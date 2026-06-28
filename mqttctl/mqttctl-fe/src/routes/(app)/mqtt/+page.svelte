<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { apiRequest, buildApiUrl } from '$lib/stores/api';
  import { capitalizeLabel } from '$lib/strings/display';
  import type {
    MqttExplorerState,
    MqttLatestMessage,
    MqttQos
  } from '$lib/types';

  type CredentialMode = 'dynsec_client' | 'custom';
  type LatestTopicsLimitValue = '5' | '10' | '20' | '25' | '100' | 'all';

  interface DynsecClientOption {
    username: string;
    clientId: string | null;
    clientIdIsRandom: boolean;
    textName: string | null;
    disabled: boolean;
  }

  interface DynsecSubscriptionAccess {
    filter: string;
    acltype: 'subscribeLiteral' | 'subscribePattern';
    priority: number;
  }

  interface DynsecMqttAccess {
    subscribeFilters: DynsecSubscriptionAccess[];
    warnings: string[];
  }

  interface ConnectFormState {
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password: string;
    clientId: string;
  }

  interface MessageModalState {
    title: string;
    description: string;
    value: string;
    copyLabel: string;
  }

  export let data: {
    explorer: MqttExplorerState;
    dynsecClients: DynsecClientOption[];
    dynsecMqttAccess: Record<string, DynsecMqttAccess>;
    generatedClientId: string;
    canUseDynsec: boolean;
    selectedDynsecUsername: string | null;
    publishPanelOpen: boolean;
    latestTopicsOpen: boolean;
  };

  const emptyDynsecMqttAccess: DynsecMqttAccess = {
    subscribeFilters: [],
    warnings: []
  };

  const publishDraftStorageKey = 'mqttctl.mqtt.publish-draft';
  const qosOptions = [
    { value: 0 as MqttQos, label: '0 - Fire and forget' },
    { value: 1 as MqttQos, label: '1 - Deliver at least once' },
    { value: 2 as MqttQos, label: '2 - Deliver exactly once' }
  ];
  const latestTopicsLimitOptions: { value: LatestTopicsLimitValue; label: string }[] = [
    { value: '5', label: '5' },
    { value: '10', label: '10' },
    { value: '20', label: '20' },
    { value: '25', label: '25' },
    { value: '100', label: '100' },
    { value: 'all', label: 'All' }
  ];

  const stateTone = ({ state }: { state: MqttExplorerState['connection']['state'] }) => {
    if (state === 'connected') return 'tone-mid';
    if (state === 'connecting') return 'tone-warning';
    if (state === 'error') return 'tone-danger';
    return '';
  };

  const formatPayload = ({ message }: { message: MqttLatestMessage | null }) => {
    if (!message) return '';
    if (message.payloadFormat !== 'json') return message.payload;

    try {
      return JSON.stringify(JSON.parse(message.payload), null, 2);
    } catch {
      return message.payload;
    }
  };

  const normalizeStoredQos = ({
    value,
    fallback
  }: {
    value: unknown;
    fallback: MqttQos;
  }): MqttQos => {
    if (value === 0 || value === 1 || value === 2) return value;
    return fallback;
  };

  const resolveInitialDynsecUsername = () => {
    if (
      data.selectedDynsecUsername
      && data.dynsecClients.some((client) => client.username === data.selectedDynsecUsername)
    ) {
      return data.selectedDynsecUsername;
    }

    return data.dynsecClients.find((client) => client.username === explorer.defaults.configuredUsername)?.username
      ?? data.dynsecClients[0]?.username
      ?? null;
  };

  const createConnectForm = ({ explorer }: { explorer: MqttExplorerState }): ConnectFormState => ({
    host: explorer.defaults.host,
    port: explorer.defaults.port,
    tls: explorer.defaults.tls,
    username: '',
    password: '',
    clientId: data.generatedClientId
  });

  let explorer = data.explorer;
  let connectForm = createConnectForm({ explorer });
  let credentialMode: CredentialMode = data.canUseDynsec && data.dynsecClients.length ? 'dynsec_client' : 'custom';
  let selectedDynsecUsername = resolveInitialDynsecUsername();
  let subscriptionFilter = '';
  let subscriptionQos: MqttQos = 0;
  let publishTopic = '';
  let publishPayload = '';
  let publishQos: MqttQos = 0;
  let publishRetain = false;
  let publishPanelOpen = data.publishPanelOpen;
  let latestTopicsOpen = data.latestTopicsOpen;
  let selectedTopic = explorer.messages[0]?.topic ?? null;
  let busyAction: 'connect' | 'disconnect' | 'subscribe' | 'unsubscribe' | 'publish' | 'clear_latest_topics' | 'set_latest_topics_limit' | null = null;
  let actionError = '';
  let actionMessage = '';
  let eventSource: EventSource | null = null;
  let browserReady = false;
  let messageModal: MessageModalState | null = null;
  let exitDisconnectSent = false;
  let browserResetInFlight = false;
  let isConnected = explorer.connection.state === 'connected' || explorer.connection.connected;
  let connectionLocked = false;
  let selectedDynsecClient: DynsecClientOption | null = null;
  let visibleDynsecClients: DynsecClientOption[] = data.dynsecClients;
  let selectedDynsecClientId = data.generatedClientId;
  let selectedDynsecClientIdIsRandom = false;
  let selectedDynsecUsesConfiguredAdminSecret = false;
  let selectedDynsecMqttAccess: DynsecMqttAccess = emptyDynsecMqttAccess;
  let selectedDynsecSubscriptionAccess: DynsecSubscriptionAccess[] = [];
  let selectedDynsecAccessWarnings: string[] = [];
  let customClientIdIsRandom = true;
  let currentClientIdIsRandom = false;
  let connectDisabled = false;
  let disconnectDisabled = true;
  let connectLabel = 'Connect';
  let disconnectLabel = 'Disconnected';
  let currentSelectedMessage: MqttLatestMessage | null = null;

  const formatClientId = ({
    clientId,
    isRandom
  }: {
    clientId: string;
    isRandom: boolean;
  }) => isRandom ? `${clientId} (random)` : clientId;

  const formatSubscriptionAclType = ({ acltype }: { acltype: DynsecSubscriptionAccess['acltype'] }) =>
    acltype === 'subscribePattern' ? 'Pattern' : 'Literal';

  const replaceSelectedClientInUrl = ({ username }: { username: string | null }) => {
    if (typeof window === 'undefined') return;

    const nextUrl = new URL(window.location.href);

    if (username === null) {
      nextUrl.searchParams.delete('client');
    } else {
      nextUrl.searchParams.set('client', username);
    }

    window.history.replaceState(window.history.state, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  };

  const replacePublishPanelInUrl = ({ open }: { open: boolean }) => {
    if (typeof window === 'undefined') return;

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('publish', open ? 'open' : 'closed');

    window.history.replaceState(window.history.state, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  };

  const replaceLatestTopicsInUrl = ({ open }: { open: boolean }) => {
    if (typeof window === 'undefined') return;

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('topics', open ? 'open' : 'closed');

    window.history.replaceState(window.history.state, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  };

  $: isConnected = explorer.connection.state === 'connected' || explorer.connection.connected;
  $: selectedDynsecClient = data.dynsecClients.find((client) => client.username === selectedDynsecUsername) ?? null;
  $: visibleDynsecClients = isConnected && selectedDynsecUsername
    ? data.dynsecClients.filter((client) => client.username === selectedDynsecUsername)
    : data.dynsecClients;
  $: selectedDynsecClientId = selectedDynsecClient?.clientId ?? data.generatedClientId;
  $: selectedDynsecClientIdIsRandom = selectedDynsecClient?.clientIdIsRandom ?? false;
  $: selectedDynsecUsesConfiguredAdminSecret = selectedDynsecClient?.username === explorer.defaults.configuredUsername;
  $: selectedDynsecMqttAccess = selectedDynsecClient
    ? data.dynsecMqttAccess[selectedDynsecClient.username] ?? emptyDynsecMqttAccess
    : emptyDynsecMqttAccess;
  $: selectedDynsecSubscriptionAccess = selectedDynsecMqttAccess.subscribeFilters;
  $: selectedDynsecAccessWarnings = selectedDynsecMqttAccess.warnings;
  $: customClientIdIsRandom = connectForm.clientId === data.generatedClientId;
  $: currentClientIdIsRandom = credentialMode === 'dynsec_client'
    ? selectedDynsecClientIdIsRandom
    : customClientIdIsRandom;
  $: connectionLocked =
    isConnected
    || explorer.connection.state === 'connecting'
    || busyAction === 'connect'
    || busyAction === 'disconnect';
  $: connectDisabled = busyAction !== null || isConnected || explorer.connection.state === 'connecting';
  $: disconnectDisabled = busyAction !== null || !isConnected;
  $: connectLabel = busyAction === 'connect' || explorer.connection.state === 'connecting'
    ? 'Connecting...'
    : isConnected
      ? 'Connected'
      : 'Connect';
  $: disconnectLabel = busyAction === 'disconnect'
    ? 'Disconnecting...'
    : !isConnected
      ? 'Disconnected'
      : 'Disconnect';
  $: currentSelectedMessage = explorer.messages.find((entry) => entry.topic === selectedTopic) ?? null;

  $: if (browserReady) {
    localStorage.setItem(publishDraftStorageKey, JSON.stringify({
      topic: publishTopic,
      payload: publishPayload,
      qos: publishQos,
      retain: publishRetain
    }));
  }

  const applyExplorer = ({ next }: { next: MqttExplorerState }) => {
    if (next.revision < explorer.revision) return;

    explorer = next;

    if (
      selectedTopic
      && !explorer.messages.some((entry) => entry.topic === selectedTopic)
    ) {
      selectedTopic = null;
    }

    if (!isConnected) {
      messageModal = null;
    }
  };

  const selectTopic = ({ topic }: { topic: string }) => {
    const previous = selectedTopic;
    selectedTopic = topic;

    if (
      publishTopic.trim() === ''
      || publishTopic === previous
    ) {
      publishTopic = topic;
    }
  };

  const deselectTopic = () => {
    selectedTopic = null;
    messageModal = null;
  };

  const openMessageModal = ({
    message,
    title,
    description,
    value,
    copyLabel
  }: {
    message: MqttLatestMessage;
    title: string;
    description: string;
    value: string;
    copyLabel: string;
  }) => {
    selectTopic({ topic: message.topic });
    messageModal = {
      title,
      description,
      value,
      copyLabel
    };
  };

  const closeMessageModal = () => {
    messageModal = null;
  };

  const copyToClipboard = async ({
    value,
    successMessage
  }: {
    value: string;
    successMessage: string;
  }) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      actionError = 'Clipboard access is unavailable in this browser.';
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      actionError = '';
      actionMessage = successMessage;
    } catch {
      actionError = 'Failed copying to the clipboard.';
    }
  };

  const chooseCredentialMode = ({ mode }: { mode: CredentialMode }) => {
    credentialMode = mode;
    connectForm.password = '';

    if (mode === 'custom') {
      connectForm.username = selectedDynsecClient?.username ?? '';
      connectForm.clientId = selectedDynsecClientId;
    }
  };

  const chooseDynsecClient = ({ username }: { username: string }) => {
    selectedDynsecUsername = username;
    connectForm.password = '';
    replaceSelectedClientInUrl({ username });
  };

  const resetDefaults = () => {
    connectForm = createConnectForm({ explorer });
    credentialMode = data.canUseDynsec && data.dynsecClients.length ? 'dynsec_client' : 'custom';
    selectedDynsecUsername = resolveInitialDynsecUsername();
    actionError = '';
    actionMessage = 'Connection defaults restored.';
    replaceSelectedClientInUrl({ username: selectedDynsecUsername });
  };

  const togglePublishPanel = () => {
    publishPanelOpen = !publishPanelOpen;
    replacePublishPanelInUrl({ open: publishPanelOpen });
  };

  const toggleLatestTopicsPanel = () => {
    latestTopicsOpen = !latestTopicsOpen;
    replaceLatestTopicsInUrl({ open: latestTopicsOpen });
  };

  const normalizeLatestTopicsLimit = ({ value }: { value: string }): number | null => {
    if (value === 'all') return null;

    const parsed = Number.parseInt(value, 10);
    if ([5, 10, 20, 25, 100].includes(parsed)) {
      return parsed;
    }

    return explorer.stats.trackedTopicsLimit;
  };

  const latestTopicsLimitValue = () => explorer.stats.trackedTopicsLimit === null
    ? 'all'
    : `${explorer.stats.trackedTopicsLimit}` as LatestTopicsLimitValue;

  const runRequest = async ({
    action,
    request
  }: {
    action: NonNullable<typeof busyAction>;
    request: () => Promise<{ ok: true; explorer: MqttExplorerState }>;
  }) => {
    busyAction = action;
    actionError = '';

    try {
      const response = await request();
      applyExplorer({ next: response.explorer });
      return response;
    } catch (caught) {
      actionError = caught instanceof Error ? caught.message : 'Request failed.';
      throw caught;
    } finally {
      busyAction = null;
    }
  };

  const connectToBroker = async () => {
    if (
      credentialMode === 'dynsec_client'
      && !selectedDynsecUsername
    ) {
      actionError = 'Choose a dynsec client before connecting.';
      return;
    }

    const payload = credentialMode === 'dynsec_client'
      ? {
          host: connectForm.host,
          port: connectForm.port,
          tls: connectForm.tls,
          authMode: 'dynsec_client' as const,
          username: selectedDynsecClient?.username?.trim() ?? '',
          password: connectForm.password.trim() || undefined,
          clientId: selectedDynsecClientId.trim() || data.generatedClientId
        }
      : {
          host: connectForm.host,
          port: connectForm.port,
          tls: connectForm.tls,
          authMode: 'custom' as const,
          username: connectForm.username.trim(),
          password: connectForm.password,
          clientId: connectForm.clientId.trim()
        };

    await runRequest({
      action: 'connect',
      request: async () => await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/connect',
        method: 'POST',
        body: payload
      })
    });

    connectForm.password = '';

    if (!eventSource) {
      openLiveStream();
    }

    actionMessage = 'MQTT connection established.';
  };

  const disconnectFromBroker = async () => {
    await runRequest({
      action: 'disconnect',
      request: async () => await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/disconnect',
        method: 'POST',
        body: {}
      })
    });

    actionMessage = 'MQTT connection closed.';
  };

  const addSubscription = async ({ filter }: { filter?: string } = {}) => {
    const nextFilter = (filter ?? subscriptionFilter).trim();
    if (!nextFilter) {
      actionError = 'A topic filter is required.';
      return;
    }

    await runRequest({
      action: 'subscribe',
      request: async () => await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/subscribe',
        method: 'POST',
        body: {
          filter: nextFilter,
          qos: subscriptionQos
        }
      })
    });

    subscriptionFilter = nextFilter;
    actionMessage = `Subscribed to ${nextFilter}.`;
  };

  const removeSubscription = async ({ filter }: { filter: string }) => {
    await runRequest({
      action: 'unsubscribe',
      request: async () => await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/unsubscribe',
        method: 'POST',
        body: { filter }
      })
    });

    actionMessage = `Unsubscribed from ${filter}.`;
  };

  const publishMessage = async () => {
    if (!publishTopic.trim()) {
      actionError = 'A publish topic is required.';
      return;
    }

    await runRequest({
      action: 'publish',
      request: async () => await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/publish',
        method: 'POST',
        body: {
          topic: publishTopic.trim(),
          payload: publishPayload,
          qos: publishQos,
          retain: publishRetain
        }
      })
    });

    actionMessage = `Published to ${publishTopic.trim()}.`;
  };

  const clearLatestTopics = async () => {
    await runRequest({
      action: 'clear_latest_topics',
      request: async () => await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/messages',
        method: 'POST',
        body: {
          action: 'clear'
        }
      })
    });

    actionMessage = 'Latest topics cleared.';
  };

  const updateLatestTopicsLimit = async ({
    value
  }: {
    value: string;
  }) => {
    const nextLimit = normalizeLatestTopicsLimit({ value });

    await runRequest({
      action: 'set_latest_topics_limit',
      request: async () => await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/messages',
        method: 'POST',
        body: {
          action: 'set_limit',
          limit: nextLimit
        }
      })
    });

    actionMessage = nextLimit === null
      ? 'Latest topics limit set to all.'
      : `Latest topics limit set to ${nextLimit}. Oldest topics were removed when needed.`;
  };

  const refreshExplorerState = async () => {
    const response = await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
      url: '/api/mqtt/state'
    });
    applyExplorer({ next: response.explorer });
  };

  const disconnectBrowserSession = async () => {
    if (browserResetInFlight) return;

    browserResetInFlight = true;
    eventSource?.close();
    eventSource = null;

    try {
      const response = await apiRequest<{ ok: true; explorer: MqttExplorerState }>({
        url: '/api/mqtt/disconnect',
        method: 'POST',
        body: {}
      });

      applyExplorer({ next: response.explorer });
      actionError = '';
      actionMessage = 'Browser live channel dropped. MQTT session was disconnected.';
    } catch (caught) {
      actionError = caught instanceof Error ? caught.message : 'Browser live channel dropped.';
      actionMessage = 'Browser live channel dropped. The page state was reset.';
    } finally {
      browserResetInFlight = false;
    }
  };

  const disconnectOnPageExit = () => {
    if (typeof window === 'undefined' || !browserReady) return;
    if (exitDisconnectSent) return;
    if (
      !isConnected
      && explorer.connection.state !== 'connecting'
    ) {
      return;
    }

    exitDisconnectSent = true;
    eventSource?.close();
    eventSource = null;

    void fetch(buildApiUrl({ url: '/api/mqtt/disconnect' }), {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: {
        'content-type': 'application/json'
      },
      body: '{}'
    }).catch(() => {
      // Ignore unload disconnect failures.
    });
  };

  const openLiveStream = () => {
    eventSource?.close();
    eventSource = new EventSource(buildApiUrl({ url: '/api/mqtt/events' }));

    eventSource.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { explorer: MqttExplorerState };
      applyExplorer({ next: payload.explorer });
    };

    eventSource.onerror = () => {
      if (
        exitDisconnectSent
        || browserResetInFlight
        || (
          !isConnected
          && explorer.connection.state !== 'connecting'
        )
      ) {
        return;
      }

      void disconnectBrowserSession().catch((caught) => {
        actionError = caught instanceof Error ? caught.message : 'Browser live channel dropped.';
        actionMessage = 'Browser live channel dropped. The page state was reset.';
      });
    };
  };

  onMount(() => {
    const handlePageHide = () => {
      disconnectOnPageExit();
    };

    try {
      const rawDraft = localStorage.getItem(publishDraftStorageKey);
      if (rawDraft) {
        const parsedDraft = JSON.parse(rawDraft) as {
          topic?: unknown;
          payload?: unknown;
          qos?: unknown;
          retain?: unknown;
        };

        if (typeof parsedDraft.topic === 'string') publishTopic = parsedDraft.topic;
        if (typeof parsedDraft.payload === 'string') publishPayload = parsedDraft.payload;
        publishQos = normalizeStoredQos({
          value: parsedDraft.qos,
          fallback: publishQos
        });
        publishRetain = parsedDraft.retain === true;
      }
    } catch {
      // Ignore invalid stored publish draft state.
    }

    browserReady = true;
    window.addEventListener('pagehide', handlePageHide);
    openLiveStream();
    void refreshExplorerState().catch((caught) => {
      actionError = caught instanceof Error ? caught.message : 'Failed to refresh MQTT explorer state.';
      actionMessage = '';
    });

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      eventSource?.close();
      eventSource = null;
    };
  });

  onDestroy(() => {
    disconnectOnPageExit();
  });
