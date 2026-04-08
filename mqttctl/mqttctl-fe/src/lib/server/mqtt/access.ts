import { createOpaqueToken } from '$server/utils/ids';
import { getSourceIp, requireSameOrigin } from '$server/http';
import { hasCapability, requireCapability } from '$server/permissions';
import type { RequestEvent } from '@sveltejs/kit';

const mqttBrowserSessionCookieName = 'mqttctl_mqtt_browser_session';

const cookiePath = ({ basePath }: { basePath: string }) => basePath || '/';

export const ensureMqttBrowserSession = ({ event }: { event: RequestEvent }) => {
  const existing = event.cookies.get(mqttBrowserSessionCookieName);
  if (existing) return existing;

  const nextValue = createOpaqueToken({ bytes: 18 });
  const isSecure = new URL(event.locals.appContext.runtimeConfig.config.publicBaseUrl).protocol === 'https:';

  event.cookies.set(mqttBrowserSessionCookieName, nextValue, {
    path: cookiePath({ basePath: event.locals.appContext.runtimeConfig.config.basePath }),
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure
  });

  return nextValue;
};

export const requireMqttSessionUser = ({
  event,
  requireOrigin = false
}: {
  event: RequestEvent;
  requireOrigin?: boolean;
}) => {
  if (requireOrigin) requireSameOrigin({ event });

  requireCapability({
    user: event.locals.currentUser,
    capability: 'read',
    correlationId: event.locals.correlationId
  });

  const browserSessionId = ensureMqttBrowserSession({ event });

  return {
    browserSessionId,
    sessionKey: `${event.locals.currentUser!.id}:${browserSessionId}`,
    sourceIp: getSourceIp({ event }),
    canUseDynsec: hasCapability({
      user: event.locals.currentUser,
      capability: 'manage_broker'
    })
  };
};

export const requireMqttDynsecUser = ({
  event,
  requireOrigin = false
}: {
  event: RequestEvent;
  requireOrigin?: boolean;
}) => {
  const access = requireMqttSessionUser({ event, requireOrigin });

  requireCapability({
    user: event.locals.currentUser,
    capability: 'manage_broker',
    correlationId: event.locals.correlationId
  });

  return access;
};
