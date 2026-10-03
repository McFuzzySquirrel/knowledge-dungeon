/**
 * QA's independent probe of the data/migration claim for the room-clear reward ledger.
 *
 * ## The claim under test
 *
 * `src/core/progression/roomClearRewards.ts` stores its ledger in the canonical progression
 * record's preserved `extraFields` under `roomClearRewardLedger`, and claims:
 *
 * - no canonical-progression version bump, and **no change** to
 *   `src/core/progression/canonicalProgression.ts` or
 *   `src/services/persistence/v2/validation.ts`;
 * - the subject schema stays `1.1.0`;
 * - a ledger-bearing record round-trips through the **full-device** `.kdbak` product;
 * - it round-trips through the **subject** `.kdsubject` product, including subject-copy id
 *   remapping;
 * - storage-v2 validation accepts it;
 * - the blank `.kdtemplate` product correctly does **not** carry it.
 *
 * ## Why this file exists when `tests/unit/roomClearRewards.test.ts` already says most of it
 *
 * Two of those six are asserted there in a way that cannot fail:
 *
 * - **The template claim.** That test stringifies a *hand-written literal* template document
 *   and asserts the literal does not contain the ledger key - a tautology - and then calls
 *   `canonicalProgressionToRecord`, which is the legacy mirror flattener, not the template
 *   product. The real `exportSubjectTemplate` is never invoked, so "the blank `.kdtemplate`
 *   correctly does not carry the ledger" is not currently tested at all. It is asserted
 *   properly here, on the real product's output, for a snapshot that *does* carry a ledger.
 * - **The `.kdsubject` claim.** No test in the repository carries a ledger-bearing record
 *   through `exportSubjectBackup` / `importSubjectBackup`, so "subject-copy ID remapping
 *   rewrites this subject's whole `bySubject` subtree, so a copy carries the awarded-once
 *   history" is an argument, not a result. It is measured here on a real copy into a
 *   destination with **different** subject ids, which is the case that would break if the
 *   ledger were keyed by anything but the room.
 *
 * The device is built through `tests/phase6/support/forge`, the repository's own real-path
 * device builder (`openStorageV2Repository` → `stageGeneration` → `activateGeneration`), so
 * the product is measured against a real storage-v2 generation rather than a mock. The
 * IndexedDB substrate is `fake-indexeddb`; **that limit is stated in the report, not hidden:
 * no browser evidence is claimed here.**
 *
 * The untouched-file claim is verified with `git status`, not with a test, and is reported in
 * the QA notes rather than asserted here.
 */
import { afterEach, describe, expect, it } from 'vitest';

import 'fake-indexeddb/auto';

import {
  ROOM_CLEAR_REWARD_LEDGER_KEY,
  decideRoomClearReward,
  readRoomClearRewardLedgerFromFields,
  writeRoomClearRewardLedgerToFields,
} from '@/core/progression/roomClearRewards';
import { CURRENT_SCHEMA_VERSION } from '@/core/validation/persistence';
import {
  exportSubjectBackup,
  importSubjectBackup,
} from '@/services/persistence/products/subjectBackup';
import { exportSubjectTemplate } from '@/services/persistence/products/subjectTemplate';
import { validateProgressionRecord } from '@/services/persistence/v2/validation';
import {
  ALPHA,
  R_ROOT,
  forgeDevice,
  readActiveValues,
  type ForgedDevice,
} from '../phase6/support/forge';
import type { ProgressionRecordValue } from '@/services/persistence/v2/schema';

const NOW = '2026-03-04T05:06:07.000Z';
const AWARDED_AT = '2026-02-28T11:22:33.000Z';
const CLEAR_IDENTITY = 'clear-1a2b3c4d';

/** A ledger with one real entry, minted through the decision function. */
function ledgerFields(): Record<string, unknown> {
  return writeRoomClearRewardLedgerToFields(
    undefined,
    decideRoomClearReward({
      extraFields: undefined,
      roomId: R_ROOT,
      clearIdentity: CLEAR_IDENTITY,
      awardedAt: AWARDED_AT,
    }).ledger,
  );
}

const EXPECTED_ENTRY = {
  roomId: R_ROOT,
  clearIdentity: CLEAR_IDENTITY,
  awardedAt: AWARDED_AT,
};

