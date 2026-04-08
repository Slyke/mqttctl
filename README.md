# mqttctl

Run, secure, and troubleshoot Mosquitto from one local-first control plane.

`mqttctl` gives you a browser UI for DynSec, raw broker config, audit history, snapshots, and live MQTT debugging, without assuming shell access to the broker host.

## What The App Does Today

- Dashboard: live diagnostics, transport security badges, DynSec bootstrap status, counts, and recent audit activity
- Audit: append-only history for writes, app startup, and login outcomes, limit presets, and JSON export with chained SHA-256 integrity metadata
- DynSec: clients, groups, roles, ACLs, effective-permissions view, default-role management, and clean-start bootstrap of `read-all` plus `read-write-all`
- MQTT Config: raw broker-config pull or push, explicit reload or restart actions, and managed CA or public key downloads
- MQTT Explorer: session-scoped MQTT connect, subscribe, publish, latest-topic tracking, and SSE-backed live updates
- Snapshots: JSON export for dynsec, broker config, or combined data, plus import preview and broker-config apply
- Auth and RBAC: local auth, OIDC, or trusted headers, with DB-backed sessions and server-side authorization on mutations

## Documentation Map

- [`docs/getting-started.md`](./docs/getting-started.md): quick guides for getting the stack running, choosing auth, wiring TLS, and first-use flows
- [`docs/advanced-operations.md`](./docs/advanced-operations.md): detailed runtime, auth, broker-agent, DynSec, MQTT explorer, snapshots, and logging behavior
- [`docs/development.md`](./docs/development.md): contributor workflow, local dev commands, tests, and bind-mounted dev stack notes
- [`CERTS.md`](./CERTS.md): TLS walkthrough for Mosquitto, broker-agent HTTPS, and compose-mounted cert files
- [`spec.md`](./spec.md): current product and technical contract
- [`AGENTS.md`](./AGENTS.md): repo-wide rules and documentation maintenance expectations
- [`mqttctl/AGENTS.md`](./mqttctl/AGENTS.md), [`mqttctl/mqttctl-api/AGENTS.md`](./mqttctl/mqttctl-api/AGENTS.md), [`mqttctl/mqttctl-fe/AGENTS.md`](./mqttctl/mqttctl-fe/AGENTS.md), [`broker-agent/AGENTS.md`](./broker-agent/AGENTS.md): package-level boundaries

## Quick Start

### Docker Compose + Local Auth

Copy the local-auth samples into the filenames that compose actually mounts:

```bash
cp config/compose/gui-api/mqttctl.config.example-localauth.json config/compose/gui-api/mqttctl.config.json
cp config/compose/gui-api/mqttctl.secrets.example-localauth.json config/compose/gui-api/mqttctl.secrets.json
docker compose up --build
```

Then open `http://localhost:3000` and sign in with the bootstrap credentials you placed in `config/compose/gui-api/mqttctl.secrets.json`. The checked-in defaults live in [`config/compose/gui-api/mqttctl.secrets.example-localauth.json`](./config/compose/gui-api/mqttctl.secrets.example-localauth.json).

### Common Next Steps

- OIDC: start from [`config/compose/gui-api/mqttctl.config.example-oidc-localauth.json`](./config/compose/gui-api/mqttctl.config.example-oidc-localauth.json) and [`config/compose/gui-api/mqttctl.secrets.example-oidc.json`](./config/compose/gui-api/mqttctl.secrets.example-oidc.json), then restart the app
- Trusted-header auth: add `auth.headerEnabled`, `auth.header.trustedCidrs`, `auth.header.usernameHeader`, and `auth.header.defaultRole`; details are in [`docs/getting-started.md`](./docs/getting-started.md)
- TLS for Mosquitto or broker-agent HTTPS: follow [`CERTS.md`](./CERTS.md)

## Runtime Model

- The control plane reads exactly two JSON files at startup:
  - `MQTTCTL_CONFIG_PATH`
  - `MQTTCTL_SECRETS_PATH`
- The broker-agent reads one JSON file at startup:
  - `MQTTCTL_BROKER_AGENT_CONFIG_PATH`
- Those JSON files are bootstrap-only inputs:
  - the app treats them as read-only
  - changes require a process restart to take effect
- SQLite is the default DB mode:
  - `MQTTCTL_DB_KIND=sqlite`
  - `MQTTCTL_SQLITE_PATH=/path/to/mqttctl.sqlite`
- Postgres is optional:
  - set `MQTTCTL_DB_KIND=postgres`
  - keep `config.database.postgres` in config JSON
  - keep `secrets.postgresPassword` in secrets JSON
- `MQTTCTL_UI_OVERRIDE_CSS_PATH` exposes instance-specific CSS through `/instance-overrides.css`
- `MQTTCTL_LOG_*` env vars can override the configured logging sinks at deploy time
- `MQTTCTL_LOG_K8S_METADATA_ENABLED` or `LOG_K8S_METADATA_ENABLED`, plus `K8S_*` metadata env vars, can attach Kubernetes metadata to each log entry

