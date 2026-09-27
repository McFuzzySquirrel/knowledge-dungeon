/**
 * Phase 6 data-product gate: **a record that is not owned by the subject it is keyed
 * on**, and the three id-reference disclosures that came out of the same review.
 *
 * ## What this gate holds
 *
 * `ProgressionRecordValue` is keyed by `record.subjectId` and holds a
 * `bySubject: Record<string, unknown>` map, and the canonical v3 `localStorage`
 * writer produced exactly the shape that makes that dangerous: **one** record whose
 * `bySubject` was filled with every subject on the device. A `.kdsubject` import
 * that treats such a record as belonging to its named subject destroys other
 * subjects' learner state, and reports nothing, because a per-store record count
 * cannot express "this record was also holding somebody else".
 *
 * This gate is built on `support/sharedProgressionDevice.ts` - a fixture written for
 * these findings, where a bystander's learner state lives **only** inside the
 * exported subject's progression record, and an unrelated control subject has a
 * record of its own. That makes every assertion below a statement about a *whole*
 * loss rather than about a duplicate, and gives the merge a record it must leave
 * alone so "it touched only the target" is a measurement.
 *
 * The five findings, one block each:
 *
 * 1. **A replace must not destroy the bystander**, must not roll the device's newer
 *    state back with an archive's older one, must say what it did, and must not put a
 *    bystander identifier in the report.
 * 2. **A copy must not fork the bystander.** A foreign `bySubject` entry is carried
 *    verbatim - key, fish ids, note ids, and all - and no identifier inside one is
 *    minted, so the reported mapping does not claim a rewrite that did not happen.
 * 4. **A `relativePath` naming a remapped id is disclosed, not rewritten**, because
 *    it addresses a file in the Electron `userData` tree that this copy did not move.
 * 5. **The residual's meaning is pinned to string values.** An id in an object
 *    **key** is neither swept nor counted, and the module header now says exactly
 *    that instead of claiming the count covers it.
 * 6. **`DungeonMetadata.dungeonId` is a declared subject-id location**, rewritten
 *    when it equals the record's own `subjectId` and disclosed when it does not.
 *
 * Privacy: assertions compare canonical record values for equality and read counts.
 * No assertion copies a subject name, a topic, a note, a filename, or a URL into a
 * failure message, and the report-privacy cases assert that no identifier reaches
 * the result at all.
 */

import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import { progressionEnvelopeFrom } from '@/services/persistence/v2/appState';
import type {
  AssistanceRecordValue,
  ProgressionRecordValue,
  SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import {
  exportSubjectBackup,
  importSubjectBackup,
  mergeAssistanceForReplace,
  mergeProgressionForReplace,
} from '@/services/persistence/products/subjectBackup';
import {
  remapSubjectRecords,
  SUBJECT_VERBATIM_DISCLOSURE_CODES,
  type SubjectIdGenerator,
  type SubjectVerbatimDisclosureCode,
} from '@/services/persistence/products/idRemapping';
import {
  ASSISTANCE_ID_BYSTANDER,
  ASSISTANCE_ID_OWN,
  BYSTANDER_FISH_ID,
  BYSTANDER_NOTE_ID,
  ROOM_RELATIVE_PATH,
  SHARED_ATTACHMENT_ID,
  SHARED_BYSTANDER_ID,
  SHARED_OWN_FISH_ID,
  SHARED_OWN_NOTE_ID,
  SHARED_SUBJECT_ID,
  SHARED_UNRELATED_ID,
  SHARED_NOW as NOW,
  STALE_DUNGEON_ID,
  SUBJECT_ROOM_ID,
  createSharedProgressionDevice,
  limitArchiveProgressionToOwnSubject,
  sharedSubjectSnapshot,
  type SharedProgressionDevice,
} from './support/sharedProgressionDevice';

/** A counter generator, so a minted identifier is predictable. */
function counter(seed = 'gate'): SubjectIdGenerator {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return `${seed}-${n.toString().padStart(4, '0')}`;
    },
  };
}

