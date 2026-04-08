import { fail, redirect } from '@sveltejs/kit';
import { getSourceIp } from '$server/http';
import { normalizeUsername } from '$server/utils/passwords';

export const load = async ({ locals, url }) => {
  if (locals.currentUser) {
    throw redirect(303, `${locals.appContext.runtimeConfig.config.basePath}/dashboard`);
  }

  return {
    redirectTo: locals.appContext.auth.getSafePostLoginRedirectPath({
      redirectTo: url.searchParams.get('redirectTo')
    }),
    auth: locals.appContext.runtimeConfig.config.auth
  };
};

export const actions = {
  default: async (event) => {
    const formData = await event.request.formData();
    const username = String(formData.get('username') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const provider = String(formData.get('provider') ?? 'local');
    const redirectTo = event.locals.appContext.auth.getSafePostLoginRedirectPath({
      redirectTo: String(formData.get('redirectTo') ?? '')
    });

    if (provider === 'oidc') {
      const redirectUrl = await event.locals.appContext.auth.beginOidcLogin({
        redirectTo,
        correlationId: event.locals.correlationId
      });

      throw redirect(303, redirectUrl.href);
    }

    const sourceIp = getSourceIp({ event });

    if (!username || !password) {
      await event.locals.appContext.audit.record({
        actor: null,
        authMode: 'local',
        sourceIp,
        correlationId: event.locals.correlationId,
        action: 'auth.login.local',
        targetType: 'auth_login',
        targetId: username ? normalizeUsername({ username }) : null,
        beforeSummary: {
          submittedUsername: username || null,
          normalizedUsername: username ? normalizeUsername({ username }) : null,
          authMethod: 'local'
        },
        commandResult: {
          failureReason: 'missing_credentials'
        },
        success: false
      });

      return fail(400, {
        message: 'Username and password are required.',
        redirectTo
      });
    }

    try {
      const result = await event.locals.appContext.auth.loginLocal({
        username,
        password,
        sourceIp,
        userAgent: event.request.headers.get('user-agent'),
        correlationId: event.locals.correlationId
      });

      event.cookies.set(event.locals.appContext.auth.getSessionCookieName(), result.cookieValue, {
        ...event.locals.appContext.auth.getCookieOptions(),
        expires: new Date(result.expiresAt)
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      return fail(error instanceof Error ? ((error as { status?: number }).status ?? 400) : 400, {
        message,
        username,
        redirectTo
      });
    }

    throw redirect(303, redirectTo);
  }
};
