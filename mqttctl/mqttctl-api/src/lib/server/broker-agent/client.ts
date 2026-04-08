import https from 'node:https';
import type { CommandResult } from '$server/broker/command-runner';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppLogger } from '$server/logging/logger';
import { AppError, createAppError, resolveErrorCode } from '$server/logging/errors';
import type {
  ManagedBrokerKeyFileDownload,
  ManagedBrokerKeyFileId,
  ManagedBrokerKeyFileStatus
} from '$lib/types';

interface AgentErrorBody {
  ok: false;
  errorKey?: string;
  errorCode?: string;
  reason?: string;
  correlationId?: string | null;
  details?: unknown;
}

interface AgentSuccessBody<T> {
  ok: true;
  data: T;
}

interface AgentOperationResult {
  status: 'idle' | 'running' | 'success' | 'failed';
  message: string | null;
  result?: unknown;
}

interface BrokerAgentHealth {
  brokerRunning: boolean;
  brokerPid: number | null;
}

interface RequestResponse<T> {
  ok: boolean;
  status: number;
  payload: AgentSuccessBody<T> | AgentErrorBody | null;
}

interface DynsecConnectionTlsRequest {
  enabled: boolean;
  caFile: string | null;
  certFile: string | null;
  keyFile: string | null;
  insecure: boolean;
}

interface DynsecConnectionRequest {
  host: string;
  port: number;
  username: string;
  password: string;
  clientId: string;
  tls: DynsecConnectionTlsRequest;
}

const describeRemoteDetails = ({ details }: { details: unknown }) => {
  if (!details || typeof details !== 'object') return null;

  const path = 'path' in details && typeof details.path === 'string'
    ? details.path
    : null;
  const cause = 'cause' in details && typeof details.cause === 'string'
    ? details.cause
    : null;
  const atomicCause = 'atomicCause' in details && typeof details.atomicCause === 'string'
    ? details.atomicCause
    : null;

  if (!path && !cause && !atomicCause) return null;
  if (path && cause && atomicCause) return `Path: ${path}. Cause: ${cause}. Atomic cause: ${atomicCause}`;
  if (path && cause) return `Path: ${path}. Cause: ${cause}`;
  if (cause && atomicCause) return `Cause: ${cause}. Atomic cause: ${atomicCause}`;
  if (path) return `Path: ${path}.`;
  if (atomicCause) return `Atomic cause: ${atomicCause}`;
  return `Cause: ${cause}`;
};

export class BrokerAgentClient {
  constructor(
    private readonly runtimeConfig: LoadedRuntimeConfig,
    private readonly logger: AppLogger
  ) {}

  isConfigured() {
    return Boolean(this.runtimeConfig.config.broker.agent?.baseUrl);
  }

  private baseUrl() {
    return this.runtimeConfig.config.broker.agent?.baseUrl ?? null;
  }

  private timeoutMs() {
    return this.runtimeConfig.config.broker.agent?.timeoutMs ?? 10_000;
  }

  private insecure() {
    return this.runtimeConfig.config.broker.agent?.insecure ?? false;
  }

  private apiKey() {
    return this.runtimeConfig.secrets.broker.agentApiKey ?? null;
  }

  private requiresApiKey(path: string) {
    return path !== '/health' && path !== '/healthz';
  }

  private ensureConfigured({ correlationId }: { correlationId: string | null }) {
    const baseUrl = this.baseUrl();
    if (baseUrl) return baseUrl;

    throw createAppError({
      caller: 'broker-agent::ensureConfigured',
      reason: 'Broker agent is not configured.',
      errorKey: 'BROKER_AGENT_REQUEST_FAILED',
      correlationId,
      status: 500
    });
  }

