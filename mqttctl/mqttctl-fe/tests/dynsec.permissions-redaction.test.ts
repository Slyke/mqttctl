import { describe, expect, it, vi } from 'vitest';
import { DynsecService } from '$server/dynsec/service';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppLogger } from '$server/logging/logger';

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

describe('DynsecService effective permission raw state', () => {
  it('returns fingerprints instead of complete password hashes and salts', async () => {
    const password = '0123456789abcdefghijkl';
    const salt = 'abcdefghijklmnop';
    const brokerAgent = {
      isConfigured: vi.fn(() => true),
      readDynsecStateRaw: vi.fn(async () => ({
        clients: [{
          username: 'utest1',
          password,
          salt,
          roles: []
        }],
        groups: [],
        roles: [],
        anonymousGroup: null,
        defaultACLAccess: {}
      }))
    };
    const service = new DynsecService(
      {} as never,
      createRuntimeConfig(),
      createLogger(),
      brokerAgent as never
    );

    const permissions = await service.getEffectivePermissions({
      username: 'utest1',
      correlationId: 'corr-permissions'
    });
    const raw = permissions.raw as { clients: Array<{ password: string; salt: string }> };

    expect(raw.clients[0]).toMatchObject({
      password: '012345...ghijkl',
      salt: 'abcdef...klmnop'
    });
    expect(JSON.stringify(raw)).not.toContain(password);
    expect(JSON.stringify(raw)).not.toContain(salt);
  });
});
