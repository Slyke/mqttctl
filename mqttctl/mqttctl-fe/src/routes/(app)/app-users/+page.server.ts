import { requirePageCapability } from '$lib/server/page-permissions';

export const load = async ({ locals }) => {
  requirePageCapability({
    user: locals.currentUser,
    capability: 'manage_users',
    correlationId: locals.correlationId
  });

  return {
    users: await locals.appContext.auth.listUsers()
  };
};