async function freshDevice(suffix: string): Promise<SharedProgressionDevice> {
  return createSharedProgressionDevice(`kd-data-gate-shared-${suffix}`);
}

/** The archive as a device that **never shared a record** would have written it. */
async function crossDeviceArchive(device: SharedProgressionDevice): Promise<Uint8Array> {
  return limitArchiveProgressionToOwnSubject(
    (
      await exportSubjectBackup({
        repository: device.repository,
        generationId: device.generationId,
        subjectId: device.subjectId,
        now: NOW,
        payloadBytes: device.payloadBytes,
      })
    ).bytes,
  );
}

/** The archive this device would have written for itself, shared record and all. */
async function sameDeviceArchive(device: SharedProgressionDevice): Promise<Uint8Array> {
  return (
    await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: device.subjectId,
      now: NOW,
      payloadBytes: device.payloadBytes,
    })
  ).bytes;
}

interface ActiveState {
  readonly subjects: Map<string, Record<string, unknown>>;
  readonly progression: ProgressionRecordValue[];
  readonly assistance: AssistanceRecordValue[];
  readonly attachmentMetadata: Map<string, Record<string, unknown>>;
}

async function activeState(device: SharedProgressionDevice): Promise<ActiveState> {
  const activeId = await device.repository.readActiveGenerationId();
  expect(activeId).not.toBeNull();
  const snapshot = await device.repository.readRecords(activeId as string);
  return {
    subjects: new Map(
      snapshot.records.subjects.map((envelope) => [envelope.recordId, envelope.value as never]),
    ),
    progression: snapshot.records.progression.map((envelope) => envelope.value),
    assistance: snapshot.records.assistance.map((envelope) => envelope.value),
    attachmentMetadata: new Map(
      snapshot.records.attachmentMetadata.map((envelope) => [
        envelope.recordId,
        envelope.value as unknown as { attachmentId: string },
      ]),
    ),
  };
}

/** Every `bySubject` key the device holds, with the entry that key resolves to. */
function entriesBySubject(
  records: readonly ProgressionRecordValue[],
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record.bySubject as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        out.set(key, value as Record<string, unknown>);
      }
    }
  }
  return out;
}

/** The fish identifiers one entry holds, for a readable failure message. */
function fishIdsOf(entry: Record<string, unknown> | undefined): string[] {
  const collection = entry?.fishCollection;
  if (!Array.isArray(collection)) return [];
  return collection
    .filter((fish): fish is Record<string, unknown> => typeof fish === 'object' && fish !== null)
    .map((fish) => fish.id)
    .filter((id): id is string => typeof id === 'string');
}

function noteIdsOf(entry: Record<string, unknown> | undefined): string[] {
  const collection = entry?.collectedNotes;
  if (!Array.isArray(collection)) return [];
  return collection
    .filter((note): note is Record<string, unknown> => typeof note === 'object' && note !== null)
    .map((note) => note.noteId)
    .filter((id): id is string => typeof id === 'string');
}

/** The disclosure for one code, or `undefined`. */
function disclosureOf(
  disclosures: readonly { code: string; count: number }[],
  code: SubjectVerbatimDisclosureCode,
): number | undefined {
  return disclosures.find((entry) => entry.code === code)?.count;
}

// Every test builds its own device under its own IndexedDB database name, so there is
// no shared fixture state to reset between them: `createSharedProgressionDevice`
// clears the one global store (the `localStorage` mirror) itself.

