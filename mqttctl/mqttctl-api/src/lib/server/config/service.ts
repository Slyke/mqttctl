import { Buffer } from 'node:buffer';
import { access, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppDatabase } from '$server/db';
import type { AppLogger } from '$server/logging/logger';
import { AppError, createAppError } from '$server/logging/errors';
import { runCommand } from '$server/broker/command-runner';
import type { BrokerAgentClient } from '$server/broker-agent/client';
import type {
  ManagedBrokerKeyFileDownload,
  ManagedBrokerKeyFileId,
  ManagedBrokerKeyFileStatus
} from '$lib/types';

const operationsSettingScope = 'operations';
const managedBrokerKeyFileOrder: ManagedBrokerKeyFileId[] = ['caFile', 'mosquittoPublicKey', 'brokerPublicKey'];

export class BrokerConfigService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtimeConfig: LoadedRuntimeConfig,
    private readonly logger: AppLogger,
    private readonly brokerAgent: BrokerAgentClient
  ) {}

  async readCurrentBrokerConfig({ correlationId = null }: { correlationId?: string | null } = {}) {
    if (this.brokerAgent.isConfigured()) {
      return await this.brokerAgent.readCurrentBrokerConfig({ correlationId });
    }

    return await readFile(this.runtimeConfig.config.broker.mainConfigPath, 'utf8');
  }

  private resolveManagedKeyFilePath({
    fileId,
    correlationId
  }: {
    fileId: ManagedBrokerKeyFileId;
    correlationId: string | null;
  }) {
    const configuredPath = this.runtimeConfig.config.broker.keyFiles[fileId];
    if (configuredPath) return configuredPath;

    throw createAppError({
      caller: 'config::resolveManagedKeyFilePath',
      reason: `Managed broker key file ${fileId} is not configured.`,
      errorKey: 'BROKER_MANAGED_PATH_INVALID',
      correlationId,
      status: 404,
      context: { fileId }
    });
  }

  private async pathExists({
    filePath,
    fileId,
    correlationId
  }: {
    filePath: string;
    fileId: ManagedBrokerKeyFileId;
    correlationId: string | null;
  }) {
    try {
      await access(filePath);
      return true;
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') return false;

      throw createAppError({
        caller: 'config::pathExists',
        reason: `Failed checking managed broker key file ${fileId}.`,
        errorKey: 'BROKER_CONFIG_INVALID',
        correlationId,
        context: { fileId, path: filePath },
        cause: caught
      });
    }
  }

  private describeManagedKeyFilesFromConfig(): ManagedBrokerKeyFileStatus[] {
    return managedBrokerKeyFileOrder.map((fileId) => {
      const configuredPath = this.runtimeConfig.config.broker.keyFiles[fileId];

      return {
        fileId,
        path: configuredPath,
        fileName: configuredPath ? path.basename(configuredPath) : null,
        configured: Boolean(configuredPath),
        exists: false
      };
    });
  }

  async listManagedKeyFiles({
    correlationId = null
  }: {
    correlationId?: string | null;
  } = {}): Promise<ManagedBrokerKeyFileStatus[]> {
    if (this.brokerAgent.isConfigured()) {
      try {
        return await this.brokerAgent.listManagedKeyFiles({ correlationId });
      } catch (error) {
        if (
          error instanceof AppError
          && error.errorKey === 'BROKER_AGENT_REQUEST_FAILED'
          && error.status === 404
        ) {
          this.logger.warn({
            caller: 'broker-config::listManagedKeyFiles',
            message: 'Broker agent does not expose managed key file listing. Falling back to configured key file metadata.',
            correlationId,
            errorKey: error.errorKey,
            rootCause: error
          });
          return this.describeManagedKeyFilesFromConfig();
        }

        throw error;
      }
    }

    return await Promise.all(managedBrokerKeyFileOrder.map(async (fileId) => {
      const configuredPath = this.runtimeConfig.config.broker.keyFiles[fileId];
      const exists = configuredPath
        ? await this.pathExists({
            filePath: configuredPath,
            fileId,
            correlationId
          })
        : false;

      return {
        fileId,
        path: configuredPath,
        fileName: configuredPath ? path.basename(configuredPath) : null,
        configured: Boolean(configuredPath),
        exists
      };
    }));
  }

  async readManagedKeyFile({
    fileId,
    correlationId = null
  }: {
    fileId: ManagedBrokerKeyFileId;
    correlationId?: string | null;
  }): Promise<ManagedBrokerKeyFileDownload> {
    if (this.brokerAgent.isConfigured()) {
      return await this.brokerAgent.readManagedKeyFile({ fileId, correlationId });
    }

    const filePath = this.resolveManagedKeyFilePath({ fileId, correlationId });

    try {
      return {
        fileId,
        path: filePath,
        fileName: path.basename(filePath),
        content: await readFile(filePath, 'utf8')
      };
    } catch (caught) {
      throw createAppError({
        caller: 'config::readManagedKeyFile',
        reason: `Failed reading managed broker key file ${fileId}.`,
        errorKey: 'BROKER_CONFIG_INVALID',
        correlationId,
        context: { fileId, path: filePath },
        cause: caught
      });
    }
  }

  private async writeBrokerConfigLocally({
    rendered
  }: {
    rendered: string;
  }) {
    const brokerConfigPath = this.runtimeConfig.config.broker.mainConfigPath;
    const directory = path.dirname(brokerConfigPath);
    const temporaryPath = `${brokerConfigPath}.tmp`;

    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, rendered, 'utf8');
      await rename(temporaryPath, brokerConfigPath);
    } catch (caught) {
      // Mounted config files can reject replacement and truncate-write flows even when in-place writes succeed.
      const handle = await open(brokerConfigPath, 'r+').catch(async (openError: NodeJS.ErrnoException) => {
        if (openError.code === 'ENOENT') {
          return await open(brokerConfigPath, 'w+');
        }

        throw caught;
      });

      try {
        const renderedBuffer = Buffer.from(rendered, 'utf8');
        await handle.write(renderedBuffer, 0, renderedBuffer.byteLength, 0);
        await handle.truncate(renderedBuffer.byteLength);
        await handle.sync();
      } catch {
        throw caught;
      } finally {
        await handle.close();
      }
    }
  }

  private async assertBrokerConfigMatchesExpected({
    expectedCurrent,
    correlationId
  }: {
    expectedCurrent: string;
    correlationId: string | null;
  }) {
    const current = await this.readCurrentBrokerConfig({ correlationId });
    if (current === expectedCurrent) return;

    throw createAppError({
      caller: 'config::assertBrokerConfigMatchesExpected',
      reason: 'Broker config changed since it was last pulled. Pull the latest broker config before pushing again.',
      errorKey: 'BROKER_CONFIG_CONFLICT',
      correlationId,
      status: 409,
      context: {
        path: this.runtimeConfig.config.broker.mainConfigPath,
        expectedBytes: Buffer.byteLength(expectedCurrent, 'utf8'),
        actualBytes: Buffer.byteLength(current, 'utf8')
      }
    });
  }

  async pushBrokerConfig({
    rendered,
    expectedCurrent = null,
    actorUsername,
    correlationId
  }: {
    rendered: string;
    expectedCurrent?: string | null;
    actorUsername: string | null;
    correlationId: string | null;
  }) {
    if (expectedCurrent !== null) {
      await this.assertBrokerConfigMatchesExpected({ expectedCurrent, correlationId });
    }

    if (this.brokerAgent.isConfigured()) {
      await this.brokerAgent.writeBrokerConfig({ rendered, expectedCurrent, correlationId });
    } else {
      await this.writeBrokerConfigLocally({ rendered });
    }

    this.logger.info({
      caller: 'broker-config::pushBrokerConfig',
      message: 'Pushed broker config text.',
      correlationId,
      context: { actorUsername }
    });

    return {
      current: await this.readCurrentBrokerConfig({ correlationId })
    };
  }

  private async saveOperationStatus({
    settingKey,
    operation,
    executedAt = new Date().toISOString()
  }: {
    settingKey: 'lastReload' | 'lastRestart';
    operation: { status: string; message: string | null };
    executedAt?: string;
  }) {
    await this.db.setSetting({
      scope: operationsSettingScope,
      key: settingKey,
      value: {
        status: operation.status,
        lastRunAt: executedAt,
        message: operation.message
      },
      updatedAt: executedAt
    });
  }

  private async runOperationalCommand({
    command,
    commandArgs,
    settingKey,
    correlationId
  }: {
    command: string;
    commandArgs: string[] | undefined;
    settingKey: 'lastReload' | 'lastRestart';
    correlationId: string | null;
  }) {
    if (!commandArgs || !commandArgs.length) {
      await this.db.setSetting({
        scope: 'operations',
        key: settingKey,
        value: {
          status: 'idle',
          lastRunAt: new Date().toISOString(),
          message: `${command} command is not configured.`
        },
        updatedAt: new Date().toISOString()
      });
      return {
        status: 'idle',
        message: `${command} command is not configured.`
      };
    }

    const [executable, ...args] = commandArgs;
    if (!executable) throw new Error(`${command} command is empty.`);
    const result = await runCommand({
      executable,
      args,
      correlationId,
      timeoutMs: 30_000
    });

    const success = result.exitCode === 0;
    await this.db.setSetting({
      scope: 'operations',
      key: settingKey,
      value: {
        status: success ? 'success' : 'failed',
        lastRunAt: new Date().toISOString(),
        message: success ? `${command} completed.` : result.stderr.trim() || `${command} failed.`
      },
      updatedAt: new Date().toISOString()
    });

    if (!success) {
      throw createAppError({
        caller: 'config::runOperationalCommand',
        reason: `${command} command failed.`,
        errorKey: command === 'reload' ? 'BROKER_RELOAD_FAILED' : 'BROKER_RESTART_FAILED',
        correlationId,
        context: result
      });
    }

    return {
      status: 'success',
      message: `${command} completed.`,
      result
    };
  }

  async reloadBroker({ correlationId }: { correlationId: string | null }) {
    let operation;

    if (this.brokerAgent.isConfigured()) {
      operation = await this.brokerAgent.reloadBroker({ correlationId });
      await this.saveOperationStatus({
        settingKey: 'lastReload',
        operation: {
          status: operation.status,
          message: operation.message ?? null
        }
      });
    } else {
      operation = await this.runOperationalCommand({
        command: 'reload',
        commandArgs: this.runtimeConfig.config.broker.reloadCommand,
        settingKey: 'lastReload',
        correlationId
      });
    }

    this.logger.info({
      caller: 'broker-config::reloadBroker',
      message: 'Triggered standalone broker reload.',
      correlationId
    });

    return operation;
  }

  async restartBroker({ correlationId }: { correlationId: string | null }) {
    let operation;

    if (this.brokerAgent.isConfigured()) {
      operation = await this.brokerAgent.restartBroker({ correlationId });
      await this.saveOperationStatus({
        settingKey: 'lastRestart',
        operation: {
          status: operation.status,
          message: operation.message ?? null
        }
      });
    } else {
      operation = await this.runOperationalCommand({
        command: 'restart',
        commandArgs: this.runtimeConfig.config.broker.restartCommand,
        settingKey: 'lastRestart',
        correlationId
      });
    }

    this.logger.info({
      caller: 'broker-config::restartBroker',
      message: 'Triggered standalone broker restart.',
      correlationId
    });

    return operation;
  }
}
