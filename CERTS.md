# Docker TLS Setup

Run these commands from the repo root:

```bash
cd /path/to/mqttctl
```

This repo now treats Mosquitto config as raw text only. TLS listener changes go directly into:

- `./config/compose/mqtt-agent/mosquitto.conf`

broker-agent HTTPS goes into:

- `./config/compose/mqtt-agent/broker-agent.config.json`

`mqttctl` client-side MQTT TLS settings go into:

- `./config/compose/gui-api/mqttctl.config.json`

MQTT Config page downloads for the CA and public key files are configured through:

- `broker.keyFiles.caFile`
- `broker.keyFiles.mosquittoPublicKey`
- `broker.keyFiles.brokerPublicKey`

Private keys stay broker-local and are never downloadable through `mqttctl`.

## Create Cert Directories

```bash
mkdir -p ./config/compose/mqtt-agent/certs/mosquitto
mkdir -p ./config/compose/mqtt-agent/certs/broker-agent
mkdir -p ./config/compose/mqtt-agent/certs/ca
```

## Quick Self-Signed Certs

### Mosquitto

```bash
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout ./config/compose/mqtt-agent/certs/mosquitto/tls.key \
  -out ./config/compose/mqtt-agent/certs/mosquitto/tls.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:broker-agent,IP:127.0.0.1"
```

### broker-agent

```bash
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout ./config/compose/mqtt-agent/certs/broker-agent/tls.key \
  -out ./config/compose/mqtt-agent/certs/broker-agent/tls.crt \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:broker-agent,IP:127.0.0.1"
```

## Private CA + Separate Service Certs

### Create CA

```bash
openssl genrsa -out ./config/compose/mqtt-agent/certs/ca/ca.key 4096

openssl req -x509 -new -nodes \
  -key ./config/compose/mqtt-agent/certs/ca/ca.key \
  -sha256 -days 3650 \
  -out ./config/compose/mqtt-agent/certs/ca/ca.crt \
  -subj "/CN=mqttctl-local-ca"
```

### Create Mosquitto Cert

```bash
cat > ./config/compose/mqtt-agent/certs/mosquitto/ext.cnf <<'EOF'
subjectAltName=DNS:localhost,DNS:broker-agent,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF

openssl genrsa -out ./config/compose/mqtt-agent/certs/mosquitto/tls.key 2048

openssl req -new \
  -key ./config/compose/mqtt-agent/certs/mosquitto/tls.key \
  -out ./config/compose/mqtt-agent/certs/mosquitto/tls.csr \
  -subj "/CN=localhost"

openssl x509 -req \
  -in ./config/compose/mqtt-agent/certs/mosquitto/tls.csr \
  -CA ./config/compose/mqtt-agent/certs/ca/ca.crt \
  -CAkey ./config/compose/mqtt-agent/certs/ca/ca.key \
  -CAcreateserial \
  -out ./config/compose/mqtt-agent/certs/mosquitto/tls.crt \
  -days 825 -sha256 \
  -extfile ./config/compose/mqtt-agent/certs/mosquitto/ext.cnf
```

### Create broker-agent Cert

```bash
cat > ./config/compose/mqtt-agent/certs/broker-agent/ext.cnf <<'EOF'
subjectAltName=DNS:localhost,DNS:broker-agent,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF

openssl genrsa -out ./config/compose/mqtt-agent/certs/broker-agent/tls.key 2048

openssl req -new \
  -key ./config/compose/mqtt-agent/certs/broker-agent/tls.key \
  -out ./config/compose/mqtt-agent/certs/broker-agent/tls.csr \
  -subj "/CN=localhost"

openssl x509 -req \
  -in ./config/compose/mqtt-agent/certs/broker-agent/tls.csr \
  -CA ./config/compose/mqtt-agent/certs/ca/ca.crt \
  -CAkey ./config/compose/mqtt-agent/certs/ca/ca.key \
  -CAcreateserial \
  -out ./config/compose/mqtt-agent/certs/broker-agent/tls.crt \
  -days 825 -sha256 \
  -extfile ./config/compose/mqtt-agent/certs/broker-agent/ext.cnf
```

## Mosquitto TLS

Edit:

- `./config/compose/mqtt-agent/mosquitto.conf`

Example with plain MQTT and TLS MQTT together:

```conf
log_dest stdout
allow_anonymous false
persistence true
persistence_location /mosquitto/data/
plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /mosquitto/data/dynamic-security.json
per_listener_settings false

listener 1883

listener 8883
certfile /mosquitto/config/certs/mosquitto/tls.crt
keyfile /mosquitto/config/certs/mosquitto/tls.key

listener 9001
protocol websockets
```

`cafile` is only needed if you want Mosquitto to validate client certificates.

## mqttctl Client TLS To Mosquitto

If `mqttctl` should connect to the TLS MQTT port, edit:

- `./config/compose/gui-api/mqttctl.config.json`

Example:

```json
"broker": {
  "host": "broker-agent",
  "port": 8883,
  "dynsecAdminUsername": "admin",
  "controlBinaryPath": "mosquitto_ctrl",
  "agent": {
    "baseUrl": "http://broker-agent:3900",
    "timeoutMs": 10000
  },
  "dynsecStateFilePath": "/mosquitto/data/dynamic-security.json",
  "mainConfigPath": "/mosquitto/config/mosquitto.conf",
  "keyFiles": {
    "caFile": "/mosquitto/config/certs/ca/ca.crt",
    "mosquittoPublicKey": "/mosquitto/config/certs/mosquitto/tls.crt",
    "brokerPublicKey": "/mosquitto/config/certs/broker-agent/tls.crt"
  },
  "mqttClientId": "mqttctl-compose-admin",
  "tls": {
    "enabled": true,
    "caFile": "/mosquitto/config/certs/ca/ca.crt",
    "certFile": null,
    "keyFile": null,
    "insecure": false
  }
}
```

For quick local self-signed testing, `insecure: true` is acceptable.

## broker-agent HTTPS

Edit:

- `./config/compose/mqtt-agent/broker-agent.config.json`

Example:

```json
"listen": {
  "http": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3900
  },
  "https": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3943,
    "certFile": "/mosquitto/config/certs/broker-agent/tls.crt",
    "keyFile": "/mosquitto/config/certs/broker-agent/tls.key"
  }
}
```

The broker-agent config should also expose the same symbolic key-file paths:

```json
"broker": {
  "keyFiles": {
    "caFile": "/mosquitto/config/certs/ca/ca.crt",
    "mosquittoPublicKey": "/mosquitto/config/certs/mosquitto/tls.crt",
    "brokerPublicKey": "/mosquitto/config/certs/broker-agent/tls.crt"
  }
}
```

If `mqttctl` should call broker-agent over HTTPS, also edit:

- `./config/compose/gui-api/mqttctl.config.json`

```json
"agent": {
  "baseUrl": "https://broker-agent:3943",
  "timeoutMs": 10000
}
```

If broker-agent uses a private CA, the `mqttctl` container must trust that CA.

When these paths are configured, the MQTT Config page checks whether each managed file exists and only shows download actions for the CA and public key files that are actually present.

## Docker Compose Ports

If you enable TLS listeners, expose those ports in:

- `./docker-compose.yml`
- `./docker-compose.dev.yml`

Example:

```yaml
ports:
  - "1883:1883"
  - "8883:8883"
  - "9001:9001"
  - "3943:3943"
```

## Restart

Production compose:

```bash
docker compose down
docker compose up --build
```

Dev compose:

```bash
docker compose -f ./docker-compose.dev.yml down
docker compose -f ./docker-compose.dev.yml up --build
```
