import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrokerAgentClient } from '$server/broker-agent/client';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppLogger } from '$server/logging/logger';

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  generateLog: vi.fn(),
  createError: vi.fn()
} as unknown as AppLogger);

const createRuntimeConfig = ({
  baseUrl,
  insecure = false
}: {
  baseUrl: string;
  insecure?: boolean;
}) => ({
  config: {
    broker: {
      agent: {
        baseUrl,
        timeoutMs: 10_000,
        insecure
      }
    }
  },
  secrets: {
    broker: {
      agentApiKey: 'agent-key'
    }
  }
} as unknown as LoadedRuntimeConfig);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BrokerAgentClient request paths', () => {
  it('preserves a configured baseUrl path prefix for broker-agent endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          files: []
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BrokerAgentClient(
      createRuntimeConfig({ baseUrl: 'http://broker-agent:3900/internal/agent' }),
      createLogger()
    );

    await expect(client.listManagedKeyFiles({ correlationId: 'corr-key-files-1' })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://broker-agent:3900/internal/agent/broker-key-files',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-api-key': 'agent-key',
          'x-correlation-id': 'corr-key-files-1'
        })
      })
    );
  });

  it('uses an insecure HTTPS request when broker-agent TLS verification is explicitly disabled', async () => {
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((url: string | URL, options: https.RequestOptions, callback?: (response: IncomingMessage) => void) => {
      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      response.statusCode = 200;

      const request = new EventEmitter() as EventEmitter & {
        setTimeout: (timeoutMs: number, listener: () => void) => void;
        write: (chunk: string) => void;
        end: () => void;
        destroy: (error?: Error) => void;
      };

      request.setTimeout = vi.fn();
      request.write = vi.fn();
      request.destroy = vi.fn();
      request.end = vi.fn(() => {
        callback?.(response as never);
        queueMicrotask(() => {
          response.emit('data', Buffer.from(JSON.stringify({
            ok: true,
            data: {
              files: []
            }
          })));
          response.emit('end');
        });
      });

      return request as never;
    }) as never);

    const client = new BrokerAgentClient(
      createRuntimeConfig({
        baseUrl: 'https://broker-agent:3900/internal/agent',
        insecure: true
      }),
      createLogger()
    );

    await expect(client.listManagedKeyFiles({ correlationId: 'corr-key-files-2' })).resolves.toEqual([]);
    expect(requestSpy).toHaveBeenCalledWith(
      'https://broker-agent:3900/internal/agent/broker-key-files',
      expect.objectContaining({
        method: 'GET',
        rejectUnauthorized: false,
        headers: expect.objectContaining({
          'x-api-key': 'agent-key',
          'x-correlation-id': 'corr-key-files-2'
        })
      }),
      expect.any(Function)
    );
  });

  it('does not send the broker-agent API key when reading unauthenticated health', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          health: {
            brokerRunning: true,
            brokerPid: 1234
          }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BrokerAgentClient(
      createRuntimeConfig({ baseUrl: 'http://broker-agent:3900/internal/agent' }),
      createLogger()
    );

    await expect(client.readHealth({ correlationId: 'corr-health-1' })).resolves.toEqual({
      brokerRunning: true,
      brokerPid: 1234
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://broker-agent:3900/internal/agent/health',
      expect.objectContaining({
        method: 'GET',
        headers: expect.not.objectContaining({
          'x-api-key': 'agent-key'
        })
      })
    );
  });
});
