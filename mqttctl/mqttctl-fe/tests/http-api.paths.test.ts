import { describe, expect, it } from 'vitest';
import {
  buildHttpApiProxyTargetUrl,
  getHttpApiClientBasePath,
  getHttpApiProxyRequestBasePath,
  stripHttpApiPathPrefix
} from '$server/config/http-api';
import type { LoadedRuntimeConfig } from '$server/config/load';
import { buildApiUrl } from '$lib/stores/api';

const createRuntimeConfig = ({
  appBasePath = '',
  mode = 'browser',
  browserBasePath = '/api',
  proxyBasePath = '/api-proxy',
  upstreamBaseUrl = 'http://api.internal:3000/internal',
  upstreamBasePath = '/api'
}: {
  appBasePath?: string;
  mode?: 'browser' | 'proxy';
  browserBasePath?: string;
  proxyBasePath?: string;
  upstreamBaseUrl?: string | null;
  upstreamBasePath?: string;
}) => ({
  config: {
    basePath: appBasePath,
    httpApi: {
      mode,
      browserBasePath,
      proxy: {
        basePath: proxyBasePath,
        upstreamBaseUrl,
        upstreamBasePath
      }
    }
  }
} as LoadedRuntimeConfig);

describe('HTTP API path configuration', () => {
  it('keeps browser mode on the configured direct API base path', () => {
    const runtimeConfig = createRuntimeConfig({
      appBasePath: '/mqttctl',
      mode: 'browser',
      browserBasePath: 'api'
    });

    expect(getHttpApiClientBasePath({ runtimeConfig })).toBe('/mqttctl/api');
  });

  it('switches client calls to the proxy base path in proxy mode', () => {
    const runtimeConfig = createRuntimeConfig({
      appBasePath: '/mqttctl',
      mode: 'proxy',
      proxyBasePath: 'api-proxy'
    });

    expect(getHttpApiClientBasePath({ runtimeConfig })).toBe('/mqttctl/api-proxy');
    expect(getHttpApiProxyRequestBasePath({ runtimeConfig })).toBe('/mqttctl/api-proxy');
  });

  it('strips the downstream proxy prefix and preserves upstream base URL paths', () => {
    const runtimeConfig = createRuntimeConfig({
      appBasePath: '/mqttctl',
      mode: 'proxy',
      proxyBasePath: '/api-proxy',
      upstreamBaseUrl: 'http://api.internal:3000/internal',
      upstreamBasePath: '/api'
    });
    const downstreamPath = stripHttpApiPathPrefix({
      pathname: '/mqttctl/api-proxy/dynsec/clients',
      basePath: getHttpApiProxyRequestBasePath({ runtimeConfig })
    });

    expect(downstreamPath).toBe('/dynsec/clients');
    expect(buildHttpApiProxyTargetUrl({
      runtimeConfig,
      downstreamPath: downstreamPath ?? '',
      search: '?limit=25'
    })?.href).toBe('http://api.internal:3000/internal/api/dynsec/clients?limit=25');
  });

  it('rewrites legacy /api browser URLs to the active configured API base path', () => {
    expect(buildApiUrl({
      apiBasePath: '/api-proxy',
      url: '/api/config/pull'
    })).toBe('/api-proxy/config/pull');
    expect(buildApiUrl({
      apiBasePath: '/mqttctl/api-proxy',
      url: '/api'
    })).toBe('/mqttctl/api-proxy');
    expect(buildApiUrl({
      apiBasePath: '/api-proxy',
      url: '/auth/login'
    })).toBe('/auth/login');
  });
});
