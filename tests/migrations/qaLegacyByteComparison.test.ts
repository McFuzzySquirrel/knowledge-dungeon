/**
 * INDEPENDENT QA gate: no default behavior change on the live legacy key.
 *
 * The exact strings below were produced by running the SAME scenario in a clean
 * `git worktree` of the pre-phase HEAD (5345493) and in the phase worktree, and
 * diffing the two outputs. See the phase evidence for the two artefacts.
 *
 * Three cases are byte-identical to the pre-phase build. Two differ, in exactly
 * one documented way: unknown app-owned fields are now PRESERVED instead of
 * being dropped on rewrite. That is a deliberate, tested change to the live
 * `knowledge-dungeon:v1:progression` write path, recorded here so it cannot be
 * discovered later as a surprise.
 *
 * ## Phase 18 changed one of them, and case 5 is the record of why
 *
 * Case 5 used to be byte-identical too - but only because the scenario called the store the way
 * **no production caller does**, naming neither a room nor a Phase 15 clear identity. `qa-engineer`
 * reproduced in real Chromium against the default `dist` that a completed note on the shipping
 * lane (`NoteEditorModal`, because `VITE_SCRIBE_ENCOUNTER_WORKSPACE` defaults to `false`) awarded
 * XP and recorded nothing anywhere: `extraFields: null`, session `notesSubmitted: 0`. This file
 * stayed green through that defect because it was pinning the shape of a call production had
 * stopped making.
 *
 * Case 5 now makes the call `NoteEditorModal.handleSubmit` makes and pins the single documented
 * difference; case 5b keeps the no-room call pinned for the rollback lane. A fixture that pins the
 * old shape is a fixture that was asserting the bug.
 *
 * All values are synthetic. `Math.random` and the clock are pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  eventsOfKind,
  readStatisticsEventLedgerFromFields,
  totalXpAwarded,
} from '@/core/statistics/statisticsEvents';

const PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';
const ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';

type ProgressionStoreModule = typeof import('@/store/progressionStore');

async function loadStore(): Promise<ProgressionStoreModule> {
  vi.resetModules();
  const mod = await import('@/store/progressionStore');
  // Phase 4: hydration is an explicit step owned by the application bootstrap,
  // not a module-load side effect. These two calls are exactly what the
  // bootstrap performs for the legacy repository, so the characterization
  // below still exercises the real hydration path with its assertions intact.
  mod.useProgressionStore.getState().hydrateProgression(mod.readPersistedProgressionPayload());
  return mod;
}

function raw(): string {
  const value = window.localStorage.getItem(PROGRESSION_KEY);
  if (value === null) throw new Error('the store wrote nothing to the progression key');
  return value;
}

/** Byte-identical to the pre-phase HEAD build. */
const HEAD_FRESH_SUBJECT =
  '{"version":3,"bySubject":{"subject-qa-fresh":{"xpTotal":0,"rank":"Novice","badges":[],"inventory":[],"equippedItems":[],"collectedNotes":[],"streakCount":0,"subjectsMastered":0,"roomsCleared":0,"reviewPasses":0,"artifacts":0,"bossesDefeated":0,"fishCollection":[]}},"crossSubjectAchievements":[]}';

const HEAD_ROOM_CLEAR = "{\"version\":3,\"bySubject\":{\"subject-qa-roomclear\":{\"xpTotal\":26,\"rank\":\"Novice\",\"badges\":[\"CreatorPhaseComplete\"],\"inventory\":[{\"id\":\"gear-mufil8k5-4fzz\",\"name\":\"Scholar's Cap\",\"description\":\"A velvet cap that sharpens the mind. +1 quality bonus on note submissions.\",\"rarity\":\"common\",\"acquiredAt\":\"2026-09-24T12:34:56.789Z\",\"equipSlot\":\"head\",\"qualityBonus\":1,\"equipped\":false}],\"equippedItems\":[],\"collectedNotes\":[],\"streakCount\":1,\"subjectsMastered\":0,\"roomsCleared\":1,\"reviewPasses\":0,\"artifacts\":0,\"bossesDefeated\":0,\"fishCollection\":[]}},\"crossSubjectAchievements\":[]}";

/**
 * The thirteen keys the pre-phase build wrote, in the order it wrote them.
 *
 * Declared once and used by both the byte-equality cases and the structural "one documented
 * difference" checks, so a change to the legacy key order cannot make one case disagree with
 * another.
 */
