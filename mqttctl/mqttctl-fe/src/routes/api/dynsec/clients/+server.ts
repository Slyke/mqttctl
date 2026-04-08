import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const createClientSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1).nullable().optional(),
  disabled: z.boolean().default(false)
});

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const state = await event.locals.appContext.dynsec.readState({ correlationId: event.locals.correlationId });
    return ok({ data: { clients: state.clients } });
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

    const payload = await parseRequestJson({ event, schema: createClientSchema });
    const result = await event.locals.appContext.dynsec.createClient({
      username: payload.username,
      password: payload.password ?? null,
      clientId: payload.clientId ?? null,
      disabled: payload.disabled,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'dynsec.client.create',
      targetType: 'dynsec_client',
      targetId: payload.username,
      afterSummary: {
        username: payload.username,
        clientId: payload.clientId ?? null,
        disabled: payload.disabled,
        defaultRoleName: result.defaultRoleName,
        defaultRolePriority: result.defaultRolePriority,
        defaultRoleApplied: result.defaultRoleApplied
      },
      commandResult: {
        created: true,
        defaultRoleName: result.defaultRoleName,
        defaultRolePriority: result.defaultRolePriority,
        defaultRoleApplied: result.defaultRoleApplied
      },
      success: true
    });

    return ok({ data: { created: true }, status: 201 });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
