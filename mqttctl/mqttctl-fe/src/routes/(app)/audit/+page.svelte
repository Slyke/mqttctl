<script lang="ts">
  import { copyTableAsJson, type TableJsonPayload } from '$lib/actions/copy-table-json';
  import { formatDisplayCode } from '$lib/strings/display';

  export let data: {
    limitValue: '10' | '20' | '50' | '100' | 'all';
    totalEntries: number;
    hasMore: boolean;
    filters: {
      indexes: [number, number];
    };
    limitOptions: Array<'10' | '20' | '50' | '100' | 'all'>;
    exportUrl: string;
    entries: Array<{
      timestamp: string;
      actorUsername: string | null;
      authMode: string | null;
      sourceIp: string | null;
      action: string;
      targetType: string;
      targetId: string | null;
      success: boolean;
      correlationId: string;
    }>;
  };

  const limitLabel = ({ value }: { value: string }) => value === 'all' ? 'All' : value;
  let auditTableJson: TableJsonPayload;

  $: auditTableJson = {
    section: 'Audit',
    table: 'Entries',
    pages: data.filters.indexes,
    columns: ['time', 'actor', 'auth', 'ip', 'action', 'target', 'result', 'correlation'],
    content: data.entries.map((entry) => ({
      time: entry.timestamp,
      actor: entry.actorUsername,
      auth: entry.authMode,
      ip: entry.sourceIp,
      action: entry.action,
      target: {
        type: entry.targetType,
        id: entry.targetId
      },
      result: entry.success ? 'success' : 'failed',
      correlation: entry.correlationId
    }))
  };
</script>

<section class="stack">
  <div class="page-header audit-header">
    <div>
      <h1 class="page-title">Audit</h1>
      <p class="muted">Append-only write history with actor, auth mode, source IP, and correlation ID.</p>
      <div class="pill-row audit-meta-row">
        <div class="badge tone-mid">
          Showing {data.filters.indexes[1] === -1 ? 'all' : `latest ${data.filters.indexes[1]}`} entries
        </div>
        <div class="badge">{data.totalEntries} total</div>
      </div>
    </div>
    <div class="stack-tight audit-controls">
      <div class="pill-row">
        {#each data.limitOptions as option}
          <a
            class={option === data.limitValue ? 'button-start audit-limit-link' : 'button-mid audit-limit-link'}
            href={`?limit=${option}`}
          >
            {limitLabel({ value: option })}
          </a>
        {/each}
      </div>
      <a class="button-start audit-export-link" href={data.exportUrl}>Download JSON</a>
    </div>
  </div>

  <article class="panel">
    <div class="table-wrap" use:copyTableAsJson={auditTableJson}>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Auth</th>
            <th>IP</th>
            <th>Action</th>
            <th>Target</th>
            <th>Result</th>
            <th>Correlation</th>
          </tr>
        </thead>
        <tbody>
          {#if data.entries.length}
            {#each data.entries as entry}
              <tr>
                <td>{entry.timestamp}</td>
                <td>{entry.actorUsername ?? 'System'}</td>
                <td>{entry.authMode ? formatDisplayCode(entry.authMode) : 'N/A'}</td>
                <td>{entry.sourceIp ?? 'N/A'}</td>
                <td>{entry.action}</td>
                <td>{formatDisplayCode(entry.targetType)}{entry.targetId ? `: ${entry.targetId}` : ''}</td>
                <td class={entry.success ? 'tone-mid' : 'tone-danger'}>{entry.success ? 'Success' : 'Failed'}</td>
                <td class="subtle">{entry.correlationId}</td>
              </tr>
            {/each}
          {:else}
            <tr>
              <td colspan="8" class="muted audit-empty-cell">No audit entries recorded yet.</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    {#if data.hasMore}
      <p class="muted audit-footer-note">Choose a larger limit or `All` to include older entries.</p>
    {/if}
  </article>
</section>

<style>
  .audit-header {
    align-items: flex-start;
    gap: var(--space-4);
  }

  .audit-controls {
    align-items: flex-end;
  }

  .audit-limit-link,
  .audit-export-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 3.5rem;
  }

  .audit-meta-row {
    margin-top: var(--space-3);
  }

  .audit-empty-cell {
    padding: var(--space-5);
    text-align: center;
  }

  .audit-footer-note {
    margin-top: var(--space-4);
  }

  @media (max-width: 960px) {
    .audit-controls {
      width: 100%;
      align-items: stretch;
    }

    .audit-limit-link,
    .audit-export-link {
      flex: 1 1 auto;
    }
  }
</style>
