import { requirePageCapability } from '$lib/server/page-permissions';
import { auditEntryLimitOptions, parseAuditEntryLimitValue } from '$server/audit/service';
import { getHttpApiClientBasePath } from '$server/config/http-api';

export const load = async ({ locals, url }) => {
  requirePageCapability({
    user: locals.currentUser,
    capability: 'view_audit',
    correlationId: locals.correlationId
  });

  const limitValue = parseAuditEntryLimitValue({ value: url.searchParams.get('limit') });
  const page = await locals.appContext.audit.listEntries({ limitValue });
  const apiBasePath = getHttpApiClientBasePath({ runtimeConfig: locals.appContext.runtimeConfig });

  return {
    ...page,
    limitOptions: auditEntryLimitOptions,
    exportUrl: `${apiBasePath}/audit?limit=${limitValue}&download=1`
  };
};
