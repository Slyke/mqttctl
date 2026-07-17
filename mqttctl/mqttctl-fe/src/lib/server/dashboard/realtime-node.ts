import { randomUUID } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

const dashboardWebSocketSuffix = '/api/dashboard/ws';
const dashboardServerPatchedKey = '__mqttctlDashboardWsPatched__';

interface UpgradeCapableServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

interface DashboardRuntimeSnapshot {
  generatedAt: string;
  diagnostics: unknown;
  mcpRuntime?: unknown;
}

export interface DashboardWebSocketRuntime {
  authorizeDashboardSocket(args: {
    requestUrl: URL;
    headers: Headers;
    sourceIp: string | null;
    correlationId: string;
  }): Promise<void>;
  getDashboardStatusSnapshot(args: {
    correlationId: string;
  }): Promise<DashboardRuntimeSnapshot | null>;
  subscribeDashboardStatus(args: {
    listener: (snapshot: DashboardRuntimeSnapshot) => void;
  }): () => void;
  reportDashboardSocketError?(args: {
    stage: 'upgrade' | 'snapshot';
    correlationId: string;
    error: unknown;
  }): Promise<void> | void;
}

interface LegacyDashboardWebSocketRuntime {
  authorizeDashboardSocket(args: {
    requestUrl: URL;
    headers: Headers;
    sourceIp: string | null;
    correlationId: string;
  }): Promise<void>;
  loadDashboardStatusSnapshot?(args: {
    correlationId: string;
  }): Promise<{ generatedAt?: string; diagnostics: unknown } | null>;
  reportDashboardSocketError?(args: {
    stage: 'upgrade' | 'snapshot';
    correlationId: string;
    error: unknown;
  }): Promise<void> | void;
}

const attachedServers = new WeakSet<UpgradeCapableServer>();

interface DashboardStatusMessage {
  type: 'status';
  generatedAt: string;
  diagnostics: unknown;
  mcpRuntime?: unknown;
}

