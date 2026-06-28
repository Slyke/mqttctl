# mqttctl Specification

## Summary

`mqttctl` is a self-hosted, offline-first Mosquitto control plane. It does not replace Mosquitto. It manages:

- Mosquitto Dynamic Security entities and assignments
- direct broker config pull, push, reload, and restart workflows, with broker-agent support when broker-local control is available
- admin authentication and RBAC for the web UI
- snapshots, audit history, diagnostics, broker-admin MQTT exploration, and future add-ons

The application must run fully offline after installation and must not depend on vendor activation, telemetry services, CDNs, or SaaS.

This file is the primary product and technical spec for the repository. Implementation-specific ownership and workflow rules live in the AGENTS files.

## Product Intent

- Keep Mosquitto as the broker and source of truth for broker policy.
- Provide a safer, more observable admin plane around it.
- Avoid hidden mutation.
- Keep the blast radius small and recovery paths visible.

## Runtime Baseline

- Node.js 24 LTS
- latest Svelte 5 and SvelteKit 2 conventions
- strict TypeScript
- single-broker, self-hosted deployment in V1
- Kubernetes-first deployment assumptions, while still supporting Compose and generic Linux installs

## In Scope For V1

### Mosquitto Dynamic Security

- clients
- groups
- roles
- ACL entries
- client-group membership
- role assignments
- password set and reset
- enable and disable clients
- effective-permissions viewer

### Broker Configuration

- direct raw Mosquitto config editing through pull and push of the configured main config file
- configured CA and public key file status checks and downloads by named broker file ID
- optimistic conflict checks against the last pulled config text before push
- no structured JSON broker-config model in the app

### Operational Actions

- broker config pull
- broker config push
- live dynsec mutation
- broker reload
- broker restart

### MQTT Explorer

- API-managed MQTT client sessions scoped to each browser session
- authenticated UI access for custom MQTT credentials, with dynsec-client mode limited to roles that have `manage_broker`
- connect to any reachable MQTT broker, defaulting to the configured broker host and port
- dynsec-client mode may use an operator-entered password or no password; when the selected username matches the configured dynsec admin username, the server may reuse the configured admin password
- optional TLS transport with certificate validation disabled in the current implementation
- subscribe with QoS `0`, `1`, or `2`
- topic explorer keeps only the latest payload per topic in memory, allows operators to clear the in-memory latest-topic view, and supports session-scoped tracked-topic limits with oldest-topic eviction
- publish with QoS and retain controls
- tearing down the browser live channel must tear down the corresponding API-owned MQTT session after a short grace period

### Admin Authentication

- local auth with session cookies
- OAuth/OIDC with session cookies
- trusted HTTP header auth
- OIDC callback URL defaults to `{publicBaseUrl}{basePath}/auth/callback` and may be overridden with `config.auth.oidc.callbackUrl`
- OIDC token endpoint client authentication defaults to `client_secret_post` and may be overridden with `config.auth.oidc.tokenEndpointAuthMethod`
- OIDC discovery may be overridden per endpoint with optional `config.auth.oidc.authorizationEndpoint`, `config.auth.oidc.tokenEndpoint`, and `config.auth.oidc.userinfoEndpoint`
- allowed combinations:
  - local only
  - OAuth only
  - header auth only
  - local + OAuth
  - local + header auth
- forbidden combinations:
  - header auth + OAuth
  - local + header auth + OAuth

### Safety And Observability

- audit log for all write actions
- configurable structured auth-outcome logging to console, file, or curl sinks
- startup logs and the authenticated app shell expose the embedded control-plane build label
- snapshot export and import
- diagnostics and health dashboard

### UI Customization

- custom CSS override file loaded from an env-var-specified path
- optional UI language override JSON loaded from `config.ui.languageFilePath`
- override path must point at a CSS file in a location the app can serve safely
- language override path may point at a JSON file on the app filesystem and falls back to bundled strings when unset or invalid
- shared tokens and selectors must remain stable so override CSS is durable

## Explicitly Out Of Scope For V1

