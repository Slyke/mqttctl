import type { AuthenticatedUser } from '$server/auth/types';
import { hasCapability, type Capability } from '$server/permissions';

interface AppNavDefinition {
  href: string;
  label: string;
  capability: Capability;
}

export interface AppNavItem {
  href: string;
  label: string;
}

const appNavDefinitions: AppNavDefinition[] = [
  { href: '/dashboard', label: 'Dashboard', capability: 'read' },
  { href: '/app-users', label: 'App Users', capability: 'manage_users' },
  { href: '/dynsec', label: 'DynSec', capability: 'read' },
  { href: '/mqtt', label: 'MQTT', capability: 'read' },
  { href: '/config', label: 'MQTT Config', capability: 'read' },
  { href: '/audit', label: 'Audit', capability: 'view_audit' },
  { href: '/snapshots', label: 'Snapshots', capability: 'manage_snapshots' }
];

export const buildAppNavItems = ({
  user
}: {
  user: AuthenticatedUser | null;
}): AppNavItem[] => appNavDefinitions
  .filter((item) => hasCapability({ user, capability: item.capability }))
  .map(({ href, label }) => ({ href, label }));
