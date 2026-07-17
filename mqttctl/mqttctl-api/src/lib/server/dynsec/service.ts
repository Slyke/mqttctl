import { readFile } from 'node:fs/promises';
import type {
  DynsecAcl,
  DynsecClient,
  DynsecClientDefaults,
  DynsecClientRef,
  DynsecGroup,
  DynsecGroupRef,
  DynsecRole,
  DynsecRoleRef,
  DynsecState,
  EffectivePermissionView,
  OperationStatus
} from '$lib/types';
import {
  dynsecAclTypes,
  dynsecBootstrapDefaultRoleName,
  dynsecBootstrapReadWriteRoleName,
  dynsecLegacyBootstrapRoleName
} from '$lib/types';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppLogger } from '$server/logging/logger';
import { AppError, createAppError } from '$server/logging/errors';
import { runCommand, type CommandResult } from '$server/broker/command-runner';
import type { BrokerAgentClient } from '$server/broker-agent/client';
import type { AppDatabase } from '$server/db';

const redactedToken = '<redacted>';
const dynsecClientDefaultsScope = 'dynsec';
const dynsecClientDefaultsKey = 'clientDefaults';
const dynsecBootstrapDefaultRoleInitializedKey = 'bootstrapDefaultRoleInitialized';
const dynsecBootstrapDefaultRolePriority = 0;
const dynsecBootstrapDefaultRoleStateSyncGraceMs = 10_000;
const dynsecBootstrapReservedRoles = new Set([
  'admin',
  'broker-admin',
  'client',
  'dynsec-admin',
  'super-admin',
  'sys-notify',
  'sys-observe',
  'topic-observe',
  dynsecBootstrapDefaultRoleName,
  dynsecBootstrapReadWriteRoleName,
  dynsecLegacyBootstrapRoleName
]);
const dynsecBootstrapDefaultRoleAcls: Array<Pick<DynsecAcl, 'acltype' | 'topic' | 'allow' | 'priority'>> = [
  {
    acltype: 'publishClientReceive',
    topic: '#',
    allow: true,
    priority: 0
  },
  {
    acltype: 'subscribePattern',
    topic: '#',
    allow: true,
    priority: 0
  },
  {
    acltype: 'unsubscribePattern',
    topic: '#',
    allow: true,
    priority: 0
  }
];
const dynsecBootstrapReadWriteRoleAcls: Array<Pick<DynsecAcl, 'acltype' | 'topic' | 'allow' | 'priority'>> = [
  ...dynsecBootstrapDefaultRoleAcls,
  {
    acltype: 'publishClientSend',
    topic: '#',
    allow: true,
    priority: 0
  }
];

const numericValue = ({ value, fallback = -1 }: { value: unknown; fallback?: number }) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const integerValue = ({ value, fallback = 0 }: { value: unknown; fallback?: number }) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const idleOperationStatus = (): OperationStatus => ({
  status: 'idle',
  lastRunAt: null,
  message: null
});

interface DynsecBootstrapDefaultRoleError {
  reason: string;
  errorKey: string | null;
  details: unknown;
}

const deriveBootstrapDefaultRoleErrorReason = ({ error }: { error: unknown }) => {
  if (!(error instanceof Error)) return 'Unknown error';
  if (!(error instanceof AppError)) return error.message;

  const context = error.context;
  if (
    context
    && typeof context === 'object'
    && 'rollbackError' in context
    && typeof (context as Record<string, unknown>).rollbackError === 'string'
    && (context as Record<string, unknown>).rollbackError
  ) {
    return (context as Record<string, unknown>).rollbackError as string;
  }

  const nestedReason = error.errorChain.at(-1)?.reason;
  if (nestedReason && nestedReason !== error.message) {
    return nestedReason;
  }

  if (error.cause instanceof Error) {
    return deriveBootstrapDefaultRoleErrorReason({ error: error.cause });
  }

  return error.message;
};

const extractMeaningfulDynsecStderr = ({ stderr }: { stderr: string }) => {
  const benignLines = new Set([
    'Warning: You are running mosquitto_ctrl without encryption.',
    'This means all of the configuration changes you are making are visible on the network, including passwords.'
  ]);

  return stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !benignLines.has(line))
    .join('\n');
};

const normalizeEntityName = ({ value }: { value: string }) => value.trim();

const parseRoleRefs = ({ value }: { value: unknown }): DynsecRoleRef[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') return { rolename: entry, priority: -1 };
      if (!entry || typeof entry !== 'object') return null;
      const rolename = String((entry as Record<string, unknown>).rolename ?? (entry as Record<string, unknown>).name ?? '');
      if (!rolename) return null;
      return {
        rolename,
        priority: numericValue({ value: (entry as Record<string, unknown>).priority })
      };
    })
    .filter((entry): entry is DynsecRoleRef => Boolean(entry));
};

const parseGroupRefs = ({ value }: { value: unknown }): DynsecGroupRef[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') return { groupname: entry, priority: -1 };
      if (!entry || typeof entry !== 'object') return null;
      const groupname = String((entry as Record<string, unknown>).groupname ?? (entry as Record<string, unknown>).name ?? '');
      if (!groupname) return null;
      return {
        groupname,
        priority: numericValue({ value: (entry as Record<string, unknown>).priority })
      };
    })
    .filter((entry): entry is DynsecGroupRef => Boolean(entry));
};

