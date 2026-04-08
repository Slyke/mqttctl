import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import type { AppUser, AuditEntry, SessionRecord, SnapshotKind, SnapshotRecord } from '$lib/types';
import { createAppError } from '$server/logging/errors';
import { parseJsonSafe, stringifyJson } from '$server/utils/json';

type DatabaseKind = 'sqlite' | 'postgres';

interface DbStatement {
  text: string;
  params?: Array<string | number | null>;
}

export interface StoredUser extends AppUser {
  passwordHash: string | null;
}

export interface AuthRequestRecord {
  state: string;
  codeVerifier: string;
  redirectTo: string | null;
  createdAt: string;
}

interface RuntimeDbConfig {
  kind: DatabaseKind;
  sqlitePath: string;
  postgres?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
  };
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  sequence_number: number | string | null;
  timestamp: string;
  actor_username: string | null;
  actor_user_id: string | null;
  auth_mode: string | null;
  source_ip: string | null;
  correlation_id: string;
  action_name: string;
  target_type: string;
  target_id: string | null;
  before_summary: string | null;
  after_summary: string | null;
  command_result: string | null;
  previous_entry_hash: string | null;
  entry_hash: string | null;
  success: number | string;
}

const toPostgresText = ({ text }: { text: string }) => {
  let index = 0;
  return text.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
};

const migrationStatements = [
  `CREATE TABLE IF NOT EXISTS app_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    role TEXT NOT NULL,
    auth_source TEXT NOT NULL,
    external_subject TEXT,
    password_hash TEXT,
    protected_from_auto_link INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    auth_method TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    session_version INTEGER NOT NULL,
    source_ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_requests (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    redirect_to TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    actor_username TEXT,
    actor_user_id TEXT,
    auth_mode TEXT,
    source_ip TEXT,
    correlation_id TEXT NOT NULL,
    action_name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    before_summary TEXT,
    after_summary TEXT,
    command_result TEXT,
    success INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    scope TEXT NOT NULL,
    key_name TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(scope, key_name)
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    actor_username TEXT,
    note TEXT,
    payload_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at)`
];

const toAuditSequenceNumber = ({ value, fallback }: { value: unknown; fallback: number }) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const parseAuditSummaryJson = ({ value }: { value: string | null }) => parseJsonSafe({ value, fallback: null as unknown });

const buildAuditHashPayload = ({
  timestamp,
  actorUsername,
  actorUserId,
  authMode,
  sourceIp,
  action,
  targetType,
  targetId,
  correlationId,
  beforeSummaryJson,
  afterSummaryJson,
  commandResultJson,
  success,
  previousEntryHash
}: {
  timestamp: string;
  actorUsername: string | null;
  actorUserId: string | null;
  authMode: string | null;
  sourceIp: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  correlationId: string;
  beforeSummaryJson: string | null;
  afterSummaryJson: string | null;
  commandResultJson: string | null;
  success: boolean;
  previousEntryHash: string | null;
}) => ({
  time: timestamp,
  author: actorUsername ?? 'System',
  authorUserId: actorUserId,
  auth: authMode ?? 'N/A',
  ip: sourceIp ?? 'N/A',
  action,
  targetType,
  targetId,
  target: targetId ? `${targetType}: ${targetId}` : targetType,
  result: success ? 'success' : 'failed',
  correlation: correlationId,
  before: parseAuditSummaryJson({ value: beforeSummaryJson }),
  after: parseAuditSummaryJson({ value: afterSummaryJson }),
  commandResult: parseAuditSummaryJson({ value: commandResultJson }),
  previousHash: previousEntryHash
});

