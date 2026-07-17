import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";

const parseBoolean = ({ value, fallback = false }) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const parseInteger = ({ value, fallback, min, max }) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const readJson5 = ({ filePath }) => {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return JSON5.parse(fs.readFileSync(filePath, "utf8"));
};

const readTokenValue = ({ entry, cwd }) => {
  if (entry?.token) return String(entry.token);
  if (!entry?.tokenFile) return "";
  return fs.readFileSync(path.resolve(cwd, String(entry.tokenFile)), "utf8").trim();
};

const parseTokenEntries = ({ value, label, access, cwd }) => {
  if (value === undefined || value === null || value === "") return [];
  const parsed = typeof value === "string" ? JSON5.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array of named token entries.`);

  return parsed.map((entry, index) => {
    const name = String(entry?.name ?? "").trim();
    const token = readTokenValue({ entry, cwd });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === "_service") {
      throw new Error(`${label}[${index}].name is invalid or reserved.`);
    }
    if (!token) throw new Error(`${label}[${index}] must include token or tokenFile.`);
    return { name, token, access };
  });
};

const envOr = ({ env, fileConfig, envKey, fileValue, fallback }) => (
  env[envKey] !== undefined ? env[envKey] : (fileValue ?? fallback)
);

export const loadConfig = ({ env = process.env, cwd = process.cwd(), requireRequired = true } = {}) => {
  const configPath = path.resolve(cwd, env.MCP_CONFIG_FILE ?? "./config.json5");
  const fileConfig = readJson5({ filePath: configPath });
  const readTokens = parseTokenEntries({
    value: envOr({ env, fileConfig, envKey: "MCP_READ_BEARER_TOKENS", fileValue: fileConfig.auth?.readBearerTokens }),
    label: "MCP_READ_BEARER_TOKENS",
    access: "read",
    cwd
  });
  const readWriteTokens = parseTokenEntries({
    value: envOr({ env, fileConfig, envKey: "MCP_READWRITE_BEARER_TOKENS", fileValue: fileConfig.auth?.readWriteBearerTokens }),
    label: "MCP_READWRITE_BEARER_TOKENS",
    access: "readwrite",
    cwd
  });
  const tokens = [...readTokens, ...readWriteTokens];
  const duplicateNames = tokens.filter((entry, index) => tokens.findIndex((candidate) => candidate.name === entry.name) !== index);
  if (duplicateNames.length) throw new Error(`MCP bearer token names must be unique: ${[...new Set(duplicateNames.map((entry) => entry.name))].join(", ")}`);

  const httpEnabled = parseBoolean({ value: envOr({ env, fileConfig, envKey: "HTTP_ENABLED", fileValue: fileConfig.http?.enabled, fallback: false }) });
  const httpsEnabled = parseBoolean({ value: envOr({ env, fileConfig, envKey: "HTTPS_ENABLED", fileValue: fileConfig.https?.enabled, fallback: true }), fallback: true });
  if (!httpEnabled && !httpsEnabled) throw new Error("At least one of HTTP_ENABLED or HTTPS_ENABLED must be true.");

  const mqttctlBaseUrl = String(envOr({ env, fileConfig, envKey: "MQTTCTL_BASE_URL", fileValue: fileConfig.mqttctl?.baseUrl, fallback: "" })).replace(/\/+$/, "");
  const privateKeyFile = path.resolve(cwd, String(envOr({ env, fileConfig, envKey: "MQTTCTL_MCP_PRIVATE_KEY_FILE", fileValue: fileConfig.mqttctl?.privateKeyFile, fallback: "" })));

  if (requireRequired) {
    const missing = [];
    if (!mqttctlBaseUrl) missing.push("MQTTCTL_BASE_URL");
    if (!privateKeyFile || privateKeyFile === cwd) missing.push("MQTTCTL_MCP_PRIVATE_KEY_FILE");
    if (!tokens.length) missing.push("MCP_READ_BEARER_TOKENS or MCP_READWRITE_BEARER_TOKENS");
    if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  return {
    configPath,
    readOnly: parseBoolean({ value: envOr({ env, fileConfig, envKey: "MCP_READ_ONLY", fileValue: fileConfig.readOnly, fallback: false }) }),
    auth: { tokens },
    http: {
      enabled: httpEnabled,
      host: String(envOr({ env, fileConfig, envKey: "HTTP_HOST", fileValue: fileConfig.http?.host, fallback: "0.0.0.0" })),
      port: parseInteger({ value: envOr({ env, fileConfig, envKey: "HTTP_PORT", fileValue: fileConfig.http?.port, fallback: 3001 }), fallback: 3001, min: 1, max: 65535 })
    },
    https: {
      enabled: httpsEnabled,
      host: String(envOr({ env, fileConfig, envKey: "HTTPS_HOST", fileValue: fileConfig.https?.host, fallback: "0.0.0.0" })),
      port: parseInteger({ value: envOr({ env, fileConfig, envKey: "HTTPS_PORT", fileValue: fileConfig.https?.port, fallback: 3443 }), fallback: 3443, min: 1, max: 65535 }),
      certsDir: path.resolve(cwd, String(envOr({ env, fileConfig, envKey: "HTTPS_CERTS_DIR", fileValue: fileConfig.https?.certsDir, fallback: "./data/certs" })))
    },
    mqttctl: {
      baseUrl: mqttctlBaseUrl,
      privateKeyFile,
      keyId: String(envOr({ env, fileConfig, envKey: "MQTTCTL_MCP_KEY_ID", fileValue: fileConfig.mqttctl?.keyId, fallback: "compose" })),
      audience: String(envOr({ env, fileConfig, envKey: "MQTTCTL_MCP_AUDIENCE", fileValue: fileConfig.mqttctl?.audience, fallback: "mqttctl-api" })),
      timeoutMs: parseInteger({ value: envOr({ env, fileConfig, envKey: "MQTTCTL_API_TIMEOUT_MS", fileValue: fileConfig.mqttctl?.timeoutMs, fallback: 15000 }), fallback: 15000, min: 1000, max: 120000 }),
      verifyTls: parseBoolean({ value: envOr({ env, fileConfig, envKey: "MQTTCTL_VERIFY_TLS", fileValue: fileConfig.mqttctl?.verifyTls, fallback: true }), fallback: true }),
      readyCheck: parseBoolean({ value: envOr({ env, fileConfig, envKey: "READY_CHECK_MQTTCTL", fileValue: fileConfig.mqttctl?.readyCheck, fallback: true }), fallback: true }),
      heartbeatSeconds: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_HEARTBEAT_SECONDS", fileValue: fileConfig.mqttctl?.heartbeatSeconds, fallback: 15 }), fallback: 15, min: 5, max: 120 })
    },
    sessions: {
      maxTotal: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_MAX_SESSIONS", fileValue: fileConfig.sessions?.maxTotal, fallback: 100 }), fallback: 100, min: 1, max: 1000 }),
      maxPerToken: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_MAX_SESSIONS_PER_TOKEN", fileValue: fileConfig.sessions?.maxPerToken, fallback: 20 }), fallback: 20, min: 1, max: 100 })
    },
    rateLimits: {
      windowMs: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_RATE_LIMIT_WINDOW_SECONDS", fileValue: fileConfig.rateLimits?.windowSeconds, fallback: 60 }), fallback: 60, min: 1, max: 3600 }) * 1000,
      read: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_RATE_LIMIT_READ", fileValue: fileConfig.rateLimits?.read, fallback: 300 }), fallback: 300, min: 1, max: 100000 }),
      write: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_RATE_LIMIT_WRITE", fileValue: fileConfig.rateLimits?.write, fallback: 120 }), fallback: 120, min: 1, max: 100000 }),
      destructive: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_RATE_LIMIT_DESTRUCTIVE", fileValue: fileConfig.rateLimits?.destructive, fallback: 30 }), fallback: 30, min: 1, max: 100000 })
    },
    mqttBuffer: {
      inactivityMs: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_MQTT_INACTIVITY_SECONDS", fileValue: fileConfig.mqttBuffer?.inactivitySeconds, fallback: 3600 }), fallback: 3600, min: 60, max: 86400 }) * 1000,
      maxMessages: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_MQTT_MAX_BUFFERED_MESSAGES", fileValue: fileConfig.mqttBuffer?.maxMessages, fallback: 10000 }), fallback: 10000, min: 1, max: 100000 }),
      maxBytes: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_MQTT_MAX_BUFFERED_BYTES", fileValue: fileConfig.mqttBuffer?.maxBytes, fallback: 16777216 }), fallback: 16777216, min: 1024, max: 268435456 }),
      defaultPoll: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_MQTT_DEFAULT_POLL_MESSAGES", fileValue: fileConfig.mqttBuffer?.defaultPoll, fallback: 100 }), fallback: 100, min: 1, max: 1000 }),
      maxPoll: parseInteger({ value: envOr({ env, fileConfig, envKey: "MCP_MQTT_MAX_POLL_MESSAGES", fileValue: fileConfig.mqttBuffer?.maxPoll, fallback: 1000 }), fallback: 1000, min: 1, max: 5000 })
    }
  };
};