const parseClientRefs = ({ value }: { value: unknown }): DynsecClientRef[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') return { username: entry, priority: -1 };
      if (!entry || typeof entry !== 'object') return null;
      const username = String((entry as Record<string, unknown>).username ?? (entry as Record<string, unknown>).name ?? '');
      if (!username) return null;
      return {
        username,
        priority: numericValue({ value: (entry as Record<string, unknown>).priority })
      };
    })
    .filter((entry): entry is DynsecClientRef => Boolean(entry));
};

const parseAcls = ({ value }: { value: unknown }): DynsecAcl[] => {
  if (Array.isArray(value)) {
    const parsed: DynsecAcl[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const aclRecord = entry as Record<string, unknown>;
      const acltype = String(aclRecord.acltype ?? '');
      const topic = String(aclRecord.topic ?? '');
      if (!acltype || !topic) continue;
      parsed.push({
        acltype: acltype as DynsecAcl['acltype'],
        topic,
        priority: numericValue({ value: aclRecord.priority }),
        allow: Boolean(aclRecord.allow ?? (aclRecord.effect === 'allow')),
        name: (aclRecord.name as string | null) ?? null,
        description: (aclRecord.description as string | null) ?? null
      });
    }
    return parsed;
  }

  if (!value || typeof value !== 'object') return [];

  const parsed: DynsecAcl[] = [];

  for (const [acltype, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const aclRecord = entry as Record<string, unknown>;
      const topic = String(aclRecord.topic ?? '');
      if (!topic) continue;
      parsed.push({
        acltype: acltype as DynsecAcl['acltype'],
        topic,
        priority: numericValue({ value: aclRecord.priority }),
        allow: Boolean(aclRecord.allow ?? (aclRecord.effect === 'allow')),
        name: (aclRecord.name as string | null) ?? null,
        description: (aclRecord.description as string | null) ?? null
      });
    }
  }

  return parsed;
};

const sortByPriorityDesc = <T extends { priority: number }>(items: T[]) => [...items].sort((left, right) => right.priority - left.priority);
const mergePriority = ({ left, right }: { left: number; right: number }) => Math.max(left, right);
const sortAclsByPriorityAndEffect = <T extends DynsecAcl>(items: T[]) =>
  [...items].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    if (left.allow !== right.allow) return left.allow ? 1 : -1;
    return `${left.acltype}:${left.topic}`.localeCompare(`${right.acltype}:${right.topic}`);
  });

const normalizeAclTypeSelection = ({ value }: { value: DynsecAcl['acltype'][] }) => {
  const selected = new Set(value);
  return dynsecAclTypes.filter((acltype) => selected.has(acltype));
};

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

const normalizeClientDefaults = ({ value }: { value: unknown }): DynsecClientDefaults => {
  if (!value || typeof value !== 'object') {
    return {
      defaultRoleName: null,
      defaultRolePriority: 0
    };
  }

  const record = value as Record<string, unknown>;
  const defaultRoleName = typeof record.defaultRoleName === 'string' && record.defaultRoleName.trim()
    ? record.defaultRoleName.trim()
    : null;

  return {
    defaultRoleName,
    defaultRolePriority: integerValue({ value: record.defaultRolePriority, fallback: 0 })
  };
};

const summarizeCredentialValue = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string' || value.length <= 12) return redactedToken;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
};

const sanitizeDynsecCredentialFields = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDynsecCredentialFields({ value: entry }));
  }

  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === 'password' || key === 'salt'
        ? summarizeCredentialValue({ value: entry })
        : sanitizeDynsecCredentialFields({ value: entry })
    ])
  );
};

