/**
 * Phase 6 verifier gate V6 - the two load-bearing claims about *how* an import
 * writes.
 *
 * The implementer asserts two things that no other gate measures directly:
 *
 * 1. "The live active generation is **never** written to" - the import is
 *    `stageGeneration` -> validate -> `activateGeneration`, with `putRecords`
 *    absent.
 * 2. "On any failure, discard the staged generation and leaves the device
 *    byte-identical."
 *
 * Both are properties of the *call sequence*, not of a final state, so both are
 * measured by putting a recording, fault-injecting proxy in front of the real
 * repository and watching what the product actually calls. The proxy forwards every
 * call to the real `StorageV2Repository`; it invents nothing, so the product is
 * still running against real storage-v2 over `fake-indexeddb`.
 *
 * The claim (1) matters because plan section 5.2 requires that "Data imports never
 * partially overwrite the active data generation", and because a device that has
 * only one generation has no rollback path at all: an in-place write would leave a
 * half-imported device with nothing to go back to. The claim (2) matters because a
 * staged generation that is not discarded is invisible to the pointer but still
 * occupies records, which is exactly the orphan state `discardAbandonedGeneration`
 * exists to clean up - a product that created orphans on every failed import would
 * be a slow storage leak.
 */

import { describe, expect, it } from 'vitest';

import {
  exportSubjectBackup,
  importSubjectBackup,
} from '@/services/persistence/products/subjectBackup';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import { StorageV2Error } from '@/services/persistence/v2/schema';
import {
  ALPHA,
  ATT_ALPHA,
  forgeDevice,
  readActiveValues,
  type ForgedDevice,
} from './support/forge';
import { diffFingerprints, fingerprintDevice } from './support/forge';
import { listAllGenerationIds } from './support/forge';
import { listAllRecordGenerations, listMetaRecordIds } from './support/rawIdb';

const NOW = '2026-05-06T07:08:09.000Z';

interface Recorder {
  readonly calls: string[];
  readonly repository: StorageV2Repository;
}

/**
 * A transparent proxy that records every method call by name and can be told to
 * fail one of them once, after forwarding the previous calls.
 */
function recordingRepository(
  repository: StorageV2Repository,
  failOnce?: {
    readonly method: string;
    readonly after: number;
    /** Only inject once this method has been called, so "after staging" is exact. */
    readonly onlyAfter?: string;
  },
): Recorder {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const target = repository as unknown as Record<string, unknown>;
  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(object, property, receiver);
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(property);
        const seen = (counts.get(property) ?? 0) + 1;
        counts.set(property, seen);
        const armed =
          failOnce !== undefined &&
          (failOnce.onlyAfter === undefined || (counts.get(failOnce.onlyAfter) ?? 0) > 0);
        if (
          armed &&
          property === failOnce.method &&
          seen > failOnce.after &&
          !counts.has(`failed:${property}`)
        ) {
          counts.set(`failed:${property}`, 1);
          return Promise.reject(
            new StorageV2Error('CHECKSUM_MISMATCH', { stage: 'injected-fault' }),
          );
        }
        return (value as (...rest: unknown[]) => unknown).apply(object, args);
      };
    },
  });
  return { calls, repository: proxy as unknown as StorageV2Repository };
}

async function exportAlpha(repository: StorageV2Repository, device: ForgedDevice): Promise<Uint8Array> {
  const result = await exportSubjectBackup({
    repository,
    generationId: device.generationId,
    subjectId: ALPHA,
    now: NOW,
    payloadBytes: new Map([[ATT_ALPHA, device.sharedBytes]]),
  });
  return result.bytes;
}

