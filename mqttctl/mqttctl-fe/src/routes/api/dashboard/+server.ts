import { ok, handleApiError } from '$server/http';
import { loadDashboardPageData } from '$lib/server/dashboard/data';
import { requireCapability } from '$server/permissions';

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    return ok({
      data: await loadDashboardPageData({
        appContext: event.locals.appContext,
        correlationId: event.locals.correlationId,
        currentUser: event.locals.currentUser
      })
    });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
