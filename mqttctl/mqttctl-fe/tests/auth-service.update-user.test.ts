import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('argon2', () => ({
  default: {
    argon2id: 2,
    hash: vi.fn(async (value: string) => `hashed:${value}`),
    verify: vi.fn()
  }
}));

import { AuthService } from '$server/auth/service';
import type { AuditService } from '$server/audit/service';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { StoredUser } from '$server/db';
import type { AppLogger } from '$server/logging/logger';

const createStoredUser = (overrides: Partial<StoredUser> = {}): StoredUser => ({
  id: 'user-1',
  username: 'alice',
  email: 'alice@example.com',
  role: 'viewer',
  authSource: 'local',
  externalSubject: null,
  passwordHash: 'existing-hash',
  protectedFromAutoLink: false,
  disabled: false,
  sessionVersion: 3,
  createdAt: '2026-04-08T00:00:00.000Z',
  updatedAt: '2026-04-08T00:00:00.000Z',
  ...overrides
});

const createRuntimeConfig = ({
  headerEnabled = false,
  oidcEnabled = false,
  headerTrustedCidrs = ['127.0.0.1/32']
}: {
  headerEnabled?: boolean;
  oidcEnabled?: boolean;
  headerTrustedCidrs?: string[];
} = {}) => ({
  config: {
    publicBaseUrl: 'http://localhost:3000',
    basePath: '',
    auth: {
      localEnabled: true,
      headerEnabled,
      header: headerEnabled
        ? {
            trustedCidrs: headerTrustedCidrs,
            requiredHeaders: [],
            usernameHeader: 'x-auth-user',
            groupsHeader: null,
            defaultRole: 'viewer'
          }
        : null,
      oidcEnabled,
      oidc: oidcEnabled
        ? {
            bootstrapAdminSubject: null
          }
        : null,
      sessionTtlMinutes: 60
    },
    logging: {
      failedLoginAttempts: null,
      successfulLogin: null,
      includeCorrelationId: false,
      includeNormalizedUsername: false,
      includeUserAgent: false,
      includeSessionExpiry: false
    }
  },
  secrets: {
    sessionSecret: 'session-secret',
    oidcClientSecret: 'oidc-secret'
  }
} as unknown as LoadedRuntimeConfig);

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  generateLog: vi.fn(),
  createError: vi.fn()
} as unknown as AppLogger);

const createAudit = () => ({
  record: vi.fn()
} as unknown as AuditService);

const createDb = () => ({
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  deleteSessionsForUser: vi.fn(),
  getUserByExternalSubject: vi.fn(),
  getUserByUsername: vi.fn(),
  createUser: vi.fn()
});

describe('AuthService user update rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows local accounts to reset passwords and disable the user', async () => {
    const db = createDb();
    const existing = createStoredUser();
    db.getUserById.mockResolvedValue(existing);
    const service = new AuthService(db as never, createRuntimeConfig(), createLogger(), createAudit());

    await service.updateUser({
      userId: existing.id,
      email: 'updated@example.com',
      role: 'operator',
      disabled: true,
      password: 'next-password',
      correlationId: 'corr-1'
    });

    expect(db.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: existing.id,
      email: 'updated@example.com',
      role: 'operator',
      authSource: 'local',
      disabled: true,
      passwordHash: 'hashed:next-password',
      sessionVersion: existing.sessionVersion + 1
    }));
    expect(db.deleteSessionsForUser).toHaveBeenCalledWith({ userId: existing.id });
  });

  it('normalizes legacy non-local accounts back to no-password and enabled state', async () => {
    const db = createDb();
    const existing = createStoredUser({
      authSource: 'oidc',
      externalSubject: 'subject-1',
      passwordHash: 'legacy-hash',
      disabled: true,
      sessionVersion: 7
    });
    db.getUserById.mockResolvedValue(existing);
    const service = new AuthService(db as never, createRuntimeConfig({ oidcEnabled: true }), createLogger(), createAudit());

    await service.updateUser({
      userId: existing.id,
      email: 'updated@example.com',
      role: 'broker_admin',
      disabled: false,
      password: null,
      correlationId: 'corr-2'
    });

    expect(db.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: existing.id,
      email: 'updated@example.com',
      role: 'broker_admin',
      authSource: 'oidc',
      externalSubject: 'subject-1',
      passwordHash: null,
      disabled: false,
      sessionVersion: existing.sessionVersion + 1
    }));
    expect(db.deleteSessionsForUser).toHaveBeenCalledWith({ userId: existing.id });
  });

  it('rejects password resets for non-local accounts', async () => {
    const db = createDb();
    const existing = createStoredUser({
      authSource: 'header',
      passwordHash: null
    });
    db.getUserById.mockResolvedValue(existing);
    const service = new AuthService(db as never, createRuntimeConfig({ headerEnabled: true }), createLogger(), createAudit());

    await expect(service.updateUser({
      userId: existing.id,
      email: existing.email,
      role: existing.role,
      disabled: false,
      password: 'next-password',
      correlationId: 'corr-3'
    })).rejects.toMatchObject({
      errorKey: 'INPUT_INVALID',
      message: 'Only local accounts can reset passwords.'
    });

    expect(db.updateUser).not.toHaveBeenCalled();
    expect(db.deleteSessionsForUser).not.toHaveBeenCalled();
  });

  it('converts merged trusted-header users into header-backed accounts', async () => {
    const db = createDb();
    const existing = createStoredUser({
      authSource: 'local',
      passwordHash: 'legacy-hash',
      sessionVersion: 4
    });
    db.getUserByUsername.mockResolvedValue(existing);
    const service = new AuthService(db as never, createRuntimeConfig({ headerEnabled: true }), createLogger(), createAudit());

    const user = await service.authenticateTrustedHeaders({
      sourceIp: '127.0.0.1',
      headers: new Headers({ 'x-auth-user': existing.username }),
      correlationId: 'corr-4'
    });

    expect(user).toEqual(expect.objectContaining({
      id: existing.id,
      username: existing.username,
      authSource: 'header'
    }));
    expect(db.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      userId: existing.id,
      authSource: 'header',
      passwordHash: null,
      disabled: false,
      sessionVersion: existing.sessionVersion + 1
    }));
    expect(db.deleteSessionsForUser).toHaveBeenCalledWith({ userId: existing.id });
  });
});
