import { handleApiError, ok } from '$server/http';
import { requireCapability } from '$server/permissions';

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_broker',
      correlationId: event.locals.correlationId
    });

    const current = await event.locals.appContext.brokerConfig.readCurrentBrokerConfig({
      correlationId: event.locals.correlationId
    });

    return ok({ data: { current } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
