<script lang="ts">
  import { onMount } from 'svelte';
  import { apiRequest, buildApiUrl } from '$lib/stores/api';
  import type { BrokerAgentRuntimeInfo, ManagedBrokerKeyFileId, ManagedBrokerKeyFileStatus } from '$lib/types';

  export let data: {
    canManageBroker: boolean;
    configText: string;
    loadError: string | null;
    apiBasePath: string;
  };

  let configText = data.configText;
  let lastPulledConfig: string | null = data.canManageBroker && !data.loadError ? data.configText : null;
  let message = '';
  let error = data.canManageBroker ? data.loadError ?? '' : '';
  let keyFiles: ManagedBrokerKeyFileStatus[] = [];
  let keyFilesLoading = false;
  let keyFilesError = '';
  let brokerAgentRuntimeInfo: BrokerAgentRuntimeInfo | null = null;

  const keyFileLabels: Record<ManagedBrokerKeyFileId, string> = {
    caFile: 'CA File',
    mosquittoPublicKey: 'Mosquitto Public Key',
    brokerPublicKey: 'Broker Public Key'
  };

  const unwrapApiData = <T,>(payload: T | { data: T }): T =>
    payload && typeof payload === 'object' && 'data' in payload
      ? payload.data
      : payload;

  const runtimeValue = ({ value }: { value: string | null }) => value ?? 'Unavailable';

  const keyFileStatusTone = ({ configured, exists }: ManagedBrokerKeyFileStatus) => {
    if (!configured) return '';
    return exists ? 'tone-mid' : 'tone-danger';
  };

  const keyFileStatusLabel = ({ configured, exists }: ManagedBrokerKeyFileStatus) => {
    if (!configured) return 'Not Configured';
    return exists ? 'Available' : 'Missing';
  };

  const refreshKeyFiles = async () => {
    keyFilesLoading = true;
    keyFilesError = '';

    try {
      const result = unwrapApiData(await apiRequest<{
        data: {
          files: ManagedBrokerKeyFileStatus[];
          brokerAgentRuntimeInfo: BrokerAgentRuntimeInfo | null;
        };
      } | {
        files: ManagedBrokerKeyFileStatus[];
        brokerAgentRuntimeInfo: BrokerAgentRuntimeInfo | null;
      }>({
        url: '/api/config/key-files',
        method: 'GET'
      }));
      keyFiles = result.files;
      brokerAgentRuntimeInfo = result.brokerAgentRuntimeInfo;
    } catch (caught) {
      keyFilesError = caught instanceof Error ? caught.message : 'Failed loading managed key files.';
    } finally {
      keyFilesLoading = false;
    }
  };

  const pullConfig = async () => {
    message = '';
    error = '';

    try {
      const result = unwrapApiData(await apiRequest<{ data: { current: string } } | { current: string }>({
        url: '/api/config/pull',
        method: 'GET'
      }));
      configText = result.current;
      lastPulledConfig = result.current;
      message = 'Broker config pulled.';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed pulling broker config.';
    }
  };

  const pushConfig = async () => {
    message = '';
    error = '';

    if (lastPulledConfig === null) {
      error = 'Pull the latest broker config before pushing changes.';
      return;
    }

    try {
      const result = unwrapApiData(await apiRequest<{ data: { result: { current: string } } } | { result: { current: string } }>({
        url: '/api/config/push',
        method: 'POST',
        body: { rendered: configText, expectedCurrent: lastPulledConfig }
      }));
      configText = result.result.current;
      lastPulledConfig = result.result.current;
      message = 'Broker config pushed.';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed pushing broker config.';
    }
  };

  const reloadBroker = async () => {
    message = '';
    error = '';

    try {
      await apiRequest({
        url: '/api/config/reload',
        method: 'POST'
      });
      message = 'Broker reload requested.';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed reloading broker.';
    }
  };

  const restartBroker = async () => {
    message = '';
    error = '';

    try {
      await apiRequest({
        url: '/api/config/restart',
        method: 'POST'
      });
      message = 'Broker restart requested.';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed restarting broker.';
    }
  };

  onMount(async () => {
    await refreshKeyFiles();
  });
</script>

