/**
 * Exit criterion 1: no visible data loss in legacy fixtures.
 *
 * `src/services/persistence/v2/appState.ts` states the rule this file enforces:
 * the storage-v2 reader must produce the *same* in-memory state the legacy reader
 * produces, "otherwise 'the default `legacy` repository produces the exact same
 * in-memory state' would be a claim nothing enforces". So each hostile legacy
 * device below is read twice - once by the literal pre-phase reader
 * (`readAppStateFromLegacy`, the same keys, the same parsing, the same defaults)
 * and once by the storage-v2 reader after a real migration - and the two results
 * are compared field by field for every entity the exit criterion names.
 *
 * Nine attack shapes, all synthetic and self-describing:
 *
 * 1. a subject carrying unknown app-owned fields
 * 2. a corrupt JSON subject payload
 * 3. a subject index naming an id with no payload
 * 4. a payload with no index entry
 * 5. a subject with a local attachment whose bytes cannot be recovered
 * 6. a subject with an external attachment
 * 7. a v1 flat progression payload
 * 8. a v3 progression payload with unknown fields
 * 9. a deliberately truncated subject payload
 *
 * A tenth device combines all of them, because "one corrupt record among many"
 * is the realistic case and the one where a migration is most likely to drop
 * something a learner can see.
 *
 * ── Status: green. ──
 * Every case in the first block was red when this file was written, and each one
 * is now a regression test for the defect it reproduced.
 *
 * - `progressionEnvelopeFrom` (src/services/persistence/v2/appState.ts) built an
 *   envelope with no `version`, so `normalizeProgressionRecord` did not
 *   recognise its own `bySubject` map and filed the whole envelope as one flat
 *   record, losing every badge, XP total, and fish on every flagged-build reload.
 *   The envelope now carries the canonical version. See
 *   `flaggedBuildRoundTrip.test.ts` for the minimal reproduction and
 *   `phase4BrowserProbe.spec.ts` for the runtime witness.
 * - The migration carried a subject the *default* build could not see: a payload
 *   under `knowledge-dungeon:v1:subject:<id>` that the subject index did not
 *   name, so the flagged build showed it and a rollback build did not. The index
 *   is the application's subject list, so a payload it does not name is no longer
 *   a `subjects` record; it is preserved byte-for-byte as a recovery record and
 *   disclosed, and the two repositories agree.
 * - The two repositories hydrated shortcuts in different *orders*. The legacy
 *   reader keeps the persisted array order; `shortcutsFrom` sorts by `labelKey`.
 *   `setShortcutKey` is index-based and the settings list is rendered in store
 *   order, so index 1 binds a different action before and after a reload in the
 *   flagged build. See `flaggedBuildRoundTrip.test.ts`.
 *
 * The one divergence that is *not* a defect: a session record whose stored
 * `subjectName` disagrees with its subject's real name reads as the subject's
 * name in the flagged build and as the stored name in the default one. The
 * storage-v2 reader deliberately derives it rather than keeping a second copy,
 * so the fixture here stores a name that agrees.
 *
 * Nothing else in this file fails. When the product is fixed, these turn green
 * with no edit here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUBJECT_ID,
  NOW,
  openRepo,
  dropRepo,
  syntheticSnapshot,
  legacyKeySet,
  PREFERENCES_KEY,
  SHORTCUTS_KEY,
  SESSIONS_KEY,
  PROGRESSION_KEY,
  SUBJECT_INDEX_KEY,
  ROOT_ROOM_ID,
} from './support/phase4Support';

import { migrateLegacyState } from '@/services/persistence/v2/migrations';
import {
  readAppStateFromLegacy,
  readAppStateFromStorageV2,
  type AppPersistedState,
} from '@/services/persistence/v2/appState';
import { resetRepositorySelection, selectStorageV2Repository } from '@/services/persistence/v2/repositorySelection';
import { clearDualWriteReports } from '@/services/persistence/v2/dualWrite';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useShortcutStore } from '@/store/shortcutStore';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { SubjectSnapshot } from '@/core/validation/persistence';

type Database = Record<string, string>;

let repository: StorageV2Repository | null = null;
let name = '';

function write(keys: Database): void {
  window.localStorage.clear();
  for (const [key, value] of Object.entries(keys)) window.localStorage.setItem(key, value);
}

/** A complete legacy device with one subject and every supporting key. */
function healthyDevice(): Database {
  return {
    [SUBJECT_INDEX_KEY]: JSON.stringify([SUBJECT_ID]),
    [`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]: JSON.stringify(syntheticSnapshot()),
    'knowledge-dungeon:v1:activeSubjectId': SUBJECT_ID,
    [PROGRESSION_KEY]: JSON.stringify({
      version: 3,
      bySubject: {
        [SUBJECT_ID]: {
          xpTotal: 17,
          rank: 'Novice',
          badges: ['synthetic-qa-badge'],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 2,
          subjectsMastered: 0,
          roomsCleared: 3,
          reviewPasses: 0,
          artifacts: 1,
          bossesDefeated: 0,
          fishCollection: [{ id: 'fish-synthetic-1', name: 'Synthetic Trout', rarity: 'common', subjectId: SUBJECT_ID, subjectName: 'QA subject', caughtAt: '2026-02-01T00:00:00.000Z' }],
        },
      },
      crossSubjectAchievements: ['synthetic-cross-achievement'],
      // An unknown app-owned envelope field.
      futureEnvelopeField: { retained: true },
    }),
    [PREFERENCES_KEY]: JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'colorful', activeSpritePack: 'synthetic-pack' }),
    [SHORTCUTS_KEY]: JSON.stringify([
      { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: '/', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', defaultKey: 'm', key: 'v', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Info Panel', labelKey: 'shortcuts.toggleInfoPanel', defaultKey: 'i', key: 'i', ctrlKey: false, shiftKey: false },
    ]),
    // The session's stored `subjectName` matches the subject's real name, which
    // is what a real device holds: the storage-v2 reader *derives* the name from
    // the subject record rather than storing it twice, so a fixture that made
    // them disagree would be testing the fixture.
    [SESSIONS_KEY]: JSON.stringify([
      { sessionId: 'session-qa-1', startedAt: '2026-02-01T00:00:00.000Z', endedAt: '2026-02-01T00:30:00.000Z', subjectId: SUBJECT_ID, subjectName: 'Phase4 Independent Synthetic Subject', roomsVisited: [ROOT_ROOM_ID], notesSubmitted: 2, reviewsCompleted: 1, xpEarned: 17 },
    ]),
    'knowledge-dungeon:locale': 'en',
  };
}

function withRooms(subject: SubjectSnapshot, rooms: Record<string, unknown>): SubjectSnapshot {
  return { ...subject, rooms: { ...subject.rooms, ...rooms } } as SubjectSnapshot;
}

interface Case {
  readonly label: string;
  readonly keys: Database;
  /** What the migration must report, so a silent drop is caught as well as a wrong value. */
  readonly expectStatus: 'migrated' | 'recovery-required';
  readonly expectSubjectsInLegacyRead: number;
  readonly expectSubjectsInGeneration: number;
  readonly expectDisclosedProblemsAtLeast: number;
}

/** Every attack shape, including the combined device. */
function cases(): Case[] {
  const healthy = healthyDevice();

  const unknownFields = healthyDevice();
  const withUnknown = syntheticSnapshot({
    dungeon: { ...syntheticSnapshot().dungeon, qaUnknownField: 'retained', anotherUnknown: [1, 2, 3] },
  } as unknown as SubjectSnapshot);
  unknownFields[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] = JSON.stringify(withUnknown);

  const corruptJson = healthyDevice();
  corruptJson[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] = '{"dungeon":{"schemaVersion":"1.1.0",';

  const ghostIndex = healthyDevice();
  ghostIndex[SUBJECT_INDEX_KEY] = JSON.stringify([SUBJECT_ID, 'subject-qa-ghost-with-no-payload']);

  const orphanPayload = healthyDevice();
  orphanPayload[`knowledge-dungeon:v1:subject:subject-qa-orphan-payload`] = JSON.stringify(
    syntheticSnapshot({ dungeon: { ...syntheticSnapshot().dungeon, dungeonId: 'subject-qa-orphan-payload', subjectName: 'QA orphan payload subject' } } as unknown as SubjectSnapshot),
  );

  const unrecoverableAttachment = healthyDevice();
  const attachmentSubject = withRooms(syntheticSnapshot(), {
    [ROOT_ROOM_ID]: {
      ...(syntheticSnapshot().rooms[ROOT_ROOM_ID] as unknown as Record<string, unknown>),
      attachments: [
        {
          attachmentId: 'att-qa-unrecoverable',
          sourceType: 'local',
          fileName: 'qa-synthetic-historical-upload.png',
          mimeType: 'image/png',
          relativePath: 'uploads/qa-synthetic-historical-upload.png',
          altText: 'qa synthetic historical alt',
          addedAt: '2026-02-01T00:10:00.000Z',
        },
        {
          attachmentId: 'att-qa-external',
          sourceType: 'external',
          fileName: 'qa-synthetic-external.png',
          mimeType: 'image/png',
          externalUrl: 'https://example.invalid/qa-synthetic-external.png',
          altText: 'qa synthetic external alt',
          addedAt: '2026-02-01T00:11:00.000Z',
        },
      ],
    },
  });
  unrecoverableAttachment[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] = JSON.stringify(attachmentSubject);

  const v1Flat = healthyDevice();
  v1Flat[PROGRESSION_KEY] = JSON.stringify({
    xpTotal: 9,
    rank: 'Novice',
    badges: ['synthetic-v1-badge'],
    inventory: [],
    equippedItems: [],
    collectedNotes: [],
    streakCount: 0,
    subjectsMastered: 0,
    roomsCleared: 0,
    reviewPasses: 0,
    artifacts: 0,
    bossesDefeated: 0,
    fishCollection: [],
  });

  const truncated = healthyDevice();
  const full = JSON.stringify(syntheticSnapshot());
  truncated[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] = full.slice(0, Math.floor(full.length / 2));

  const combined: Database = { ...corruptJson };
  combined[SUBJECT_INDEX_KEY] = JSON.stringify([
    SUBJECT_ID,
    'subject-qa-ghost-with-no-payload',
    'subject-qa-truncated',
  ]);
  combined[`knowledge-dungeon:v1:subject:subject-qa-truncated`] =
    truncated[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] as string;
  combined[PROGRESSION_KEY] = v1Flat[PROGRESSION_KEY] as string;
  combined[`knowledge-dungeon:v1:subject:subject-qa-orphan-payload`] =
    orphanPayload[`knowledge-dungeon:v1:subject:subject-qa-orphan-payload`] as string;

  return [
    { label: 'a healthy device', keys: healthy, expectStatus: 'migrated', expectSubjectsInLegacyRead: 1, expectSubjectsInGeneration: 1, expectDisclosedProblemsAtLeast: 0 },
    { label: 'unknown app-owned fields', keys: unknownFields, expectStatus: 'migrated', expectSubjectsInLegacyRead: 1, expectSubjectsInGeneration: 1, expectDisclosedProblemsAtLeast: 0 },
    { label: 'a corrupt JSON subject', keys: corruptJson, expectStatus: 'migrated', expectSubjectsInLegacyRead: 0, expectSubjectsInGeneration: 0, expectDisclosedProblemsAtLeast: 1 },
    { label: 'an index entry with no payload', keys: ghostIndex, expectStatus: 'migrated', expectSubjectsInLegacyRead: 1, expectSubjectsInGeneration: 1, expectDisclosedProblemsAtLeast: 1 },
    { label: 'a payload with no index entry', keys: orphanPayload, expectStatus: 'migrated', expectSubjectsInLegacyRead: 1, expectSubjectsInGeneration: 1, expectDisclosedProblemsAtLeast: 0 },
    { label: 'attachments whose bytes are unrecoverable', keys: unrecoverableAttachment, expectStatus: 'migrated', expectSubjectsInLegacyRead: 1, expectSubjectsInGeneration: 1, expectDisclosedProblemsAtLeast: 1 },
    { label: 'a v1 flat progression', keys: v1Flat, expectStatus: 'migrated', expectSubjectsInLegacyRead: 1, expectSubjectsInGeneration: 1, expectDisclosedProblemsAtLeast: 0 },
    { label: 'a truncated subject', keys: truncated, expectStatus: 'migrated', expectSubjectsInLegacyRead: 0, expectSubjectsInGeneration: 0, expectDisclosedProblemsAtLeast: 1 },
    { label: 'all of them at once', keys: combined, expectStatus: 'migrated', expectSubjectsInLegacyRead: 0, expectSubjectsInGeneration: 0, expectDisclosedProblemsAtLeast: 2 },
  ];
}

/**
 * What the application would actually show for a state payload.
 *
 * The exit criterion is about *visible* loss, so the comparison is made at the
 * store boundary rather than on the raw documents: the two readers are allowed
 * to store different bytes, but they may not hydrate different state.
 */
function hydratedFingerprint(state: AppPersistedState): Record<string, unknown> {
  useProgressionStore.getState().hydrateProgression(state.progression);
  usePreferencesStore.getState().hydratePreferences(state.preferences);
  useShortcutStore.getState().hydrateShortcuts(state.shortcuts);
  const progression = useProgressionStore.getState();
  return {
    subjects: state.subjects.map((entry) => entry.snapshot),
    progression: {
      bySubject: progression.bySubject,
      crossSubjectAchievements: progression.crossSubjectAchievements,
      activeSubjectId: progression.activeSubjectId,
      xpTotal: progression.xpTotal,
      rank: progression.rank,
      badges: progression.badges,
      fishCollection: progression.fishCollection,
      roomsCleared: progression.roomsCleared,
      artifacts: progression.artifacts,
      streakCount: progression.streakCount,
    },
    preferences: {
      graphicsMode: usePreferencesStore.getState().graphicsMode,
      colorTheme: usePreferencesStore.getState().colorTheme,
      activeSpritePack: usePreferencesStore.getState().activeSpritePack,
    },
    shortcuts: useShortcutStore.getState().shortcuts,
    sessions: state.sessions,
    activeSubjectId: state.activeSubjectId,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  clearDualWriteReports();
  vi.restoreAllMocks();
});

afterEach(async () => {
  repository?.close();
  repository = null;
  if (name) await dropRepo(name);
  name = '';
  resetRepositorySelection();
  clearDualWriteReports();
  window.localStorage.clear();
});

describe('Exit criterion 1: the two repositories read the same device identically', () => {
  for (const testCase of cases()) {
    it(`survives ${testCase.label}`, async () => {
      write(testCase.keys);
      const before = legacyKeySet();

      name = testCase.label.replace(/[^a-z0-9]+/gi, '-');
      const repo = await openRepo(name);
      repository = repo;
      const outcome = await migrateLegacyState({
        repository: repo,
        generationId: 'gen-phase4-criterion1',
        now: NOW,
        clock: { now: () => NOW },
      });

      expect(outcome.report.status, `${testCase.label}: migration status`).toBe(testCase.expectStatus);
      // The migration reads the legacy device and never writes it.
      expect(legacyKeySet(), `${testCase.label}: the legacy key set changed`).toEqual(before);

      const legacyRead = readAppStateFromLegacy();
      selectStorageV2Repository(repo);
      const storageRead = await readAppStateFromStorageV2(repo, {
        activeSubjectId: legacyRead.activeSubjectId,
      });
      selectStorageV2Repository(repo);
      repository = repo;

      // 1. Subjects, rooms, notes, validation state, artifacts, and attachments:
      //    the stored documents must be identical, because a subject is a single
      //    record in both models.
      const legacyById = new Map(legacyRead.subjects.map((entry) => [entry.id, entry.snapshot]));
      const storageById = new Map(storageRead.subjects.map((entry) => [entry.id, entry.snapshot]));
      expect([...storageById.keys()].sort(), `${testCase.label}: which subjects survived`).toEqual(
        [...legacyById.keys()].sort(),
      );
      expect(legacyRead.subjects.length, `${testCase.label}: legacy subject count`).toBe(
        testCase.expectSubjectsInLegacyRead,
      );
      for (const [id, snapshot] of storageById) {
        expect(snapshot, `${testCase.label}: ${id} in the generation`).toEqual(legacyById.get(id));
      }
      const active = await repo.readActiveGenerationId();
      const generationSubjects = (await repo.readRecords(active as string)).records.subjects;
      expect(
        generationSubjects.length,
        `${testCase.label}: the generation's own subject count`,
      ).toBe(testCase.expectSubjectsInGeneration);

      // 2-6. Progression (XP, badges, fish, cross-subject achievements),
      //      preferences, shortcuts, sessions, and the active-subject pointer,
      //      compared as the state the application would show.
      expect(hydratedFingerprint(storageRead), `${testCase.label}: hydrated state`).toEqual(
        hydratedFingerprint(legacyRead),
      );

      // 7. The disclosure count: a record the transform could not carry is
      //    reported, never silently dropped.
      const disclosed = outcome.report.problems.reduce((total, problem) => total + problem.count, 0);
      expect(disclosed, `${testCase.label}: disclosed problem count`).toBeGreaterThanOrEqual(
        testCase.expectDisclosedProblemsAtLeast,
      );
      expect(
        outcome.report.problems.every((problem) => problem.severity === 'warning'),
        `${testCase.label}: a source problem must be a disclosure`,
      ).toBe(true);
    });
  }
});

