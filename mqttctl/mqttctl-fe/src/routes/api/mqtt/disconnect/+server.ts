import { handleApiError, ok } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';

export const POST = async (event) => {
  try {
    const { sessionKey, sourceIp } = requireMqttSessionUser({
      event,
      requireOrigin: true
    });
    const explorer = await event.locals.appContext.mqtt.disconnect({
      sessionKey,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp,
      correlationId: event.locals.correlationId,
      action: 'mqtt.explorer.disconnect',
      targetType: 'mqtt-session',
      targetId: sessionKey,
      commandResult: {
        state: explorer.connection.state
      },
      success: true
    });

    return ok({ data: { explorer } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