const normalizeState = ({ raw }: { raw: Record<string, unknown> }): DynsecState => {
  const parsedClients = Array.isArray(raw.clients)
    ? raw.clients.map((entry) => {
      const client = entry as Record<string, unknown>;
      return {
        username: String(client.username ?? client.name ?? ''),
        clientid: (client.clientid as string | null) ?? null,
        textname: (client.textname as string | null) ?? null,
        textdescription: (client.textdescription as string | null) ?? null,
        disabled: Boolean(client.disabled),
        roles: sortByPriorityDesc(parseRoleRefs({ value: client.roles })),
        groups: sortByPriorityDesc(parseGroupRefs({ value: client.groups }))
      } satisfies DynsecClient;
    }).filter((entry) => entry.username)
    : [];

  const parsedGroups = Array.isArray(raw.groups)
    ? raw.groups.map((entry) => {
      const group = entry as Record<string, unknown>;
      return {
        groupname: String(group.groupname ?? group.name ?? ''),
        textname: (group.textname as string | null) ?? null,
        textdescription: (group.textdescription as string | null) ?? null,
        roles: sortByPriorityDesc(parseRoleRefs({ value: group.roles })),
        clients: sortByPriorityDesc(parseClientRefs({ value: group.clients }))
      } satisfies DynsecGroup;
    }).filter((entry) => entry.groupname)
    : [];

  const roles = Array.isArray(raw.roles)
    ? raw.roles.map((entry) => {
      const role = entry as Record<string, unknown>;
      return {
        rolename: String(role.rolename ?? role.name ?? ''),
        textname: (role.textname as string | null) ?? null,
        textdescription: (role.textdescription as string | null) ?? null,
        acls: sortByPriorityDesc(parseAcls({ value: role.acls }))
      } satisfies DynsecRole;
    }).filter((entry) => entry.rolename)
    : [];

  const groupMembershipsByClient = new Map<string, Map<string, number>>();
  for (const group of parsedGroups) {
    for (const client of group.clients) {
      const memberships = groupMembershipsByClient.get(client.username) ?? new Map<string, number>();
      memberships.set(group.groupname, mergePriority({
        left: memberships.get(group.groupname) ?? Number.NEGATIVE_INFINITY,
        right: client.priority
      }));
      groupMembershipsByClient.set(client.username, memberships);
    }
  }

  const clientMembershipsByGroup = new Map<string, Map<string, number>>();
  for (const client of parsedClients) {
    for (const group of client.groups) {
      const memberships = clientMembershipsByGroup.get(group.groupname) ?? new Map<string, number>();
      memberships.set(client.username, mergePriority({
        left: memberships.get(client.username) ?? Number.NEGATIVE_INFINITY,
        right: group.priority
      }));
      clientMembershipsByGroup.set(group.groupname, memberships);
    }
  }

  const clients = parsedClients.map((client) => {
    const mergedGroups = new Map(client.groups.map((group) => [group.groupname, group.priority]));

    for (const [groupname, priority] of groupMembershipsByClient.get(client.username) ?? new Map<string, number>()) {
      mergedGroups.set(groupname, mergePriority({
        left: mergedGroups.get(groupname) ?? Number.NEGATIVE_INFINITY,
        right: priority
      }));
    }

    return {
      ...client,
      groups: sortByPriorityDesc(
        [...mergedGroups.entries()].map(([groupname, priority]) => ({ groupname, priority }))
      )
    } satisfies DynsecClient;
  });

  const groups = parsedGroups.map((group) => {
    const mergedClients = new Map(group.clients.map((client) => [client.username, client.priority]));

    for (const [username, priority] of clientMembershipsByGroup.get(group.groupname) ?? new Map<string, number>()) {
      mergedClients.set(username, mergePriority({
        left: mergedClients.get(username) ?? Number.NEGATIVE_INFINITY,
        right: priority
      }));
    }

    return {
      ...group,
      clients: sortByPriorityDesc(
        [...mergedClients.entries()].map(([username, priority]) => ({ username, priority }))
      )
    } satisfies DynsecGroup;
  });

  return {
    clients,
    groups,
    roles,
    anonymousGroup: typeof raw.anonymousGroup === 'string' ? raw.anonymousGroup : null,
    defaultAcls: (raw.defaultACLAccess as Record<string, string | null>) ?? {},
    raw,
    loadedAt: new Date().toISOString()
  };
};

export class DynsecService {
  private bootstrapDefaultRoleProvisionedAt: number | null = null;
  private bootstrapDefaultRoleError: DynsecBootstrapDefaultRoleError | null = null;
  private bootstrapDefaultRoleStatus: OperationStatus = idleOperationStatus();

  constructor(
    private readonly db: AppDatabase,
    private readonly runtimeConfig: LoadedRuntimeConfig,
    private readonly logger: AppLogger,
    private readonly brokerAgent: BrokerAgentClient
  ) {}

  private buildConnectionArgs({ redactPassword = false }: { redactPassword?: boolean } = {}) {
    const args = [
      '-h',
      this.runtimeConfig.config.broker.host,
      '-p',
      String(this.runtimeConfig.config.broker.port),
      '-u',
      this.runtimeConfig.config.broker.dynsecAdminUsername,
      '-P',
      redactPassword ? redactedToken : this.runtimeConfig.secrets.broker.dynsecAdminPassword,
      '-i',
      this.runtimeConfig.config.broker.mqttClientId
    ];

    if (this.runtimeConfig.config.broker.tls.enabled) {
      if (this.runtimeConfig.config.broker.tls.caFile) args.push('--cafile', this.runtimeConfig.config.broker.tls.caFile);
      if (this.runtimeConfig.config.broker.tls.certFile) args.push('--cert', this.runtimeConfig.config.broker.tls.certFile);
      if (this.runtimeConfig.config.broker.tls.keyFile) args.push('--key', this.runtimeConfig.config.broker.tls.keyFile);
      if (this.runtimeConfig.config.broker.tls.insecure) args.push('--insecure');
    }

    return args;
  }

  private buildConnectionOptions() {
    return {
      host: this.runtimeConfig.config.broker.host,
      port: this.runtimeConfig.config.broker.port,
      username: this.runtimeConfig.config.broker.dynsecAdminUsername,
      password: this.runtimeConfig.secrets.broker.dynsecAdminPassword,
      clientId: this.runtimeConfig.config.broker.mqttClientId,
      tls: {
        enabled: this.runtimeConfig.config.broker.tls.enabled,
        caFile: this.runtimeConfig.config.broker.tls.caFile,
        certFile: this.runtimeConfig.config.broker.tls.certFile,
        keyFile: this.runtimeConfig.config.broker.tls.keyFile,
        insecure: this.runtimeConfig.config.broker.tls.insecure
      }
    };
  }

  private redactCommandArgs({ command, args }: { command: string; args: string[] }) {
    if (command === 'setClientPassword' && args.length >= 2) {
      return [args[0]!, redactedToken, ...args.slice(2)];
    }

    return [...args];
  }

