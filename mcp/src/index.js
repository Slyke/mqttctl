import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authenticateBearer, toMcpAuthInfo } from "./auth.js";
import { getBuildInfo } from "./buildInfo.js";
import { ensureHttpsCertificates } from "./certs.js";
import { loadConfig } from "./config.js";
import { createHeartbeat } from "./heartbeat.js";
import { createLogger } from "./logger.js";
import { MqttMessageBuffer } from "./mqttBuffer.js";
import { loadSigningKey, MqttctlClient } from "./mqttctlClient.js";
import { createRateLimiter } from "./rateLimit.js";
import { createMcpServer } from "./tools.js";

const sendJson = ({ res, status = 200, body }) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
};

const sendMcpError = ({ res, status, message }) => sendJson({
  res,
  status,
  body: { jsonrpc: "2.0", error: { code: -32000, message }, id: null }
});

const readJsonBody = async ({ req, maxBytes = 16 * 1024 * 1024 }) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("MCP request body exceeds the 16 MiB limit.");
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const listen = async ({ server, host, port }) => await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => {
    server.off("error", reject);
    resolve();
  });
});

const stopListening = async ({ server }) => await new Promise((resolve) => server.close(resolve));

export const main = async () => {
  const logger = createLogger();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    throw logger.generateError({
      caller: "index::configuration",
      reason: err instanceof Error ? err.message : "MCP configuration is invalid.",
      errorKey: "MCP_CONFIG_INVALID",
      err,
      context: {
        requiredTokenConfiguration: "MCP_READ_BEARER_TOKENS or MCP_READWRITE_BEARER_TOKENS",
        failureRestartDelayEnvironment: "MCP_FAILURE_RESTART_DELAY_SECONDS"
      }
    });
  }
  const buildInfo = getBuildInfo();
  let privateKey;
  try {
    privateKey = loadSigningKey({ filePath: config.mqttctl.privateKeyFile });
  } catch (err) {
    throw logger.generateError({
      caller: "index::main",
      reason: `The mqttctl MCP signing private key could not be loaded from ${config.mqttctl.privateKeyFile}. Run the mqttctl-mcp-keygen service and mount its private-key volume read-only at this path.`,
      errorKey: "MCP_SIGNING_KEY_LOAD_FAILED",
      err,
      context: {
        privateKeyFile: config.mqttctl.privateKeyFile,
        requiredFormat: "PKCS8 PEM Ed25519 private key",
        keyGeneratorService: "mqttctl-mcp-keygen"
      }
    });
  }

  const sessions = new Map();
  const rateLimiter = createRateLimiter({ config });
  const servers = [];
  let shuttingDown = false;
  const heartbeat = createHeartbeat({ config, privateKey, buildInfo, logger });
  const readinessIdentity = config.auth.tokens[0];
  const readinessApi = new MqttctlClient({ config, privateKey, identity: readinessIdentity, logger });

  const closeSession = async ({ state, closeTransport = true }) => {
    if (!state || state.closing) return;
    state.closing = true;
    if (state.sessionId) sessions.delete(state.sessionId);
    await state.mqtt.close().catch((err) => {
      logger.generateError({ caller: "index::closeSession", reason: "Failed cleaning up an MCP MQTT session.", errorKey: "MCP_SESSION_CLEANUP_FAILED", err, context: { sessionId: state.sessionId, identityName: state.identity.name } });
    });
    state.api.close();
    if (closeTransport) await state.transport.close().catch(() => {});
    await state.server.close().catch(() => {});
  };

  const createSession = async ({ identity }) => {
    const perToken = [...sessions.values()].filter((state) => state.identity.name === identity.name).length;
    if (sessions.size >= config.sessions.maxTotal || perToken >= config.sessions.maxPerToken) {
      throw Object.assign(new Error("MCP session limit reached."), { status: 429 });
    }

    const api = new MqttctlClient({ config, privateKey, identity, logger });
    const mqtt = new MqttMessageBuffer({ api, config, logger, identity });
    const state = { identity, api, mqtt, sessionId: null, closing: false, transport: null, server: null, lastActivityAt: Date.now() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        state.sessionId = sessionId;
        sessions.set(sessionId, state);
        logger.generateLog({ level: "info", caller: "index::createSession", loggerKey: "MCP_SESSION_INITIALIZED", message: "MCP session initialized.", context: { sessionId, identityName: identity.name, access: identity.access } });
      }
    });
    state.transport = transport;
    const context = { config, logger, identity, api, mqtt, rateLimiter };
    state.server = createMcpServer({ context, buildInfo });
    transport.onclose = () => {
      void closeSession({ state, closeTransport: false }).catch(() => {});
    };
    await state.server.connect(transport);
    return state;
  };

  const handleMcp = async ({ req, res, identity }) => {
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    let parsedBody;
    if (req.method === "POST") parsedBody = await readJsonBody({ req });

    let state = sessionId ? sessions.get(sessionId) : null;
    if (state) {
      if (state.identity.name !== identity.name || state.identity.access !== identity.access) {
        sendMcpError({ res, status: 403, message: "MCP session belongs to a different bearer identity." });
        return;
      }
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(parsedBody)) {
      state = await createSession({ identity });
    } else {
      sendMcpError({ res, status: sessionId ? 404 : 400, message: "No valid MCP session was provided." });
      return;
    }

    req.auth = toMcpAuthInfo({ identity });
    state.lastActivityAt = Date.now();
    await state.transport.handleRequest(req, res, parsedBody);
    if (req.method === "DELETE") await closeSession({ state });
  };

  const requestHandler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/healthz") {
        if (req.method !== "GET") return sendJson({ res, status: 405, body: { ok: false } });
        return sendJson({ res, body: { ok: true, version: buildInfo.version, buildHash: buildInfo.buildHash, sessions: sessions.size, readOnly: config.readOnly } });
      }
      if (url.pathname === "/readyz") {
        if (req.method !== "GET") return sendJson({ res, status: 405, body: { ok: false } });
        if (config.mqttctl.readyCheck) {
          try {
            await readinessApi.request({ path: "/api/me" });
          } catch (err) {
            return sendJson({ res, status: 503, body: { ok: false, version: buildInfo.version, buildHash: buildInfo.buildHash, reason: "mqttctl authentication is unavailable" } });
          }
        }
        return sendJson({ res, body: { ok: true, version: buildInfo.version, buildHash: buildInfo.buildHash, heartbeat: heartbeat.status() } });
      }
      if (url.pathname !== "/mcp") return sendJson({ res, status: 404, body: { ok: false, error: { code: "not_found", message: "Not found." } } });
      if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) return sendMcpError({ res, status: 405, message: "Method not allowed." });

      const identity = authenticateBearer({ authorization: req.headers.authorization, config });
      if (!identity) return sendMcpError({ res, status: 401, message: "Missing or invalid MCP bearer token." });
      await handleMcp({ req, res, identity });
    } catch (err) {
      logger.generateError({ caller: "index::request", reason: "MCP HTTP request handling failed.", errorKey: "HTTP_REQUEST_FAILED", err, context: { method: req.method, path: url.pathname } });
      if (!res.headersSent) sendMcpError({ res, status: err?.status ?? 500, message: err?.status === 429 ? err.message : "Internal server error." });
    }
  };

  if (config.http.enabled) {
    const server = http.createServer((req, res) => void requestHandler(req, res));
    await listen({ server, host: config.http.host, port: config.http.port });
    servers.push(server);
  }
  if (config.https.enabled) {
    const tls = ensureHttpsCertificates({ certsDir: config.https.certsDir });
    const server = https.createServer(tls, (req, res) => void requestHandler(req, res));
    await listen({ server, host: config.https.host, port: config.https.port });
    servers.push(server);
  }

  logger.generateLog({
    level: "info",
    caller: "index::main",
    loggerKey: "SERVICE_BOOT_DIAGNOSTICS",
    message: "mqttctl MCP server started.",
    context: {
      version: buildInfo.version,
      buildHash: buildInfo.buildHash,
      httpEnabled: config.http.enabled,
      httpsEnabled: config.https.enabled,
      mqttctlBaseUrl: config.mqttctl.baseUrl,
      signingPrivateKeyFile: config.mqttctl.privateKeyFile,
      tokenNames: config.auth.tokens.map((entry) => ({ name: entry.name, access: entry.access }))
    }
  });
  heartbeat.start();
  const sessionMaintenanceTimer = setInterval(() => {
    const inactiveBefore = Date.now() - config.mqttBuffer.inactivityMs;
    for (const state of sessions.values()) {
      if (state.lastActivityAt >= inactiveBefore) continue;
      void closeSession({ state }).catch((err) => {
        logger.generateError({
          caller: "index::sessionMaintenance",
          reason: "Failed closing an abandoned MCP protocol session.",
          errorKey: "MCP_SESSION_CLEANUP_FAILED",
          err,
          context: { sessionId: state.sessionId, identityName: state.identity.name }
        });
      });
    }
  }, 60_000);
  sessionMaintenanceTimer.unref?.();

  const shutdown = async ({ signal }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sessionMaintenanceTimer);
    heartbeat.stop();
    readinessApi.close();
    await Promise.allSettled([...sessions.values()].map((state) => closeSession({ state })));
    await Promise.allSettled(servers.map((server) => stopListening({ server })));
    logger.generateLog({ level: "info", caller: "index::shutdown", loggerKey: "SERVICE_SHUTDOWN", message: "mqttctl MCP server stopped.", context: { signal } });
  };
  process.once("SIGTERM", () => void shutdown({ signal: "SIGTERM" }).finally(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown({ signal: "SIGINT" }).finally(() => process.exit(0)));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      caller: "index::main",
      loggerKey: "SERVICE_START_FAILED",
      message: err instanceof Error ? err.message : "MCP service startup failed.",
      errorKey: err?.errorKey ?? "ERR_UNKNOWN",
      errorCode: err?.errorCode ?? null
    }));
    process.exitCode = 1;
  });
}