describe('Exit criterion 1: attachments disclose honestly instead of pretending', () => {
  it('reports a historical local attachment as external-only and never fetches it', async () => {
    const testCase = cases()[5] as Case;
    write(testCase.keys);
    name = 'attachment-disclosure';
    const repo = await openRepo(name);
    repository = repo;

    const fetchSpy = vi.fn(() => {
      throw new Error('a migration must never perform a network request');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-attachments',
      now: NOW,
      clock: { now: () => NOW },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    // Both attachments are disclosed; neither is claimed to have bytes.
    const disclosures = outcome.report.externalOnlyAttachments.map((entry) => ({
      reason: entry.reason,
      contentHash: entry.contentHash,
      byteLength: entry.byteLength,
      sourceType: entry.sourceType,
      keys: Object.keys(entry).sort(),
    }));
    expect(disclosures.map((entry) => `${entry.sourceType}:${entry.reason}`).sort()).toEqual([
      'external:historical-external-url',
      'local:bytes-not-recoverable',
    ]);
    // And no disclosure carries a URL, a filename, or a hash it does not have.
    for (const entry of disclosures) {
      expect(entry.contentHash).toBeNull();
      expect(entry.byteLength).toBeNull();
      expect(entry.keys).toEqual([
        'attachmentId',
        'byteLength',
        'contentHash',
        'reason',
        'roomId',
        'sourceType',
        'subjectId',
      ]);
    }
    // No blob was invented for either.
    const active = await repo.readActiveGenerationId();
    expect((await repo.readRecords(active as string)).records.attachmentBlobs).toEqual([]);
    // The subject's own attachment list is preserved verbatim, so the room still
    // shows what the learner had.
    const stored = (await repo.readRecords(active as string)).records.subjects[0]?.value as
      | SubjectRecordLike
      | undefined;
    const attachments = (stored?.snapshot.rooms[ROOT_ROOM_ID] as { attachments: unknown[] }).attachments;
    expect(attachments).toHaveLength(2);
  });
});

interface SubjectRecordLike {
  readonly snapshot: { rooms: Record<string, unknown> };
}

describe('Every disclosed problem is a warning, at every site that raises one', () => {
  /**
   * Phase 3 recorded that `severity: 'error'` did not block activation, so the
   * severity naming and the blocking rule disagreed. Phase 4 aligned them by
   * making every *source* problem a `warning`. This block attacks each of the
   * sites that raises one, because a single fixture cannot reach them all and a
   * gate that only reaches one is a gate that proves one thing.
   */
  const sites: { label: string; mutate: (keys: Database) => Database; expected: string[] }[] = [
    {
      label: 'a corrupt subject payload',
      mutate: (keys) => ({ ...keys, [`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]: '{"dungeon":' }),
      expected: ['not-an-object'],
    },
    {
      // Two different keys whose payloads both declare the same `dungeonId`:
      // the migration resolves the identity from the payload, so this is the one
      // way a duplicate subject identifier can actually arise.
      label: 'a duplicate subject identifier',
      mutate: (keys) => {
        const payload = JSON.parse(keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] as string) as object;
        return {
          ...keys,
          [SUBJECT_INDEX_KEY]: JSON.stringify([SUBJECT_ID, 'subject-qa-second-key']),
          [`knowledge-dungeon:v1:subject:subject-qa-second-key`]: JSON.stringify(payload),
        };
      },
      expected: ['duplicate-identifier'],
    },
    {
      label: 'an unreadable progression payload',
      mutate: (keys) => ({ ...keys, [PROGRESSION_KEY]: '{not json' }),
      expected: ['not-an-object'],
    },
    {
      label: 'a malformed session record',
      mutate: (keys) => ({ ...keys, [SESSIONS_KEY]: JSON.stringify(['not-a-session', { sessionId: 'session-qa-1', subjectId: SUBJECT_ID, startedAt: '2026-02-01T00:00:00.000Z', endedAt: null, roomsVisited: [], notesSubmitted: 0, reviewsCompleted: 0, xpEarned: 0 }]) }),
      expected: ['wrong-type'],
    },
    {
      label: 'a duplicated session identifier',
      mutate: (keys) => {
        const session = { sessionId: 'session-qa-1', subjectId: SUBJECT_ID, startedAt: '2026-02-01T00:00:00.000Z', endedAt: null, roomsVisited: [], notesSubmitted: 0, reviewsCompleted: 0, xpEarned: 0 };
        return { ...keys, [SESSIONS_KEY]: JSON.stringify([session, session]) };
      },
      expected: ['duplicate-identifier'],
    },
    {
      label: 'a sessions value that is not an array',
      mutate: (keys) => ({ ...keys, [SESSIONS_KEY]: JSON.stringify({ sessions: [] }) }),
      expected: ['unexpected-json-shape'],
    },
    {
      label: 'a malformed shortcut record',
      mutate: (keys) => ({ ...keys, [SHORTCUTS_KEY]: JSON.stringify([42, { key: 'm', labelKey: 'shortcuts.toggleMap' }]) }),
      expected: ['wrong-type'],
    },
    {
      label: 'a duplicate attachment identifier',
      mutate: (keys) => {
        const snapshot = JSON.parse(keys[`knowledge-dungeon:v1:subject:${SUBJECT_ID}`] as string) as {
          rooms: Record<string, { attachments: unknown[] }>;
        };
        const attachment = {
          attachmentId: 'att-qa-duplicate',
          sourceType: 'local' as const,
          fileName: 'qa-synthetic-duplicate.png',
          mimeType: 'image/png',
          relativePath: 'uploads/qa-synthetic-duplicate.png',
          addedAt: '2026-02-01T00:10:00.000Z',
        };
        snapshot.rooms[ROOT_ROOM_ID].attachments = [attachment, { ...attachment }];
        return { ...keys, [`knowledge-dungeon:v1:subject:${SUBJECT_ID}`]: JSON.stringify(snapshot) };
      },
      expected: ['duplicate-identifier'],
    },
  ];

  for (const site of sites) {
    it(`discloses ${site.label} as a warning`, async () => {
      write(site.mutate(healthyDevice()));
      const before = legacyKeySet();
      name = site.label.replace(/[^a-z0-9]+/gi, '-');
      const repo = await openRepo(name);
      repository = repo;
      const outcome = await migrateLegacyState({
        repository: repo,
        generationId: 'gen-phase4-severity-site',
        now: NOW,
        clock: { now: () => NOW },
      });

      const codes = outcome.report.problems.map((problem) => problem.code);
      expect(codes, `${site.label}: the problem was not raised at all`).toEqual(
        expect.arrayContaining(site.expected),
      );
      // The alignment: every one of them is a disclosure, and the run still
      // finished, so a learner with one unreadable record is not locked out.
      for (const problem of outcome.report.problems) {
        expect(problem.severity, `${site.label}: ${problem.code}`).toBe('warning');
        expect(Object.keys(problem).sort(), `${site.label}: ${problem.code}`).toEqual([
          'code',
          'count',
          'scope',
          'severity',
        ]);
      }
      expect(outcome.report.status).toBe('migrated');
      expect(await repo.readActiveGenerationId()).toBe('gen-phase4-severity-site');
      // And the legacy device is still byte-identical.
      expect(legacyKeySet()).toEqual(before);
    });
  }
});

describe('Exit criterion 1: the records the exit criterion names but a store does not read', () => {
  it('carries quest state, custom sprites, recovery records, and locale into the generation', async () => {
    // Quest state, custom sprites, and recovery records have no store hydration
    // yet - Phase 8 owns sprites and Phase 19 owns assistance - so "no visible
    // loss" for them means the generation *holds* them, byte for byte, and the
    // receipt accounts for every legacy key it read.
    const spriteOverride = '<svg xmlns="http://www.w3.org/2000/svg" data-probe="override" />';
    const recoveryRaw = '{"corrupt":"phase4 synthetic recovery payload"';
    const keys: Database = {
      ...healthyDevice(),
      'kd-quest-step': '3',
      'kd-village-spawn': 'room-phase4-independent-root',
      // One custom-sprite key, which is the only shape the phase's own migration
      // fixture covers. A second kind for the *same* path is the defect below.
      'knowledge-dungeon:custom-sprites:override:player-hero': spriteOverride,
      'knowledge-dungeon:custom-sprites:packs': JSON.stringify(['synthetic-pack']),
      [`knowledge-dungeon:corrupt:${SUBJECT_ID}`]: recoveryRaw,
      'knowledge-dungeon:ui:touch-hint:v1': '1',
    };
    write(keys);
    const before = legacyKeySet();

    name = 'quest-sprites-recovery';
    const repo = await openRepo(name);
    repository = repo;
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-quest-sprites',
      now: NOW,
      clock: { now: () => NOW },
    });

    expect(outcome.report.status).toBe('migrated');
    expect(legacyKeySet()).toEqual(before);

    const active = await repo.readActiveGenerationId();
    const records = (await repo.readRecords(active as string)).records;
    // Custom sprites, verbatim.
    expect(
      records.customSprites.map((envelope) => ({
        spritePath: (envelope.value as { spritePath: string }).spritePath,
        kind: (envelope.value as { kind: string }).kind,
        content: (envelope.value as { content: unknown }).content,
      })),
    ).toEqual(
      expect.arrayContaining([
        { spritePath: 'player-hero', kind: 'override', content: spriteOverride },
        { spritePath: 'packs', kind: 'override', content: JSON.stringify(['synthetic-pack']) },
      ]),
    );
    // Recovery records, byte for byte, including the payload the app could not
    // parse: a quarantined record must not be dropped on the way in.
    expect(records.recovery).toHaveLength(1);
    expect((records.recovery[0]?.value as { kind: string; raw: string }).kind).toBe('corrupt');
    expect((records.recovery[0]?.value as { raw: string }).raw).toBe(recoveryRaw);
    // The quest step and the locale are session state, recorded in the session
    // store, and counted in the receipt.
    expect(outcome.report.recordCounts.customSprites).toBe(2);
    expect(outcome.report.recordCounts.recovery).toBe(1);
    expect(outcome.report.legacyKeys.present).toBeGreaterThanOrEqual(8);
    // Every allowlisted key that was present is accounted for, and the
    // generation validates.
    const validation = await repo.validateGeneration(active as string);
    expect(validation.ok, JSON.stringify(validation.problems)).toBe(true);
    // Every declared count is the stored count, in both directions. (`meta` is
    // the registry entry, which validation never compares.)
    expect({ ...validation.countDeltas, meta: 0 }).toEqual({
      meta: 0,
      subjects: 0,
      progression: 0,
      sessions: 0,
      preferences: 0,
      shortcuts: 0,
      assistance: 0,
      attachments: 0,
      customSprites: 0,
      recovery: 0,
      migrationReceipts: 0,
    });
    // The receipt is the durable record of the run.
    const receipt = (await repo.listMigrationReceipts())[0];
    expect(receipt?.status).toBe('activated');
    expect(receipt?.recordCounts.customSprites).toBe(2);
    expect(receipt?.recordCounts.recovery).toBe(1);
    expect(receipt?.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
    // And the locale, which the app reads from its own key, is still exactly
    // what the device had.
    expect(window.localStorage.getItem('knowledge-dungeon:locale')).toBe('en');
  });
});

describe('two custom-sprite kinds for one path both migrate', () => {
  /**
   * Regression, formerly red at blocker severity.
   *
   * `buildRecordEnvelopes` in `src/services/persistence/v2/repository.ts` keys the
   * `customSprites` store by `value.spritePath` alone, while the legacy device
   * keeps an `override`, an `anim`, and an `original` under *different* keys that
   * share one path (`knowledge-dungeon:custom-sprites:{override,anim,originals}:<path>`).
   * Three records therefore collapse onto two primary keys, the descriptor's
   * `recordCounts.customSprites` counts the pre-collapse array, and
   * `validateGeneration` refuses activation with `count-mismatch` /
   * `severity: 'error'`.
   *
   * The learner-visible effect is that **a device with any custom sprite data
   * never migrates**: the flagged build reports `recovery-required`, keeps the
   * legacy generation authoritative, and shows a recovery state for data the
   * migration itself could not carry. No data is lost, and a rollback build
   * still works - but the migration deliverable is not met for these devices.
   *
   * The phase's own migration fixture seeds exactly one custom-sprite key
   * (`override:village/tree.svg`), so this shape was never exercised.
   */
  it('migrates a device whose sprite has an override, an anim, and an original', async () => {
    const keys: Database = {
      ...healthyDevice(),
      'knowledge-dungeon:custom-sprites:override:player-hero': '<svg data-probe="override" />',
      'knowledge-dungeon:custom-sprites:anim:player-hero': '<svg data-probe="anim" />',
      'knowledge-dungeon:custom-sprites:originals:player-hero': '<svg data-probe="original" />',
    };
    write(keys);
    const before = legacyKeySet();
    name = 'sprite-collision';
    const repo = await openRepo(name);
    repository = repo;
    const outcome = await migrateLegacyState({
      repository: repo,
      generationId: 'gen-phase4-sprite-collision',
      now: NOW,
      clock: { now: () => NOW },
    });

    // The legacy device is untouched either way, which is the safety half.
    expect(legacyKeySet()).toEqual(before);
    // The other half: the migration is expected to succeed and activate.
    expect(outcome.report.status).toBe('migrated');
    expect(outcome.report.activated).toBe(true);
    const active = await repo.readActiveGenerationId();
    expect(active).toBe('gen-phase4-sprite-collision');
    // All three kinds survive, keyed so none of them overwrites another.
    const records = (await repo.readRecords(active as string)).records.customSprites;
    expect(
      records
        .map((envelope) => (envelope.value as { kind: string; content: string }))
        .map((value) => `${value.kind}:${value.content}`)
        .sort(),
    ).toEqual([
      'anim:<svg data-probe="anim" />',
      'original:<svg data-probe="original" />',
      'override:<svg data-probe="override" />',
    ]);
  });
});
