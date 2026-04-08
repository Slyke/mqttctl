import { loadDashboardPageData } from '$lib/server/dashboard/data';

export const load = async ({ locals }) => await loadDashboardPageData({
  appContext: locals.appContext,
  correlationId: locals.correlationId,
  currentUser: locals.currentUser
});
