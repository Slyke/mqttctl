import { ok, handleApiError } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';

export const GET = async (event) => {
  try {
    const { sessionKey } = requireMqttSessionUser({ event });
    const explorer = event.locals.appContext.mqtt.getExplorerState({ sessionKey });
    return ok({ data: { explorer } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
