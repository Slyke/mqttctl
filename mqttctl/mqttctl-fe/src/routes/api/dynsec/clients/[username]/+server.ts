import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';
import { dynsecAclTypes } from '$lib/types';

const updateClientSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('setEnabled'),
    enabled: z.boolean()
  }),
  z.object({
    action: z.literal('setPassword'),
    password: z.string().min(1)
  }),
  z.object({
    action: z.literal('assignRole'),
    rolename: z.string().min(1),
    priority: z.number().int()
  }),
  z.object({
    action: z.literal('removeRole'),
    rolename: z.string().min(1)
  }),
  z.object({
    action: z.literal('addGroup'),
    groupname: z.string().min(1),
    priority: z.number().int()
  }),
  z.object({
    action: z.literal('removeGroup'),
    groupname: z.string().min(1)
  })
]);

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const effective = await event.locals.appContext.dynsec.getEffectivePermissions({
      username: event.params.username,
      correlationId: event.locals.correlationId
    });

    return ok({ data: { effective } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

export const PATCH = async (event) => {
  try {
    requireSameOrigin({ event });
    requireCapability({
      user: event.locals.currentUser,
      capability: 'manage_security',
      correlationId: event.locals.correlationId
    });

    const payload = await parseRequestJson({ event, schema: updateClientSchema });

    if (payload.action === 'setEnabled') {
      await event.locals.appContext.dynsec.setClientEnabled({
        username: event.params.username,
        enabled: payload.enabled,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'setPassword') {
      await event.locals.appContext.dynsec.setClientPassword({
        username: event.params.username,
        password: payload.password,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'assignRole') {
      await event.locals.appContext.dynsec.assignClientRole({
        username: event.params.username,
        rolename: payload.rolename,
        priority: payload.priority,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'removeRole') {
      await event.locals.appContext.dynsec.removeClientRole({
        username: event.params.username,
        rolename: payload.rolename,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'addGroup') {
      await event.locals.appContext.dynsec.addGroupClient({
        groupname: payload.groupname,
        username: event.params.username,
        priority: payload.priority,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'removeGroup') {
      await event.locals.appContext.dynsec.removeGroupClient({
        groupname: payload.groupname,
        username: event.params.username,
        correlationId: event.locals.correlationId
      });
    }

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: `dynsec.client.${payload.action}`,
      targetType: 'dynsec_client',
      targetId: event.params.username,
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

    await event.locals.appContext.dynsec.deleteClient({
      username: event.params.username,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'dynsec.client.delete',
      targetType: 'dynsec_client',
      targetId: event.params.username,
      commandResult: { deleted: true },
      success: true
    });

    return ok({ data: { deleted: true } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};