const PRE_PHASE_SUBJECT_KEYS = [
  'xpTotal', 'rank', 'badges', 'inventory', 'equippedItems', 'collectedNotes',
  'streakCount', 'subjectsMastered', 'roomsCleared', 'reviewPasses',
  'artifacts', 'bossesDefeated', 'fishCollection',
];

/**
 * `HEAD_ROOM_CLEAR` plus the one key Phase 18 added, flattened after the thirteen legacy keys.
 *
 * Reproducible: `beforeEach` pins the clock and `Math.random`, and neither the ledger nor the
 * event digests read anything else. Case 5 asserts this literal **and** asserts structurally that
 * removing `statisticsEventLedger` returns exactly `HEAD_ROOM_CLEAR`, so the added key is the
 * whole difference rather than one difference among several.
 */
const SHIPPING_LANE_ROOM_CLEAR = "{\"version\":3,\"bySubject\":{\"subject-qa-roomclear\":{\"xpTotal\":26,\"rank\":\"Novice\",\"badges\":[\"CreatorPhaseComplete\"],\"inventory\":[{\"id\":\"gear-mufil8k5-4fzz\",\"name\":\"Scholar's Cap\",\"description\":\"A velvet cap that sharpens the mind. +1 quality bonus on note submissions.\",\"rarity\":\"common\",\"acquiredAt\":\"2026-09-24T12:34:56.789Z\",\"equipSlot\":\"head\",\"qualityBonus\":1,\"equipped\":false}],\"equippedItems\":[],\"collectedNotes\":[],\"streakCount\":1,\"subjectsMastered\":0,\"roomsCleared\":1,\"reviewPasses\":0,\"artifacts\":0,\"bossesDefeated\":0,\"fishCollection\":[],\"statisticsEventLedger\":{\"version\":1,\"events\":[{\"kind\":\"xp-award\",\"eventId\":\"sevt-9dc2c804\",\"localDate\":\"2026-09-24\",\"recordedAt\":\"2026-09-24T12:34:56.789Z\",\"source\":\"note-submission\",\"amount\":26},{\"eventId\":\"sevt-e757dc53\",\"localDate\":\"2026-09-24\",\"recordedAt\":\"2026-09-24T12:34:56.789Z\",\"kind\":\"note-submission\",\"roomId\":\"room-qa-roomclear\",\"xpAwarded\":26}]}}},\"crossSubjectAchievements\":[]}";

const V1_FLAT = JSON.stringify({
  xpTotal: 315,
  rank: 'Novice',
  badges: ['synthetic-v1-badge', 7, null],
  inventory: [
    { id: 'loot-v1-synthetic', name: 'Synthetic Legacy Relic', description: 'synthetic', rarity: 'rare', acquiredAt: '2026-02-01T03:04:05.000Z' },
    { name: 'Synthetic Item Without Identifier', description: 'synthetic', rarity: 'mystery' },
  ],
  collectedNotes: [
    { noteId: 'subject-v1:room-v1-root', dungeonId: 'subject-v1', roomId: 'room-v1-root', topic: 'Synthetic V1 Topic', floorLabel: 'Synthetic Floor', artifactPreview: 'Synthetic preview', noteMarkdown: 'Synthetic note', artifactMarkdown: 'Synthetic artifact', collectedAt: '2026-02-01T04:00:00.000Z' },
  ],
  fishCollection: [
    { id: 'moss-carp:v1-1', name: 'Moss Carp', rarity: 'common', subjectId: 'subject-v1', subjectName: 'Synthetic V1 Subject', caughtAt: '2026-02-01T05:00:00.000Z' },
  ],
  legacyOnlyField: 'synthetic-legacy-only',
});

const V3_WITH_UNKNOWN = JSON.stringify({
  version: 3,
  bySubject: {
    'subject-qa-unknown': {
      xpTotal: 320,
      rank: 'Stale Rank',
      badges: ['synthetic-badge'],
      inventory: [],
      equippedItems: [],
      collectedNotes: [],
      streakCount: 0,
      subjectsMastered: 0,
      roomsCleared: 1,
      reviewPasses: 0,
      artifacts: 0,
      bossesDefeated: 0,
      fishCollection: [],
      qaUnknownField: { marker: 'synthetic-unknown-field' },
      anotherUnknown: 42,
    },
  },
  crossSubjectAchievements: ['meta-subjects-5'],
});

