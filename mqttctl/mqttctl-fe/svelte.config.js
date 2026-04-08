import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter(),
    experimental: {
      instrumentation: {
        server: true
      }
    },
    alias: {
      $api: '../mqttctl-api/src',
      $server: '../mqttctl-api/src/lib/server',
      $types: '../mqttctl-api/src/lib/types',
      $styles: './src/lib/styles'
    }
  }
};

export default config;
