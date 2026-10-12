#!/bin/sh
set -eu

# Generate once on the persistent broker volume; never rotate existing keys.
[ "${MQTTCTL_AUTO_TLS:-true}" = true ] || exit 0

tls_dir=${MQTTCTL_TLS_DIR:-/mosquitto/config/certs}
# Export is opt-in: standalone/non-root deployments may have no shared volume.
public_dir=${MQTTCTL_TLS_PUBLIC_DIR:-}
san=${MQTTCTL_TLS_SAN:-DNS:broker-agent,DNS:localhost,IP:127.0.0.1}
owner=${MQTTCTL_TLS_MOSQUITTO_OWNER:-mosquitto}
umask 077
mkdir -p "$tls_dir"
work=$(mktemp -d "$tls_dir/.generate.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM

fail() {
    printf '[broker-tls] ERROR: %s\n' "$*" >&2
    exit 1
}

# A partial pair requires operator attention, not a silent identity change.
missing_pair() {
    key=$1
    cert=$2
    if [ ! -e "$key" ] && [ ! -e "$cert" ]; then
        return 0
    fi
    [ -s "$key" ] && [ -s "$cert" ] || fail "Incomplete key/certificate pair: $key, $cert. Restore the missing file; existing keys will not be overwritten."
    key_public=$(openssl pkey -in "$key" -pubout 2>/dev/null) || fail "Cannot read private key: $key"
    cert_public=$(openssl x509 -in "$cert" -pubkey -noout 2>/dev/null) || fail "Cannot read certificate: $cert"
    [ "$key_public" = "$cert_public" ] || fail "Key does not match certificate: $cert"
    openssl x509 -in "$cert" -checkend 0 -noout >/dev/null || fail "Certificate expired: $cert. Renew it explicitly."
    return 1
}

mkdir -p "$tls_dir/ca" "$tls_dir/mosquitto" "$tls_dir/broker-agent"
chmod 755 "$tls_dir" "$tls_dir/ca" "$tls_dir/mosquitto" "$tls_dir/broker-agent"
if missing_pair "$tls_dir/ca/ca.key" "$tls_dir/ca/ca.crt"; then
    # Do not replace the trust anchor underneath existing service certificates.
    for service in mosquitto broker-agent; do
        [ ! -e "$tls_dir/$service/tls.key" ] && [ ! -e "$tls_dir/$service/tls.crt" ] \
            || fail "CA is missing but $service credentials already exist. Restore the CA or set MQTTCTL_AUTO_TLS=false for externally managed certificates."
    done
    openssl req -x509 -newkey rsa:3072 -noenc -sha256 -days 3650 \
        -keyout "$work/ca.key" -out "$work/ca.crt" \
        -subj '/CN=mqttctl-local-ca' \
        -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
        -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>"$work/openssl.log" \
        || fail "CA generation failed: $(cat "$work/openssl.log")"
    chmod 600 "$work/ca.key"
    chmod 644 "$work/ca.crt"
    mv "$work/ca.key" "$tls_dir/ca/ca.key"
    mv "$work/ca.crt" "$tls_dir/ca/ca.crt"
    printf '[broker-tls] Auto-generated self-signed CA key and certificate: %s/ca\n' "$tls_dir"
fi

for service in mosquitto broker-agent; do
    if missing_pair "$tls_dir/$service/tls.key" "$tls_dir/$service/tls.crt"; then
        printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$san" > "$work/extensions.cnf"
        openssl req -new -newkey rsa:2048 -noenc \
            -keyout "$work/tls.key" -out "$work/tls.csr" \
            -subj "/CN=$service" 2>"$work/openssl.log" \
            || fail "Key generation failed for $service: $(cat "$work/openssl.log")"
        openssl x509 -req -in "$work/tls.csr" -sha256 -days 825 \
            -CA "$tls_dir/ca/ca.crt" -CAkey "$tls_dir/ca/ca.key" \
            -set_serial "0x$(openssl rand -hex 16)" -extfile "$work/extensions.cnf" \
            -out "$work/tls.crt" 2>"$work/openssl.log" \
            || fail "Certificate generation failed for $service: $(cat "$work/openssl.log")"
        chmod 600 "$work/tls.key"
        chmod 644 "$work/tls.crt"
        if [ "$service" = mosquitto ] && [ "$(id -u)" = 0 ]; then
            chown "$owner" "$work/tls.key"
        fi
        mv "$work/tls.key" "$tls_dir/$service/tls.key"
        mv "$work/tls.crt" "$tls_dir/$service/tls.crt"
        printf '[broker-tls] Auto-generated %s TLS key and certificate signed by the local CA: %s/%s\n' "$service" "$tls_dir" "$service"
    fi
    openssl verify -CAfile "$tls_dir/ca/ca.crt" "$tls_dir/$service/tls.crt" >/dev/null \
        || fail "Certificate is not signed by the configured local CA: $service"
done

# The API mounts only this public volume. No private key leaves the broker.
if [ -n "$public_dir" ]; then
    for path in ca/ca.crt mosquitto/tls.crt broker-agent/tls.crt; do
        mkdir -p "$public_dir/$(dirname "$path")"
        chmod 755 "$public_dir" "$public_dir/$(dirname "$path")"
        cp "$tls_dir/$path" "$public_dir/$path"
        chmod 644 "$public_dir/$path"
    done
fi
printf '[broker-tls] TLS certificates ready; existing keys preserved.\n'
