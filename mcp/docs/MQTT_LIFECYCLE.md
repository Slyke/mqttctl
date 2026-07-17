# MQTT API session and buffer lifecycle

Status: implemented

## 1. Core rule

The MCP server never creates its own MQTT connection. All MQTT operations go through mqttctl's existing MQTT Explorer HTTP API and SSE stream.

This preserves mqttctl's credential handling, RBAC, audit behavior, broker connection implementation, validation, and current product limitations.

## 2. Session isolation

mqttctl keys an MQTT Explorer session by:

```text
app-user-id + mqttctl_mqtt_browser_session cookie
```

All MCP requests authenticate as the stable mqttctl `mcp` user, so the MCP server must provide a unique browser-session cookie for each MCP protocol session. Otherwise different agents would share subscriptions and messages.

For each initialized MCP session, the MCP server stores:

- MCP session ID.
- Bound MCP bearer-token name and access category.
- Random mqttctl MQTT browser-session cookie value.
- Current SSE abort controller/state.
- Current upstream connection/subscription metadata.
- In-memory message queue and byte count.
- Dropped-message counters.
- Creation, last poll, last event, and expiry timestamps.

Changing bearer identity for an existing MCP session is rejected.

## 3. Connect

`mqttctl_mqtt_connect`:

1. Validates tool input locally without logging secrets.
2. Sends the request to `POST /api/mqtt/connect` with the session's unique MQTT browser cookie and an Ed25519 proof.
3. Lets mqttctl enforce normal capabilities. `dynsec_client` mode continues to require mqttctl `manage_broker`; `custom` mode follows the existing mqttctl rules.
4. Stores only the sanitized connection state. The password is not retained after the HTTP request completes.
5. Sets the initial inactivity deadline.

Only one mqttctl MQTT Explorer connection exists per MCP protocol session. Calling connect again follows mqttctl's existing replacement behavior.

## 4. Subscribe and SSE consumption

`mqttctl_mqtt_subscribe`:

1. Calls `POST /api/mqtt/subscribe` using the session cookie.
2. On success, ensures one background connection to `GET /api/mqtt/events` exists for that MCP session.
3. Parses SSE frames incrementally across arbitrary HTTP chunks.
4. Ignores comments/heartbeats, consumes explorer-state events for upstream status, and consumes named `mqtt-message` events for payload delivery.
5. Appends each valid individual message event to the in-memory queue in receive order.

There is one SSE consumer per MCP session, not one consumer per topic filter.

### Individual-message delivery

mqttctl emits a named SSE event immediately for each broker publication before its normal coalesced explorer-state update. Browser MQTT Explorer clients ignore the named event and retain their existing behavior; the MCP consumer uses it so rapid same-topic publications are not lost to state coalescing.

## 5. In-memory queue

Messages remain queued until one of these events:

- The agent polls and drains them.
- The agent explicitly clears messages.
- The MQTT/MCP session disconnects.
- The one-hour inactivity deadline expires.
- The MCP server process restarts.
- A configured safety bound is reached and oldest entries are dropped.

Proposed defaults:

```text
maximum queued messages per MCP session: 10,000
maximum queued payload bytes per MCP session: 16 MiB
maximum messages returned by one poll: 1,000
default messages returned by one poll: 100
```

The limits are configurable but retain absolute validated upper bounds. Queue overflow is never silent:

- Oldest entries are removed first.
- `dropped_messages` and `dropped_bytes` counters increase.
- Poll and status results include the counters and `overflowed: true`.
- A gated warning is emitted without payload contents.

Unbounded buffering is intentionally not proposed because a disconnected or malicious agent could exhaust the MCP process.

## 6. Poll semantics

`mqttctl_mqtt_poll_messages` atomically:

1. Performs a lightweight signed mqttctl authorization check so a disabled MCP principal cannot retrieve already-buffered data.
2. Selects up to `max_messages` oldest queued messages.
3. Removes exactly those selected messages.
4. Refreshes `last_polled_at` and the one-hour expiry deadline.
5. Returns messages in receive order plus queue and loss metadata.

Proposed result shape:

```json
{
  "ok": true,
  "messages": [],
  "returned": 0,
  "remaining": 0,
  "queuedBytes": 0,
  "droppedMessages": 0,
  "droppedBytes": 0,
  "overflowed": false,
  "lastPolledAt": "2026-07-16T00:00:00.000Z",
  "expiresAt": "2026-07-16T01:00:00.000Z",
  "upstream": {
    "sseConnected": true,
    "lastEventAt": null
  }
}
```

Polling an empty queue still counts as checking and refreshes the deadline.

`mqttctl_mqtt_get_state` and `mqttctl_mqtt_buffer_status` do not refresh the inactivity deadline. The user's requirement is interpreted literally: only polling/checking the message buffer keeps subscriptions alive.

### 6.1 MCP-user disablement

When a superadmin disables the special mqttctl `mcp` user:

