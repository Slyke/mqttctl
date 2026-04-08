import { hasCapability } from '$server/permissions';

export const load = async ({ locals }) => {
  const canManageBroker = hasCapability({
    user: locals.currentUser,
    capability: 'manage_broker'
  });

  let configText = '';
  let loadError: string | null = null;

  if (canManageBroker) {
    try {
      configText = await locals.appContext.brokerConfig.readCurrentBrokerConfig({
        correlationId: locals.correlationId
      });
    } catch (caught) {
      loadError = caught instanceof Error ? caught.message : 'Failed reading broker config.';
    }
  }

  return {
    canManageBroker,
    configText,
    loadError
  };
};
