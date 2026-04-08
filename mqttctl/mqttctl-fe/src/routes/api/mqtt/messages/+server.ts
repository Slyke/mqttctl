import { z } from 'zod';
import { handleApiError, ok, parseRequestJson } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';

const latestTopicsMutationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('clear')
  }),
  z.object({
    action: z.literal('set_limit'),
    limit: z.union([
      z.literal(5),
      z.literal(10),
      z.literal(20),
      z.literal(25),
      z.literal(100),
      z.null()
    ])
  })
]);

export const POST = async (event) => {
  try {
    const { sessionKey, sourceIp } = requireMqttSessionUser({
      event,
      requireOrigin: true
    });
    const payload = await parseRequestJson({
      event,
      schema: latestTopicsMutationSchema
    });

    const explorer = payload.action === 'clear'
      ? await event.locals.appContext.mqtt.clearMessages({
          sessionKey,
          correlationId: event.locals.correlationId
        })
      : await event.locals.appContext.mqtt.setTrackedTopicsLimit({
          sessionKey,
          limit: payload.limit,
          correlationId: event.locals.correlationId
        });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp,
      correlationId: event.locals.correlationId,
      action: payload.action === 'clear'
        ? 'mqtt.explorer.clear_latest_topics'
        : 'mqtt.explorer.set_latest_topics_limit',
      targetType: 'mqtt-session',
      targetId: sessionKey,
      afterSummary: {
        trackedTopics: explorer.stats.trackedTopics,
        totalMessages: explorer.stats.totalMessages,
        trackedTopicsLimit: explorer.stats.trackedTopicsLimit
      },
      commandResult: {
        action: payload.action,
        limit: payload.action === 'set_limit' ? payload.limit : undefined
      },
      success: true
    });

    return ok({ data: { explorer } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