/** Fields of a record's `bySubject[subjectId]`, or `undefined`. */
function preservedFieldsOf(
  bySubject: unknown,
  subjectId: string,
): Record<string, unknown> | undefined {
  if (typeof bySubject !== 'object' || bySubject === null) return undefined;
  const record = (bySubject as Record<string, unknown>)[subjectId];
  if (typeof record !== 'object' || record === null) return undefined;
  return (record as { extraFields?: Record<string, unknown> }).extraFields;
}

/**
 * A forged device whose alpha progression record carries the ledger.
 *
 * The device is forged *without* the ledger and the ledger is added by staging a second
 * generation, so the product is asked to move a real record rather than to read a fixture
 * that was shaped to be convenient.
 */
async function forgeLedgerDevice(): Promise<{ device: ForgedDevice; generationId: string }> {
  const device = await forgeDevice({ isolateProgression: true });
  const values = await readActiveValues(device);
  const progression = values.progression.map((record) =>
    record.subjectId === ALPHA
      ? ({
          ...record,
          bySubject: {
            ...(record.bySubject as Record<string, unknown>),
            [ALPHA]: {
              ...(preservedFieldsOf(record.bySubject, ALPHA) === undefined
                ? {}
                : (record.bySubject as Record<string, Record<string, unknown>>)[ALPHA]),
              extraFields: ledgerFields(),
            },
          },
        } as ProgressionRecordValue)
      : record,
  );

  const generationId = 'qa-ledger-active-0002';
  await device.repository.stageGeneration({
    generationId,
    source: 'legacy-migration',
    parentGenerationId: device.generationId,
    // The receipt forged for the previous generation names that generation, so a second
    // generation carries none rather than a stale receipt.
    records: { ...values, progression, migrationReceipts: [] },
  });
  await device.repository.activateGeneration(generationId);
  const validation = await device.repository.validateGeneration(generationId);
  if (!validation.ok) {
    throw new Error(
      `the ledger-bearing generation does not validate: ${validation.problems
        .map((problem) => `${problem.severity}:${problem.scope}:${problem.code}:${problem.count}`)
        .join(',')}`,
    );
  }
  // The *new* generation is the one that carries the ledger; the export is asked for it by id.
  return { device, generationId };
}

const OPEN: ForgedDevice[] = [];

afterEach(() => {
  for (const device of OPEN.splice(0)) device.repository.close();
});

describe('the ledger-bearing progression record: storage-v2 validation', () => {
  it('is accepted with no problems, and the subject schema is untouched at 1.1.0', () => {
    const record = {
      subjectId: ALPHA,
      sourceVersion: 3 as const,
      rank: 'Novice' as const,
      xpTotal: 120,
      bySubject: {
        [ALPHA]: {
          xpTotal: 120,
          rank: 'Novice' as const,
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 1,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [],
          extraFields: ledgerFields(),
        },
      },
      crossSubjectAchievements: [],
    };
    expect(validateProgressionRecord(record).problems).toEqual([]);
    expect(CURRENT_SCHEMA_VERSION).toBe('1.1.0');
  });

  it('reads its own entry back out of the preserved fields', () => {
    expect(readRoomClearRewardLedgerFromFields(ledgerFields()).entries).toEqual([
      EXPECTED_ENTRY,
    ]);
  });
});