  private async runDynsecCommand({
    command,
    args = [],
    correlationId
  }: {
    command: string;
    args?: string[];
    correlationId: string | null;
  }) {
    const redactedArgs = this.redactCommandArgs({ command, args });
    const result = this.brokerAgent.isConfigured()
      ? await this.brokerAgent.runDynsecCommand({
          command,
          args,
          connection: this.buildConnectionOptions(),
          correlationId
        })
      : await runCommand({
          executable: this.runtimeConfig.config.broker.controlBinaryPath,
          args: [...this.buildConnectionArgs(), 'dynsec', command, ...args],
          displayArgs: [...this.buildConnectionArgs({ redactPassword: true }), 'dynsec', command, ...redactedArgs],
          correlationId
        });
    const meaningfulStderr = extractMeaningfulDynsecStderr({ stderr: result.stderr });

    this.logger.info({
      caller: 'dynsec::runDynsecCommand',
      message: `dynsec ${command} exited with ${result.exitCode}`,
      correlationId,
      context: {
        args: redactedArgs,
        stderr: meaningfulStderr || null,
        via: this.brokerAgent.isConfigured() ? 'broker-agent' : 'local-process'
      }
    });

    if (result.exitCode !== 0 || meaningfulStderr) {
      throw createAppError({
        caller: 'dynsec::runDynsecCommand',
        reason: meaningfulStderr
          ? `mosquitto_ctrl dynsec ${command} failed: ${meaningfulStderr}`
          : `mosquitto_ctrl dynsec ${command} failed.`,
        errorKey: 'DYNSEC_OPERATION_FAILED',
        correlationId,
        context: result
      });
    }

    return result;
  }

  async readState({ correlationId }: { correlationId: string | null }): Promise<DynsecState> {
    if (this.brokerAgent.isConfigured()) {
      try {
        const raw = await this.brokerAgent.readDynsecStateRaw({ correlationId });
        if (!raw || typeof raw !== 'object') {
          throw new Error('Broker agent dynsec state response must be an object.');
        }
        return normalizeState({ raw: raw as Record<string, unknown> });
      } catch (error) {
        throw createAppError({
          caller: 'dynsec::readState',
          reason: 'Failed reading dynamic security state through broker agent.',
          errorKey: 'DYNSEC_STATE_READ_FAILED',
          correlationId,
          cause: error
        });
      }
    }

    try {
      const text = await readFile(this.runtimeConfig.config.broker.dynsecStateFilePath, 'utf8');
      return normalizeState({ raw: JSON.parse(text) as Record<string, unknown> });
    } catch (error) {
      throw createAppError({
        caller: 'dynsec::readState',
        reason: 'Failed reading dynamic security state file.',
        errorKey: 'DYNSEC_STATE_READ_FAILED',
        correlationId,
        context: { path: this.runtimeConfig.config.broker.dynsecStateFilePath },
        cause: error
      });
    }
  }

  async getClientDefaults(): Promise<DynsecClientDefaults> {
    const stored = await this.db.getSetting<unknown>({
      scope: dynsecClientDefaultsScope,
      key: dynsecClientDefaultsKey
    });

    return normalizeClientDefaults({ value: stored });
  }

  private roleExistsInState({
    rolename,
    state
  }: {
    rolename: string;
    state: DynsecState;
  }) {
    return state.roles.some((role) => role.rolename === rolename);
  }

  private groupExistsInState({
    groupname,
    state
  }: {
    groupname: string;
    state: DynsecState;
  }) {
    return state.groups.some((group) => group.groupname === groupname);
  }

  private async assertGroupNameAvailable({
    groupname,
    correlationId
  }: {
    groupname: string;
    correlationId: string | null;
  }) {
    const normalizedGroupname = normalizeEntityName({ value: groupname });
    const state = await this.readState({ correlationId });

    if (!this.groupExistsInState({ groupname: normalizedGroupname, state })) {
      return normalizedGroupname;
    }

    throw createAppError({
      caller: 'dynsec::assertGroupNameAvailable',
      reason: `Group ${normalizedGroupname} already exists.`,
      errorKey: 'INPUT_INVALID',
      correlationId,
      status: 409,
      context: { groupname: normalizedGroupname }
    });
  }

  private async assertRoleNameAvailable({
    rolename,
    correlationId
  }: {
    rolename: string;
    correlationId: string | null;
  }) {
    const normalizedRolename = normalizeEntityName({ value: rolename });
    const state = await this.readState({ correlationId });

    if (!this.roleExistsInState({ rolename: normalizedRolename, state })) {
      return normalizedRolename;
    }

    throw createAppError({
      caller: 'dynsec::assertRoleNameAvailable',
      reason: `Role ${normalizedRolename} already exists.`,
      errorKey: 'INPUT_INVALID',
      correlationId,
      status: 409,
      context: { rolename: normalizedRolename }
    });
  }

  private markBootstrapDefaultRoleProvisioned() {
    this.bootstrapDefaultRoleProvisionedAt = Date.now();
  }

  private clearBootstrapDefaultRoleProvisioned() {
    this.bootstrapDefaultRoleProvisionedAt = null;
  }

  private clearBootstrapDefaultRoleError() {
    this.bootstrapDefaultRoleError = null;
  }

  markBootstrapDefaultRolePending({ message }: { message: string }) {
    this.bootstrapDefaultRoleStatus = {
      status: 'running',
      lastRunAt: new Date().toISOString(),
      message
    };
  }

  clearBootstrapDefaultRolePending() {
    this.bootstrapDefaultRoleStatus = idleOperationStatus();
  }

  markBootstrapDefaultRoleFailed({ message }: { message: string }) {
    this.bootstrapDefaultRoleStatus = {
      status: 'failed',
      lastRunAt: new Date().toISOString(),
      message
    };
  }

