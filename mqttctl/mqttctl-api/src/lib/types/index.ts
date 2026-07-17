export const userRoles = ['super_admin', 'broker_admin', 'security_admin', 'operator', 'viewer'] as const;
export type UserRole = (typeof userRoles)[number];
export type PrincipalRole = UserRole | 'mcp';

export const authMethods = ['local', 'oidc', 'header', 'mcp'] as const;
export type AuthMethod = (typeof authMethods)[number];
export const auditEntryLimitValues = ['10', '20', '50', '100', 'all'] as const;
export type AuditEntryLimitValue = (typeof auditEntryLimitValues)[number];

export const dynsecAclTypes = [
  'publishClientSend',
  'publishClientReceive',
  'subscribeLiteral',
  'subscribePattern',
  'unsubscribeLiteral',
  'unsubscribePattern'
] as const;
export const dynsecBootstrapDefaultRoleName = 'read-all';
export const dynsecBootstrapReadWriteRoleName = 'read-write-all';
export const dynsecLegacyBootstrapRoleName = 'mqttctl-default';
export type DynsecAclType = (typeof dynsecAclTypes)[number];

export type DynsecPermissionEffect = 'allow' | 'deny';
export type SnapshotKind = 'dynsec' | 'broker-config' | 'combined';
export const mqttQosLevels = [0, 1, 2] as const;
export type MqttQos = (typeof mqttQosLevels)[number];
export type MqttAuthMode = 'configured_admin' | 'dynsec_client' | 'custom';
export type MqttConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export const managedBrokerKeyFileIds = ['caFile', 'mosquittoPublicKey', 'brokerPublicKey'] as const;
export type ManagedBrokerKeyFileId = (typeof managedBrokerKeyFileIds)[number];

export interface AppUser {
  id: string;
  username: string;
  email: string | null;
  role: PrincipalRole;
  authSource: AuthMethod;
  externalSubject: string | null;
  protectedFromAutoLink: boolean;
  disabled: boolean;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  authMethod: AuthMethod;
  expiresAt: string;
  sessionVersion: number;
  sourceIp: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string | null;
  role: PrincipalRole;
  authSource: AuthMethod;
  capabilities?: string[];
  delegatedIdentity?: {
    clientName: string;
    access: 'read' | 'readwrite';
  } | null;
}

export interface DynsecRoleRef {
  rolename: string;
  priority: number;
}

export interface DynsecGroupRef {
  groupname: string;
  priority: number;
}

export interface DynsecClientRef {
  username: string;
  priority: number;
}

export interface DynsecAcl {
  acltype: DynsecAclType;
  topic: string;
  priority: number;
  allow: boolean;
  name?: string | null;
  description?: string | null;
}

export interface DynsecClient {
  username: string;
  clientid: string | null;
  textname: string | null;
  textdescription: string | null;
  disabled: boolean;
  roles: DynsecRoleRef[];
  groups: DynsecGroupRef[];
}

export interface DynsecGroup {
  groupname: string;
  textname: string | null;
  textdescription: string | null;
  roles: DynsecRoleRef[];
  clients: DynsecClientRef[];
}

export interface DynsecRole {
  rolename: string;
  textname: string | null;
  textdescription: string | null;
  acls: DynsecAcl[];
}

export interface DynsecState {
  clients: DynsecClient[];
  groups: DynsecGroup[];
  roles: DynsecRole[];
  anonymousGroup: string | null;
  defaultAcls: Record<string, string | null>;
  raw: unknown;
  loadedAt: string;
}

export interface DynsecClientDefaults {
  defaultRoleName: string | null;
  defaultRolePriority: number;
}

export interface EffectivePermissionView {
  client: DynsecClient;
  directRoles: DynsecRole[];
  inheritedGroups: Array<{
    group: DynsecGroup;
    roles: DynsecRole[];
  }>;
  mergedAcls: DynsecAcl[];
  warnings: string[];
  raw: unknown;
}

export interface AuditEntry {
  id: string;
  sequenceNumber: number;
  timestamp: string;
  actorUsername: string | null;
  actorUserId: string | null;
  authMode: AuthMethod | null;
  sourceIp: string | null;
  correlationId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  beforeSummary: unknown;
  afterSummary: unknown;
  commandResult: unknown;
  previousEntryHash: string | null;
  entryHash: string;
  success: boolean;
}

export interface AuditIntegrityStatus {
  verified: boolean;
  algorithm: 'sha256';
  hashInput: 'sha256(JSON.stringify(entry))';
  totalEntriesVerified: number;
  latestHash: string | null;
}

