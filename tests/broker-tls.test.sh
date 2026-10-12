#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
export MQTTCTL_TLS_DIR="$test_dir/private"
export MQTTCTL_TLS_PUBLIC_DIR="$test_dir/public"
export MQTTCTL_TLS_MOSQUITTO_OWNER="$(id -u)"
export MQTTCTL_AUTO_TLS=true
init="$repo/dockerfiles/init-broker-tls.sh"

sh "$init" > "$test_dir/first.log"
[ "$(grep -c 'Auto-generated' "$test_dir/first.log")" = 3 ]
for service in mosquitto broker-agent; do
    openssl verify -CAfile "$MQTTCTL_TLS_PUBLIC_DIR/ca/ca.crt" \
        -verify_hostname broker-agent "$MQTTCTL_TLS_DIR/$service/tls.crt"
    openssl verify -CAfile "$MQTTCTL_TLS_PUBLIC_DIR/ca/ca.crt" \
        -verify_ip 127.0.0.1 "$MQTTCTL_TLS_DIR/$service/tls.crt"
    [ "$(stat -c %a "$MQTTCTL_TLS_DIR/$service/tls.key")" = 600 ]
done
[ "$(stat -c %a "$MQTTCTL_TLS_DIR/ca/ca.key")" = 600 ]
[ "$(find "$MQTTCTL_TLS_PUBLIC_DIR" -type f | wc -l)" = 3 ]
[ -z "$(find "$MQTTCTL_TLS_PUBLIC_DIR" -name '*.key')" ]
find "$MQTTCTL_TLS_DIR" -type f -exec sha256sum {} \; | sort > "$test_dir/before"
sh "$init" > "$test_dir/restart.log"
! grep -q 'Auto-generated' "$test_dir/restart.log"
find "$MQTTCTL_TLS_DIR" -type f -exec sha256sum {} \; | sort > "$test_dir/after"
cmp "$test_dir/before" "$test_dir/after"
printf 'PASS: generation, trusted SANs, private permissions, public-only export, restart reuse\n'

mv "$MQTTCTL_TLS_DIR/mosquitto/tls.crt" "$test_dir/saved.crt"
if sh "$init" > "$test_dir/partial.log" 2>&1; then
    printf 'FAIL: incomplete pair was accepted\n' >&2; exit 1
fi
grep -q 'Incomplete key/certificate pair' "$test_dir/partial.log"
mv "$test_dir/saved.crt" "$MQTTCTL_TLS_DIR/mosquitto/tls.crt"
cp "$MQTTCTL_TLS_DIR/broker-agent/tls.crt" "$MQTTCTL_TLS_DIR/mosquitto/tls.crt"
if sh "$init" > "$test_dir/mismatch.log" 2>&1; then
    printf 'FAIL: mismatched key was accepted\n' >&2; exit 1
fi
grep -q 'Key does not match certificate' "$test_dir/mismatch.log"
printf 'PASS: incomplete and mismatched pairs fail without replacing keys\n'

MQTTCTL_AUTO_TLS=false MQTTCTL_TLS_DIR="$test_dir/disabled" sh "$init"
[ ! -e "$test_dir/disabled" ]
printf 'PASS: automatic generation can be disabled\n'

# Standalone containers running as UID 1883 cannot create /run directories.
# They must still start when no public export volume was configured.
unset MQTTCTL_TLS_PUBLIC_DIR
export MQTTCTL_TLS_DIR="$test_dir/no-export"
sh "$init" > "$test_dir/no-export.log"
[ -s "$MQTTCTL_TLS_DIR/mosquitto/tls.key" ]
[ -s "$MQTTCTL_TLS_DIR/broker-agent/tls.crt" ]
sh "$init" > "$test_dir/no-export-restart.log"
! grep -q 'Auto-generated' "$test_dir/no-export-restart.log"
printf 'PASS: startup and restart without a public export volume\n'
