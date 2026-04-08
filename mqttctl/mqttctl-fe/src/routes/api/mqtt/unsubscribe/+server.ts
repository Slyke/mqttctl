import { z } from 'zod';
import { handleApiError, ok, parseRequestJson } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';

const unsubscribeSchema = z.object({
  filter: z.string().min(1)
});

export const POST = async (event) => {
  try {
    const { sessionKey, sourceIp } = requireMqttSessionUser({
      event,
      requireOrigin: true
    });
    const payload = await parseRequestJson({ event, schema: unsubscribeSchema });
    const explorer = await event.locals.appContext.mqtt.unsubscribe({
      sessionKey,
      filter: payload.filter,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp,
      correlationId: event.locals.correlationId,
      action: 'mqtt.explorer.unsubscribe',
      targetType: 'mqtt-subscription',
      targetId: payload.filter,
      success: true
    });

    return ok({ data: { explorer } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