const rejectUpgrade = ({
  socket,
  statusCode,
  statusText,
  reason
}: {
  socket: Duplex;
  statusCode: number;
  statusText: string;
  reason: string;
}) => {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(reason)}\r\n`
    + '\r\n'
    + reason
  );
  socket.destroy();
};

const sendRawMessage = ({
  ws,
  payload
}: {
  ws: WebSocket;
  payload: string;
}) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(payload);
};

const createStatusPayload = ({ snapshot }: { snapshot: DashboardRuntimeSnapshot }) => JSON.stringify({
  type: 'status',
  generatedAt: snapshot.generatedAt,
  diagnostics: snapshot.diagnostics,
  mcpRuntime: snapshot.mcpRuntime
} satisfies DashboardStatusMessage);

const toHeaders = ({ requestHeaders }: { requestHeaders: IncomingHttpHeaders }) => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(requestHeaders)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }

    if (typeof value === 'string') {
      headers.set(key, value);
    }
  }

  return headers;
};

const toUpgradeErrorStatus = ({ error }: { error: unknown }) => {
  if (
    typeof error === 'object'
    && error
    && 'status' in error
    && typeof error.status === 'number'
  ) {
    return error.status;
  }

  return 500;
};

const toUpgradeErrorReason = ({ error }: { error: unknown }) =>
  error instanceof Error ? error.message : 'Dashboard websocket upgrade failed.';

const toUpgradeErrorStatusText = ({ statusCode }: { statusCode: number }) => {
  if (statusCode === 401) return 'Unauthorized';
  if (statusCode === 403) return 'Forbidden';
  if (statusCode === 404) return 'Not Found';
  return 'Internal Server Error';
};

const reportRuntimeError = async ({
  getRuntime,
  stage,
  correlationId,
  error
}: {
  getRuntime: () => Promise<DashboardWebSocketRuntime>;
  stage: 'upgrade' | 'snapshot';
  correlationId: string;
  error: unknown;
}) => {
  try {
    const runtime = await getRuntime();
    await runtime.reportDashboardSocketError?.({
      stage,
      correlationId,
      error
    });
  } catch (reportError) {
    console.error('Dashboard websocket error reporting failed.', {
      stage,
      correlationId,
      error,
      reportError
    });
  }
};

const normalizeRuntime = ({
  runtime
}: {
  runtime: DashboardWebSocketRuntime | LegacyDashboardWebSocketRuntime;
}): DashboardWebSocketRuntime => {
  if ('getDashboardStatusSnapshot' in runtime && 'subscribeDashboardStatus' in runtime) {
    return runtime;
  }

  return {
    authorizeDashboardSocket: runtime.authorizeDashboardSocket,
    getDashboardStatusSnapshot: async ({ correlationId }) => {
      if (!('loadDashboardStatusSnapshot' in runtime) || typeof runtime.loadDashboardStatusSnapshot !== 'function') {
        return null;
      }

      const snapshot = await runtime.loadDashboardStatusSnapshot({ correlationId });

      if (!snapshot) return null;

      return {
        generatedAt: snapshot.generatedAt ?? new Date().toISOString(),
        diagnostics: snapshot.diagnostics
      };
    },
    subscribeDashboardStatus: () => () => {},
    reportDashboardSocketError: runtime.reportDashboardSocketError
  };
};

export const attachDashboardWebSocketServer = ({
  server,
  loadRuntime
}: {
  server: UpgradeCapableServer | null | undefined;
  loadRuntime: () => Promise<DashboardWebSocketRuntime | LegacyDashboardWebSocketRuntime>;
}) => {
  if (!server || attachedServers.has(server)) return;

  attachedServers.add(server);

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let runtimePromise: Promise<DashboardWebSocketRuntime> | null = null;
  let unsubscribeDashboardStatus: (() => void) | null = null;

  const getRuntime = async () => {
    if (!runtimePromise) {
      runtimePromise = loadRuntime().catch((error) => {
        runtimePromise = null;
        throw error;
      }).then((runtime) => normalizeRuntime({ runtime }));
    }

    return await runtimePromise;
  };

  const broadcastSnapshot = ({ snapshot }: { snapshot: DashboardRuntimeSnapshot }) => {
    const payload = createStatusPayload({ snapshot });

    for (const client of clients) {
      sendRawMessage({
        ws: client,
        payload
      });
    }
  };

  const stopDashboardSubscription = () => {
    if (
      clients.size > 0
      || !unsubscribeDashboardStatus
    ) {
      return;
    }

    unsubscribeDashboardStatus();
    unsubscribeDashboardStatus = null;
  };

  const startDashboardSubscription = async () => {
    if (unsubscribeDashboardStatus) return;

    const runtime = await getRuntime();

    unsubscribeDashboardStatus = runtime.subscribeDashboardStatus({
      listener: (snapshot) => {
        broadcastSnapshot({ snapshot });
      }
    });
  };

  wss.on('connection', (ws) => {
    clients.add(ws);

    const initializeConnection = async () => {
      const correlationId = randomUUID();

      try {
        await startDashboardSubscription();

        const runtime = await getRuntime();
        const snapshot = await runtime.getDashboardStatusSnapshot({ correlationId });

        if (snapshot) {
          sendRawMessage({
            ws,
            payload: createStatusPayload({ snapshot })
          });
        }
      } catch (error) {
        await reportRuntimeError({
          getRuntime,
          stage: 'snapshot',
          correlationId,
          error
        });

        ws.close(1011, 'Dashboard snapshot unavailable.');
      }
    };

    void initializeConnection().catch((error) => {
      console.error('Dashboard websocket connection initialization failed.', {
        error
      });
      ws.close(1011, 'Dashboard snapshot unavailable.');
    });

    const closeClient = () => {
      clients.delete(ws);
      stopDashboardSubscription();
    };

    ws.on('close', closeClient);
    ws.on('error', closeClient);
  });

  const handleUpgrade = async ({
    request,
    socket,
    head
  }: {
    request: IncomingMessage;
    socket: Duplex;
    head: Buffer;
  }) => {
    const requestUrl = request.url ?? '/';
    const host = request.headers.host ?? '127.0.0.1';
    const parsedUrl = new URL(requestUrl, `http://${host}`);

    if (!parsedUrl.pathname.endsWith(dashboardWebSocketSuffix)) return;

    const correlationId = randomUUID();

    try {
      const runtime = await getRuntime();

      await runtime.authorizeDashboardSocket({
        requestUrl: parsedUrl,
        headers: toHeaders({ requestHeaders: request.headers }),
        sourceIp: request.socket.remoteAddress ?? null,
        correlationId
      });
    } catch (error) {
      await reportRuntimeError({
        getRuntime,
        stage: 'upgrade',
        correlationId,
        error
      });

      const statusCode = toUpgradeErrorStatus({ error });

      rejectUpgrade({
        socket,
        statusCode,
        statusText: toUpgradeErrorStatusText({ statusCode }),
        reason: toUpgradeErrorReason({ error })
      });

      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };

  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade({
      request,
      socket,
      head
    }).catch((error) => {
      console.error('Dashboard websocket upgrade failed.', {
        error
      });

      if (socket.destroyed) return;

      rejectUpgrade({
        socket,
        statusCode: 500,
        statusText: 'Internal Server Error',
        reason: 'Dashboard websocket upgrade failed.'
      });
    });
  });
};

export const patchDashboardWebSocketHttpServer = ({
  loadRuntime
}: {
  loadRuntime: () => Promise<DashboardWebSocketRuntime | LegacyDashboardWebSocketRuntime>;
}) => {
  const globalObject = globalThis as typeof globalThis & {
    [dashboardServerPatchedKey]?: boolean;
  };

  if (globalObject[dashboardServerPatchedKey]) return;

  globalObject[dashboardServerPatchedKey] = true;

  const originalCreateServer = http.createServer.bind(http);

  http.createServer = ((...args: Parameters<typeof http.createServer>) => {
    const server = originalCreateServer(...args);
    attachDashboardWebSocketServer({
      server,
      loadRuntime
    });
    return server;
  }) as typeof http.createServer;
};
