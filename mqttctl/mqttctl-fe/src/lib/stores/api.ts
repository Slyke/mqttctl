export const apiRequest = async <T>({
  url,
  method = 'GET',
  body
}: {
  url: string;
  method?: string;
  body?: unknown;
}) => {
  const response = await fetch(url, {
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

