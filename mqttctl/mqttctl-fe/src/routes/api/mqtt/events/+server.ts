import { handleApiError } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';
import type { MqttExplorerState, MqttLatestMessage } from '$lib/types';

export const GET = async (event) => {
  try {
    const { sessionKey } = requireMqttSessionUser({ event });
    const encoder = new TextEncoder();
    let cleanup = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream({
      start: (controller) => {
        const send = (explorer: MqttExplorerState) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ explorer })}\n\n`));
        };
        const sendMessage = (message: MqttLatestMessage) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: mqtt-message\ndata: ${JSON.stringify({ message })}\n\n`));
        };

        cleanup = event.locals.appContext.mqtt.watchSession({
          sessionKey,
          correlationId: event.locals.correlationId,
          listener: send,
          messageListener: sendMessage
        });

        heartbeat = setInterval(() => {
          if (closed) return;
          void (async () => {
            try {
              if (event.locals.currentUser?.role === 'mcp') {
                await event.locals.appContext.mcpAuth.assertPrincipalEnabled({
                  correlationId: event.locals.correlationId
                });
              }
              if (!closed) controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              if (closed) return;
              closed = true;
              if (heartbeat) clearInterval(heartbeat);
              cleanup();
              controller.close();
            }
          })();
        }, 15_000);

        event.request.signal.addEventListener('abort', () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          cleanup();
        });
      },
      cancel: () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        cleanup();
      }
    });

    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream'
      }
    });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