- multi-broker management
- clustering and HA orchestration
- AI features
- alerting engine
- Slack or SaaS integrations
- ACME, cert-manager, or certificate issuance workflows
- arbitrary plugin management
- historical charts
- retained-message history, archival, or destructive retained-message management

## Architecture

### High-Level Shape

The control plane remains one product, but the repository now has two deployables and a split app workspace:

- `mqttctl/`
  - workspace root
  - `mqttctl-fe/` for SvelteKit UI and route entrypoints
  - `mqttctl-api/` for internal server modules, auth, DB, dynsec, audit, snapshots, and jobs
- `broker-agent/`
  - broker-local REST agent with a shared API key on protected endpoints, plus unauthenticated `/health` and `/healthz`
  - full broker-config read and write operations against the configured main config path
  - standalone broker reload and restart
  - dynsec command execution and state-file reads
  - optional HTTP and HTTPS listeners
  - Mosquitto process supervision in the broker-local image

This remains one repository. The UI or app API should not absorb broker-local file and process control back into the main app once the broker agent boundary exists.

The primary deployment assumption is that the app may run in a different Kubernetes pod from Mosquitto. Design must not require broker shell access.

### Core Components

1. Frontend
   - SSR for first load and auth-aware routing
   - client-side interactivity for CRUD and status refresh
2. Backend API
   - authenticated REST endpoints
   - form actions or typed fetch usage from UI
3. Dynsec adapter
   - wraps `mosquitto_ctrl dynsec`
   - parses command output
   - maps failures to structured app errors
4. Config manager
   - reads and writes the configured broker config file as raw text
   - loads the current broker config on page load and supports direct pull and push actions
   - rejects stale pushes when the broker config no longer matches the last pulled copy
   - checks and serves configured CA and public key files by symbolic ID without accepting broker paths from request input
5. App database
   - stores app-owned users, sessions, settings, audit log, and snapshots
6. Job pipeline
   - in-process queue currently used to serialize broker-config push, reload, and restart operations

## Source Of Truth Rules

- Mosquitto is authoritative for dynsec runtime security state.
- Broker config files are authoritative for managed broker settings.
- The app DB is authoritative for app-only concerns:
  - UI accounts
  - sessions
  - audit log
  - settings-backed defaults and operation status
  - snapshot records and payload metadata

The app must not silently drift these boundaries.

## Config And Secret Inputs

### Config Files

The app loads exactly two JSON files at startup:

- `config` JSON
- `secrets` JSON

Both file paths are supplied via env vars. Both files are read-only to the application and require a full application reload to take effect.

### Policy

- Put deployment wiring, paths, auth mode selection, and integration details in config files.
- Put startup logging policy, sink defaults, and auth-outcome routing in config files.
- Put secrets, passwords, client secrets, signing keys, and secret material in the secrets file.
- Put mutable non-secret product settings in the DB wherever possible.
- Use env vars for startup path selection, deploy-time logging overrides, optional Kubernetes log metadata hints, and deployment-local file hooks such as the custom CSS override path.
- `config.httpApi.mode` selects how browser HTTP API calls are routed:
  - `browser`: browser calls use `config.httpApi.browserBasePath`, defaulting to `/api`
  - `proxy`: browser calls use `config.httpApi.proxy.basePath`, and the SvelteKit Node process proxies those HTTP requests to `config.httpApi.proxy.upstreamBaseUrl` plus `config.httpApi.proxy.upstreamBasePath`

## Database Support

### Required Modes

- SQLite
- Postgres

### Rules

- SQLite is the default single-node option.
- SQLite file path comes from an env var.
- Postgres connection details live in config JSON, except secrets which live in secrets JSON.
- First run should preseed required records and defaults.

## RBAC

App-level roles:

- `super_admin`
- `broker_admin`
- `security_admin`
- `operator`
- `viewer`

Role intent:

