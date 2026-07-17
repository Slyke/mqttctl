import { requirePageCapability } from '$lib/server/page-permissions';
import { hasCapability } from '$server/permissions';

export const load = async ({ locals }) => {
  requirePageCapability({
    user: locals.currentUser,
    capability: 'manage_users',
    correlationId: locals.correlationId
  });

  const canManageMcp = hasCapability({
    user: locals.currentUser,
    capability: 'manage_mcp'
  });
  const mcpConfigured = locals.appContext.mcpAuth.isConfigured();

  return {
    users: await locals.appContext.auth.listUsers(),
    canManageMcp,
    mcpConfigured,
    mcpAccess: canManageMcp && mcpConfigured
      ? await locals.appContext.mcpAuth.getAccessState()
      : null
  };
};
