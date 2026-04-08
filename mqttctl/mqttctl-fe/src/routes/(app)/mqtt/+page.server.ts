import { requireMqttSessionUser } from '$lib/server/mqtt/access';
import type { DynsecAcl, DynsecClient, DynsecGroup, DynsecRole, DynsecState } from '$lib/types';
import { createOpaqueToken } from '$server/utils/ids';

const sortAclsByPriorityAndEffect = <T extends DynsecAcl>(items: T[]) =>
  [...items].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    if (left.allow !== right.allow) return left.allow ? 1 : -1;
    return `${left.acltype}:${left.topic}`.localeCompare(`${right.acltype}:${right.topic}`);
  });

const resolveEffectiveAcls = ({ value }: { value: DynsecAcl[] }) => {
  const effective = new Map<string, DynsecAcl>();

  for (const acl of value) {
    const key = `${acl.acltype}:${acl.topic}`;
    const current = effective.get(key);

    if (!current) {
      effective.set(key, acl);
      continue;
    }

    if (acl.priority > current.priority) {
      effective.set(key, acl);
      continue;
    }

    if (acl.priority === current.priority && current.allow && !acl.allow) {
      effective.set(key, acl);
    }
  }

  return sortAclsByPriorityAndEffect([...effective.values()]);
};

type DynsecSubscriptionAccessPreview = {
  filter: string;
  acltype: 'subscribeLiteral' | 'subscribePattern';
  priority: number;
};

type DynsecMqttAccessPreview = {
  subscribeFilters: DynsecSubscriptionAccessPreview[];
  warnings: string[];
};

const buildDynsecMqttAccess = ({
  state,
  configuredAdminUsername
}: {
  state: DynsecState;
  configuredAdminUsername: string;
}) => {
  const roleLookup = new Map(state.roles.map((role) => [role.rolename, role] as const));
  const groupLookup = new Map(state.groups.map((group) => [group.groupname, group] as const));

  return Object.fromEntries(
    state.clients.map((client) => {
      const directRoles = client.roles
        .map((reference) => roleLookup.get(reference.rolename))
        .filter((entry): entry is DynsecRole => Boolean(entry));
      const inheritedGroups = client.groups
        .map((reference) => groupLookup.get(reference.groupname))
        .filter((entry): entry is DynsecGroup => Boolean(entry))
        .map((group) => ({
          group,
          roles: group.roles
            .map((reference) => roleLookup.get(reference.rolename))
            .filter((entry): entry is DynsecRole => Boolean(entry))
        }));
      const mergedAcls = resolveEffectiveAcls({
        value: [
          ...directRoles.flatMap((role) => role.acls),
          ...inheritedGroups.flatMap((entry) => entry.roles.flatMap((role) => role.acls))
        ]
      });
      const subscribeFilters = mergedAcls
        .filter((acl): acl is DynsecAcl & { acltype: 'subscribeLiteral' | 'subscribePattern' } =>
          acl.allow && (acl.acltype === 'subscribeLiteral' || acl.acltype === 'subscribePattern'))
        .map((acl) => ({
          filter: acl.topic,
          acltype: acl.acltype,
          priority: acl.priority
        }));
      const receiveFilters = mergedAcls
        .filter((acl) => acl.allow && acl.acltype === 'publishClientReceive')
        .map((acl) => ({
          filter: acl.topic,
          priority: acl.priority
        }));
      const publishSendFilters = mergedAcls
        .filter((acl) => acl.allow && acl.acltype === 'publishClientSend')
        .map((acl) => ({
          filter: acl.topic,
          priority: acl.priority
        }));
      const warnings: string[] = [];

      if (subscribeFilters.length > 0 && receiveFilters.length === 0) {
        warnings.push('This client has subscribe ACLs but no Read/Receive ACLs. Mosquitto may accept the subscription and still deliver no messages.');
      }

      if (
        subscribeFilters.some((acl) => acl.filter === '#')
        && !receiveFilters.some((acl) => acl.filter === '#')
      ) {
        warnings.push('Read/Receive ACLs are narrower than the subscribe ACLs shown here. Non-matching topics can stay invisible even when the subscription filter matches them.');
      }

      if (
        subscribeFilters.some((acl) => acl.filter === '#')
        && !publishSendFilters.some((acl) => acl.filter === '#')
      ) {
        warnings.push(
          client.username === configuredAdminUsername
            ? 'This dynsec admin client can subscribe broadly, but the built-in Mosquitto admin role does not currently show broker-wide Write/Publish:# access. Publish tests to arbitrary topics can still fail.'
            : 'This client can subscribe broadly, but it does not have broker-wide Write/Publish:# access. Publish tests to arbitrary topics can still fail.'
        );
      }

      return [
        client.username,
        {
          subscribeFilters,
          warnings
        } satisfies DynsecMqttAccessPreview
      ] as const;
    })
  );
};

export const load = async (event) => {
  const { sessionKey, canUseDynsec } = requireMqttSessionUser({ event });
  const generatedClientId = `mqttctl-web-${createOpaqueToken({ bytes: 8 })}`;
  const publishPanelParam = event.url.searchParams.get('publish');
  const latestTopicsPanelParam = event.url.searchParams.get('topics');
  const dynsecState = canUseDynsec
    ? await event.locals.appContext.dynsec.readState({
        correlationId: event.locals.correlationId
      })
    : null;
  const dynsecClients = (dynsecState?.clients ?? [])
    .map((client) => ({
      username: client.username,
      clientId: client.clientid ?? `mqttctl-web-${createOpaqueToken({ bytes: 8 })}`,
      clientIdIsRandom: !client.clientid,
      textName: client.textname,
      disabled: client.disabled
    }))
    .sort((left, right) => left.username.localeCompare(right.username));
  const requestedClient = event.url.searchParams.get('client');
  const hasRequestedClient = requestedClient && dynsecClients.some((client) => client.username === requestedClient);
  const adminClient = dynsecClients.find((client) => client.username === 'admin') ?? null;
  const selectedDynsecUsername = hasRequestedClient
    ? requestedClient
    : adminClient?.username ?? dynsecClients[0]?.username ?? null;
  const dynsecMqttAccess = dynsecState
    ? buildDynsecMqttAccess({
        state: dynsecState,
        configuredAdminUsername: event.locals.appContext.runtimeConfig.config.broker.dynsecAdminUsername
      })
    : {};

  return {
    explorer: event.locals.appContext.mqtt.getExplorerState({ sessionKey }),
    dynsecClients,
    dynsecMqttAccess,
    generatedClientId,
    canUseDynsec,
    selectedDynsecUsername,
    publishPanelOpen: publishPanelParam !== 'closed',
    latestTopicsOpen: latestTopicsPanelParam !== 'closed'
  };
};
