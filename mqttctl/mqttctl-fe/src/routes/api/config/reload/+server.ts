import { handleApiError, ok, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';
import { refreshDashboardSnapshot } from '$lib/server/dashboard/live-state';

export const POST = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_broker',
      correlationId: event.locals.correlationId
    });

    const result = await event.locals.appContext.jobs.enqueue({
      name: 'broker-reload',
      run: async () => await event.locals.appContext.brokerConfig.reloadBroker({
        correlationId: event.locals.correlationId
      })
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'broker.reload',
      targetType: 'broker',
      targetId: null,
      commandResult: result,
      success: true
    });

    await refreshDashboardSnapshot({
      appContext: event.locals.appContext,
      correlationId: event.locals.correlationId
    });

    return ok({ data: { result } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
