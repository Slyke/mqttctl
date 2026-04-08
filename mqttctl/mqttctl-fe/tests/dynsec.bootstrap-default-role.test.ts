import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dynsecBootstrapDefaultRoleName,
  dynsecBootstrapReadWriteRoleName,
  dynsecLegacyBootstrapRoleName
} from '$lib/types';
import { DynsecService } from '$server/dynsec/service';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppLogger } from '$server/logging/logger';

const dynsecSettingsScope = 'dynsec';
const clientDefaultsKey = 'clientDefaults';
const bootstrapInitializedKey = 'bootstrapDefaultRoleInitialized';

const createRuntimeConfig = () => ({
  config: {
    broker: {
      host: 'broker.local',
      port: 1883,
      dynsecAdminUsername: 'admin',
      mqttClientId: 'mqttctl-test',
      controlBinaryPath: '/usr/bin/mosquitto_ctrl',
      tls: {
        enabled: false,
        caFile: null,
        certFile: null,
        keyFile: null,
        insecure: false
      }
    }
  },
  secrets: {
    broker: {
      dynsecAdminPassword: 'admin-secret'
    }
  }
} as unknown as LoadedRuntimeConfig);

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
} as unknown as AppLogger);

const createDb = () => {
  const settings = new Map<string, unknown>();

  return {
    settings,
    getSetting: vi.fn(async ({ scope, key }: { scope: string; key: string }) => settings.get(`${scope}:${key}`) ?? null),
    setSetting: vi.fn(async ({
      scope,
      key,
      value
    }: {
      scope: string;
      key: string;
      value: unknown;
      updatedAt: string;
    }) => {
      settings.set(`${scope}:${key}`, value);
    })
  };
};

const createBrokerAgent = ({ rawState }: { rawState: Record<string, unknown> }) => ({
  isConfigured: vi.fn(() => true),
  readDynsecStateRaw: vi.fn(async () => rawState),
  runDynsecCommand: vi.fn(async ({
    command,
    args
  }: {
    command: string;
    args?: string[];
  }) => ({
    executable: 'mosquitto_ctrl',
    args: ['dynsec', command, ...(args ?? [])],
    exitCode: 0,
    stdout: '',
    stderr: ''
  }))
});

const pristineDynsecState = {
  clients: [],
  groups: [],
  roles: [
    {
      rolename: 'admin',
      textname: null,
      textdescription: null,
      acls: []
    }
  ],
  anonymousGroup: null,
  defaultACLAccess: {}
} satisfies Record<string, unknown>;

