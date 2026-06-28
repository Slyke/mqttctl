import { TextDecoder } from 'node:util';
import { connect, type MqttClient } from 'mqtt';
import type {
  MqttAuthMode,
  MqttConnectionDefaults,
  MqttConnectionStatus,
  MqttExplorerState,
  MqttLatestMessage,
  MqttQos,
  MqttSubscription
} from '$lib/types';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppLogger } from '$server/logging/logger';
import { createAppError } from '$server/logging/errors';

interface ConnectInput {
  host: string;
  port: number;
  tls: boolean;
  authMode: MqttAuthMode;
  username?: string;
  password?: string;
  clientId?: string;
}

interface PublishInput {
  topic: string;
  payload: string;
  qos: MqttQos;
  retain: boolean;
}

interface SessionRecord {
  client: MqttClient | null;
  revision: number;
  connection: MqttConnectionStatus;
  subscriptions: Map<string, MqttSubscription>;
  messages: Map<string, MqttLatestMessage>;
  totalMessages: number;
  trackedTopicsLimit: number | null;
  listeners: Set<(state: MqttExplorerState) => void>;
  pendingEmitTimer: NodeJS.Timeout | null;
  pendingSessionCloseTimer: NodeJS.Timeout | null;
}

const absoluteMaxTrackedTopics = 500;
const sessionCloseGracePeriodMs = 10_000;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const defaultConnectionStatus = (): MqttConnectionStatus => ({
  state: 'disconnected',
  connected: false,
  host: null,
  port: null,
  tls: false,
  authMode: null,
  username: null,
  clientId: null,
  message: null,
  connectedAt: null,
  updatedAt: null
});

const normalizeText = ({ value }: { value: string }) => value.trim();

const topicMatchesFilter = ({ filter, topic }: { filter: string; topic: string }) => {
  const filterLevels = filter.split('/');
  const topicLevels = topic.split('/');

  if (
    topic.startsWith('$')
    && (filterLevels[0] === '#' || filterLevels[0] === '+')
  ) {
    return false;
  }

  for (let index = 0; index < filterLevels.length; index += 1) {
    const filterLevel = filterLevels[index];
    const topicLevel = topicLevels[index];

    if (filterLevel === '#') return index === filterLevels.length - 1;
    if (topicLevel === undefined) return false;
    if (filterLevel === '+') continue;
    if (filterLevel !== topicLevel) return false;
  }

  return filterLevels.length === topicLevels.length;
};

const detectPayloadFormat = ({ payload }: { payload: Buffer }) => {
  try {
    const decoded = utf8Decoder.decode(payload);
    const trimmed = decoded.trim();
    if (
      trimmed
      && (trimmed.startsWith('{') || trimmed.startsWith('['))
    ) {
      JSON.parse(trimmed);
      return {
        payload: decoded,
        payloadFormat: 'json' as const
      };
    }

    return {
      payload: decoded,
      payloadFormat: 'text' as const
    };
  } catch {
    return {
      payload: payload.toString('base64'),
      payloadFormat: 'base64' as const
    };
  }
};

const buildPreview = ({ value }: { value: string }) => value.length > 160 ? `${value.slice(0, 157)}...` : value;

const wrapClientEnd = async ({ client }: { client: MqttClient }) => {
  await new Promise<void>((resolve) => {
    client.end(true, {}, () => {
      return resolve();
    });
  });
};

const wrapSubscribe = async ({
  client,
  filter,
  qos
}: {
  client: MqttClient;
  filter: string;
  qos: MqttQos;
}) => {
  await new Promise<void>((resolve, reject) => {
    client.subscribe(filter, { qos }, (error) => {
      if (error) {
        return reject(error);
      }

      return resolve();
    });
  });
};

const wrapUnsubscribe = async ({
  client,
  filter
}: {
  client: MqttClient;
  filter: string;
}) => {
  await new Promise<void>((resolve, reject) => {
    client.unsubscribe(filter, (error) => {
      if (error) {
        return reject(error);
      }

      return resolve();
    });
  });
};

