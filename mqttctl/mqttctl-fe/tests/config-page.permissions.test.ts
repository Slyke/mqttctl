import { describe, expect, it, vi } from 'vitest';
import { load as loadConfigPage } from '../src/routes/(app)/config/+page.server';
import { load as loadAppUsersPage } from '../src/routes/(app)/app-users/+page.server';
import { GET as pullBrokerConfig } from '../src/routes/api/config/pull/+server';
import type { AuthenticatedUser } from '$server/auth/types';

const createUser = (role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: 'user-1',
  username: 'viewer-user',
  email: null,
  role,
  authSource: 'local'
});

describe('config page permissions', () => {
  it('does not load raw broker config for accounts without manage_broker', async () => {
    const readCurrentBrokerConfig = vi.fn();

    await expect(loadConfigPage({
      locals: {
        currentUser: createUser('viewer'),
        correlationId: 'corr-config-page',
        appContext: {
          brokerConfig: {
            readCurrentBrokerConfig
          }
        }
      }
    } as never)).resolves.toEqual({
      canManageBroker: false,
      configText: '',
      loadError: null
    });

    expect(readCurrentBrokerConfig).not.toHaveBeenCalled();
  });

  it('returns permission denied for broker config pull without manage_broker', async () => {
    const response = await pullBrokerConfig({
      locals: {
        currentUser: createUser('viewer'),
        correlationId: 'corr-config-pull',
        appContext: {
          logger: {
            error: vi.fn()
          },
          brokerConfig: {
            readCurrentBrokerConfig: vi.fn()
          }
        }
      }
    } as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      errorKey: 'PERMISSION_DENIED',
      reason: 'User lacks manage_broker capability.'
    });
  });

  it('throws an expected 403 for page loads that need manage_users', async () => {
    await expect(loadAppUsersPage({
      locals: {
        currentUser: createUser('viewer'),
        correlationId: 'corr-app-users',
        appContext: {
          auth: {
            listUsers: vi.fn()
          }
        }
      }
    } as never)).rejects.toMatchObject({
      status: 403,
      body: expect.objectContaining({
        message: 'User lacks manage_users capability.',
        errorKey: 'PERMISSION_DENIED'
      })
    });
  });
});
