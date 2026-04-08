import { handleApiError, ok } from '$server/http';
import { requireCapability } from '$server/permissions';

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const files = await event.locals.appContext.brokerConfig.listManagedKeyFiles({
      correlationId: event.locals.correlationId
    });

    return ok({ data: { files } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
