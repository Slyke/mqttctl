import { z } from 'zod';
import { capabilities } from '$server/permissions';
import { handleApiError, ok, parseRequestJson, requireSameOrigin, getSourceIp } from '$server/http';
import { requireCapability } from '$server/permissions';
import { refreshDashboardMcpRuntime } from '$lib/server/dashboard/live-state';

const assignableMcpCapabilities = capabilities.filter((capability) => capability !== 'manage_mcp');

const updateMcpAccessSchema = z.object({
  disabled: z.boolean(),
  allowedCapabilities: z.array(z.enum(assignableMcpCapabilities)).max(assignableMcpCapabilities.length)
}).strict();

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: event.locals.currentUser?.role === 'mcp' ? 'read' : 'manage_mcp',
      correlationId: event.locals.correlationId
    });

    return ok({
      data: {
        access: await event.locals.appContext.mcpAuth.getAccessState(),
        assignableCapabilities: assignableMcpCapabilities
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
      capability: 'manage_mcp',
      correlationId: event.locals.correlationId
    });

    const before = await event.locals.appContext.mcpAuth.getAccessState();
    const payload = await parseRequestJson({ event, schema: updateMcpAccessSchema });
    await event.locals.appContext.mcpAuth.setAccess(payload);
    const after = await event.locals.appContext.mcpAuth.getAccessState();
    await refreshDashboardMcpRuntime({ appContext: event.locals.appContext });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp: getSourceIp({ event }),
      correlationId: event.locals.correlationId,
      action: 'mcp.access.update',
      targetType: 'app_user',
      targetId: after.id,
      beforeSummary: before,
      afterSummary: after,
      commandResult: { updated: true },
      success: true
    });

    return ok({ data: { access: after, assignableCapabilities: assignableMcpCapabilities } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
