import { Buffer } from 'node:buffer';
import { handleApiError, ok } from '$server/http';
import { parseAuditEntryLimitValue } from '$server/audit/service';
import { requireCapability } from '$server/permissions';

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'view_audit',
      correlationId: event.locals.correlationId
    });

    const limitValue = parseAuditEntryLimitValue({ value: event.url.searchParams.get('limit') });
    const download = event.url.searchParams.get('download') === '1';
    const auditLog = await event.locals.appContext.audit.exportEntries({
      limitValue,
      buildLabel: event.locals.appContext.buildInfo.label
    });

    if (download) {
      const payload = JSON.stringify(auditLog);
      return new Response(payload, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="mqttctl-audit-${limitValue}.json"`,
          'content-length': String(Buffer.byteLength(payload, 'utf8')),
          'content-type': 'application/json; charset=utf-8'
        }
      });
    }

    return ok({ data: { auditLog } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