describe('DynsecService bootstrap default role handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bootstraps read-all as the default role and creates read-write-all alongside it', async () => {
    const db = createDb();
    const brokerAgent = createBrokerAgent({ rawState: pristineDynsecState });
    const service = new DynsecService(
      db as never,
      createRuntimeConfig(),
      createLogger(),
      brokerAgent as never
    );

    await expect(service.ensureBootstrapDefaultRole({
      correlationId: 'corr-bootstrap-role'
    })).resolves.toEqual({
      bootstrapped: true,
      defaultRoleName: dynsecBootstrapDefaultRoleName
    });

    const state = await service.readState({ correlationId: 'corr-state-read' });

    expect(service.isConfiguredDefaultRoleMissing({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      state
    })).toBe(false);

    await expect(service.createClient({
      username: 'sensor-a',
      password: 'sensor-secret',
      clientId: null,
      disabled: false,
      correlationId: 'corr-create-client'
    })).resolves.toMatchObject({
      defaultRoleApplied: true,
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      defaultRolePriority: 0
    });

    expect(db.settings.get(`${dynsecSettingsScope}:${clientDefaultsKey}`)).toEqual({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      defaultRolePriority: 0
    });
    expect(db.settings.get(`${dynsecSettingsScope}:${bootstrapInitializedKey}`)).toBe(true);
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'createRole',
      args: [dynsecBootstrapDefaultRoleName],
      correlationId: 'corr-bootstrap-role'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'createRole',
      args: [dynsecBootstrapReadWriteRoleName],
      correlationId: 'corr-bootstrap-role'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'addClientRole',
      args: ['sensor-a', dynsecBootstrapDefaultRoleName, '0'],
      correlationId: 'corr-create-client'
    }));
  });

  it('reports a missing default role when the configured read-all role was never provisioned in this process', async () => {
    const db = createDb();
    db.settings.set(`${dynsecSettingsScope}:${clientDefaultsKey}`, {
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      defaultRolePriority: 0
    });
    db.settings.set(`${dynsecSettingsScope}:${bootstrapInitializedKey}`, true);

    const service = new DynsecService(
      db as never,
      createRuntimeConfig(),
      createLogger(),
      createBrokerAgent({ rawState: pristineDynsecState }) as never
    );
    const state = await service.readState({ correlationId: 'corr-state-missing' });

    expect(service.isConfiguredDefaultRoleMissing({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      state
    })).toBe(true);
  });

  it('only suppresses the missing-role warning briefly after bootstrap while the state file catches up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));

    const service = new DynsecService(
      createDb() as never,
      createRuntimeConfig(),
      createLogger(),
      createBrokerAgent({ rawState: pristineDynsecState }) as never
    );

    await expect(service.ensureBootstrapDefaultRole({
      correlationId: 'corr-bootstrap-grace'
    })).resolves.toEqual({
      bootstrapped: true,
      defaultRoleName: dynsecBootstrapDefaultRoleName
    });

    const state = await service.readState({ correlationId: 'corr-state-grace' });

    expect(service.isConfiguredDefaultRoleMissing({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      state
    })).toBe(false);

    vi.advanceTimersByTime(10_001);

    expect(service.isConfiguredDefaultRoleMissing({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      state
    })).toBe(true);
  });

  it('captures the bootstrap failure details for later UI visibility', async () => {
    const service = new DynsecService(
      createDb() as never,
      createRuntimeConfig(),
      createLogger(),
      {
        isConfigured: vi.fn(() => true),
        readDynsecStateRaw: vi.fn(async () => {
          throw new Error('broker agent unavailable');
        }),
        runDynsecCommand: vi.fn()
      } as never
    );

    await expect(service.ensureBootstrapDefaultRole({
      correlationId: 'corr-bootstrap-error'
    })).rejects.toMatchObject({
      errorKey: 'DYNSEC_STATE_READ_FAILED',
      message: 'Failed reading dynamic security state through broker agent.'
    });

    expect(service.getBootstrapDefaultRoleError()).toEqual({
      reason: 'broker agent unavailable',
      errorKey: 'DYNSEC_STATE_READ_FAILED',
      details: null
    });
  });

  it('treats stderr-reported dynsec command errors as bootstrap failures even when the exit code is zero', async () => {
    const db = createDb();
    const service = new DynsecService(
      db as never,
      createRuntimeConfig(),
      createLogger(),
      {
        isConfigured: vi.fn(() => true),
        readDynsecStateRaw: vi.fn(async () => pristineDynsecState),
        runDynsecCommand: vi.fn(async ({
          command,
          args
        }: {
          command: string;
          args?: string[];
        }) => ({
          executable: 'mosquitto_ctrl',
          args: ['dynsec', command, ...(args ?? [])],
          exitCode: 0,
          stdout: '',
          stderr: command === 'createRole'
            ? 'Warning: You are running mosquitto_ctrl without encryption.\nThis means all of the configuration changes you are making are visible on the network, including passwords.\n\nConnection error: Not authorized\n'
            : ''
        }))
      } as never
    );

    await expect(service.ensureBootstrapDefaultRole({
      correlationId: 'corr-bootstrap-stderr-error'
    })).rejects.toMatchObject({
      errorKey: 'DYNSEC_OPERATION_FAILED'
    });

    expect(db.settings.get(`${dynsecSettingsScope}:${clientDefaultsKey}`)).toBeUndefined();
    expect(db.settings.get(`${dynsecSettingsScope}:${bootstrapInitializedKey}`)).toBeUndefined();
  });

  it('reconciles a partially created read-all role and creates read-write-all before setting the default', async () => {
    const db = createDb();
    const brokerAgent = createBrokerAgent({
      rawState: {
        ...pristineDynsecState,
        roles: [
          ...pristineDynsecState.roles,
          {
            rolename: dynsecBootstrapDefaultRoleName,
            textname: null,
            textdescription: null,
            acls: [
              {
                acltype: 'publishClientReceive',
                topic: '#',
                allow: true,
                priority: 0
              }
            ]
          }
        ]
      }
    });
    const service = new DynsecService(
      db as never,
      createRuntimeConfig(),
      createLogger(),
      brokerAgent as never
    );

    await expect(service.ensureBootstrapDefaultRole({
      correlationId: 'corr-bootstrap-reconcile'
    })).resolves.toEqual({
      bootstrapped: true,
      defaultRoleName: dynsecBootstrapDefaultRoleName
    });

    expect(db.settings.get(`${dynsecSettingsScope}:${clientDefaultsKey}`)).toEqual({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      defaultRolePriority: 0
    });
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'addRoleACL',
      args: [dynsecBootstrapDefaultRoleName, 'subscribePattern', '#', 'allow', '0'],
      correlationId: 'corr-bootstrap-reconcile'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'addRoleACL',
      args: [dynsecBootstrapDefaultRoleName, 'unsubscribePattern', '#', 'allow', '0'],
      correlationId: 'corr-bootstrap-reconcile'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'createRole',
      args: [dynsecBootstrapReadWriteRoleName],
      correlationId: 'corr-bootstrap-reconcile'
    }));
  });

  it('migrates the legacy mqttctl-default role into read-write-all and moves the default to read-all', async () => {
    const db = createDb();
    db.settings.set(`${dynsecSettingsScope}:${clientDefaultsKey}`, {
      defaultRoleName: dynsecLegacyBootstrapRoleName,
      defaultRolePriority: 0
    });
    db.settings.set(`${dynsecSettingsScope}:${bootstrapInitializedKey}`, true);

    const brokerAgent = createBrokerAgent({
      rawState: {
        ...pristineDynsecState,
        clients: [
          {
            username: 'sensor-a',
            clientid: null,
            textname: null,
            textdescription: null,
            disabled: false,
            roles: [
              {
                rolename: dynsecLegacyBootstrapRoleName,
                priority: 7
              }
            ],
            groups: []
          }
        ],
        groups: [
          {
            groupname: 'operators',
            textname: null,
            textdescription: null,
            roles: [
              {
                rolename: dynsecLegacyBootstrapRoleName,
                priority: 5
              }
            ],
            clients: []
          }
        ],
        roles: [
          ...pristineDynsecState.roles,
          {
            rolename: dynsecLegacyBootstrapRoleName,
            textname: null,
            textdescription: null,
            acls: [
              {
                acltype: 'publishClientReceive',
                topic: '#',
                allow: true,
                priority: 0
              },
              {
                acltype: 'publishClientSend',
                topic: '#',
                allow: true,
                priority: 0
              },
              {
                acltype: 'subscribePattern',
                topic: '#',
                allow: true,
                priority: 0
              },
              {
                acltype: 'unsubscribePattern',
                topic: '#',
                allow: true,
                priority: 0
              }
            ]
          }
        ]
      }
    });
    const service = new DynsecService(
      db as never,
      createRuntimeConfig(),
      createLogger(),
      brokerAgent as never
    );

    await expect(service.ensureBootstrapDefaultRole({
      correlationId: 'corr-bootstrap-legacy-migrate'
    })).resolves.toEqual({
      bootstrapped: true,
      defaultRoleName: dynsecBootstrapDefaultRoleName
    });

    expect(db.settings.get(`${dynsecSettingsScope}:${clientDefaultsKey}`)).toEqual({
      defaultRoleName: dynsecBootstrapDefaultRoleName,
      defaultRolePriority: 0
    });
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'addClientRole',
      args: ['sensor-a', dynsecBootstrapReadWriteRoleName, '7'],
      correlationId: 'corr-bootstrap-legacy-migrate'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'removeClientRole',
      args: ['sensor-a', dynsecLegacyBootstrapRoleName],
      correlationId: 'corr-bootstrap-legacy-migrate'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'addGroupRole',
      args: ['operators', dynsecBootstrapReadWriteRoleName, '5'],
      correlationId: 'corr-bootstrap-legacy-migrate'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'removeGroupRole',
      args: ['operators', dynsecLegacyBootstrapRoleName],
      correlationId: 'corr-bootstrap-legacy-migrate'
    }));
    expect(brokerAgent.runDynsecCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'deleteRole',
      args: [dynsecLegacyBootstrapRoleName],
      correlationId: 'corr-bootstrap-legacy-migrate'
    }));
  });
});
