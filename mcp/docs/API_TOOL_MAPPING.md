# mqttctl API to MCP tool mapping

Status: implemented

## Conventions

- Tool names use the `mqttctl_` prefix and snake_case inputs.
- `read` tools accept either an MCP read token or read/write token.
- `write` tools require an MCP read/write token.
- `confirm` means the tool additionally requires `confirm: true`.
- mqttctl remains authoritative for its role/capability checks and input validation.
- API errors are returned with sanitized HTTP status, `errorKey`, `errorCode`, reason, correlation ID, and safe details.
- Optional `include_raw` may include the sanitized mqttctl response envelope when useful; it never exposes credentials or signing proofs.

## General, dashboard, diagnostics, and audit

| MCP tool | mqttctl API | Access | Confirm | Notes |
| --- | --- | --- | --- | --- |
| `mqttctl_whoami` | `GET /api/me` | read | no | Returns the protected `mcp` actor, delegated token name/access, and correlation ID. |
| `mqttctl_get_dashboard` | `GET /api/dashboard` | read | no | Current dashboard snapshot, including MCP Server reachability when MCP authentication is enabled. |
| `mqttctl_get_diagnostics` | `GET /api/diagnostics` | read | no | Current diagnostics summary. |
| `mqttctl_list_audit` | `GET /api/audit?limit=...` | read | no | `limit`: `10`, `20`, `50`, `100`, or `all`. |
| `mqttctl_export_audit` | `GET /api/audit?limit=...&download=1` | read | no | Returns parsed export data and attachment metadata rather than writing a server-side file. |

`/api/dashboard/ws` will not be held open by the MCP server in the initial implementation. The current-state data exposed by that WebSocket is available from `GET /api/dashboard`. This is called out for explicit review because it is the only `/api` transport not mapped one-to-one.

## MCP access visibility

| MCP tool | mqttctl API | Access | Confirm | Notes |
| --- | --- | --- | --- | --- |
| `mqttctl_get_mcp_access` | `GET /api/mcp/access` | read | no | Returns authentication-subsystem enablement, MCP-user disabled state, key ID/fingerprint metadata, default/effective capabilities, and heartbeat runtime status. Never returns key content. |

`PATCH /api/mcp/access` is intentionally not exposed as an MCP tool. It is restricted to an interactive `super_admin` and controls MCP-user disabled state and allowed capabilities, so MCP cannot re-enable or expand its own authority.

`POST /api/mcp/heartbeat` is an internal signed service-heartbeat endpoint, not an agent tool. It supplies MCP version/build metadata and drives dashboard connected/disconnected status.

## Application users

The MCP principal may invoke these tools only while its `manage_users` capability is allowed. mqttctl permanently rejects MCP attempts to create/promote/update/delete a superadmin.

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_list_users` | `GET /api/users` | read | no | Lists ordinary app users; MCP system principal is returned separately by the MCP access endpoint/UI. |
| `mqttctl_create_user` | `POST /api/users` | write | no | `username`, optional `email`, required local `password`, `role`. MCP cannot choose `super_admin`. |
| `mqttctl_update_user` | `PATCH /api/users/{id}` | write | no | `id`, `email`, `role`, `disabled`, optional `password`. MCP cannot target or promote to `super_admin`. |
| `mqttctl_delete_user` | `DELETE /api/users/{id}` | write | yes | MCP cannot target `super_admin`; requires `confirm: true`. |

## Broker configuration and managed public key files

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_list_broker_key_files` | `GET /api/config/key-files` | read | no | Returns configured public-file status plus broker-agent and MCP runtime information used by the renamed Runtime Info section. |
| `mqttctl_read_broker_key_file` | `GET /api/config/key-files/{fileId}` | read | no | `file_id`: `caFile`, `mosquittoPublicKey`, or `brokerPublicKey`; returns filename, content type, and content. |
| `mqttctl_pull_broker_config` | `GET /api/config/pull` | read | no | Returns current raw broker configuration; upstream requires `manage_broker`. |
| `mqttctl_push_broker_config` | `POST /api/config/push` | write | yes | `rendered`, `expected_current`, `confirm`; preserves mqttctl conflict checking. |
| `mqttctl_reload_broker` | `POST /api/config/reload` | write | yes | Explicit reload; `confirm: true`. |
| `mqttctl_restart_broker` | `POST /api/config/restart` | write | yes | Explicit restart; `confirm: true`. |

