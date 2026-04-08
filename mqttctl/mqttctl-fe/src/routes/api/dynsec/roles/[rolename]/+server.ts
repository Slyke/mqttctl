import { z } from 'zod';
import { dynsecAclTypes } from '$lib/types';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const updateRoleSchema = z.union([
  z.object({
    action: z.literal('addAcl'),
    acltype: z.enum(dynsecAclTypes),
    acltypes: z.undefined().optional(),
    topic: z.string().min(1),
    allow: z.boolean(),
    priority: z.number().int()
  }),
  z.object({
    action: z.literal('addAcl'),
    acltype: z.undefined().optional(),
    acltypes: z.array(z.enum(dynsecAclTypes)).min(1),
    topic: z.string().min(1),
    allow: z.boolean(),
    priority: z.number().int()
  }),
  z.object({
    action: z.literal('removeAcl'),
    acltype: z.enum(dynsecAclTypes),
    topic: z.string().min(1)
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

    const payload = await parseRequestJson({ event, schema: updateRoleSchema });

    if (payload.action === 'addAcl') {
      const acltypes = 'acltypes' in payload && Array.isArray(payload.acltypes)
        ? payload.acltypes
        : payload.acltype
          ? [payload.acltype]
          : [];

      if (!acltypes.length) {
        throw new Error('At least one ACL type is required.');
      }

      await event.locals.appContext.dynsec.addRoleAcls({
        rolename: event.params.rolename,
        acltypes,
        topic: payload.topic,
        allow: payload.allow,
        priority: payload.priority,
        correlationId: event.locals.correlationId
      });
    }

    if (payload.action === 'removeAcl') {
      await event.locals.appContext.dynsec.removeRoleAcl({
        rolename: event.params.rolename,
        acltype: payload.acltype,
        topic: payload.topic,
        correlationId: event.locals.correlationId
      });
    }

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: `dynsec.role.${payload.action}`,
      targetType: 'dynsec_role',
      targetId: event.params.rolename,
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

    await event.locals.appContext.dynsec.deleteRole({
      rolename: event.params.rolename,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'dynsec.role.delete',
      targetType: 'dynsec_role',
      targetId: event.params.rolename,
      commandResult: { deleted: true },
      success: true
    });

    return ok({ data: { deleted: true } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
