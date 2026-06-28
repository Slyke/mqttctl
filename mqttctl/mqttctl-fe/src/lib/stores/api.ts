const defaultApiBasePath = '/api';

const isAbsoluteUrl = ({ url }: { url: string }) => /^[a-z][a-z0-9+.-]*:/i.test(url);

const normalizeApiBasePath = ({ apiBasePath }: { apiBasePath: string }) => {
  const trimmed = apiBasePath.trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  if (!withoutTrailingSlash) return defaultApiBasePath;

  const normalized = withoutTrailingSlash.startsWith('/') ? withoutTrailingSlash : `/${withoutTrailingSlash}`;

  return normalized || defaultApiBasePath;
};

const readDocumentApiBasePath = () => {
  if (typeof document === 'undefined') return defaultApiBasePath;

  return document.documentElement.dataset.apiBasePath ?? defaultApiBasePath;
};

export const buildApiUrl = ({
  url,
  apiBasePath = readDocumentApiBasePath()
}: {
  url: string;
  apiBasePath?: string;
}) => {
  if (isAbsoluteUrl({ url })) return url;
  if (url !== defaultApiBasePath && !url.startsWith(`${defaultApiBasePath}/`)) return url;

  return `${normalizeApiBasePath({ apiBasePath })}${url.slice(defaultApiBasePath.length)}`;
};

export const apiRequest = async <T>({
  url,
  method = 'GET',
  body,
  apiBasePath
}: {
  url: string;
  method?: string;
  body?: unknown;
  apiBasePath?: string;
}) => {
  const response = await fetch(buildApiUrl({ url, apiBasePath }), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.reason ?? payload.errorKey ?? `Request failed with ${response.status}`);
  }

  return payload as T;
};
