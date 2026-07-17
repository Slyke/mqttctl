import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MqttctlApiError } from "./mqttctlClient.js";

const emptySchema = z.object({}).strict();
const confirmSchema = z.object({ confirm: z.literal(true) }).strict();
const qosSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const ordinaryRoleSchema = z.enum(["broker_admin", "security_admin", "operator", "viewer"]);
const aclTypeSchema = z.enum([
  "publishClientSend",
  "publishClientReceive",
  "subscribeLiteral",
  "subscribePattern",
  "unsubscribeLiteral",
  "unsubscribePattern"
]);

const toMcpResult = ({ payload }) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
  isError: payload?.ok === false
});

const errorPayload = ({ err, toolName }) => {
  if (err instanceof MqttctlApiError) {
    return {
      ok: false,
      error: {
        code: "mqttctl_api_error",
        status: err.status,
        errorKey: err.response?.errorKey ?? null,
        errorCode: err.response?.errorCode ?? null,
        reason: err.response?.reason ?? err.message,
        correlationId: err.response?.correlationId ?? null,
        details: err.response?.details ?? null
      }
    };
  }
  return {
    ok: false,
    error: {
      code: "tool_failed",
      reason: "MCP tool execution failed.",
      toolName
    }
  };
};

const createHandler = ({ context, toolName, mutating = false, destructive = false, handler }) => async (args) => {
  context.logger.generateLog({
    level: "info",
    caller: `tools::${toolName}`,
    loggerKey: "MCP_TOOL_CALL",
    message: "MCP tool called.",
    context: {
      toolName,
      identityName: context.identity.name,
      access: context.identity.access,
      mutating,
      destructive
    }
  });

  const rateCategory = destructive ? "destructive" : (mutating ? "write" : "read");
  const rate = context.rateLimiter.check({ identityName: context.identity.name, category: rateCategory });
  if (!rate.allowed) {
    context.logger.generateLog({
      level: "warn",
      caller: `tools::${toolName}`,
      loggerKey: "MCP_RATE_LIMIT_BLOCKED",
      message: "MCP tool call exceeded its named-token rate limit.",
      context: { toolName, identityName: context.identity.name, rateCategory, limit: rate.limit, retryAfterSeconds: rate.retryAfterSeconds }
    });
    return toMcpResult({
      payload: {
        ok: false,
        error: {
          code: "rate_limited",
          reason: "MCP tool rate limit exceeded.",
          retryAfterSeconds: rate.retryAfterSeconds,
          limit: rate.limit
        }
      }
    });
  }

  if (mutating && (context.config.readOnly || context.identity.access !== "readwrite")) {
    return toMcpResult({
      payload: {
        ok: false,
        error: {
          code: context.config.readOnly ? "read_only" : "auth_error",
          reason: context.config.readOnly
            ? "The MCP server is running in read-only mode."
            : "This tool requires a read/write MCP bearer token."
        }
      }
    });
  }

  if (destructive && args.confirm !== true) {
    return toMcpResult({
      payload: { ok: false, error: { code: "confirmation_required", reason: `${toolName} requires confirm: true.` } }
    });
  }

  try {
    const response = await handler(args);
    return toMcpResult({ payload: response?.ok === false ? response : { ok: true, response } });
  } catch (err) {
    context.logger.generateError({
      caller: `tools::${toolName}`,
      reason: "MCP tool execution failed.",
      errorKey: "MCP_TOOL_FAILED",
      err,
      context: { toolName, identityName: context.identity.name }
    });
    return toMcpResult({ payload: errorPayload({ err, toolName }) });
  }
};

const register = ({ server, context, name, description, schema, mutating = false, destructive = false, handler }) => {
  if (mutating && context.config.readOnly) return;
  server.registerTool(name, {
    description,
    inputSchema: schema,
    annotations: {
      readOnlyHint: !mutating,
      destructiveHint: destructive
    }
  }, createHandler({ context, toolName: name, mutating, destructive, handler }));
};

const apiBody = async ({ context, method = "GET", path, body }) => (
  await context.api.request({ method, path, body })
).body;

const pathPart = ({ value }) => encodeURIComponent(value);

