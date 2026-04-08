import { sveltekit } from '@sveltejs/kit/vite';
// @ts-expect-error Vite config runs under native ESM, so this import needs the explicit .ts extension.
import { attachDashboardWebSocketServer } from './src/lib/server/dashboard/realtime-node.ts';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'mqttctl-dashboard-websocket',
      configureServer(server) {
        void server.ssrLoadModule('/src/instrumentation.server.ts').catch((error) => {
          console.error('Failed preloading server instrumentation during Vite startup.', error);
          process.exit(1);
        });

        attachDashboardWebSocketServer({
          server: server.httpServer,
          loadRuntime: async () => {
            const runtimeModule = await server.ssrLoadModule('/src/lib/server/dashboard/ws-runtime.ts');
            return runtimeModule.dashboardWebSocketRuntime;
          }
        });
      }
    },
    sveltekit()
  ],
  server: {
    fs: {
      allow: ['..']
    },
    allowedHosts: [
      'button-wui-fe',
      'localhost',
      ...(process.env._DEV_ALLOWED_HOST ? [process.env._DEV_ALLOWED_HOST] : [])
    ]
  },
  ssr: {
    external: [
      'argon2',
      'better-sqlite3'
    ]
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