const computeAuditEntryHash = ({
  timestamp,
  actorUsername,
  actorUserId,
  authMode,
  sourceIp,
  action,
  targetType,
  targetId,
  correlationId,
  beforeSummaryJson,
  afterSummaryJson,
  commandResultJson,
  success,
  previousEntryHash
}: {
  timestamp: string;
  actorUsername: string | null;
  actorUserId: string | null;
  authMode: string | null;
  sourceIp: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  correlationId: string;
  beforeSummaryJson: string | null;
  afterSummaryJson: string | null;
  commandResultJson: string | null;
  success: boolean;
  previousEntryHash: string | null;
}) => createHash('sha256').update(JSON.stringify(buildAuditHashPayload({
  timestamp,
  actorUsername,
  actorUserId,
  authMode,
  sourceIp,
  action,
  targetType,
  targetId,
  correlationId,
  beforeSummaryJson,
  afterSummaryJson,
  commandResultJson,
  success,
  previousEntryHash
}))).digest('hex');

const mapAuditEntryRow = (row: AuditRow): AuditEntry => ({
  id: String(row.id),
  sequenceNumber: toAuditSequenceNumber({ value: row.sequence_number, fallback: -1 }),
  timestamp: String(row.timestamp),
  actorUsername: (row.actor_username as string | null) ?? null,
  actorUserId: (row.actor_user_id as string | null) ?? null,
  authMode: (row.auth_mode as AuditEntry['authMode']) ?? null,
  sourceIp: (row.source_ip as string | null) ?? null,
  correlationId: String(row.correlation_id),
  action: String(row.action_name),
  targetType: String(row.target_type),
  targetId: (row.target_id as string | null) ?? null,
  beforeSummary: parseJsonSafe({ value: row.before_summary as string | null, fallback: null }),
  afterSummary: parseJsonSafe({ value: row.after_summary as string | null, fallback: null }),
  commandResult: parseJsonSafe({ value: row.command_result as string | null, fallback: null }),
  previousEntryHash: (row.previous_entry_hash as string | null) ?? null,
  entryHash: String(row.entry_hash ?? ''),
  success: Number(row.success) === 1
});

export class AppDatabase {
  private kind: DatabaseKind;
  private sqlite: Database.Database | null = null;
  private pg: Pool | null = null;

