<script lang="ts">
  import { copyTableAsJson, type TableJsonPayload } from '$lib/actions/copy-table-json';
  import { formatDisplayCode } from '$lib/strings/display';
  import type { AuditEntry } from '$lib/types';

  export let data: {
    limitValue: '10' | '20' | '50' | '100' | 'all';
    totalEntries: number;
    hasMore: boolean;
    filters: {
      indexes: [number, number];
    };
    limitOptions: Array<'10' | '20' | '50' | '100' | 'all'>;
    exportUrl: string;
    entries: AuditEntry[];
  };

  type AuditModalField = {
    key: keyof AuditEntry;
    label: string;
    displayValue: string;
    copyValue: string;
  };

  const limitLabel = ({ value }: { value: string }) => value === 'all' ? 'All' : value;
  const auditPrimaryFieldRows: Array<Array<{ key: keyof AuditEntry; label: string }>> = [
    [
      { key: 'id', label: 'ID' },
      { key: 'sequenceNumber', label: 'Sequence' }
    ],
    [
      { key: 'timestamp', label: 'Time' },
      { key: 'actorUsername', label: 'Actor' }
    ],
    [
      { key: 'action', label: 'Action' },
      { key: 'targetType', label: 'Target Type' }
    ],
    [
      { key: 'targetId', label: 'Target ID' }
    ],
    [
      { key: 'actorUserId', label: 'Actor User ID' },
      { key: 'correlationId', label: 'Correlation' }
    ],
    [
      { key: 'authMode', label: 'Auth' },
      { key: 'sourceIp', label: 'IP' },
      { key: 'success', label: 'Success' }
    ]
  ];
  const auditSecondaryFieldOrder: Array<{ key: keyof AuditEntry; label: string }> = [
    { key: 'commandResult', label: 'Command Result' },
    { key: 'beforeSummary', label: 'Before' },
    { key: 'afterSummary', label: 'After' },
    { key: 'previousEntryHash', label: 'Previous Hash' },
    { key: 'entryHash', label: 'Entry Hash' }
  ];

  let auditTableJson: TableJsonPayload;
  let selectedAuditEntry: AuditEntry | null = null;
  let modalPrimaryRows: AuditModalField[][] = [];
  let modalFields: AuditModalField[] = [];
  let copyFeedback = '';
  let copyResetTimer: number | null = null;

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

  $: modalPrimaryRows = selectedAuditEntry
    ? auditPrimaryFieldRows.map((row) => row.map(({ key, label }) => buildAuditModalField({
        entry: selectedAuditEntry!,
        key,
        label
      })))
    : [];

  $: modalFields = selectedAuditEntry
    ? auditSecondaryFieldOrder.map(({ key, label }) => buildAuditModalField({
        entry: selectedAuditEntry!,
        key,
        label
      }))
    : [];

  const formatTarget = ({ entry }: { entry: AuditEntry }) =>
    `${formatDisplayCode(entry.targetType)}${entry.targetId ? `: ${entry.targetId}` : ''}`;

  const formatFieldDisplayValue = ({ value }: { value: unknown }) => {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value, null, 2);
  };

  const formatFieldCopyValue = ({ value }: { value: unknown }) => {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    return JSON.stringify(value, null, 2) ?? String(value);
  };

  const buildAuditModalField = ({
    entry,
    key,
    label
  }: {
    entry: AuditEntry;
    key: keyof AuditEntry;
    label: string;
  }): AuditModalField => {
    const value = entry[key];

    return {
      key,
      label,
      displayValue: formatFieldDisplayValue({ value }),
      copyValue: formatFieldCopyValue({ value })
    };
  };

  const copyText = async ({ value }: { value: string }) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();

    const copied = document.execCommand('copy');
    textArea.remove();

    if (!copied) throw new Error('Clipboard copy failed.');
  };

  const setCopyFeedback = ({ message }: { message: string }) => {
    copyFeedback = message;
    if (copyResetTimer !== null) window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(() => {
      copyFeedback = '';
      copyResetTimer = null;
    }, 1500);
  };

  const copySelectedEntryJson = async () => {
    if (!selectedAuditEntry) return;
    await copyText({ value: JSON.stringify(selectedAuditEntry, null, 2) });
    setCopyFeedback({ message: 'Entry JSON copied.' });
  };

  const copyAuditField = async ({ field }: { field: AuditModalField }) => {
    await copyText({ value: field.copyValue });
    setCopyFeedback({ message: `${field.label} copied.` });
  };

  const closeAuditModal = () => {
    selectedAuditEntry = null;
    copyFeedback = '';
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
      <table class="audit-table">
        <colgroup>
          <col class="audit-col-time" />
          <col class="audit-col-actor" />
          <col class="audit-col-auth" />
          <col class="audit-col-ip" />
          <col class="audit-col-action" />
          <col class="audit-col-target" />
          <col class="audit-col-result" />
          <col class="audit-col-correlation" />
          <col class="audit-col-details" />
        </colgroup>
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
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {#if data.entries.length}
            {#each data.entries as entry}
              <tr>
                <td><span class="audit-cell-preview" title={entry.timestamp}>{entry.timestamp}</span></td>
                <td><span class="audit-cell-preview" title={entry.actorUsername ?? 'System'}>{entry.actorUsername ?? 'System'}</span></td>
                <td><span class="audit-cell-preview" title={entry.authMode ? formatDisplayCode(entry.authMode) : 'N/A'}>{entry.authMode ? formatDisplayCode(entry.authMode) : 'N/A'}</span></td>
                <td><span class="audit-cell-preview" title={entry.sourceIp ?? 'N/A'}>{entry.sourceIp ?? 'N/A'}</span></td>
                <td><span class="audit-cell-preview" title={entry.action}>{entry.action}</span></td>
                <td><span class="audit-cell-preview" title={formatTarget({ entry })}>{formatTarget({ entry })}</span></td>
                <td class={entry.success ? 'tone-mid' : 'tone-danger'}>{entry.success ? 'Success' : 'Failed'}</td>
                <td class="subtle"><span class="audit-cell-preview" title={entry.correlationId}>{entry.correlationId}</span></td>
                <td>
                  <button class="button-mid audit-expand-button" type="button" on:click={() => selectedAuditEntry = entry}>
                    Expand
                  </button>
                </td>
              </tr>
            {/each}
          {:else}
            <tr>
              <td colspan="9" class="muted audit-empty-cell">No audit entries recorded yet.</td>
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

{#if selectedAuditEntry}
  <div class="audit-modal-backdrop" role="presentation">
    <div class="panel stack audit-modal" role="dialog" aria-modal="true" aria-labelledby="audit-modal-title" tabindex="-1">
      <div class="audit-modal-header">
        <div>
          <h2 id="audit-modal-title">Audit Entry</h2>
          <p class="muted">{selectedAuditEntry.timestamp} - {selectedAuditEntry.action}</p>
        </div>
        <div class="audit-modal-actions">
          <button class="button-warning" type="button" on:click={copySelectedEntryJson}>Copy JSON</button>
          <button class="button-mid" type="button" on:click={closeAuditModal}>Close</button>
        </div>
      </div>

      <div class="audit-modal-feedback">
        {#if copyFeedback}
          <div class="badge tone-mid">{copyFeedback}</div>
        {/if}
      </div>

      <div class="audit-modal-body">
        <div class="audit-modal-feature-grid">
          {#each modalPrimaryRows as row}
            <div
              class:audit-modal-feature-row-single={row.length === 1}
              class:audit-modal-feature-row-three={row.length === 3}
              class="audit-modal-feature-row"
            >
              {#each row as field (field.key)}
                <section class="audit-modal-field">
                  <div class="audit-modal-field-header">
                    <strong>{field.label}</strong>
                    <button class="button-ghost audit-copy-field-button" type="button" on:click={() => copyAuditField({ field })}>Copy</button>
                  </div>
                  <pre>{field.displayValue}</pre>
                </section>
              {/each}
            </div>
          {/each}
        </div>

        <div class="audit-modal-field-list">
          {#each modalFields as field (field.key)}
            <section class="audit-modal-field">
              <div class="audit-modal-field-header">
                <strong>{field.label}</strong>
                <button class="button-ghost audit-copy-field-button" type="button" on:click={() => copyAuditField({ field })}>Copy</button>
              </div>
              <pre>{field.displayValue}</pre>
            </section>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

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

  .audit-table {
    min-width: 86rem;
    table-layout: fixed;
  }

  .audit-col-time {
    width: 14rem;
  }

  .audit-col-actor {
    width: 11rem;
  }

  .audit-col-auth {
    width: 8rem;
  }

  .audit-col-ip {
    width: 11rem;
  }

  .audit-col-action {
    width: 11rem;
  }

  .audit-col-target {
    width: 18rem;
  }

  .audit-col-result {
    width: 7rem;
  }

  .audit-col-correlation {
    width: 18rem;
  }

  .audit-col-details {
    width: 7rem;
  }

  .audit-cell-preview {
    display: block;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  button.audit-expand-button.button-mid,
  button.audit-copy-field-button.button-ghost,
  .audit-expand-button,
  .audit-copy-field-button {
    min-height: 2rem;
    padding: 0.38rem 0.7rem 0.32rem;
    border-bottom-width: 0.16rem;
    border-radius: var(--radius-sm);
    font-size: 0.76rem;
    letter-spacing: 0;
    line-height: 1;
  }

  .audit-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: color-mix(in srgb, var(--color-bg) 58%, transparent);
    backdrop-filter: blur(4px);
  }

  .audit-modal {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    width: min(74rem, 100%);
    max-height: min(90vh, 58rem);
    overflow: hidden;
  }

  .audit-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .audit-modal-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .audit-modal-feedback {
    min-height: 0;
  }

  .audit-modal-body {
    display: grid;
    gap: var(--space-2);
    min-height: 0;
    overflow: auto;
  }

  .audit-modal-feature-grid,
  .audit-modal-field-list {
    display: grid;
    gap: var(--space-2);
  }

  .audit-modal-feature-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .audit-modal-feature-row-single {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-modal-feature-row-three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .audit-modal-field {
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
  }

  .audit-modal-field-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }

  .audit-modal-field pre {
    margin: 0;
    padding: var(--space-3);
    overflow: visible;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-pre-text);
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

  @media (max-width: 720px) {
    .audit-modal-feature-row {
      grid-template-columns: minmax(0, 1fr);
    }

    .audit-modal-feature-row-three {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
