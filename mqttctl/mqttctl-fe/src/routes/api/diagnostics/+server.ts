import { handleApiError, ok } from '$server/http';
import { requireCapability } from '$server/permissions';
import { loadDashboardDiagnostics } from '$lib/server/dashboard/data';

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const diagnostics = await loadDashboardDiagnostics({
      appContext: event.locals.appContext,
      correlationId: event.locals.correlationId
    });

    return ok({ data: { diagnostics } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
