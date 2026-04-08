import { redirect } from '@sveltejs/kit';

export const POST = async (event) => {
  await event.locals.appContext.auth.logout({
    cookieValue: event.cookies.get(event.locals.appContext.auth.getSessionCookieName())
  });

  event.cookies.delete(event.locals.appContext.auth.getSessionCookieName(), event.locals.appContext.auth.getCookieOptions());
  throw redirect(303, `${event.locals.appContext.runtimeConfig.config.basePath}/auth/login`);
};

