import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, parseLoggerOptionsFromEnv } from '$server/logging/logger';
import type { RuntimeConfig } from '$server/config/schema';

const createLoggingConfig = (): RuntimeConfig['logging'] => ({
  includeCorrelationId: true,
  includeUserAgent: true,
  includeNormalizedUsername: true,
  includeSessionExpiry: true,
  sinks: {
    console: {
      enabled: true,
      levels: ['info', 'warn', 'error'],
      format: 'text'
    },
    file: {
      enabled: false,
      levels: ['info', 'warn', 'error'],
      format: 'json',
      path: null
    },
    curl: {
      enabled: false,
      levels: ['error'],
      url: null,
      method: 'POST',
      timeoutMs: 2500
    }
  },
  kubernetes: {
    enabled: false,
    podName: null,
    deployment: null,
    namespace: null,
    podIp: null,
    podIps: null,
    nodeName: null
  },
  failedLoginAttempts: null,
  successfulLogin: null
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('logger kubernetes metadata', () => {
  it('reads styleguide kubernetes env vars', () => {
    vi.stubEnv('LOG_K8S_METADATA_ENABLED', 'true');
    vi.stubEnv('K8S_POD_NAME', 'mqttctl-abc');
    vi.stubEnv('K8S_NAMESPACE', 'mqtt');
    vi.stubEnv('K8S_NODE_NAME', 'node-1');

    const options = parseLoggerOptionsFromEnv({
      config: createLoggingConfig()
    });

    expect(options.kubernetes).toEqual({
      enabled: true,
      podName: 'mqttctl-abc',
      deployment: undefined,
      namespace: 'mqtt',
      podIp: undefined,
      podIps: undefined,
      nodeName: 'node-1'
    });
  });

  it('prefers the MQTTCTL kubernetes toggle when both env vars are set', () => {
    vi.stubEnv('MQTTCTL_LOG_K8S_METADATA_ENABLED', 'false');
    vi.stubEnv('LOG_K8S_METADATA_ENABLED', 'true');

    const options = parseLoggerOptionsFromEnv({
      config: createLoggingConfig()
    });

    expect(options.kubernetes.enabled).toBe(false);
  });

  it('emits kubernetes metadata in json logs when enabled', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({
      options: {
        consoleEnabled: true,
        consoleLevels: ['info'],
        consoleFormat: 'json',
        fileEnabled: false,
        fileLevels: [],
        fileFormat: 'json',
        filePath: null,
        curlEnabled: false,
        curlLevels: [],
        curlMethod: 'POST',
        curlTimeoutMs: 2500,
        curlUrl: null,
        kubernetes: {
          enabled: true,
          podName: 'mqttctl-abc',
          deployment: 'mqttctl',
          namespace: 'mqtt',
          podIp: '',
          podIps: undefined,
          nodeName: 'node-1'
        }
      }
    });

    logger.info({
      caller: 'logger-test',
      message: 'hello world'
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(consoleSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload.kubernetes).toEqual({
      podName: 'mqttctl-abc',
      deployment: 'mqttctl',
      namespace: 'mqtt',
      nodeName: 'node-1'
    });
  });
});