- New signed MCP requests are rejected after proof verification.
- The MQTT SSE route rechecks MCP-user authorization on its heartbeat cycle and closes the stream.
- Poll and status tools fail their lightweight upstream authorization check and do not return buffered payloads.
- The MCP server discards affected local MQTT queues/sessions after the terminal authorization failure; mqttctl's SSE-close grace behavior releases broker connections even when explicit disconnect is no longer authorized.
- Re-enabling MCP permits new work but does not restore discarded connections, subscriptions, or messages.

## 7. One-hour inactivity expiry

A maintenance task runs at least once per minute. When a session has active MQTT state and more than one hour has passed since its last message poll:

1. Mark the local session as expiring so new work cannot race cleanup.
2. Abort the SSE request.
3. Best-effort call `POST /api/mqtt/disconnect` with a fresh signed proof and the session cookie.
4. Discard subscriptions, queued messages, and credentials/state metadata.
5. Remove the MQTT state from the MCP session.
6. Emit a structured informational cleanup log; failures use `generateError` and remain sanitized.

An internal cleanup request may use the session's bound access category because disconnect is a transient session-control operation allowed to read identities.

If upstream disconnect fails, local state is still removed. mqttctl also closes an MQTT Explorer session after its SSE listener disappears and its existing grace period elapses.

## 8. Disconnect behavior

### Explicit MQTT disconnect tool

`mqttctl_mqtt_disconnect` calls the upstream disconnect endpoint, aborts SSE, and removes all local MQTT state after the upstream call settles. It returns a sanitized upstream result plus cleanup status.

### Explicit MCP protocol disconnect

`DELETE /mcp` closes the MCP protocol session. The server immediately performs the same MQTT cleanup. Tool calls using that MCP session ID are rejected afterward.

### Abrupt network loss

A closed individual HTTP request/socket is not sufficient evidence that a stateful MCP client disconnected. Streamable HTTP uses many ordinary request closures. If the client disappears without deleting its MCP session, the one-hour no-poll rule performs cleanup.

### Server shutdown

SIGTERM/SIGINT stops accepting new calls, aborts all SSE streams, best-effort disconnects all upstream MQTT sessions within a bounded grace period, closes transports, and exits. In-memory messages are not persisted.

## 9. Unsubscribe behavior

`mqttctl_mqtt_unsubscribe` calls the upstream unsubscribe endpoint and updates local subscription metadata from the returned explorer state.

- If subscriptions remain, the SSE consumer remains open.
- If no subscriptions remain, the server may close SSE and clear the queue after preserving the unsubscribe result.
- A later subscribe reopens SSE.
- Unsubscribe does not refresh the one-hour message-poll deadline.

## 10. SSE reconnect behavior

Unexpected SSE termination does not immediately discard subscriptions.

- Reconnect uses bounded exponential backoff with jitter.
- Every reconnect sends a new signed proof and the same MQTT browser-session cookie.
- A successful event resets the backoff.
- A `401`/`403` authentication or capability response stops reconnecting and records the sanitized failure until the agent calls a relevant tool again.
- A missing upstream MQTT session stops reconnecting and updates local state.
- Reconnect attempts stop at explicit disconnect, MCP session deletion, inactivity expiry, or shutdown.

SSE reconnect activity does not refresh the one-hour poll deadline.

## 11. Publish behavior

`mqttctl_mqtt_publish` calls `POST /api/mqtt/publish` and requires an MCP read/write token.

- Topic, QoS, retain flag, and payload length may be logged.
- Payload and password values are redacted.
- Publishing does not alter or refresh the message-buffer inactivity deadline.
- A published message received back through a subscription is buffered like any other SSE-exposed message.

## 12. Clear behavior

`mqttctl_mqtt_clear_messages`:

1. Calls the upstream `messages` endpoint with action `clear`.
2. Clears the local pending queue.
3. Resets local dropped counters.
4. Does not refresh the one-hour poll deadline.

The operation is scoped to the caller's MCP/mqttctl MQTT session.

## 13. Security and resource isolation

- Per-session cookies and queues prevent agents sharing one MCP token from sharing MQTT state.
- Session IDs are cryptographically random and bound to the initializing bearer identity.
- Passwords are request-only and never placed in queue/session objects.
- Payloads are returned only to the same MCP session that received them.
- Logs include counts, sizes, topics when configured, and correlation IDs, but not payloads by default.
- Queue, payload-byte, session, and rate bounds prevent memory exhaustion.
- Global session limits and per-token session limits may be configured.
- Read-only MCP server mode may permit read-side MQTT session control while omitting publish and all persistent mqttctl mutations.

## 14. Tests

Tests will cover:

- Per-MCP-session cookie isolation.
- Incremental SSE frame parsing and heartbeats.
- Duplicate snapshot suppression.
- Distinct same-topic versions when mqttctl emits them.
- Drain order and atomic removal.
- Empty poll refreshing expiry.
- Status/state not refreshing expiry.
- Explicit MQTT disconnect cleanup.
- MCP DELETE cleanup.
- Abrupt-session one-hour cleanup.
- SSE reconnect/backoff and terminal authentication failures.
- Queue count and byte overflow with visible counters.
- No password/proof/token/payload leakage in structured logs.
- Shutdown cleanup and bounded failure handling.
