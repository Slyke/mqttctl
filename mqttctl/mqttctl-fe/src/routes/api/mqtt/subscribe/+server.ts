import { z } from 'zod';
import { handleApiError, ok, parseRequestJson } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';

const subscribeSchema = z.object({
  filter: z.string().min(1),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)])
});

export const POST = async (event) => {
  try {
    const { sessionKey, sourceIp } = requireMqttSessionUser({
      event,
      requireOrigin: true
    });
    const payload = await parseRequestJson({ event, schema: subscribeSchema });
    const explorer = await event.locals.appContext.mqtt.subscribe({
      sessionKey,
      filter: payload.filter,
      qos: payload.qos,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp,
      correlationId: event.locals.correlationId,
      action: 'mqtt.explorer.subscribe',
      targetType: 'mqtt-subscription',
      targetId: payload.filter,
      afterSummary: payload,
      success: true
    });

    return ok({ data: { explorer } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