  private setBootstrapDefaultRoleError(error: unknown) {
    if (error instanceof Error) {
      this.bootstrapDefaultRoleError = {
        reason: deriveBootstrapDefaultRoleErrorReason({ error }),
        errorKey: error instanceof AppError ? error.errorKey : null,
        details: error instanceof AppError ? error.context : null
      };
      return;
    }

    this.bootstrapDefaultRoleError = {
      reason: 'Unknown error',
      errorKey: null,
      details: error
    };
  }

  getBootstrapDefaultRoleError() {
    return this.bootstrapDefaultRoleError;
  }

  getBootstrapDefaultRoleStatus() {
    return this.bootstrapDefaultRoleStatus;
  }

  private bootstrapRoleAclExists({
    role,
    acl
  }: {
    role: DynsecRole;
    acl: Pick<DynsecAcl, 'acltype' | 'topic' | 'allow' | 'priority'>;
  }) {
    return role.acls.some((entry) => (
      entry.acltype === acl.acltype
      && entry.topic === acl.topic
      && entry.allow === acl.allow
      && entry.priority === acl.priority
    ));
  }

  private async ensureBootstrapRoleAcls({
    role,
    acls,
    correlationId
  }: {
    role: DynsecRole;
    acls: Array<Pick<DynsecAcl, 'acltype' | 'topic' | 'allow' | 'priority'>>;
    correlationId: string | null;
  }) {
    const missingAcls = acls.filter((acl) => !this.bootstrapRoleAclExists({ role, acl }));

    for (const acl of missingAcls) {
      await this.addRoleAcl({
        rolename: role.rolename,
        acltype: acl.acltype,
        topic: acl.topic,
        allow: acl.allow,
        priority: acl.priority,
        correlationId
      });
    }

    return missingAcls.length;
  }

  private async ensureBootstrapRole({
    roleName,
    acls,
    state,
    correlationId
  }: {
    roleName: string;
    acls: Array<Pick<DynsecAcl, 'acltype' | 'topic' | 'allow' | 'priority'>>;
    state: DynsecState;
    correlationId: string | null;
  }) {
    const existingRole = state.roles.find((role) => role.rolename === roleName);

    if (existingRole) {
      const addedAclCount = await this.ensureBootstrapRoleAcls({
        role: existingRole,
        acls,
        correlationId
      });

      return {
        roleName,
        created: false,
        addedAclCount
      };
    }

    await this.createRole({
      rolename: roleName,
      correlationId
    });

    for (const acl of acls) {
      await this.addRoleAcl({
        rolename: roleName,
        acltype: acl.acltype,
        topic: acl.topic,
        allow: acl.allow,
        priority: acl.priority,
        correlationId
      });
    }

    return {
      roleName,
      created: true,
      addedAclCount: acls.length
    };
  }

  private async migrateLegacyBootstrapRole({
    state,
    correlationId
  }: {
    state: DynsecState;
    correlationId: string | null;
  }) {
    const legacyRole = state.roles.find((role) => role.rolename === dynsecLegacyBootstrapRoleName);
    if (!legacyRole) return false;

    for (const client of state.clients) {
      const legacyRefs = client.roles.filter((reference) => reference.rolename === dynsecLegacyBootstrapRoleName);
      if (!legacyRefs.length) continue;

      const hasReadWriteRole = client.roles.some((reference) => reference.rolename === dynsecBootstrapReadWriteRoleName);

      if (!hasReadWriteRole) {
        await this.assignClientRole({
          username: client.username,
          rolename: dynsecBootstrapReadWriteRoleName,
          priority: legacyRefs[0]!.priority,
          correlationId
        });
      }

      for (const legacyRef of legacyRefs) {
        await this.removeClientRole({
          username: client.username,
          rolename: legacyRef.rolename,
          correlationId
        });
      }
    }

    for (const group of state.groups) {
      const legacyRefs = group.roles.filter((reference) => reference.rolename === dynsecLegacyBootstrapRoleName);
      if (!legacyRefs.length) continue;

      const hasReadWriteRole = group.roles.some((reference) => reference.rolename === dynsecBootstrapReadWriteRoleName);

      if (!hasReadWriteRole) {
        await this.addGroupRole({
          groupname: group.groupname,
          rolename: dynsecBootstrapReadWriteRoleName,
          priority: legacyRefs[0]!.priority,
          correlationId
        });
      }

      for (const legacyRef of legacyRefs) {
        await this.removeGroupRole({
          groupname: group.groupname,
          rolename: legacyRef.rolename,
          correlationId
        });
      }
    }

    await this.deleteRole({
      rolename: dynsecLegacyBootstrapRoleName,
      correlationId
    });

    return true;
  }

