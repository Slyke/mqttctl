import { z } from 'zod';
import { handleApiError, ok, parseRequestJson } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';

const publishSchema = z.object({
  topic: z.string().min(1),
  payload: z.string(),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  retain: z.boolean().default(false)
});

export const POST = async (event) => {
  try {
    const { sessionKey, sourceIp } = requireMqttSessionUser({
      event,
      requireOrigin: true
    });
    const payload = await parseRequestJson({ event, schema: publishSchema });
    const explorer = await event.locals.appContext.mqtt.publish({
      sessionKey,
      input: payload,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp,
      correlationId: event.locals.correlationId,
      action: 'mqtt.explorer.publish',
      targetType: 'mqtt-topic',
      targetId: payload.topic,
      afterSummary: {
        topic: payload.topic,
        qos: payload.qos,
        retain: payload.retain
      },
      commandResult: {
        payloadBytes: Buffer.byteLength(payload.payload, 'utf8')
      },
      success: true
    });

    return ok({ data: { explorer } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
