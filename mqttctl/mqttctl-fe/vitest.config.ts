import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '$lib/types',
        replacement: path.resolve(rootDir, '../mqttctl-api/src/lib/types/index.ts')
      },
      {
        find: '$server',
        replacement: path.resolve(rootDir, '../mqttctl-api/src/lib/server')
      },
      {
        find: '$types',
        replacement: path.resolve(rootDir, '../mqttctl-api/src/lib/types/index.ts')
      },
      {
        find: '$api',
        replacement: path.resolve(rootDir, '../mqttctl-api/src')
      },
      {
        find: '$styles',
        replacement: path.resolve(rootDir, './src/lib/styles')
      },
      {
        find: '$lib',
        replacement: path.resolve(rootDir, './src/lib')
      }
    ]
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
