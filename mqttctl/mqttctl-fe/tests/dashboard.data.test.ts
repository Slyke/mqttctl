import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticsSummary, OperationStatus } from '$lib/types';
import type { AppContext } from '$server/context';
import type { AppLogger } from '$server/logging/logger';
import { createAppError } from '$server/logging/errors';
import { loadDashboardPageData } from '$lib/server/dashboard/data';

const defaultOperationStatus = (): OperationStatus => ({
  status: 'idle',
  lastRunAt: null,
  message: null
});

const createDiagnosticsSummary = (
  overrides: Partial<DiagnosticsSummary> = {}
): DiagnosticsSummary => ({
  brokerReachable: true,
  dynsecStateReadable: true,
  dynsecBootstrap: defaultOperationStatus(),
  brokerConfigReadable: true,
  lastReload: defaultOperationStatus(),
  lastRestart: defaultOperationStatus(),
  ...overrides
});

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  generateLog: vi.fn(),
  createError: vi.fn()
} as unknown as AppLogger);

describe('loadDashboardPageData', () => {
  it('keeps the dashboard loadable when diagnostics already report dynsec as unreadable', async () => {
    const logger = createLogger();
    const dynsecReadState = vi.fn();
    const appContext = {
      runtimeConfig: {
        config: {
          publicBaseUrl: 'https://mqttctl.example.test',
          broker: {
            agent: {
              baseUrl: 'https://mqtt.example.test:3943'
            },
            tls: {
              enabled: false
            }
          }
        }
      },
      logger,
      diagnostics: {
        getSummary: vi.fn().mockResolvedValue(createDiagnosticsSummary({
          brokerReachable: false,
          dynsecStateReadable: false
        }))
      },
      auth: {
        listUsers: vi.fn().mockResolvedValue([{}, {}])
      },
      brokerAgent: {
        isConfigured: vi.fn(() => true)
      },
      dynsec: {
        readState: dynsecReadState
      },
      db: {
        listAuditEntries: vi.fn()
      }
    } as unknown as AppContext;

    await expect(loadDashboardPageData({
      appContext,
      correlationId: 'corr-dashboard-1',
      currentUser: null
    })).resolves.toEqual(expect.objectContaining({
      diagnostics: expect.objectContaining({
        brokerReachable: false,
        dynsecStateReadable: false
      }),
      uiTransport: {
        label: 'WUI to API',
        security: 'tls'
      },
      controlPlaneTransport: {
        label: 'API to Broker Agent',
        security: 'tls'
      },
      brokerTransport: {
        label: 'Broker Agent to Mosquitto',
        security: 'unencrypted'
      },
      canViewAudit: false,
      counts: {
        users: 2,
        clients: null,
        groups: null,
        roles: null
      },
      auditEntries: []
    }));

    expect(dynsecReadState).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to unavailable dynsec counts if the count read fails after diagnostics succeed', async () => {
    const logger = createLogger();
    const dynsecReadState = vi.fn().mockRejectedValue(createAppError({
      caller: 'dynsec::readState',
      reason: 'Failed reading dynamic security state through broker agent.',
      errorKey: 'DYNSEC_STATE_READ_FAILED',
      correlationId: 'corr-dashboard-2'
    }));
    const appContext = {
      runtimeConfig: {
        config: {
          publicBaseUrl: 'http://mqttctl.example.test',
          broker: {
            agent: null,
            tls: {
              enabled: true
            }
          }
        }
      },
      logger,
      diagnostics: {
        getSummary: vi.fn().mockResolvedValue(createDiagnosticsSummary())
      },
      auth: {
        listUsers: vi.fn().mockResolvedValue([{}])
      },
      brokerAgent: {
        isConfigured: vi.fn(() => false)
      },
      dynsec: {
        readState: dynsecReadState
      },
      db: {
        listAuditEntries: vi.fn()
      }
    } as unknown as AppContext;

    const data = await loadDashboardPageData({
      appContext,
      correlationId: 'corr-dashboard-2',
      currentUser: null
    });

    expect(data.counts).toEqual({
      users: 1,
      clients: null,
      groups: null,
      roles: null
    });
    expect(data.uiTransport).toEqual({
      label: 'WUI to API',
      security: 'unencrypted'
    });
    expect(data.controlPlaneTransport).toEqual({
      label: 'API to Broker',
      security: 'tls'
    });
    expect(data.brokerTransport).toBeNull();
    expect(dynsecReadState).toHaveBeenCalledWith({ correlationId: 'corr-dashboard-2' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      caller: 'dashboard::loadDashboardPageData',
      errorKey: 'DYNSEC_STATE_READ_FAILED'
    }));
  });

  it('keeps dynsec counts unavailable while bootstrap is still setting things up', async () => {
    const logger = createLogger();
    const dynsecReadState = vi.fn();
    const appContext = {
      runtimeConfig: {
        config: {
          publicBaseUrl: 'https://mqttctl.example.test',
          broker: {
            agent: {
              baseUrl: 'http://mqtt.example.test:3900'
            },
            tls: {
              enabled: false
            }
          }
        }
      },
      logger,
      diagnostics: {
        getSummary: vi.fn().mockResolvedValue(createDiagnosticsSummary({
          dynsecBootstrap: {
            status: 'running',
            lastRunAt: '2026-04-11T02:37:51.182Z',
            message: 'Still setting things up.'
          }
        }))
      },
      auth: {
        listUsers: vi.fn().mockResolvedValue([{}])
      },
      brokerAgent: {
        isConfigured: vi.fn(() => true)
      },
      dynsec: {
        readState: dynsecReadState
      },
      db: {
        listAuditEntries: vi.fn()
      }
    } as unknown as AppContext;

    const data = await loadDashboardPageData({
      appContext,
      correlationId: 'corr-dashboard-3',
      currentUser: null
    });

    expect(data.counts).toEqual({
      users: 1,
      clients: null,
      groups: null,
      roles: null
    });
    expect(data.uiTransport).toEqual({
      label: 'WUI to API',
      security: 'tls'
    });
    expect(data.controlPlaneTransport).toEqual({
      label: 'API to Broker Agent',
      security: 'unencrypted'
    });
    expect(data.brokerTransport).toEqual({
      label: 'Broker Agent to Mosquitto',
      security: 'unencrypted'
    });
    expect(dynsecReadState).not.toHaveBeenCalled();
  });
});
