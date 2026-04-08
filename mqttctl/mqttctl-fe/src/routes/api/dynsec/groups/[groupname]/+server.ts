import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const updateGroupSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('addClient'),
    username: z.string().min(1),
    priority: z.number().int()
  }),
  z.object({
    action: z.literal('removeClient'),
    username: z.string().min(1)
  }),
  z.object({
    action: z.literal('addRole'),
    rolename: z.string().min(1),
    priority: z.number().int()
  }),
  z.object({
    action: z.literal('removeRole'),
    rolename: z.string().min(1)
  })
]);

export const PATCH = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_security',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: updateGroupSchema });

    if (payload.action === 'addClient') {
      await event.locals.appContext.dynsec.addGroupClient({
        groupname: event.params.groupname,
        username: payload.username,
        priority: payload.priority,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'removeClient') {
      await event.locals.appContext.dynsec.removeGroupClient({
        groupname: event.params.groupname,
        username: payload.username,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'addRole') {
      await event.locals.appContext.dynsec.addGroupRole({
        groupname: event.params.groupname,
        rolename: payload.rolename,
        priority: payload.priority,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'removeRole') {
      await event.locals.appContext.dynsec.removeGroupRole({
        groupname: event.params.groupname,
        rolename: payload.rolename,
        correlationId: event.locals.correlationId
      });
    }

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: `dynsec.group.${payload.action}`,
      targetType: 'dynsec_group',
      targetId: event.params.groupname,
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
      capability: 'manage_security',
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.dynsec.deleteGroup({
      groupname: event.params.groupname,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'dynsec.group.delete',
      targetType: 'dynsec_group',
      targetId: event.params.groupname,
      commandResult: { deleted: true },
      success: true
    });

    return ok({ data: { deleted: true } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

