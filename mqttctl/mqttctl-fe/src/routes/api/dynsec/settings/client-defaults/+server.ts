import { z } from 'zod';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';

const clientDefaultsSchema = z.object({
  defaultRoleName: z.string().trim().min(1).nullable(),
  defaultRolePriority: z.number().int().default(0)
});

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const settings = await event.locals.appContext.dynsec.getClientDefaults();
    return ok({
      data: {
        defaultRoleName: settings.defaultRoleName,
        defaultRolePriority: settings.defaultRolePriority
      }
    });
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

    const beforeSummary = await event.locals.appContext.dynsec.getClientDefaults();
    const payload = await parseRequestJson({ event, schema: clientDefaultsSchema });
    const settings = await event.locals.appContext.dynsec.setClientDefaults({ value: payload });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'dynsec.settings.clientDefaults.update',
      targetType: 'dynsec_settings',
      targetId: 'clientDefaults',
      beforeSummary,
      afterSummary: settings,
      commandResult: { updated: true },
      success: true
    });

    return ok({
      data: {
        defaultRoleName: settings.defaultRoleName,
        defaultRolePriority: settings.defaultRolePriority
      }
    });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
