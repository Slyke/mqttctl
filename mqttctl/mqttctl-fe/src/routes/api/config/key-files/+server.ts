import { handleApiError, ok } from '$server/http';
import { requireCapability } from '$server/permissions';

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const [files, brokerAgentRuntimeInfo] = await Promise.all([
      event.locals.appContext.brokerConfig.listManagedKeyFiles({
        correlationId: event.locals.correlationId
      }),
      event.locals.appContext.brokerConfig.readBrokerAgentRuntimeInfo({
        correlationId: event.locals.correlationId
      })
    ]);

    return ok({ data: { files, brokerAgentRuntimeInfo } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
