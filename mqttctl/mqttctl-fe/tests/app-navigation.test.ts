import { describe, expect, it } from 'vitest';
import { buildAppNavItems } from '$lib/server/app-navigation';
import type { AuthenticatedUser } from '$server/auth/types';

const createUser = (role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: 'user-1',
  username: 'tester',
  email: null,
  role,
  authSource: 'local'
});

describe('buildAppNavItems', () => {
  it('shows only accessible routes for viewer accounts', () => {
    expect(buildAppNavItems({ user: createUser('viewer') })).toEqual([
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/dynsec', label: 'DynSec' },
      { href: '/mqtt', label: 'MQTT' },
      { href: '/config', label: 'MQTT Config' }
    ]);
  });

  it('shows every route for super admins', () => {
    expect(buildAppNavItems({ user: createUser('super_admin') })).toEqual([
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/app-users', label: 'App Users' },
      { href: '/dynsec', label: 'DynSec' },
      { href: '/mqtt', label: 'MQTT' },
      { href: '/config', label: 'MQTT Config' },
      { href: '/audit', label: 'Audit' },
      { href: '/snapshots', label: 'Snapshots' }
    ]);
  });
});