describe('Phase 6 verifier V6: the write discipline', () => {
  it('an import calls stageGeneration, validates, and activates - and never putRecords or deleteRecords', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device.repository, device);
    const recorder = recordingRepository(device.repository);

    const result = await importSubjectBackup({ repository: recorder.repository, bytes, now: NOW });

    // The write sequence, in order, with the reads it needs and nothing else that
    // mutates.
    const writes = recorder.calls.filter((name) =>
      ['stageGeneration', 'putRecords', 'deleteRecords', 'activateGeneration', 'discardStagedGeneration', 'writeMigrationReceipt', 'rollbackToGeneration', 'pruneGenerations'].includes(name),
    );
    expect(writes).toEqual(['stageGeneration', 'activateGeneration']);

    // The compare-and-validate step the plan's 7.1 sequence requires is really run.
    expect(recorder.calls.filter((name) => name === 'readRecords').length).toBeGreaterThanOrEqual(2);
    expect(recorder.calls).toContain('validateGeneration');

    // And the stage happened under a NEW label, with the previous generation as
    // its parent, and the previous generation was still readable afterwards.
    expect(result.generationId).not.toBe(device.generationId);
    expect(result.previousActiveGenerationId).toBe(device.generationId);
    const previous = await device.repository.readRecords(device.generationId);
    expect(previous.records.subjects.length).toBe(3);
    // The descriptor of the new generation says what produced it.
    const descriptor = (await device.repository.readGeneration(result.generationId))?.descriptor;
    expect(descriptor?.source).toBe('subject-import');
    expect(descriptor?.status).toBe('active');
    // ...and the previous one was superseded rather than deleted.
    const old = (await device.repository.readGeneration(device.generationId))?.descriptor;
    expect(old?.status).toBe('superseded');
  });

  it('a replace obeys the same discipline: no putRecords, no in-place write', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device.repository, device);
    const recorder = recordingRepository(device.repository);
    const result = await importSubjectBackup({
      repository: recorder.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    const writes = recorder.calls.filter((name) =>
      ['stageGeneration', 'putRecords', 'deleteRecords', 'activateGeneration', 'discardStagedGeneration'].includes(name),
    );
    expect(writes).toEqual(['stageGeneration', 'activateGeneration']);
    expect(result.activated).toBe(true);
  });

  it('a failure AFTER staging discards the staged generation and leaves nothing behind', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device.repository, device);
    const before = await fingerprintDevice(device.repository, device.databaseName);
    const generationsBefore = await listAllRecordGenerations(device.databaseName);

    // Fault injected at the read-back compare, which is the first thing the product
    // does after `stageGeneration` returns and therefore the earliest post-stage
    // failure there is. `onlyAfter: 'stageGeneration'` is what makes it *post*-stage:
    // the product also calls `readRecords` while choosing a free generation label,
    // which happens before the stage.
    const recorder = recordingRepository(device.repository, {
      method: 'readRecords',
      after: 0,
      onlyAfter: 'stageGeneration',
    });
    await expect(
      importSubjectBackup({ repository: recorder.repository, bytes, now: NOW }),
    ).rejects.toThrow(/CHECKSUM_MISMATCH/);

    // The staged generation was discarded, by name.
    expect(recorder.calls.filter((name) => name === 'stageGeneration').length).toBe(1);
    expect(recorder.calls.filter((name) => name === 'discardStagedGeneration').length).toBe(1);
    expect(recorder.calls).not.toContain('activateGeneration');

    // Nothing is left under the staged label: no descriptor, no records. This is
    // the orphan check, read straight out of IndexedDB rather than through the API.
    const describedAfter = await listMetaRecordIds(device.databaseName);
    const recordedAfter = await listAllRecordGenerations(device.databaseName);
    expect(describedAfter.sort()).toEqual(generationsBefore.filter((id) => describedAfter.includes(id)).sort());
    expect(recordedAfter.sort()).toEqual(generationsBefore.sort());
    const known = await listAllGenerationIds(device.repository, device.databaseName);
    expect(known.sort()).toEqual([...new Set([...generationsBefore, device.generationId, device.priorGenerationId])].sort());

    // And the device is byte-identical.
    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).toBe(before.digest);
    expect(diffFingerprints(before, after).lines).toEqual([]);
  });

  it('a failure at VALIDATION discards the staged generation too', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device.repository, device);
    const before = await fingerprintDevice(device.repository, device.databaseName);
    // The third read the import makes is the validate-generation one in this
    // product's sequence; a fault on `validateGeneration` itself is unambiguous.
    const recorder = recordingRepository(device.repository, { method: 'validateGeneration', after: 0 });
    await expect(
      importSubjectBackup({ repository: recorder.repository, bytes, now: NOW }),
    ).rejects.toThrow(/CHECKSUM_MISMATCH/);
    expect(recorder.calls).toContain('discardStagedGeneration');
    expect(recorder.calls).not.toContain('activateGeneration');
    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).toBe(before.digest);
  });

  it('a failure at ACTIVATION discards the staged generation, and the pointer never moved', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device.repository, device);
    const before = await fingerprintDevice(device.repository, device.databaseName);
    const recorder = recordingRepository(device.repository, { method: 'activateGeneration', after: 0 });
    await expect(
      importSubjectBackup({ repository: recorder.repository, bytes, now: NOW }),
    ).rejects.toThrow(/CHECKSUM_MISMATCH/);
    expect(recorder.calls).toContain('discardStagedGeneration');
    // The pointer is the load-bearing part: an activation that half-succeeded would
    // leave it naming a generation that has just been deleted.
    expect(await device.repository.readActiveGenerationId()).toBe(device.generationId);
    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).toBe(before.digest);
  });

  it('a failure BEFORE staging writes nothing at all', async () => {
    const device = await forgeDevice();
    // An archive whose manifest disagrees with its own counts is refused by the
    // reader, before any repository call is made.
    const { writeArchive, readArchive } = await import('@/services/persistence/v2/archive');
    const { canonicalJsonStringify } = await import('@/services/persistence/v2/checksum');
    const bytes = await exportAlpha(device.repository, device);
    const files = readArchive(bytes);
    const manifest = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === 'manifest.json')!.bytes)) as Record<string, unknown>;
    const broken = { ...manifest, roomCount: 99 };
    const corrupt = writeArchive([
      ...files.filter((f) => f.path !== 'manifest.json'),
      { path: 'manifest.json', bytes: new TextEncoder().encode(canonicalJsonStringify(broken)) },
    ] as never);

    const before = await fingerprintDevice(device.repository, device.databaseName);
    const recorder = recordingRepository(device.repository);
    await expect(
      importSubjectBackup({ repository: recorder.repository, bytes: corrupt, now: NOW }),
    ).rejects.toThrow(/COUNT_MISMATCH/);
    expect(recorder.calls).toEqual([]);
    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).toBe(before.digest);
  });

  it('the retained previous generation is a usable rollback target after a replace', async () => {
    const device = await forgeDevice();
    const bytes = await exportAlpha(device.repository, device);
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: ALPHA,
      confirmReplace: true,
    });
    // The rollback path is not decorative: the retained generation validates and
    // still holds the pre-import records.
    const previous = result.previousActiveGenerationId as string;
    const validation = await device.repository.validateGeneration(previous);
    expect(validation.problems.filter((p) => p.severity === 'error')).toEqual([]);
    const rolled = await device.repository.rollbackToGeneration(previous);
    expect(rolled.previousActiveGenerationId).toBe(result.generationId);
    const restored = await readActiveValues(device);
    expect(restored.subjects.some((r) => r.subjectId === ALPHA)).toBe(true);
    expect(restored.subjects.length).toBe(3);
  });
});
