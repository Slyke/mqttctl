import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from '$server/config/schema';
import { AppError, createAppError, resolveErrorCode } from '$server/logging/errors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSinkSelection {
  console?: boolean;
  file?: boolean;
  curl?: boolean;
}

interface KubernetesMetadata {
  enabled: boolean;
  podName?: string | null;
  deployment?: string | null;
  namespace?: string | null;
  podIp?: string | null;
  podIps?: string | null;
  nodeName?: string | null;
}

interface LogEvent {
  level: LogLevel;
  caller: string;
  message: unknown;
  correlationId?: string | null;
  errorKey?: string | null;
  errorCode?: string | null;
  context?: unknown;
  rootCause?: unknown;
  errorStack?: unknown;
  errorChain?: unknown[];
  sinks?: LogSinkSelection | null;
}

const sensitiveLogKeySet = new Set([
  'password',
  'passwordhash',
  'secret',
  'sessionsecret',
  'clientsecret',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'codeverifier',
  'authorization',
  'cookie',
  'setcookie'
]);

interface LoggerOptions {
  consoleEnabled: boolean;
  consoleLevels: LogLevel[];
  consoleFormat: 'text' | 'json';
  fileEnabled: boolean;
  fileLevels: LogLevel[];
  fileFormat: 'text' | 'json';
  filePath: string | null;
  curlEnabled: boolean;
  curlLevels: LogLevel[];
  curlMethod: string;
  curlTimeoutMs: number;
  curlUrl: string | null;
  kubernetes: KubernetesMetadata;
}

const logLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const interpolate = ({
  template,
  values,
  fallback = ''
}: {
  template: string;
  values: Record<string, string | undefined>;
  fallback?: string;
}) => template.replace(/{\$\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}/g, (_, key: string) => {
  const value = values[key];
  if (value !== undefined && value !== null) return value;
  return fallback;
});

const serializeMessage = ({ message }: { message: unknown }) => {
  if (Array.isArray(message)) {
    const parts = message.map((item) => {
      if (typeof item === 'string') return item;
      if (item === undefined || item === null) return '';
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    });

    return {
      text: parts.join(' '),
      parts
    };
  }

  if (typeof message === 'string') {
    return {
      text: message,
      parts: [message]
    };
  }

  if (message === undefined || message === null) {
    return {
      text: '',
      parts: ['']
    };
  }

  try {
    const text = JSON.stringify(message);
    return {
      text,
      parts: [text]
    };
  } catch {
    const text = String(message);
    return {
      text,
      parts: [text]
    };
  }
};

const isSensitiveLogKey = ({ key }: { key: string }) => sensitiveLogKeySet.has(key.replace(/[_-]/g, '').toLowerCase());

const redactLogSecrets = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogSecrets({ value: entry }));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveLogKey({ key })
        ? '<redacted>'
        : redactLogSecrets({ value: entry })
    ])
  );
};

const normalizeErrorDetails = ({ value }: { value: unknown }): unknown => {
  if (value instanceof AppError) {
    return {
      name: value.name,
      message: value.message,
      caller: value.caller,
      errorKey: value.errorKey,
      errorCode: value.errorCode,
      correlationId: value.correlationId,
      status: value.status,
      context: redactLogSecrets({ value: value.context }),
      errorChain: value.errorChain,
      cause: normalizeErrorDetails({ value: value.cause })
    };
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: normalizeErrorDetails({ value: value.cause })
    };
  }

  return redactLogSecrets({ value });
};

const toStackString = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (value instanceof Error) return value.stack ?? value.message ?? String(value);
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const ensureDir = ({ filePath }: { filePath: string | null }) => {
  if (!filePath) return;
  const directory = path.dirname(filePath);
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
};

const appendTextLine = ({ filePath, text }: { filePath: string | null; text: string }) => {
  if (!filePath) return;
  ensureDir({ filePath });
  appendFileSync(filePath, `${String(text || '').replace(/(?<!\\)\n/g, ' ')}\n`);
};

const appendJsonLine = ({ filePath, value }: { filePath: string | null; value: unknown }) => {
  if (!filePath) return;
  ensureDir({ filePath });
  appendFileSync(filePath, `${JSON.stringify(value)}\n`);
};

const levelAllowed = ({ level, allowed }: { level: LogLevel; allowed: LogLevel[] }) => (
  !allowed.length || allowed.includes(level)
);

