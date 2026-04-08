const tokenOverrides: Record<string, string> = {
  acl: 'ACL',
  api: 'API',
  app: 'App',
  config: 'Config',
  dynsec: 'DynSec',
  id: 'ID',
  ip: 'IP',
  json: 'JSON',
  mqtt: 'MQTT',
  oidc: 'OIDC',
  rbac: 'RBAC',
  tls: 'TLS',
  ui: 'UI',
  url: 'URL'
};

const valueOverrides: Record<string, string> = {
  'broker-config': 'Broker Config',
  'n/a': 'N/A',
  mqttctl: 'mqttctl'
};

export const formatDisplayCode = (value: string | null | undefined) => {
  if (!value) return '';

  const trimmed = value.trim();
  if (!trimmed) return '';

  const exactMatch = valueOverrides[trimmed.toLowerCase()];
  if (exactMatch) return exactMatch;

  return trimmed
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((token) => tokenOverrides[token.toLowerCase()] ?? `${token.slice(0, 1).toUpperCase()}${token.slice(1).toLowerCase()}`)
    .join(' ');
};

export const capitalizeLabel = (value: string | null | undefined) => {
  if (!value) return '';

  const trimmed = value.trim();
  if (!trimmed) return '';

  return `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)}`;
};