- `viewer`: read-only
- `operator`: operational actions and diagnostics, no security edits
- `security_admin`: dynsec CRUD, no broker config edits
- `broker_admin`: broker config edits, restart or reload operations, and MQTT explorer dynsec access
- `super_admin`: full access to the current control-plane capabilities, including app-user management

All authenticated roles may use the MQTT explorer with user-supplied custom client credentials. Only `broker_admin` and `super_admin` may enumerate or connect with dynsec client presets.
All authenticated roles may view managed CA or public key file status and download configured public broker artifacts on the MQTT Config page. Only `broker_admin` and `super_admin` may read raw broker config text or perform broker config pull, push, reload, or restart actions.

## Dynamic Security Requirements

### Clients

- create
- delete
- enable and disable
- set or rotate password
- assign and remove groups
- assign and remove direct roles
- set an optional client ID at create time
- configure one optional default role that is auto-assigned to newly created clients
- store a default-role priority alongside the optional default role
- on initial application startup only, if only broker bootstrap roles exist and no default client role is configured, create `read-all` as the default role and create `read-write-all` as an additional non-default bootstrap role
- if that configured default role is later deleted, surface the missing-role error to the operator instead of recreating it automatically
- effective permissions view

### Groups

- create
- delete
- assign and remove member clients with per-edge priorities
- assign and remove roles
- assign roles with per-edge priorities
- list member clients

### Roles

- create
- delete
- add ACL entries
- remove ACL entries
- batch-add multiple ACL types to the same topic, effect, and priority in one action

### ACL Presentation

Expose the raw dynsec ACL dimensions used by the current implementation:

- `publishClientSend`
- `publishClientReceive`
- `subscribeLiteral`
- `subscribePattern`
- `unsubscribeLiteral`
- `unsubscribePattern`

Support multi-select ACL add flows for applying several raw ACL dimensions to one topic in a single action.

Each entry includes:

- action type
- topic or pattern
- allow or deny
- priority

Assignment priorities for client-group and role-assignment edges are hidden by default and exposed only when `config.ui.dynsec.showAssignmentPriorities` is enabled.
DynSec page labels may be overridden through an optional JSON file at `config.ui.languageFilePath`.

## Effective Permissions View

For a chosen client, show:

- direct role assignments
- direct group membership
- inherited group roles
- merged ACL set
- equal-priority allow and deny conflicts resolved with deny precedence
- warnings for obvious broad write access
- warnings for conflicting allow and deny overlap
- warnings for sensitive-topic access

## Broker Config Management

- The configured broker config path is the file edited by the Config page.
- The MQTT Config page may also check and download only the configured `broker.keyFiles.caFile`, `broker.keyFiles.mosquittoPublicKey`, and `broker.keyFiles.brokerPublicKey` files.
- Private keys are intentionally excluded from the download surface.
- The app loads the current broker config text and pushes edited text back without rendering or storing an intermediate structured config.
- Raw broker-config push is conflict-checked against the last pulled text and rejected when the broker file changed in the meantime.
- Reload and restart stay explicit operator actions after a raw broker-config push.

## Auth Requirements

### Local Auth

- bootstrap admin account on first run
- username required
- email optional
- Argon2id password hashing
- admin-driven password resets for local-auth accounts
- session invalidation on password reset or account disable for local-auth accounts
- env-seeded bootstrap credentials are allowed on first run
- when no seed is provided, generate a default `admin` account with a one-time random password using only `0-9`, `a-z`, and `A-Z`
- print autogenerated bootstrap credentials to console once on initial run with prominent `#####` delimiters
- never write autogenerated bootstrap credentials to file logs
- canonicalize usernames to lowercase to avoid duplicate identities that differ only by case
- mark the bootstrap local admin account as protected from automatic OIDC or trusted-header username linking; new accounts default to unprotected unless changed directly in storage

### OAuth Or OIDC