const withTimeout = async <T>({
  timeoutMs,
  run
}: {
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const buildDefaultLogTextFormat = () => '[{$timestamp}] {$level} {$caller} {$correlationId} {$errorCode} {$errorKey} {$message}{$context}{$kubernetes}{$errorChain}{$rootCauseDetails}{$rootCause}{$errorStack}';

const firstDefined = <T>(...values: Array<T | undefined>) => values.find((value) => value !== undefined);

const parseBoolean = ({ value, fallback }: { value: string | undefined; fallback: boolean }) => {
  if (value === undefined) return fallback;
  return value === 'true';
};

const parseInteger = ({ value, fallback }: { value: string | undefined; fallback: number }) => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const resolveKubernetesMetadata = ({ kubernetes }: { kubernetes: KubernetesMetadata }) => {
  if (!kubernetes.enabled) return undefined;

  const metadata = Object.fromEntries(
    Object.entries({
      podName: kubernetes.podName,
      deployment: kubernetes.deployment,
      namespace: kubernetes.namespace,
      podIp: kubernetes.podIp,
      podIps: kubernetes.podIps,
      nodeName: kubernetes.nodeName
    }).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );

  return Object.keys(metadata).length ? metadata : undefined;
};

export const parseLoggerOptionsFromEnv = ({ config }: { config: RuntimeConfig['logging'] }) => {
  const parseLevels = ({ value, fallback }: { value: string | undefined; fallback: LogLevel[] }) => {
    if (!value) return fallback;
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item): item is LogLevel => logLevels.includes(item as LogLevel));
  };

  const curlEnabledEnv = firstDefined(process.env.MQTTCTL_LOG_CURL_ENABLED, process.env.MQTTCTL_LOG_HTTP_ENABLED);
  const curlLevelsEnv = firstDefined(process.env.MQTTCTL_LOG_CURL_LEVELS, process.env.MQTTCTL_LOG_HTTP_LEVELS);
  const curlMethodEnv = firstDefined(process.env.MQTTCTL_LOG_CURL_METHOD, process.env.MQTTCTL_LOG_HTTP_METHOD);
  const curlTimeoutEnv = firstDefined(process.env.MQTTCTL_LOG_CURL_TIMEOUT_MS, process.env.MQTTCTL_LOG_HTTP_TIMEOUT_MS);
  const curlUrlEnv = firstDefined(process.env.MQTTCTL_LOG_CURL_URL, process.env.MQTTCTL_LOG_HTTP_URL);
  const kubernetesEnabledEnv = firstDefined(process.env.MQTTCTL_LOG_K8S_METADATA_ENABLED, process.env.LOG_K8S_METADATA_ENABLED);

  return {
    consoleEnabled: parseBoolean({
      value: process.env.MQTTCTL_LOG_CONSOLE_ENABLED,
      fallback: config.sinks.console.enabled
    }),
    consoleLevels: parseLevels({ value: process.env.MQTTCTL_LOG_CONSOLE_LEVELS, fallback: config.sinks.console.levels }),
    consoleFormat: process.env.MQTTCTL_LOG_CONSOLE_FORMAT === undefined
      ? config.sinks.console.format
      : process.env.MQTTCTL_LOG_CONSOLE_FORMAT === 'json'
        ? 'json'
        : 'text',
    fileEnabled: parseBoolean({
      value: process.env.MQTTCTL_LOG_FILE_ENABLED,
      fallback: config.sinks.file.enabled
    }),
    fileLevels: parseLevels({ value: process.env.MQTTCTL_LOG_FILE_LEVELS, fallback: config.sinks.file.levels }),
    fileFormat: process.env.MQTTCTL_LOG_FILE_FORMAT === undefined
      ? config.sinks.file.format
      : process.env.MQTTCTL_LOG_FILE_FORMAT === 'text'
        ? 'text'
        : 'json',
    filePath: process.env.MQTTCTL_LOG_FILE_PATH ?? config.sinks.file.path,
    curlEnabled: parseBoolean({
      value: curlEnabledEnv,
      fallback: config.sinks.curl.enabled
    }),
    curlLevels: parseLevels({ value: curlLevelsEnv, fallback: config.sinks.curl.levels }),
    curlMethod: curlMethodEnv ?? config.sinks.curl.method,
    curlTimeoutMs: parseInteger({ value: curlTimeoutEnv, fallback: config.sinks.curl.timeoutMs }),
    curlUrl: curlUrlEnv ?? config.sinks.curl.url,
    kubernetes: {
      enabled: parseBoolean({
        value: kubernetesEnabledEnv,
        fallback: config.kubernetes.enabled
      }),
      podName: process.env.K8S_POD_NAME ?? config.kubernetes.podName ?? undefined,
      deployment: process.env.K8S_DEPLOYMENT ?? config.kubernetes.deployment ?? undefined,
      namespace: process.env.K8S_NAMESPACE ?? config.kubernetes.namespace ?? undefined,
      podIp: process.env.K8S_POD_IP ?? config.kubernetes.podIp ?? undefined,
      podIps: process.env.K8S_POD_IPS ?? config.kubernetes.podIps ?? undefined,
      nodeName: process.env.K8S_NODE_NAME ?? config.kubernetes.nodeName ?? undefined
    }
  } satisfies LoggerOptions;
};

