import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const createRoleSchema = z.object({
  rolename: z.string().trim().min(1)
});

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const state = await event.locals.appContext.dynsec.readState({ correlationId: event.locals.correlationId });
    return ok({ data: { roles: state.roles } });
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

    const payload = await parseRequestJson({ event, schema: createRoleSchema });
    await event.locals.appContext.dynsec.createRole({
      rolename: payload.rolename,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'dynsec.role.create',
      targetType: 'dynsec_role',
      targetId: payload.rolename,
      afterSummary: payload,
      commandResult: { created: true },
      success: true
    });

    return ok({ data: { created: true }, status: 201 });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