const registerCoreTools = ({ server, context }) => {
  const readTools = [
    ["mqttctl_whoami", "Return the mqttctl MCP principal and delegated token identity.", "/api/me"],
    ["mqttctl_get_dashboard", "Return current mqttctl dashboard health and reachability data.", "/api/dashboard"],
    ["mqttctl_get_diagnostics", "Return current mqttctl diagnostics.", "/api/diagnostics"],
    ["mqttctl_get_mcp_access", "Return the effective MCP user state and capabilities without exposing key material.", "/api/mcp/access"],
    ["mqttctl_list_users", "List ordinary mqttctl application users.", "/api/users"],
    ["mqttctl_list_broker_key_files", "List managed broker public files plus Runtime Info metadata.", "/api/config/key-files"],
    ["mqttctl_pull_broker_config", "Read the current raw broker configuration. Requires upstream manage_broker capability.", "/api/config/pull"],
    ["mqttctl_list_dynsec_clients", "List Dynamic Security clients.", "/api/dynsec/clients"],
    ["mqttctl_list_dynsec_groups", "List Dynamic Security groups.", "/api/dynsec/groups"],
    ["mqttctl_list_dynsec_roles", "List Dynamic Security roles and ACLs.", "/api/dynsec/roles"],
    ["mqttctl_get_dynsec_client_defaults", "Get the default Dynamic Security client role configuration.", "/api/dynsec/settings/client-defaults"]
  ];
  for (const [name, description, path] of readTools) {
    register({ server, context, name, description, schema: emptySchema, handler: async () => await apiBody({ context, path }) });
  }

  const auditSchema = z.object({ limit: z.enum(["10", "20", "50", "100", "all"]).default("20") }).strict();
  register({
    server, context, name: "mqttctl_list_audit", description: "List mqttctl audit entries and integrity metadata.", schema: auditSchema,
    handler: async ({ limit }) => await apiBody({ context, path: `/api/audit?limit=${limit}` })
  });
  register({
    server, context, name: "mqttctl_export_audit", description: "Export mqttctl audit data as parsed JSON.", schema: auditSchema,
    handler: async ({ limit }) => {
      const result = await context.api.request({ path: `/api/audit?limit=${limit}&download=1` });
      return { fileName: result.fileName, contentType: result.contentType, auditLog: result.body };
    }
  });
  register({
    server, context, name: "mqttctl_read_broker_key_file", description: "Read one configured CA or broker public-key file. Private keys are never available.",
    schema: z.object({ file_id: z.enum(["caFile", "mosquittoPublicKey", "brokerPublicKey"]) }).strict(),
    handler: async ({ file_id }) => {
      const result = await context.api.request({ path: `/api/config/key-files/${file_id}` });
      return { fileName: result.fileName, contentType: result.contentType, content: result.body };
    }
  });

  register({
    server, context, name: "mqttctl_create_user", description: "Create a non-superadmin mqttctl application user.", mutating: true,
    schema: z.object({ username: z.string().min(1), email: z.string().email().nullable().optional(), password: z.string().min(1), role: ordinaryRoleSchema }).strict(),
    handler: async (args) => await apiBody({ context, method: "POST", path: "/api/users", body: args })
  });
  register({
    server, context, name: "mqttctl_update_user", description: "Update a non-superadmin mqttctl application user.", mutating: true,
    schema: z.object({ id: z.string().min(1), email: z.string().email().nullable(), role: ordinaryRoleSchema, disabled: z.boolean(), password: z.string().min(1).nullable().default(null) }).strict(),
    handler: async ({ id, ...body }) => await apiBody({ context, method: "PATCH", path: `/api/users/${pathPart({ value: id })}`, body })
  });
  register({
    server, context, name: "mqttctl_delete_user", description: "Delete a non-superadmin mqttctl application user. Requires confirm: true.", mutating: true, destructive: true,
    schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }).strict(),
    handler: async ({ id }) => await apiBody({ context, method: "DELETE", path: `/api/users/${pathPart({ value: id })}` })
  });

  register({
    server, context, name: "mqttctl_push_broker_config", description: "Replace broker config with conflict checking. Requires confirm: true.", mutating: true, destructive: true,
    schema: z.object({ rendered: z.string(), expected_current: z.string(), confirm: z.literal(true) }).strict(),
    handler: async ({ rendered, expected_current }) => await apiBody({ context, method: "POST", path: "/api/config/push", body: { rendered, expectedCurrent: expected_current } })
  });
  for (const [name, path, description] of [
    ["mqttctl_reload_broker", "/api/config/reload", "Reload the MQTT broker. Requires confirm: true."],
    ["mqttctl_restart_broker", "/api/config/restart", "Restart the MQTT broker. Requires confirm: true."]
  ]) {
    register({ server, context, name, description, schema: confirmSchema, mutating: true, destructive: true, handler: async () => await apiBody({ context, method: "POST", path, body: {} }) });
  }
};

