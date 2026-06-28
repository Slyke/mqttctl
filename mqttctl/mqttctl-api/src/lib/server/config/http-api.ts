import type { LoadedRuntimeConfig } from '$server/config/load';

const defaultApiBasePath = '/api';

export const normalizeHttpApiBasePath = ({ basePath }: { basePath: string }) => {
  const trimmed = basePath.trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  if (!withoutTrailingSlash) return defaultApiBasePath;

  const normalized = withoutTrailingSlash.startsWith('/') ? withoutTrailingSlash : `/${withoutTrailingSlash}`;

  return normalized || defaultApiBasePath;
};

export const joinHttpApiPaths = ({ paths }: { paths: string[] }) => {
  const joined = paths
    .map((path) => path.trim())
    .filter((path) => path !== '')
    .map((path) => path.replace(/^\/+|\/+$/g, ''))
    .filter((path) => path !== '')
    .join('/');

  return joined ? `/${joined}` : '';
};

export const getHttpApiClientBasePath = ({ runtimeConfig }: { runtimeConfig: LoadedRuntimeConfig }) => {
  const httpApi = runtimeConfig.config.httpApi;
  const apiPath = httpApi.mode === 'proxy'
    ? httpApi.proxy.basePath
    : httpApi.browserBasePath;

  return joinHttpApiPaths({
    paths: [
      runtimeConfig.config.basePath,
      normalizeHttpApiBasePath({ basePath: apiPath })
    ]
  });
};

export const getHttpApiProxyRequestBasePath = ({ runtimeConfig }: { runtimeConfig: LoadedRuntimeConfig }) => joinHttpApiPaths({
  paths: [
    runtimeConfig.config.basePath,
    normalizeHttpApiBasePath({ basePath: runtimeConfig.config.httpApi.proxy.basePath })
  ]
});

export const stripHttpApiPathPrefix = ({
  pathname,
  basePath
}: {
  pathname: string;
  basePath: string;
}) => {
  if (pathname === basePath) return '';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);

  return null;
};

export const buildHttpApiProxyTargetUrl = ({
  runtimeConfig,
  downstreamPath,
  search
}: {
  runtimeConfig: LoadedRuntimeConfig;
  downstreamPath: string;
  search: string;
}) => {
  const upstreamBaseUrl = runtimeConfig.config.httpApi.proxy.upstreamBaseUrl;
  if (!upstreamBaseUrl) return null;

  const targetUrl = new URL(upstreamBaseUrl);
  targetUrl.pathname = joinHttpApiPaths({
    paths: [
      targetUrl.pathname,
      normalizeHttpApiBasePath({ basePath: runtimeConfig.config.httpApi.proxy.upstreamBasePath }),
      downstreamPath
    ]
  }) || '/';
  targetUrl.search = search;

  return targetUrl;
};