  constructor({ config }: { config: RuntimeDbConfig }) {
    this.kind = config.kind;

    if (config.kind === 'sqlite') {
      const sqlitePath = path.resolve(config.sqlitePath);
      mkdirSync(path.dirname(sqlitePath), { recursive: true });
      const sqlite = new Database(sqlitePath);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      sqlite.pragma('busy_timeout = 5000');
      sqlite.pragma('synchronous = NORMAL');
      this.sqlite = sqlite;
      return;
    }

    if (!config.postgres) {
      throw new Error('Postgres configuration is required when MQTTCTL_DB_KIND=postgres.');
    }

    this.pg = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false
    });
  }

  async initialize({ correlationId }: { correlationId: string | null }) {
    try {
      for (const statement of migrationStatements) {
        await this.execute({ text: statement });
      }

      await this.ensureAuditLogColumns();
      await this.ensureAppUserColumns();
      await this.backfillAuditLogChain();
    } catch (error) {
      throw createAppError({
        caller: 'db::initialize',
        reason: 'Failed bootstrapping the application database.',
        errorKey: 'DB_BOOTSTRAP_FAILED',
        correlationId,
        cause: error
      });
    }
  }

  async close() {
    this.sqlite?.close();
    await this.pg?.end();
  }

  async execute({ text, params = [] }: DbStatement) {
    try {
      if (this.sqlite) {
        this.sqlite.prepare(text).run(...params);
        return;
      }

      await this.pg?.query(toPostgresText({ text }), params);
    } catch (error) {
      throw createAppError({
        caller: 'db::execute',
        reason: 'Database execute failed.',
        errorKey: 'DB_QUERY_FAILED',
        context: { text, params },
        cause: error
      });
    }
  }

  async queryRows<T extends Record<string, unknown>>({ text, params = [] }: DbStatement): Promise<T[]> {
    try {
      if (this.sqlite) {
        return this.sqlite.prepare(text).all(...params) as T[];
      }

      const result = await this.pg?.query<T>(toPostgresText({ text }), params);
      return result?.rows ?? [];
    } catch (error) {
      throw createAppError({
        caller: 'db::queryRows',
        reason: 'Database select failed.',
        errorKey: 'DB_QUERY_FAILED',
        context: { text, params },
        cause: error
      });
    }
  }

  async queryFirst<T extends Record<string, unknown>>({ text, params = [] }: DbStatement): Promise<T | null> {
    const rows = await this.queryRows<T>({ text, params });
    return rows[0] ?? null;
  }

  private async hasColumn({
    tableName,
    columnName
  }: {
    tableName: string;
    columnName: string;
  }) {
    if (this.sqlite) {
      const rows = await this.queryRows<{ name?: string }>({
        text: `PRAGMA table_info(${tableName})`
      });
      return rows.some((row) => row.name === columnName);
    }

    const rows = await this.queryRows<{ column_name?: string }>({
      text: `SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ?
          AND column_name = ?`,
      params: [tableName, columnName]
    });
    return rows.length > 0;
  }

  private async ensureAppUserColumns() {
    if (!(await this.hasColumn({ tableName: 'app_users', columnName: 'protected_from_auto_link' }))) {
      await this.execute({
        text: 'ALTER TABLE app_users ADD COLUMN protected_from_auto_link INTEGER NOT NULL DEFAULT 0'
      });
    }
  }

  private async ensureAuditLogColumns() {
    if (!(await this.hasColumn({ tableName: 'audit_log', columnName: 'sequence_number' }))) {
      await this.execute({
        text: 'ALTER TABLE audit_log ADD COLUMN sequence_number BIGINT'
      });
    }

    if (!(await this.hasColumn({ tableName: 'audit_log', columnName: 'previous_entry_hash' }))) {
      await this.execute({
        text: 'ALTER TABLE audit_log ADD COLUMN previous_entry_hash TEXT'
      });
    }

    if (!(await this.hasColumn({ tableName: 'audit_log', columnName: 'entry_hash' }))) {
      await this.execute({
        text: 'ALTER TABLE audit_log ADD COLUMN entry_hash TEXT'
      });
    }

    await this.execute({
      text: 'CREATE INDEX IF NOT EXISTS idx_audit_sequence_number ON audit_log(sequence_number)'
    });
  }

  private async backfillAuditLogChain() {
    const rows = await this.queryRows<AuditRow>({
      text: `SELECT id, sequence_number, timestamp, actor_username, actor_user_id, auth_mode, source_ip, correlation_id, action_name, target_type, target_id, before_summary, after_summary, command_result, previous_entry_hash, entry_hash, success
        FROM audit_log
        ORDER BY timestamp ASC, id ASC`
    });

    let previousEntryHash: string | null = null;

    for (const [index, row] of rows.entries()) {
      const entryHash = computeAuditEntryHash({
        timestamp: String(row.timestamp),
        actorUsername: (row.actor_username as string | null) ?? null,
        actorUserId: (row.actor_user_id as string | null) ?? null,
        authMode: (row.auth_mode as string | null) ?? null,
        sourceIp: (row.source_ip as string | null) ?? null,
        correlationId: String(row.correlation_id),
        action: String(row.action_name),
        targetType: String(row.target_type),
        targetId: (row.target_id as string | null) ?? null,
        beforeSummaryJson: (row.before_summary as string | null) ?? null,
        afterSummaryJson: (row.after_summary as string | null) ?? null,
        commandResultJson: (row.command_result as string | null) ?? null,
        success: Number(row.success) === 1,
        previousEntryHash
      });

      const currentSequenceNumber = toAuditSequenceNumber({ value: row.sequence_number, fallback: -1 });
      const currentPreviousEntryHash = (row.previous_entry_hash as string | null) ?? null;
      const currentEntryHash = (row.entry_hash as string | null) ?? null;

      if (
        currentSequenceNumber !== index
        || currentPreviousEntryHash !== previousEntryHash
        || currentEntryHash !== entryHash
      ) {
        await this.execute({
          text: `UPDATE audit_log
            SET sequence_number = ?, previous_entry_hash = ?, entry_hash = ?
            WHERE id = ?`,
          params: [index, previousEntryHash, entryHash, String(row.id)]
        });
      }

      previousEntryHash = entryHash;
    }
  }

  async countUsers() {
    const row = await this.queryFirst<{ count: number | string }>({ text: 'SELECT COUNT(*) AS count FROM app_users' });
    return Number(row?.count ?? 0);
  }

  async listUsers(): Promise<StoredUser[]> {
    const rows = await this.queryRows<Record<string, unknown>>({
      text: 'SELECT id, username, email, role, auth_source, external_subject, password_hash, protected_from_auto_link, disabled, session_version, created_at, updated_at FROM app_users ORDER BY username ASC'
    });
    return rows.map(mapStoredUserRow);
  }

  async getUserById({ userId }: { userId: string }) {
    const row = await this.queryFirst<Record<string, unknown>>({
      text: 'SELECT id, username, email, role, auth_source, external_subject, password_hash, protected_from_auto_link, disabled, session_version, created_at, updated_at FROM app_users WHERE id = ?',
      params: [userId]
    });
    return row ? mapStoredUserRow(row) : null;
  }

  async getUserByUsername({ username }: { username: string }) {
    const row = await this.queryFirst<Record<string, unknown>>({
      text: 'SELECT id, username, email, role, auth_source, external_subject, password_hash, protected_from_auto_link, disabled, session_version, created_at, updated_at FROM app_users WHERE username = ?',
      params: [username]
    });
    return row ? mapStoredUserRow(row) : null;
  }

  async getUserByExternalSubject({ subject }: { subject: string }) {
    const row = await this.queryFirst<Record<string, unknown>>({
      text: 'SELECT id, username, email, role, auth_source, external_subject, password_hash, protected_from_auto_link, disabled, session_version, created_at, updated_at FROM app_users WHERE external_subject = ?',
      params: [subject]
    });
    return row ? mapStoredUserRow(row) : null;
  }

  async createUser({
    id,
    username,
    email,
    role,
    authSource,
    externalSubject,
    passwordHash,
    protectedFromAutoLink,
    disabled,
    sessionVersion,
    createdAt,
    updatedAt
  }: {
    id: string;
    username: string;
    email: string | null;
    role: string;
    authSource: string;
    externalSubject: string | null;
    passwordHash: string | null;
    protectedFromAutoLink: boolean;
    disabled: boolean;
    sessionVersion: number;
    createdAt: string;
    updatedAt: string;
  }) {
    await this.execute({
      text: `INSERT INTO app_users (
        id, username, email, role, auth_source, external_subject, password_hash, protected_from_auto_link, disabled, session_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, username, email, role, authSource, externalSubject, passwordHash, protectedFromAutoLink ? 1 : 0, disabled ? 1 : 0, sessionVersion, createdAt, updatedAt]
    });
  }

  async updateUser({
    userId,
    email,
    role,
    authSource,
    externalSubject,
    passwordHash,
    disabled,
    sessionVersion,
    updatedAt
  }: {
    userId: string;
    email: string | null;
    role: string;
    authSource: string;
    externalSubject: string | null;
    passwordHash: string | null;
    disabled: boolean;
    sessionVersion: number;
    updatedAt: string;
  }) {
    await this.execute({
      text: `UPDATE app_users
        SET email = ?, role = ?, auth_source = ?, external_subject = ?, password_hash = ?, disabled = ?, session_version = ?, updated_at = ?
        WHERE id = ?`,
      params: [email, role, authSource, externalSubject, passwordHash, disabled ? 1 : 0, sessionVersion, updatedAt, userId]
    });
  }

  async deleteUser({ userId }: { userId: string }) {
    await this.execute({
      text: 'DELETE FROM app_users WHERE id = ?',
      params: [userId]
    });
  }

  async setUserProtectedFromAutoLink({
    userId,
    protectedFromAutoLink,
    updatedAt
  }: {
    userId: string;
    protectedFromAutoLink: boolean;
    updatedAt: string;
  }) {
    await this.execute({
      text: `UPDATE app_users
        SET protected_from_auto_link = ?, updated_at = ?
        WHERE id = ?`,
      params: [protectedFromAutoLink ? 1 : 0, updatedAt, userId]
    });
  }

  async createSession({
    id,
    userId,
    authMethod,
    expiresAt,
    sessionVersion,
    sourceIp,
    userAgent,
    createdAt,
    updatedAt
  }: {
    id: string;
    userId: string;
    authMethod: string;
    expiresAt: string;
    sessionVersion: number;
    sourceIp: string | null;
    userAgent: string | null;
    createdAt: string;
    updatedAt: string;
  }) {
    await this.execute({
      text: `INSERT INTO sessions (
        id, user_id, auth_method, expires_at, session_version, source_ip, user_agent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, userId, authMethod, expiresAt, sessionVersion, sourceIp, userAgent, createdAt, updatedAt]
    });
  }

  async getSession({ sessionId }: { sessionId: string }): Promise<SessionRecord | null> {
    const row = await this.queryFirst<Record<string, unknown>>({
      text: 'SELECT id, user_id, auth_method, expires_at, session_version, source_ip, user_agent, created_at, updated_at FROM sessions WHERE id = ?',
      params: [sessionId]
    });

    if (!row) return null;

    return {
      id: String(row.id),
      userId: String(row.user_id),
      authMethod: row.auth_method as SessionRecord['authMethod'],
      expiresAt: String(row.expires_at),
      sessionVersion: Number(row.session_version),
      sourceIp: (row.source_ip as string | null) ?? null,
      userAgent: (row.user_agent as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  async deleteSession({ sessionId }: { sessionId: string }) {
    await this.execute({
      text: 'DELETE FROM sessions WHERE id = ?',
      params: [sessionId]
    });
  }

  async deleteSessionsForUser({ userId }: { userId: string }) {
    await this.execute({
      text: 'DELETE FROM sessions WHERE user_id = ?',
      params: [userId]
    });
  }

  async purgeExpiredSessions({ now }: { now: string }) {
    await this.execute({
      text: 'DELETE FROM sessions WHERE expires_at < ?',
      params: [now]
    });
  }

  async upsertAuthRequest({ state, codeVerifier, redirectTo, createdAt }: AuthRequestRecord) {
    await this.execute({
      text: `INSERT INTO auth_requests (state, code_verifier, redirect_to, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(state) DO UPDATE SET code_verifier = excluded.code_verifier, redirect_to = excluded.redirect_to, created_at = excluded.created_at`,
      params: [state, codeVerifier, redirectTo, createdAt]
    });
  }

  async getAuthRequest({ state }: { state: string }): Promise<AuthRequestRecord | null> {
    const row = await this.queryFirst<Record<string, unknown>>({
      text: 'SELECT state, code_verifier, redirect_to, created_at FROM auth_requests WHERE state = ?',
      params: [state]
    });

    if (!row) return null;

    return {
      state: String(row.state),
      codeVerifier: String(row.code_verifier),
      redirectTo: (row.redirect_to as string | null) ?? null,
      createdAt: String(row.created_at)
    };
  }

  async deleteAuthRequest({ state }: { state: string }) {
    await this.execute({
      text: 'DELETE FROM auth_requests WHERE state = ?',
      params: [state]
    });
  }

  async purgeOldAuthRequests({ olderThan }: { olderThan: string }) {
    await this.execute({
      text: 'DELETE FROM auth_requests WHERE created_at < ?',
      params: [olderThan]
    });
  }

  async appendAudit({
    id,
    timestamp,
    actorUsername,
    actorUserId,
    authMode,
    sourceIp,
    correlationId,
    action,
    targetType,
    targetId,
    beforeSummary,
    afterSummary,
    commandResult,
    success
  }: {
    id: string;
    timestamp: string;
    actorUsername: string | null;
    actorUserId: string | null;
    authMode: string | null;
    sourceIp: string | null;
    correlationId: string;
    action: string;
    targetType: string;
    targetId: string | null;
    beforeSummary: unknown;
    afterSummary: unknown;
    commandResult: unknown;
    success: boolean;
  }) {
    const beforeSummaryJson = stringifyJson({ value: beforeSummary });
    const afterSummaryJson = stringifyJson({ value: afterSummary });
    const commandResultJson = stringifyJson({ value: commandResult });
    const latestEntry = await this.queryFirst<AuditRow>({
      text: `SELECT sequence_number, entry_hash
        FROM audit_log
        ORDER BY sequence_number DESC, timestamp DESC, id DESC
        LIMIT 1`
    });
    const sequenceNumber = toAuditSequenceNumber({ value: latestEntry?.sequence_number, fallback: -1 }) + 1;
    const previousEntryHash = (latestEntry?.entry_hash as string | null) ?? null;
    const entryHash = computeAuditEntryHash({
      timestamp,
      actorUsername,
      actorUserId,
      authMode,
      sourceIp,
      correlationId,
      action,
      targetType,
      targetId,
      beforeSummaryJson,
      afterSummaryJson,
      commandResultJson,
      success,
      previousEntryHash
    });

    await this.execute({
      text: `INSERT INTO audit_log (
        id, sequence_number, timestamp, actor_username, actor_user_id, auth_mode, source_ip, correlation_id, action_name, target_type, target_id, before_summary, after_summary, command_result, previous_entry_hash, entry_hash, success
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        sequenceNumber,
        timestamp,
        actorUsername,
        actorUserId,
        authMode,
        sourceIp,
        correlationId,
        action,
        targetType,
        targetId,
        beforeSummaryJson,
        afterSummaryJson,
        commandResultJson,
        previousEntryHash,
        entryHash,
        success ? 1 : 0
      ]
    });
  }

  async listAuditEntries({ limit = 100 }: { limit?: number | null } = {}): Promise<AuditEntry[]> {
    const rows = await this.queryRows<AuditRow>({
      text: `SELECT id, sequence_number, timestamp, actor_username, actor_user_id, auth_mode, source_ip, correlation_id, action_name, target_type, target_id, before_summary, after_summary, command_result, previous_entry_hash, entry_hash, success
        FROM audit_log
        ORDER BY sequence_number DESC, timestamp DESC, id DESC${limit === null ? '' : ' LIMIT ?'}`,
      ...(limit === null ? {} : { params: [limit] })
    });

    return rows.map(mapAuditEntryRow);
  }

  async countAuditEntries() {
    const row = await this.queryFirst<{ count: number | string }>({ text: 'SELECT COUNT(*) AS count FROM audit_log' });
    return Number(row?.count ?? 0);
  }

  async verifyAuditIntegrity() {
    const rows = await this.queryRows<AuditRow>({
      text: `SELECT id, sequence_number, timestamp, actor_username, actor_user_id, auth_mode, source_ip, correlation_id, action_name, target_type, target_id, before_summary, after_summary, command_result, previous_entry_hash, entry_hash, success
        FROM audit_log
        ORDER BY sequence_number ASC, timestamp ASC, id ASC`
    });

    let previousEntryHash: string | null = null;

    for (const [index, row] of rows.entries()) {
      const expectedHash = computeAuditEntryHash({
        timestamp: String(row.timestamp),
        actorUsername: (row.actor_username as string | null) ?? null,
        actorUserId: (row.actor_user_id as string | null) ?? null,
        authMode: (row.auth_mode as string | null) ?? null,
        sourceIp: (row.source_ip as string | null) ?? null,
        correlationId: String(row.correlation_id),
        action: String(row.action_name),
        targetType: String(row.target_type),
        targetId: (row.target_id as string | null) ?? null,
        beforeSummaryJson: (row.before_summary as string | null) ?? null,
        afterSummaryJson: (row.after_summary as string | null) ?? null,
        commandResultJson: (row.command_result as string | null) ?? null,
        success: Number(row.success) === 1,
        previousEntryHash
      });

      if (
        toAuditSequenceNumber({ value: row.sequence_number, fallback: -1 }) !== index
        || ((row.previous_entry_hash as string | null) ?? null) !== previousEntryHash
        || ((row.entry_hash as string | null) ?? null) !== expectedHash
      ) {
        return {
          verified: false as const,
          algorithm: 'sha256' as const,
          hashInput: 'sha256(JSON.stringify(entry))' as const,
          totalEntriesVerified: index,
          latestHash: previousEntryHash
        };
      }

      previousEntryHash = expectedHash;
    }

    return {
      verified: true as const,
      algorithm: 'sha256' as const,
      hashInput: 'sha256(JSON.stringify(entry))' as const,
      totalEntriesVerified: rows.length,
      latestHash: previousEntryHash
    };
  }

  async getSetting<T>({ scope, key }: { scope: string; key: string }): Promise<T | null> {
    const row = await this.queryFirst<Record<string, unknown>>({
      text: 'SELECT value_json FROM settings WHERE scope = ? AND key_name = ?',
      params: [scope, key]
    });
    if (!row) return null;
    return parseJsonSafe<T>({ value: row.value_json as string | null, fallback: null as T });
  }

  async setSetting({ scope, key, value, updatedAt }: { scope: string; key: string; value: unknown; updatedAt: string }) {
    await this.execute({
      text: `INSERT INTO settings (scope, key_name, value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope, key_name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      params: [scope, key, stringifyJson({ value }), updatedAt]
    });
  }

  async createSnapshot({
    id,
    kind,
    createdAt,
    actorUsername,
    note,
    payload
  }: {
    id: string;
    kind: SnapshotKind;
    createdAt: string;
    actorUsername: string | null;
    note: string | null;
    payload: unknown;
  }) {
    await this.execute({
      text: 'INSERT INTO snapshots (id, kind, created_at, actor_username, note, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
      params: [id, kind, createdAt, actorUsername, note, stringifyJson({ value: payload })]
    });
  }

  async listSnapshots({ limit = 50 }: { limit?: number } = {}): Promise<SnapshotRecord[]> {
    const rows = await this.queryRows<Record<string, unknown>>({
      text: 'SELECT id, kind, created_at, actor_username, note FROM snapshots ORDER BY created_at DESC LIMIT ?',
      params: [limit]
    });

    return rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as SnapshotKind,
      createdAt: String(row.created_at),
      actorUsername: (row.actor_username as string | null) ?? null,
      note: (row.note as string | null) ?? null
    }));
  }

  async getSnapshotPayload<T>({ snapshotId }: { snapshotId: string }): Promise<T | null> {
    const row = await this.queryFirst<Record<string, unknown>>({
      text: 'SELECT payload_json FROM snapshots WHERE id = ?',
      params: [snapshotId]
    });

    if (!row) return null;
    return parseJsonSafe<T>({ value: row.payload_json as string | null, fallback: null as T });
  }

}

const mapStoredUserRow = (row: Record<string, unknown>): StoredUser => ({
  id: String(row.id),
  username: String(row.username),
  email: (row.email as string | null) ?? null,
  role: row.role as AppUser['role'],
  authSource: row.auth_source as AppUser['authSource'],
  externalSubject: (row.external_subject as string | null) ?? null,
  passwordHash: (row.password_hash as string | null) ?? null,
  protectedFromAutoLink: Number(row.protected_from_auto_link ?? 0) === 1,
  disabled: Number(row.disabled) === 1,
  sessionVersion: Number(row.session_version),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});
