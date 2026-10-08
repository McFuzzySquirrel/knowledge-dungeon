/**
 * Deterministic synthetic dungeon fixtures for the Phase 22 frame-time lane.
 *
 * ## Why this module is pure, and why it does not import the application
 *
 * The fixture it builds is a `SubjectSnapshot`-shaped JSON value. The **application**
 * turns that value into a world: `GameScreen` calls the real
 * `generateDungeonMap(snapshot.dungeon)` (`src/core/layout/dungeonGenerator.ts`) and
 * hands the resulting `DungeonMap` to the real PixiJS `DungeonWorld`. So this module
 * does not re-implement layout, and it must not: a second layout implementation could
 * disagree with the one the lane is measuring, and the point of the measurement is the
 * world the product builds.
 *
 * It is deliberately plain TypeScript with **no imports**. A Playwright worker compiles
 * specs with its own transform and does not resolve the repository's `@/` alias, so a
 * module that imported `@/core/...` would not load in the very lane it exists for. The
 * shape is instead pinned against the real generator by `tests/performance/…`:
 * `tests/e2e/pixi-perf-lane.test.ts` feeds these fixtures to the **real**
 * `createRootDungeon`/`addLinkedRooms`/`generateDungeonMap` and asserts the room count
 * and placement match, so a drift between this shape and the production graph schema is
 * a red `npm test` rather than a lane that quietly renders the wrong thing.
 *
 * ## Determinism
 *
 * Every value is a literal or a function of the room count. There is no clock, no
 * `Math.random`, no locale, and no environment read. Two runs over the same room count
 * produce byte-identical JSON, and the lane records the fixture's own digest so a
 * reader can tell which fixture produced a measurement.
 *
 * ## The graph the fixture builds
 *
 * A root room with `rooms - 1` direct `subtopic` children — the same flat,
 * root-plus-children shape the 100-room test in
 * `tests/phase13/dungeon-navigation-parity.test.ts` uses, and the shape the flat-floor
 * model in `computeFloorVisibility` treats as one fully visible floor. For 100 rooms
 * that is a 99-corridor world, which is the plan's "genuinely large" fixture rather
 * than a handful of stubs.
 *
 * ## Privacy
 *
 * Every id, topic, and timestamp is synthetic. There is no learner data, no real
 * subject, no attachment, no note, and no free-form text beyond generated topic labels
 * of the form `Perf Fixture Room N`.
 */

/** The fixture's schema version, independent of the lane's evidence schema. */
export const PIXI_PERF_FIXTURE_SCHEMA_VERSION = 1;

/**
 * The three world sizes the phase's scope names: 1-room, 10-room, and 100-room.
 *
 * Ordered smallest first so the lane's own output reads as a build-up, and frozen so
 * a caller cannot reshape it.
 */
export const PIXI_PERF_ROOM_COUNTS = Object.freeze([1, 10, 100] as const);

/**
 * The fixture seed family.
 *
 * A single named constant rather than a per-run random string, because the fixture's
 * whole value is that it is the same world on every run. It is not used to seed a
 * pseudo-random layout — the graph is fully determined by `rooms` — but it names the
 * fixture family in ids and in the recorded digest.
 */
export const PIXI_PERF_FIXTURE_SEED = 'kd-perf-fixture-v1' as const;

/** The fixed creation timestamp, so no run depends on the clock. */
export const PIXI_PERF_FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z' as const;

/**
 * The id the fixture masquerades under, and the storage key it occupies.
 *
 * The lane enters the world through the application's own "Start Tutorial" control,
 * which mints a *small* tutorial subject and then loads `tutorial-first-walkthrough`
 * from storage. The lane seeds its synthetic snapshot at that key and refuses the
 * tutorial's own write to it (see `pixiPerf.spec.ts`), so the world the application
 * mounts is this fixture. Reusing the app's own entry path is deliberate: the lane
 * exercises the product's real Start-Tutorial → dungeon route rather than a bespoke
 * one.
 */
export const PIXI_PERF_SUBJECT_ID = 'tutorial-first-walkthrough' as const;
export const PIXI_PERF_SUBJECT_STORAGE_KEY = `knowledge-dungeon:v1:subject:${PIXI_PERF_SUBJECT_ID}`;
export const PIXI_PERF_SUBJECT_INDEX_KEY = 'knowledge-dungeon:v1:subjects';
export const PIXI_PERF_ACTIVE_SUBJECT_KEY = 'knowledge-dungeon:v1:activeSubjectId';

/** The property names the app's legacy storage uses, declared once here. */
export const PERF_STORAGE_KEYS = Object.freeze({
  subject: PIXI_PERF_SUBJECT_STORAGE_KEY,
  index: PIXI_PERF_SUBJECT_INDEX_KEY,
  active: PIXI_PERF_ACTIVE_SUBJECT_KEY,
});

export interface PerfFixtureRoomSummary {
  readonly roomId: string;
  readonly topic: string;
  readonly status: string;
}

export interface PerfFixtureEdge {
  readonly fromRoomId: string;
  readonly toRoomId: string;
  readonly relationType: 'subtopic';
  readonly createdAt: string;
  readonly createdByPhase: 'Creator';
}

