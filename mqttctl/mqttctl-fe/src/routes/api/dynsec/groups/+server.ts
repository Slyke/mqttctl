import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const createGroupSchema = z.object({
  groupname: z.string().trim().min(1)
});

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const state = await event.locals.appContext.dynsec.readState({ correlationId: event.locals.correlationId });
    return ok({ data: { groups: state.groups } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

export const POST = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_security',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: createGroupSchema });
    await event.locals.appContext.dynsec.createGroup({
      groupname: payload.groupname,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'dynsec.group.create',
      targetType: 'dynsec_group',
      targetId: payload.groupname,
      afterSummary: payload,
      commandResult: { created: true },
      success: true
    });

    return ok({ data: { created: true }, status: 201 });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
