import { getAppContext } from '$server/context';
import { requireCapability } from '$server/permissions';
import { resolveSourceIp } from '$server/auth/service';
import { AppError, createAppError } from '$server/logging/errors';
import {
  getLatestDashboardSnapshot,
  refreshDashboardSnapshot,
  subscribeDashboardSnapshots
} from '$lib/server/dashboard/live-state';
import type { DashboardWebSocketRuntime } from './realtime-node';

const dashboardWebSocketSuffix = '/api/dashboard/ws';

const getCookieValue = ({
  cookieHeader,
  name
}: {
  cookieHeader: string | null;
  name: string;
}) => {
  if (!cookieHeader) return null;

  for (const entry of cookieHeader.split(';')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = entry.slice(0, separatorIndex).trim();
    if (key !== name) continue;

    const value = entry.slice(separatorIndex + 1).trim();

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
};

const resolveDashboardPath = ({ basePath }: { basePath: string }) => `${basePath}${dashboardWebSocketSuffix}`;

export const authorizeDashboardSocket: DashboardWebSocketRuntime['authorizeDashboardSocket'] = async ({
  requestUrl,
  headers,
  sourceIp,
  correlationId
}) => {
  const appContext = await getAppContext({ correlationId });
  const expectedPath = resolveDashboardPath({ basePath: appContext.runtimeConfig.config.basePath });

  if (requestUrl.pathname !== expectedPath) {
    throw createAppError({
      caller: 'dashboard::authorizeDashboardSocket',
      reason: 'Dashboard websocket path is invalid.',
      errorKey: 'INPUT_INVALID',
      correlationId,
      status: 404,
      context: {
        requestPath: requestUrl.pathname,
        expectedPath
      }
    });
  }

  const originHeader = headers.get('origin');

  if (originHeader) {
    const requestOrigin = new URL(originHeader).origin;
    const expectedOrigin = new URL(appContext.runtimeConfig.config.publicBaseUrl).origin;

    if (requestOrigin !== expectedOrigin) {
      throw createAppError({
        caller: 'dashboard::authorizeDashboardSocket',
        reason: 'Request origin does not match the configured base URL.',
        errorKey: 'CSRF_ORIGIN_INVALID',
        correlationId,
        status: 403,
        context: {
          requestOrigin,
          expectedOrigin
        }
      });
    }
  }

  const cookieValue = getCookieValue({
    cookieHeader: headers.get('cookie'),
    name: appContext.auth.getSessionCookieName()
  });
  const normalizedSourceIp = resolveSourceIp({ source: sourceIp });
  const sessionUser = await appContext.auth.getUserFromCookie({ cookieValue });
  const headerUser = sessionUser ?? await appContext.auth.authenticateTrustedHeaders({
    sourceIp: normalizedSourceIp,
    headers,
    correlationId
  });
  const currentUser = sessionUser ?? headerUser;

  requireCapability({
    user: currentUser,
    capability: 'read',
    correlationId
  });
};

export const getDashboardStatusSnapshot: DashboardWebSocketRuntime['getDashboardStatusSnapshot'] = async ({
  correlationId
}) => {
  const cachedSnapshot = getLatestDashboardSnapshot();

  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  const appContext = await getAppContext({ correlationId });
  return await refreshDashboardSnapshot({
    appContext,
    correlationId
  });
};

export const subscribeDashboardStatus: DashboardWebSocketRuntime['subscribeDashboardStatus'] = ({
  listener
}) => subscribeDashboardSnapshots({ listener });

export const reportDashboardSocketError: DashboardWebSocketRuntime['reportDashboardSocketError'] = async ({
  stage,
  correlationId,
  error
}) => {
  const appContext = await getAppContext({ correlationId });
  const caller = stage === 'upgrade'
    ? 'dashboard::reportDashboardSocketUpgradeError'
    : 'dashboard::reportDashboardSocketSnapshotError';
  const message = error instanceof Error
    ? error.message
    : 'Dashboard websocket runtime failed.';

  if (
    error instanceof AppError
    && error.status < 500
  ) {
    appContext.logger.warn({
      caller,
      message,
      correlationId,
      errorKey: error.errorKey,
      rootCause: error
    });
    return;
  }

  appContext.logger.error({
    caller,
    message,
    correlationId,
    errorKey: error instanceof AppError ? error.errorKey : 'DIAGNOSTICS_FAILED',
    rootCause: error
  });
};

export const dashboardWebSocketRuntime: DashboardWebSocketRuntime = {
  authorizeDashboardSocket,
  getDashboardStatusSnapshot,
  subscribeDashboardStatus,
  reportDashboardSocketError
};
