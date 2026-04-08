<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { SnapshotExport } from '$lib/types';
  import { apiRequest } from '$lib/stores/api';
  import { formatDisplayCode } from '$lib/strings/display';

  export let data: {
    snapshots: Array<{
      id: string;
      kind: string;
      createdAt: string;
      actorUsername: string | null;
      note: string | null;
    }>;
  };

  let kind = 'combined';
  let note = '';
  let snapshotJson = '';
  let snapshotDownloadUrl = '';
  let snapshotDownloadFilename = '';
  let importJson = '';
  let message = '';
  let error = '';

  const clearSnapshotDownload = () => {
    if (snapshotDownloadUrl) {
      URL.revokeObjectURL(snapshotDownloadUrl);
    }

    snapshotDownloadUrl = '';
    snapshotDownloadFilename = '';
  };

  const toSnapshotDownloadKind = ({ kind }: { kind: SnapshotExport['snapshot']['kind'] }) =>
    kind === 'broker-config' ? 'broker_config' : kind;

  const toSnapshotExportDate = ({ exportTime }: { exportTime: string }) => {
    const parsedTime = new Date(exportTime);
    if (!Number.isNaN(parsedTime.getTime())) {
      return parsedTime.toISOString().slice(0, 10);
    }

    return /^\d{4}-\d{2}-\d{2}/.test(exportTime) ? exportTime.slice(0, 10) : 'unknown-date';
  };

  const buildSnapshotDownloadFilename = ({ snapshot }: { snapshot: SnapshotExport }) =>
    `mqttctl-snapshot-${toSnapshotDownloadKind({ kind: snapshot.snapshot.kind })}-${toSnapshotExportDate({ exportTime: snapshot.exportTime })}.json`;

  onDestroy(() => {
    clearSnapshotDownload();
  });

  const exportSnapshot = async () => {
    error = '';
    message = '';
    clearSnapshotDownload();

    try {
      const result = await apiRequest<{ snapshot: SnapshotExport }>({
        url: '/api/snapshots/export',
        method: 'POST',
        body: {
          kind,
          note: note || null
        }
      });
      const exportedJson = JSON.stringify(result.snapshot, null, 2);
      snapshotJson = exportedJson;
      snapshotDownloadUrl = URL.createObjectURL(new Blob([exportedJson], { type: 'application/json' }));
      snapshotDownloadFilename = buildSnapshotDownloadFilename({ snapshot: result.snapshot });
      message = 'Snapshot exported.';
      await invalidateAll();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Snapshot export failed.';
    }
  };

  const previewImport = async () => {
    error = '';
    message = '';

    try {
      const payload = JSON.parse(importJson);
      const result = await apiRequest<{ result: unknown }>({
        url: '/api/snapshots/import',
        method: 'POST',
        body: {
          payload,
          apply: false
        }
      });
      message = JSON.stringify(result.result);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Snapshot preview failed.';
    }
  };

  const applyImport = async () => {
    error = '';
    message = '';

    try {
      const payload = JSON.parse(importJson);
      const result = await apiRequest<{ result: unknown }>({
        url: '/api/snapshots/import',
        method: 'POST',
        body: {
          payload,
          apply: true
        }
      });
      message = JSON.stringify(result.result);
      await invalidateAll();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Snapshot import failed.';
    }
  };
</script>

<section class="stack">
  <div class="page-header">
    <div>
      <h1 class="page-title">Snapshots <sup class="page-title-beta">Beta</sup></h1>
      <p class="muted">Readable JSON exports for dynsec state, broker config, or combined control-plane state.</p>
    </div>
  </div>

  {#if message}
    <div class="badge tone-mid">{message}</div>
  {/if}
  {#if error}
    <div class="badge tone-danger">{error}</div>
  {/if}

  <div class="panel-grid">
    <article class="panel stack">
      <h2>Export</h2>
      <label class="stack-tight">
        <span class="muted">Kind</span>
        <select bind:value={kind}>
          <option value="dynsec">{formatDisplayCode('dynsec')}</option>
          <option value="broker-config">{formatDisplayCode('broker-config')}</option>
          <option value="combined">{formatDisplayCode('combined')}</option>
        </select>
      </label>
      <label class="stack-tight">
        <span class="muted">Note</span>
        <input bind:value={note} />
      </label>
      <div class="form-actions snapshot-export-actions">
        <button class="button-start" type="button" on:click={exportSnapshot}>Export Snapshot</button>
        {#if snapshotDownloadUrl && snapshotDownloadFilename}
          <a class="button-mid" href={snapshotDownloadUrl} download={snapshotDownloadFilename}>Download JSON</a>
        {/if}
      </div>
      <textarea rows="16" readonly value={snapshotJson}></textarea>
    </article>

    <article class="panel stack">
      <h2>Import</h2>
      <textarea bind:value={importJson} rows="16" placeholder="Paste Snapshot JSON"></textarea>
      <div class="form-actions snapshot-import-actions">
        <button class="button-mid" type="button" on:click={previewImport}>Preview Import</button>
        <button class="button-warning" type="button" on:click={applyImport}>Apply Import</button>
      </div>
    </article>
  </div>

  <article class="panel">
    <h2>History</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Kind</th>
            <th>Created</th>
            <th>Actor</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {#each data.snapshots as snapshot}
            <tr>
              <td class="subtle">{snapshot.id}</td>
              <td>{formatDisplayCode(snapshot.kind)}</td>
              <td>{snapshot.createdAt}</td>
              <td>{snapshot.actorUsername ?? 'System'}</td>
              <td>{snapshot.note ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </article>
</section>

<style>
  .page-title-beta {
    font-size: 0.48em;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .snapshot-export-actions,
  .snapshot-import-actions {
    align-items: flex-start;
  }

  .snapshot-export-actions > :global(a),
  .snapshot-export-actions > button,
  .snapshot-import-actions > button {
    min-height: 2.35rem;
    padding: 0.55rem 0.9rem;
  }
</style>