const registerDynsecTools = ({ server, context }) => {
  register({
    server, context, name: "mqttctl_create_dynsec_client", description: "Create a Dynamic Security client.", mutating: true,
    schema: z.object({ username: z.string().min(1), password: z.string().min(1).nullable().optional(), client_id: z.string().min(1).nullable().optional(), disabled: z.boolean().default(false) }).strict(),
    handler: async ({ client_id, ...args }) => await apiBody({ context, method: "POST", path: "/api/dynsec/clients", body: { ...args, clientId: client_id } })
  });
  register({
    server, context, name: "mqttctl_get_dynsec_client_permissions", description: "Get effective permissions for one Dynamic Security client.",
    schema: z.object({ username: z.string().min(1) }).strict(),
    handler: async ({ username }) => await apiBody({ context, path: `/api/dynsec/clients/${pathPart({ value: username })}` })
  });
  const clientActions = [
    ["mqttctl_set_dynsec_client_enabled", "Set whether a Dynamic Security client is enabled.", z.object({ username: z.string().min(1), enabled: z.boolean() }).strict(), ({ enabled }) => ({ action: "setEnabled", enabled })],
    ["mqttctl_set_dynsec_client_password", "Set a Dynamic Security client password.", z.object({ username: z.string().min(1), password: z.string().min(1) }).strict(), ({ password }) => ({ action: "setPassword", password })],
    ["mqttctl_assign_dynsec_client_role", "Assign a role to a Dynamic Security client.", z.object({ username: z.string().min(1), rolename: z.string().min(1), priority: z.number().int() }).strict(), ({ rolename, priority }) => ({ action: "assignRole", rolename, priority })],
    ["mqttctl_remove_dynsec_client_role", "Remove a directly assigned role from a Dynamic Security client.", z.object({ username: z.string().min(1), rolename: z.string().min(1) }).strict(), ({ rolename }) => ({ action: "removeRole", rolename })],
    ["mqttctl_add_dynsec_client_group", "Add a Dynamic Security client to a group.", z.object({ username: z.string().min(1), groupname: z.string().min(1), priority: z.number().int() }).strict(), ({ groupname, priority }) => ({ action: "addGroup", groupname, priority })],
    ["mqttctl_remove_dynsec_client_group", "Remove a Dynamic Security client from a group.", z.object({ username: z.string().min(1), groupname: z.string().min(1) }).strict(), ({ groupname }) => ({ action: "removeGroup", groupname })]
  ];
  for (const [name, description, schema, toBody] of clientActions) {
    register({
      server, context, name, description, schema, mutating: true,
      handler: async (args) => await apiBody({ context, method: "PATCH", path: `/api/dynsec/clients/${pathPart({ value: args.username })}`, body: toBody(args) })
    });
  }
  register({
    server, context, name: "mqttctl_delete_dynsec_client", description: "Delete a Dynamic Security client. Requires confirm: true.", mutating: true, destructive: true,
    schema: z.object({ username: z.string().min(1), confirm: z.literal(true) }).strict(),
    handler: async ({ username }) => await apiBody({ context, method: "DELETE", path: `/api/dynsec/clients/${pathPart({ value: username })}` })
  });

  register({
    server, context, name: "mqttctl_create_dynsec_group", description: "Create a Dynamic Security group.", mutating: true,
    schema: z.object({ groupname: z.string().min(1) }).strict(), handler: async (body) => await apiBody({ context, method: "POST", path: "/api/dynsec/groups", body })
  });
  const groupActions = [
    ["mqttctl_add_dynsec_group_client", "Add a client to a Dynamic Security group.", z.object({ groupname: z.string().min(1), username: z.string().min(1), priority: z.number().int() }).strict(), ({ username, priority }) => ({ action: "addClient", username, priority })],
    ["mqttctl_remove_dynsec_group_client", "Remove a client from a Dynamic Security group.", z.object({ groupname: z.string().min(1), username: z.string().min(1) }).strict(), ({ username }) => ({ action: "removeClient", username })],
    ["mqttctl_add_dynsec_group_role", "Assign a role to a Dynamic Security group.", z.object({ groupname: z.string().min(1), rolename: z.string().min(1), priority: z.number().int() }).strict(), ({ rolename, priority }) => ({ action: "addRole", rolename, priority })],
    ["mqttctl_remove_dynsec_group_role", "Remove a role from a Dynamic Security group.", z.object({ groupname: z.string().min(1), rolename: z.string().min(1) }).strict(), ({ rolename }) => ({ action: "removeRole", rolename })]
  ];
  for (const [name, description, schema, toBody] of groupActions) {
    register({ server, context, name, description, schema, mutating: true, handler: async (args) => await apiBody({ context, method: "PATCH", path: `/api/dynsec/groups/${pathPart({ value: args.groupname })}`, body: toBody(args) }) });
  }
  register({
    server, context, name: "mqttctl_delete_dynsec_group", description: "Delete a Dynamic Security group. Requires confirm: true.", mutating: true, destructive: true,
    schema: z.object({ groupname: z.string().min(1), confirm: z.literal(true) }).strict(),
    handler: async ({ groupname }) => await apiBody({ context, method: "DELETE", path: `/api/dynsec/groups/${pathPart({ value: groupname })}` })
  });

  register({
    server, context, name: "mqttctl_create_dynsec_role", description: "Create a Dynamic Security role.", mutating: true,
    schema: z.object({ rolename: z.string().min(1) }).strict(), handler: async (body) => await apiBody({ context, method: "POST", path: "/api/dynsec/roles", body })
  });
  register({
    server, context, name: "mqttctl_add_dynsec_role_acls", description: "Add one or more ACL types to a Dynamic Security role.", mutating: true,
    schema: z.object({ rolename: z.string().min(1), acltypes: z.array(aclTypeSchema).min(1), topic: z.string().min(1), allow: z.boolean(), priority: z.number().int() }).strict(),
    handler: async ({ rolename, ...body }) => await apiBody({ context, method: "PATCH", path: `/api/dynsec/roles/${pathPart({ value: rolename })}`, body: { action: "addAcl", ...body } })
  });
  register({
    server, context, name: "mqttctl_remove_dynsec_role_acl", description: "Remove one ACL from a Dynamic Security role.", mutating: true,
    schema: z.object({ rolename: z.string().min(1), acltype: aclTypeSchema, topic: z.string().min(1) }).strict(),
    handler: async ({ rolename, ...body }) => await apiBody({ context, method: "PATCH", path: `/api/dynsec/roles/${pathPart({ value: rolename })}`, body: { action: "removeAcl", ...body } })
  });
  register({
    server, context, name: "mqttctl_delete_dynsec_role", description: "Delete a Dynamic Security role. Requires confirm: true.", mutating: true, destructive: true,
    schema: z.object({ rolename: z.string().min(1), confirm: z.literal(true) }).strict(),
    handler: async ({ rolename }) => await apiBody({ context, method: "DELETE", path: `/api/dynsec/roles/${pathPart({ value: rolename })}` })
  });
  register({
    server, context, name: "mqttctl_set_dynsec_client_defaults", description: "Set the default role assigned to new Dynamic Security clients.", mutating: true,
    schema: z.object({ default_role_name: z.string().min(1).nullable(), default_role_priority: z.number().int().default(0) }).strict(),
    handler: async ({ default_role_name, default_role_priority }) => await apiBody({ context, method: "PATCH", path: "/api/dynsec/settings/client-defaults", body: { defaultRoleName: default_role_name, defaultRolePriority: default_role_priority } })
  });
};

