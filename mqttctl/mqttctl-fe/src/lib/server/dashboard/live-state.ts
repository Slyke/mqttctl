import { EventEmitter } from 'node:events';
import type { DiagnosticsSummary } from '$lib/types';
import type { AppContext } from '$server/context';

const dashboardSnapshotEvent = 'dashboard-snapshot';

export interface DashboardSnapshot {
  diagnostics: DiagnosticsSummary;
  generatedAt: string;
}

const dashboardEmitter = new EventEmitter();
let latestSnapshot: DashboardSnapshot | null = null;
let latestDiagnosticsJson: string | null = null;

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
  diagnostics
}: {
  diagnostics: DiagnosticsSummary;
}) => {
  const diagnosticsJson = JSON.stringify(diagnostics);

  if (diagnosticsJson === latestDiagnosticsJson && latestSnapshot) {
    return latestSnapshot;
  }

  latestDiagnosticsJson = diagnosticsJson;
  latestSnapshot = {
    diagnostics,
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
  const diagnostics = await appContext.diagnostics.getSummary({ correlationId });
  return updateDashboardSnapshot({ diagnostics });
};