- generic issuer-based configuration
- session-based after callback
- support issuer URL, client ID, client secret, scopes, claim mapping, and optional explicit authorization/token/userinfo endpoint overrides
- disabled when header auth is enabled
- OIDC provider handling should stay generic and config-driven
- successful upstream OIDC logins may merge onto an existing lowercase username match, preserve its role, clear any stored local password or disabled state, and convert the record to OIDC-backed auth unless the account is marked protected from auto-linking
- the local disabled flag does not block a new OIDC-authenticated session; the upstream identity provider remains the source of truth for login eligibility

### Header Auth

- disabled by default
- trust only configured proxy CIDRs
- configurable required headers
- configurable username header
- optional groups header
- current implementation accepts the groups header setting but does not map proxy groups to app roles yet
- reject auth headers from untrusted sources
- disabled when OAuth is enabled
- auto-create shadow users on first trusted login
- merge onto an existing user when the normalized lowercase username already exists, clearing any stored local password or disabled state and converting the record to header-backed auth unless it is protected from auto-linking
- canonicalize incoming usernames to lowercase before lookup or creation
- protected local accounts must not be auto-linked from trusted headers by username match
- the local disabled flag does not block a new trusted-header-authenticated session; the upstream trusted proxy remains the source of truth for login eligibility

### Sessions

- signed, HTTP-only, secure cookies
- CSRF protection on state-changing operations
- configurable lifetime
- session rotation on login
- DB-backed invalidation

## Audit Log

Every write action records:

- timestamp
- actor
- auth mode
- source IP
- action and target
- before and after summary
- result
- success or failure
- correlation ID

The audit log also records successful control-plane startup and successful or failed local or OIDC login outcomes.

The audit table is append-only from the UI perspective.

The audit page and export support the latest `10`, `20`, `50`, `100`, or `all` entries.

`GET /api/audit` supports:

- the same latest-entry limit presets through a query param
- JSON download mode for the selected latest-entry slice

Audit exports must include:

- export timestamp
- control-plane build label
- the applied index-range filter
- the exported entry slice
- a SHA-256 integrity summary for the full audit chain

Each exported audit entry must include the previous entry hash so operators can recompute the current entry hash from the JSON object itself and compare it against the chain.

## Snapshots

Support:

- dynsec export
- broker config export
- combined JSON export
- dry-run import preview
- broker-config apply workflow

The export output must contain JSON data for:

- `title` set to `MQTTCTL`
- `type` set to `snapshot`
- export timestamp
- control-plane build label in the form `v<version>-<commit>`
- snapshot metadata including exported snapshot ID, kind, and note
- captured data payloads
- app-user payloads in combined exports must not include password hashes

Current import behavior:

- preview accepts exported snapshot JSON
- apply currently restores only `data.brokerConfig.current` when present
- dynsec payloads remain preview-only because client passwords are not exported or restored
- combined apply does not recreate app users or dynsec state automatically

Compressed archive formats are out of scope for V1 snapshot export.

## Diagnostics And Health

The current diagnostics summary reports:

- broker reachability
- dynsec-state readability
- dynsec bootstrap status
- broker-config readability
- last reload or restart result

The dashboard page also shows:

- user, client, group, and role counts
- recent audit entries for roles that can view audit history
- transport security badges for the current UI and broker paths
- live diagnostics updates over a websocket on `/api/dashboard/ws`

## Non-Functional Requirements

### Security

- secure cookies
- same-origin protection on state-changing HTTP routes
- server-side authorization on every mutation
- explicit trusted-proxy handling
- no command injection exposure
- argument-array process execution only
- explicit startup-configured broker config paths for direct file operations
- stable structured errors and correlation IDs

### Reliability

- tolerate temporary broker unavailability
- prefer idempotent writes
- serialize config push, reload, and restart operations through the in-process queue

### Performance

Current implementation notes:

- the repo does not yet check in benchmark-backed performance targets
- the DynSec and admin pages currently render full lists and do not yet implement filtering or pagination
- large-state UX and benchmarking remain future work

### Portability

Primary deployment targets:

- Kubernetes
- Docker Compose
- bare-metal Linux

V1 should ship examples for:

- container image
- Compose
- no checked-in systemd unit files yet

## Deployment Notes

