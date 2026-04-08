<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import defaultDynsecLanguage from '$lib/i18n/dynsec.en.json';
  import { apiRequest } from '$lib/stores/api';
  import { interpolate, type InterpolateValues } from '$lib/strings/interpolate';
  import { dynsecAclTypes, type DynsecAclType, type DynsecClientDefaults } from '$lib/types';

  type FeedbackTarget = 'global' | 'assignment' | 'defaults' | 'group' | 'role';
  type DynsecLanguage = typeof defaultDynsecLanguage;
  type DynsecLanguageKey = keyof DynsecLanguage;

  export let data: {
    state: {
      clients: Array<{
        username: string;
        clientid: string | null;
        disabled: boolean;
        roles: Array<{ rolename: string; priority: number }>;
        groups: Array<{ groupname: string; priority: number }>;
      }>;
      groups: Array<{
        groupname: string;
        roles: Array<{ rolename: string; priority: number }>;
        clients: Array<{ username: string; priority: number }>;
      }>;
      roles: Array<{
        rolename: string;
        acls: Array<{ acltype: DynsecAclType; topic: string; allow: boolean; priority: number }>;
      }>;
    };
    selectedClient: string | null;
    selectedGroup: string | null;
    selectedRole: string | null;
    language: DynsecLanguage;
    effectivePermissions: {
      warnings: string[];
      mergedAcls: Array<{ acltype: DynsecAclType; topic: string; allow: boolean; priority: number }>;
      inheritedGroups: Array<{ group: { groupname: string } }>;
    } | null;
    showAssignmentPriorities: boolean;
    clientDefaults: DynsecClientDefaults;
    defaultRoleMissing: boolean;
    showDefaultRoleMissingWarning: boolean;
    bootstrapDefaultRoleStatus: {
      status: 'idle' | 'running' | 'success' | 'failed';
      lastRunAt: string | null;
      message: string | null;
    };
    bootstrapDefaultRoleError: {
      reason: string;
      errorKey: string | null;
      details: unknown;
    } | null;
  };

  const aclTypeLabelKeys = {
    publishClientSend: 'dynsec-aclType-publishClientSend',
    publishClientReceive: 'dynsec-aclType-publishClientReceive',
    subscribeLiteral: 'dynsec-aclType-subscribeLiteral',
    subscribePattern: 'dynsec-aclType-subscribePattern',
    unsubscribeLiteral: 'dynsec-aclType-unsubscribeLiteral',
    unsubscribePattern: 'dynsec-aclType-unsubscribePattern'
  } satisfies Record<DynsecAclType, DynsecLanguageKey>;
  const aclTypeShortLabels: Record<DynsecAclType, string> = {
    publishClientSend: 'W',
    publishClientReceive: 'R',
    subscribeLiteral: 'Sl',
    subscribePattern: 'Sp',
    unsubscribeLiteral: 'Ul',
    unsubscribePattern: 'Up'
  };

  let message = '';
  let error = '';
  let assignmentMessage = '';
  let assignmentError = '';
  let defaultsMessage = '';
  let defaultsError = '';
  let groupMessage = '';
  let groupError = '';
  let roleMessage = '';
  let roleError = '';

  let clientUsername = '';
  let clientPassword = '';
  let clientId = '';
  let groupname = '';
  let rolename = '';
  let aclTypes: DynsecAclType[] = ['publishClientSend'];
  let aclTopic = '';
  let aclAllow = true;
  let aclPriority = 0;
  let assignRoleName = '';
  let assignRolePriority = 0;
  let assignGroupName = '';
  let assignGroupPriority = 0;
  let assignGroupRoleName = '';
  let assignGroupRolePriority = 0;
  let defaultRoleName = data.clientDefaults.defaultRoleName ?? '';
  let defaultRolePriority = data.clientDefaults.defaultRolePriority;
  let aclTypeMenu: HTMLDetailsElement | null = null;
  let appliedPageSearch = page.url.search;
  let currentQuerySearch = page.url.search;
  let createFormsOpen = new URLSearchParams(currentQuerySearch).get('create') === '1';
  let effectivePermissionsOpen = new URLSearchParams(currentQuerySearch).get('permissions') === '1';
  let showAssignmentPriorities = data.showAssignmentPriorities;
  let language = data.language;
  let selectedClientEntry = data.selectedClient
    ? data.state.clients.find((client) => client.username === data.selectedClient) ?? null
    : null;
  let selectedGroupEntry = data.selectedGroup
    ? data.state.groups.find((group) => group.groupname === data.selectedGroup) ?? null
    : null;
  let selectedRoleEntry = data.selectedRole
    ? data.state.roles.find((role) => role.rolename === data.selectedRole) ?? null
    : null;

  $: if (page.url.search !== appliedPageSearch) {
    appliedPageSearch = page.url.search;
    currentQuerySearch = page.url.search;
    createFormsOpen = new URLSearchParams(currentQuerySearch).get('create') === '1';
    effectivePermissionsOpen = new URLSearchParams(currentQuerySearch).get('permissions') === '1';
  }
  $: selectedClientEntry = data.selectedClient
    ? data.state.clients.find((client) => client.username === data.selectedClient) ?? null
    : null;
  $: selectedGroupEntry = data.selectedGroup
    ? data.state.groups.find((group) => group.groupname === data.selectedGroup) ?? null
    : null;
  $: selectedRoleEntry = data.selectedRole
    ? data.state.roles.find((role) => role.rolename === data.selectedRole) ?? null
    : null;
  $: defaultRoleName = data.clientDefaults.defaultRoleName ?? '';
  $: defaultRolePriority = data.clientDefaults.defaultRolePriority;
  $: showAssignmentPriorities = data.showAssignmentPriorities;
  $: language = data.language;

  const t = (key: DynsecLanguageKey, values: InterpolateValues = {}) =>
    interpolate(language[key] ?? defaultDynsecLanguage[key], values, true);

  const formatAclType = (acltype: DynsecAclType) => t(aclTypeLabelKeys[acltype]) ?? acltype;
  const formatAclTypeOptionLabel = (acltype: DynsecAclType) => `${aclTypeShortLabels[acltype]} ${formatAclType(acltype)}`;
  const formatAssignmentLabel = ({ label, priority }: { label: string; priority: number }) =>
    showAssignmentPriorities ? `${label}:${priority}` : label;
  const formatDefaultRoleLabel = ({ rolename, priority }: { rolename: string; priority: number }) =>
    showAssignmentPriorities ? `${rolename}:${priority}` : rolename;
  const formatAclEffect = ({ allow }: { allow: boolean }) => allow ? t('dynsec-common-allow') : t('dynsec-common-deny');
  const formatClientState = ({ disabled }: { disabled: boolean }) => disabled ? t('dynsec-common-disabled') : t('dynsec-common-enabled');
  const normalizeEntityName = ({ value }: { value: string }) => value.trim();
  const groupNameExists = ({ groupname, except = null }: { groupname: string; except?: string | null }) =>
    data.state.groups.some((group) => group.groupname === groupname && group.groupname !== except);
  const roleNameExists = ({ rolename, except = null }: { rolename: string; except?: string | null }) =>
    data.state.roles.some((role) => role.rolename === rolename && role.rolename !== except);
  const assertGroupNameAvailable = ({ groupname }: { groupname: string }) => {
    if (groupNameExists({ groupname })) {
      throw new Error(t('dynsec-error-groupNameExists', { groupname }));
    }
  };
  const assertRoleNameAvailable = ({ rolename }: { rolename: string }) => {
    if (roleNameExists({ rolename })) {
      throw new Error(t('dynsec-error-roleNameExists', { rolename }));
    }
  };
  const normalizeAclTypes = ({ acltypes }: { acltypes: DynsecAclType[] }) => {
    const selected = new Set(acltypes);
    return dynsecAclTypes.filter((acltype) => selected.has(acltype));
  };
  const formatAclTypeSelection = ({ acltypes }: { acltypes: DynsecAclType[] }) => {
    const normalized = normalizeAclTypes({ acltypes });

    if (!normalized.length) return t('dynsec-common-selectAcls');
    if (normalized.length === 1) return formatAclTypeOptionLabel(normalized[0]!);

    return normalized.map((acltype) => aclTypeShortLabels[acltype]).join(', ');
  };
  const toggleAclType = ({
    acltype,
    checked
  }: {
    acltype: DynsecAclType;
    checked: boolean;
  }) => {
    const selected = new Set(aclTypes);

    if (checked) {
      selected.add(acltype);
    } else {
      selected.delete(acltype);
    }

    aclTypes = normalizeAclTypes({ acltypes: [...selected] });
  };
  const selectAllAclTypes = () => {
    aclTypes = [...dynsecAclTypes];
  };
  const clearAclTypes = () => {
    aclTypes = [];
  };
  const closeAclTypeMenu = () => {
    if (aclTypeMenu?.open) {
      aclTypeMenu.open = false;
    }
  };
  const handleAclTypeMenuOutsideClick = (event: MouseEvent) => {
    if (!aclTypeMenu?.open) return;

    const target = event.target;

    if (target instanceof Node && !aclTypeMenu.contains(target)) {
      closeAclTypeMenu();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('click', handleAclTypeMenuOutsideClick);
  }

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('click', handleAclTypeMenuOutsideClick);
    }
  });

  const setFeedback = ({
    target,
    nextMessage = '',
    nextError = ''
  }: {
    target: FeedbackTarget;
    nextMessage?: string;
    nextError?: string;
  }) => {
    if (target === 'global') {
      message = nextMessage;
      error = nextError;
      return;
    }

    if (target === 'assignment') {
      assignmentMessage = nextMessage;
      assignmentError = nextError;
      return;
    }

    if (target === 'group') {
      groupMessage = nextMessage;
      groupError = nextError;
      return;
    }

    if (target === 'role') {
      roleMessage = nextMessage;
      roleError = nextError;
      return;
    }

    defaultsMessage = nextMessage;
    defaultsError = nextError;
  };

  const buildPageUrl = (updates: Record<string, string | null>) => {
    const query = new URLSearchParams(currentQuerySearch);

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') {
        query.delete(key);
        continue;
      }

      query.set(key, value);
    }

    const nextSearch = query.toString();
    return nextSearch ? `${page.url.pathname}?${nextSearch}` : page.url.pathname;
  };

  const navigateWithQuery = async ({
    updates,
    replaceState = true
  }: {
    updates: Record<string, string | null>;
    replaceState?: boolean;
  }) => {
    const nextUrl = buildPageUrl(updates);
    const nextSearch = nextUrl.includes('?') ? nextUrl.slice(nextUrl.indexOf('?')) : '';

    currentQuerySearch = nextSearch;
    createFormsOpen = new URLSearchParams(currentQuerySearch).get('create') === '1';
    effectivePermissionsOpen = new URLSearchParams(currentQuerySearch).get('permissions') === '1';

    await goto(nextUrl, {
      keepFocus: true,
      noScroll: true,
      replaceState
    });
  };

  const replaceQueryState = ({
    updates,
    nextCreateFormsOpen = createFormsOpen,
    nextEffectivePermissionsOpen = effectivePermissionsOpen
  }: {
    updates: Record<string, string | null>;
    nextCreateFormsOpen?: boolean;
    nextEffectivePermissionsOpen?: boolean;
  }) => {
    const nextUrl = buildPageUrl(updates);
    const nextSearch = nextUrl.includes('?') ? nextUrl.slice(nextUrl.indexOf('?')) : '';

    currentQuerySearch = nextSearch;
    createFormsOpen = nextCreateFormsOpen;
    effectivePermissionsOpen = nextEffectivePermissionsOpen;

    if (typeof window !== 'undefined') {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  };

  const run = async ({
    task,
    target = 'global'
  }: {
    task: () => Promise<void>;
    target?: FeedbackTarget;
  }) => {
    setFeedback({ target });

    try {
      await task();
      await invalidateAll();
    } catch (caught) {
      setFeedback({
        target,
        nextError: caught instanceof Error ? caught.message : t('dynsec-feedback_request-failed')
      });
    }
  };

  const requireSelectedClient = () => {
    if (!selectedClientEntry) {
      throw new Error(t('dynsec-error-selectClient'));
    }

    return selectedClientEntry;
  };
  const requireSelectedGroup = () => {
    if (!selectedGroupEntry) {
      throw new Error(t('dynsec-error-selectGroup'));
    }

    return selectedGroupEntry;
  };
  const requireSelectedRole = () => {
    if (!selectedRoleEntry) {
      throw new Error(t('dynsec-error-selectRole'));
    }

    return selectedRoleEntry;
  };

  const createClient = async () => {
    await run({
      task: async () => {
        const username = clientUsername;

        await apiRequest({
          url: '/api/dynsec/clients',
          method: 'POST',
          body: {
            username,
            password: clientPassword || null,
            clientId: clientId || null,
            disabled: false
          }
        });

        setFeedback({
          target: 'global',
          nextMessage: t('dynsec-feedback_client-created', { username })
        });
        clientUsername = '';
        clientPassword = '';
        clientId = '';
      }
    });
  };

  const createGroup = async () => {
    await run({
      task: async () => {
        const targetGroup = normalizeEntityName({ value: groupname });

        assertGroupNameAvailable({ groupname: targetGroup });

        await apiRequest({
          url: '/api/dynsec/groups',
          method: 'POST',
          body: { groupname: targetGroup }
        });

        setFeedback({
          target: 'global',
          nextMessage: t('dynsec-feedback_group-created', { groupname: targetGroup })
        });
        groupname = '';
      }
    });
  };

  const createRole = async () => {
    await run({
      task: async () => {
        const targetRole = normalizeEntityName({ value: rolename });

        assertRoleNameAvailable({ rolename: targetRole });

        await apiRequest({
          url: '/api/dynsec/roles',
          method: 'POST',
          body: { rolename: targetRole }
        });

        setFeedback({
          target: 'global',
          nextMessage: t('dynsec-feedback_role-created', { rolename: targetRole })
        });
        rolename = '';
      }
    });
  };

  const addAcl = async () => {
    await run({
      target: 'role',
      task: async () => {
        const role = requireSelectedRole();
        const topic = aclTopic.trim() || '#';
        const selectedAclTypes = normalizeAclTypes({ acltypes: aclTypes });

        await apiRequest({
          url: `/api/dynsec/roles/${role.rolename}`,
          method: 'PATCH',
          body: {
            action: 'addAcl',
            acltypes: selectedAclTypes,
            topic,
            allow: aclAllow,
            priority: Number(aclPriority)
          }
        });

        setFeedback({
          target: 'role',
          nextMessage: t('dynsec-feedback_role-acls-added', {
            count: selectedAclTypes.length,
            suffix: selectedAclTypes.length === 1 ? '' : 's',
            rolename: role.rolename
          })
        });
        aclTopic = '';
      }
    });
  };

  const deleteClient = async (username: string) => {
    if (!confirm(t('dynsec-confirm-deleteClient', { username }))) return;

    await run({
      task: async () => {
        await apiRequest({
          url: `/api/dynsec/clients/${username}`,
          method: 'DELETE'
        });

        setFeedback({
          target: 'global',
          nextMessage: t('dynsec-feedback_client-deleted', { username })
        });
      }
    });
  };

  const toggleClient = async (username: string, enabled: boolean) => {
    await run({
      task: async () => {
        await apiRequest({
          url: `/api/dynsec/clients/${username}`,
          method: 'PATCH',
          body: {
            action: 'setEnabled',
            enabled
          }
        });

        setFeedback({
          target: 'global',
          nextMessage: t('dynsec-feedback_client-toggled', {
            state: enabled ? t('dynsec-common-enabled') : t('dynsec-common-disabled'),
            username
          })
        });
      }
    });
  };

  const deleteGroup = async (targetGroup: string) => {
    if (!confirm(t('dynsec-confirm-deleteGroup', { groupname: targetGroup }))) return;

    await run({
      task: async () => {
        await apiRequest({
          url: `/api/dynsec/groups/${targetGroup}`,
          method: 'DELETE'
        });

        setFeedback({
          target: 'global',
          nextMessage: t('dynsec-feedback_group-deleted', { groupname: targetGroup })
        });
      }
    });
  };

  const deleteRole = async (targetRole: string) => {
    if (!confirm(t('dynsec-confirm-deleteRole', { rolename: targetRole }))) return;

    await run({
      task: async () => {
        await apiRequest({
          url: `/api/dynsec/roles/${targetRole}`,
          method: 'DELETE'
        });

        setFeedback({
          target: 'global',
          nextMessage: t('dynsec-feedback_role-deleted', { rolename: targetRole })
        });
      }
    });
  };

  const inspectClient = async (username: string) => {
    setFeedback({ target: 'assignment' });
    await navigateWithQuery({ updates: { client: username } });
  };
  const inspectGroup = async (groupnameToInspect: string) => {
    setFeedback({ target: 'group' });
    await navigateWithQuery({ updates: { group: groupnameToInspect } });
  };
  const inspectRole = async (rolenameToInspect: string) => {
    setFeedback({ target: 'role' });
    await navigateWithQuery({ updates: { role: rolenameToInspect } });
  };

  const clearSelectedClient = async () => {
    setFeedback({ target: 'assignment' });
    await navigateWithQuery({ updates: { client: null } });
  };
  const clearSelectedGroup = async () => {
    setFeedback({ target: 'group' });
    await navigateWithQuery({ updates: { group: null } });
  };
  const clearSelectedRole = async () => {
    setFeedback({ target: 'role' });
    await navigateWithQuery({ updates: { role: null } });
  };

  const toggleCreateForms = async () => {
    const nextCreateFormsOpen = !createFormsOpen;

    replaceQueryState({
      updates: { create: nextCreateFormsOpen ? '1' : null },
      nextCreateFormsOpen
    });
  };

  const toggleEffectivePermissions = async () => {
    const nextEffectivePermissionsOpen = !effectivePermissionsOpen;

    replaceQueryState({
      updates: { permissions: nextEffectivePermissionsOpen ? '1' : null },
      nextEffectivePermissionsOpen
    });
  };

  const assignRoleToSelectedClient = async () => {
    await run({
      target: 'assignment',
      task: async () => {
        const client = requireSelectedClient();

        await apiRequest({
          url: `/api/dynsec/clients/${client.username}`,
          method: 'PATCH',
          body: {
            action: 'assignRole',
            rolename: assignRoleName,
            priority: Number(assignRolePriority)
          }
        });

        setFeedback({
          target: 'assignment',
          nextMessage: t('dynsec-feedback-roleAssignedToClient', {
            rolename: assignRoleName,
            username: client.username
          })
        });
        assignRoleName = '';
        assignRolePriority = 0;
      }
    });
  };

  const removeRoleFromSelectedClient = async (rolenameToRemove: string) => {
    await run({
      target: 'assignment',
      task: async () => {
        const client = requireSelectedClient();

        await apiRequest({
          url: `/api/dynsec/clients/${client.username}`,
          method: 'PATCH',
          body: {
            action: 'removeRole',
            rolename: rolenameToRemove
          }
        });

        setFeedback({
          target: 'assignment',
          nextMessage: t('dynsec-feedback-roleRemovedFromClient', {
            rolename: rolenameToRemove,
            username: client.username
          })
        });
      }
    });
  };

  const addSelectedClientToGroup = async () => {
    await run({
      target: 'assignment',
      task: async () => {
        const client = requireSelectedClient();

        await apiRequest({
          url: `/api/dynsec/clients/${client.username}`,
          method: 'PATCH',
          body: {
            action: 'addGroup',
            groupname: assignGroupName,
            priority: Number(assignGroupPriority)
          }
        });

        setFeedback({
          target: 'assignment',
          nextMessage: t('dynsec-feedback-clientAddedToGroup', {
            username: client.username,
            groupname: assignGroupName
          })
        });
        assignGroupName = '';
        assignGroupPriority = 0;
      }
    });
  };

  const removeSelectedClientFromGroup = async (groupnameToRemove: string) => {
    await run({
      target: 'assignment',
      task: async () => {
        const client = requireSelectedClient();

        await apiRequest({
          url: `/api/dynsec/clients/${client.username}`,
          method: 'PATCH',
          body: {
            action: 'removeGroup',
            groupname: groupnameToRemove
          }
        });

        setFeedback({
          target: 'assignment',
          nextMessage: t('dynsec-feedback-clientRemovedFromGroup', {
            username: client.username,
            groupname: groupnameToRemove
          })
        });
      }
    });
  };

  const saveClientDefaults = async () => {
    await run({
      target: 'defaults',
      task: async () => {
        await apiRequest({
          url: '/api/dynsec/settings/client-defaults',
          method: 'PATCH',
          body: {
            defaultRoleName: defaultRoleName || null,
            defaultRolePriority: Number(defaultRolePriority)
          }
        });

        setFeedback({
          target: 'defaults',
          nextMessage: defaultRoleName
            ? t('dynsec-feedback-defaultRole-saved', { rolename: defaultRoleName })
            : t('dynsec-feedback-defaultRole-cleared')
        });
      }
    });
  };
  const assignRoleToSelectedGroup = async () => {
    await run({
      target: 'group',
      task: async () => {
        const group = requireSelectedGroup();

        await apiRequest({
          url: `/api/dynsec/groups/${group.groupname}`,
          method: 'PATCH',
          body: {
            action: 'addRole',
            rolename: assignGroupRoleName,
            priority: Number(assignGroupRolePriority)
          }
        });

        setFeedback({
          target: 'group',
          nextMessage: t('dynsec-feedback-roleAssignedToGroup', {
            rolename: assignGroupRoleName,
            groupname: group.groupname
          })
        });
        assignGroupRoleName = '';
        assignGroupRolePriority = 0;
      }
    });
  };
  const removeRoleFromSelectedGroup = async (rolenameToRemove: string) => {
    await run({
      target: 'group',
      task: async () => {
        const group = requireSelectedGroup();

        await apiRequest({
          url: `/api/dynsec/groups/${group.groupname}`,
          method: 'PATCH',
          body: {
            action: 'removeRole',
            rolename: rolenameToRemove
          }
        });

        setFeedback({
          target: 'group',
          nextMessage: t('dynsec-feedback-roleRemovedFromGroup', {
            rolename: rolenameToRemove,
            groupname: group.groupname
          })
        });
      }
    });
  };
  const removeSelectedGroupClient = async (usernameToRemove: string) => {
    await run({
      target: 'group',
      task: async () => {
        const group = requireSelectedGroup();

        await apiRequest({
          url: `/api/dynsec/groups/${group.groupname}`,
          method: 'PATCH',
          body: {
            action: 'removeClient',
            username: usernameToRemove
          }
        });

        setFeedback({
          target: 'group',
          nextMessage: t('dynsec-feedback-clientRemovedFromGroup', {
            username: usernameToRemove,
            groupname: group.groupname
          })
        });
      }
    });
  };
  const removeAclFromSelectedRole = async ({
    acltype,
    topic
  }: {
    acltype: DynsecAclType;
    topic: string;
  }) => {
    const role = requireSelectedRole();

    if (!confirm(t('dynsec-confirm-removeRoleAcl', {
      acltype: formatAclType(acltype),
      topic,
      rolename: role.rolename
    }))) return;

    await run({
      target: 'role',
      task: async () => {
        await apiRequest({
          url: `/api/dynsec/roles/${role.rolename}`,
          method: 'PATCH',
          body: {
            action: 'removeAcl',
            acltype,
            topic
          }
        });

        setFeedback({
          target: 'role',
          nextMessage: t('dynsec-feedback-roleAclRemoved', {
            acltype: formatAclType(acltype),
            rolename: role.rolename
          })
        });
      }
    });
  };
</script>

<section class="stack dynsec-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">{t('dynsec-page_title')}</h1>
      <p class="muted">{t('dynsec-page_description')}</p>
    </div>
  </div>

  {#if message}
    <div class="badge tone-mid">{message}</div>
  {/if}
  {#if error}
    <div class="badge tone-danger">{error}</div>
  {/if}

  <article class="panel stack">
    <button
      class="create-toggle"
      type="button"
      aria-expanded={createFormsOpen}
      on:click={toggleCreateForms}
    >
      <span>{t('dynsec-create_toggle-label')}</span>
      <span class="create-toggle-indicator" aria-hidden="true">{createFormsOpen ? '−' : '+'}</span>
    </button>

    {#if createFormsOpen}
      <div class="panel-grid">
        <section class="create-card stack">
          <h2>{t('dynsec-createClient_section-heading')}</h2>
          {#if data.clientDefaults.defaultRoleName}
            <div class={data.defaultRoleMissing ? 'badge tone-warning' : 'badge tone-mid'}>
              {#if data.defaultRoleMissing}
                {t('dynsec-createClient_defaultRole-missing', { rolename: data.clientDefaults.defaultRoleName })}
              {:else}
                {t('dynsec-createClient_defaultRole-applied', { roleLabel: formatDefaultRoleLabel({
                  rolename: data.clientDefaults.defaultRoleName,
                  priority: data.clientDefaults.defaultRolePriority
                }) })}
              {/if}
            </div>
          {/if}
          <form class="stack" on:submit|preventDefault={createClient}>
            <input bind:value={clientUsername} placeholder={t('dynsec-createClient_input-username-placeholder')} />
            <input bind:value={clientPassword} type="password" placeholder={t('dynsec-createClient_input-password-placeholder')} />
            <input bind:value={clientId} placeholder={t('dynsec-createClient_input-clientId-placeholder')} />
            <button class="button-start" type="submit">{t('dynsec-createClient_button-submit')}</button>
          </form>
        </section>

        <section class="create-card stack">
          <h2>{t('dynsec-createGroup_section-heading')}</h2>
          <form class="stack" on:submit|preventDefault={createGroup}>
            <input bind:value={groupname} placeholder={t('dynsec-createGroup_input-groupName-placeholder')} />
            <button class="button-mid" type="submit">{t('dynsec-createGroup_button-submit')}</button>
          </form>
        </section>

        <section class="create-card stack">
          <h2>{t('dynsec-createRole_section-heading')}</h2>
          <form class="stack" on:submit|preventDefault={createRole}>
            <input bind:value={rolename} placeholder={t('dynsec-createRole_input-roleName-placeholder')} />
            <button class="button-warning" type="submit">{t('dynsec-createRole_button-submit')}</button>
          </form>
        </section>
      </div>
    {/if}
  </article>

  <div class="panel-grid">
    <article class="panel stack dynsec-defaults-panel">
      <h2>{t('dynsec-clientDefaults_section-heading')}</h2>
      {#if defaultsMessage}
        <div class="badge dynsec-status-banner tone-mid">{defaultsMessage}</div>
      {/if}
      {#if defaultsError}
        <div class="badge dynsec-status-banner tone-danger">{defaultsError}</div>
      {/if}
      {#if data.bootstrapDefaultRoleStatus.status === 'running'}
        <div class="badge dynsec-status-banner tone-warning">
          {t('dynsec-clientDefaults_defaultRole-bootstrapPending')}
        </div>
      {/if}
      {#if data.bootstrapDefaultRoleStatus.status === 'failed'}
        <div class="badge dynsec-status-banner tone-danger">
          {t('dynsec-clientDefaults_defaultRole-bootstrapFailed', {
            reason: data.bootstrapDefaultRoleError?.reason ?? data.bootstrapDefaultRoleStatus.message ?? 'Unknown error'
          })}
        </div>
      {/if}
      {#if data.clientDefaults.defaultRoleName}
        {#if data.showDefaultRoleMissingWarning}
          <div class="badge dynsec-status-banner tone-warning">
            {t('dynsec-clientDefaults_defaultRole-missing', { rolename: data.clientDefaults.defaultRoleName })}
          </div>
        {:else if !data.defaultRoleMissing}
          <div class="badge dynsec-status-banner tone-mid">
            {t('dynsec-clientDefaults_defaultRole-current', { roleLabel: formatDefaultRoleLabel({
              rolename: data.clientDefaults.defaultRoleName,
              priority: data.clientDefaults.defaultRolePriority
            }) })}
          </div>
        {/if}
      {:else if data.bootstrapDefaultRoleStatus.status !== 'running'}
        <p class="muted">{t('dynsec-clientDefaults_defaultRole-empty')}</p>
      {/if}
      <form class="stack-tight dynsec-defaults-form" on:submit|preventDefault={saveClientDefaults}>
        <div class:dynsec-defaults-controls-priority={showAssignmentPriorities} class="dynsec-defaults-controls">
          <label class="stack-tight">
            <span class="muted">{t('dynsec-common-defaultRole')}</span>
            <select bind:value={defaultRoleName}>
              <option value="">{t('dynsec-common-none')}</option>
              {#each data.state.roles as role}
                <option value={role.rolename}>{role.rolename}</option>
              {/each}
            </select>
          </label>
          {#if showAssignmentPriorities}
            <label class="stack-tight">
              <span class="muted">{t('dynsec-common-priority')}</span>
              <input bind:value={defaultRolePriority} type="number" />
            </label>
          {/if}
          <div class="form-actions dynsec-defaults-actions">
            <button class="button-mid" type="submit">{t('dynsec-clientDefaults_button-save')}</button>
          </div>
        </div>
      </form>
    </article>

  </div>

  <div class="stack inspection-cluster">
    <article class="panel stack">
      <h2>{t('dynsec-clients_section-heading')}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('dynsec-clients_column-client')}</th>
              <th>{t('dynsec-clients_column-groups')}</th>
              <th>{t('dynsec-clients_column-roles')}</th>
              <th>{t('dynsec-common-state')}</th>
              <th>{t('dynsec-common-actions')}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.state.clients as client}
              <tr class:selected-row={selectedClientEntry?.username === client.username}>
                <td>
                  <strong>{client.username}</strong>
                  <div class="subtle">{client.clientid ?? t('dynsec-common-noBoundClientId')}</div>
                </td>
                <td>
                  <div class="pill-row">
                    {#each client.groups as group}
                      <span class="badge">{formatAssignmentLabel({ label: group.groupname, priority: group.priority })}</span>
                    {/each}
                  </div>
                </td>
                <td>
                  <div class="pill-row">
                    {#each client.roles as role}
                      <span class="badge">{formatAssignmentLabel({ label: role.rolename, priority: role.priority })}</span>
                    {/each}
                  </div>
                </td>
                <td class={client.disabled ? 'tone-danger' : 'tone-mid'}>{formatClientState({ disabled: client.disabled })}</td>
                <td class="form-actions client-table-actions">
                  <button
                    class={`client-action-button ${selectedClientEntry?.username === client.username ? 'button-start' : 'button-mid'}`}
                    type="button"
                    on:click={() => inspectClient(client.username)}
                  >
                    {selectedClientEntry?.username === client.username ? t('dynsec-common-selected') : t('dynsec-common-inspect')}
                  </button>
                  <button
                    class={`client-action-button ${client.disabled ? 'button-start' : 'button-warning'}`}
                    type="button"
                    on:click={() => toggleClient(client.username, client.disabled)}
                  >
                    {client.disabled ? t('dynsec-common-enable') : t('dynsec-common-disable')}
                  </button>
                  <button class="button-danger client-action-button" type="button" on:click={() => deleteClient(client.username)}>{t('dynsec-common-delete')}</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>

    {#if selectedClientEntry}
      <article class="panel stack inspection-panel">
        <div class="page-header">
          <div class="stack-tight">
            <h2>{t('dynsec-clientAssignments_section-heading')}</h2>
            <div class="muted">
              {t('dynsec-clientAssignments_selectedClient', { username: selectedClientEntry.username })}
              {#if selectedClientEntry.clientid}
                <span class="subtle">({selectedClientEntry.clientid})</span>
              {/if}
            </div>
          </div>
          <button class="button-mid" type="button" on:click={clearSelectedClient}>{t('dynsec-common-deselect')}</button>
        </div>
        {#if assignmentMessage}
          <div class="badge tone-mid">{assignmentMessage}</div>
        {/if}
        {#if assignmentError}
          <div class="badge tone-danger">{assignmentError}</div>
        {/if}

        <div class="stack">
          <div class="stack-tight">
            <h3>{t('dynsec-clientAssignments_directRoles-heading')}</h3>
            {#if selectedClientEntry.roles.length}
              <div class="pill-row">
                {#each selectedClientEntry.roles as role}
                  <span class="badge removable-badge">
                    <span>{formatAssignmentLabel({ label: role.rolename, priority: role.priority })}</span>
                    <button class="badge-action" type="button" on:click={() => removeRoleFromSelectedClient(role.rolename)}>{t('dynsec-common-remove')}</button>
                  </span>
                {/each}
              </div>
            {:else}
              <p class="muted">{t('dynsec-clientAssignments_directRoles-empty')}</p>
            {/if}
          </div>

          <div class="stack-tight">
            <h3>{t('dynsec-clientAssignments_groups-heading')}</h3>
            {#if selectedClientEntry.groups.length}
              <div class="pill-row">
                {#each selectedClientEntry.groups as group}
                  <span class="badge removable-badge">
                    <span>{formatAssignmentLabel({ label: group.groupname, priority: group.priority })}</span>
                    <button class="badge-action" type="button" on:click={() => removeSelectedClientFromGroup(group.groupname)}>{t('dynsec-common-remove')}</button>
                  </span>
                {/each}
              </div>
            {:else}
              <p class="muted">{t('dynsec-clientAssignments_groups-empty')}</p>
            {/if}
          </div>
        </div>

        <div class="panel-grid">
          <form class="panel stack" on:submit|preventDefault={assignRoleToSelectedClient}>
            <h3>{t('dynsec-clientAssignments_assignRole-heading')}</h3>
            <label class="stack-tight">
              <span class="muted">{t('dynsec-common-role')}</span>
              <select bind:value={assignRoleName}>
                <option value="">{t('dynsec-common-selectRole')}</option>
                {#each data.state.roles as role}
                  <option value={role.rolename}>{role.rolename}</option>
                {/each}
              </select>
            </label>
            {#if showAssignmentPriorities}
              <label class="stack-tight">
                <span class="muted">{t('dynsec-common-priority')}</span>
                <input bind:value={assignRolePriority} type="number" />
              </label>
            {/if}
            <button class="button-warning" type="submit" disabled={!assignRoleName}>{t('dynsec-clientAssignments_button-assignRole')}</button>
          </form>

          <form class="panel stack" on:submit|preventDefault={addSelectedClientToGroup}>
            <h3>{t('dynsec-clientAssignments_addToGroup-heading')}</h3>
            <label class="stack-tight">
              <span class="muted">{t('dynsec-common-group')}</span>
              <select bind:value={assignGroupName}>
                <option value="">{t('dynsec-common-selectGroup')}</option>
                {#each data.state.groups as group}
                  <option value={group.groupname}>{group.groupname}</option>
                {/each}
              </select>
            </label>
            {#if showAssignmentPriorities}
              <label class="stack-tight">
                <span class="muted">{t('dynsec-common-priority')}</span>
                <input bind:value={assignGroupPriority} type="number" />
              </label>
            {/if}
            <button class="button-mid" type="submit" disabled={!assignGroupName}>{t('dynsec-clientAssignments_button-addToGroup')}</button>
          </form>
        </div>
      </article>

      <article class="panel stack inspection-panel">
        <button
          class="create-toggle"
          type="button"
          aria-expanded={effectivePermissionsOpen}
          on:click={toggleEffectivePermissions}
        >
          <span>{t('dynsec-effectivePermissions_toggle-label')}</span>
          <span class="create-toggle-indicator" aria-hidden="true">{effectivePermissionsOpen ? '−' : '+'}</span>
        </button>

        {#if effectivePermissionsOpen}
          <div class="muted">{t('dynsec-effectivePermissions_inspecting', { username: data.selectedClient ?? '' })}</div>
          <div class="subtle">{t('dynsec-effectivePermissions_note')}</div>
          {#if data.effectivePermissions}
            {#if data.effectivePermissions.warnings.length}
              {#each data.effectivePermissions.warnings as warning}
                <div class="badge tone-warning">{warning}</div>
              {/each}
            {/if}
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('dynsec-effectivePermissions_column-acl')}</th>
                    <th>{t('dynsec-effectivePermissions_column-topic')}</th>
                    <th>{t('dynsec-effectivePermissions_column-effect')}</th>
                    <th>{t('dynsec-effectivePermissions_column-priority')}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each data.effectivePermissions.mergedAcls as acl}
                    <tr>
                      <td>{formatAclType(acl.acltype)}</td>
                      <td>{acl.topic}</td>
                      <td class={acl.allow ? 'tone-mid' : 'tone-danger'}>{formatAclEffect({ allow: acl.allow })}</td>
                      <td>{acl.priority}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <p class="muted">{t('dynsec-effectivePermissions-empty')}</p>
          {/if}
        {/if}
      </article>
    {/if}
  </div>

  <div class="stack inspection-cluster">
    <article class="panel stack">
      <h2>{t('dynsec-roles_section-heading')}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('dynsec-roles_column-role')}</th>
              <th>{t('dynsec-roles_column-acls')}</th>
              <th>{t('dynsec-common-actions')}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.state.roles as role}
              <tr class:selected-row={selectedRoleEntry?.rolename === role.rolename}>
                <td>{role.rolename}</td>
                <td>{role.acls.map((acl) => `${formatAclType(acl.acltype)}:${acl.topic}:${formatAclEffect({ allow: acl.allow })}:${acl.priority}`).join(', ') || t('dynsec-common-none')}</td>
                <td class="form-actions client-table-actions">
                  <button
                    class={`client-action-button ${selectedRoleEntry?.rolename === role.rolename ? 'button-start' : 'button-mid'}`}
                    type="button"
                    on:click={() => inspectRole(role.rolename)}
                  >
                    {selectedRoleEntry?.rolename === role.rolename ? t('dynsec-common-selected') : t('dynsec-common-inspect')}
                  </button>
                  <button class="button-danger client-action-button" type="button" on:click={() => deleteRole(role.rolename)}>{t('dynsec-common-delete')}</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>

    {#if selectedRoleEntry}
      <article class="panel stack inspection-panel">
        <div class="page-header">
          <h2>{t('dynsec-roleAcls_section-heading', { rolename: selectedRoleEntry.rolename })}</h2>
          <button class="button-mid" type="button" on:click={clearSelectedRole}>{t('dynsec-common-deselect')}</button>
        </div>
        {#if roleMessage}
          <div class="badge tone-mid">{roleMessage}</div>
        {/if}
        {#if roleError}
          <div class="badge tone-danger">{roleError}</div>
        {/if}

        <div class="stack-tight">
          <h3>{t('dynsec-addRoleAcl_section-heading')}</h3>
          <form class="form-grid role-acl-form" on:submit|preventDefault={addAcl}>
            <label class="stack-tight role-acl-types-field">
              <span class="muted">{t('dynsec-common-acl')}</span>
              <details bind:this={aclTypeMenu} class="acl-multi-select">
                <summary>{formatAclTypeSelection({ acltypes: aclTypes })}</summary>
                <div class="acl-multi-select-menu">
                  <div class="acl-multi-select-actions">
                    <button
                      class="button-ghost acl-multi-select-action-button"
                      type="button"
                      disabled={aclTypes.length === dynsecAclTypes.length}
                      on:click={selectAllAclTypes}
                    >
                      {t('dynsec-common-selectAllAcls')}
                    </button>
                    <button
                      class="button-ghost acl-multi-select-action-button"
                      type="button"
                      disabled={!aclTypes.length}
                      on:click={clearAclTypes}
                    >
                      {t('dynsec-common-deselectAllAcls')}
                    </button>
                  </div>
                  {#each dynsecAclTypes as acltype}
                    <label class:selected={aclTypes.includes(acltype)} class="acl-multi-select-option">
                      <input
                        class="acl-multi-select-input"
                        type="checkbox"
                        checked={aclTypes.includes(acltype)}
                        on:change={(event) =>
                          toggleAclType({
                            acltype,
                            checked: (event.currentTarget as HTMLInputElement).checked
                          })}
                      />
                      <span aria-hidden="true" class="acl-multi-select-marker"></span>
                      <span class="acl-multi-select-code">{aclTypeShortLabels[acltype]}</span>
                      <span>{formatAclType(acltype)}</span>
                    </label>
                  {/each}
                </div>
              </details>
            </label>
            <label class="stack-tight">
              <span class="muted">{t('dynsec-common-topic')}</span>
              <input bind:value={aclTopic} placeholder="#" />
            </label>
            <label class="stack-tight">
              <span class="muted">{t('dynsec-common-priority')}</span>
              <input bind:value={aclPriority} type="number" />
            </label>
            <label class="stack-tight">
              <span class="muted">{t('dynsec-common-effect')}</span>
              <select bind:value={aclAllow}>
                <option value={true}>{t('dynsec-common-allow')}</option>
                <option value={false}>{t('dynsec-common-deny')}</option>
              </select>
            </label>
            <div class="form-actions form-actions-end">
              <button class="button-start acl-submit-button" type="submit" disabled={!aclTypes.length}>{t('dynsec-addRoleAcl_button-submit')}</button>
            </div>
          </form>
        </div>

        <div class="stack-tight">
          <h3>{t('dynsec-roleAcls_assigned-heading')}</h3>
          {#if selectedRoleEntry.acls.length}
            <div class="table-wrap compact-table-wrap">
              <table class="compact-table">
                <thead>
                  <tr>
                    <th>{t('dynsec-common-acl')}</th>
                    <th>{t('dynsec-common-topic')}</th>
                    <th>{t('dynsec-common-effect')}</th>
                    <th>{t('dynsec-common-priority')}</th>
                    <th>{t('dynsec-common-action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each selectedRoleEntry.acls as acl}
                    <tr>
                      <td>{formatAclType(acl.acltype)}</td>
                      <td>{acl.topic}</td>
                      <td class={acl.allow ? 'tone-mid' : 'tone-danger'}>{formatAclEffect({ allow: acl.allow })}</td>
                      <td>{acl.priority}</td>
                      <td>
                        <button
                          class="button-danger compact-action-button"
                          type="button"
                          on:click={() => removeAclFromSelectedRole({ acltype: acl.acltype, topic: acl.topic })}
                        >
                          {t('dynsec-common-remove')}
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <p class="muted">{t('dynsec-roleAcls_empty')}</p>
          {/if}
        </div>
      </article>
    {/if}
  </div>

  <div class="stack inspection-cluster">
    <article class="panel stack">
      <h2>{t('dynsec-groups_section-heading')}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('dynsec-groups_column-group')}</th>
              <th>{t('dynsec-groups_column-clients')}</th>
              <th>{t('dynsec-groups_column-roles')}</th>
              <th>{t('dynsec-common-actions')}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.state.groups as group}
              <tr class:selected-row={selectedGroupEntry?.groupname === group.groupname}>
                <td>{group.groupname}</td>
                <td>{group.clients.map((entry) => formatAssignmentLabel({ label: entry.username, priority: entry.priority })).join(', ') || t('dynsec-common-none')}</td>
                <td>{group.roles.map((entry) => formatAssignmentLabel({ label: entry.rolename, priority: entry.priority })).join(', ') || t('dynsec-common-none')}</td>
                <td class="form-actions client-table-actions">
                  <button
                    class={`client-action-button ${selectedGroupEntry?.groupname === group.groupname ? 'button-start' : 'button-mid'}`}
                    type="button"
                    on:click={() => inspectGroup(group.groupname)}
                  >
                    {selectedGroupEntry?.groupname === group.groupname ? t('dynsec-common-selected') : t('dynsec-common-inspect')}
                  </button>
                  <button class="button-danger client-action-button" type="button" on:click={() => deleteGroup(group.groupname)}>{t('dynsec-common-delete')}</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>

    {#if selectedGroupEntry}
      <article class="panel stack inspection-panel">
        <div class="page-header">
          <h2>{t('dynsec-groupAssignments_section-heading', { groupname: selectedGroupEntry.groupname })}</h2>
          <button class="button-mid" type="button" on:click={clearSelectedGroup}>{t('dynsec-common-deselect')}</button>
        </div>
        {#if groupMessage}
          <div class="badge tone-mid">{groupMessage}</div>
        {/if}
        {#if groupError}
          <div class="badge tone-danger">{groupError}</div>
        {/if}

        <div class="stack">
          <div class="stack-tight">
            <h3>{t('dynsec-groupAssignments_roles-heading')}</h3>
            {#if selectedGroupEntry.roles.length}
              <div class="pill-row">
                {#each selectedGroupEntry.roles as role}
                  <span class="badge removable-badge">
                    <span>{formatAssignmentLabel({ label: role.rolename, priority: role.priority })}</span>
                    <button class="badge-action" type="button" on:click={() => removeRoleFromSelectedGroup(role.rolename)}>{t('dynsec-common-remove')}</button>
                  </span>
                {/each}
              </div>
            {:else}
              <p class="muted">{t('dynsec-groupAssignments_roles-empty')}</p>
            {/if}
          </div>

          <div class="stack-tight">
            <h3>{t('dynsec-groupAssignments_clients-heading')}</h3>
            {#if selectedGroupEntry.clients.length}
              <div class="pill-row">
                {#each selectedGroupEntry.clients as client}
                  <span class="badge removable-badge">
                    <span>{formatAssignmentLabel({ label: client.username, priority: client.priority })}</span>
                    <button class="badge-action" type="button" on:click={() => removeSelectedGroupClient(client.username)}>{t('dynsec-common-remove')}</button>
                  </span>
                {/each}
              </div>
            {:else}
              <p class="muted">{t('dynsec-groupAssignments_clients-empty')}</p>
            {/if}
          </div>
        </div>

        <form class="panel stack" on:submit|preventDefault={assignRoleToSelectedGroup}>
          <h3>{t('dynsec-groupAssignments_assignRole-heading')}</h3>
          <label class="stack-tight">
            <span class="muted">{t('dynsec-common-role')}</span>
            <select bind:value={assignGroupRoleName}>
              <option value="">{t('dynsec-common-selectRole')}</option>
              {#each data.state.roles as role}
                <option value={role.rolename}>{role.rolename}</option>
              {/each}
            </select>
          </label>
          {#if showAssignmentPriorities}
            <label class="stack-tight">
              <span class="muted">{t('dynsec-common-priority')}</span>
              <input bind:value={assignGroupRolePriority} type="number" />
            </label>
          {/if}
          <button class="button-warning" type="submit" disabled={!assignGroupRoleName}>{t('dynsec-groupAssignments_button-assignRole')}</button>
        </form>
      </article>
    {/if}
  </div>

</section>

<style>
  .dynsec-page {
    gap: 1.5rem;
    --dynsec-control-min-height: 2.45rem;
    --dynsec-control-padding-block: 0.65rem;
    --dynsec-control-padding-inline: 0.9rem;
  }

  .dynsec-page :is(input:not([type='checkbox']), select) {
    min-height: var(--dynsec-control-min-height);
    padding: var(--dynsec-control-padding-block) var(--dynsec-control-padding-inline);
  }

  .dynsec-page .form-actions-end > button,
  .dynsec-page form.stack > button {
    min-height: var(--dynsec-control-min-height);
    padding: var(--dynsec-control-padding-block) var(--dynsec-control-padding-inline);
  }

  .inspection-cluster {
    gap: 0.65rem;
  }

  .create-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    border-style: dashed;
    text-align: left;
  }

  .create-toggle-indicator {
    font-size: 1.25rem;
    line-height: 1;
  }

  .create-card {
    align-self: start;
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
  }

  .create-card > form {
    align-content: start;
  }

  .client-table-actions {
    align-items: flex-start;
  }

  .client-action-button {
    width: 6.75rem;
    text-align: center;
  }

  .removable-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
    padding-right: 0.35rem;
  }

  .badge-action {
    border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-panel-strong) 88%, var(--color-mid-soft));
    color: var(--color-text);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    padding: 0.32rem 0.65rem;
    transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
  }

  .badge-action:hover,
  .badge-action:focus-visible {
    border-color: var(--color-mid);
    background: color-mix(in srgb, var(--color-mid-soft) 75%, var(--color-panel-strong));
    transform: translateY(-1px);
  }

  .selected-row {
    background: var(--color-mid-soft);
  }

  .inspection-panel {
    margin-top: 0;
  }

  .form-actions-end {
    align-self: end;
  }

  .dynsec-defaults-form {
    gap: var(--space-3);
  }

  .dynsec-defaults-panel {
    align-self: start;
  }

  .dynsec-status-banner {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 0;
    padding: 0.65rem 1rem;
    border-radius: var(--radius-md);
    line-height: 1.45;
  }

  .dynsec-defaults-controls {
    grid-template-columns: minmax(15rem, 1fr) auto;
    display: grid;
    align-items: end;
    gap: var(--space-4);
  }

  .dynsec-defaults-controls.dynsec-defaults-controls-priority {
    grid-template-columns: minmax(15rem, 1fr) minmax(10rem, 12rem) auto;
  }

  .dynsec-defaults-actions {
    justify-content: flex-end;
    align-self: end;
  }

  .acl-submit-button {
    min-height: var(--dynsec-control-min-height);
  }

  .role-acl-form {
    grid-template-columns:
      minmax(18rem, 1.5fr)
      minmax(12rem, 1fr)
      minmax(8rem, 0.75fr)
      minmax(10rem, 0.9fr)
      auto;
    align-items: end;
  }

  .role-acl-types-field {
    grid-column: auto;
  }

  .acl-multi-select {
    position: relative;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
  }

  .acl-multi-select summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    min-height: var(--dynsec-control-min-height);
    padding: var(--dynsec-control-padding-block) var(--dynsec-control-padding-inline);
  }

  .acl-multi-select[open] summary {
    border-bottom: 1px solid var(--color-border);
  }

  .acl-multi-select summary::-webkit-details-marker {
    display: none;
  }

  .acl-multi-select-menu {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    right: 0;
    z-index: 20;
    display: grid;
    gap: 0.4rem;
    padding: 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-border) 30%, transparent);
  }

  .acl-multi-select-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .acl-multi-select-action-button {
    width: 100%;
    min-height: auto;
    padding: 0.35rem 0.65rem;
    border-color: var(--color-border-strong);
    background: var(--color-panel-strong);
    box-shadow: none;
  }

  .acl-multi-select-action-button:hover {
    border-color: var(--color-start);
    box-shadow: var(--shadow-hover);
  }

  .acl-multi-select-actions:hover .acl-multi-select-action-button:not(:hover) {
    border-color: var(--color-border-strong);
    box-shadow: none;
  }

  .acl-multi-select-option {
    display: grid;
    grid-template-columns: auto auto auto minmax(0, 1fr);
    align-items: center;
    gap: 0.65rem;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-panel);
  }

  .acl-multi-select-input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .acl-multi-select-marker {
    width: 1.15rem;
    height: 1.15rem;
    border: 1px solid var(--color-border);
    border-radius: 0.35rem;
    background: var(--color-panel-strong);
  }

  .acl-multi-select-option.selected .acl-multi-select-marker {
    border-color: var(--color-mid);
    background: var(--color-mid-soft);
    box-shadow: inset 0 0 0 0.28rem var(--color-mid);
  }

  .acl-multi-select-code {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    padding: 0.15rem 0.35rem;
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 0.85rem;
    line-height: 1.1;
  }

  .compact-table-wrap {
    background: transparent;
  }

  .compact-table th,
  .compact-table td {
    white-space: nowrap;
  }

  .compact-action-button {
    min-height: 2.2rem;
    padding: 0.45rem 0.8rem;
  }

  @media (max-width: 860px) {
    .dynsec-defaults-controls,
    .dynsec-defaults-controls.dynsec-defaults-controls-priority {
      grid-template-columns: 1fr;
    }

    .dynsec-defaults-actions {
      justify-content: flex-start;
    }

    .role-acl-form {
      grid-template-columns: 1fr;
    }
  }
</style>
