import { readFile } from 'node:fs/promises';
import {
  dynsecBootstrapDefaultRoleName,
  dynsecLegacyBootstrapRoleName
} from '$lib/types';
import defaultDynsecLanguage from '$lib/i18n/dynsec.en.json';

const loadDynsecLanguage = async ({ filePath, logger, correlationId }: { filePath: string | null; logger: App.Locals['appContext']['logger']; correlationId: string }) => {
  if (!filePath) return defaultDynsecLanguage;

  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return {
      ...defaultDynsecLanguage,
      ...Object.fromEntries(entries)
    };
  } catch (error) {
    logger.warn({
      caller: 'dynsec::loadLanguage',
      message: `Failed loading DynSec language file at ${filePath}. Falling back to bundled language.`,
      correlationId,
      rootCause: error
    });

    return defaultDynsecLanguage;
  }
};

export const load = async ({ locals, url }) => {
  const state = await locals.appContext.dynsec.readState({ correlationId: locals.correlationId });
  const clientDefaults = await locals.appContext.dynsec.getClientDefaults();
  const language = await loadDynsecLanguage({
    filePath: locals.appContext.runtimeConfig.config.ui.languageFilePath,
    logger: locals.appContext.logger,
    correlationId: locals.correlationId
  });
  const requestedClient = url.searchParams.get('client');
  const requestedGroup = url.searchParams.get('group');
  const requestedRole = url.searchParams.get('role');
  const selectedClient = requestedClient && state.clients.some((client) => client.username === requestedClient)
    ? requestedClient
    : null;
  const selectedGroup = requestedGroup && state.groups.some((group) => group.groupname === requestedGroup)
    ? requestedGroup
    : null;
  const selectedRole = requestedRole && state.roles.some((role) => role.rolename === requestedRole)
    ? requestedRole
    : null;
  const effectivePermissions = selectedClient
    ? await locals.appContext.dynsec.getEffectivePermissions({
        username: selectedClient,
        correlationId: locals.correlationId
      }).catch(() => null)
    : null;
  const defaultRoleMissing = locals.appContext.dynsec.isConfiguredDefaultRoleMissing({
    defaultRoleName: clientDefaults.defaultRoleName,
    state
  });
  const bootstrapDefaultRoleError = locals.appContext.dynsec.getBootstrapDefaultRoleError();
  const bootstrapDefaultRoleStatus = locals.appContext.dynsec.getBootstrapDefaultRoleStatus();
  const showDefaultRoleMissingWarning = defaultRoleMissing
    && !(
      (clientDefaults.defaultRoleName === dynsecBootstrapDefaultRoleName
        || clientDefaults.defaultRoleName === dynsecLegacyBootstrapRoleName)
      && bootstrapDefaultRoleStatus.status !== 'idle'
    );

  return {
    state,
    selectedClient,
    selectedGroup,
    selectedRole,
    language,
    effectivePermissions,
    showAssignmentPriorities: locals.appContext.runtimeConfig.config.ui.dynsec.showAssignmentPriorities,
    clientDefaults,
    defaultRoleMissing,
    showDefaultRoleMissingWarning,
    bootstrapDefaultRoleError,
    bootstrapDefaultRoleStatus
  };
};