- The app may run separately from Mosquitto and still needs to manage dynsec and broker lifecycle safely.
- Dynsec operations should work over network connectivity and must not depend on shell access to the broker pod.
- Config mutation may use shared storage or other deployment wiring, but the app must only write the configured raw broker config path explicitly.
- Restart or reload mechanisms must account for Kubernetes deployments where direct process signaling may be unavailable or undesirable.

## HTTP Surface

The current repository exposes these UI and API routes:

By default these routes remain under `/api`. When HTTP API proxy mode is enabled, the browser-facing API prefix may be changed with `config.httpApi.proxy.basePath` while the upstream API prefix remains independently configured with `config.httpApi.proxy.upstreamBasePath`.

### Session And Auth Routes

- `GET /auth/login`
- `POST /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /api/me`

### Dashboard And App Admin Routes

- `GET /api/dashboard`
- `GET /api/dashboard/ws` (websocket upgrade)
- `GET /api/diagnostics`
- `GET /api/audit` with latest-entry limit presets and optional JSON download mode
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:id`
- `DELETE /api/users/:id`

### Broker Config Routes

- `GET /api/config/pull`
- `POST /api/config/push`
- `GET /api/config/key-files`
- `GET /api/config/key-files/:fileId`
- `POST /api/config/reload`
- `POST /api/config/restart`

### DynSec Routes

- `GET /api/dynsec/clients`
- `POST /api/dynsec/clients`
- `GET /api/dynsec/clients/:username`
- `PATCH /api/dynsec/clients/:username`
- `DELETE /api/dynsec/clients/:username`
- `GET /api/dynsec/groups`
- `POST /api/dynsec/groups`
- `PATCH /api/dynsec/groups/:groupname`
- `DELETE /api/dynsec/groups/:groupname`
- `GET /api/dynsec/roles`
- `POST /api/dynsec/roles`
- `PATCH /api/dynsec/roles/:rolename`
- `DELETE /api/dynsec/roles/:rolename`
- `GET /api/dynsec/settings/client-defaults`
- `PATCH /api/dynsec/settings/client-defaults`

### Snapshot Routes

- `POST /api/snapshots/export`
- `POST /api/snapshots/import`

### MQTT Explorer Routes

- `GET /api/mqtt/state`
- `GET /api/mqtt/events`
- `POST /api/mqtt/connect`
- `POST /api/mqtt/disconnect`
- `POST /api/mqtt/subscribe`
- `POST /api/mqtt/unsubscribe`
- `POST /api/mqtt/publish`
- `POST /api/mqtt/messages`

## Core Tables

- `app_users`
- `sessions`
- `auth_requests`
- `settings`
- `audit_log`
- `snapshots`

The `settings` table also stores dynsec client defaults, dynsec bootstrap default-role initialization metadata, and operation status.

The `audit_log` table also stores append-order chain metadata so each row can reference the previous row hash and expose export-time integrity verification.

## Testing Requirements

### Current Checked-In Coverage

- auth account update rules and trusted-header auto-linking
- broker-agent client path handling, including path prefixes, insecure HTTPS, and unauthenticated health requests
- broker key file status and download handling
- config page permission boundaries
- dashboard data fallback behavior
- DynSec bootstrap default-role handling
- logging env override and Kubernetes metadata handling
- navigation visibility by role
- broker-agent dynsec stderr filtering

### Not Yet Checked In

- disposable-Mosquitto integration coverage for the full dynsec and lifecycle flow
- browser-level end-to-end coverage for the Svelte UI

## Acceptance Criteria

V1 is ready when the application:

1. manages dynsec clients, groups, roles, and ACLs from the UI
2. edits the configured raw broker config safely with conflict checks
3. keeps reload and restart as explicit operator actions after config edits
4. supports the required auth-mode combinations
5. works fully offline after installation
6. audits all writes
7. supports snapshot export, import preview, and broker-config apply
8. survives broker restarts without losing app-owned state
9. avoids cloud or vendor dependencies
10. never rewrites operator-owned Mosquitto paths except the configured main config file
