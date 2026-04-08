import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin } from '$server/http';
import { requireCapability } from '$server/permissions';
import { userRoles } from '$lib/types';
import { getSourceIp } from '$server/http';

const createUserSchema = z.object({
  username: z.string().min(1),
  email: z.string().email().nullable().optional(),
  password: z.string().min(1).nullable().optional(),
  role: z.enum(userRoles)
});

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_users',
      correlationId: event.locals.correlationId
    });

    const users = await event.locals.appContext.auth.listUsers();
    return ok({ data: { users } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

export const POST = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_users',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: createUserSchema });
    await event.locals.appContext.auth.createUser({
      ...payload,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'user.create',
      targetType: 'app_user',
      targetId: payload.username,
      afterSummary: payload,
      commandResult: { created: true },
      success: true
    });

    return ok({ data: { created: true }, status: 201 });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