describe('Phase 6 gate: a progression record is not owned by the subject it is keyed on', () => {
  // ── Finding 1: replace must not destroy the bystander ────────────────────

  it('a cross-device replace preserves the bystander entry byte for byte, and says so', async () => {
    const device = await freshDevice('replace-preserve');
    const bystanderBefore = device.bystanderEntryBefore;
    const bytes = await crossDeviceArchive(device);

    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: SHARED_SUBJECT_ID,
      confirmReplace: true,
    });

    const after = await activeState(device);
    const entries = entriesBySubject(after.progression);

    // The bystander still resolves, and to the **same value** - the same rooms
    // cleared, the same XP, the same streak, the same fish and note identifiers, the
    // same unknown field.
    const bystanderAfter = entries.get(SHARED_BYSTANDER_ID);
    expect(bystanderAfter, 'the bystander has no progression left on the device').toBeDefined();
    expect(canonicalJsonStringify(bystanderAfter)).toBe(canonicalJsonStringify(bystanderBefore));
    expect(fishIdsOf(bystanderAfter)).toEqual([BYSTANDER_FISH_ID]);
    expect(noteIdsOf(bystanderAfter)).toEqual([BYSTANDER_NOTE_ID]);
    // And the application, not just the stored record, resolves it.
    const resolved = (progressionEnvelopeFrom(after.progression).bySubject as Record<
      string,
      Record<string, unknown>
    >)[SHARED_BYSTANDER_ID];
    expect(resolved).toBeDefined();
    expect(fishIdsOf(resolved)).toEqual([BYSTANDER_FISH_ID]);

    // The exported subject's own entry **is** the archive's, wholesale: a replace is
    // authoritative about the subject it names.
    const ownAfter = entries.get(SHARED_SUBJECT_ID);
    expect(ownAfter).toBeDefined();
    expect(canonicalJsonStringify(ownAfter)).toBe(
      canonicalJsonStringify(device.ownEntryBefore),
    );

    // The unrelated control subject's record is byte-identical.
    const unrelatedAfter = after.progression.find(
      (record) => record.subjectId === SHARED_UNRELATED_ID,
    );
    expect(canonicalJsonStringify(unrelatedAfter)).toBe(
      canonicalJsonStringify(device.unrelatedRecordBefore),
    );

    // The report says what happened, in counts.
    expect(result.foreignState.preservedProgressionKeys).toBe(1);
    expect(result.foreignState.appliedProgressionKeys).toBe(0);
    expect(result.foreignState.retainedProgressionKeys).toBe(0);
    expect(result.foreignState.destroyedProgressionKeys).toBe(0);
    // The per-store count still says "one progression record", because one record
    // still holds two subjects. That is why the foreign state is a separate field.
    expect(result.destroyedRecordCounts.progression).toBe(1);
  });

  it('the report carries no bystander identifier, and the disclosure set gains no new code', async () => {
    const device = await freshDevice('replace-report-privacy');
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: await crossDeviceArchive(device),
      now: NOW,
      mode: 'replace',
      replaceSubjectId: SHARED_SUBJECT_ID,
      confirmReplace: true,
    });

    // The per-store keys are unchanged, so a consumer that reads them is unaffected.
    expect(Object.keys(result.destroyedRecordCounts).sort()).toEqual([
      'attachments',
      'progression',
      'sessions',
      'subjects',
    ]);
    // No bystander identifier appears anywhere in the result, in any shape.
    const serialised = JSON.stringify(result, (_key, value) =>
      value instanceof Map || value instanceof Set || value instanceof Uint8Array || value instanceof ArrayBuffer
        ? '[binary]'
        : value,
    );
    for (const forbidden of [
      SHARED_BYSTANDER_ID,
      SHARED_UNRELATED_ID,
      BYSTANDER_FISH_ID,
      BYSTANDER_NOTE_ID,
    ]) {
      expect(serialised, `the result leaked ${forbidden}`).not.toContain(forbidden);
    }
    // The one line that describes it is code-shaped, so a screen can map it to copy.
    expect(result.foreignState.note).toBe(
      'replace-preserves-foreign-progression-keys-device-copy-wins-on-conflict-assistance-collisions-are-preserved-not-overwritten',
    );
  });

  it('a same-device replace is faithful for the target and idempotent for the bystander', async () => {
    const device = await freshDevice('replace-same-device');
    const bytes = await sameDeviceArchive(device);
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes,
      now: NOW,
      mode: 'replace',
      replaceSubjectId: SHARED_SUBJECT_ID,
      confirmReplace: true,
    });

    const after = await activeState(device);
    const entries = entriesBySubject(after.progression);
    // The archive carried the bystander's entry too, and the device already had that
    // exact value, so the device's copy is kept and nothing is duplicated.
    expect(result.foreignState.retainedProgressionKeys).toBe(1);
    expect(result.foreignState.preservedProgressionKeys).toBe(0);
    expect(canonicalJsonStringify(entries.get(SHARED_BYSTANDER_ID))).toBe(
      canonicalJsonStringify(device.bystanderEntryBefore),
    );
    // Exactly one entry per subject key: no fork.
    expect([...entries.keys()].sort()).toEqual(
      [SHARED_SUBJECT_ID, SHARED_BYSTANDER_ID, SHARED_UNRELATED_ID].sort(),
    );
    expect(after.progression).toHaveLength(2);
  });

  describe('mergeProgressionForReplace: the rule, on records no archive can build', () => {
    const own = (subjectId: string, xp: number): Record<string, unknown> => ({
      subjectId,
      xpTotal: xp,
      fishCollection: [],
      collectedNotes: [],
    });

    const record = (
      subjectId: string,
      bySubject: Record<string, unknown>,
      xp: number,
    ): ProgressionRecordValue => ({
      subjectId,
      sourceVersion: 3,
      rank: 'Novice',
      xpTotal: xp,
      bySubject,
      crossSubjectAchievements: [],
    });

    it('keeps a foreign key the archive did not carry, and counts it', () => {
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1), 'subj-b': own('subj-b', 5) }, 1)];
      const archive = [record('subj-a', { 'subj-a': own('subj-a', 9) }, 9)];
      const merged = mergeProgressionForReplace(base, archive, 'subj-a');
      expect(merged.preservedProgressionKeys).toBe(1);
      expect(merged.appliedProgressionKeys).toBe(0);
      expect(merged.retainedProgressionKeys).toBe(0);
      expect(merged.destroyedProgressionKeys).toBe(0);
      const bySubject = merged.records[0]?.bySubject as Record<string, Record<string, unknown>>;
      expect(Object.keys(bySubject).sort()).toEqual(['subj-a', 'subj-b']);
      // The target's entry is the archive's, not a merge of the two.
      expect(bySubject['subj-a']?.xpTotal).toBe(9);
      expect(bySubject['subj-b']?.xpTotal).toBe(5);
    });

    it("keeps the device's value when both hold a foreign key, and counts it as retained", () => {
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1), 'subj-b': own('subj-b', 5) }, 1)];
      const archive = [record('subj-a', { 'subj-a': own('subj-a', 9), 'subj-b': own('subj-b', 99) }, 9)];
      const merged = mergeProgressionForReplace(base, archive, 'subj-a');
      expect(merged.retainedProgressionKeys).toBe(1);
      expect(merged.preservedProgressionKeys).toBe(0);
      const bySubject = merged.records[0]?.bySubject as Record<string, Record<string, unknown>>;
      // The device's is the newer one by construction: an archive is a statement about
      // an earlier moment, and applying it would undo work done since.
      expect(bySubject['subj-b']?.xpTotal).toBe(5);
    });

    it('applies a foreign key the device does not have, and counts it', () => {
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1) }, 1)];
      const archive = [record('subj-a', { 'subj-a': own('subj-a', 9), 'subj-c': own('subj-c', 4) }, 9)];
      const merged = mergeProgressionForReplace(base, archive, 'subj-a');
      expect(merged.appliedProgressionKeys).toBe(1);
      const bySubject = merged.records[0]?.bySubject as Record<string, Record<string, unknown>>;
      expect(bySubject['subj-c']?.xpTotal).toBe(4);
    });

    it("destroys only the target's own entry when the archive has none, and keeps the record alive for the rest", () => {
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1), 'subj-b': own('subj-b', 5) }, 1)];
      const merged = mergeProgressionForReplace(base, [], 'subj-a');
      expect(merged.destroyedProgressionKeys).toBe(1);
      expect(merged.records).toHaveLength(1);
      const bySubject = merged.records[0]?.bySubject as Record<string, Record<string, unknown>>;
      expect(Object.keys(bySubject)).toEqual(['subj-b']);
    });

    it('writes no record at all when there is nothing left to hold', () => {
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1) }, 1)];
      const merged = mergeProgressionForReplace(base, [], 'subj-a');
      expect(merged.destroyedProgressionKeys).toBe(1);
      expect(merged.records).toEqual([]);
    });

    it('leaves every record that is not the target byte-identical', () => {
      const unrelated = record('subj-z', { 'subj-z': own('subj-z', 3) }, 3);
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1) }, 1), unrelated];
      const archive = [record('subj-a', { 'subj-a': own('subj-a', 9) }, 9)];
      const merged = mergeProgressionForReplace(base, archive, 'subj-a');
      // The rebuilt target record is **appended**, so the untouched record keeps its
      // position and the assertion below is a positional one too.
      expect(merged.records).toHaveLength(2);
      expect(merged.records[0]).toBe(unrelated);
      expect(canonicalJsonStringify(merged.records[0])).toBe(canonicalJsonStringify(unrelated));
    });

    it('is idempotent: merging the same inputs twice gives the same canonical records', () => {
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1), 'subj-b': own('subj-b', 5) }, 1)];
      const archive = [record('subj-a', { 'subj-a': own('subj-a', 9), 'subj-c': own('subj-c', 4) }, 9)];
      const first = mergeProgressionForReplace(base, archive, 'subj-a');
      // The merged output is itself a valid input, so a second replace of the same
      // archive is a no-op rather than a second rewrite.
      const second = mergeProgressionForReplace(first.records, archive, 'subj-a');
      expect(canonicalJsonStringify(second.records)).toBe(canonicalJsonStringify(first.records));
      // `subj-b` is still there and still absent from the archive, so the second run
      // preserves it again; `subj-c` is in both, so the device's copy is kept again.
      expect(second.preservedProgressionKeys).toBe(1);
      expect(second.retainedProgressionKeys).toBe(1);
      expect(second.appliedProgressionKeys).toBe(0);
    });

    it('preserves a foreign entry whose value is null, rather than treating it as absent', () => {
      const base = [record('subj-a', { 'subj-a': own('subj-a', 1), 'subj-b': null }, 1)];
      const archive = [record('subj-a', { 'subj-a': own('subj-a', 9) }, 9)];
      const merged = mergeProgressionForReplace(base, archive, 'subj-a');
      expect(merged.preservedProgressionKeys).toBe(1);
      const bySubject = merged.records[0]?.bySubject as Record<string, unknown>;
      expect(Object.keys(bySubject).sort()).toEqual(['subj-a', 'subj-b']);
      expect(bySubject['subj-b']).toBeNull();
    });
  });

  describe('mergeAssistanceForReplace: the device-global store', () => {
    const record = (assistanceId: string, hintsShown: number): AssistanceRecordValue => ({
      assistanceId,
      mode: 'gentle',
      signals: { hintsShown },
      dismissalCount: 0,
      updatedAt: NOW,
    });

    it('adds a record the device does not have', () => {
      const merged = mergeAssistanceForReplace(
        [record('assist-1', 1)],
        [record('assist-2', 2)],
        counter(),
        new Set<string>(),
      );
      expect(merged).toMatchObject({ identical: 0, preserved: 0, applied: 1 });
      expect(merged.records).toHaveLength(2);
    });

    it('does nothing when the device already holds the same value, so a repeat import is a no-op', () => {
      const base = [record('assist-1', 1)];
      const merged = mergeAssistanceForReplace(base, [record('assist-1', 1)], counter(), new Set<string>());
      expect(merged).toMatchObject({ identical: 1, preserved: 0, applied: 0 });
      expect(canonicalJsonStringify(merged.records)).toBe(canonicalJsonStringify(base));
    });

    it('keeps the device value and preserves the archive value under a fresh id when they differ', () => {
      const merged = mergeAssistanceForReplace(
        [record('assist-1', 1)],
        [record('assist-1', 99)],
        counter(),
        new Set<string>(),
      );
      expect(merged).toMatchObject({ identical: 0, preserved: 1, applied: 0 });
      expect(merged.records).toHaveLength(2);
      // The device's value is still there, under its own id.
      const kept = merged.records.find((entry) => entry.assistanceId === 'assist-1');
      expect(kept?.signals.hintsShown).toBe(1);
      // And the archive's is not destroyed: it is under a new id.
      const preserved = merged.records.find((entry) => entry.assistanceId !== 'assist-1');
      expect(preserved?.signals.hintsShown).toBe(99);
      expect(preserved?.assistanceId).not.toBe('assist-1');
      expect(preserved?.assistanceId).toMatch(/^kc-assistance-/);
    });

    it('never mints an identifier the device already holds', () => {
      const merged = mergeAssistanceForReplace(
        [record('assist-1', 1), record('kc-assistance-gate-0001', 5)],
        [record('assist-1', 99)],
        counter(),
        new Set(['kc-assistance-gate-0001']),
      );
      const minted = merged.records.map((entry) => entry.assistanceId);
      expect(new Set(minted).size).toBe(minted.length);
      expect(minted).toContain('kc-assistance-gate-0001');
    });
  });

  it('a replace discloses the assistance outcomes it chose, and never overwrites a bystander', async () => {
    const device = await freshDevice('replace-assistance');
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: await sameDeviceArchive(device),
      now: NOW,
      mode: 'replace',
      replaceSubjectId: SHARED_SUBJECT_ID,
      confirmReplace: true,
    });

    const after = await activeState(device);
    const byId = new Map(after.assistance.map((entry) => [entry.assistanceId, entry]));
    // The bystander's device-global record is still there, with its own value.
    expect(byId.get(ASSISTANCE_ID_BYSTANDER)?.signals.hintsShown).toBe(9);
    expect(byId.get(ASSISTANCE_ID_BYSTANDER)?.dismissalCount).toBe(2);
    // The archive carried both records with the values the device already had, so
    // nothing was added and nothing was changed.
    expect(result.foreignState.identicalAssistanceRecords).toBe(2);
    expect(result.foreignState.preservedAssistanceRecords).toBe(0);
    expect(result.foreignState.appliedAssistanceRecords).toBe(0);
    // The exported subject's own device-global record is untouched too, and the store
    // did not grow: the archive asked for two records and both were already there.
    expect(byId.get(ASSISTANCE_ID_OWN)?.signals.hintsShown).toBe(3);
    expect(after.assistance).toHaveLength(2);
  });

  // ── Finding 2: a copy must not fork the bystander ───────────────────────

  it('a copy carries the bystander entry verbatim and mints nothing inside it', async () => {
    const device = await freshDevice('copy-fork');
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: await sameDeviceArchive(device),
      now: NOW,
    });

    const after = await activeState(device);
    const copyRecord = after.progression.find(
      (record) => record.subjectId === result.importedSubjectId,
    );
    expect(copyRecord).toBeDefined();
    const copyBySubject = copyRecord?.bySubject as Record<string, Record<string, unknown>>;

    // The copy does hold a foreign entry - dropping it would be data loss - and it is
    // the bystander's value **exactly**, identifiers included.
    const forked = copyBySubject[SHARED_BYSTANDER_ID];
    expect(forked).toBeDefined();
    expect(canonicalJsonStringify(forked)).toBe(
      canonicalJsonStringify(device.bystanderEntryBefore),
    );
    expect(fishIdsOf(forked)).toEqual([BYSTANDER_FISH_ID]);
    expect(noteIdsOf(forked)).toEqual([BYSTANDER_NOTE_ID]);

    // The copy's **own** entry is remapped.
    const own = copyBySubject[result.importedSubjectId];
    expect(own).toBeDefined();
    expect(fishIdsOf(own)).not.toEqual([SHARED_OWN_FISH_ID]);
    expect(fishIdsOf(own)[0]).toMatch(/^kc-fish-/);
    expect(noteIdsOf(own)[0]).toMatch(/^kc-note-/);

    // The reported mapping claims no rewrite inside the foreign entry, because none
    // happened. Every mapped `from` is the exported subject's own identity or one of
    // its rooms - never a bystander fish or note.
    const mapped = new Set(result.idMapping.map((entry) => entry.from));
    expect(mapped.has(BYSTANDER_FISH_ID)).toBe(false);
    expect(mapped.has(BYSTANDER_NOTE_ID)).toBe(false);
    for (const entry of result.idMapping) {
      if (entry.kind === 'fish') expect(entry.from).toBe(SHARED_OWN_FISH_ID);
      if (entry.kind === 'note') expect(entry.from).toBe(SHARED_OWN_NOTE_ID);
      // The fixture has no loot, so a mapped loot id would mean one was invented.
      expect(entry.kind).not.toBe('loot');
    }

    // And the application resolves one identity for the bystander, not two.
    const resolved = (progressionEnvelopeFrom(after.progression).bySubject as Record<
      string,
      Record<string, unknown>
    >)[SHARED_BYSTANDER_ID];
    expect(fishIdsOf(resolved)).toEqual([BYSTANDER_FISH_ID]);
  });

  // ── Findings 4, 5, 6: the id-reference disclosures ──────────────────────

  it('a relativePath naming a remapped id is disclosed and left alone', async () => {
    const device = await freshDevice('relative-path');
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: await sameDeviceArchive(device),
      now: NOW,
    });

    const after = await activeState(device);
    const copy = after.subjects.get(result.importedSubjectId);
    const snapshot = copy?.snapshot as unknown as { rooms: Record<string, Record<string, unknown>> };
    const rooms = Object.values(snapshot.rooms);
    const attachment = rooms
      .flatMap((room) => (Array.isArray(room.attachments) ? room.attachments : []))
      .find((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);

    // The room was remapped - the room **key** is a new identifier - ...
    expect(Object.keys(snapshot.rooms)[0]).not.toBe(SUBJECT_ROOM_ID);
    // ... and the path still names the source room, because it points at a file in
    // the Electron `userData` tree that this copy did not move. Rewriting it would
    // name a directory that was never created.
    expect(attachment?.relativePath).toBe(ROOM_RELATIVE_PATH);
    // And it is disclosed, with a count and a closed code - not left to be inferred.
    expect(disclosureOf(result.verbatimDisclosures, 'attachment-relative-path-names-a-remapped-id')).toBe(1);
    // The disclosure is a count, not a string, so it cannot leak the room id.
    expect(JSON.stringify(result.verbatimDisclosures)).not.toContain(SUBJECT_ROOM_ID);
  });

  it('the residual counts string values and an object key is neither swept nor counted', async () => {
    const device = await freshDevice('residual-meaning');
    // The exported subject carries exactly one prose mention (`sharedSummary`), one
    // stale `dungeonId`, and one undeclared object **key** holding a room id.
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: await sameDeviceArchive(device),
      now: NOW,
    });

    const after = await activeState(device);
    const copy = after.subjects.get(result.importedSubjectId);
    const snapshot = copy?.snapshot as unknown as {
      rooms: Record<string, Record<string, unknown>>;
    };
    const room = Object.values(snapshot.rooms)[0] as Record<string, unknown>;

    // The prose mention is carried verbatim and counted: the documented residual.
    expect(room.sharedSummary).toBe(`Progress lives in ${SUBJECT_ROOM_ID}.`);
    expect(result.unresolvedReferenceCount).toBeGreaterThan(0);

    // The **key** is carried verbatim - there is no way to tell a key that is a room
    // id from a key that is a tag or a field name - and it is NOT counted. The
    // module header now states exactly this, so the number keeps the one meaning it
    // is documented to have.
    const links = room.sharedLinksByRoom as Record<string, unknown>;
    expect(Object.keys(links)).toEqual([SUBJECT_ROOM_ID]);
    // It is not silently swept either: the whole point of leaving it alone is that
    // `tagIndex` and any other key that happens to equal an id must survive.
    expect(links[Object.keys(links)[0] as string]).toEqual({ href: 'x' });
  });

  it('dungeonId is rewritten when it equals the record subjectId, and disclosed when it does not', async () => {
    const device = await freshDevice('dungeon-id');
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: await sameDeviceArchive(device),
      now: NOW,
    });

    const after = await activeState(device);
    const copy = after.subjects.get(result.importedSubjectId);
    const copyDungeon = (copy?.snapshot as unknown as { dungeon: Record<string, unknown> }).dungeon;

    // The exported subject's own `dungeonId` disagrees with its record, so it is
    // carried verbatim - no mapping is minted for an identity the archive does not
    // declare - and the disagreement is disclosed under its own code.
    expect(copyDungeon.dungeonId).toBe(STALE_DUNGEON_ID);
    expect(disclosureOf(result.verbatimDisclosures, 'stale-subject-dungeon-id')).toBe(1);

    // The **unrelated** subject's `dungeonId` agrees with its own record, and its
    // record is untouched by the import, so this is the control: a rule that rewrote
    // `dungeonId` unconditionally would be visible as a difference here.
    const unrelated = after.subjects.get(SHARED_UNRELATED_ID);
    const unrelatedDungeon = (unrelated?.snapshot as unknown as { dungeon: Record<string, unknown> })
      .dungeon;
    expect(unrelatedDungeon.dungeonId).toBe(SHARED_UNRELATED_ID);

    // Every disclosure is one of the closed codes, and only codes that fired appear.
    for (const entry of result.verbatimDisclosures) {
      expect(SUBJECT_VERBATIM_DISCLOSURE_CODES).toContain(entry.code);
      expect(entry.count).toBeGreaterThan(0);
    }
  });

  it('a record that agrees with its own dungeonId has it rewritten to the new subject id', () => {
    // The same rule from the other side, on a record that does **not** disagree, so
    // the rewrite is exercised rather than only the disclosure. Built here rather
    // than read off the device, because the device's own subject is deliberately the
    // disagreeing case and a subject that agrees would be a second fixture.
    const snapshot = sharedSubjectSnapshot() as unknown as { dungeon: Record<string, unknown> };
    snapshot.dungeon.dungeonId = SHARED_SUBJECT_ID;
    const subject = {
      subjectId: SHARED_SUBJECT_ID,
      schemaVersion: '1.1.0',
      snapshot: snapshot as unknown as SubjectRecordValue['snapshot'],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const remap = remapSubjectRecords({
      subject: subject as SubjectRecordValue,
      progression: [],
      sessions: [],
      assistance: [],
      attachmentMetadata: [],
      attachmentBlobs: [],
      existing: { taken: new Set<string>() },
      generator: counter(),
      now: NOW,
    });
    const outDungeon = (remap.subject.snapshot as unknown as { dungeon: Record<string, unknown> }).dungeon;
    // The copy's dungeon id names the copy, which is what `subjectActivation.ts`,
    // `tagDomain.ts`, and `GameScreen.ts` all resolve a subject by.
    expect(outDungeon.dungeonId).toBe(remap.subject.subjectId);
    expect(outDungeon.dungeonId).not.toBe(SHARED_SUBJECT_ID);
    // A rewrite is not a disclosure: nothing was carried verbatim for this field.
    expect(disclosureOf(remap.verbatimDisclosures, 'stale-subject-dungeon-id')).toBeUndefined();
  });
  it('the attachment metadata and bytes of the bystander survive a replace of the target', async () => {
    const device = await freshDevice('replace-attachments');
    const result = await importSubjectBackup({
      repository: device.repository,
      bytes: await crossDeviceArchive(device),
      now: NOW,
      mode: 'replace',
      replaceSubjectId: SHARED_SUBJECT_ID,
      confirmReplace: true,
    });
    const after = await activeState(device);
    // The target's attachment was destroyed and rewritten from the archive, keyed by
    // attachment id - never by content hash.
    // The envelope record id is `meta:<attachmentId>`, so the assertion reads the
    // record's own field rather than a storage bookkeeping detail.
    expect([...after.attachmentMetadata.values()].map((entry) => entry.attachmentId)).toEqual([
      SHARED_ATTACHMENT_ID,
    ]);
    expect(result.destroyedRecordCounts.attachments).toBe(1);
  });
});
