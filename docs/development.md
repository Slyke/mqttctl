# Development

This guide is for people changing the repo, not for first-time operators.

## Fastest Dev Loop

Use the bind-mounted dev stack if you want the containers to run directly from the checkout:

```bash
docker compose -f docker-compose.dev.yml up --build mqttctl broker-agent
```

Notes:

- the `mqttctl` dev container runs `npm install` on startup so new dependencies appear without manually clearing the named volume
- the optional nginx proxy sample under [`../config/nginx-dev-proxy/`](../config/nginx-dev-proxy) is separate from the base dev loop
- if you want TLS in front of the dev UI, follow [`CERTS.md`](./CERTS.md)

## Manual Workspace Commands

### Control Plane

The repo is expected to run in WSL2, and non-interactive shells may not load `nvm` automatically.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd mqttctl
npm install
npm run check
npm run test
npm run build
npm run error-validate
```

The workspace uses TypeScript 6.0.3, the newest release supported by the
SvelteKit 3 and svelte-check peer dependencies. TypeScript 7 is not yet supported
by this toolchain. SvelteKit configuration lives in `mqttctl-fe/vite.config.ts`.

Start production builds with `npm start` (or `node server.mjs` from
`mqttctl-fe`). The startup wrapper preserves runtime `ORIGIN` support on
adapter-node 6 and detects direct HTTP connections. Set `ORIGIN` to the public
origin behind a reverse proxy. Alternatively, explicitly configure
`PROTOCOL_HEADER` / `HOST_HEADER` for a trusted proxy that overwrites those
headers. Keep `publicBaseUrl` in the mqttctl configuration set to the
browser-facing URL for authentication and WebSocket origin checks.

Set the minimum runtime env vars before running the built app manually:

```bash
export MQTTCTL_CONFIG_PATH=/abs/path/to/mqttctl.config.json5
export MQTTCTL_SECRETS_PATH=/abs/path/to/mqttctl.secrets.json5
export MQTTCTL_DB_KIND=sqlite
export MQTTCTL_SQLITE_PATH=/abs/path/to/mqttctl.sqlite
```

Optional:

- `MQTTCTL_UI_OVERRIDE_CSS_PATH=/abs/path/to/custom.css`
- `MQTTCTL_LOG_*` sink overrides and Kubernetes log metadata env vars described in [`advanced-operations.md`](./advanced-operations.md)

### Broker Agent

The images use Rust 1.99.0 and Mosquitto 2.1.2. When the agent runs as root,
new dynamic-security files are assigned to `mosquitto` so the broker can read
them after dropping privileges. If your broker uses another OS account, set
`broker.dynsecBootstrap.fileOwner` to that account. Existing state files and
their parent directory must already be readable and writable by the broker;
the agent does not change ownership of existing files.

```bash
cd broker-agent
cargo test
```

At runtime:

```bash
export MQTTCTL_BROKER_AGENT_CONFIG_PATH=/abs/path/to/broker-agent.config.json
```