describe('QA no default behavior change: legacy progression key vs pre-phase HEAD', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:34:56.789Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('case 1 - a fresh subject writes the pre-phase bytes exactly', async () => {
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-fresh');
    expect(raw()).toBe(HEAD_FRESH_SUBJECT);
  });

  it('case 5 - a room clear on the SHIPPING lane writes the pre-phase bytes plus ONE documented key', async () => {
    // CHANGED IN PHASE 18, deliberately, and this is the record of why.
    //
    // This case used to assert that a room clear wrote `HEAD_ROOM_CLEAR` byte-for-byte, which
    // was true only because the scenario called the store the way *no production caller does*:
    // with no room and no clear identity at all. `qa-engineer` then reproduced in real Chromium
    // against the default `dist` that a completed note on the shipping lane awarded XP and
    // recorded no statistics anywhere - `extraFields: null`, session `notesSubmitted: 0`. The
    // byte-comparison lane was pinning the shape of a call production had stopped making, so it
    // stayed green through the defect. It now calls `awardRoomClear` the way
    // `NoteEditorModal.handleSubmit` does, and pins the one documented difference.
    //
    // The change: a call that names a room writes `statisticsEventLedger`, flattened after the
    // thirteen legacy keys. It is the ledger the Phase 18 statistics layer reads, and it is also
    // the lane's awarded-once guard. A lane that records nothing is a worse defect than a lane
    // whose record gained a key the pre-phase reader ignores.
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-roomclear');
    useProgressionStore.getState().awardRoomClear({
      qualityBonus: 5,
      totalRooms: 2,
      creatorMappedRooms: 2,
      scribeClearedRooms: 1,
      archaeologistFullReviewPasses: 0,
      roomId: 'room-qa-roomclear',
    });

    // The exact bytes. The clock and `Math.random` are pinned in `beforeEach`, and neither the
    // event digests nor the ledger depend on anything else, so this is reproducible.
    expect(raw()).toBe(SHIPPING_LANE_ROOM_CLEAR);

    // ── The "one documented difference" property, stated structurally so it stays reviewable:
    // delete the single added key and the record is byte-identical to the pre-phase build.
    const written = JSON.parse(raw()) as { bySubject: Record<string, Record<string, unknown>> };
    const writtenRecord = written.bySubject['subject-qa-roomclear'];
    expect(Object.keys(writtenRecord).slice(0, 13)).toEqual(PRE_PHASE_SUBJECT_KEYS);
    expect(Object.keys(writtenRecord).slice(13)).toEqual(['statisticsEventLedger']);
    const withoutLedger = { ...writtenRecord };
    delete withoutLedger.statisticsEventLedger;
    expect(
      JSON.stringify({
        version: 3,
        bySubject: { 'subject-qa-roomclear': withoutLedger },
        crossSubjectAchievements: [],
      }),
    ).toBe(HEAD_ROOM_CLEAR);

    // ── The added key carries the counted facts, not a marker. Asserted by value, so a digest
    // that stopped distinguishing rooms, or an XP that stopped being recorded, fails here.
    const ledger = readStatisticsEventLedgerFromFields(writtenRecord);
    expect(eventsOfKind(ledger, 'note-submission')).toHaveLength(1);
    expect(eventsOfKind(ledger, 'note-submission')[0]).toMatchObject({
      roomId: 'room-qa-roomclear',
      xpAwarded: 26,
      // Pinned digest: a change to `deriveRoomClearSubmissionIdentity` must break this fixture
      // deliberately, because a silently changed identity re-keys a room's awarded-once history.
      eventId: 'sevt-e757dc53',
    });
    expect(totalXpAwarded(ledger)).toBe(26);
  });

  it('case 5b - a room clear by a caller that names no room writes the pre-phase bytes exactly', async () => {
    // The shape this file used to use, kept for the one caller shape that still exists: a direct
    // store caller that names neither a room nor a clear generation. It cannot record
    // statistics - a `note-submission` event requires an app-minted `roomId`, so there is no
    // honest event to write - and it remains an unconditional award, which is the pre-Phase-15
    // behaviour a rollback build would take.
    //
    // No production caller uses this shape: `NoteEditorModal` names its room, and
    // `encounter/note-submit` supplies a clear identity. It is here so the rollback lane stays
    // pinned, not because the shipping build depends on it.
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-roomclear');
    useProgressionStore.getState().awardRoomClear({
      qualityBonus: 5,
      totalRooms: 2,
      creatorMappedRooms: 2,
      scribeClearedRooms: 1,
      archaeologistFullReviewPasses: 0,
    });
    expect(raw()).toBe(HEAD_ROOM_CLEAR);
  });

  it('case 4 - a v2 payload is left untouched until a write happens', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V3_WITH_UNKNOWN.replace('"version":3', '"version":2').replace('subject-qa-unknown', 'subject-qa-v2').replace('subject-qa-unknown', 'subject-qa-v2'));
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-v2');
    const before = raw();
    await loadStore();
    // Hydration alone must not rewrite the key.
    expect(raw()).toBe(before);
    expect(JSON.parse(before).version).toBe(2);
    // The in-memory state matches what the pre-phase build produced.
    const { useProgressionStore } = await import('@/store/progressionStore');
    expect(useProgressionStore.getState().xpTotal).toBe(320);
    expect(useProgressionStore.getState().rank).toBe('Scholar');
  });

  it('case 2 - a v1 flat payload differs ONLY by the preserved unknown field', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V1_FLAT);
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-v1');
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-v1');
    useProgressionStore.getState().awardBadge('synthetic-v1-written-badge');

    const written = JSON.parse(raw()) as {
      version: number;
      bySubject: Record<string, Record<string, unknown>>;
      crossSubjectAchievements: string[];
    };
    const record = written.bySubject['subject-qa-v1']!;

    // Everything the pre-phase build wrote is present, in the pre-phase order.
    expect(Object.keys(record).slice(0, PRE_PHASE_SUBJECT_KEYS.length)).toEqual(PRE_PHASE_SUBJECT_KEYS);
    // The ONLY difference: the unknown envelope field survives.
    expect(Object.keys(record).slice(PRE_PHASE_SUBJECT_KEYS.length)).toEqual(['legacyOnlyField']);
    expect(record.legacyOnlyField).toBe('synthetic-legacy-only');
    // Nothing canonical-only leaked onto the legacy key.
    expect(record).not.toHaveProperty('subjectId');
    expect(record).not.toHaveProperty('extraFields');
    expect(Object.keys(written).sort()).toEqual(['bySubject', 'crossSubjectAchievements', 'version']);
    expect(written.version).toBe(3);
  });

  it('case 3 - a v3 payload with unknown fields differs ONLY by their preservation', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V3_WITH_UNKNOWN);
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-unknown');
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-unknown');
    useProgressionStore.getState().awardBadge('synthetic-second-badge');

    const written = JSON.parse(raw()) as {
      bySubject: Record<string, Record<string, unknown>>;
      crossSubjectAchievements: string[];
    };
    const record = written.bySubject['subject-qa-unknown']!;
    expect(Object.keys(record).slice(0, PRE_PHASE_SUBJECT_KEYS.length)).toEqual(PRE_PHASE_SUBJECT_KEYS);
    expect(Object.keys(record).slice(PRE_PHASE_SUBJECT_KEYS.length)).toEqual(['qaUnknownField', 'anotherUnknown']);
    expect(record.qaUnknownField).toEqual({ marker: 'synthetic-unknown-field' });
    expect(record.anotherUnknown).toBe(42);
    expect(written.crossSubjectAchievements).toEqual(['meta-subjects-5']);
    // The pre-phase build dropped both; the phase build keeps them. The exact
    // pre-phase string is reproduced here so the difference is the whole story.
    expect(raw()).not.toBe(
      '{"version":3,"bySubject":{"subject-qa-unknown":{"xpTotal":320,"rank":"Scholar","badges":["synthetic-badge","synthetic-second-badge"],"inventory":[],"equippedItems":[],"collectedNotes":[],"streakCount":0,"subjectsMastered":0,"roomsCleared":1,"reviewPasses":0,"artifacts":0,"bossesDefeated":0,"fishCollection":[]}},"crossSubjectAchievements":["meta-subjects-5"]}',
    );
  });

  it('the storage-v2 serializer stays off the legacy key', async () => {
    window.localStorage.setItem(PROGRESSION_KEY, V3_WITH_UNKNOWN);
    window.localStorage.setItem(ACTIVE_SUBJECT_KEY, 'subject-qa-unknown');
    const { useProgressionStore } = await loadStore();
    useProgressionStore.getState().setActiveSubject('subject-qa-unknown');
    useProgressionStore.getState().awardBadge('synthetic-second-badge');
    const written = raw();
    for (const canonicalOnly of ['"kind"', '"sourceVersion"', '"activeSubjectId"', '"legacyBucketSubjectId"']) {
      expect(written, canonicalOnly).not.toContain(canonicalOnly);
    }
  });
});
