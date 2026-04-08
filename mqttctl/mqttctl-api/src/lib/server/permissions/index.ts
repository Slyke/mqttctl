import type { AuthenticatedUser } from '$server/auth/types';
import type { UserRole } from '$lib/types';
import { createAppError } from '$server/logging/errors';

export const capabilities = [
  'read',
  'operate',
  'manage_broker',
  'manage_security',
  'manage_users',
  'view_audit',
  'manage_snapshots'
] as const;

export type Capability = (typeof capabilities)[number];

const roleCapabilities: Record<UserRole, Capability[]> = {
  viewer: ['read'],
  operator: ['read', 'operate', 'view_audit', 'manage_snapshots'],
  security_admin: ['read', 'manage_security', 'view_audit', 'manage_snapshots'],
  broker_admin: ['read', 'operate', 'manage_broker', 'view_audit', 'manage_snapshots'],
  super_admin: ['read', 'operate', 'manage_broker', 'manage_security', 'manage_users', 'view_audit', 'manage_snapshots']
};

export const hasCapability = ({ user, capability }: { user: AuthenticatedUser | null; capability: Capability }) => {
  if (!user) return false;
  return roleCapabilities[user.role].includes(capability);
};

export const requireCapability = ({
  user,
  capability,
  correlationId
}: {
  user: AuthenticatedUser | null;
  capability: Capability;
  correlationId: string | null;
}) => {
  if (hasCapability({ user, capability })) return;

  throw createAppError({
    caller: 'permissions::requireCapability',
    reason: user ? `User lacks ${capability} capability.` : 'Authentication is required.',
    errorKey: user ? 'PERMISSION_DENIED' : 'AUTH_UNAUTHENTICATED',
    correlationId,
    status: user ? 403 : 401
  });
};