## Dynamic Security clients

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_list_dynsec_clients` | `GET /api/dynsec/clients` | read | no | Lists clients. |
| `mqttctl_create_dynsec_client` | `POST /api/dynsec/clients` | write | no | `username`, optional `password`, optional `client_id`, optional `disabled`. |
| `mqttctl_get_dynsec_client_permissions` | `GET /api/dynsec/clients/{username}` | read | no | Effective roles, groups, ACLs, and warnings. |
| `mqttctl_set_dynsec_client_enabled` | `PATCH /api/dynsec/clients/{username}` | write | no | Sends action `setEnabled`; input `enabled`. |
| `mqttctl_set_dynsec_client_password` | same PATCH endpoint | write | no | Sends action `setPassword`; secret input is always redacted. |
| `mqttctl_assign_dynsec_client_role` | same PATCH endpoint | write | no | `rolename`, `priority`. |
| `mqttctl_remove_dynsec_client_role` | same PATCH endpoint | write | no | `rolename`. |
| `mqttctl_add_dynsec_client_group` | same PATCH endpoint | write | no | `groupname`, `priority`. |
| `mqttctl_remove_dynsec_client_group` | same PATCH endpoint | write | no | `groupname`. |
| `mqttctl_delete_dynsec_client` | `DELETE /api/dynsec/clients/{username}` | write | yes | Requires `confirm: true`. |

## Dynamic Security groups

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_list_dynsec_groups` | `GET /api/dynsec/groups` | read | no | Lists groups. |
| `mqttctl_create_dynsec_group` | `POST /api/dynsec/groups` | write | no | `groupname`. |
| `mqttctl_add_dynsec_group_client` | `PATCH /api/dynsec/groups/{groupname}` | write | no | Action `addClient`; `username`, `priority`. |
| `mqttctl_remove_dynsec_group_client` | same PATCH endpoint | write | no | Action `removeClient`; `username`. |
| `mqttctl_add_dynsec_group_role` | same PATCH endpoint | write | no | Action `addRole`; `rolename`, `priority`. |
| `mqttctl_remove_dynsec_group_role` | same PATCH endpoint | write | no | Action `removeRole`; `rolename`. |
| `mqttctl_delete_dynsec_group` | `DELETE /api/dynsec/groups/{groupname}` | write | yes | Requires `confirm: true`. |

The current API has no individual group GET operation; list data comes from `GET /api/dynsec/groups`.

## Dynamic Security roles and ACLs

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_list_dynsec_roles` | `GET /api/dynsec/roles` | read | no | Lists roles and ACLs. |
| `mqttctl_create_dynsec_role` | `POST /api/dynsec/roles` | write | no | `rolename`. |
| `mqttctl_add_dynsec_role_acls` | `PATCH /api/dynsec/roles/{rolename}` | write | no | Action `addAcl`; one or more `acltypes`, `topic`, `allow`, `priority`. |
| `mqttctl_remove_dynsec_role_acl` | same PATCH endpoint | write | no | Action `removeAcl`; `acltype`, `topic`. |
| `mqttctl_delete_dynsec_role` | `DELETE /api/dynsec/roles/{rolename}` | write | yes | Requires `confirm: true`. |

Allowed ACL types remain exactly those accepted by mqttctl:

- `publishClientSend`
- `publishClientReceive`
- `subscribeLiteral`
- `subscribePattern`
- `unsubscribeLiteral`
- `unsubscribePattern`

## Dynamic Security client defaults

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_get_dynsec_client_defaults` | `GET /api/dynsec/settings/client-defaults` | read | no | Returns default role name and priority. |
| `mqttctl_set_dynsec_client_defaults` | `PATCH /api/dynsec/settings/client-defaults` | write | no | Nullable `default_role_name`, integer `default_role_priority`. |

