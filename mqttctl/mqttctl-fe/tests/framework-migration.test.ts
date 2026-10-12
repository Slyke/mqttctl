import { describe, expect, it, vi } from 'vitest';
import { error, isHttpError, isRedirect } from '@sveltejs/kit';
import { handleError } from '../src/hooks.server';
import { actions } from '../src/routes/auth/login/+page.server';

describe('SvelteKit authentication and errors', () => {
  it('redirects OIDC login to the configured external provider', async () => {
    const providerUrl = new URL('https://identity.example/authorize?state=test');
    const event = {
      request: new Request('http://localhost/auth/login', {
        method: 'POST',
        body: new URLSearchParams({ provider: 'oidc', redirectTo: '/dashboard' })
      }),
      locals: {
        correlationId: 'oidc-test',
        appContext: {
          auth: {
            getSafePostLoginRedirectPath: () => '/dashboard',
            beginOidcLogin: vi.fn().mockResolvedValue(providerUrl)
          }
        }
      }
    };

    const redirect = await actions.default(event as never).catch((caught: unknown) => caught);
    expect(isRedirect(redirect)).toBe(true);
    expect(redirect).toMatchObject({ status: 303, location: providerUrl.href });
  });

  it('preserves expected permission errors without logging them as server failures', async () => {
    let caught: unknown;
    try {
      error(403, 'Permission denied', { errorKey: 'PERMISSION_DENIED' });
    } catch (err) {
      caught = err;
    }
    expect(isHttpError(caught)).toBe(true);
    const logError = vi.fn();
    const result = await handleError({
      kind: 'app',
      error: caught,
      event: { locals: { appContext: { logger: { error: logError } } } }
    } as never);

    expect(result).toBeUndefined();
    expect(logError).not.toHaveBeenCalled();
    expect(caught).toMatchObject({ status: 403, body: { message: 'Permission denied' } });
  });
});
