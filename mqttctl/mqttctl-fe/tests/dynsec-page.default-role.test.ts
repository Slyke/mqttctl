import { describe, expect, it, vi } from 'vitest';
import { dynsecBootstrapDefaultRoleName } from '$lib/types';
import { load as loadDynsecPage } from '../src/routes/(app)/dynsec/+page.server';

describe('dynsec page default role status', () => {
  it('uses the dynsec service missing-role status instead of directly trusting the state file', async () => {
    const readState = vi.fn().mockResolvedValue({
      clients: [],
      groups: [],
      roles: []
    });
    const getClientDefaults = vi.fn().mockResolvedValue({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      defaultRolePriority: 0
    });
    const isConfiguredDefaultRoleMissing = vi.fn().mockReturnValue(false);
    const getBootstrapDefaultRoleError = vi.fn().mockReturnValue(null);
    const getBootstrapDefaultRoleStatus = vi.fn().mockReturnValue({
      status: 'idle',
      lastRunAt: null,
      message: null
    });

    await expect(loadDynsecPage({
      locals: {
        correlationId: 'corr-dynsec-page',
        appContext: {
          logger: {
            warn: vi.fn()
          },
          runtimeConfig: {
            config: {
              ui: {
                languageFilePath: null,
                dynsec: {
                  showAssignmentPriorities: true
                }
              }
            }
          },
          dynsec: {
            readState,
            getClientDefaults,
            getEffectivePermissions: vi.fn(),
            isConfiguredDefaultRoleMissing,
            getBootstrapDefaultRoleError,
            getBootstrapDefaultRoleStatus
          }
        }
      },
      url: new URL('http://localhost/dynsec')
    } as never)).resolves.toMatchObject({
      clientDefaults: {
        defaultRoleName: dynsecBootstrapDefaultRoleName,
        defaultRolePriority: 0
      },
      defaultRoleMissing: false,
      showDefaultRoleMissingWarning: false,
      bootstrapDefaultRoleError: null,
      bootstrapDefaultRoleStatus: {
        status: 'idle',
        lastRunAt: null,
        message: null
      }
    });

    expect(isConfiguredDefaultRoleMissing).toHaveBeenCalledWith({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      state: {
        clients: [],
        groups: [],
        roles: []
      }
    });
  });

  it('suppresses the stale bootstrap-role missing warning while bootstrap is still running or failed', async () => {
    const readState = vi.fn().mockResolvedValue({
      clients: [],
      groups: [],
      roles: []
    });
    const getClientDefaults = vi.fn().mockResolvedValue({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      defaultRolePriority: 0
    });
    const isConfiguredDefaultRoleMissing = vi.fn().mockReturnValue(true);
    const getBootstrapDefaultRoleError = vi.fn().mockReturnValue({
      reason: 'Connection error: Not authorized',
      errorKey: 'DYNSEC_OPERATION_FAILED',
      details: null
    });
    const getBootstrapDefaultRoleStatus = vi.fn().mockReturnValue({
      status: 'failed',
      lastRunAt: '2026-04-11T05:05:35.676Z',
      message: 'Default dynsec role bootstrap failed.'
    });

    await expect(loadDynsecPage({
      locals: {
        correlationId: 'corr-dynsec-page-bootstrap-failed',
        appContext: {
          logger: {
            warn: vi.fn()
          },
          runtimeConfig: {
            config: {
              ui: {
                languageFilePath: null,
                dynsec: {
                  showAssignmentPriorities: true
                }
              }
            }
          },
          dynsec: {
            readState,
            getClientDefaults,
            getEffectivePermissions: vi.fn(),
            isConfiguredDefaultRoleMissing,
            getBootstrapDefaultRoleError,
            getBootstrapDefaultRoleStatus
          }
        }
      },
      url: new URL('http://localhost/dynsec')
    } as never)).resolves.toMatchObject({
      defaultRoleMissing: true,
      showDefaultRoleMissingWarning: false,
      bootstrapDefaultRoleStatus: {
        status: 'failed'
      }
    });
  });
});
