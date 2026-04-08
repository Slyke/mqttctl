import { requirePageCapability } from '$lib/server/page-permissions';
import { auditEntryLimitOptions, parseAuditEntryLimitValue } from '$server/audit/service';

export const load = async ({ locals, url }) => {
  requirePageCapability({
    user: locals.currentUser,
    capability: 'view_audit',
    correlationId: locals.correlationId
  });

  const limitValue = parseAuditEntryLimitValue({ value: url.searchParams.get('limit') });
  const page = await locals.appContext.audit.listEntries({ limitValue });

  return {
    ...page,
    limitOptions: auditEntryLimitOptions,
    exportUrl: `${locals.appContext.runtimeConfig.config.basePath}/api/audit?limit=${limitValue}&download=1`
  };
};
