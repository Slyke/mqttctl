import type { AuditEntriesPage, AuditEntry, AuditEntryLimitValue, AuditIntegrityStatus, AuditLogExport } from '$lib/types';
import type { AuthenticatedUser } from '$server/auth/types';
import { createOpaqueToken } from '$server/utils/ids';
import type { AppDatabase } from '$server/db';
import type { AppLogger } from '$server/logging/logger';

const sensitiveAuditKeySet = new Set([
  'password',
  'passwordhash',
  'secret',
  'sessionsecret',
  'clientsecret',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'codeverifier',
  'authorization'
]);

const isSensitiveAuditKey = ({ key }: { key: string }) => sensitiveAuditKeySet.has(key.replace(/[_-]/g, '').toLowerCase());
export const auditEntryLimitOptions = ['10', '20', '50', '100', 'all'] as const satisfies readonly AuditEntryLimitValue[];
export const defaultAuditEntryLimitValue: AuditEntryLimitValue = '20';

export const parseAuditEntryLimitValue = ({ value }: { value: string | null | undefined }): AuditEntryLimitValue =>
  auditEntryLimitOptions.includes((value ?? '') as AuditEntryLimitValue)
    ? (value as AuditEntryLimitValue)
    : defaultAuditEntryLimitValue;

export const resolveAuditEntryLimit = ({ value }: { value: AuditEntryLimitValue }) =>
  value === 'all' ? null : Number.parseInt(value, 10);

export const buildAuditIndexFilter = ({ value }: { value: AuditEntryLimitValue }): [number, number] => [
  0,
  value === 'all' ? -1 : Number.parseInt(value, 10)
];

const redactAuditSecrets = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditSecrets({ value: entry }));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveAuditKey({ key })
        ? '<redacted>'
        : redactAuditSecrets({ value: entry })
    ])
  );
};

const toAuditExportEntry = ({ entry }: { entry: AuditEntry }) => ({
  time: entry.timestamp,
  author: entry.actorUsername ?? 'System',
  authorUserId: entry.actorUserId,
  auth: entry.authMode ?? 'N/A',
  ip: entry.sourceIp ?? 'N/A',
  action: entry.action,
  targetType: entry.targetType,
  targetId: entry.targetId,
  target: entry.targetId ? `${entry.targetType}: ${entry.targetId}` : entry.targetType,
  result: entry.success ? 'success' as const : 'failed' as const,
  correlation: entry.correlationId,
  before: entry.beforeSummary,
  after: entry.afterSummary,
  commandResult: entry.commandResult,
  previousHash: entry.previousEntryHash
});

export class AuditService {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: AppDatabase,
    private readonly logger: AppLogger
  ) {}

  async listEntries({ limitValue }: { limitValue: AuditEntryLimitValue }): Promise<AuditEntriesPage> {
    const limit = resolveAuditEntryLimit({ value: limitValue });
    const [entries, totalEntries] = await Promise.all([
      this.db.listAuditEntries({ limit }),
      this.db.countAuditEntries()
    ]);

    return {
      limitValue,
      totalEntries,
      hasMore: limit !== null && totalEntries > entries.length,
      filters: {
        indexes: buildAuditIndexFilter({ value: limitValue })
      },
      entries
    };
  }

  async verifyIntegrity(): Promise<AuditIntegrityStatus> {
    return await this.db.verifyAuditIntegrity();
  }

  async exportEntries({
    limitValue,
    buildLabel
  }: {
    limitValue: AuditEntryLimitValue;
    buildLabel: string;
  }): Promise<AuditLogExport> {
    const [page, integrity] = await Promise.all([
      this.listEntries({ limitValue }),
      this.verifyIntegrity()
    ]);

    return {
      exportTime: new Date().toISOString(),
      build: buildLabel,
      filters: {
        indexes: page.filters.indexes,
        limit: limitValue,
        totalEntries: page.totalEntries,
        returnedEntries: page.entries.length
      },
      title: 'MQTTCTL',
      type: 'audit log',
      integrity,
      data: page.entries.map((entry) => toAuditExportEntry({ entry }))
    };
  }

  async record({
    actor,
    authMode,
    sourceIp,
    correlationId,
    action,
    targetType,
    targetId = null,
    beforeSummary = null,
    afterSummary = null,
    commandResult = null,
    success
  }: {
    actor: AuthenticatedUser | null;
    authMode: string | null;
    sourceIp: string | null;
    correlationId: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    beforeSummary?: unknown;
    afterSummary?: unknown;
    commandResult?: unknown;
    success: boolean;
  }) {
    const sanitizedBeforeSummary = redactAuditSecrets({ value: beforeSummary });
    const sanitizedAfterSummary = redactAuditSecrets({ value: afterSummary });
    const sanitizedCommandResult = redactAuditSecrets({ value: commandResult });
    const runWrite = async () => {
      await this.db.appendAudit({
        id: createOpaqueToken({ bytes: 18 }),
        timestamp: new Date().toISOString(),
        actorUsername: actor?.username ?? null,
        actorUserId: actor?.id ?? null,
        authMode,
        sourceIp,
        correlationId,
        action,
        targetType,
        targetId,
        beforeSummary: sanitizedBeforeSummary,
        afterSummary: sanitizedAfterSummary,
        commandResult: sanitizedCommandResult,
        success
      });

      this.logger.info({
        caller: 'audit::record',
        message: `${action} ${success ? 'succeeded' : 'failed'} for ${targetType}`,
        correlationId,
        context: {
          targetId,
          actor: actor?.username ?? null
        }
      });
    };

    const writePromise = this.writeQueue.then(runWrite);
    this.writeQueue = writePromise.catch(() => {});
    await writePromise;
  }
}