  private async request<T>({
    method,
    path,
    body,
    correlationId
  }: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    correlationId: string | null;
  }) {
    const baseUrl = this.ensureConfigured({ correlationId });
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const url = new URL(normalizedPath, `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}`).toString();
    const apiKey = this.requiresApiKey(path) ? this.apiKey() : null;
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(correlationId ? { 'x-correlation-id': correlationId } : {})
    };

    try {
      const response = this.insecure() && new URL(url).protocol === 'https:'
        ? await this.requestWithInsecureHttps<T>({
            url,
            method,
            headers,
            body
          })
        : await this.requestWithFetch<T>({
            url,
            method,
            headers,
            body
          });
      const payload = response.payload;

      if (!response.ok) {
        const errorBody = payload && typeof payload === 'object' && 'ok' in payload ? payload as AgentErrorBody : null;
        const remoteErrorKey = errorBody?.errorKey ?? null;
        const mappedErrorKey = (
          remoteErrorKey
          && resolveErrorCode({ errorKey: remoteErrorKey }) !== resolveErrorCode({ errorKey: 'ERR_UNKNOWN' })
        )
          ? remoteErrorKey
          : 'BROKER_AGENT_REQUEST_FAILED';
        const remoteDetailsDescription = describeRemoteDetails({ details: errorBody?.details ?? null });
        throw createAppError({
          caller: 'broker-agent::request',
          reason: remoteDetailsDescription
            ? `${errorBody?.reason ?? `Broker agent request failed with HTTP ${response.status}.`} ${remoteDetailsDescription}`
            : errorBody?.reason ?? `Broker agent request failed with HTTP ${response.status}.`,
          errorKey: mappedErrorKey,
          correlationId,
          status: response.status,
          context: {
            method,
            path,
            remoteErrorKey: errorBody?.errorKey ?? null,
            remoteErrorCode: errorBody?.errorCode ?? null,
            remoteCorrelationId: errorBody?.correlationId ?? null,
            remoteDetails: errorBody?.details ?? null
          }
        });
      }

      if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true || !('data' in payload)) {
        throw createAppError({
          caller: 'broker-agent::request',
          reason: 'Broker agent returned an invalid response payload.',
          errorKey: 'BROKER_AGENT_RESPONSE_INVALID',
          correlationId,
          context: { method, path }
        });
      }

      this.logger.info({
        caller: 'broker-agent::request',
        message: `${method} ${path} succeeded.`,
        correlationId
      });

      return payload.data;
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw createAppError({
        caller: 'broker-agent::request',
        reason: `Broker agent request failed for ${method} ${path}.`,
        errorKey: 'BROKER_AGENT_REQUEST_FAILED',
        correlationId,
        context: { method, path },
        cause: error
      });
    }
  }

  private async requestWithFetch<T>({
    url,
    method,
    headers,
    body
  }: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
  }): Promise<RequestResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs());

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      return {
        ok: response.ok,
        status: response.status,
        payload: await response.json().catch(() => null) as AgentSuccessBody<T> | AgentErrorBody | null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestWithInsecureHttps<T>({
    url,
    method,
    headers,
    body
  }: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
  }): Promise<RequestResponse<T>> {
    const requestBody = body === undefined ? null : JSON.stringify(body);

    return await new Promise<RequestResponse<T>>((resolve, reject) => {
      const request = https.request(url, {
        method,
        headers,
        rejectUnauthorized: false
      }, (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            payload: text
              ? (() => {
                  try {
                    return JSON.parse(text) as AgentSuccessBody<T> | AgentErrorBody;
                  } catch {
                    return null;
                  }
                })()
              : null
          });
        });
      });

      request.on('error', reject);
      request.setTimeout(this.timeoutMs(), () => {
        request.destroy(new Error(`Request timed out after ${this.timeoutMs()}ms.`));
      });

      if (requestBody) {
        request.write(requestBody);
      }

      request.end();
    });
  }

  async readCurrentBrokerConfig({ correlationId }: { correlationId: string | null }) {
    const response = await this.request<{ current: string }>({
      method: 'GET',
      path: '/broker-config/current',
      correlationId
    });

    return response.current;
  }

  async listManagedKeyFiles({ correlationId }: { correlationId: string | null }) {
    const response = await this.request<{ files: ManagedBrokerKeyFileStatus[] }>({
      method: 'GET',
      path: '/broker-key-files',
      correlationId
    });

    return response.files;
  }

  async readManagedKeyFile({
    fileId,
    correlationId
  }: {
    fileId: ManagedBrokerKeyFileId;
    correlationId: string | null;
  }) {
    const response = await this.request<{ file: ManagedBrokerKeyFileDownload }>({
      method: 'GET',
      path: `/broker-key-files/${fileId}`,
      correlationId
    });

    return response.file;
  }

  async readHealth({ correlationId }: { correlationId: string | null }) {
    const response = await this.request<{ health: BrokerAgentHealth }>({
      method: 'GET',
      path: '/health',
      correlationId
    });

    return response.health;
  }

  async writeBrokerConfig({
    rendered,
    expectedCurrent,
    correlationId
  }: {
    rendered: string;
    expectedCurrent: string | null;
    correlationId: string | null;
  }) {
    return await this.request<{ written: true }>({
      method: 'POST',
      path: '/broker-config/write',
      body: { rendered, expectedCurrent },
      correlationId
    });
  }

  async readDynsecStateRaw({ correlationId }: { correlationId: string | null }) {
    const response = await this.request<{ raw: unknown }>({
      method: 'GET',
      path: '/dynsec/state',
      correlationId
    });

    return response.raw;
  }

  async runDynsecCommand({
    command,
    args = [],
    connection,
    correlationId
  }: {
    command: string;
    args?: string[];
    connection: DynsecConnectionRequest;
    correlationId: string | null;
  }) {
    const response = await this.request<{ result: CommandResult }>({
      method: 'POST',
      path: '/dynsec/command',
      body: { command, args, connection },
      correlationId
    });

    return response.result;
  }

  async reloadBroker({ correlationId }: { correlationId: string | null }) {
    const response = await this.request<{ operation: AgentOperationResult }>({
      method: 'POST',
      path: '/broker/reload',
      correlationId
    });

    return response.operation;
  }

  async restartBroker({ correlationId }: { correlationId: string | null }) {
    const response = await this.request<{ operation: AgentOperationResult }>({
      method: 'POST',
      path: '/broker/restart',
      correlationId
    });

    return response.operation;
  }
}
