import { error } from '@sveltejs/kit';
import type { AuthenticatedUser } from '$server/auth/types';
import { resolveErrorCode } from '$server/logging/errors';
import { hasCapability, type Capability } from '$server/permissions';

export const requirePageCapability = ({
  user,
  capability,
  correlationId
}: {
  user: AuthenticatedUser | null;
  capability: Capability;
  correlationId: string | null;
}) => {
  if (hasCapability({ user, capability })) return;

  const isAuthenticated = Boolean(user);
  const errorKey = isAuthenticated ? 'PERMISSION_DENIED' : 'AUTH_UNAUTHENTICATED';

  throw error(isAuthenticated ? 403 : 401, {
    message: isAuthenticated ? `User lacks ${capability} capability.` : 'Authentication is required.',
    correlationId,
    errorKey,
    errorCode: resolveErrorCode({ errorKey })
  });
};
