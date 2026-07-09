# Getting Started

This guide is intentionally layered:

- use the quick-start sections if you want a working stack fast
- use the linked advanced notes only when you need to change auth mode, TLS, or deployment wiring
- contributor-specific local-dev workflows live in [`development.md`](./development.md)

## Quick Start: Compose + Local Auth

1. Copy the example files into the filenames that compose mounts:

```bash
cp config/compose/gui-api/mqttctl.config.example-localauth.json config/compose/gui-api/mqttctl.config.json
cp config/compose/gui-api/mqttctl.secrets.example-localauth.json config/compose/gui-api/mqttctl.secrets.json
```

2. Edit `config/compose/gui-api/mqttctl.secrets.json` if you want different bootstrap credentials. The checked-in defaults are in [`../config/compose/gui-api/mqttctl.secrets.example-localauth.json`](../config/compose/gui-api/mqttctl.secrets.example-localauth.json).

3. Start the default stack:

```bash
docker compose up --build
```

4. Open `http://localhost:3000`.

5. Sign in with the local bootstrap user from `mqttctl.secrets.json`.

6. Open these pages first:

- `Dashboard`: health, transport security, reload or restart status, and recent audit activity
- `DynSec`: clients, groups, roles, ACLs, effective permissions, and client default role handling
- `MQTT Config`: raw Mosquitto config pull or push, explicit reload or restart, and managed public key downloads
- `MQTT`: browser-scoped MQTT explorer
- `Snapshots`: export history plus import preview and broker-config apply

## Runtime Files and Restart Rules

- the control plane reads `MQTTCTL_CONFIG_PATH` and `MQTTCTL_SECRETS_PATH` once at startup
- broker-agent reads `MQTTCTL_BROKER_AGENT_CONFIG_PATH` once at startup
- changes to those JSON files require a process restart
- the default DB mode is SQLite with:
  - `MQTTCTL_DB_KIND=sqlite`
  - `MQTTCTL_SQLITE_PATH=/path/to/mqttctl.sqlite`
- Postgres needs:
  - `MQTTCTL_DB_KIND=postgres`
  - `config.database.postgres`
  - `secrets.postgresPassword`
- sample runtime files live under [`../config/compose/gui-api/`](../config/compose/gui-api) and [`../config/compose/mqtt-agent/`](../config/compose/mqtt-agent)

## Quick Start: OIDC

1. Start from the checked-in OIDC examples:

```bash
cp config/compose/gui-api/mqttctl.config.example-oidc-localauth.json config/compose/gui-api/mqttctl.config.json
cp config/compose/gui-api/mqttctl.secrets.example-oidc.json config/compose/gui-api/mqttctl.secrets.json
```

2. Edit these config fields:

- `auth.oidc.issuerUrl`
- `auth.oidc.clientId`
- optional `auth.oidc.callbackUrl`
- optional `auth.oidc.tokenEndpointAuthMethod`
- optional `auth.oidc.authorizationEndpoint`
- optional `auth.oidc.tokenEndpoint`
- optional `auth.oidc.userinfoEndpoint`
- optional claim overrides and scopes

3. Put only `oidcClientSecret` in the secrets JSON.

4. Restart the app. Config and secrets JSON are read only at process start.

5. Use `Sign In With OIDC` on the login page.

## Quick Start: Trusted Header Auth

There is no checked-in compose example for this mode yet, so you need to add the auth block yourself.

Minimal config example:

```json
{
  "auth": {
    "localEnabled": false,
    "oidcEnabled": false,
    "headerEnabled": true,
    "sessionTtlMinutes": 1440,
    "header": {
      "trustedCidrs": ["10.0.0.0/8"],
      "requiredHeaders": ["x-auth-request-user"],
      "usernameHeader": "x-auth-request-user",
      "groupsHeader": null,
      "defaultRole": "viewer"
    }
  }
}
```

Notes:

- `headerEnabled` and `oidcEnabled` cannot both be `true`
- you may leave `localEnabled` on if you want local fallback accounts
- restart the app after changing the config JSON
- the current implementation accepts `groupsHeader` in config, but it does not map proxy groups to app roles yet
- trusted-header auth is based on the request source IP the app sees directly, so make sure your proxy or ingress preserves the expected client address semantics

## Quick Start: TLS

Use [`CERTS.md`](./CERTS.md) when you need any of these:

- Mosquitto TLS listeners
- broker-agent HTTPS
- `mqttctl` talking to broker-agent over HTTPS
- `mqttctl` talking to Mosquitto over MQTT TLS

The key files that `mqttctl` can expose on the MQTT Config page are:

- `broker.keyFiles.caFile`
- `broker.keyFiles.mosquittoPublicKey`
- `broker.keyFiles.brokerPublicKey`

Private keys stay broker-local and are never downloadable through the app.

## What To Read Next

- [`advanced-operations.md`](./advanced-operations.md) for the detailed behavior behind auth, DynSec bootstrap, MQTT explorer, snapshots, logging, and broker-agent mode
- [`development.md`](./development.md) if you need the contributor workflow or local dev commands
- [`spec.md`](./spec.md) for the product contract and current API surface
