import type { Handle, HandleServerError } from '@sveltejs/kit';
import { getAppContext } from '$server/context';
import { createCorrelationId } from '$server/utils/ids';
import { AppError, toErrorBody } from '$server/logging/errors';
import { getSourceIp } from '$server/http';
import frontendErrorCatalog from './errors.json';
import { handleHttpApiProxy } from '$lib/server/http-api-proxy';

const frontendErrors = frontendErrorCatalog as Record<string, string>;
const eagerSsrRelativeFetchPattern = 'Cannot call `fetch` eagerly during server-side rendering with relative URL';
const svelteConstTagInvalidPlacementPattern = 'const_tag_invalid_placement';
const svelteConstTagInvalidPlacementMessagePattern = '`{@const}` must be the immediate child';
const frontendNotFoundPattern = 'Not found: ';

const resolveFrontendErrorCode = ({ errorKey }: { errorKey: string }) =>
  frontendErrors[errorKey] ?? frontendErrors.ERR_UNKNOWN ?? 'FFFFFFFFFFFFFFFF';

const toFrontendHandleErrorBody = ({ error }: { error: unknown }) => {
  if (
    error instanceof Error
    && error.message.includes(eagerSsrRelativeFetchPattern)
  ) {
    return {
      ok: false as const,
      errorKey: 'FRONTEND_SSR_RELATIVE_FETCH_INVALID',
      errorCode: resolveFrontendErrorCode({ errorKey: 'FRONTEND_SSR_RELATIVE_FETCH_INVALID' }),
      reason: error.message,
      correlationId: null
    };
  }

  if (
    error instanceof Error
    && (
      error.message.includes(svelteConstTagInvalidPlacementPattern)
      || error.message.includes(svelteConstTagInvalidPlacementMessagePattern)
    )
  ) {
    return {
      ok: false as const,
      errorKey: 'FRONTEND_SVELTE_CONST_TAG_INVALID_PLACEMENT',
      errorCode: resolveFrontendErrorCode({ errorKey: 'FRONTEND_SVELTE_CONST_TAG_INVALID_PLACEMENT' }),
      reason: error.message,
      correlationId: null
    };
  }

  if (
    error instanceof Error
    && error.message.includes(frontendNotFoundPattern)
  ) {
    return {
      ok: false as const,
      errorKey: 'FRONTEND_ROUTE_NOT_FOUND',
      errorCode: resolveFrontendErrorCode({ errorKey: 'FRONTEND_ROUTE_NOT_FOUND' }),
      reason: error.message,
      correlationId: null
    };
  }

  const body = toErrorBody({ error });

  if (body.errorKey === 'ERR_UNKNOWN') {
    return {
      ...body,
      errorKey: 'FRONTEND_UNHANDLED_SERVER_ERROR',
      errorCode: resolveFrontendErrorCode({ errorKey: 'FRONTEND_UNHANDLED_SERVER_ERROR' })
    };
  }

  return body;
};

export const handle: Handle = async ({ event, resolve }) => {
  const correlationId = createCorrelationId();
  const appContext = await getAppContext({ correlationId });

  event.locals.correlationId = correlationId;
  event.locals.appContext = appContext;

  const cookieValue = event.cookies.get(appContext.auth.getSessionCookieName());
  const sourceIp = getSourceIp({ event });

  const sessionUser = await appContext.auth.getUserFromCookie({ cookieValue });
  const headerUser = sessionUser ?? await appContext.auth.authenticateTrustedHeaders({
    sourceIp,
    headers: event.request.headers,
    correlationId
  });

  event.locals.currentUser = sessionUser ?? headerUser;

  const response = await handleHttpApiProxy({ event, resolve });
  response.headers.set('x-correlation-id', correlationId);
  return response;
};

export const handleError: HandleServerError = ({ error, event }) => {
  const body = toFrontendHandleErrorBody({ error });
  const rootCause = error instanceof AppError && error.cause ? error.cause : error;
  event.locals.appContext?.logger.error({
    caller: 'hooks::handleError',
    message: body.reason,
    correlationId: event.locals.correlationId ?? null,
    errorKey: body.errorKey,
    errorCode: body.errorCode,
    context: body.details,
    rootCause,
    errorChain: error instanceof AppError ? error.errorChain : undefined
  });

  return {
    message: body.reason,
    correlationId: body.correlationId,
    errorKey: body.errorKey,
    errorCode: body.errorCode
  };
};
