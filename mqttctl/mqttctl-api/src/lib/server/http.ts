import { json, type RequestEvent } from '@sveltejs/kit';
import type { ZodSchema } from 'zod';
import { AppError, createAppError, toErrorBody } from '$server/logging/errors';
import { resolveSourceIp } from '$server/auth/service';

export const parseRequestJson = async <T>({
  event,
  schema
}: {
  event: RequestEvent;
  schema: ZodSchema<T>;
}) => {
  const body = await event.request.json().catch(() => {
    throw createAppError({
      caller: 'http::parseRequestJson',
      reason: 'Request body must be valid JSON.',
      errorKey: 'INPUT_INVALID',
      correlationId: event.locals.correlationId,
      status: 400
    });
  });

  const result = schema.safeParse(body);
  if (!result.success) {
    throw createAppError({
      caller: 'http::parseRequestJson',
      reason: 'Request body failed validation.',
      errorKey: 'INPUT_INVALID',
      correlationId: event.locals.correlationId,
      status: 400,
      context: result.error.flatten()
    });
  }

  return result.data;
};

export const handleApiError = ({ event, error }: { event: RequestEvent; error: unknown }) => {
  const status = error instanceof AppError ? error.status : 500;
  event.locals.appContext.logger.error({
    caller: 'http::handleApiError',
    message: error instanceof Error ? error.message : 'Unhandled API error',
    correlationId: event.locals.correlationId,
    errorKey: error instanceof AppError ? error.errorKey : 'ERR_UNKNOWN',
    rootCause: error
  });
  return json(toErrorBody({ error }), { status });
};

export const ok = ({ data, status = 200 }: { data: Record<string, unknown>; status?: number }) => json({ ok: true, ...data }, { status });

export const requireSameOrigin = ({ event }: { event: RequestEvent }) => {
  const originHeader = event.request.headers.get('origin');
  if (!originHeader) return;

  const requestOrigin = new URL(originHeader).origin;
  const expectedOrigin = new URL(event.locals.appContext.runtimeConfig.config.publicBaseUrl).origin;

  if (requestOrigin === expectedOrigin) return;

  throw createAppError({
    caller: 'http::requireSameOrigin',
    reason: 'Request origin does not match the configured base URL.',
    errorKey: 'CSRF_ORIGIN_INVALID',
    correlationId: event.locals.correlationId,
    status: 403,
    context: { requestOrigin, expectedOrigin }
  });
};

export const getSourceIp = ({ event }: { event: RequestEvent }) => {
  try {
    return resolveSourceIp({ source: event.getClientAddress() });
  } catch {
    return null;
  }
};
