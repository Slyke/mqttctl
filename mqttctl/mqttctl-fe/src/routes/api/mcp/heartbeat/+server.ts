import { z } from 'zod';
import { handleApiError, ok, parseRequestJson } from '$server/http';
import { mcpServiceSubject } from '$server/auth/mcp';
import { refreshDashboardMcpRuntime } from '$lib/server/dashboard/live-state';

const heartbeatSchema = z.object({
  version: z.string().min(1).max(128),
  buildHash: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  startedAt: z.string().datetime(),
  heartbeatAt: z.string().datetime()
}).strict();

export const POST = async (event) => {
  try {
    const principal = event.locals.currentUser;
    if (
      principal?.role !== 'mcp'
      || principal.delegatedIdentity?.clientName !== mcpServiceSubject
    ) {
      return new Response(null, { status: 404 });
    }

    const payload = await parseRequestJson({ event, schema: heartbeatSchema });
    event.locals.appContext.mcpAuth.recordHeartbeat({ input: payload });
    await refreshDashboardMcpRuntime({ appContext: event.locals.appContext });

    return ok({
      data: {
        runtime: await event.locals.appContext.mcpAuth.getRuntimeInfo(),
        signingKey: event.locals.appContext.mcpAuth.getPublicKeyMetadata()
      }
    });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