  private async ensureManagedBootstrapRoles({
    state,
    correlationId,
    setAsDefault
  }: {
    state: DynsecState;
    correlationId: string | null;
    setAsDefault: boolean;
  }) {
    const readAllResult = await this.ensureBootstrapRole({
      roleName: dynsecBootstrapDefaultRoleName,
      acls: dynsecBootstrapDefaultRoleAcls,
      state,
      correlationId
    });
    const readWriteAllResult = await this.ensureBootstrapRole({
      roleName: dynsecBootstrapReadWriteRoleName,
      acls: dynsecBootstrapReadWriteRoleAcls,
      state,
      correlationId
    });
    const migratedLegacyRole = await this.migrateLegacyBootstrapRole({
      state,
      correlationId
    });

    if (setAsDefault) {
      await this.setClientDefaults({
        value: {
          defaultRoleName: dynsecBootstrapDefaultRoleName,
          defaultRolePriority: dynsecBootstrapDefaultRolePriority
        }
      });
      this.markBootstrapDefaultRoleProvisioned();
    }

    const bootstrapped = readAllResult.created || readWriteAllResult.created || migratedLegacyRole;

    this.logger.info({
      caller: 'dynsec::ensureBootstrapDefaultRole',
      message: bootstrapped
        ? `Bootstrapped dynsec roles ${dynsecBootstrapDefaultRoleName} and ${dynsecBootstrapReadWriteRoleName}.`
        : `Verified dynsec roles ${dynsecBootstrapDefaultRoleName} and ${dynsecBootstrapReadWriteRoleName}.`,
      correlationId,
      context: {
        defaultRoleName: setAsDefault ? dynsecBootstrapDefaultRoleName : null,
        readAllCreated: readAllResult.created,
        readWriteAllCreated: readWriteAllResult.created,
        migratedLegacyRole
      }
    });

    return {
      bootstrapped,
      defaultRoleName: setAsDefault ? dynsecBootstrapDefaultRoleName : null
    };
  }

  isConfiguredDefaultRoleMissing({
    defaultRoleName,
    state
  }: {
    defaultRoleName: string | null;
    state: DynsecState;
  }) {
    if (!defaultRoleName) return false;
    if (this.roleExistsInState({ rolename: defaultRoleName, state })) {
      if (defaultRoleName === dynsecBootstrapDefaultRoleName) {
        this.clearBootstrapDefaultRoleProvisioned();
      }

      return false;
    }

    if (defaultRoleName !== dynsecBootstrapDefaultRoleName) return true;
    if (this.bootstrapDefaultRoleProvisionedAt === null) return true;

    const stateSyncPending = (Date.now() - this.bootstrapDefaultRoleProvisionedAt) < dynsecBootstrapDefaultRoleStateSyncGraceMs;

    if (stateSyncPending) return false;

    this.clearBootstrapDefaultRoleProvisioned();
    return true;
  }

  async setClientDefaults({ value }: { value: DynsecClientDefaults }) {
    const normalized = normalizeClientDefaults({ value });

    await this.db.setSetting({
      scope: dynsecClientDefaultsScope,
      key: dynsecClientDefaultsKey,
      value: normalized,
      updatedAt: new Date().toISOString()
    });

    return normalized;
  }

  private async hasInitializedBootstrapDefaultRole() {
    const stored = await this.db.getSetting<unknown>({
      scope: dynsecClientDefaultsScope,
      key: dynsecBootstrapDefaultRoleInitializedKey
    });

    return stored === true;
  }

  private async markBootstrapDefaultRoleInitialized() {
    await this.db.setSetting({
      scope: dynsecClientDefaultsScope,
      key: dynsecBootstrapDefaultRoleInitializedKey,
      value: true,
      updatedAt: new Date().toISOString()
    });
  }

  async ensureBootstrapDefaultRole({ correlationId }: { correlationId: string | null }) {
    this.clearBootstrapDefaultRoleError();
    try {
      const hasInitializedBootstrapDefaultRole = await this.hasInitializedBootstrapDefaultRole();
      const clientDefaults = await this.getClientDefaults();
      const state = await this.readState({ correlationId });
      const storesBootstrapDefaultRole = clientDefaults.defaultRoleName === dynsecBootstrapDefaultRoleName;
      const storesLegacyBootstrapDefaultRole = clientDefaults.defaultRoleName === dynsecLegacyBootstrapRoleName;
      const hasLegacyBootstrapRole = this.roleExistsInState({
        rolename: dynsecLegacyBootstrapRoleName,
        state
      });
      const hasCustomRoles = state.roles.some((role) => !dynsecBootstrapReservedRoles.has(role.rolename));

      // The built-in default role is a one-time startup bootstrap, not an ongoing repair loop.
      // The exception is the app-owned bootstrap roles themselves: startup can migrate the legacy
      // mqttctl-default role and repair the current read-all/read-write-all pair while the app-
      // managed default role is still selected.
      if (
        hasInitializedBootstrapDefaultRole
        && !storesBootstrapDefaultRole
        && !storesLegacyBootstrapDefaultRole
        && !hasLegacyBootstrapRole
      ) {
        return {
          bootstrapped: false,
          defaultRoleName: clientDefaults.defaultRoleName
        };
      }

      if (
        clientDefaults.defaultRoleName
        && !storesBootstrapDefaultRole
        && !storesLegacyBootstrapDefaultRole
        && !hasLegacyBootstrapRole
      ) {
        await this.markBootstrapDefaultRoleInitialized();
        return {
          bootstrapped: false,
          defaultRoleName: clientDefaults.defaultRoleName
        };
      }

      if (
        hasInitializedBootstrapDefaultRole
        && !clientDefaults.defaultRoleName
        && !hasLegacyBootstrapRole
      ) {
        return {
          bootstrapped: false,
          defaultRoleName: null
        };
      }

      if (storesLegacyBootstrapDefaultRole || hasLegacyBootstrapRole) {
        const migratedResult = await this.ensureManagedBootstrapRoles({
          state,
          correlationId,
          setAsDefault: storesLegacyBootstrapDefaultRole || (!clientDefaults.defaultRoleName && !hasCustomRoles)
        });
        await this.markBootstrapDefaultRoleInitialized();

        return {
          bootstrapped: migratedResult.bootstrapped,
          defaultRoleName: migratedResult.defaultRoleName ?? clientDefaults.defaultRoleName
        };
      }

      if (storesBootstrapDefaultRole) {
        const result = await this.ensureManagedBootstrapRoles({
          state,
          correlationId,
          setAsDefault: true
        });
        await this.markBootstrapDefaultRoleInitialized();
        return result;
      }

      if (hasCustomRoles) {
        await this.markBootstrapDefaultRoleInitialized();

        return {
          bootstrapped: false,
          defaultRoleName: clientDefaults.defaultRoleName
        };
      }

      const result = await this.ensureManagedBootstrapRoles({
        state,
        correlationId,
        setAsDefault: true
      });
      await this.markBootstrapDefaultRoleInitialized();

      return result;
    } catch (error) {
      this.setBootstrapDefaultRoleError(error);
      throw error;
    }
  }

