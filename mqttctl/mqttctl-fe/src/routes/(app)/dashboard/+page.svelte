<script lang="ts">
  import { onMount } from 'svelte';
  import { copyTableAsJson, type TableJsonPayload } from '$lib/actions/copy-table-json';
  import { formatDisplayCode } from '$lib/strings/display';
  import type { DiagnosticsSummary, OperationStatus } from '$lib/types';

  export let data: {
    basePath: string;
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
  };

  type DashboardLiveMessage =
    | {
        type: 'status';
        generatedAt: string;
        diagnostics: DiagnosticsSummary;
      };
  type BackendConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
  type DashboardBadgeTone = 'tone-mid' | 'tone-warning' | 'tone-danger';

  const backendConnectionTone = ({
    state
  }: {
    state: BackendConnectionState;
  }): DashboardBadgeTone => {
    if (state === 'connected') return 'tone-mid';
    if (state === 'connecting') return 'tone-warning';
    return 'tone-danger';
  };

  const backendConnectionLabel = ({
    state
  }: {
    state: BackendConnectionState;
  }) => {
    if (state === 'connected') return 'WUI to API Connected';
    if (state === 'connecting') return 'WUI to API Connecting';
    return 'WUI to API Disconnected';
  };

  const brokerStatus = ({
    state
  }: {
    state: BackendConnectionState;
  }): { label: string; tone: DashboardBadgeTone } => {
    if (state === 'connected') {
      return liveDiagnostics.brokerReachable
        ? { label: 'Broker Reachable', tone: 'tone-mid' }
        : { label: 'Broker Unreachable', tone: 'tone-danger' };
    }

    if (state === 'connecting') {
      return { label: 'Broker Unknown', tone: 'tone-warning' };
    }

    return { label: 'Broker Unreachable', tone: 'tone-danger' };
  };

  const dynsecStatus = ({
    state
  }: {
    state: BackendConnectionState;
  }): { label: string; tone: DashboardBadgeTone } => {
    if (state === 'connected') {
      return liveDiagnostics.dynsecStateReadable
        ? { label: 'DynSec State Readable', tone: 'tone-mid' }
        : { label: 'DynSec State Unreadable', tone: 'tone-danger' };
    }

    if (state === 'connecting') {
      return { label: 'DynSec State Unknown', tone: 'tone-warning' };
    }

    return { label: 'DynSec State Unreadable', tone: 'tone-danger' };
  };

  const createDashboardSocketUrl = () => {
    const url = new URL(`${data.basePath}/api/dashboard/ws`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  };

  const operationStatusTone = ({
    status
  }: {
    status: OperationStatus['status'];
  }): DashboardBadgeTone | '' => {
    if (status === 'success') return 'tone-mid';
    if (status === 'running') return 'tone-warning';
    if (status === 'failed') return 'tone-danger';
    return '';
  };

  const formatStatValue = (value: number | null) => value === null ? 'Unavailable' : `${value}`;
  const dynsecBootstrapNoticeTone = ({
    status
  }: {
    status: OperationStatus['status'];
  }): DashboardBadgeTone => status === 'failed' ? 'tone-danger' : 'tone-warning';
  const dynsecBootstrapNoticeLabel = ({
    status,
    message
  }: {
    status: OperationStatus['status'];
    message: string | null;
  }) => {
    if (status === 'running') return message ?? 'DynSec is still setting things up.';
    if (status === 'failed') return message ?? 'DynSec bootstrap failed.';
    return '';
  };

  let liveDiagnostics = data.diagnostics;
  let backendConnectionState: BackendConnectionState = 'connecting';
  let dashboardSocket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let keepDashboardSocketAlive = true;
  let currentBrokerStatus = brokerStatus({ state: backendConnectionState });
  let currentDynsecStatus = dynsecStatus({ state: backendConnectionState });
  let recentWritesTableJson: TableJsonPayload;

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = () => {
    clearReconnectTimer();

    if (!keepDashboardSocketAlive) return;

    backendConnectionState = 'connecting';

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      openDashboardSocket();
    }, 2_000);
  };

  const handleDashboardMessage = ({ raw }: { raw: string }) => {
    const message = JSON.parse(raw) as DashboardLiveMessage;

    if (message.type !== 'status') return;

    liveDiagnostics = message.diagnostics;
    backendConnectionState = 'connected';
    clearReconnectTimer();
  };

  const openDashboardSocket = () => {
    if (!keepDashboardSocketAlive) return;

    dashboardSocket?.close();
    if (backendConnectionState !== 'connected') {
      backendConnectionState = 'connecting';
    }

    const socket = new WebSocket(createDashboardSocketUrl());
    dashboardSocket = socket;

    socket.onopen = () => {
      if (dashboardSocket !== socket) return;
      if (backendConnectionState !== 'connected') {
        backendConnectionState = 'connecting';
      }
    };

    socket.onmessage = (event) => {
      if (dashboardSocket !== socket) return;

      try {
        handleDashboardMessage({ raw: event.data as string });
      } catch {
        backendConnectionState = 'error';
        socket.close();
      }
    };

    socket.onerror = () => {
      if (dashboardSocket !== socket) return;
      backendConnectionState = 'error';
    };

    socket.onclose = () => {
      if (dashboardSocket !== socket) return;
      dashboardSocket = null;
      scheduleReconnect();
    };
  };

  onMount(() => {
    openDashboardSocket();

    return () => {
      keepDashboardSocketAlive = false;
      clearReconnectTimer();
      dashboardSocket?.close();
      dashboardSocket = null;
    };
  });

  $: currentBrokerStatus = brokerStatus({ state: backendConnectionState });
  $: currentDynsecStatus = dynsecStatus({ state: backendConnectionState });
  $: recentWritesTableJson = {
    section: 'Dashboard',
    table: 'Recent Writes',
    columns: ['time', 'action', 'actor', 'result'],
    content: data.auditEntries.map((entry) => ({
      time: entry.timestamp,
      action: entry.action,
      actor: entry.actorUsername,
      result: entry.success ? 'success' : 'failed'
    }))
  };