</script>

<section class="stack mqtt-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">MQTT</h1>
      <p class="muted">Broker-admin MQTT explorer with browser-scoped sessions, latest-topic snapshots, and direct publish controls.</p>
    </div>
    <div class="stack-tight mqtt-page-status">
      <div class="badge {stateTone({ state: explorer.connection.state })}">
        {isConnected
          ? 'Connected'
          : explorer.connection.state === 'connecting'
            ? 'Connecting'
            : explorer.connection.state === 'error'
              ? 'Connection Error'
              : 'Disconnected'}
      </div>
      {#if explorer.connection.host}
        <div class="subtle">{explorer.connection.host}:{explorer.connection.port}</div>
      {/if}
    </div>
  </div>

  {#if actionError}
    <article class="panel stack-tight mqtt-alert mqtt-alert-danger">
      <strong>Request Failed</strong>
      <div>{actionError}</div>
    </article>
  {/if}

  {#if actionMessage}
    <article class="panel stack-tight mqtt-alert mqtt-alert-info">
      <strong>Status</strong>
      <div>{actionMessage}</div>
    </article>
  {/if}

  <div class="stack mqtt-layout">
    <article class="panel stack mqtt-connection-panel">
      <div class="mqtt-panel-header">
        <div>
          <h2>Connection</h2>
          <p class="muted">Defaults come from the configured broker host and port.</p>
        </div>
        <button class="button-warning mqtt-disabled-button" disabled={connectionLocked || isConnected} type="button" on:click={resetDefaults}>Use Defaults</button>
      </div>

      <div class="form-grid">
        <label class="mqtt-field">
          <span>Host</span>
          <input bind:value={connectForm.host} disabled={connectionLocked} placeholder="broker.internal" />
        </label>

        <label class="mqtt-field">
          <span>Port</span>
          <input bind:value={connectForm.port} disabled={connectionLocked} min="1" max="65535" type="number" />
        </label>

        <label class="mqtt-field mqtt-checkbox-field">
          <span>TLS</span>
          <div class="mqtt-checkbox-row">
            <input bind:checked={connectForm.tls} disabled={connectionLocked} type="checkbox" />
            <small class="subtle">Encrypted transport</small>
          </div>
        </label>
      </div>

      {#if !isConnected}
        <div class="mqtt-auth-toggle">
          {#if data.canUseDynsec}
            <button
              class:button-mid={credentialMode === 'dynsec_client'}
              class:button-start={credentialMode !== 'dynsec_client'}
              disabled={connectionLocked || !data.dynsecClients.length}
              type="button"
              on:click={() => chooseCredentialMode({ mode: 'dynsec_client' })}
            >
              DynSec Client
            </button>
          {/if}
          <button
            class:button-mid={credentialMode === 'custom'}
            class:button-start={credentialMode !== 'custom'}
            disabled={connectionLocked}
            type="button"
            on:click={() => chooseCredentialMode({ mode: 'custom' })}
          >
            Custom Client
          </button>
        </div>
      {/if}

      {#if !data.canUseDynsec && !isConnected}
        <p class="muted">DynSec client presets are limited to broker admins and super admins. Custom MQTT credentials remain available.</p>
      {/if}

      {#if credentialMode === 'dynsec_client'}
        <div class="stack mqtt-client-picker">
          {#if !isConnected}
            <div class="table-wrap mqtt-client-table-wrap">
              <table class="mqtt-client-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Client ID</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {#if visibleDynsecClients.length}
                    {#each visibleDynsecClients as client}
                      <tr class:selected-row={client.username === selectedDynsecUsername}>
                        <td>
                          <div>{client.username}</div>
                          {#if client.textName}
                            <div class="subtle">{client.textName}</div>
                          {/if}
                        </td>
                        <td>{formatClientId({
                          clientId: client.clientId ?? data.generatedClientId,
                          isRandom: client.clientIdIsRandom
                        })}</td>
                        <td>{client.disabled ? 'Disabled' : 'Enabled'}</td>
                        <td class="mqtt-table-action">
                          <button
                            class:button-mid={client.username === selectedDynsecUsername}
                            class:button-start={client.username !== selectedDynsecUsername}
                            disabled={connectionLocked}
                            type="button"
                            on:click={() => chooseDynsecClient({ username: client.username })}
                          >
                            {client.username === selectedDynsecUsername ? 'Selected' : 'Use'}
                          </button>
                        </td>
                      </tr>
                    {/each}
                  {:else}
                    <tr>
                      <td colspan="4" class="muted">No dynsec clients are available.</td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          {/if}

          <div class="mqtt-identity-toolbar">
            <div class="mqtt-identity-card">
              <div class="mqtt-identity-row">
                <span class="mqtt-identity-label">Username</span>
                <span class="mqtt-identity-value">{selectedDynsecClient?.username || 'None Selected'}</span>
              </div>
              <div class="mqtt-identity-row">
                <span class="mqtt-identity-label">Client ID</span>
                <span class="mqtt-identity-value">{formatClientId({
                  clientId: selectedDynsecClientId,
                  isRandom: selectedDynsecClientIdIsRandom
                })}</span>
              </div>
            </div>

            <div class="form-actions mqtt-identity-actions">
              <button
                class="button-start mqtt-connection-action"
                class:mqtt-connection-action-live={!connectDisabled}
                disabled={connectDisabled}
                type="button"
                on:click={connectToBroker}
              >
                {connectLabel}
              </button>
              <button
                class="button-danger mqtt-connection-action"
                class:mqtt-connection-action-live={!disconnectDisabled}
                disabled={disconnectDisabled}
                type="button"
                on:click={disconnectFromBroker}
              >
                {disconnectLabel}
              </button>
            </div>
          </div>

          {#if selectedDynsecClient?.username && !selectedDynsecUsesConfiguredAdminSecret && !isConnected}
            <label class="mqtt-field">
              <span>Password</span>
              <input
                bind:value={connectForm.password}
                disabled={connectionLocked}
                type="password"
                placeholder="Enter this dynsec client's password if broker auth requires one"
              />
            </label>
          {/if}
        </div>
      {:else}
        <div class="form-grid">
          <label class="mqtt-field">
            <span>Username</span>
            <input bind:value={connectForm.username} disabled={connectionLocked} placeholder="mqtt-user" />
          </label>

          <label class="mqtt-field">
            <span>Password</span>
            <input
              bind:value={connectForm.password}
              disabled={connectionLocked}
              type="password"
              placeholder={isConnected ? 'Password is hidden while connected' : 'password'}
            />
          </label>

          <label class="mqtt-field">
            <span>Client ID</span>
            <input bind:value={connectForm.clientId} disabled={connectionLocked} placeholder="Randomized on page load" />
          </label>
        </div>

        <div class="mqtt-identity-toolbar">
          <div class="mqtt-identity-card">
            <div class="mqtt-identity-row">
              <span class="mqtt-identity-label">Username</span>
              <span class="mqtt-identity-value">{connectForm.username || 'Unset'}</span>
            </div>
            <div class="mqtt-identity-row">
              <span class="mqtt-identity-label">Client ID</span>
              <span class="mqtt-identity-value">{formatClientId({
                clientId: connectForm.clientId || data.generatedClientId,
                isRandom: customClientIdIsRandom
              })}</span>
            </div>
          </div>

          <div class="form-actions mqtt-identity-actions">
            <button
              class="button-start mqtt-connection-action"
              class:mqtt-connection-action-live={!connectDisabled}
              disabled={connectDisabled}
              type="button"
              on:click={connectToBroker}
            >
              {connectLabel}
            </button>
            <button
              class="button-danger mqtt-connection-action"
              class:mqtt-connection-action-live={!disconnectDisabled}
              disabled={disconnectDisabled}
              type="button"
              on:click={disconnectFromBroker}
            >
              {disconnectLabel}
            </button>
          </div>
        </div>
      {/if}
    </article>

    {#if isConnected}
      <article class="panel stack-tight mqtt-session-panel">
        <div class="mqtt-panel-header">
          <div>
            <h2>Session</h2>
            <p class="muted">Current API-managed browser session details.</p>
          </div>
          <div class="badge {stateTone({ state: explorer.connection.state })}">{capitalizeLabel(explorer.connection.state)}</div>
        </div>
        <div class="mqtt-session-grid">
          <div class="mqtt-session-item">
            <span class="mqtt-session-label">Auth</span>
            <span>{explorer.connection.authMode ?? 'none'}</span>
          </div>
          <div class="mqtt-session-item">
            <span class="mqtt-session-label">User</span>
            <span>{explorer.connection.username ?? 'n/a'}</span>
          </div>
          <div class="mqtt-session-item">
            <span class="mqtt-session-label">Client ID</span>
            <span>{explorer.connection.clientId
              ? formatClientId({
                  clientId: explorer.connection.clientId,
                  isRandom: currentClientIdIsRandom
                })
              : 'n/a'}</span>
          </div>
          <div class="mqtt-session-item">
            <span class="mqtt-session-label">Broker</span>
            <span>{explorer.connection.host}:{explorer.connection.port}</span>
          </div>
        </div>
        <div class="subtle">{explorer.connection.message ?? 'No active broker connection.'}</div>
      </article>

      <article class="panel stack mqtt-publish-panel">
        <button
          class="mqtt-section-toggle"
          type="button"
          aria-expanded={publishPanelOpen}
          on:click={togglePublishPanel}
        >
          <span>Publish</span>
          <span class="mqtt-section-toggle-indicator" aria-hidden="true">{publishPanelOpen ? '−' : '+'}</span>
        </button>

        {#if publishPanelOpen}
          <div class="stack">
            <div class="mqtt-panel-header">
              <div>
                <p class="muted">Send a message through the active API-managed MQTT session.</p>
              </div>
              {#if currentSelectedMessage}
                <button class="button-start" type="button" on:click={() => publishTopic = currentSelectedMessage?.topic ?? ''}>Use Selected Topic</button>
              {/if}
            </div>

            <label class="mqtt-field">
              <span>Topic</span>
              <input bind:value={publishTopic} placeholder="devices/kitchen/light/set" />
            </label>

            <label class="mqtt-field">
              <span>Payload</span>
              <textarea bind:value={publishPayload} rows="14" placeholder="Example JSON or text payload"></textarea>
            </label>

            <div class="form-grid">
              <label class="mqtt-field">
                <span>QoS</span>
                <select bind:value={publishQos}>
                  {#each qosOptions as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              </label>

              <label class="mqtt-field mqtt-checkbox-field">
                <span>Retain</span>
                <div class="mqtt-checkbox-row">
                  <input bind:checked={publishRetain} type="checkbox" />
                  <small class="subtle">Broker stores the latest payload for future subscribers.</small>
                </div>
              </label>
            </div>

            <div class="form-actions">
              <button class="button-mid" disabled={busyAction !== null || !isConnected} type="button" on:click={publishMessage}>
                {busyAction === 'publish' ? 'Publishing...' : 'Publish'}
              </button>
            </div>
          </div>
        {/if}
      </article>

      <article class="panel stack mqtt-subscriptions-panel">
        <div class="mqtt-panel-header">
          <div>
            <h2>Subscriptions</h2>
            <p class="muted">Track live topics with broker-side QoS and keep only the latest value per topic.</p>
          </div>
        </div>

        {#if credentialMode === 'dynsec_client' && selectedDynsecClient}
          <details class="mqtt-access-details">
            <summary>Allowed Filters ({selectedDynsecSubscriptionAccess.length})</summary>

            <div class="stack mqtt-access-body">
              <p class="subtle">Helper list derived from the selected dynsec client's effective subscribe ACLs. You can still enter a topic filter manually.</p>

              {#if selectedDynsecAccessWarnings.length}
                <div class="panel stack-tight mqtt-access-warning">
                  <strong>Access Note</strong>
                  {#each selectedDynsecAccessWarnings as warning}
                    <div>{warning}</div>
                  {/each}
                </div>
              {/if}

              {#if selectedDynsecSubscriptionAccess.length}
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Filter</th>
                        <th>ACL</th>
                        <th>Priority</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each selectedDynsecSubscriptionAccess as entry}
                        <tr>
                          <td>{entry.filter}</td>
                          <td>{formatSubscriptionAclType({ acltype: entry.acltype })}</td>
                          <td>{entry.priority}</td>
                          <td class="mqtt-table-action">
                            <button class="button-start" type="button" on:click={() => subscriptionFilter = entry.filter}>Use</button>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else}
                <p class="muted">No allowed subscribe filters were found for {selectedDynsecClient.username}.</p>
              {/if}
            </div>
          </details>
        {:else if data.canUseDynsec}
          <p class="subtle">ACL filter preview is only available for dynsec clients.</p>
        {/if}

        <div class="mqtt-subscribe-row">
          <label class="mqtt-field mqtt-field-grow">
            <span>Topic Filter</span>
            <input bind:value={subscriptionFilter} placeholder="devices/+/status" />
          </label>

          <label class="mqtt-field mqtt-qos-field">
            <span>QoS</span>
            <select bind:value={subscriptionQos}>
              {#each qosOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>

          <button class="button-mid mqtt-subscribe-button" disabled={busyAction !== null} type="button" on:click={() => addSubscription()}>
            {busyAction === 'subscribe' ? 'Adding...' : 'Subscribe'}
          </button>
        </div>

        {#if explorer.subscriptions.length}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Filter</th>
                  <th>QoS</th>
                  <th>Matches</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each explorer.subscriptions as subscription}
                  <tr>
                    <td>{subscription.filter}</td>
                    <td>{subscription.qos}</td>
                    <td>{subscription.matchedMessageCount}</td>
                    <td class="mqtt-table-action">
                      <button class="button-danger" disabled={busyAction !== null} type="button" on:click={() => removeSubscription({ filter: subscription.filter })}>
                        Remove
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="muted">No active subscriptions yet.</p>
        {/if}
      </article>

      <article class="panel stack mqtt-latest-topics-panel">
        <button
          class="mqtt-section-toggle"
          type="button"
          aria-expanded={latestTopicsOpen}
          on:click={toggleLatestTopicsPanel}
        >
          <span>Latest Topics</span>
          <span class="mqtt-section-toggle-indicator" aria-hidden="true">{latestTopicsOpen ? '−' : '+'}</span>
        </button>

        {#if latestTopicsOpen}
          <div class="stack">
            <div class="mqtt-panel-header">
              <div>
                <p class="muted">Messages seen {explorer.stats.totalMessages}. Tracked topics {explorer.stats.trackedTopics}.</p>
              </div>
              <div class="mqtt-latest-topics-toolbar">
                <label class="mqtt-field mqtt-latest-topics-limit">
                  <span>Tracked Limit</span>
                  <select
                    disabled={busyAction !== null}
                    value={latestTopicsLimitValue()}
                    on:change={(event) => updateLatestTopicsLimit({ value: event.currentTarget.value })}
                  >
                    {#each latestTopicsLimitOptions as option}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </label>

                <button
                  class="button-warning"
                  disabled={busyAction !== null || !explorer.messages.length}
                  type="button"
                  on:click={clearLatestTopics}
                >
                  {busyAction === 'clear_latest_topics' ? 'Clearing...' : 'Clear'}
                </button>
              </div>
            </div>

            <div class="subtle">Oldest tracked topics are removed when the selected limit is reached. Hover or click topic and payload fields to inspect the full value.</div>

            {#if currentSelectedMessage}
              <div class="panel stack mqtt-selected-topic-panel">
                <div class="mqtt-panel-header">
                  <div>
                    <h2>Selected Topic</h2>
                    <p class="muted">Inspect the selected latest-topic row and reuse it in publish.</p>
                  </div>
                  <div class="pill-row">
                    <button class="button-start" type="button" on:click={() => publishTopic = currentSelectedMessage.topic}>Use In Publish</button>
                    <button class="button-warning" type="button" on:click={() => copyToClipboard({
                      value: currentSelectedMessage.topic,
                      successMessage: 'Selected topic copied.'
                    })}>Copy Topic</button>
                    <button class="button-warning" type="button" on:click={() => copyToClipboard({
                      value: formatPayload({ message: currentSelectedMessage }),
                      successMessage: 'Selected payload copied.'
                    })}>Copy Payload</button>
                    <button class="button-danger" type="button" on:click={deselectTopic}>Deselect</button>
                  </div>
                </div>

                <div class="pill-row">
                  <div class="badge tone-start">{currentSelectedMessage.topic}</div>
                  <div class="badge">QoS {currentSelectedMessage.qos}</div>
                  <div class="badge">{currentSelectedMessage.retain ? 'Retained' : 'Not Retained'}</div>
                  <div class="badge">{currentSelectedMessage.payloadFormat}</div>
                </div>
                <div class="subtle">Received {currentSelectedMessage.receivedAt} · {currentSelectedMessage.byteLength} bytes</div>
                <pre class="mqtt-payload-view">{formatPayload({ message: currentSelectedMessage })}</pre>
              </div>
            {/if}

            {#if explorer.messages.length}
              <div class="table-wrap mqtt-topic-table-wrap">
                <table class="mqtt-topics-table">
                  <thead>
                    <tr>
                      <th class="mqtt-col-topic">Topic</th>
                      <th class="mqtt-col-payload">Payload</th>
                      <th class="mqtt-col-qos">QoS</th>
                      <th class="mqtt-col-retain">Retain</th>
                      <th class="mqtt-col-received">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each explorer.messages as message}
                      {@const fullPayload = formatPayload({ message })}
                      <tr class:selected-row={message.topic === selectedTopic} class="mqtt-topic-row" on:click={() => selectTopic({ topic: message.topic })}>
                        <td class="mqtt-topic-cell">
                          <button
                            class="mqtt-message-cell-button"
                            title={message.topic}
                            type="button"
                            on:click|stopPropagation={() => openMessageModal({
                              message,
                              title: 'Topic',
                              description: 'Full topic path for the selected latest-message row.',
                              value: message.topic,
                              copyLabel: 'Copy Topic'
                            })}
                          >
                            {message.topic}
                          </button>
                        </td>
                        <td class="mqtt-preview-cell">
                          <button
                            class="mqtt-message-cell-button"
                            title={fullPayload}
                            type="button"
                            on:click|stopPropagation={() => openMessageModal({
                              message,
                              title: `Payload · ${message.topic}`,
                              description: 'Full payload for the selected latest-message row.',
                              value: fullPayload,
                              copyLabel: 'Copy Payload'
                            })}
                          >
                            {message.preview}
                          </button>
                        </td>
                        <td>{message.qos}</td>
                        <td>{message.retain ? 'Yes' : 'No'}</td>
                        <td class="mqtt-received-cell">{message.receivedAt}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <p class="muted">No messages received yet. Subscribe to begin.</p>
            {/if}
          </div>
        {/if}
      </article>
    {/if}
  </div>
</section>

{#if messageModal}
  <div class="mqtt-modal-backdrop" role="presentation">
    <div class="panel stack mqtt-modal" role="dialog" aria-modal="true" aria-labelledby="mqtt-modal-title" tabindex="-1">
      <div class="mqtt-panel-header">
        <div>
          <h2 id="mqtt-modal-title">{messageModal.title}</h2>
          <p class="muted">{messageModal.description}</p>
        </div>
        <div class="mqtt-modal-actions">
          <button class="button-warning" type="button" on:click={() => copyToClipboard({
            value: messageModal?.value ?? '',
            successMessage: `${messageModal?.copyLabel ?? 'Value'} copied.`
          })}>
            Copy
          </button>
          <button class="button-danger" type="button" on:click={closeMessageModal}>Close</button>
        </div>
      </div>

      <textarea class="mqtt-modal-text" readonly rows="18">{messageModal.value}</textarea>
    </div>
  </div>
{/if}

<style>
  .mqtt-page {
    gap: 1.5rem;
    width: 100%;
  }

  .mqtt-page-status {
    justify-items: end;
  }

  .mqtt-layout {
    gap: 1.4rem;
  }

  .mqtt-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .mqtt-panel-header h2 {
    margin: 0 0 0.35rem;
  }

  .mqtt-alert {
    padding-block: 1rem;
  }

  .mqtt-alert-danger {
    border-color: var(--color-danger-border);
    background: var(--color-danger-fill);
  }

  .mqtt-alert-info {
    border-color: var(--color-start-border);
    background: var(--color-start-fill);
  }

  .mqtt-field {
    display: grid;
    gap: 0.45rem;
  }

  .mqtt-field span,
  .mqtt-session-label {
    color: var(--color-text-faint);
    font-size: 0.8rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .mqtt-checkbox-field {
    align-content: start;
  }

  .mqtt-checkbox-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 2.75rem;
  }

  .mqtt-auth-toggle {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .mqtt-connection-action {
    min-width: 11rem;
    border-width: 2px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .mqtt-connection-action-live {
    box-shadow:
      var(--shadow-panel),
      0 0 0 1px currentColor;
  }

  .mqtt-disabled-button:disabled,
  .mqtt-connection-action:disabled {
    opacity: 0.42;
    filter: saturate(0.15);
    border-style: dashed;
    box-shadow: none;
    cursor: not-allowed;
    transform: none;
  }

  .mqtt-identity-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: stretch;
  }

  .mqtt-identity-card,
  .mqtt-session-panel {
    background: var(--color-bg-elevated);
  }

  .mqtt-identity-card {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .mqtt-identity-row {
    display: flex;
    justify-content: flex-start;
    gap: var(--space-3);
    align-items: baseline;
    flex-wrap: wrap;
  }

  .mqtt-identity-label {
    min-width: 6.25rem;
    color: var(--color-text-faint);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .mqtt-identity-value {
    color: var(--color-text);
    font-size: 1rem;
    font-weight: 600;
  }

  .mqtt-identity-actions {
    display: grid;
    align-content: center;
    gap: var(--space-2);
  }

  .mqtt-client-picker {
    gap: var(--space-3);
  }

  .mqtt-client-table-wrap {
    max-height: 18rem;
  }

  .mqtt-client-table td {
    vertical-align: middle;
  }

  .mqtt-subscribe-row {
    display: grid;
    grid-template-columns: minmax(18rem, 44rem) minmax(17rem, 19rem) auto;
    gap: var(--space-3);
    align-items: end;
    justify-content: start;
  }

  .mqtt-access-details {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
  }

  .mqtt-access-details summary {
    padding: var(--space-3);
    cursor: pointer;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .mqtt-access-details[open] summary {
    border-bottom: 1px solid var(--color-border);
  }

  .mqtt-access-body {
    padding: var(--space-3);
  }

  .mqtt-access-warning {
    border-color: var(--color-warning-border);
    background: var(--color-warning-fill);
    color: var(--color-warning-ink);
  }

  .mqtt-field-grow {
    min-width: 0;
  }

  .mqtt-qos-field,
  .mqtt-subscribe-button {
    align-self: end;
  }

  .mqtt-subscribe-button {
    min-width: 9.5rem;
  }

  .mqtt-publish-panel {
    margin-block: 0.25rem 0.45rem;
  }

  .mqtt-subscriptions-panel {
    margin-top: 0.35rem;
  }

  .mqtt-latest-topics-panel {
    margin-top: 0.2rem;
  }

  .mqtt-table-action {
    width: 1%;
    white-space: nowrap;
  }

  .mqtt-section-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-text);
    font: inherit;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
  }

  .mqtt-section-toggle:hover {
    border-color: var(--color-start-border);
  }

  .mqtt-section-toggle-indicator {
    font-size: 1.25rem;
    line-height: 1;
  }

  .mqtt-session-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .mqtt-session-item {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
  }

  .mqtt-latest-topics-toolbar {
    display: flex;
    align-items: end;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .mqtt-latest-topics-limit {
    min-width: 9rem;
  }

  .mqtt-selected-topic-panel {
    margin-top: 0.35rem;
    background: var(--color-bg-elevated);
  }

  .mqtt-topics-table {
    width: 100%;
    min-width: 60rem;
    table-layout: fixed;
  }

  .mqtt-col-topic {
    width: 28%;
  }

  .mqtt-col-payload {
    width: auto;
  }

  .mqtt-col-qos,
  .mqtt-col-retain {
    width: 7%;
  }

  .mqtt-col-received {
    width: calc(30ch + 2rem + 32px);
    padding-right: calc(1rem + 4px);
  }

  .mqtt-topic-row {
    cursor: pointer;
  }

  .selected-row {
    background: var(--color-mid-fill);
  }

  .mqtt-message-cell-button {
    display: -webkit-box;
    width: 100%;
    min-height: 4.2rem;
    padding: 0 0.2rem 0 0.45rem;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: 1.35;
    text-align: left;
    word-break: break-word;
    overflow: hidden;
    cursor: pointer;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
  }

  .mqtt-message-cell-button:hover {
    color: var(--color-start-text);
  }

  .mqtt-received-cell {
    padding-right: calc(1rem + 4px);
    white-space: nowrap;
    word-break: normal;
    overflow-wrap: normal;
  }

  .mqtt-payload-view {
    margin: 0;
    max-height: 28rem;
    overflow: auto;
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .mqtt-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: color-mix(in srgb, var(--color-bg) 58%, transparent);
    backdrop-filter: blur(4px);
  }

  .mqtt-modal {
    width: min(72rem, 100%);
    max-height: min(90vh, 56rem);
  }

  .mqtt-modal-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .mqtt-modal-text {
    width: 100%;
    min-height: 18rem;
    resize: vertical;
    font: inherit;
  }

  @media (max-width: 980px) {
    .mqtt-session-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .mqtt-col-topic {
      width: 25%;
    }
  }

  @media (max-width: 860px) {
    .mqtt-identity-toolbar,
    .mqtt-session-grid,
    .mqtt-subscribe-row {
      grid-template-columns: 1fr;
    }

    .mqtt-identity-actions {
      grid-template-columns: 1fr;
    }

    .mqtt-modal {
      padding: var(--space-3);
    }
  }
</style>