const wrapPublish = async ({
  client,
  topic,
  payload,
  qos,
  retain
}: {
  client: MqttClient;
  topic: string;
  payload: string;
  qos: MqttQos;
  retain: boolean;
}) => {
  await new Promise<void>((resolve, reject) => {
    client.publish(topic, payload, { qos, retain }, (error) => {
      if (error) {
        return reject(error);
      }

      return resolve();
    });
  });
};

export class MqttExplorerService {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly runtimeConfig: LoadedRuntimeConfig,
    private readonly logger: AppLogger
  ) {}

  private buildDefaults(): MqttConnectionDefaults {
    return {
      host: this.runtimeConfig.config.broker.host,
      port: this.runtimeConfig.config.broker.port,
      tls: this.runtimeConfig.config.broker.tls.enabled,
      authMode: 'configured_admin',
      configuredUsername: this.runtimeConfig.config.broker.dynsecAdminUsername,
      configuredClientId: this.runtimeConfig.config.broker.mqttClientId
    };
  }

  private getOrCreateSession({ sessionKey }: { sessionKey: string }) {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const created: SessionRecord = {
      client: null,
      revision: 0,
      connection: defaultConnectionStatus(),
      subscriptions: new Map(),
      messages: new Map(),
      totalMessages: 0,
      trackedTopicsLimit: null,
      listeners: new Set(),
      pendingEmitTimer: null,
      pendingSessionCloseTimer: null
    };

    this.sessions.set(sessionKey, created);
    return created;
  }

  private snapshot({ session }: { session: SessionRecord }): MqttExplorerState {
    return {
      revision: session.revision,
      defaults: this.buildDefaults(),
      connection: { ...session.connection },
      subscriptions: [...session.subscriptions.values()].sort((left, right) => left.filter.localeCompare(right.filter)),
      messages: [...session.messages.values()].sort((left, right) => right.receivedAt.localeCompare(left.receivedAt)),
      stats: {
        totalMessages: session.totalMessages,
        trackedTopics: session.messages.size,
        trackedTopicsLimit: session.trackedTopicsLimit
      }
    };
  }

  private trimTrackedMessages({ session }: { session: SessionRecord }) {
    const effectiveLimit = session.trackedTopicsLimit === null
      ? absoluteMaxTrackedTopics
      : Math.min(session.trackedTopicsLimit, absoluteMaxTrackedTopics);

    while (session.messages.size > effectiveLimit) {
      const oldest = [...session.messages.values()]
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))[0];
      if (!oldest) return;
      session.messages.delete(oldest.topic);
    }
  }

  private emitNow({ sessionKey }: { sessionKey: string }) {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (!session.listeners.size) return;

    const nextState = this.snapshot({ session });
    for (const listener of session.listeners) {
      listener(nextState);
    }
  }

  private scheduleEmit({
    sessionKey,
    immediate = false
  }: {
    sessionKey: string;
    immediate?: boolean;
  }) {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.revision += 1;

    if (immediate) {
      if (session.pendingEmitTimer) {
        clearTimeout(session.pendingEmitTimer);
        session.pendingEmitTimer = null;
      }

      this.emitNow({ sessionKey });
      return;
    }

    if (session.pendingEmitTimer) return;

    session.pendingEmitTimer = setTimeout(() => {
      session.pendingEmitTimer = null;
      this.emitNow({ sessionKey });
    }, 90);
  }

  private setConnectionStatus({
    session,
    patch
  }: {
    session: SessionRecord;
    patch: Partial<MqttConnectionStatus>;
  }) {
    session.connection = {
      ...session.connection,
      ...patch,
      updatedAt: new Date().toISOString()
    };
  }

  private async disconnectClient({
    session,
    sessionKey,
    correlationId,
    reason
  }: {
    session: SessionRecord;
    sessionKey: string;
    correlationId: string | null;
    reason: string;
  }) {
    const activeClient = session.client;
    session.client = null;

    if (activeClient) {
      try {
        await wrapClientEnd({ client: activeClient });
      } catch (error) {
        this.logger.warn({
          caller: 'mqtt::disconnect',
          message: 'MQTT client shutdown raised an error.',
          correlationId,
          rootCause: error
        });
      }
    }

    this.setConnectionStatus({
      session,
      patch: {
        state: 'disconnected',
        connected: false,
        message: reason
      }
    });
    this.scheduleEmit({ sessionKey, immediate: true });
  }

  private bindClientEvents({
    sessionKey,
    session,
    client,
    correlationId
  }: {
    sessionKey: string;
    session: SessionRecord;
    client: MqttClient;
    correlationId: string | null;
  }) {
    client.on('connect', () => {
      const currentSession = this.sessions.get(sessionKey);
      if (!currentSession || currentSession.client !== client) return;

      this.setConnectionStatus({
        session: currentSession,
        patch: {
          state: 'connected',
          connected: true,
          message: `Connected to ${currentSession.connection.host}:${currentSession.connection.port}.`,
          connectedAt: new Date().toISOString()
        }
      });
      this.scheduleEmit({ sessionKey, immediate: true });
    });

    client.on('reconnect', () => {
      const currentSession = this.sessions.get(sessionKey);
      if (!currentSession || currentSession.client !== client) return;

      this.setConnectionStatus({
        session: currentSession,
        patch: {
          state: 'connecting',
          connected: false,
          message: 'Reconnecting to broker...'
        }
      });
      this.scheduleEmit({ sessionKey, immediate: true });
    });

    client.on('offline', () => {
      const currentSession = this.sessions.get(sessionKey);
      if (!currentSession || currentSession.client !== client) return;

      this.setConnectionStatus({
        session: currentSession,
        patch: {
          state: 'error',
          connected: false,
          message: 'Broker connection went offline.'
        }
      });
      this.scheduleEmit({ sessionKey, immediate: true });
    });

    client.on('close', () => {
      const currentSession = this.sessions.get(sessionKey);
      if (!currentSession || currentSession.client !== client) return;

      this.setConnectionStatus({
        session: currentSession,
        patch: {
          state: 'error',
          connected: false,
          message: 'Broker connection closed.'
        }
      });
      this.scheduleEmit({ sessionKey, immediate: true });
    });

    client.on('error', (error) => {
      const currentSession = this.sessions.get(sessionKey);
      if (!currentSession || currentSession.client !== client) return;

      this.logger.warn({
        caller: 'mqtt::client',
        message: 'MQTT client error received.',
        correlationId,
        rootCause: error,
        context: {
          host: currentSession.connection.host,
          port: currentSession.connection.port
        }
      });

      this.setConnectionStatus({
        session: currentSession,
        patch: {
          state: 'error',
          connected: false,
          message: error instanceof Error ? error.message : 'MQTT client error.'
        }
      });
      this.scheduleEmit({ sessionKey, immediate: true });
    });

    client.on('message', (topic, payload, packet) => {
      const currentSession = this.sessions.get(sessionKey);
      if (!currentSession || currentSession.client !== client) return;

      const normalizedPayload = detectPayloadFormat({ payload });
      const nextMessage: MqttLatestMessage = {
        topic,
        payload: normalizedPayload.payload,
        payloadFormat: normalizedPayload.payloadFormat,
        qos: packet.qos as MqttQos,
        retain: packet.retain,
        receivedAt: new Date().toISOString(),
        byteLength: payload.byteLength,
        preview: buildPreview({ value: normalizedPayload.payload })
      };

      currentSession.totalMessages += 1;
      currentSession.messages.set(topic, nextMessage);

      for (const [filter, subscription] of currentSession.subscriptions.entries()) {
        if (!topicMatchesFilter({ filter, topic })) continue;

        currentSession.subscriptions.set(filter, {
          ...subscription,
          matchedMessageCount: subscription.matchedMessageCount + 1
        });
      }

      this.trimTrackedMessages({ session: currentSession });

      this.scheduleEmit({ sessionKey });
    });
  }

  private resolveCredentials({ input }: { input: ConnectInput }) {
    if (input.authMode === 'configured_admin') {
      return {
        username: this.runtimeConfig.config.broker.dynsecAdminUsername,
        password: this.runtimeConfig.secrets.broker.dynsecAdminPassword,
        clientId: input.clientId?.trim() || this.runtimeConfig.config.broker.mqttClientId
      };
    }

    if (input.authMode === 'dynsec_client') {
      const normalizedUsername = input.username?.trim() ?? '';
      const normalizedPassword = input.password?.trim() || undefined;
      return {
        username: normalizedUsername,
        password: normalizedPassword
          ?? (normalizedUsername === this.runtimeConfig.config.broker.dynsecAdminUsername
            ? this.runtimeConfig.secrets.broker.dynsecAdminPassword
            : undefined),
        clientId: input.clientId?.trim() ?? ''
      };
    }

    return {
      username: input.username?.trim() ?? '',
      password: input.password,
      clientId: input.clientId?.trim() ?? ''
    };
  }

  private async waitForInitialConnect({
    client,
    correlationId
  }: {
    client: MqttClient;
    correlationId: string | null;
  }) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        return reject(createAppError({
          caller: 'mqtt::connect',
          reason: 'Timed out while waiting for the MQTT broker connection.',
          errorKey: 'MQTT_CONNECTION_FAILED',
          correlationId,
          status: 502
        }));
      }, 12_000);

      const onConnect = () => {
        cleanup();
        return resolve();
      };

      const onError = (error: unknown) => {
        cleanup();
        return reject(createAppError({
          caller: 'mqtt::connect',
          reason: error instanceof Error ? error.message : 'MQTT broker connection failed.',
          errorKey: 'MQTT_CONNECTION_FAILED',
          correlationId,
          status: 502,
          cause: error
        }));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        client.off('connect', onConnect);
        client.off('error', onError);
      };

      client.once('connect', onConnect);
      client.once('error', onError);
    });
  }

  private ensureConnected({
    session,
    correlationId
  }: {
    session: SessionRecord;
    correlationId: string | null;
  }) {
    if (session.client && session.connection.connected) return session.client;

    throw createAppError({
      caller: 'mqtt::ensureConnected',
      reason: 'An active MQTT connection is required.',
      errorKey: 'MQTT_NOT_CONNECTED',
      correlationId,
      status: 409
    });
  }

  getExplorerState({ sessionKey }: { sessionKey: string }) {
    return this.snapshot({ session: this.getOrCreateSession({ sessionKey }) });
  }

  watchSession({
    sessionKey,
    listener,
    correlationId
  }: {
    sessionKey: string;
    listener: (state: MqttExplorerState) => void;
    correlationId: string | null;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    if (session.pendingSessionCloseTimer) {
      clearTimeout(session.pendingSessionCloseTimer);
      session.pendingSessionCloseTimer = null;
    }

    session.listeners.add(listener);
    listener(this.snapshot({ session }));

    return () => {
      const currentSession = this.sessions.get(sessionKey);
      if (!currentSession) return;

      currentSession.listeners.delete(listener);
      if (currentSession.listeners.size > 0) return;

      if (currentSession.pendingEmitTimer) {
        clearTimeout(currentSession.pendingEmitTimer);
        currentSession.pendingEmitTimer = null;
      }

      const sessionToClose = currentSession;
      if (sessionToClose.pendingSessionCloseTimer) {
        clearTimeout(sessionToClose.pendingSessionCloseTimer);
      }

      sessionToClose.pendingSessionCloseTimer = setTimeout(() => {
        sessionToClose.pendingSessionCloseTimer = null;

        const activeSession = this.sessions.get(sessionKey);
        if (
          activeSession !== sessionToClose
          || activeSession.listeners.size > 0
        ) {
          return;
        }

        void this.disconnectClient({
          session: sessionToClose,
          sessionKey,
          correlationId,
          reason: 'Browser live channel closed.'
        }).finally(() => {
          const finalSession = this.sessions.get(sessionKey);
          if (
            finalSession === sessionToClose
            && finalSession.listeners.size === 0
          ) {
            this.sessions.delete(sessionKey);
          }
        }).catch((error) => {
          this.logger.warn({
            caller: 'mqtt::disconnectAfterLiveChannelClosed',
            message: 'Failed to clean up MQTT session after the browser live channel closed.',
            correlationId,
            errorKey: 'MQTT_OPERATION_FAILED',
            rootCause: error
          });
        });
      }, sessionCloseGracePeriodMs);
    };
  }

  async connect({
    sessionKey,
    input,
    correlationId
  }: {
    sessionKey: string;
    input: ConnectInput;
    correlationId: string | null;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    await this.disconnectClient({
      session,
      sessionKey,
      correlationId,
      reason: 'Preparing new MQTT connection.'
    });

    session.messages.clear();
    session.totalMessages = 0;
    session.subscriptions.clear();

    const credentials = this.resolveCredentials({ input });
    const host = normalizeText({ value: input.host });
    const clientId = credentials.clientId.trim();
    const username = credentials.username.trim();

    this.setConnectionStatus({
      session,
      patch: {
        state: 'connecting',
        connected: false,
        host,
        port: input.port,
        tls: input.tls,
        authMode: input.authMode,
        username,
        clientId,
        connectedAt: null,
        message: `Connecting to ${host}:${input.port}...`
      }
    });
    this.scheduleEmit({ sessionKey, immediate: true });

    const client = connect({
      host,
      port: input.port,
      protocol: input.tls ? 'mqtts' : 'mqtt',
      username: credentials.username,
      password: credentials.password,
      clientId,
      connectTimeout: 10_000,
      reconnectPeriod: 2_000,
      resubscribe: true,
      rejectUnauthorized: false
    });

    session.client = client;

    try {
      await this.waitForInitialConnect({ client, correlationId });
      this.bindClientEvents({ sessionKey, session, client, correlationId });

      for (const subscription of session.subscriptions.values()) {
        await wrapSubscribe({
          client,
          filter: subscription.filter,
          qos: subscription.qos
        });
      }

      this.setConnectionStatus({
        session,
        patch: {
          state: 'connected',
          connected: true,
          message: `Connected to ${host}:${input.port}.`,
          connectedAt: new Date().toISOString()
        }
      });
      this.scheduleEmit({ sessionKey, immediate: true });
      this.logger.info({
        caller: 'mqtt::connect',
        message: `Connected to ${host}:${input.port}.`,
        correlationId,
        context: {
          authMode: input.authMode,
          username,
          clientId
        }
      });

      return this.snapshot({ session });
    } catch (error) {
      session.client = null;

      try {
        await wrapClientEnd({ client });
      } catch {
        // Ignore shutdown errors after an already-failed connect attempt.
      }

      this.setConnectionStatus({
        session,
        patch: {
          state: 'error',
          connected: false,
          message: error instanceof Error ? error.message : 'MQTT connection failed.'
        }
      });
      this.scheduleEmit({ sessionKey, immediate: true });

      throw error;
    }
  }

  async disconnect({
    sessionKey,
    correlationId,
    reason = 'Disconnected from broker.'
  }: {
    sessionKey: string;
    correlationId: string | null;
    reason?: string;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    await this.disconnectClient({
      session,
      sessionKey,
      correlationId,
      reason
    });
    this.logger.info({
      caller: 'mqtt::disconnect',
      message: reason,
      correlationId,
      context: {
        host: session.connection.host,
        port: session.connection.port
      }
    });

    return this.snapshot({ session });
  }

  async subscribe({
    sessionKey,
    filter,
    qos,
    correlationId
  }: {
    sessionKey: string;
    filter: string;
    qos: MqttQos;
    correlationId: string | null;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    const normalizedFilter = normalizeText({ value: filter });
    const client = this.ensureConnected({ session, correlationId });

    try {
      await wrapSubscribe({ client, filter: normalizedFilter, qos });
      session.subscriptions.set(normalizedFilter, {
        filter: normalizedFilter,
        qos,
        subscribedAt: new Date().toISOString(),
        matchedMessageCount: 0
      });
      this.scheduleEmit({ sessionKey, immediate: true });
      this.logger.info({
        caller: 'mqtt::subscribe',
        message: `Subscribed to ${normalizedFilter}.`,
        correlationId,
        context: { qos }
      });
      return this.snapshot({ session });
    } catch (error) {
      throw createAppError({
        caller: 'mqtt::subscribe',
        reason: `Failed subscribing to ${normalizedFilter}.`,
        errorKey: 'MQTT_OPERATION_FAILED',
        correlationId,
        status: 502,
        context: {
          filter: normalizedFilter,
          qos
        },
        cause: error
      });
    }
  }

  async unsubscribe({
    sessionKey,
    filter,
    correlationId
  }: {
    sessionKey: string;
    filter: string;
    correlationId: string | null;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    const normalizedFilter = normalizeText({ value: filter });

    if (session.subscriptions.has(normalizedFilter) && session.client && session.connection.connected) {
      try {
        await wrapUnsubscribe({ client: session.client, filter: normalizedFilter });
      } catch (error) {
        throw createAppError({
          caller: 'mqtt::unsubscribe',
          reason: `Failed unsubscribing from ${normalizedFilter}.`,
          errorKey: 'MQTT_OPERATION_FAILED',
          correlationId,
          status: 502,
          context: { filter: normalizedFilter },
          cause: error
        });
      }
    }

    session.subscriptions.delete(normalizedFilter);
    this.scheduleEmit({ sessionKey, immediate: true });
    this.logger.info({
      caller: 'mqtt::unsubscribe',
      message: `Unsubscribed from ${normalizedFilter}.`,
      correlationId
    });
    return this.snapshot({ session });
  }

  async publish({
    sessionKey,
    input,
    correlationId
  }: {
    sessionKey: string;
    input: PublishInput;
    correlationId: string | null;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    const client = this.ensureConnected({ session, correlationId });

    try {
      await wrapPublish({
        client,
        topic: input.topic,
        payload: input.payload,
        qos: input.qos,
        retain: input.retain
      });
      this.logger.info({
        caller: 'mqtt::publish',
        message: `Published to ${input.topic}.`,
        correlationId,
        context: {
          qos: input.qos,
          retain: input.retain,
          host: session.connection.host,
          port: session.connection.port
        }
      });
      return this.snapshot({ session });
    } catch (error) {
      throw createAppError({
        caller: 'mqtt::publish',
        reason: `Failed publishing to ${input.topic}.`,
        errorKey: 'MQTT_OPERATION_FAILED',
        correlationId,
        status: 502,
        context: {
          topic: input.topic,
          qos: input.qos,
          retain: input.retain
        },
        cause: error
      });
    }
  }

  async clearMessages({
    sessionKey,
    correlationId
  }: {
    sessionKey: string;
    correlationId: string | null;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    session.messages.clear();
    session.totalMessages = 0;
    for (const [filter, subscription] of session.subscriptions.entries()) {
      session.subscriptions.set(filter, {
        ...subscription,
        matchedMessageCount: 0
      });
    }
    this.scheduleEmit({ sessionKey, immediate: true });
    this.logger.info({
      caller: 'mqtt::clearMessages',
      message: 'Cleared tracked MQTT latest topics.',
      correlationId,
      context: {
        trackedTopicsLimit: session.trackedTopicsLimit
      }
    });
    return this.snapshot({ session });
  }

  async setTrackedTopicsLimit({
    sessionKey,
    limit,
    correlationId
  }: {
    sessionKey: string;
    limit: number | null;
    correlationId: string | null;
  }) {
    const session = this.getOrCreateSession({ sessionKey });
    session.trackedTopicsLimit = limit;
    this.trimTrackedMessages({ session });
    this.scheduleEmit({ sessionKey, immediate: true });
    this.logger.info({
      caller: 'mqtt::setTrackedTopicsLimit',
      message: limit === null
        ? 'Tracked MQTT latest topics limit set to all.'
        : `Tracked MQTT latest topics limit set to ${limit}.`,
      correlationId,
      context: {
        trackedTopicsLimit: limit,
        trackedTopics: session.messages.size
      }
    });
    return this.snapshot({ session });
  }
}