<section class="stack config-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">MQTT Config</h1>
      <p class="muted">
        {#if data.canManageBroker}
          Load the current Mosquitto config, edit it directly, manage broker reloads, and download configured CA or public key files.
        {:else}
          Download configured CA and public key files. Raw broker config access requires broker management permission.
        {/if}
      </p>
    </div>
  </div>

  {#if message}
    <div class="badge tone-mid">{message}</div>
  {/if}
  {#if error}
    <div class="badge tone-danger">{error}</div>
  {/if}

  {#if data.canManageBroker}
    <article class="panel stack">
      <div class="config-section-header">
        <div>
          <h2>Config File</h2>
          <p class="muted">Edit the raw Mosquitto config text. Pushes are conflict-checked against the last pull.</p>
        </div>
      </div>
      <textarea bind:value={configText} rows="26" spellcheck="false"></textarea>
      <div class="config-actions">
        <div class="form-actions">
          <button class="button-mid" type="button" on:click={pullConfig}>Pull Config</button>
          <button class="button-start" type="button" on:click={pushConfig}>Push Config</button>
        </div>
        <div class="form-actions config-actions-right">
          <button class="button-mid" type="button" on:click={reloadBroker}>Reload Broker</button>
          <button class="button-warning" type="button" on:click={restartBroker}>Restart Broker</button>
        </div>
      </div>
    </article>
  {:else}
    <article class="panel stack">
      <div class="badge tone-warning">Broker config access is limited to broker-management roles.</div>
      <p class="muted">This account can still inspect managed CA and public key availability and download configured public artifacts below.</p>
    </article>
  {/if}

  <article class="panel stack">
    <div class="config-section-header">
      <div>
        <h2>Key Management</h2>
        <p class="muted">This page only exposes the configured CA and public key files. Private keys remain broker-local and are never downloadable.</p>
      </div>
      <button class="button-mid" type="button" on:click={refreshKeyFiles} disabled={keyFilesLoading}>
        {keyFilesLoading ? 'Refreshing…' : 'Refresh Files'}
      </button>
    </div>

    {#if keyFilesError}
      <div class="badge tone-danger">{keyFilesError}</div>
    {/if}

    <div class="key-file-grid">
      {#each keyFiles as file}
        <section class="key-file-card stack-tight">
          <div class="key-file-card-header">
            <strong>{keyFileLabels[file.fileId]}</strong>
            <div class={`badge ${keyFileStatusTone(file)}`}>{keyFileStatusLabel(file)}</div>
          </div>

          <div class="muted key-file-path">{file.path ?? 'Not configured in broker.keyFiles.'}</div>

          {#if file.configured && file.exists}
            <div class="form-actions">
              <a class="button-start" href={buildApiUrl({ apiBasePath: data.apiBasePath, url: `/api/config/key-files/${file.fileId}` })}>Download {file.fileName ?? keyFileLabels[file.fileId]}</a>
            </div>
          {/if}
        </section>
      {/each}
    </div>

    {#if !keyFiles.length && !keyFilesLoading && !keyFilesError}
      <div class="muted">No managed key files were reported by the broker yet.</div>
    {/if}
  </article>

  <article class="panel stack">
    <div class="config-section-header">
      <div>
        <h2>Broker Agent Runtime</h2>
        <p class="muted">Runtime metadata reported by the configured broker-agent.</p>
      </div>
    </div>

    <div class="runtime-info-grid">
      <section class="runtime-info-item stack-tight">
        <span class="runtime-info-label">Agent Version</span>
        <code>{runtimeValue({ value: brokerAgentRuntimeInfo?.brokerAgentVersion ?? null })}</code>
      </section>
      <section class="runtime-info-item stack-tight">
        <span class="runtime-info-label">Agent Build Hash</span>
        <code>{runtimeValue({ value: brokerAgentRuntimeInfo?.brokerAgentBuildHash ?? null })}</code>
      </section>
      <section class="runtime-info-item stack-tight">
        <span class="runtime-info-label">MQTT Server Version</span>
        <code>{runtimeValue({ value: brokerAgentRuntimeInfo?.mqttServerVersion ?? null })}</code>
      </section>
    </div>
  </article>
</section>

<style>
  .config-page {
    gap: 1.5rem;
  }

  .config-section-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .config-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .config-actions-right {
    justify-content: flex-end;
  }

  .key-file-grid {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
  }

  .key-file-card {
    padding: var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    box-shadow: inset 0 0 0 1px var(--color-tone-glint);
  }

  .key-file-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
  }

  .key-file-path {
    word-break: break-word;
  }

  .runtime-info-grid {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }

  .runtime-info-item {
    padding: var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
  }

  .runtime-info-label {
    color: var(--color-text-muted);
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .runtime-info-item code {
    white-space: normal;
    word-break: break-word;
  }
</style>
