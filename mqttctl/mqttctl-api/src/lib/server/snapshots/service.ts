import type { SnapshotExport, SnapshotKind } from '$lib/types';
import type { AppDatabase } from '$server/db';
import { createOpaqueToken } from '$server/utils/ids';
import { createAppError } from '$server/logging/errors';
import type { DynsecService } from '$server/dynsec/service';
import type { BrokerConfigService } from '$server/config/service';

const snapshotKinds = new Set<SnapshotKind>(['dynsec', 'broker-config', 'combined']);

const createInvalidSnapshotImportError = ({ reason }: { reason: string }) => createAppError({
  caller: 'snapshots::parseImport',
  reason,
  errorKey: 'SNAPSHOT_IMPORT_INVALID',
  correlationId: null,
  status: 400
});

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseSnapshotExport = ({ payload }: { payload: unknown }): SnapshotExport => {
  if (!isRecord(payload)) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot payload must be an object.'
    });
  }

  if (payload.title !== 'MQTTCTL' || payload.type !== 'snapshot') {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot payload must include the MQTTCTL snapshot export envelope.'
    });
  }

  if (typeof payload.exportTime !== 'string' || !payload.exportTime.trim()) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot export must include a non-empty export timestamp.'
    });
  }

  if (typeof payload.build !== 'string' || !payload.build.trim()) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot export must include a non-empty build label.'
    });
  }

  if (!isRecord(payload.snapshot)) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot export must include snapshot metadata.'
    });
  }

  if (typeof payload.snapshot.id !== 'string' || !payload.snapshot.id.trim()) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot export must include a non-empty snapshot id.'
    });
  }

  if (!snapshotKinds.has(payload.snapshot.kind as SnapshotKind)) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot export must include a valid snapshot kind.'
    });
  }

  if (!isRecord(payload.data)) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot export must include a data object.'
    });
  }

  if (!(payload.snapshot.note === null || payload.snapshot.note === undefined || typeof payload.snapshot.note === 'string')) {
    throw createInvalidSnapshotImportError({
      reason: 'Snapshot export note must be null or a string.'
    });
  }

  return {
    title: 'MQTTCTL',
    type: 'snapshot',
    exportTime: payload.exportTime,
    build: payload.build,
    snapshot: {
      id: payload.snapshot.id,
      kind: payload.snapshot.kind as SnapshotKind,
      note: typeof payload.snapshot.note === 'string' ? payload.snapshot.note : null
    },
    data: payload.data
  };
};

export class SnapshotService {
  constructor(
    private readonly db: AppDatabase,
    private readonly buildLabel: string,
    private readonly dynsec: DynsecService,
    private readonly brokerConfig: BrokerConfigService
  ) {}

  async exportSnapshot({
    kind,
    actorUsername,
    note,
    correlationId
  }: {
    kind: SnapshotKind;
    actorUsername: string | null;
    note: string | null;
    correlationId: string | null;
  }): Promise<SnapshotExport> {
    const id = createOpaqueToken({ bytes: 18 });
    const exportTime = new Date().toISOString();

    const data: Record<string, unknown> = {};

    if (kind === 'dynsec' || kind === 'combined') {
      data.dynsec = await this.dynsec.readState({ correlationId });
    }

    if (kind === 'broker-config' || kind === 'combined') {
      data.brokerConfig = {
        current: await this.brokerConfig.readCurrentBrokerConfig({ correlationId })
      };
    }

    if (kind === 'combined') {
      data.users = (await this.db.listUsers()).map(({ passwordHash: _passwordHash, ...user }) => user);
    }

    const snapshot = {
      title: 'MQTTCTL',
      type: 'snapshot',
      exportTime,
      build: this.buildLabel,
      snapshot: {
        id,
        kind,
        note
      },
      data
    } satisfies SnapshotExport;

    await this.db.createSnapshot({
      id,
      kind,
      createdAt: exportTime,
      actorUsername,
      note,
      payload: snapshot
    });

    return snapshot;
  }

  async listSnapshots() {
    return await this.db.listSnapshots();
  }

  previewImport({ payload }: { payload: unknown }) {
    const snapshot = parseSnapshotExport({ payload });
    return {
      metadata: {
        title: snapshot.title,
        type: snapshot.type,
        exportTime: snapshot.exportTime,
        build: snapshot.build,
        ...snapshot.snapshot
      },
      dataKeys: Object.keys(snapshot.data),
      dynsecImportNotice: snapshot.data.dynsec
        ? 'Dynsec snapshot restore is preview-only for client password safety.'
        : null
    };
  }

  async applyImport({
    payload,
    actorUsername,
    correlationId
  }: {
    payload: unknown;
    actorUsername: string | null;
    correlationId: string | null;
  }) {
    const preview = this.previewImport({ payload });
    const snapshot = parseSnapshotExport({ payload });
    const results: Record<string, unknown> = {
      preview
    };

    const brokerConfigPayload = snapshot.data.brokerConfig as {
      current?: unknown;
    } | undefined;
    if (typeof brokerConfigPayload?.current === 'string') {
      await this.brokerConfig.pushBrokerConfig({
        rendered: brokerConfigPayload.current,
        actorUsername,
        correlationId
      });
      results.brokerConfig = 'pushed';
    }

    if (snapshot.data.dynsec) {
      results.dynsec = 'preview-only: client passwords are not present in snapshot exports and are not automatically restored.';
    }

    return results;
  }
}