  async getEffectivePermissions({
    username,
    correlationId
  }: {
    username: string;
    correlationId: string | null;
  }): Promise<EffectivePermissionView> {
    const state = await this.readState({ correlationId });
    const client = state.clients.find((entry) => entry.username === username);

    if (!client) {
      throw createAppError({
        caller: 'dynsec::getEffectivePermissions',
        reason: 'Client not found in dynsec state.',
        errorKey: 'DYNSEC_OPERATION_FAILED',
        correlationId,
        status: 404
      });
    }

    const roleLookup = new Map(state.roles.map((role) => [role.rolename, role]));
    const groupLookup = new Map(state.groups.map((group) => [group.groupname, group]));

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

    const mergedAcls = [
      ...directRoles.flatMap((role) => role.acls),
      ...inheritedGroups.flatMap((entry) => entry.roles.flatMap((role) => role.acls))
    ];

    const warnings = new Set<string>();

    if (mergedAcls.some((acl) => acl.allow && acl.acltype === 'publishClientSend' && acl.topic.includes('#'))) {
      warnings.add('Broad write access includes wildcard publish permission.');
    }

    const conflictEffects = new Map<string, Set<'allow' | 'deny'>>();
    for (const acl of mergedAcls) {
      const key = `${acl.acltype}:${acl.topic}`;
      const effect = acl.allow ? 'allow' : 'deny';
      const seenEffects = conflictEffects.get(key) ?? new Set<'allow' | 'deny'>();

      seenEffects.add(effect);
      conflictEffects.set(key, seenEffects);

      if (seenEffects.has('allow') && seenEffects.has('deny')) {
        warnings.add('Conflicting allow/deny ACL overlap detected. Equal-priority conflicts resolve to deny.');
      }
    }

    if (mergedAcls.some((acl) => acl.topic.includes('$SYS') || acl.topic.includes('$CONTROL') || acl.topic.toLowerCase().includes('secret'))) {
      warnings.add('Sensitive topic access detected.');
    }

    const effectiveAcls = resolveEffectiveAcls({ value: mergedAcls });

    return {
      client,
      directRoles,
      inheritedGroups,
      mergedAcls: effectiveAcls,
      warnings: [...warnings],
      raw: sanitizeDynsecCredentialFields({ value: state.raw })
    };
  }

  async createClient({
    username,
    password,
    clientId,
    disabled,
    correlationId
  }: {
    username: string;
    password: string | null;
    clientId: string | null;
    disabled: boolean;
    correlationId: string | null;
  }) {
    const clientDefaults = await this.getClientDefaults();

    if (clientDefaults.defaultRoleName) {
      const state = await this.readState({ correlationId });

      if (this.isConfiguredDefaultRoleMissing({
        defaultRoleName: clientDefaults.defaultRoleName,
        state
      })) {
        throw createAppError({
          caller: 'dynsec::createClient',
          reason: 'Configured default dynsec role no longer exists.',
          errorKey: 'DYNSEC_OPERATION_FAILED',
          correlationId,
          status: 409,
          context: {
            defaultRoleName: clientDefaults.defaultRoleName
          }
        });
      }
    }

    await this.runDynsecCommand({
      command: 'createClient',
      args: clientId ? [username, '-i', clientId] : [username],
      correlationId
    });

    if (password) {
      await this.runDynsecCommand({
        command: 'setClientPassword',
        args: [username, password],
        correlationId
      });
    }

    let defaultRoleApplied = false;

    if (clientDefaults.defaultRoleName) {
      try {
        await this.assignClientRole({
          username,
          rolename: clientDefaults.defaultRoleName,
          priority: clientDefaults.defaultRolePriority,
          correlationId
        });
        defaultRoleApplied = true;
      } catch (error) {
        if (clientDefaults.defaultRoleName === dynsecBootstrapDefaultRoleName) {
          this.clearBootstrapDefaultRoleProvisioned();
        }

        let rollbackDeleted = false;
        let rollbackError: unknown = null;

        try {
          await this.deleteClient({ username, correlationId });
          rollbackDeleted = true;
        } catch (caught) {
          rollbackError = caught;
        }

        throw createAppError({
          caller: 'dynsec::createClient',
          reason: rollbackDeleted
            ? 'Client creation was rolled back because assigning the configured default role failed.'
            : 'Assigning the configured default role failed after client creation, and rollback did not complete cleanly.',
          errorKey: 'DYNSEC_OPERATION_FAILED',
          correlationId,
          status: 409,
          context: {
            username,
            defaultRoleName: clientDefaults.defaultRoleName,
            defaultRolePriority: clientDefaults.defaultRolePriority,
            rollbackDeleted,
            rollbackError: rollbackError instanceof Error ? rollbackError.message : rollbackError
          },
          cause: error
        });
      }
    }

    if (disabled) {
      await this.runDynsecCommand({
        command: 'disableClient',
        args: [username],
        correlationId
      });
    }

    return {
      defaultRoleApplied,
      defaultRoleName: clientDefaults.defaultRoleName,
      defaultRolePriority: clientDefaults.defaultRolePriority
    };
  }