export const createLogger = ({ options }: { options: LoggerOptions }) => {
  const logMessage = ({ event }: { event: LogEvent }) => {
    const timestamp = new Date().toISOString();
    const serialized = serializeMessage({ message: event.message });
    const rootCause = toStackString({ value: event.rootCause });
    const errorStack = toStackString({ value: event.errorStack });
    const rootCauseDetails = normalizeErrorDetails({ value: event.rootCause });
    const normalizedContext = redactLogSecrets({ value: event.context });
    const derivedAppError = event.rootCause instanceof AppError ? event.rootCause : null;
    const kubernetes = resolveKubernetesMetadata({ kubernetes: options.kubernetes });
    const normalizedErrorChain = Array.isArray(event.errorChain) && event.errorChain.length
      ? redactLogSecrets({ value: event.errorChain })
      : derivedAppError?.errorChain ?? [];
    const normalized = {
      level: event.level,
      message: serialized.text,
      timestamp,
      errorKey: event.errorKey ?? derivedAppError?.errorKey ?? undefined,
      correlationId: event.correlationId ?? undefined,
      caller: event.caller || 'unknown',
      rootCause: rootCause ?? undefined,
      rootCauseDetails: rootCauseDetails ?? undefined,
      errorStack: errorStack ?? undefined,
      errorCode: event.errorCode
        ?? derivedAppError?.errorCode
        ?? (event.errorKey ? resolveErrorCode({ errorKey: event.errorKey }) : undefined),
      errorChain: normalizedErrorChain,
      context: normalizedContext ?? undefined,
      kubernetes
    };
    const sinkSelection = {
      console: event.sinks?.console ?? true,
      file: event.sinks?.file ?? true,
      curl: event.sinks?.curl ?? true
    };
    const textLine = interpolate({
      template: buildDefaultLogTextFormat(),
      values: {
        ...Object.fromEntries(
          Object.entries(normalized).map(([key, value]) => [key, value === undefined ? undefined : String(value)])
        ),
        correlationId: normalized.correlationId ? `[${normalized.correlationId}]` : '',
        errorCode: normalized.errorCode ? `[${normalized.errorCode}]` : '',
        errorKey: normalized.errorKey ? `[${normalized.errorKey}]` : '',
        context: normalized.context ? ` | context=${JSON.stringify(normalized.context)}` : '',
        kubernetes: normalized.kubernetes ? ` | kubernetes=${JSON.stringify(normalized.kubernetes)}` : '',
        errorChain: Array.isArray(normalized.errorChain) && normalized.errorChain.length
          ? ` | errorChain=${JSON.stringify(normalized.errorChain)}`
          : '',
        rootCauseDetails: normalized.rootCauseDetails ? ` | rootCauseDetails=${JSON.stringify(normalized.rootCauseDetails)}` : '',
        rootCause: normalized.rootCause ? ` | rootCause=${normalized.rootCause}` : '',
        errorStack: normalized.errorStack ? ` | stack=${normalized.errorStack}` : ''
      }
    });

    if (sinkSelection.console && options.consoleEnabled && levelAllowed({ level: normalized.level, allowed: options.consoleLevels })) {
      if (options.consoleFormat === 'json') {
        console.log(JSON.stringify(normalized));
      } else {
        console.log(textLine);
      }
    }

    if (sinkSelection.file && options.fileEnabled && levelAllowed({ level: normalized.level, allowed: options.fileLevels })) {
      if (options.fileFormat === 'json') {
        appendJsonLine({ filePath: options.filePath, value: normalized });
      } else {
        appendTextLine({ filePath: options.filePath, text: textLine });
      }
    }

    if (sinkSelection.curl && options.curlEnabled && options.curlUrl && levelAllowed({ level: normalized.level, allowed: options.curlLevels })) {
      void withTimeout({
        timeoutMs: options.curlTimeoutMs,
        run: async (signal) => {
          await fetch(options.curlUrl!, {
            method: options.curlMethod,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(normalized),
            signal
          });
        }
      }).catch((error) => {
        console.error(`Curl log sink failed: ${toStackString({ value: error }) ?? 'unknown'}`);
      });
    }
  };

  const generateBoundLog = ({
    level = 'debug',
    ...event
  }: Omit<LogEvent, 'level'> & { level?: LogLevel }) => {
    logMessage({
      event: {
        level,
        ...event
      }
    });
  };

  return {
    debug: (event: Omit<LogEvent, 'level'>) => logMessage({ event: { level: 'debug', ...event } }),
    info: (event: Omit<LogEvent, 'level'>) => logMessage({ event: { level: 'info', ...event } }),
    warn: (event: Omit<LogEvent, 'level'>) => logMessage({ event: { level: 'warn', ...event } }),
    error: (event: Omit<LogEvent, 'level'>) => logMessage({ event: { level: 'error', ...event } }),
    generateLog: generateBoundLog,
    createError: createAppError
  };
};

export type AppLogger = ReturnType<typeof createLogger>;

export const generateLog = ({
  logger,
  level,
  ...event
}: {
  logger: AppLogger;
  level: LogLevel;
} & Omit<LogEvent, 'level'>) => {
  logger.generateLog({
    level,
    ...event
  });
};
