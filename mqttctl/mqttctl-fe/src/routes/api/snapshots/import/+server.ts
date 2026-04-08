import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const importSchema = z.object({
  payload: z.unknown(),
  apply: z.boolean().default(false)
});

export const POST = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_snapshots',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: importSchema });
    const result = payload.apply
      ? await event.locals.appContext.snapshots.applyImport({
          payload: payload.payload,
          actorUsername: event.locals.currentUser?.username ?? null,
          correlationId: event.locals.correlationId
        })
      : event.locals.appContext.snapshots.previewImport({
          payload: payload.payload
        });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: payload.apply ? 'snapshot.import.apply' : 'snapshot.import.preview',
      targetType: 'snapshot',
      targetId: null,
      afterSummary: result,
      commandResult: { imported: payload.apply },
      success: true
    });

    return ok({ data: { result } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

