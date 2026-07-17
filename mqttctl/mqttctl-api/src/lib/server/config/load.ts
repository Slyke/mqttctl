import { readFile } from 'node:fs/promises';
import JSON5 from 'json5';
import { configSchema, secretsSchema, type RuntimeConfig, type RuntimeSecrets } from '$server/config/schema';
import { createAppError } from '$server/logging/errors';

export interface LoadedRuntimeConfig {
  config: RuntimeConfig;
  secrets: RuntimeSecrets;
  dbKind: 'sqlite' | 'postgres';
  sqlitePath: string;
  uiOverrideCssPath: string | null;
}

const parseBooleanOverride = ({ value }: { value: string }) => (
  ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
);

const readJson5File = async ({ filePath, errorKey, correlationId }: { filePath: string; errorKey: string; correlationId: string | null }) => {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON5.parse(text);
  } catch (error) {
    throw createAppError({
      caller: 'config::load',
      reason: `Failed loading JSON5 from ${filePath}`,
      errorKey,
      correlationId,
      context: { filePath },
      cause: error
    });
  }
};

export const loadRuntimeConfig = async ({ correlationId = null }: { correlationId?: string | null } = {}): Promise<LoadedRuntimeConfig> => {
  const configPath = process.env.MQTTCTL_CONFIG_PATH ?? '';
  const secretsPath = process.env.MQTTCTL_SECRETS_PATH ?? '';
  const dbKind = process.env.MQTTCTL_DB_KIND === 'postgres' ? 'postgres' : 'sqlite';
  const sqlitePath = process.env.MQTTCTL_SQLITE_PATH ?? './var/mqttctl.sqlite';
  const uiOverrideCssPath = process.env.MQTTCTL_UI_OVERRIDE_CSS_PATH ?? null;

  if (!configPath || !secretsPath) {
    throw createAppError({
      caller: 'config::load',
      reason: 'MQTTCTL_CONFIG_PATH and MQTTCTL_SECRETS_PATH are required.',
      errorKey: 'CONFIG_LOAD_FAILED',
      correlationId,
      context: { configPath, secretsPath }
    });
  }

  const [rawConfig, rawSecrets] = await Promise.all([
    readJson5File({ filePath: configPath, errorKey: 'CONFIG_LOAD_FAILED', correlationId }),
    readJson5File({ filePath: secretsPath, errorKey: 'CONFIG_LOAD_FAILED', correlationId })
  ]);

  const configResult = configSchema.safeParse(rawConfig);
  if (!configResult.success) {
    throw createAppError({
      caller: 'config::load',
      reason: 'Config JSON5 failed validation.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId,
      context: configResult.error.flatten()
    });
  }

  const secretsResult = secretsSchema.safeParse(rawSecrets);
  if (!secretsResult.success) {
    throw createAppError({
      caller: 'config::load',
      reason: 'Secrets JSON5 failed validation.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId,
      context: secretsResult.error.flatten()
    });
  }

  if (process.env.MQTTCTL_MCP_AUTH_ENABLED !== undefined) {
    configResult.data.auth.mcp.enabled = parseBooleanOverride({
      value: process.env.MQTTCTL_MCP_AUTH_ENABLED
    });
  }

  if (process.env.MQTTCTL_MCP_PUBLIC_KEY_PATH !== undefined) {
    const publicKeyFile = process.env.MQTTCTL_MCP_PUBLIC_KEY_PATH.trim();
    if (publicKeyFile) {
      configResult.data.auth.mcp.publicKeyFile = publicKeyFile;
    }
  }

  if (
    configResult.data.auth.oidcEnabled
    && !configResult.data.auth.oidc
  ) {
    throw createAppError({
      caller: 'config::load',
      reason: 'OIDC is enabled but config.auth.oidc is missing.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId
    });
  }

  if (
    configResult.data.auth.headerEnabled
    && !configResult.data.auth.header
  ) {
    throw createAppError({
      caller: 'config::load',
      reason: 'Header auth is enabled but config.auth.header is missing.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId
    });
  }

  if (
    dbKind === 'postgres'
    && (!configResult.data.database.postgres || !secretsResult.data.postgresPassword)
  ) {
    throw createAppError({
      caller: 'config::load',
      reason: 'Postgres mode requires config.database.postgres and secrets.postgresPassword.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId
    });
  }

  if (
    configResult.data.auth.oidcEnabled
    && !secretsResult.data.oidcClientSecret
  ) {
    throw createAppError({
      caller: 'config::load',
      reason: 'OIDC mode requires secrets.oidcClientSecret.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId
    });
  }

  if (
    configResult.data.broker.agent
    && !secretsResult.data.broker.agentApiKey
  ) {
    throw createAppError({
      caller: 'config::load',
      reason: 'Broker agent mode requires secrets.broker.agentApiKey.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId
    });
  }

  if (
    configResult.data.httpApi.mode === 'proxy'
    && !configResult.data.httpApi.proxy.upstreamBaseUrl
  ) {
    throw createAppError({
      caller: 'config::load',
      reason: 'HTTP API proxy mode requires config.httpApi.proxy.upstreamBaseUrl.',
      errorKey: 'CONFIG_VALIDATION_FAILED',
      correlationId
    });
  }

  return {
    config: configResult.data,
    secrets: secretsResult.data,
    dbKind,
    sqlitePath,
    uiOverrideCssPath
  };
};
