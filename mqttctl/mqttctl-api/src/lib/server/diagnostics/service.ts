import { readFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import type { DiagnosticsSummary, OperationStatus } from '$lib/types';
import type { AppDatabase } from '$server/db';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { DynsecService } from '$server/dynsec/service';
import type { BrokerConfigService } from '$server/config/service';
import type { BrokerAgentClient } from '$server/broker-agent/client';

const defaultOperationStatus = (): OperationStatus => ({
  status: 'idle',
  lastRunAt: null,
  message: null
});

export class DiagnosticsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtimeConfig: LoadedRuntimeConfig,
    private readonly dynsec: DynsecService,
    private readonly brokerConfig: BrokerConfigService,
    private readonly brokerAgent: BrokerAgentClient
  ) {}

  private async checkBrokerReachable({ correlationId }: { correlationId: string | null }) {
    if (this.brokerAgent.isConfigured()) {
      return await this.brokerAgent.readHealth({ correlationId })
        .then(({ brokerRunning }) => brokerRunning)
        .catch(() => false);
    }

    const { host, port, tls: brokerTls } = this.runtimeConfig.config.broker;
    let socket: net.Socket | tls.TLSSocket;
    let successEvent: 'connect' | 'secureConnect' = 'connect';

    if (brokerTls.enabled) {
      try {
        const [ca, cert, key] = await Promise.all([
          brokerTls.caFile ? readFile(brokerTls.caFile) : Promise.resolve(undefined),
          brokerTls.certFile ? readFile(brokerTls.certFile) : Promise.resolve(undefined),
          brokerTls.keyFile ? readFile(brokerTls.keyFile) : Promise.resolve(undefined)
        ]);

        socket = tls.connect({
          host,
          port,
          ca,
          cert,
          key,
          rejectUnauthorized: !brokerTls.insecure,
          servername: net.isIP(host) ? undefined : host
        });
        successEvent = 'secureConnect';
      } catch {
        return false;
      }
    } else {
      socket = net.connect({ host, port });
    }

    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        return resolve(false);
      }, 2_000);

      socket.once(successEvent, () => {
        clearTimeout(timeout);
        socket.end();
        return resolve(true);
      });

      socket.once('error', () => {
        clearTimeout(timeout);
        return resolve(false);
      });
    });
  }

  async getSummary({ correlationId }: { correlationId: string | null }): Promise<DiagnosticsSummary> {
    const [brokerReachable, dynsecStateReadable, brokerConfigReadable, lastReload, lastRestart] = await Promise.all([
      this.checkBrokerReachable({ correlationId }),
      this.dynsec.readState({ correlationId }).then(() => true).catch(() => false),
      this.brokerConfig.readCurrentBrokerConfig({ correlationId }).then(() => true).catch(() => false),
      this.db.getSetting<OperationStatus>({ scope: 'operations', key: 'lastReload' }),
      this.db.getSetting<OperationStatus>({ scope: 'operations', key: 'lastRestart' })
    ]);

    return {
      brokerReachable,
      dynsecStateReadable,
      dynsecBootstrap: this.dynsec.getBootstrapDefaultRoleStatus(),
      brokerConfigReadable,
      lastReload: lastReload ?? defaultOperationStatus(),
      lastRestart: lastRestart ?? defaultOperationStatus()
    };
  }
}