</script>

<section class="stack dashboard-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Dashboard</h1>
      <p class="muted">Operational health, broker reachability, and recent write activity.</p>
    </div>
  </div>

  {#if liveDiagnostics.dynsecBootstrap.status === 'running' || liveDiagnostics.dynsecBootstrap.status === 'failed'}
    <div class="badge dynsec-bootstrap-banner {dynsecBootstrapNoticeTone({ status: liveDiagnostics.dynsecBootstrap.status })}">
      {dynsecBootstrapNoticeLabel({
        status: liveDiagnostics.dynsecBootstrap.status,
        message: liveDiagnostics.dynsecBootstrap.message
      })}
    </div>
  {/if}

  <div class="stat-grid">
    <article class="stat-card">
      <div class="muted">App Users</div>
      <p class="stat-value">{data.counts.users}</p>
    </article>
    <article class="stat-card">
      <div class="muted">DynSec Clients</div>
      <p class="stat-value" class:stat-value-unavailable={data.counts.clients === null}>
        {formatStatValue(data.counts.clients)}
      </p>
    </article>
    <article class="stat-card">
      <div class="muted">Groups</div>
      <p class="stat-value" class:stat-value-unavailable={data.counts.groups === null}>
        {formatStatValue(data.counts.groups)}
      </p>
    </article>
    <article class="stat-card">
      <div class="muted">Roles</div>
      <p class="stat-value" class:stat-value-unavailable={data.counts.roles === null}>
        {formatStatValue(data.counts.roles)}
      </p>
    </article>
  </div>

  <div class="panel-grid">
    <article class="panel stack-tight">
      <h2>Broker Reachability</h2>
      <div class="dashboard-status-list">
        <div class="badge dashboard-status-badge {backendConnectionTone({ state: backendConnectionState })}">
          {backendConnectionLabel({ state: backendConnectionState })}
        </div>
        <div class="badge dashboard-status-badge {currentBrokerStatus.tone}">
          {currentBrokerStatus.label}
        </div>
        <div class="badge dashboard-status-badge {currentDynsecStatus.tone}">
          {currentDynsecStatus.label}
        </div>
        {#if liveDiagnostics.dynsecBootstrap.status === 'running' || liveDiagnostics.dynsecBootstrap.status === 'failed'}
          <div class="badge dashboard-status-badge {dynsecBootstrapNoticeTone({ status: liveDiagnostics.dynsecBootstrap.status })}">
            DynSec Bootstrap {formatDisplayCode(liveDiagnostics.dynsecBootstrap.status)}
          </div>
        {/if}
        <div class="badge dashboard-status-badge {data.uiTransport.security === 'tls' ? 'tone-mid' : 'tone-warning'}">
          {data.uiTransport.label} {formatDisplayCode(data.uiTransport.security)}
        </div>
        <div class="badge dashboard-status-badge {data.controlPlaneTransport.security === 'tls' ? 'tone-mid' : 'tone-warning'}">
          {data.controlPlaneTransport.label} {formatDisplayCode(data.controlPlaneTransport.security)}
        </div>
        {#if data.brokerTransport}
          <div class="badge dashboard-status-badge {data.brokerTransport.security === 'tls' ? 'tone-mid' : 'tone-warning'}">
            {data.brokerTransport.label} {formatDisplayCode(data.brokerTransport.security)}
          </div>
        {/if}
      </div>
    </article>

    <article class="panel stack-tight">
      <h2>MQTT Config</h2>
      <div class="badge dashboard-status-badge {liveDiagnostics.brokerConfigReadable ? 'tone-mid' : 'tone-danger'}">
        {liveDiagnostics.brokerConfigReadable ? 'Readable' : 'Unreadable'}
      </div>
      <div class="subtle">Direct file editing and key downloads are active on the MQTT Config page.</div>
    </article>

    <article class="panel stack-tight">
      <h2>Last Reload</h2>
      <div class="badge dashboard-status-badge {operationStatusTone({ status: liveDiagnostics.lastReload.status })}">
        {formatDisplayCode(liveDiagnostics.lastReload.status)}
      </div>
      <div class="muted">{liveDiagnostics.lastReload.lastRunAt ?? 'Never'}</div>
      <div class="subtle">{liveDiagnostics.lastReload.message ?? 'No reload attempted yet.'}</div>
    </article>

    <article class="panel stack-tight">
      <h2>Last Restart</h2>
      <div class="badge dashboard-status-badge {operationStatusTone({ status: liveDiagnostics.lastRestart.status })}">
        {formatDisplayCode(liveDiagnostics.lastRestart.status)}
      </div>
      <div class="muted">{liveDiagnostics.lastRestart.lastRunAt ?? 'Never'}</div>
      <div class="subtle">{liveDiagnostics.lastRestart.message ?? 'No restart attempted yet.'}</div>
    </article>
  </div>

  <div class="panel-grid dashboard-detail-grid">
    <article class="panel stack">
      <h2>Recent Writes</h2>
      {#if data.canViewAudit}
        {#if data.auditEntries.length}
          <div class="table-wrap" use:copyTableAsJson={recentWritesTableJson}>
            <table class="dashboard-recent-writes">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {#each data.auditEntries as entry}
                  <tr>
                    <td>{entry.timestamp}</td>
                    <td>{entry.action}</td>
                    <td>{entry.actorUsername ?? 'System'}</td>
                    <td class={entry.success ? 'tone-mid' : 'tone-danger'}>{entry.success ? 'Success' : 'Failed'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="muted">No write activity recorded yet.</p>
        {/if}
      {:else}
        <p class="muted">Recent write history is not available for your role.</p>
      {/if}
    </article>
  </div>
</section>

<style>
  .dashboard-page {
    gap: 1.5rem;
  }

  .dashboard-detail-grid {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  .dashboard-status-badge {
    align-self: start;
    justify-self: start;
    width: auto;
    max-width: max-content;
  }

  .dashboard-status-list {
    display: grid;
    gap: var(--space-2);
  }

  .dashboard-status-list .dashboard-status-badge {
    justify-self: stretch;
    width: 100%;
    max-width: none;
    justify-content: flex-start;
    box-sizing: border-box;
  }

  .dynsec-bootstrap-banner {
    width: 100%;
    justify-content: flex-start;
  }

  .stat-value-unavailable {
    font-size: clamp(1.1rem, 2vw, 1.5rem);
    letter-spacing: -0.02em;
  }

  .dashboard-recent-writes {
    min-width: 44rem;
  }

  .dashboard-recent-writes th,
  .dashboard-recent-writes td {
    white-space: nowrap;
  }

  @media (max-width: 1180px) {
    .dashboard-detail-grid {
      grid-template-columns: 1fr;
    }

    .dashboard-recent-writes {
      min-width: 0;
    }

    .dashboard-recent-writes th,
    .dashboard-recent-writes td {
      white-space: normal;
    }
  }
</style>