  async deleteClient({ username, correlationId }: { username: string; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: 'deleteClient',
      args: [username],
      correlationId
    });
  }

  async setClientPassword({ username, password, correlationId }: { username: string; password: string; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: 'setClientPassword',
      args: [username, password],
      correlationId
    });
  }

  async setClientEnabled({ username, enabled, correlationId }: { username: string; enabled: boolean; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: enabled ? 'enableClient' : 'disableClient',
      args: [username],
      correlationId
    });
  }

  async assignClientRole({
    username,
    rolename,
    priority,
    correlationId
  }: {
    username: string;
    rolename: string;
    priority: number;
    correlationId: string | null;
  }) {
    await this.runDynsecCommand({
      command: 'addClientRole',
      args: [username, rolename, String(priority)],
      correlationId
    });
  }

  async removeClientRole({ username, rolename, correlationId }: { username: string; rolename: string; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: 'removeClientRole',
      args: [username, rolename],
      correlationId
    });
  }

  async createGroup({ groupname, correlationId }: { groupname: string; correlationId: string | null }) {
    const normalizedGroupname = await this.assertGroupNameAvailable({ groupname, correlationId });

    await this.runDynsecCommand({
      command: 'createGroup',
      args: [normalizedGroupname],
      correlationId
    });
  }

  async deleteGroup({ groupname, correlationId }: { groupname: string; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: 'deleteGroup',
      args: [groupname],
      correlationId
    });
  }

  async addGroupClient({
    groupname,
    username,
    priority,
    correlationId
  }: {
    groupname: string;
    username: string;
    priority: number;
    correlationId: string | null;
  }) {
    await this.runDynsecCommand({
      command: 'addGroupClient',
      args: [groupname, username, String(priority)],
      correlationId
    });
  }

  async removeGroupClient({ groupname, username, correlationId }: { groupname: string; username: string; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: 'removeGroupClient',
      args: [groupname, username],
      correlationId
    });
  }

  async addGroupRole({
    groupname,
    rolename,
    priority,
    correlationId
  }: {
    groupname: string;
    rolename: string;
    priority: number;
    correlationId: string | null;
  }) {
    await this.runDynsecCommand({
      command: 'addGroupRole',
      args: [groupname, rolename, String(priority)],
      correlationId
    });
  }

  async removeGroupRole({ groupname, rolename, correlationId }: { groupname: string; rolename: string; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: 'removeGroupRole',
      args: [groupname, rolename],
      correlationId
    });
  }

  async createRole({ rolename, correlationId }: { rolename: string; correlationId: string | null }) {
    const normalizedRolename = await this.assertRoleNameAvailable({ rolename, correlationId });

    await this.runDynsecCommand({
      command: 'createRole',
      args: [normalizedRolename],
      correlationId
    });
  }

  async deleteRole({ rolename, correlationId }: { rolename: string; correlationId: string | null }) {
    await this.runDynsecCommand({
      command: 'deleteRole',
      args: [rolename],
      correlationId
    });

    if (rolename === dynsecBootstrapDefaultRoleName) {
      this.clearBootstrapDefaultRoleProvisioned();
    }
  }

  async addRoleAcl({
    rolename,
    acltype,
    topic,
    allow,
    priority,
    correlationId
  }: {
    rolename: string;
    acltype: DynsecAcl['acltype'];
    topic: string;
    allow: boolean;
    priority: number;
    correlationId: string | null;
  }) {
    await this.runDynsecCommand({
      command: 'addRoleACL',
      args: [rolename, acltype, topic, allow ? 'allow' : 'deny', String(priority)],
      correlationId
    });
  }

  async addRoleAcls({
    rolename,
    acltypes,
    topic,
    allow,
    priority,
    correlationId
  }: {
    rolename: string;
    acltypes: DynsecAcl['acltype'][];
    topic: string;
    allow: boolean;
    priority: number;
    correlationId: string | null;
  }) {
    const normalizedAclTypes = normalizeAclTypeSelection({ value: acltypes });

    for (const acltype of normalizedAclTypes) {
      await this.addRoleAcl({
        rolename,
        acltype,
        topic,
        allow,
        priority,
        correlationId
      });
    }

    return normalizedAclTypes;
  }

  async removeRoleAcl({
    rolename,
    acltype,
    topic,
    correlationId
  }: {
    rolename: string;
    acltype: DynsecAcl['acltype'];
    topic: string;
    correlationId: string | null;
  }) {
    await this.runDynsecCommand({
      command: 'removeRoleACL',
      args: [rolename, acltype, topic],
      correlationId
    });
  }

  async dynsecHealthCheck({ correlationId }: { correlationId: string | null }): Promise<CommandResult> {
    return await this.runDynsecCommand({
      command: 'listClients',
      correlationId
    });
  }
}
