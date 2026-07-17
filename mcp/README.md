# mqttctl MCP server

This directory contains the stateful MCP server for the mqttctl HTTP API. It exposes purpose-built tools for the full supported `/api` surface while leaving mqttctl responsible for authorization, validation, auditing, broker changes, and MQTT connectivity.

The MCP process never opens an MQTT connection. MQTT tools call `/api/mqtt/*`, consume mqttctl's authenticated SSE stream, and retain API-delivered messages in a bounded in-memory queue until the agent polls them.

## Authentication model

There are two independent authentication layers:

1. Agents authenticate to `/mcp` with a named read or read/write bearer token.
2. The MCP server authenticates every mqttctl request with a short-lived Ed25519 JWS bound to the HTTP method, exact path/query, and body digest.

The JWS subject is the configured bearer-token **name**, never its value. mqttctl resolves all valid proofs to the protected passwordless `mcp` system user and includes the delegated token name/access inside audit details.

The `mcp` user has no web login, password, OIDC identity, or trusted-header identity. A superadmin can disable it or remove allowed capabilities in the App Users → MCP Access section. MCP can manage non-superadmin users when allowed, but can never create, promote, modify, or delete a superadmin and cannot change its own access controls.

## Docker Compose quick start

The repository's `docker-compose.yml` and `docker-compose.dev.yml` include:

- `mqttctl-mcp-keygen`, which idempotently creates the Ed25519 keypair;
- separate private and public named volumes;
- the public key mounted read-only into mqttctl;
- the private key mounted read-only into this MCP server;
- HTTPS on host port `3443`;
- a 60-second failed-start delay before Docker restart.

Compose deliberately supplies no bearer-token values. Until at least one token list is configured, `mqttctl-mcp` exits non-zero, waits 60 seconds, and is restarted by Docker.

Set token lists in the shell or a repository `.env` file before starting:

```env
MCP_READ_BEARER_TOKENS=[{name:'read-agent',token:'replace-with-a-long-random-secret'}]
MCP_READWRITE_BEARER_TOKENS=[{name:'automation-agent',token:'replace-with-a-different-long-random-secret'}]
```

Then run this from the repository root:

```bash
docker compose up --build
```

Endpoints:

- MCP: `https://localhost:3443/mcp`
- Health: `https://localhost:3443/healthz`
- Readiness: `https://localhost:3443/readyz`

The automatically generated HTTPS certificate is self-signed. Configure the client to trust it or replace `data/certs/server.crt` and `server.key` through the MCP data volume.

## Standalone configuration

Copy [.env.example](./.env.example) or [config.example.json5](./config.example.json5). Required settings are:

```env
MQTTCTL_BASE_URL=http://mqttctl:3000
MQTTCTL_MCP_PRIVATE_KEY_FILE=/run/mqttctl-mcp-private/signing-private.pem
MQTTCTL_MCP_KEY_ID=compose
MQTTCTL_MCP_AUDIENCE=mqttctl-api
MCP_READ_BEARER_TOKENS=[{name:'reader',token:'secret'}]
```

At least one of `MCP_READ_BEARER_TOKENS` or `MCP_READWRITE_BEARER_TOKENS` is required. Token entries may use `tokenFile` instead of `token`; this is preferred with Docker/Kubernetes secrets.

Run the standalone commands from this `mcp/` directory. Generate the signing keypair:

```bash
npm run keygen
```

Install and start:

```bash
npm ci
npm start
```

HTTPS is enabled and HTTP is disabled by default. Set `HTTP_ENABLED=true` only on a trusted network. If the mqttctl URL uses a private CA, mount that CA into the container; `MQTTCTL_VERIFY_TLS=false` is available for isolated development only.

## MCP tools and access

Read tokens can invoke GET tools and transient MQTT read-channel tools. Read/write tokens can additionally invoke mutating tools. Destructive and high-impact tools require `confirm: true`. `MCP_READ_ONLY=true` omits all mutating tools entirely.

Fixed-window limits are isolated by named token and read/write/destructive category. Configure them with `MCP_RATE_LIMIT_WINDOW_SECONDS`, `MCP_RATE_LIMIT_READ`, `MCP_RATE_LIMIT_WRITE`, and `MCP_RATE_LIMIT_DESTRUCTIVE`.

The complete operation mapping is [docs/API_TOOL_MAPPING.md](./docs/API_TOOL_MAPPING.md). Two endpoints are intentionally internal rather than agent-callable:

- `POST /api/mcp/heartbeat` is called by the MCP service identity every 15 seconds.
- `PATCH /api/mcp/access` remains interactive-superadmin-only so MCP cannot expand or re-enable itself.

`GET /api/dashboard/ws` is represented by the current dashboard snapshot tool; an unbounded WebSocket is not returned as one tool call.

## MQTT queue lifecycle

Each initialized MCP protocol session gets an isolated mqttctl MQTT browser cookie, SSE consumer, and queue. The queue defaults are:

- 10,000 messages;
- 16 MiB of payload data;
- 100 messages per poll by default;
- 1,000 messages per poll maximum;
- one-hour expiry since the last message-buffer poll.

Polling atomically removes returned messages and refreshes expiry. Status and state reads do not. Overflow drops the oldest entries and reports dropped counts/bytes. Explicit `DELETE /mcp`, the MQTT disconnect tool, server shutdown, or one hour without a poll closes the API stream, requests mqttctl disconnect, and discards subscriptions and queued data.

See [docs/MQTT_LIFECYCLE.md](./docs/MQTT_LIFECYCLE.md) for full behavior.

## Key rotation

The key generator never overwrites an existing valid private key. If only the public volume is removed, rerunning keygen derives the matching public key again.

For intentional rotation:

1. Stop mqttctl and the MCP server.
2. Back up or remove both signing-key volumes.
3. Run `mqttctl-mcp-keygen` to create the replacement pair.
4. Restart mqttctl and the MCP server together.

mqttctl intentionally exits at startup when MCP auth is enabled but its public key is missing, unreadable, malformed, or not Ed25519. The fatal log includes the checked path, expected format, Compose service/volume, and both disable switches.

## Development and tests

From the repository root:

```bash
cd mcp
npm ci
npm run check
docker build -t mqttctl-mcp .
```

Tests cover token parsing, request-proof binding/signature verification, incremental SSE parsing, queue overflow/draining, and inactivity cleanup. mqttctl's own tests cover public-key startup failure, proof replay rejection, and protected MCP/superadmin mutation rules.

## Image Publishing

MQTTCtl MCP image, from the repository root:

```bash
USERNAME=YOURUSERNAME
DOMAIN=yourdomain.xyz
VERSION=v0.0.7
git tag -a "$VERSION" -m "$VERSION"
# git tag -f -a "$VERSION" -m "$VERSION"
# git push --force origin "$VERSION"

SHA=$(git rev-parse --short=12 HEAD)

docker build --build-arg BUILD_HASH="$SHA" -t mqttctl-mcp:build ./mcp

for TAG in latest "$VERSION" "$VERSION-$SHA"; do
  docker tag mqttctl-mcp:build "$USERNAME/mqttctl-mcp:$TAG"
  docker tag mqttctl-mcp:build "$DOMAIN/$USERNAME/mqttctl-mcp:$TAG"
  docker push "$USERNAME/mqttctl-mcp:$TAG" # Dockerhub
  docker push "$DOMAIN/$USERNAME/mqttctl-mcp:$TAG" # Custom
done
```
