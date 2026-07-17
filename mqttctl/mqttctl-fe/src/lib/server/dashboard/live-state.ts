import { EventEmitter } from 'node:events';
import type { DiagnosticsSummary, McpRuntimeInfo } from '$lib/types';
import type { AppContext } from '$server/context';

const dashboardSnapshotEvent = 'dashboard-snapshot';

export interface DashboardSnapshot {
  diagnostics: DiagnosticsSummary;
  mcpRuntime: McpRuntimeInfo;
  generatedAt: string;
}

const dashboardEmitter = new EventEmitter();
let latestSnapshot: DashboardSnapshot | null = null;
let latestSnapshotJson: string | null = null;

export const getLatestDashboardSnapshot = () => latestSnapshot;

export const subscribeDashboardSnapshots = ({
  listener
}: {
  listener: (snapshot: DashboardSnapshot) => void;
}) => {
  dashboardEmitter.on(dashboardSnapshotEvent, listener);

  return () => {
    dashboardEmitter.off(dashboardSnapshotEvent, listener);
  };
};

export const updateDashboardSnapshot = ({
  diagnostics,
  mcpRuntime
}: {
  diagnostics: DiagnosticsSummary;
  mcpRuntime: McpRuntimeInfo;
}) => {
  const snapshotJson = JSON.stringify({ diagnostics, mcpRuntime });

  if (snapshotJson === latestSnapshotJson && latestSnapshot) {
    return latestSnapshot;
  }

  latestSnapshotJson = snapshotJson;
  latestSnapshot = {
    diagnostics,
    mcpRuntime,
    generatedAt: new Date().toISOString()
  };

  dashboardEmitter.emit(dashboardSnapshotEvent, latestSnapshot);

  return latestSnapshot;
};

export const refreshDashboardSnapshot = async ({
  appContext,
  correlationId
}: {
  appContext: AppContext;
  correlationId: string | null;
}) => {
  const [diagnostics, mcpRuntime] = await Promise.all([
    appContext.diagnostics.getSummary({ correlationId }),
    appContext.mcpAuth.getRuntimeInfo()
  ]);
  return updateDashboardSnapshot({ diagnostics, mcpRuntime });
};

export const refreshDashboardMcpRuntime = async ({
  appContext
}: {
  appContext: AppContext;
}) => {
  if (!latestSnapshot) return null;
  return updateDashboardSnapshot({
    diagnostics: latestSnapshot.diagnostics,
    mcpRuntime: await appContext.mcpAuth.getRuntimeInfo()
  });
};
