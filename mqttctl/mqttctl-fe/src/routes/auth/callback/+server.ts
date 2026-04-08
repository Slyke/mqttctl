import { redirect } from '@sveltejs/kit';
import { getSourceIp } from '$server/http';

export const GET = async (event) => {
  const result = await event.locals.appContext.auth.completeOidcLogin({
    callbackUrl: event.url,
    sourceIp: getSourceIp({ event }),
    userAgent: event.request.headers.get('user-agent'),
    correlationId: event.locals.correlationId
  });

  event.cookies.set(event.locals.appContext.auth.getSessionCookieName(), result.cookieValue, {
    ...event.locals.appContext.auth.getCookieOptions(),
    expires: new Date(result.expiresAt)
  });

  throw redirect(303, result.redirectTo);
};

