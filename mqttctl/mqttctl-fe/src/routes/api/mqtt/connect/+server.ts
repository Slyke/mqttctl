import { z } from 'zod';
import { handleApiError, ok, parseRequestJson } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';
import { requireCapability } from '$server/permissions';

const connectSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean().default(false),
  authMode: z.enum(['dynsec_client', 'custom']),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  clientId: z.string().min(1).optional()
}).superRefine((value, context) => {
  if (!value.username) {
    context.addIssue({
      code: 'custom',
      message: 'username is required for MQTT credentials.',
      path: ['username']
    });
  }

  if (value.authMode === 'custom' && !value.password) {
    context.addIssue({
      code: 'custom',
      message: 'password is required for custom MQTT credentials.',
      path: ['password']
    });
  }

  if (!value.clientId) {
    context.addIssue({
      code: 'custom',
      message: 'clientId is required for MQTT credentials.',
      path: ['clientId']
    });
  }
});

export const POST = async (event) => {
  try {
    const { sessionKey, sourceIp } = requireMqttSessionUser({
      event,
      requireOrigin: true
    });
    const payload = await parseRequestJson({ event, schema: connectSchema });

    if (payload.authMode === 'dynsec_client') {
      requireCapability({
        user: event.locals.currentUser,
        capability: 'manage_broker',
        correlationId: event.locals.correlationId
      });
    }

    const explorer = await event.locals.appContext.mqtt.connect({
      sessionKey,
      input: payload,
      correlationId: event.locals.correlationId
    });

    await event.locals.appContext.audit.record({
      actor: event.locals.currentUser,
      authMode: event.locals.currentUser?.authSource ?? null,
      sourceIp,
      correlationId: event.locals.correlationId,
      action: 'mqtt.explorer.connect',
      targetType: 'mqtt-session',
      targetId: sessionKey,
      afterSummary: {
        host: explorer.connection.host,
        port: explorer.connection.port,
        tls: explorer.connection.tls,
        authMode: explorer.connection.authMode,
        username: explorer.connection.username,
        clientId: explorer.connection.clientId
      },
      commandResult: {
        state: explorer.connection.state
      },
      success: true
    });

    return ok({ data: { explorer } });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