export interface AuditEntriesPage {
  limitValue: AuditEntryLimitValue;
  totalEntries: number;
  hasMore: boolean;
  filters: {
    indexes: [number, number];
  };
  entries: AuditEntry[];
}

export interface ControlPlaneExportEnvelope<TType extends string> {
  title: 'MQTTCTL';
  type: TType;
  exportTime: string;
  build: string;
}

export interface AuditLogExport extends ControlPlaneExportEnvelope<'audit log'> {
  filters: {
    indexes: [number, number];
    limit: AuditEntryLimitValue;
    totalEntries: number;
    returnedEntries: number;
  };
  integrity: AuditIntegrityStatus;
  data: AuditExportEntry[];
}

export interface AuditExportEntry {
  time: string;
  author: string;
  authorUserId: string | null;
  auth: string;
  ip: string;
  action: string;
  targetType: string;
  targetId: string | null;
  target: string;
  result: 'success' | 'failed';
  correlation: string;
  before: unknown;
  after: unknown;
  commandResult: unknown;
  previousHash: string | null;
}

export interface SnapshotRecord {
  id: string;
  kind: SnapshotKind;
  createdAt: string;
  actorUsername: string | null;
  note: string | null;
}

export interface SnapshotExport extends ControlPlaneExportEnvelope<'snapshot'> {
  snapshot: {
    id: string;
    kind: SnapshotKind;
    note: string | null;
  };
  data: Record<string, unknown>;
}

export interface OperationStatus {
  status: 'idle' | 'running' | 'success' | 'failed';
  lastRunAt: string | null;
  message: string | null;
}

export interface DiagnosticsSummary {
  brokerReachable: boolean;
  dynsecStateReadable: boolean;
  dynsecBootstrap: OperationStatus;
  brokerConfigReadable: boolean;
  lastReload: OperationStatus;
  lastRestart: OperationStatus;
}

export interface ManagedBrokerKeyFileStatus {
  fileId: ManagedBrokerKeyFileId;
  path: string | null;
  fileName: string | null;
  configured: boolean;
  exists: boolean;
}

export interface ManagedBrokerKeyFileDownload {
  fileId: ManagedBrokerKeyFileId;
  path: string;
  fileName: string;
  content: string;
}

export interface BrokerAgentRuntimeInfo {
  brokerAgentVersion: string | null;
  brokerAgentBuildHash: string | null;
  mqttServerVersion: string | null;
}

export interface MqttConnectionDefaults {
  host: string;
  port: number;
  tls: boolean;
  authMode: MqttAuthMode;
  configuredUsername: string;
  configuredClientId: string;
}

export interface MqttConnectionStatus {
  state: MqttConnectionState;
  connected: boolean;
  host: string | null;
  port: number | null;
  tls: boolean;
  authMode: MqttAuthMode | null;
  username: string | null;
  clientId: string | null;
  message: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
}

export interface MqttSubscription {
  filter: string;
  qos: MqttQos;
  subscribedAt: string;
  matchedMessageCount: number;
}

export interface MqttLatestMessage {
  topic: string;
  payload: string;
  payloadFormat: 'text' | 'json' | 'base64';
  qos: MqttQos;
  retain: boolean;
  receivedAt: string;
  byteLength: number;
  preview: string;
}

export interface MqttSessionStats {
  totalMessages: number;
  trackedTopics: number;
  trackedTopicsLimit: number | null;
}

export interface MqttExplorerState {
  revision: number;
  defaults: MqttConnectionDefaults;
  connection: MqttConnectionStatus;
  subscriptions: MqttSubscription[];
  messages: MqttLatestMessage[];
  stats: MqttSessionStats;
}

export interface ApiErrorBody {
  ok: false;
  errorKey: string;
  errorCode: string;
  reason: string;
  correlationId: string | null;
  details?: unknown;
}

export interface McpDelegatedIdentity {
  clientName: string;
  access: 'read' | 'readwrite';
}

export interface McpRuntimeInfo {
  enabled: boolean;
  connected: boolean;
  reason: string;
  version: string | null;
  buildHash: string | null;
  instanceId: string | null;
  startedAt: string | null;
  lastSeenAt: string | null;
  heartbeatExpiresAt: string | null;
}

export interface McpAccessState {
  id: 'system:mcp';
  username: 'mcp';
  role: 'mcp';
  authSource: 'mcp';
  disabled: boolean;
  defaultCapabilities: string[];
  allowedCapabilities: string[];
  signingKey: {
    keyId: string;
    fingerprint: string | null;
  };
  runtime: McpRuntimeInfo;
}