const registerSnapshotTools = ({ server, context }) => {
  register({
    server, context, name: "mqttctl_export_snapshot", description: "Create and return a mqttctl snapshot export.", mutating: true,
    schema: z.object({ kind: z.enum(["dynsec", "broker-config", "combined"]), note: z.string().nullable().optional() }).strict(),
    handler: async (body) => await apiBody({ context, method: "POST", path: "/api/snapshots/export", body })
  });
  register({
    server, context, name: "mqttctl_preview_snapshot_import", description: "Validate and preview a snapshot import without applying it.", mutating: true,
    schema: z.object({ payload: z.unknown() }).strict(),
    handler: async ({ payload }) => await apiBody({ context, method: "POST", path: "/api/snapshots/import", body: { payload, apply: false } })
  });
  register({
    server, context, name: "mqttctl_apply_snapshot_import", description: "Apply a validated snapshot import. Requires confirm: true.", mutating: true, destructive: true,
    schema: z.object({ payload: z.unknown(), confirm: z.literal(true) }).strict(),
    handler: async ({ payload }) => await apiBody({ context, method: "POST", path: "/api/snapshots/import", body: { payload, apply: true } })
  });
};

const registerMqttTools = ({ server, context }) => {
  register({
    server, context, name: "mqttctl_mqtt_connect", description: "Create this MCP session's transient MQTT Explorer connection through the mqttctl API. The MCP server never connects directly to MQTT.",
    schema: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), tls: z.boolean().default(false), auth_mode: z.enum(["dynsec_client", "custom"]), username: z.string().min(1), password: z.string().min(1).optional(), client_id: z.string().min(1) }).strict(),
    handler: async ({ auth_mode, client_id, ...args }) => await context.mqtt.connect({ input: { ...args, authMode: auth_mode, clientId: client_id } })
  });
  register({ server, context, name: "mqttctl_mqtt_get_state", description: "Get this MCP session's upstream MQTT Explorer state without refreshing the one-hour poll deadline.", schema: emptySchema, handler: async () => await context.mqtt.getState() });
  register({
    server, context, name: "mqttctl_mqtt_subscribe", description: "Subscribe through mqttctl and start buffering every API-delivered publication until polled.",
    schema: z.object({ filter: z.string().min(1), qos: qosSchema }).strict(), handler: async (args) => await context.mqtt.subscribe(args)
  });
  register({
    server, context, name: "mqttctl_mqtt_unsubscribe", description: "Unsubscribe this MCP session from one topic filter through mqttctl.",
    schema: z.object({ filter: z.string().min(1) }).strict(), handler: async (args) => await context.mqtt.unsubscribe(args)
  });
  register({
    server, context, name: "mqttctl_mqtt_poll_messages", description: "Atomically drain buffered MQTT messages and refresh the one-hour inactivity deadline.",
    schema: z.object({ max_messages: z.number().int().min(1).max(context.config.mqttBuffer.maxPoll).optional() }).strict(),
    handler: async ({ max_messages }) => await context.mqtt.poll({ maxMessages: max_messages })
  });
  register({
    server, context, name: "mqttctl_mqtt_buffer_status", description: "Inspect queue, loss, expiry, and optional upstream state without refreshing the inactivity deadline.",
    schema: z.object({ include_upstream: z.boolean().default(false) }).strict(),
    handler: async ({ include_upstream }) => await context.mqtt.status({ includeUpstream: include_upstream })
  });
  register({ server, context, name: "mqttctl_mqtt_clear_messages", description: "Clear mqttctl latest-topic state and this MCP session's in-memory queue.", schema: emptySchema, handler: async () => await context.mqtt.clear() });
  register({
    server, context, name: "mqttctl_mqtt_set_tracked_topics_limit", description: "Set mqttctl's latest-topic display limit; this is separate from the MCP queue bound.",
    schema: z.object({ limit: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(25), z.literal(100), z.null()]) }).strict(),
    handler: async (args) => await context.mqtt.setTrackedTopicsLimit(args)
  });
  register({
    server, context, name: "mqttctl_mqtt_publish", description: "Publish through the mqttctl API. Requires a read/write MCP token.", mutating: true,
    schema: z.object({ topic: z.string().min(1), payload: z.string(), qos: qosSchema, retain: z.boolean().default(false) }).strict(),
    handler: async (input) => await context.mqtt.publish({ input })
  });
  register({ server, context, name: "mqttctl_mqtt_disconnect", description: "Disconnect the upstream mqttctl MQTT Explorer session and discard subscriptions and queued messages.", schema: emptySchema, handler: async () => await context.mqtt.disconnect() });
};

export const createMcpServer = ({ context, buildInfo }) => {
  const server = new McpServer({ name: "mqttctl-mcp", version: buildInfo.version }, { capabilities: { logging: {} } });
  registerCoreTools({ server, context });
  registerDynsecTools({ server, context });
  registerSnapshotTools({ server, context });
  registerMqttTools({ server, context });
  return server;
};
