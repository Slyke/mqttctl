import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const exportSchema = z.object({
  kind: z.enum(['dynsec', 'broker-config', 'combined']),
  note: z.string().nullable().optional()
});

export const POST = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_snapshots',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: exportSchema });
    const snapshot = await event.locals.appContext.snapshots.exportSnapshot({
      kind: payload.kind,
      actorUsername: event.locals.currentUser?.username ?? null,
      note: payload.note ?? null,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'snapshot.export',
      targetType: 'snapshot',
      targetId: snapshot.snapshot.id,
      afterSummary: {
        title: snapshot.title,
        type: snapshot.type,
        exportTime: snapshot.exportTime,
        build: snapshot.build,
        ...snapshot.snapshot
      },
      commandResult: { exported: true },
      success: true
    });

    return ok({ data: { snapshot } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
