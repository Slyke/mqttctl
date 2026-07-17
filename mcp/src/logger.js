import errorCodes from "../errors.json" with { type: "json" };

const sensitiveKeys = new Set(["authorization", "cookie", "token", "password", "privatekey", "payload"]);

const redact = ({ value }) => {
  if (Array.isArray(value)) return value.map((entry) => redact({ value: entry }));
  if (!value || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    sensitiveKeys.has(key.replace(/[_-]/g, "").toLowerCase()) ? "<redacted>" : redact({ value: nested })
  ]));
};

export const createLogger = () => {
  const generateLog = ({ level = "info", caller, loggerKey, message, correlationId = null, context, errorKey, errorCode, err }) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      caller,
      loggerKey: loggerKey ?? null,
      message,
      correlationId,
      errorKey: errorKey ?? null,
      errorCode: errorCode ?? (errorKey ? (errorCodes[errorKey] ?? errorCodes.ERR_UNKNOWN) : null),
      context: redact({ value: context }),
      error: redact({ value: err })
    };
    const writer = level === "error" ? console.error : (level === "warn" ? console.warn : console.log);
    writer(JSON.stringify(entry));
    return entry;
  };

  const generateError = ({ caller, reason, errorKey, err, correlationId = null, context, includeStackTrace = false }) => {
    const error = new Error(reason, err ? { cause: err } : undefined);
    error.errorKey = errorKey;
    error.errorCode = errorCodes[errorKey] ?? errorCodes.ERR_UNKNOWN;
    error.correlationId = correlationId;
    error.context = redact({ value: context });
    if (!includeStackTrace) error.stack = undefined;
    generateLog({ level: "error", caller, message: reason, errorKey, errorCode: error.errorCode, correlationId, context, err });
    return error;
  };

  return {
    generateLog,
    generateError,
    debug: (input) => generateLog({ ...input, level: "debug" }),
    info: (input) => generateLog({ ...input, level: "info" }),
    warn: (input) => generateLog({ ...input, level: "warn" }),
    error: (input) => generateLog({ ...input, level: "error" })
  };
};
