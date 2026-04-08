import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';
import { userRoles } from '$lib/types';

const updateUserSchema = z.object({
  email: z.string().email().nullable(),
  role: z.enum(userRoles),
  disabled: z.boolean(),
  password: z.string().min(1).nullable()
});

export const PATCH = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_users',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: updateUserSchema });
    await event.locals.appContext.auth.updateUser({
      userId: event.params.id,
      ...payload,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'user.update',
      targetType: 'app_user',
      targetId: event.params.id,
      afterSummary: payload,
      commandResult: { updated: true },
      success: true
    });

    return ok({ data: { updated: true } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

export const DELETE = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_users',
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.auth.deleteUser({ userId: event.params.id });
    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'user.delete',
      targetType: 'app_user',
      targetId: event.params.id,
      commandResult: { deleted: true },
      success: true
    });

    return ok({ data: { deleted: true } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