## Snapshots

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_export_snapshot` | `POST /api/snapshots/export` | write | no | `kind`: `dynsec`, `broker-config`, or `combined`; optional `note`. Creates a snapshot record. |
| `mqttctl_preview_snapshot_import` | `POST /api/snapshots/import` with `apply: false` | write | no | Validates/previews supplied exported payload. Classified write because the existing endpoint is POST and records an audit entry. |
| `mqttctl_apply_snapshot_import` | `POST /api/snapshots/import` with `apply: true` | write | yes | Requires `confirm: true`. Existing mqttctl limitations on restored data remain. |

## MQTT Explorer

Detailed lifecycle behavior is in `MQTT_LIFECYCLE.md`.

MQTT connection/session-control tools are classified as `read` because they only create and manage the calling MCP session's transient read channel. Publishing is `write`.

| MCP tool | mqttctl API | Access | Confirm | Inputs/notes |
| --- | --- | --- | --- | --- |
| `mqttctl_mqtt_connect` | `POST /api/mqtt/connect` | read | no | `host`, `port`, `tls`, `auth_mode`, `username`, optional `password`, `client_id`. Calls mqttctl; MCP never connects to broker. |
| `mqttctl_mqtt_get_state` | `GET /api/mqtt/state` | read | no | Current connection/subscription/latest-topic state for this MCP session. |
| `mqttctl_mqtt_subscribe` | `POST /api/mqtt/subscribe` | read | no | `filter`, `qos`; starts/maintains internal SSE consumer. |
| `mqttctl_mqtt_unsubscribe` | `POST /api/mqtt/unsubscribe` | read | no | `filter`; stops SSE only when no subscriptions remain or the session is disconnected. |
| `mqttctl_mqtt_poll_messages` | local queue populated from `GET /api/mqtt/events` | read | no | Atomically drains up to `max_messages`; refreshes one-hour activity deadline. |
| `mqttctl_mqtt_buffer_status` | local queue plus `GET /api/mqtt/state` when requested | read | no | Queue counts, bytes, dropped count, last poll, expiry, SSE status, upstream state. Does not refresh the inactivity deadline. |
| `mqttctl_mqtt_clear_messages` | `POST /api/mqtt/messages` action `clear` plus local queue clear | read | no | Clears mqttctl latest-topic state and this MCP session's pending buffer. |
| `mqttctl_mqtt_set_tracked_topics_limit` | `POST /api/mqtt/messages` action `set_limit` | read | no | Limit is `5`, `10`, `20`, `25`, `100`, or `null`. This is mqttctl's latest-topic limit, separate from MCP queue bounds. |
| `mqttctl_mqtt_publish` | `POST /api/mqtt/publish` | write | no | `topic`, `payload`, `qos`, `retain`; payload is redacted from logs/audit diagnostics. |
| `mqttctl_mqtt_disconnect` | `POST /api/mqtt/disconnect` | read | no | Aborts SSE and removes local session data after upstream disconnect. |

`GET /api/mqtt/events` is covered by the server's internal SSE consumer rather than a raw MCP tool. Returning an unbounded SSE stream as one tool result is not compatible with the poll-buffer requirement.

## API route coverage summary

| Existing route | Covered |
| --- | --- |
| `/api/audit` | yes |
| `/api/config/key-files` | yes |
| `/api/config/key-files/{fileId}` | yes |
| `/api/config/pull` | yes |
| `/api/config/push` | yes |
| `/api/config/reload` | yes |
| `/api/config/restart` | yes |
| `/api/dashboard` | yes |
| `/api/dashboard/ws` | current snapshot covered by GET; no persistent MCP WebSocket proposed |
| `/api/diagnostics` | yes |
| `/api/dynsec/clients` | yes |
| `/api/dynsec/clients/{username}` | yes, all actions |
| `/api/dynsec/groups` | yes |
| `/api/dynsec/groups/{groupname}` | yes, all actions |
| `/api/dynsec/roles` | yes |
| `/api/dynsec/roles/{rolename}` | yes, all actions |
| `/api/dynsec/settings/client-defaults` | yes |
| `/api/me` | yes |
| `/api/mqtt/connect` | yes |
| `/api/mqtt/disconnect` | yes |
| `/api/mqtt/events` | yes, internal SSE consumer |
| `/api/mqtt/messages` | yes, both actions |
| `/api/mqtt/publish` | yes |
| `/api/mqtt/state` | yes |
| `/api/mqtt/subscribe` | yes |
| `/api/mqtt/unsubscribe` | yes |
| `/api/snapshots/export` | yes |
| `/api/snapshots/import` | yes, preview and apply |
| `/api/users` | yes |
| `/api/users/{id}` | yes |
| proposed `/api/mcp/access` | GET exposed; PATCH intentionally superadmin-only |
| proposed `/api/mcp/heartbeat` | yes, internal signed MCP-service heartbeat |

Non-API browser routes such as `/auth/callback`, `/auth/logout`, login page actions, static CSS, and ordinary Svelte pages are not MCP tools.
