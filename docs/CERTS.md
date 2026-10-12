# Docker TLS Setup

## Automatic certificates

The broker-agent images run `dockerfiles/init-broker-tls.sh` before starting the agent and Mosquitto. On first startup the script creates:

- a self-signed local CA in `/mosquitto/config/certs/ca/`
- a Mosquitto key and certificate in `/mosquitto/config/certs/mosquitto/`
- a broker-agent key and certificate in `/mosquitto/config/certs/broker-agent/`

Both service certificates are signed by the local CA. Their default subject alternative names are `broker-agent`, `localhost`, and `127.0.0.1`. The CA lasts 10 years and service certificates last 825 days.

Each generated pair produces a `[broker-tls] Auto-generated ...` startup log with its service and path. Private key contents are never logged. Existing pairs are validated and reused without rotation. An incomplete, mismatched, expired, or untrusted pair stops startup with an actionable error; repair or renew it explicitly.

Compose persists the files under `config/compose/mqtt-agent/certs/`. This directory is excluded from Git and Docker build contexts. Back it up securely along with broker data. Private keys have mode `0600`; the generated Mosquitto key belongs to the `mosquitto` user so the broker can read it after dropping privileges.

Only the CA and service certificates are copied into the `mqttctl-broker-public` volume. The API mounts that volume read-only, uses `NODE_EXTRA_CA_CERTS` to trust the agent's HTTPS certificate, and uses `broker.tls.caFile` to verify MQTT TLS. Private keys stay in the broker container's mount. The dev API's workspace mount also masks the private certificate directory with the public volume.

The default Compose configuration waits for the broker-agent HTTPS health check and MCP signing-key generator before starting the API. Internal connections are:

- API to broker-agent: `https://broker-agent:3943`, with CA and hostname verification
- broker-agent to Mosquitto: `broker-agent:8883`, with CA and hostname verification

The browser UI still uses `http://localhost:3000`; configure a reverse proxy for browser-facing HTTPS. The optional plain MQTT and WebSocket listeners remain on 1883 and 9001 for existing clients. Broker-agent HTTP is disabled in the default config.

## Upgrade an existing Compose installation

Existing `mqttctl.config.json5` files are retained. Update their broker settings while preserving your authentication and other configuration:

```json5
broker: {
  host: 'broker-agent',
  port: 8883,
  // Preserve existing credentials and other broker fields.
  agent: {
    baseUrl: 'https://broker-agent:3943',
    timeoutMs: 60000,
    insecure: false,
  },
  tls: {
    enabled: true,
    caFile: '/mosquitto/config/certs/ca/ca.crt',
    insecure: false,
  },
}
```

The tracked broker-agent and Mosquitto sample configs enable HTTPS and the MQTT TLS listener. Merge those listener changes if you customized either file. Rebuild and recreate the services:

```bash
docker compose up -d --build
# Development:
docker compose -f docker-compose.dev.yml up -d --build
```

The dashboard should show `API to Broker Agent TLS` and `Broker Agent to Mosquitto TLS`. The MQTT Config page provides downloads for the CA and public service certificates configured in `broker.keyFiles`. Those paths remain `/mosquitto/config/certs/ca/ca.crt`, `/mosquitto/config/certs/mosquitto/tls.crt`, and `/mosquitto/config/certs/broker-agent/tls.crt`.

## Startup options

Set these on the broker-agent container:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MQTTCTL_AUTO_TLS` | `true` | Set to `false` to skip automatic generation and public certificate copying. |
| `MQTTCTL_TLS_DIR` | `/mosquitto/config/certs` | Persistent private certificate directory. |
| `MQTTCTL_TLS_PUBLIC_DIR` | unset | Optional public certificate export directory. Compose sets `/run/mqttctl-broker-public` and mounts a writable volume there. |
| `MQTTCTL_TLS_SAN` | `DNS:broker-agent,DNS:localhost,IP:127.0.0.1` | Names/IPs for newly generated service certificates. |
| `MQTTCTL_TLS_MOSQUITTO_OWNER` | `mosquitto` | Owner for a newly generated Mosquitto private key when startup runs as root. |

Changing the SAN setting does not replace existing certificates. Renew service certificates explicitly when their names or expiry require it, then restart both broker-agent and API. The script never silently replaces an existing key. With custom paths, update listener settings, volume mounts, API CA settings, and the health check to match.

## Externally managed certificates

Set `MQTTCTL_AUTO_TLS=false` to supply your own certificates. Configure the Mosquitto `certfile`/`keyfile` and broker-agent `listen.https.certFile`/`keyFile`, and mount the trusted CA into the API. Populate the public certificate volume yourself, or replace that mount with a read-only directory containing only public certificates. Keep certificate verification enabled with `broker.agent.insecure: false` and `broker.tls.insecure: false`.

For deployments outside Compose, mount persistent storage for the private certificate directory. Public export is optional: set `MQTTCTL_TLS_PUBLIC_DIR` only when sharing a writable export volume with the API. A non-root broker can generate and reuse keys in its writable private directory without writing to `/run`. If certificates already exist in another location (such as `/mosquitto/certs`), set `MQTTCTL_TLS_DIR` to that location for locally managed CA/key pairs, or disable auto-generation for externally managed certificates. The startup script creates files; listener addresses and TLS selection remain explicit configuration.

## Regression check

```bash
sh tests/broker-tls.test.sh
```

This checks first-start logs, CA/hostname validation, private-key permissions, public-only export, restart preservation, rejection of incomplete/mismatched pairs, and startup without an export volume. Run the same script inside the broker image as UID/GID 1883 to cover non-root deployments.
