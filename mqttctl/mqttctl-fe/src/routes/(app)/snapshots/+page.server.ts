import { requirePageCapability } from '$lib/server/page-permissions';

export const load = async ({ locals }) => {
  requirePageCapability({
    user: locals.currentUser,
    capability: 'manage_snapshots',
    correlationId: locals.correlationId
  });

  return {
    snapshots: await locals.appContext.snapshots.listSnapshots()
  };
};