export interface PerfFixtureRoomMetadata {
  readonly roomId: string;
  readonly topic: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: string;
  readonly notePath: string;
  readonly artifactPath: string;
  readonly noteText: string;
  readonly artifactMarkdown: null;
  readonly validationState: {
    readonly wordCount: number;
    readonly requiredSectionsPresent: boolean;
    readonly manualConfirmed: boolean;
    readonly criterionScores: {
      readonly sectionCompleteness: number;
      readonly conceptTermCoverage: number;
      readonly linkReferences: number;
      readonly recallQuestionQuality: number;
      readonly clarityReadability: number;
    };
    readonly failedChecks: readonly string[];
    readonly qualityBonus: number;
    readonly finalPass: boolean;
  };
  readonly reviewPassCount: number;
  readonly attachments: readonly unknown[];
}

export interface PerfFixtureSnapshot {
  readonly dungeon: {
    readonly schemaVersion: string;
    readonly dungeonId: string;
    readonly subjectName: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly phaseState: string;
    readonly rootRoomId: string;
    readonly rooms: readonly PerfFixtureRoomSummary[];
    readonly edges: readonly PerfFixtureEdge[];
    readonly progression: {
      readonly xpTotal: number;
      readonly rank: string;
      readonly badges: readonly string[];
      readonly fishCollection: readonly unknown[];
    };
  };
  readonly rooms: Readonly<Record<string, PerfFixtureRoomMetadata>>;
}

/** The root room id for a fixture of this size. */
export function perfRootRoomId(rooms: number): string {
  return `${PIXI_PERF_FIXTURE_SEED}-${rooms}-root`;
}

/** The id of child `index` (0-based) for a fixture of this size. */
export function perfChildRoomId(rooms: number, index: number): string {
  return `${PIXI_PERF_FIXTURE_SEED}-${rooms}-r${index}`;
}

/**
 * Build the deterministic synthetic subject for `rooms` rooms.
 *
 * `rooms` counts the root, so `1` is a lone root, `10` is a root plus nine children,
 * and `100` is a root plus ninety-nine. A non-integer or a count below one throws,
 * because a fixture that silently produced a different size than its label is worse
 * than one that fails.
 */
export function buildPerfSubjectSnapshot(rooms: number): PerfFixtureSnapshot {
  if (!Number.isInteger(rooms) || rooms < 1) {
    throw new Error(`A perf fixture needs a positive integer room count, received ${String(rooms)}.`);
  }

  const rootRoomId = perfRootRoomId(rooms);
  const roomMetadata: Record<string, PerfFixtureRoomMetadata> = {};
  const roomSummaries: PerfFixtureRoomSummary[] = [];
  const edges: PerfFixtureEdge[] = [];

  const emptyValidation = {
    wordCount: 0,
    requiredSectionsPresent: false,
    manualConfirmed: false,
    criterionScores: {
      sectionCompleteness: 0,
      conceptTermCoverage: 0,
      linkReferences: 0,
      recallQuestionQuality: 0,
      clarityReadability: 0,
    },
    failedChecks: [] as readonly string[],
    qualityBonus: 0,
    finalPass: false,
  };

  const makeMetadata = (roomId: string, topic: string): PerfFixtureRoomMetadata => ({
    roomId,
    topic,
    createdAt: PIXI_PERF_FIXTURE_TIMESTAMP,
    updatedAt: PIXI_PERF_FIXTURE_TIMESTAMP,
    state: 'Created',
    notePath: '',
    artifactPath: '',
    noteText: '',
    artifactMarkdown: null,
    validationState: { ...emptyValidation },
    reviewPassCount: 0,
    attachments: [],
  });

  const rootTopic = `Perf Fixture Root (${rooms})`;
  roomSummaries.push({ roomId: rootRoomId, topic: rootTopic, status: 'Created' });
  roomMetadata[rootRoomId] = makeMetadata(rootRoomId, rootTopic);

  for (let index = 0; index < rooms - 1; index += 1) {
    const roomId = perfChildRoomId(rooms, index);
    const topic = `Perf Fixture Room ${index}`;
    roomSummaries.push({ roomId, topic, status: 'Created' });
    roomMetadata[roomId] = makeMetadata(roomId, topic);
    edges.push({
      fromRoomId: rootRoomId,
      toRoomId: roomId,
      relationType: 'subtopic',
      createdAt: PIXI_PERF_FIXTURE_TIMESTAMP,
      createdByPhase: 'Creator',
    });
  }

  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: PIXI_PERF_SUBJECT_ID,
      subjectName: `Synthetic Perf Fixture (${rooms} rooms)`,
      createdAt: PIXI_PERF_FIXTURE_TIMESTAMP,
      updatedAt: PIXI_PERF_FIXTURE_TIMESTAMP,
      phaseState: 'CreatorActive',
      rootRoomId,
      rooms: roomSummaries,
      edges,
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: roomMetadata,
  };
}

/**
 * A stable, content-derived digest of a fixture, for the evidence record.
 *
 * Not a cryptographic commitment to anything secret — every byte is synthetic and
 * published — but a short identity that lets two runs be compared and a reader confirm
 * that the 100-room measurement was made against the 100-room fixture. FNV-1a over the
 * JSON text, rendered as eight lowercase hex digits, with no dependency.
 */
export function fixtureDigest(snapshot: PerfFixtureSnapshot): string {
  const text = JSON.stringify(snapshot);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
