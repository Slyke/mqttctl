import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BrokerConfigService } from '$server/config/service';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppLogger } from '$server/logging/logger';
import { createAppError } from '$server/logging/errors';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

const createRuntimeConfig = ({
  keyFiles
}: {
  keyFiles: {
    caFile: string | null;
    mosquittoPublicKey: string | null;
    brokerPublicKey: string | null;
  };
}) => ({
  config: {
    broker: {
      mainConfigPath: '/tmp/mosquitto.conf',
      keyFiles
    }
  }
} as unknown as LoadedRuntimeConfig);

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
} as unknown as AppLogger);

const createBrokerAgent = () => ({
  isConfigured: vi.fn(() => false),
  listManagedKeyFiles: vi.fn(),
  readManagedKeyFile: vi.fn()
});

describe('BrokerConfigService managed key files', () => {
  it('reports configured and missing key files in local mode', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mqttctl-key-files-'));
    tempDirectories.push(directory);

    const caFilePath = path.join(directory, 'ca.crt');
    await writeFile(caFilePath, 'ca-data', 'utf8');

    const service = new BrokerConfigService(
      { setSetting: vi.fn() } as never,
      createRuntimeConfig({
        keyFiles: {
          caFile: caFilePath,
          mosquittoPublicKey: path.join(directory, 'mosquitto.crt'),
          brokerPublicKey: null
        }
      }),
      createLogger(),
      createBrokerAgent() as never
    );

    await expect(service.listManagedKeyFiles()).resolves.toEqual([
      expect.objectContaining({
        fileId: 'caFile',
        path: caFilePath,
        fileName: 'ca.crt',
        configured: true,
        exists: true
      }),
      expect.objectContaining({
        fileId: 'mosquittoPublicKey',
        fileName: 'mosquitto.crt',
        configured: true,
        exists: false
      }),
      expect.objectContaining({
        fileId: 'brokerPublicKey',
        path: null,
        fileName: null,
        configured: false,
        exists: false
      })
    ]);
  });

  it('reads configured managed key files in local mode', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mqttctl-key-files-'));
    tempDirectories.push(directory);

    const brokerPublicKeyPath = path.join(directory, 'broker.crt');
    await writeFile(brokerPublicKeyPath, 'broker-public-key', 'utf8');

    const service = new BrokerConfigService(
      { setSetting: vi.fn() } as never,
      createRuntimeConfig({
        keyFiles: {
          caFile: null,
          mosquittoPublicKey: null,
          brokerPublicKey: brokerPublicKeyPath
        }
      }),
      createLogger(),
      createBrokerAgent() as never
    );

    await expect(service.readManagedKeyFile({ fileId: 'brokerPublicKey' })).resolves.toEqual({
      fileId: 'brokerPublicKey',
      path: brokerPublicKeyPath,
      fileName: 'broker.crt',
      content: 'broker-public-key'
    });
  });

  it('falls back to configured metadata when broker-agent key file listing returns 404', async () => {
    const brokerAgent = createBrokerAgent();
    brokerAgent.isConfigured.mockReturnValue(true);
    brokerAgent.listManagedKeyFiles.mockRejectedValue(createAppError({
      caller: 'broker-agent::request',
      reason: 'Broker agent request failed with HTTP 404.',
      errorKey: 'BROKER_AGENT_REQUEST_FAILED',
      correlationId: 'corr-key-files-404',
      status: 404
    }));
    const logger = createLogger();

    const service = new BrokerConfigService(
      { setSetting: vi.fn() } as never,
      createRuntimeConfig({
        keyFiles: {
          caFile: null,
          mosquittoPublicKey: null,
          brokerPublicKey: null
        }
      }),
      logger,
      brokerAgent as never
    );

    await expect(service.listManagedKeyFiles()).resolves.toEqual([
      {
        fileId: 'caFile',
        path: null,
        fileName: null,
        configured: false,
        exists: false
      },
      {
        fileId: 'mosquittoPublicKey',
        path: null,
        fileName: null,
        configured: false,
        exists: false
      },
      {
        fileId: 'brokerPublicKey',
        path: null,
        fileName: null,
        configured: false,
        exists: false
      }
    ]);

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      caller: 'broker-config::listManagedKeyFiles',
      errorKey: 'BROKER_AGENT_REQUEST_FAILED'
    }));
  });

  it('delegates broker-agent key file downloads even when app-local key file paths are unset', async () => {
    const brokerAgent = createBrokerAgent();
    brokerAgent.isConfigured.mockReturnValue(true);
    brokerAgent.readManagedKeyFile.mockResolvedValue({
      fileId: 'caFile',
      path: '/mosquitto/certs/ca/ca.crt',
      fileName: 'ca.crt',
      content: 'ca-data'
    });

    const service = new BrokerConfigService(
      { setSetting: vi.fn() } as never,
      createRuntimeConfig({
        keyFiles: {
          caFile: null,
          mosquittoPublicKey: null,
          brokerPublicKey: null
        }
      }),
      createLogger(),
      brokerAgent as never
    );

    await expect(service.readManagedKeyFile({
      fileId: 'caFile',
      correlationId: 'corr-key-file-missing'
    })).resolves.toEqual({
      fileId: 'caFile',
      path: '/mosquitto/certs/ca/ca.crt',
      fileName: 'ca.crt',
      content: 'ca-data'
    });

    expect(brokerAgent.readManagedKeyFile).toHaveBeenCalledWith({
      fileId: 'caFile',
      correlationId: 'corr-key-file-missing'
    });
  });
});
