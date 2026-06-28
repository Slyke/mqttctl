import type { Handle } from '@sveltejs/kit';
import {
  buildHttpApiProxyTargetUrl,
  getHttpApiProxyRequestBasePath,
  stripHttpApiPathPrefix
} from '$server/config/http-api';
import { createAppError, toErrorBody } from '$server/logging/errors';

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host'
]);

const nullBodyStatuses = new Set([204, 205, 304]);
const bodylessRequestMethods = new Set(['GET', 'HEAD']);

const filterProxyRequestHeaders = ({ headers }: { headers: Headers }) => {
  const nextHeaders = new Headers();

  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (hopByHopHeaders.has(normalizedKey)) return;

    nextHeaders.set(key, value);
  });

  return nextHeaders;
};

const filterProxyResponseHeaders = ({ headers }: { headers: Headers }) => {
  const nextHeaders = new Headers();

  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (hopByHopHeaders.has(normalizedKey)) return;
    if (normalizedKey === 'content-encoding') return;

    nextHeaders.set(key, value);
  });

  return nextHeaders;
};

const appendForwardedFor = ({
  existing,
  clientAddress
}: {
  existing: string | null;
  clientAddress: string | null;
}) => {
  if (!clientAddress) return existing;

  return existing ? `${existing}, ${clientAddress}` : clientAddress;
};

const getClientAddress = ({ event }: { event: Parameters<Handle>[0]['event'] }) => {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
};

const readRequestBody = async ({ request }: { request: Request }) => {
  if (bodylessRequestMethods.has(request.method)) return undefined;

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return undefined;

  return new Uint8Array(body);
};

const buildProxyHeaders = ({
  event
}: {
  event: Parameters<Handle>[0]['event'];
}) => {
  const headers = filterProxyRequestHeaders({ headers: event.request.headers });
  const clientAddress = getClientAddress({ event });
  const existingForwardedFor = event.request.headers.get('x-forwarded-for');
  const nextForwardedFor = appendForwardedFor({ existing: existingForwardedFor, clientAddress });

  headers.set('x-forwarded-host', event.url.host);
  headers.set('x-forwarded-proto', event.url.protocol.replace(':', ''));
  if (nextForwardedFor) {
    headers.set('x-forwarded-for', nextForwardedFor);
  }
  headers.set('x-correlation-id', event.locals.correlationId);

  return headers;
};

const createProxyFailureResponse = ({
  event,
  error,
  targetUrl
}: {
  event: Parameters<Handle>[0]['event'];
  error: unknown;
  targetUrl: URL | null;
}) => {
  const appError = createAppError({
    caller: 'httpApiProxy::handle',
    reason: 'HTTP API proxy request failed.',
    errorKey: 'API_PROXY_FAILED',
    correlationId: event.locals.correlationId,
    status: 502,
    context: {
      method: event.request.method,
      path: event.url.pathname,
      targetOrigin: targetUrl?.origin ?? null,
      targetPath: targetUrl?.pathname ?? null
    },
    cause: error
  });

  event.locals.appContext.logger.error({
    caller: 'httpApiProxy::handle',
    message: appError.message,
    correlationId: event.locals.correlationId,
    errorKey: appError.errorKey,
    errorCode: appError.errorCode,
    context: appError.context,
    rootCause: appError
  });

  return new Response(JSON.stringify(toErrorBody({ error: appError })), {
    status: appError.status,
    headers: {
      'content-type': 'application/json'
    }
  });
};

export const handleHttpApiProxy: Handle = async ({ event, resolve }) => {
  const { runtimeConfig } = event.locals.appContext;

  if (runtimeConfig.config.httpApi.mode !== 'proxy') {
    return resolve(event);
  }

  const proxyBasePath = getHttpApiProxyRequestBasePath({ runtimeConfig });
  const downstreamPath = stripHttpApiPathPrefix({
    pathname: event.url.pathname,
    basePath: proxyBasePath
  });

  if (downstreamPath === null) {
    return resolve(event);
  }

  const targetUrl = buildHttpApiProxyTargetUrl({
    runtimeConfig,
    downstreamPath,
    search: event.url.search
  });

  if (!targetUrl) {
    return createProxyFailureResponse({
      event,
      error: new Error('HTTP API proxy upstream base URL is not configured.'),
      targetUrl
    });
  }

  try {
    const headers = buildProxyHeaders({ event });
    const body = await readRequestBody({ request: event.request });
    const response = await fetch(targetUrl, {
      method: event.request.method,
      headers,
      body
    });
    const responseHeaders = filterProxyResponseHeaders({ headers: response.headers });

    return new Response(nullBodyStatuses.has(response.status) ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    return createProxyFailureResponse({ event, error, targetUrl });
  }
};
