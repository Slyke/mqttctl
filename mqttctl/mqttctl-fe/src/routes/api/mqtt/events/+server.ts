import { handleApiError } from '$server/http';
import { requireMqttSessionUser } from '$lib/server/mqtt/access';
import type { MqttExplorerState } from '$lib/types';

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

        cleanup = event.locals.appContext.mqtt.watchSession({
          sessionKey,
          correlationId: event.locals.correlationId,
          listener: send
        });

        heartbeat = setInterval(() => {
          if (closed) return;
          controller.enqueue(encoder.encode(': ping\n\n'));
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
