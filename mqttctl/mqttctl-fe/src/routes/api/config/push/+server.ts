import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';
import { refreshDashboardSnapshot } from '$lib/server/dashboard/live-state';

const brokerConfigSchema = z.object({
  rendered: z.string(),
  expectedCurrent: z.string()
});

export const POST = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_broker',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: brokerConfigSchema });
    const result = await event.locals.appContext.jobs.enqueue({
      name: 'broker-config-push',
      run: async () => await event.locals.appContext.brokerConfig.pushBrokerConfig({
        rendered: payload.rendered,
        expectedCurrent: payload.expectedCurrent,
        actorUsername: event.locals.currentUser?.username ?? null,
        correlationId: event.locals.correlationId
      })
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'broker.config.push',
      targetType: 'broker_config',
      targetId: null,
      afterSummary: {
        bytes: Buffer.byteLength(payload.rendered, 'utf8')
      },
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
