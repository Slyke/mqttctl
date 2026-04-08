import { getAppContext } from '$server/context';
import { createCorrelationId } from '$server/utils/ids';
import { patchDashboardWebSocketHttpServer } from './lib/server/dashboard/realtime-node';
import { dashboardWebSocketRuntime } from './lib/server/dashboard/ws-runtime';

patchDashboardWebSocketHttpServer({
  loadRuntime: async () => dashboardWebSocketRuntime
});

const startupCorrelationId = createCorrelationId();

try {
  await getAppContext({ correlationId: startupCorrelationId });
} catch (error) {
  console.error('mqttctl startup initialization failed.', {
    correlationId: startupCorrelationId,
    error
  });
  throw error;
}