describe('the ledger-bearing progression record: the subject .kdsubject product', () => {
  it('is in the generation before the product is asked to carry it', async () => {
    const { device } = await forgeLedgerDevice();
    OPEN.push(device);
    const values = await readActiveValues(device);
    const record = values.progression.find((entry) => entry.subjectId === ALPHA);
    expect(
      readRoomClearRewardLedgerFromFields(preservedFieldsOf(record?.bySubject, ALPHA)).entries,
    ).toEqual([EXPECTED_ENTRY]);
  });

  it('survives export and a subject-copy import onto a differently-keyed destination', async () => {
    const { device, generationId } = await forgeLedgerDevice();
    OPEN.push(device);
    const exported = await exportSubjectBackup({
      repository: device.repository,
      generationId,
      subjectId: ALPHA,
      now: NOW,
    });

    // A *fresh* device, so the copy has to mint ids that are not ALPHA's.
    const destination = await forgeLedgerDevice();
    OPEN.push(destination.device);
    const imported = await importSubjectBackup({
      repository: destination.device.repository,
      bytes: exported.bytes,
      now: NOW,
      mode: 'copy',
    });
    expect(imported.mode).toBe('copy');
    expect(imported.replacedSubjectId).toBeNull();
    // The product reports the fresh id it minted, and it is genuinely not the source's.
    // This is the case that rewrites the whole `bySubject` subtree.
    const copiedSubjectId = imported.importedSubjectId;
    expect(copiedSubjectId).not.toBe(ALPHA);
    expect(imported.identifiersRemapped).toBeGreaterThan(0);

    const after = await readActiveValues(destination.device);
    expect(after.subjects.some((entry) => entry.subjectId === copiedSubjectId)).toBe(true);

    const copiedProgression = after.progression.find(
      (entry) =>
        readRoomClearRewardLedgerFromFields(preservedFieldsOf(entry.bySubject, copiedSubjectId))
          .entries.length > 0,
    );
    expect(copiedProgression, 'no progression record in the copy carries the ledger').toBeDefined();
    // The copy's ledger is keyed by the *copied* subject's room ids, which is the only
    // correct answer: a ledger keyed by the source's room ids would never match anything in
    // the copy, and every room in it would be re-clearable. So this asserts survival *and*
    // correct remapping, and pins which of the two it got.
    const copiedEntries = readRoomClearRewardLedgerFromFields(
      preservedFieldsOf(copiedProgression!.bySubject, copiedSubjectId),
    ).entries;
    expect(copiedEntries).toHaveLength(1);
    expect(copiedEntries[0]?.clearIdentity).toBe(CLEAR_IDENTITY);
    expect(copiedEntries[0]?.awardedAt).toBe(AWARDED_AT);
    expect(copiedEntries[0]?.roomId).not.toBe(R_ROOT);
    // ...and it names a room that actually exists in the copied subject.
    const copiedSubject = after.subjects.find((entry) => entry.subjectId === copiedSubjectId);
    const copiedRooms = Object.keys(
      (copiedSubject?.snapshot as unknown as { rooms?: Record<string, unknown> }).rooms ?? {},
    );
    expect(copiedRooms).toContain(copiedEntries[0]?.roomId);
    // The ledger's own record still carries only app-minted ids and an opaque digest.
    expect(copiedProgression!.subjectId).not.toBe(ALPHA);
  });
});

describe('the ledger-bearing progression record: the blank .kdtemplate product', () => {
  it('is absent from a real template export of a snapshot that carries a ledger', () => {
    // The real product, on a real snapshot. This is the assertion
    // `tests/unit/roomClearRewards.test.ts` stands in for with a string literal.
    const deviceRoom = R_ROOT;
    const snapshot = {
      dungeon: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dungeonId: 'qa-template-subject',
        subjectName: 'Data Structures',
        rootRoomId: deviceRoom,
        createdAt: NOW,
        updatedAt: NOW,
        phaseState: 'ScribeActive',
        rooms: [{ roomId: deviceRoom, topic: 'Linked Lists', status: 'NotesDrafted' }],
        edges: [],
        progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
      },
      rooms: {
        [deviceRoom]: {
          roomId: deviceRoom,
          topic: 'Linked Lists',
          createdAt: NOW,
          updatedAt: NOW,
          state: 'NotesDrafted',
          noteText: '',
          artifactMarkdown: null,
          validationState: {
            wordCount: 0,
            requiredSectionsPresent: false,
            manualConfirmed: false,
            criterionScores: {},
            failedChecks: [],
            qualityBonus: 0,
            finalPass: false,
          },
          attachments: [],
          tags: [],
          extraFields: ledgerFields(),
        },
      },
    };

    const result = exportSubjectTemplate(snapshot as never, {
      now: NOW,
      name: 'QA template',
      approvedTags: ['linear'],
    });

    // The file is real: it names the product, the format, and the subject schema version,
    // which is how the "schema stays 1.1.0" claim is visible in the artifact itself.
    expect(result.template).toContain('"product":"kdtemplate"');
    expect(result.template).toContain('"subjectSchemaVersion":"1.1.0"');
    expect(result.roomCount).toBe(1);

    // The ledger, and everything in it, is absent.
    expect(result.template).not.toContain(ROOM_CLEAR_REWARD_LEDGER_KEY);
    expect(result.template).not.toContain(CLEAR_IDENTITY);
    expect(result.template).not.toContain(AWARDED_AT);
  });
});