Control-plane builds generate a build label in the form `v<version>-<commit>`. The API logs it at startup, the signed-in app shell shows it in the sidebar, and broker-agent logs its own label on startup as well.

## Sample Runtime Inputs

Control-plane samples:

- [`config/compose/gui-api/mqttctl.config.example-localauth.json`](./config/compose/gui-api/mqttctl.config.example-localauth.json)
- [`config/compose/gui-api/mqttctl.config.example-oidc-localauth.json`](./config/compose/gui-api/mqttctl.config.example-oidc-localauth.json)
- [`config/compose/gui-api/mqttctl.secrets.example-localauth.json`](./config/compose/gui-api/mqttctl.secrets.example-localauth.json)
- [`config/compose/gui-api/mqttctl.secrets.example-oidc.json`](./config/compose/gui-api/mqttctl.secrets.example-oidc.json)
- [`config/compose/gui-api/custom.css`](./config/compose/gui-api/custom.css)

Broker-agent and Mosquitto samples:

- [`config/compose/mqtt-agent/broker-agent.config.json`](./config/compose/mqtt-agent/broker-agent.config.json)
- [`config/compose/mqtt-agent/mosquitto.conf`](./config/compose/mqtt-agent/mosquitto.conf)

The MQTT Config page exposes only the configured public broker artifacts by symbolic ID:

- `caFile`
- `mosquittoPublicKey`
- `brokerPublicKey`

Private keys are intentionally excluded from that download surface.

When the control plane talks to broker-agent over HTTPS, set `broker.agent.baseUrl` to an `https://...` URL. The control-plane `broker.agent.insecure` flag only affects that hop. It does not change the separate broker-agent-to-Mosquitto TLS settings under `broker.tls.*`.

The broker-agent `/health` and `/healthz` endpoints are intentionally unauthenticated. All other broker-agent endpoints still require the shared API key.

## Docker and Compose

Production images:

- [`dockerfiles/mqttctl.Dockerfile`](./dockerfiles/mqttctl.Dockerfile)
- [`dockerfiles/broker-agent.Dockerfile`](./dockerfiles/broker-agent.Dockerfile)

Development images:

- [`dockerfiles/mqttctl.dev.Dockerfile`](./dockerfiles/mqttctl.dev.Dockerfile)
- [`dockerfiles/broker-agent.dev.Dockerfile`](./dockerfiles/broker-agent.dev.Dockerfile)

Run the default stack:

```bash
docker compose up --build
```

Run the bind-mounted development stack:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Both compose examples mount the whole [`config/compose/mqtt-agent/`](./config/compose/mqtt-agent) directory into `/mosquitto/config` so raw broker-config pushes can overwrite `mosquitto.conf` in place. Mounting only `/mosquitto/config/mosquitto.conf` makes that path a mount point and can cause `EBUSY` on push.

Default local endpoints:

- UI: `http://localhost:3000`
- MQTT: `mqtt://localhost:1883`
- MQTT over WebSockets: `ws://localhost:9001`

## Repository Layout

- [`mqttctl/`](./mqttctl): npm workspace root for the control plane
- [`mqttctl/mqttctl-api/`](./mqttctl/mqttctl-api): backend services, runtime config, DB layer, auth, dynsec, snapshots, diagnostics, MQTT explorer, logging, and broker-agent client
- [`mqttctl/mqttctl-fe/`](./mqttctl/mqttctl-fe): SvelteKit routes, pages, hooks, styles, dashboard websocket glue, and frontend error catalog
- [`broker-agent/`](./broker-agent): Rust crate for broker-local file, dynsec, and lifecycle operations
- [`config/`](./config): sample config, secrets, CSS overrides, compose-mounted broker files, and the optional nginx dev-proxy sample
- [`dockerfiles/`](./dockerfiles): production and development images

## Image Publishing

Broker-agent image:

```bash
docker build -t mqttctl-broker-agent:build -f ./dockerfiles/broker-agent.Dockerfile .
docker tag mqttctl-broker-agent:build USERNAME/mqttctl-broker-agent:latest
docker tag mqttctl-broker-agent:build USERNAME/mqttctl-broker-agent:v0.0.X
docker push USERNAME/mqttctl-broker-agent:latest
docker push USERNAME/mqttctl-broker-agent:v0.0.X
```

Control-plane image:

```bash
docker build -t mqttctl:build -f ./dockerfiles/mqttctl.Dockerfile .
docker tag mqttctl:build USERNAME/mqttctl:latest
docker tag mqttctl:build USERNAME/mqttctl:v0.0.X
docker push USERNAME/mqttctl:latest
docker push USERNAME/mqttctl:v0.0.X
```

## Donate

If you like this code and want to donate, you can do so:

* Buy me a coffee: https://www.buymeacoffee.com/Slyke
* BTC: `bc1q7zew2exzzcydlk7gyh8xfjal6gzfzr4d95a2ut`
* Eth: `0x3986A26727ceCe5b8092501b8CBC196C754ec2b1`
* Doge: `DQ41pGzAr25LkbdTCrLVZaVCAySxv5buXc`
