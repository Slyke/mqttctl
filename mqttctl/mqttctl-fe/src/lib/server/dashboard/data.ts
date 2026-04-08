import type { DiagnosticsSummary } from '$types';
import type { AuthenticatedUser } from '$server/auth/types';
import type { AppContext } from '$server/context';
import { AppError } from '$server/logging/errors';
import { hasCapability } from '$server/permissions';
import { refreshDashboardSnapshot } from '$lib/server/dashboard/live-state';

interface DashboardDynsecCounts {
  clients: number | null;
  groups: number | null;
  roles: number | null;
}

export interface DashboardPageData extends Record<string, unknown> {
  diagnostics: DiagnosticsSummary;
  uiTransport: {
    label: string;
    security: 'tls' | 'unencrypted';
  };
  controlPlaneTransport: {
    label: string;
    security: 'tls' | 'unencrypted';
  };
  brokerTransport: {
    label: string;
    security: 'tls' | 'unencrypted';
  } | null;
  canViewAudit: boolean;
  counts: {
    users: number;
    clients: number | null;
    groups: number | null;
    roles: number | null;
  };
  auditEntries: Array<{
    timestamp: string;
    action: string;
    actorUsername: string | null;
    success: boolean;
  }>;
}

export const loadDashboardDiagnostics = async ({
  appContext,
  correlationId
}: {
  appContext: AppContext;
  correlationId: string | null;
}) => (await refreshDashboardSnapshot({
  appContext,
  correlationId
})).diagnostics;

export const loadDashboardPageData = async ({
  appContext,
  correlationId,
  currentUser
}: {
  appContext: AppContext;
  correlationId: string | null;
  currentUser: AuthenticatedUser | null;
}): Promise<DashboardPageData> => {
  const unavailableDynsecCounts: DashboardDynsecCounts = {
    clients: null,
    groups: null,
    roles: null
  };
  const canViewAudit = hasCapability({
    user: currentUser,
    capability: 'view_audit'
  });

  const [diagnostics, users, auditEntries] = await Promise.all([
    loadDashboardDiagnostics({ appContext, correlationId }),
    appContext.auth.listUsers(),
    canViewAudit
      ? appContext.db.listAuditEntries({ limit: 5 })
      : Promise.resolve([])
  ]);

  let dynsecCounts = unavailableDynsecCounts;
  const brokerAgentConfigured = appContext.brokerAgent.isConfigured();

  if (diagnostics.dynsecStateReadable && diagnostics.dynsecBootstrap.status !== 'running') {
    try {
      const dynsec = await appContext.dynsec.readState({ correlationId });
      dynsecCounts = {
        clients: dynsec.clients.length,
        groups: dynsec.groups.length,
        roles: dynsec.roles.length
      };
    } catch (error) {
      if (
        error instanceof AppError
        && error.errorKey === 'DYNSEC_STATE_READ_FAILED'
      ) {
        appContext.logger.warn({
          caller: 'dashboard::loadDashboardPageData',
          message: 'Failed reading DynSec state while loading dashboard counts. Rendering unavailable counts.',
          correlationId,
          errorKey: error.errorKey,
          rootCause: error
        });
      } else {
        throw error;
      }
    }
  }

  return {
    diagnostics,
    uiTransport: {
      label: 'WUI to API',
      security: appContext.runtimeConfig.config.publicBaseUrl.startsWith('https://') ? 'tls' : 'unencrypted'
    },
    controlPlaneTransport: brokerAgentConfigured
      ? {
          label: 'API to Broker Agent',
          security: appContext.runtimeConfig.config.broker.agent?.baseUrl.startsWith('https://') ? 'tls' : 'unencrypted'
        }
      : {
          label: 'API to Broker',
          security: appContext.runtimeConfig.config.broker.tls.enabled ? 'tls' : 'unencrypted'
        },
    brokerTransport: brokerAgentConfigured
      ? {
          label: 'Broker Agent to Mosquitto',
          security: appContext.runtimeConfig.config.broker.tls.enabled ? 'tls' : 'unencrypted'
        }
      : null,
    canViewAudit,
    counts: {
      users: users.length,
      ...dynsecCounts
    },
    auditEntries
  };
};
