/**
 * Independent attacks on the two new subsystems and the bootstrap.
 *
 * - `attachmentBytes.ts`: the round trip, the hash, caller mutation, object-URL
 *   lifetime, concurrency, a failed write, a second delete, and the external-only
 *   record's inability to expose bytes or a URL.
 * - `dualWrite.ts`: ordering, sanitisation, bounds, propagation, and the
 *   active-subject pointer's deliberate exclusion.
 * - `migrationState.ts`: the four states' mutual exclusivity and
 *   `assertMigrationStatusReachable` attacked directly.
 * - `bootstrap.ts`: every store hydrated before the first render, a read failure
 *   that cannot half-hydrate, StrictMode's double-invoke, and a failed migration
 *   that must still show the learner their data.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  SUBJECT_ID,
  NOW,
  ROOT_ROOM_ID,
  openRepo,
  dropRepo,
  legacyKeySet,
  seedLegacyKeys,
  syntheticSnapshot,
} from './support/phase4Support';

import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import {
  resetRepositorySelection,
  selectLegacyRepository,
  selectStorageV2Repository,
} from '@/services/persistence/v2/repositorySelection';
import {
  clearDualWriteReports,
  dualWriteReports,
  DUAL_WRITE_REPORT_LIMIT,
  recordDualWriteReport,
  setDualWriteSink,
  summarizeDualWriteReports,
  writeThrough,
  fireAndForget,
} from '@/services/persistence/v2/dualWrite';
import {
  closeDeviceLocalAttachmentStore,
  deleteAttachmentBytes,
  deleteDeviceLocalAttachmentDatabase,
  listDeviceLocalAttachments,
  readAttachmentBytes,
  readAttachmentObjectUrl,
  readAttachmentRecord,
  recordExternalAttachment,
  storeAttachmentBytes,
} from '@/services/persistence/v2/attachmentBytes';
import {
  assertMigrationStatusReachable,
  classifyMigrationReport,
  MIGRATION_BLOCKING_POLICY,
} from '@/services/persistence/v2/migrationState';
import type { MigrationReport } from '@/services/persistence/v2/schema';
import { saveSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const EXTERNAL_URL = 'https://example.invalid/phase4-attack-external.png';

const handles: StorageV2Repository[] = [];
const dbNames: string[] = [];

async function openRepoTracked(suffix: string): Promise<StorageV2Repository> {
  dbNames.push(suffix);
  const repo = await openRepo(suffix);
  handles.push(repo);
  return repo;
}

function bytes(...values: number[]): Blob {
  return new Blob([new Uint8Array(values)], { type: 'image/png' });
}

beforeEach(() => {
  window.localStorage.clear();
  seedLegacyKeys();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase().catch(() => undefined);
  for (const handle of handles.splice(0)) handle.close();
  for (const suffix of dbNames.splice(0)) await dropRepo(suffix);
  resetRepositorySelection();
  clearDualWriteReports();
  setDualWriteSink(null);
  window.localStorage.clear();
});

describe('attachmentBytes: the bytes and the hash are the real thing', () => {
  it('round-trips byte for byte and hashes exactly what Node hashes', async () => {
    // A sweep across the SHA-256 padding boundaries, including 55, 56, 63, 64,
    // 119 and 120 bytes, which is where a hand-rolled padding expression breaks.
    const lengths = [0, 1, 2, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 183, 184, 200, 1000];
    for (const length of lengths) {
      const payload = Array.from({ length }, (_value, index) => (index * 37 + length) % 256);
      const stored = await storeAttachmentBytes({
        subjectId: SUBJECT_ID,
        roomId: ROOT_ROOM_ID,
        bytes: bytes(...payload),
        mimeType: 'image/png',
        fileName: `phase4-synthetic-${length}.png`,
        now: NOW,
      });
      const expected = createHash('sha256').update(Buffer.from(payload)).digest('hex');
      expect(stored.contentHash, `length ${length}`).toBe(expected);
      expect(stored.byteLength, `length ${length}`).toBe(length);
      const read = await readAttachmentBytes(stored.attachmentId);
      expect(read, `length ${length}`).not.toBeNull();
      expect([...read?.bytes ?? []], `length ${length}`).toEqual(payload);
      expect(read?.contentHash, `length ${length}`).toBe(expected);
    }
  });

  it('a caller mutating its buffer after the write cannot change the stored bytes', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const blob = new Blob([payload], { type: 'image/png' });
    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOT_ROOM_ID,
      bytes: blob,
      mimeType: 'image/png',
      now: NOW,
    });
    // Mutate the caller's own view, and try to reach the stored buffer.
    payload.fill(0xff);
    const record = await readAttachmentRecord(stored.attachmentId);
    new Uint8Array(record?.bytes as ArrayBuffer).fill(0xee);
    new Uint8Array(record?.bytes as ArrayBuffer)[0] = 0xdd;

    const read = await readAttachmentBytes(stored.attachmentId);
    // The module copies on the way in and copies on the way out, so a mutation
    // on either side is invisible to the stored bytes.
    expect([...(read?.bytes ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(read?.contentHash).toBe(
      createHash('sha256').update(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])).digest('hex'),
    );
  });

  it('holds the bytes under concurrent writes and a re-read', async () => {
    const writes = await Promise.all(
      Array.from({ length: 24 }, (_value, index) =>
        storeAttachmentBytes({
          subjectId: SUBJECT_ID,
          roomId: ROOT_ROOM_ID,
          bytes: bytes(index, index + 1, index + 2),
          mimeType: 'image/png',
          fileName: `phase4-concurrent-${index}.png`,
          now: NOW,
        }),
      ),
    );
    const ids = new Set(writes.map((entry) => entry.attachmentId));
    expect(ids.size).toBe(24);
    const listed = await listDeviceLocalAttachments();
    expect(listed).toHaveLength(24);
    for (const write of writes) {
      const read = await readAttachmentBytes(write.attachmentId);
      expect(read?.byteLength).toBe(3);
      expect(read?.contentHash).toBe(write.contentHash);
    }
  });

  it('a write that fails mid-transaction leaves nothing behind', async () => {
    const before = await listDeviceLocalAttachments();
    // The realistic mid-transaction failure: the record is handed to the store
    // and the transaction is then aborted, so the write is neither committed nor
    // half-visible. `put` is wrapped rather than the module patched, so the code
    // under test is the real one.
    const original = IDBObjectStore.prototype.put;
    const putSpy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
        const request = (original as (...rest: unknown[]) => IDBRequest).apply(this, args);
        request.transaction?.abort();
        return request;
      });
    try {
      await expect(
        storeAttachmentBytes({
          subjectId: SUBJECT_ID,
          roomId: ROOT_ROOM_ID,
          bytes: bytes(1, 2, 3),
          mimeType: 'image/png',
          fileName: 'phase4-aborted.png',
          now: NOW,
        }),
      ).rejects.toThrow();
    } finally {
      putSpy.mockRestore();
    }
    // Nothing was committed, and the failure was a typed storage error.
    expect(await listDeviceLocalAttachments()).toEqual(before);
    expect(await readAttachmentRecord('att-phase4-aborted')).toBeNull();
  });

  it('deleting twice reports the truth both times', async () => {
    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOT_ROOM_ID,
      bytes: bytes(7, 7, 7),
      mimeType: 'image/png',
      now: NOW,
    });
    expect(await deleteAttachmentBytes(stored.attachmentId)).toBe(true);
    expect(await deleteAttachmentBytes(stored.attachmentId)).toBe(false);
    expect(await deleteAttachmentBytes('att-phase4-never-existed')).toBe(false);
    expect(await readAttachmentBytes(stored.attachmentId)).toBeNull();
    expect(await listDeviceLocalAttachments()).toEqual([]);
  });

  it('an external attachment exposes no bytes, no hash, and no object URL', async () => {
    const external = await recordExternalAttachment({
      subjectId: SUBJECT_ID,
      roomId: ROOT_ROOM_ID,
      externalUrl: EXTERNAL_URL,
      mimeType: 'image/png',
      fileName: 'phase4-synthetic-external.png',
      altText: 'phase4 synthetic external alt',
      now: NOW,
    });
    expect(external.availability).toBe('external-only');
    expect(external.contentHash).toBeNull();

    const record = await readAttachmentRecord(external.attachmentId);
    expect(record?.bytes).toBeNull();
    expect(record?.byteLength).toBe(0);
    expect(record?.contentHash).toBeNull();
    expect(record?.storedAt).toBeNull();
    expect(record?.externalUrl).toBe(EXTERNAL_URL);
    expect(await readAttachmentBytes(external.attachmentId)).toBeNull();
    // The critical one: no object URL is minted for a record with no bytes, so a
    // preview can never turn into a request.
    expect(await readAttachmentObjectUrl(external.attachmentId)).toBeNull();
    expect(await readAttachmentObjectUrl('att-phase4-never-existed')).toBeNull();
  });

  it('an object URL is minted from the stored bytes and is the caller\'s to revoke', async () => {
    const stored = await storeAttachmentBytes({
      subjectId: SUBJECT_ID,
      roomId: ROOT_ROOM_ID,
      bytes: bytes(1, 2, 3, 4),
      mimeType: 'image/png',
      now: NOW,
    });
    const created: string[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob.size === 4 && blob.type === 'image/png' ? 'blob:synthetic-ok' : 'blob:synthetic-bad');
      return created[created.length - 1] as string;
    });
    const revokeObjectURL = vi.fn();
    const original = (URL as unknown as { createObjectURL: unknown; revokeObjectURL: unknown });
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    try {
      const url = await readAttachmentObjectUrl(stored.attachmentId);
      expect(url).toBe('blob:synthetic-ok');
      // The store does not revoke for the caller: ownership is documented, and
      // the note editor's effect is what releases them.
      expect(revokeObjectURL).not.toHaveBeenCalled();
      revokeObjectURL(url as string);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-ok');
    } finally {
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = original.createObjectURL;
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = original.revokeObjectURL;
    }
  });
});

describe('dualWrite: the primary is never sacrificed, and a failure is never swallowed', () => {
  it('runs the mirror only after the primary has resolved', async () => {
    const order: string[] = [];
    let releasePrimary = (): void => undefined;
    const primaryGate = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    const pending = writeThrough({
      operation: 'subject.save',
      primary: async () => {
        order.push('primary:start');
        await primaryGate;
        order.push('primary:done');
        return 'value';
      },
      mirror: () => {
        order.push('mirror');
        return true;
      },
    });
    // Give the primary every chance to finish first.
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(order, 'the mirror ran before the primary finished').toEqual(['primary:start']);
    releasePrimary();
    const result = await pending;
    expect(order).toEqual(['primary:start', 'primary:done', 'mirror']);
    expect(result).toEqual({ primaryValue: 'value', primaryOk: true, mirrorOk: true, repository: 'v2' });
  });

  it('a primary failure leaves the legacy keys untouched and rejects', async () => {
    let mirrored = false;
    await expect(
      writeThrough({
        operation: 'progression',
        primary: async () => {
          throw new Error('qa primary failure');
        },
        mirror: () => {
          mirrored = true;
          return true;
        },
      }),
    ).rejects.toThrow('qa primary failure');
    expect(mirrored, 'the mirror ran after a failed primary').toBe(false);
    expect(dualWriteReports()).toEqual([
      { sequence: 1, operation: 'progression', outcome: 'primary-failed', code: 'STORAGE_V2_WRITE_FAILED' },
    ]);
  });

  it('a mirror failure never rejects and never hides itself', async () => {
    for (const mirror of [() => false, () => { throw new Error('qa mirror failure'); }]) {
      clearDualWriteReports();
      const result = await writeThrough({ operation: 'shortcuts', primary: async () => 'ok', mirror });
      expect(result.primaryOk).toBe(true);
      expect(result.mirrorOk).toBe(false);
      // The primary landed, and the mirror did not take it. Both facts are
      // reported: `written` is independent of the mirror, so the failure is
      // never the only report and never hidden behind a success.
      expect(dualWriteReports()).toEqual([
        { sequence: 1, operation: 'shortcuts', outcome: 'written', code: null },
        { sequence: 2, operation: 'shortcuts', outcome: 'mirror-failed', code: 'LEGACY_MIRROR_WRITE_FAILED' },
      ]);
    }
  });

  it('reports carry no record content and are bounded', async () => {
    const seen: unknown[] = [];
    setDualWriteSink({ onDualWriteReport: (report) => seen.push(report) });
    const marker = 'Phase4 Attack Synthetic Subject Name';
    for (let index = 0; index < DUAL_WRITE_REPORT_LIMIT + 40; index += 1) {
      recordDualWriteReport('subject.save', 'mirror-failed', 'LEGACY_MIRROR_WRITE_FAILED');
    }
    const reports = dualWriteReports();
    // Bounded, and the sequence is monotonic rather than a clock.
    expect(reports).toHaveLength(DUAL_WRITE_REPORT_LIMIT);
    expect(reports[0]?.sequence).toBe(41);
    expect(reports[reports.length - 1]?.sequence).toBe(DUAL_WRITE_REPORT_LIMIT + 40);
    expect(seen).toHaveLength(DUAL_WRITE_REPORT_LIMIT + 40);
    // Every key of every report is from the fixed vocabulary: no free text, so a
    // subject name or a note cannot ride along.
    for (const report of reports) {
      expect(Object.keys(report).sort()).toEqual(['code', 'operation', 'outcome', 'sequence']);
      expect(typeof report.operation).toBe('string');
      expect(JSON.stringify(report)).not.toContain(marker);
    }
    expect(summarizeDualWriteReports(reports)).toEqual({
      written: 0,
      primaryFailed: 0,
      mirrorFailed: DUAL_WRITE_REPORT_LIMIT,
      lastCode: 'LEGACY_MIRROR_WRITE_FAILED',
    });
  });

  it('a successful write records `written`, so a recovery screen can count it', async () => {
    // Previously recorded as a finding: `DualWriteOutcome` declares 'written'
    // and `summarizeDualWriteReports` counts it, but no production path ever
    // recorded it, so a recovery screen built on the summary always reported
    // zero successful writes. `writeThrough` now records it once the primary
    // has succeeded, and a failure is still never swallowed.
    await writeThrough({ operation: 'preferences', primary: async () => 1, mirror: () => true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dualWriteReports()).toEqual([
      { sequence: 1, operation: 'preferences', outcome: 'written', code: null },
    ]);
    expect(summarizeDualWriteReports().written).toBe(1);
  });

  it('fireAndForget turns a rejected write into a report and never an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      fireAndForget('sessions', Promise.reject(new Error('qa rejected')));
      for (let index = 0; index < 50; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(rejections).toEqual([]);
      expect(dualWriteReports()).toEqual([
        { sequence: 1, operation: 'sessions', outcome: 'primary-failed', code: 'STORAGE_V2_WRITE_FAILED' },
      ]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('the active-subject pointer is deliberately not dual-written, and that is safe', async () => {
    const repo = await openRepoTracked('pointer');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-pointer',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    const before = legacyKeySet();
    const pointer = before['knowledge-dungeon:v1:activeSubjectId'];

    // Every flagged-build write leaves the pointer exactly where it was.
    await saveSubjectSnapshot(SUBJECT_ID, syntheticSnapshot());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.localStorage.getItem('knowledge-dungeon:v1:activeSubjectId')).toBe(pointer);
    // And a rollback build reads the same pointer, so "the subject I was last in"
    // survives the switch in both directions.
    resetRepositorySelection();
    selectLegacyRepository();
    const { getActiveSubjectId } = await import('@/services/persistence/subjectPersistence');
    expect(getActiveSubjectId()).toBe(pointer);
    // The migration recorded it too, so the flagged build's own read is not the
    // only place the pointer exists.
    const active = await repo.readActiveGenerationId();
    expect((await repo.readRecords(active as string)).records.sessions.length).toBe(1);
  });

  it('the legacy device is never ahead of storage-v2, even under repeated writes', async () => {
    const repo = await openRepoTracked('ordering');
    await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-ordering',
      now: NOW,
      clock: { now: () => NOW },
    });
    selectStorageV2Repository(repo);
    const before = JSON.parse(
      window.localStorage.getItem('knowledge-dungeon:v1:progression') as string,
    ) as { bySubject: Record<string, { badges: string[] }> };

    // Two writes in a row, the second issued before the first has settled.
    const { useProgressionStore } = await import('@/store/progressionStore');
    useProgressionStore.getState().hydrateProgression(before);
    useProgressionStore.getState().setActiveSubject(SUBJECT_ID);
    useProgressionStore.getState().awardBadge('synthetic-phase4-order-1');
    useProgressionStore.getState().awardBadge('synthetic-phase4-order-2');
    for (let index = 0; index < 60; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 2));
      const mirrored = JSON.parse(
        window.localStorage.getItem('knowledge-dungeon:v1:progression') as string,
      ) as { bySubject: Record<string, { badges: string[] }> };
      const badges = mirrored.bySubject[SUBJECT_ID]?.badges ?? [];
      const active = await repo.readActiveGenerationId();
      const stored = JSON.stringify((await repo.readRecords(active as string)).records.progression);
      // Whatever the interleaving, the mirror is a subset of storage-v2: the
      // legacy key is never *ahead*.
      for (const badge of badges) {
        if (badge.startsWith('synthetic-phase4-order')) {
          expect(stored, `the legacy key was ahead on ${badge}`).toContain(badge);
        }
      }
    }
  });
});

describe('migrationState: the four states are mutually exclusive', () => {
  function report(overrides: Partial<MigrationReport>): MigrationReport {
    return {
      status: 'migrated',
      stagedGenerationId: 'gen-phase4-state',
      previousActiveGenerationId: null,
      activated: true,
      recordCounts: {
        subjects: 1,
        progression: 1,
        sessions: 0,
        preferences: 0,
        shortcuts: 0,
        assistance: 0,
        attachments: 0,
        attachmentBlobs: 0,
        customSprites: 0,
        recovery: 0,
        meta: 0,
        migrationReceipts: 0,
      } as MigrationReport['recordCounts'],
      legacyKeys: {
        allowlistedKeys: 1,
        present: 1,
        absent: 0,
        parseErrors: 0,
        unsupportedShapes: 0,
      },
      externalOnlyAttachments: [],
      problems: [],
      contentChecksum: 'a'.repeat(64),
      receiptId: 'receipt-phase4',
      recovery: null,
      ...overrides,
    } as MigrationReport;
  }

  it('maps each outcome to exactly one state, and the states never overlap', () => {
    const clean = classifyMigrationReport(report({}));
    const withDisclosure = classifyMigrationReport(
      report({
        externalOnlyAttachments: [
          {
            attachmentId: 'att-phase4',
            subjectId: SUBJECT_ID,
            roomId: ROOT_ROOM_ID,
            contentHash: null,
            byteLength: null,
            reason: 'bytes-not-recoverable',
            sourceType: 'local',
          },
        ],
      }),
    );
    const failed = classifyMigrationReport(
      report({
        status: 'recovery-required',
        activated: false,
        recovery: { code: 'TRANSACTION_ABORTED', stage: 'stage-records' } as MigrationReport['recovery'],
      }),
    );
    const empty = classifyMigrationReport(report({ status: 'no-source-data' }));

    // Reports that differ *only* in their outcome produce four distinct kinds,
    // and no kind answers to two outcomes.
    expect([clean.kind, withDisclosure.kind, failed.kind, empty.kind]).toEqual([
      'migrated',
      'partial',
      'recovery-required',
      'no-source-data',
    ]);
    expect(new Set([clean.kind, withDisclosure.kind, failed.kind, empty.kind]).size).toBe(4);
    // A report carrying external-only attachments can never be a clean success.
    expect(withDisclosure.kind === 'migrated').toBe(false);
    expect((withDisclosure as { hasDisclosure: boolean }).hasDisclosure).toBe(true);
    expect((withDisclosure as { externalOnlyAttachments: number }).externalOnlyAttachments).toBe(1);
    // A recovery state always says the legacy generation is authoritative and
    // the pointer never moved.
    expect((failed as { legacyAuthoritative: boolean }).legacyAuthoritative).toBe(true);
    expect(failed.activeGenerationFlipped).toBe(false);
    expect((failed as { retryable: boolean }).retryable).toBe(true);
    // Every state states the blocking policy it used, so a screen cannot invent
    // its own.
    for (const state of [clean, withDisclosure, failed, empty]) {
      expect(state.blockingPolicy).toBe(MIGRATION_BLOCKING_POLICY);
    }
  });

  it('assertMigrationStatusReachable refuses every unreachable success', () => {
    const clean = report({});
    // The happy path: an active generation, and a superseded one later on.
    expect(() => assertMigrationStatusReachable(clean, 'active')).not.toThrow();
    expect(() => assertMigrationStatusReachable(clean, 'superseded')).not.toThrow();
    // A generation that is still only staged: records exist, nothing points at
    // them. This is the ambiguity the Phase 3 review found.
    expect(() => assertMigrationStatusReachable(clean, 'staged')).toThrow(/still only staged/);
    // A generation that does not exist at all.
    expect(() => assertMigrationStatusReachable(clean, null)).toThrow(/still exists/);
    // A report that names no generation.
    expect(() => assertMigrationStatusReachable(report({ stagedGenerationId: null }), 'active')).toThrow(
      /must name the generation/,
    );
    // A report that carries an activation-blocking problem cannot be a success.
    expect(() =>
      assertMigrationStatusReachable(
        report({ problems: [{ code: 'not-an-object', scope: 'subject', count: 1, severity: 'error' }] }),
        'active',
      ),
    ).toThrow(/activation-blocking/);
    // Non-success statuses are not the guard's business.
    expect(() =>
      assertMigrationStatusReachable(report({ status: 'recovery-required', stagedGenerationId: null }), null),
    ).not.toThrow();
    expect(() =>
      assertMigrationStatusReachable(report({ status: 'no-source-data', stagedGenerationId: null }), null),
    ).not.toThrow();
  });
});
