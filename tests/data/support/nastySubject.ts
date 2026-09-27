/**
 * A subject nastier than any fixture Phase 5 shipped, for the Phase 6 gates.
 *
 * Phase 5's `populatedDevice.ts` is realistic. This module is **adversarial**, and
 * every one of its hazards exists because a plausible implementation of copy-mode
 * remapping gets it wrong:
 *
 * - **A room id that is a substring of another.** `room-1` and `room-1a` sit in the
 *   same subject, both appear in the same `tagIndex` array, both appear in the same
 *   session's `roomsVisited`, and each room's `notePath` embeds its own id. A
 *   substring-based rewrite corrupts all four at once. This is the same class of bug
 *   Phase 5's `custom-sprites` member-path gate covers for member names.
 * - **A room id made of regular-expression and dot metacharacters**,
 *   `room.(x)[1]{2}+?*`. Any implementation that builds a `RegExp` from an id has to
 *   escape it, and an implementation that escapes it wrongly still fails here.
 * - **A room id containing a non-ASCII astral character**, `chambre-🌊-1`, so
 *   code-unit comparisons and `String.prototype` slicing are exercised on a pair.
 * - **A room id that is also a tag name**, `cozy-hearth`, which appears as a
 *   `tagIndex` **key** and in two rooms' `tags` arrays. A rewrite that renames object
 *   keys renames a learner's tag; a rewrite that sweeps values renames the tag's
 *   occurrences. Both must leave the tag alone and rewrite the room ids inside it.
 * - **A room topic and a subject name that are literally another room's id**, so the
 *   "protected learner-authored text" rule is tested against a case where the
 *   *wrong* answer and the *right* answer differ visibly.
 * - **A room id that is an `Object.prototype` name**, `__proto__`. A `rooms` map
 *   rebuilt with `{}` loses it silently; the copy's room count is the assertion that
 *   catches that.
 * - **An unknown app-owned field holding a room id at six levels** - top level,
 *   dungeon, edge, room, validation state, room attachment - so "preserve unknown
 *   fields" and "remap unknown fields" are tested at once, and a rewrite that
 *   rebuilds a record from a field list fails visibly.
 * - **An unknown field holding a room id inside a `notePath`-shaped string** and one
 *   holding a room id as prose, which is the *disclosed residual* case.
 * - **Unicode and emoji in a topic and in a note body**, so nothing may be treated
 *   as ASCII.
 * - **Fish, collected notes, and loot ids** in the progression record, so the
 *   progression side of the mapping is not vacuous, plus a `crossSubjectAchievements`
 *   list and an `extraFields` entry.
 * - **A stored attachment with bytes, an external-only attachment with none, and a
 *   room whose own `attachments[]` names an id no metadata record has** - the Phase 0
 *   fixture's shape, which is the case where an id exists in the subject but in no
 *   record.
 * - **A second subject on the same device**, so "no unrelated subject changed" and
 *   "the copy shares no id with the source" both have something to be true about.
 *
 * Everything is built through the **real** production path - `openStorageV2Repository`,
 * `stageGeneration`, `activateGeneration` - and the fixture then requires
 * `validateGeneration` to be clean, so "realistic" is a measured property here too and
 * not a claim. The suite then requires the device's own `validateGeneration` to
 * report no blocking problem, so a hazard that storage-v2 itself refuses would fail
 * the fixture rather than silently weaken the gates.
 *
 * Privacy: every string is synthetic and self-describing. The learner-content marker
 * from `./marker` is planted in a subject name, a room topic, a note body, an
 * attachment filename, and an attachment's alt text, so the privacy gate's absence
 * assertions cannot be satisfied by an empty surface. The only host named anywhere is
 * the reserved `example.invalid`.
 */

import 'fake-indexeddb/auto';

import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import { openStorageV2Repository } from '@/services/persistence/v2/repository';
import type { GenerationRecordValues } from '@/services/persistence/v2/validation';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type AssistanceRecordValue,
  type MigrationReceiptValue,
  type PreferenceRecordValue,
  type ProgressionRecordValue,
  type RecoveryRecordValue,
  type SessionRecordValue,
  type ShortcutRecordValue,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import { canonicalProgressionShapeFor } from './progressionShape';
import { platformSha256 } from './hashes';
import {
  MARKER_ARTIFACT_BODY,
  MARKER_ATTACHMENT_ALT_TEXT,
  MARKER_ATTACHMENT_FILE_NAME,
  MARKER_NOTE_BODY,
  MARKER_ROOM_TOPIC,
  MARKER_SUBJECT_NAME,
} from './marker';
import { resetLegacyStorage } from './populatedDevice';

// ── Fixed identities and clocks ────────────────────────────────────────────

/** The device clock. Distinct from the determinism clock on purpose. */
export const NASTY_DEVICE_NOW = '2026-09-26T00:00:00.000Z';

/**
 * The clock the determinism gate injects.
 *
 * Chosen to be nowhere near either the device clock or any plausible wall clock,
 * so a test that "passed" because the wall clock happened to agree could not exist:
 * the ZIP member timestamps are derived from this value, and if the product read
 * the wall clock the two exports would differ.
 */
export const NASTY_DETERMINISM_NOW = '2011-03-04T05:06:07.000Z';

export const NASTY_GENERATION_ID = 'gen-data-gate-nasty';
export const NASTY_PRIOR_GENERATION_ID = 'gen-data-gate-nasty-prior';
export const NASTY_SUBJECT_ID = 'subject-data-gate-nasty';
export const NASTY_OTHER_SUBJECT_ID = 'subject-data-gate-nasty-other';

/**
 * The room ids, one hazard each.
 *
 * `prototype` is `__proto__` on purpose: it is the one name that cannot be an
 * ordinary own key of an object literal-assigned map, so a `rooms` rebuild that uses
 * `{}` and index assignment loses the room without an error. The gates assert the
 * copy's room **count**, which is the only way to notice.
 */
export const NASTY_ROOM_IDS = {
  /** A room id that is a strict prefix of `substringSibling`. */
  substring: 'room-1',
  /** A room id that has `substring` as a strict prefix. */
  substringSibling: 'room-1a',
  /** Regex and dot metacharacters, unescaped. */
  metachar: 'room.(x)[1]{2}+?*',
  /** An astral-plane non-ASCII character. */
  unicode: 'chambre-\u{1F30A}-1',
  /** Identical to a tag name the learner chose. */
  tagNamed: 'cozy-hearth',
  /** An `Object.prototype` name. */
  prototype: '__proto__',
} as const;

export type NastyRoomKey = keyof typeof NASTY_ROOM_IDS;

/** Every room id, in a fixed order. */
export const NASTY_ROOM_LIST: readonly string[] = Object.values(NASTY_ROOM_IDS);

/**
 * Tags, two of which are also room ids.
 *
 * A correct rewrite leaves every one of these exactly as it is. That is the whole
 * assertion: "a room id that collides with a tag name must survive".
 */
export const NASTY_TAGS: readonly string[] = [
  'room-1',
  'cozy-hearth',
  'synthetic-tag',
];

/**
 * A room topic that is *literally another room's id*.
 *
 * Applied to the `room-1a` room, so the topic is simultaneously a different room's
 * identifier and a **strict prefix of the room that carries it**. If the
 * protected-text rule breaks, this becomes a minted room id; if the substring rule
 * breaks, the `room-1a` room's own `notePath` becomes `rooms/<mapped room-1>/...`.
 * Neither failure is visible anywhere else in the fixture.
 */
export const NASTY_ROOM_TOPIC_EQUALS_A_ROOM_ID = NASTY_ROOM_IDS.substring;

/**
 * A subject name that *begins with* a room id, and carries the learner-content marker.
 *
 * The prefix is the assertion - a value-sweep rewrite would replace it and the name
 * would start `kc-room-` - and the marker is what the privacy gate needs, since a
 * subject name is one of the surfaces plan section 12 rule 6 protects.
 */
export const NASTY_SUBJECT_NAME_EQUALS_A_ROOM_ID = `${NASTY_ROOM_IDS.metachar} ${MARKER_SUBJECT_NAME}`;

export const NASTY_ATTACHMENT_IDS = {
  /** Bytes on the device; the archive carries them. */
  stored: 'att-data-gate-nasty-stored',
  /** A URL the application never fetches; no bytes anywhere. */
  external: 'att-data-gate-nasty-external',
  /**
   * Named by a room's own `attachments[]` and by **no** metadata record, exactly as
   * the Phase 0 fixture does. Its id must still not be shared with the source.
   */
  orphanInSnapshot: 'att-data-gate-nasty-orphan',
} as const;

/** The reserved host, and the only URL in this suite. */
export const NASTY_EXTERNAL_URL = 'https://example.invalid/data-gate-nasty-external.png';

export const NASTY_OTHER_ROOT_ROOM_ID = 'room-data-gate-nasty-other-root';

// ── Synthetic payload ──────────────────────────────────────────────────────

/** A 1x1 PNG, byte for byte. */
const SYNTHETIC_PNG: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

/** Real payload bytes for the stored attachment, with their real digest. */
export function nastyPayload(): { bytes: Uint8Array; contentHash: string } {
  const bytes = new Uint8Array(SYNTHETIC_PNG);
  return { bytes, contentHash: platformSha256(bytes) };
}

// ── The subject snapshot ───────────────────────────────────────────────────

function room(input: {
  readonly roomId: string;
  readonly topic: string;
  readonly noteText: string;
  readonly artifactMarkdown: string;
  readonly noteFile: string;
  readonly attachments: readonly Record<string, unknown>[];
  readonly extra: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    roomId: input.roomId,
    topic: input.topic,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: NASTY_DEVICE_NOW,
    state: 'ArtifactCollected',
    // The room's own id, embedded in a path, in both the legacy `.md` spelling the
    // Phase 0 fixture uses and the `.txt` spelling `makeEmptyRoomMetadata` writes.
    notePath: `rooms/${input.roomId}/notes.md`,
    artifactPath: `rooms/${input.roomId}/artifact.md`,
    noteText: input.noteText,
    artifactMarkdown: input.artifactMarkdown,
    validationState: {
      wordCount: 24,
      requiredSectionsPresent: true,
      manualConfirmed: true,
      criterionScores: {
        sectionCompleteness: 5,
        conceptTermCoverage: 5,
        linkReferences: 5,
        recallQuestionQuality: 5,
        clarityReadability: 5,
      },
      failedChecks: [],
      qualityBonus: 5,
      finalPass: true,
      // Unknown app-owned field holding a room id, at the validation level.
      fixtureValidationField: NASTY_ROOM_IDS.metachar,
    },
    reviewPassCount: 1,
    sm2QualityResponse: 4,
    sm2EaseFactor: 2.5,
    sm2IntervalDays: 3,
    sm2NextReviewDate: '2026-03-01T00:00:00.000Z',
    sm2ConsecutiveCorrect: 2,
    tags: [...NASTY_TAGS],
    attachments: input.attachments.map((attachment) => ({ ...attachment })),
    // Unknown app-owned field holding a room id, at the room level.
    fixtureRoomField: input.roomId,
    // An unknown field holding a room id inside a path-shaped string, and one
    // holding a room id as prose. The path is rewritten by the segment rule; the
    // prose is the disclosed residual.
    fixtureRoomPointerField: `rooms/${input.roomId}/notes.md`,
    fixtureRoomProseField: `open ${input.roomId} before the next room`,
  };
}

/**
 * The nasty snapshot.
 *
 * The `rooms` map is built with `Object.create(null)` and a null-prototype
 * assignment, because `JSON.parse` is the only other way to get a `__proto__` own
 * key and this is clearer about intent. Both routes produce the same own key, and
 * the gates assert the room count either way.
 */
export function nastySnapshot(): SubjectSnapshot {
  const rootAttachments = [
    {
      attachmentId: NASTY_ATTACHMENT_IDS.stored,
      sourceType: 'local',
      fileName: MARKER_ATTACHMENT_FILE_NAME,
      mimeType: 'image/png',
      altText: MARKER_ATTACHMENT_ALT_TEXT,
      addedAt: NASTY_DEVICE_NOW,
      // Unknown app-owned field at the attachment level, holding a room id.
      fixtureAttachmentField: NASTY_ROOM_IDS.tagNamed,
    },
    {
      attachmentId: NASTY_ATTACHMENT_IDS.orphanInSnapshot,
      sourceType: 'local',
      fileName: 'synthetic-nasty-orphan-in-snapshot.png',
      mimeType: 'image/png',
      altText: 'synthetic alt text for the orphan attachment',
      addedAt: NASTY_DEVICE_NOW,
    },
  ];

  const rooms: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  rooms[NASTY_ROOM_IDS.substring] = room({
    roomId: NASTY_ROOM_IDS.substring,
    topic: MARKER_ROOM_TOPIC,
    noteText: MARKER_NOTE_BODY,
    artifactMarkdown: MARKER_ARTIFACT_BODY,
    noteFile: 'notes.md',
    attachments: rootAttachments,
    extra: {},
  });
  rooms[NASTY_ROOM_IDS.substringSibling] = room({
    roomId: NASTY_ROOM_IDS.substringSibling,
    // A topic that is *literally another room's id*. If the protected-text rule
    // breaks, this becomes a remapped id and the gate sees it.
    topic: NASTY_ROOM_TOPIC_EQUALS_A_ROOM_ID,
    noteText: `A note for the room whose id is a prefix of another. \u{1F40D}`,
    artifactMarkdown: '# Synthetic sibling artifact\n',
    noteFile: 'notes.md',
    attachments: [],
    extra: {},
  });
  rooms[NASTY_ROOM_IDS.metachar] = room({
    roomId: NASTY_ROOM_IDS.metachar,
    topic: 'Synthetic metacharacter topic',
    noteText: 'Synthetic note for the metacharacter room.',
    artifactMarkdown: '# Synthetic metacharacter artifact\n',
    noteFile: 'notes.md',
    attachments: [],
    extra: {},
  });
  rooms[NASTY_ROOM_IDS.unicode] = room({
    roomId: NASTY_ROOM_IDS.unicode,
    topic: 'Synthetic unicode topic \u{1F9EA}',
    noteText: 'Synthetic unicode note \u{1F4A1}.',
    artifactMarkdown: '# Synthetic unicode artifact\n',
    noteFile: 'notes.md',
    attachments: [
      {
        attachmentId: NASTY_ATTACHMENT_IDS.external,
        sourceType: 'external',
        fileName: 'synthetic-nasty-external.png',
        mimeType: 'image/png',
        externalUrl: NASTY_EXTERNAL_URL,
        altText: 'synthetic external alt text',
        addedAt: NASTY_DEVICE_NOW,
      },
    ],
    extra: {},
  });
  rooms[NASTY_ROOM_IDS.tagNamed] = room({
    roomId: NASTY_ROOM_IDS.tagNamed,
    topic: 'Synthetic tag-named room topic',
    noteText: 'Synthetic note for the room that shares its id with a tag.',
    artifactMarkdown: '# Synthetic tag-named artifact\n',
    noteFile: 'notes.md',
    attachments: [],
    extra: {},
  });
  rooms[NASTY_ROOM_IDS.prototype] = room({
    roomId: NASTY_ROOM_IDS.prototype,
    topic: 'Synthetic prototype-name room topic',
    noteText: 'Synthetic note for the room whose id is a prototype name.',
    artifactMarkdown: '# Synthetic prototype-name artifact\n',
    noteFile: 'notes.md',
    attachments: [],
    extra: {},
  });

  return {
    // An unknown top-level field holding a room id, and one that is a
    // `notePath`-shaped string, and one holding a tag name that is also a room id.
    unknownTopLevelField: NASTY_ROOM_IDS.unicode,
    unknownTopLevelPathField: `rooms/${NASTY_ROOM_IDS.metachar}/notes.md`,
    unknownTopLevelProseField: `the room called ${NASTY_ROOM_IDS.metachar} is the tricky one`,
    fixtureFormat: 'knowledge-dungeon-phase-6-synthetic',
    dungeon: {
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      dungeonId: NASTY_SUBJECT_ID,
      subjectName: NASTY_SUBJECT_NAME_EQUALS_A_ROOM_ID,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: NASTY_DEVICE_NOW,
      phaseState: 'ArchaeologistActive',
      rootRoomId: NASTY_ROOM_IDS.substring,
      rooms: NASTY_ROOM_LIST.map((roomId) => ({
        roomId,
        topic: roomId === NASTY_ROOM_IDS.substring ? MARKER_ROOM_TOPIC : `Synthetic topic for ${roomId}`,
        status: 'ArtifactCollected',
      })),
      // Every edge endpoint, including both members of the substring pair and the
      // prototype-named room, so the whole map is exercised.
      edges: [
        {
          fromRoomId: NASTY_ROOM_IDS.substring,
          toRoomId: NASTY_ROOM_IDS.substringSibling,
          relationType: 'subtopic',
          createdAt: '2026-02-01T00:00:00.000Z',
          createdByPhase: 'Creator',
          // Unknown field holding a room id, at the edge level.
          fixtureEdgeField: NASTY_ROOM_IDS.tagNamed,
        },
        {
          fromRoomId: NASTY_ROOM_IDS.substringSibling,
          toRoomId: NASTY_ROOM_IDS.metachar,
          relationType: 'analogy',
          createdAt: '2026-02-01T00:00:00.000Z',
          createdByPhase: 'Scribe',
        },
        {
          fromRoomId: NASTY_ROOM_IDS.metachar,
          toRoomId: NASTY_ROOM_IDS.unicode,
          relationType: 'related',
          createdAt: '2026-02-01T00:00:00.000Z',
          createdByPhase: 'Scribe',
        },
        {
          fromRoomId: NASTY_ROOM_IDS.unicode,
          toRoomId: NASTY_ROOM_IDS.tagNamed,
          relationType: 'related',
          createdAt: '2026-02-01T00:00:00.000Z',
          createdByPhase: 'Scribe',
        },
        {
          fromRoomId: NASTY_ROOM_IDS.tagNamed,
          toRoomId: NASTY_ROOM_IDS.prototype,
          relationType: 'depends_on',
          createdAt: '2026-02-01T00:00:00.000Z',
          createdByPhase: 'Scribe',
        },
        {
          fromRoomId: NASTY_ROOM_IDS.prototype,
          toRoomId: NASTY_ROOM_IDS.substring,
          relationType: 'prerequisite',
          createdAt: '2026-02-01T00:00:00.000Z',
          createdByPhase: 'Scribe',
        },
      ],
      progression: {
        xpTotal: 900,
        rank: 'Scholar',
        badges: ['synthetic-nasty-badge'],
        fishCollection: [
          {
            id: 'fish-data-gate-nasty-01',
            name: 'Synthetic Nasty Gate Fish',
            rarity: 'rare',
            subjectId: NASTY_SUBJECT_ID,
            subjectName: 'Synthetic Nasty Fish Subject Name',
            caughtAt: '2026-02-05T00:00:00.000Z',
            catalogId: 'catalog-data-gate-nasty-01',
          },
        ],
        fixtureProgressionField: NASTY_ROOM_IDS.prototype,
      },
      biome: 'cozy-hearth',
      tagIndex: {
        // Two of the three keys are room ids as well. Both keys must survive; the
        // values must all be rewritten.
        [NASTY_TAGS[0] as string]: [NASTY_ROOM_IDS.substring, NASTY_ROOM_IDS.substringSibling],
        [NASTY_TAGS[1] as string]: [NASTY_ROOM_IDS.tagNamed],
        [NASTY_TAGS[2] as string]: [NASTY_ROOM_IDS.unicode],
      },
      // Unknown field holding a room id, at the dungeon level.
      fixtureDungeonField: NASTY_ROOM_IDS.substringSibling,
    },
    rooms,
  } as unknown as SubjectSnapshot;
}

/** The second subject on the device: unrelated, and it must never change. */
export function otherSubjectSnapshot(): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      dungeonId: NASTY_OTHER_SUBJECT_ID,
      subjectName: 'Synthetic Other Subject That Must Not Change',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: NASTY_DEVICE_NOW,
      phaseState: 'CreatorComplete',
      rootRoomId: NASTY_OTHER_ROOT_ROOM_ID,
      rooms: [
        {
          roomId: NASTY_OTHER_ROOT_ROOM_ID,
          topic: 'Synthetic other root topic',
          status: 'Created',
        },
      ],
      edges: [],
      progression: { xpTotal: 10, rank: 'Novice', badges: [], fishCollection: [] },
      biome: 'cozy-meadow',
      tagIndex: { 'other-tag': [NASTY_OTHER_ROOT_ROOM_ID] },
    },
    rooms: {
      [NASTY_OTHER_ROOT_ROOM_ID]: {
        roomId: NASTY_OTHER_ROOT_ROOM_ID,
        topic: 'Synthetic other root topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: NASTY_DEVICE_NOW,
        state: 'Created',
        notePath: `rooms/${NASTY_OTHER_ROOT_ROOM_ID}/notes.txt`,
        artifactPath: `rooms/${NASTY_OTHER_ROOT_ROOM_ID}/artifact.md`,
        noteText: '',
        artifactMarkdown: null,
        validationState: {
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
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: [],
        tags: ['other-tag'],
      },
    },
  } as unknown as SubjectSnapshot;
}

function stamp(subjectId: string, snapshot: SubjectSnapshot): SubjectRecordValue {
  return {
    subjectId,
    schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    snapshot,
    createdAt: '2026-01-04T03:04:05.000Z',
    updatedAt: NASTY_DEVICE_NOW,
  };
}

function nastyProgression(payload: { bytes: Uint8Array; contentHash: string }): ProgressionRecordValue {
  const shape = canonicalProgressionShapeFor({
    subjectId: NASTY_SUBJECT_ID,
    subjectName: 'Synthetic Nasty Progression Subject Name',
    xpTotal: 900,
    rank: 'Scholar',
    badgeCount: 2,
    fishCount: 2,
    reviewPasses: 3,
  });
  // The canonical shape's own entries, corrected to name this subject's rooms so the
  // record is internally consistent, and then given the hazards.
  const perSubject = {
    ...shape,
    subjectId: NASTY_SUBJECT_ID,
    // A `subjectName` that is literally a room id: protected text.
    subjectName: NASTY_ROOM_IDS.metachar,
    fishCollection: [
      {
        id: 'fish-data-gate-nasty-01',
        name: 'Synthetic Nasty Gate Fish',
        rarity: 'rare',
        subjectId: NASTY_SUBJECT_ID,
        // A fish `subjectName` that is a room id: protected text.
        subjectName: NASTY_ROOM_IDS.tagNamed,
        caughtAt: '2026-02-05T00:00:00.000Z',
        catalogId: 'catalog-data-gate-nasty-01',
      },
      {
        id: 'fish-data-gate-nasty-02',
        name: 'Synthetic Nasty Gate Fish Two',
        rarity: 'common',
        subjectId: NASTY_SUBJECT_ID,
        subjectName: 'Synthetic Nasty Gate Fish Two Subject',
        caughtAt: '2026-02-06T00:00:00.000Z',
        catalogId: 'catalog-data-gate-nasty-02',
      },
    ],
    collectedNotes: [
      {
        noteId: 'note-data-gate-nasty-01',
        dungeonId: NASTY_SUBJECT_ID,
        roomId: NASTY_ROOM_IDS.metachar,
        topic: 'Synthetic collected note topic',
        floorLabel: 'Floor 1',
        artifactPreview: 'Synthetic artifact preview.',
        noteMarkdown: '# Synthetic collected note\n',
        artifactMarkdown: '# Synthetic collected artifact\n',
        collectedAt: '2026-02-07T00:00:00.000Z',
      },
      {
        noteId: 'note-data-gate-nasty-02',
        dungeonId: NASTY_SUBJECT_ID,
        // The two rooms of the substring pair, in one note, so a substring rewrite
        // corrupts a collected note too.
        roomId: NASTY_ROOM_IDS.substring,
        topic: 'Synthetic second collected note topic',
        floorLabel: 'Floor 1',
        artifactPreview: 'Synthetic artifact preview.',
        noteMarkdown: '# Synthetic second collected note\n',
        artifactMarkdown: '# Synthetic second collected artifact\n',
        collectedAt: '2026-02-08T00:00:00.000Z',
      },
    ],
    inventory: [
      {
        id: 'loot-data-gate-nasty-01',
        name: 'Synthetic Nasty Ledger',
        description: 'A synthetic inventory entry.',
        rarity: 'rare',
        acquiredAt: '2026-02-09T00:00:00.000Z',
      },
    ],
    equippedItems: [
      {
        id: 'equip-data-gate-nasty-01',
        name: 'Synthetic Nasty Lantern',
        description: 'An equipped item.',
        rarity: 'epic',
        acquiredAt: '2026-02-10T00:00:00.000Z',
        equipSlot: 'weapon',
        equipped: true,
      },
    ],
    extraFields: {
      fixtureProgressionField: 'preserve-this-synthetic-progression-field',
      // An unknown field holding a room id, inside progression.
      fixtureProgressionRoomField: NASTY_ROOM_IDS.unicode,
    },
  };
  void payload;
  return {
    subjectId: NASTY_SUBJECT_ID,
    sourceVersion: 3,
    rank: 'Scholar',
    xpTotal: 900,
    bySubject: { [NASTY_SUBJECT_ID]: perSubject },
    crossSubjectAchievements: ['achievement-data-gate-nasty-first'],
  };
}

function nastySessions(): SessionRecordValue[] {
  const base = {
    startedAt: '2026-03-01T09:00:00.000Z',
    endedAt: '2026-03-01T09:30:00.000Z',
    notesSubmitted: 1,
    reviewsCompleted: 1,
    xpEarned: 90,
  };
  return [
    {
      sessionId: 'session-data-gate-nasty-0001',
      subjectId: NASTY_SUBJECT_ID,
      // A session whose `subjectName` is a room id: protected text.
      subjectName: NASTY_ROOM_IDS.tagNamed,
      eventId: 'event-data-gate-nasty-0001',
      ...base,
      // Both members of the substring pair, plus the prototype name, in one list.
      roomsVisited: [
        NASTY_ROOM_IDS.substring,
        NASTY_ROOM_IDS.substringSibling,
        NASTY_ROOM_IDS.prototype,
      ],
    },
    {
      sessionId: 'session-data-gate-nasty-0002',
      subjectId: NASTY_SUBJECT_ID,
      eventId: 'event-data-gate-nasty-0002',
      startedAt: '2026-03-02T09:00:00.000Z',
      endedAt: null,
      // A room the subject does not have: a disclosed reference, not a refusal.
      roomsVisited: [NASTY_ROOM_IDS.unicode, 'room-data-gate-nasty-vanished'],
      notesSubmitted: 0,
      reviewsCompleted: 0,
      xpEarned: 0,
    },
    {
      // A session for a subject that no longer exists. The export must not carry it,
      // and the device must keep it.
      sessionId: 'session-data-gate-nasty-orphan',
      subjectId: 'subject-data-gate-nasty-vanished',
      subjectName: 'Synthetic Vanished Subject',
      eventId: 'event-data-gate-nasty-orphan',
      ...base,
      roomsVisited: [],
    },
  ];
}

/** One assistance record. Assistance is not subject-keyed in the schema. */
export const NASTY_ASSISTANCE_ID = 'assistance-data-gate-nasty-0001';

function nastyAssistance(): AssistanceRecordValue[] {
  return [
    {
      assistanceId: NASTY_ASSISTANCE_ID,
      mode: 'gentle',
      signals: { hintRequests: 3, validationRetries: 1, idleSeconds: 120 },
      dismissalCount: 1,
      updatedAt: NASTY_DEVICE_NOW,
    },
  ];
}

function nastyAttachmentRecords(payload: {
  bytes: Uint8Array;
  contentHash: string;
}): { metadata: AttachmentMetadataRecordValue[]; blobs: AttachmentBlobRecordValue[] } {
  return {
    metadata: [
      {
        attachmentId: NASTY_ATTACHMENT_IDS.stored,
        subjectId: NASTY_SUBJECT_ID,
        roomId: NASTY_ROOM_IDS.substring,
        sourceType: 'local',
        mimeType: 'image/png',
        availability: 'stored',
        contentHash: payload.contentHash,
        fileName: MARKER_ATTACHMENT_FILE_NAME,
        altText: MARKER_ATTACHMENT_ALT_TEXT,
        addedAt: NASTY_DEVICE_NOW,
      },
      {
        attachmentId: NASTY_ATTACHMENT_IDS.external,
        subjectId: NASTY_SUBJECT_ID,
        roomId: NASTY_ROOM_IDS.unicode,
        sourceType: 'external',
        mimeType: 'image/png',
        availability: 'external-only',
        contentHash: null,
        fileName: 'synthetic-nasty-external.png',
        externalUrl: NASTY_EXTERNAL_URL,
        altText: 'synthetic external alt text',
        addedAt: NASTY_DEVICE_NOW,
      },
    ],
    blobs: [
      {
        attachmentId: NASTY_ATTACHMENT_IDS.stored,
        contentHash: payload.contentHash,
        bytes: payload.bytes.buffer.slice(
          payload.bytes.byteOffset,
          payload.bytes.byteOffset + payload.bytes.byteLength,
        ) as ArrayBuffer,
        byteLength: payload.bytes.byteLength,
        storedAt: NASTY_DEVICE_NOW,
      },
    ],
  };
}

function preferences(): PreferenceRecordValue[] {
  return [
    { preferenceId: 'locale', value: 'en-GB', updatedAt: NASTY_DEVICE_NOW },
    {
      preferenceId: 'graphics',
      value: { graphicsMode: 'rpg', colorTheme: 'aurora', activeSpritePack: null },
      updatedAt: NASTY_DEVICE_NOW,
    },
  ];
}

function shortcuts(): ShortcutRecordValue[] {
  return [
    { actionId: 'toggle-map', labelKey: 'shortcuts.toggleMap', key: 'm', ctrlKey: false, shiftKey: false },
  ];
}

function recovery(): RecoveryRecordValue[] {
  return [
    {
      kind: 'unindexed-subject',
      subjectId: 'subject-data-gate-nasty-unindexed',
      raw: '{"synthetic":"data-gate-nasty-recovery-payload"}',
      capturedAt: NASTY_DEVICE_NOW,
    },
  ];
}

function receipt(generationId: string): MigrationReceiptValue {
  return {
    receiptId: 'receipt-data-gate-nasty-0001',
    migrationId: 'legacy-localstorage-to-storage-v2',
    fromStorage: 'legacy-localstorage',
    toStorage: 'storage-v2',
    stagedGenerationId: generationId,
    previousActiveGenerationId: null,
    status: 'activated',
    createdAt: NASTY_DEVICE_NOW,
    storageGenerationFormatVersion: 1,
    subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    subjectSchemaVersions: { [CANONICAL_SUBJECT_SCHEMA_VERSION]: 2 },
    progressionSourceVersions: { '3': 2 },
    recordCounts: {
      meta: 0,
      subjects: 2,
      progression: 2,
      sessions: 3,
      preferences: 2,
      shortcuts: 1,
      assistance: 1,
      attachments: 3,
      customSprites: 0,
      recovery: 1,
      migrationReceipts: 1,
    },
    recordChecksums: {
      meta: '',
      subjects: '',
      progression: '',
      sessions: '',
      preferences: '',
      shortcuts: '',
      assistance: '',
      attachments: '',
      customSprites: '',
      recovery: '',
      migrationReceipts: '',
    },
    contentChecksum: '1'.repeat(64),
  };
}

// ── The device ─────────────────────────────────────────────────────────────

export interface NastyDevice {
  readonly repository: import('@/services/persistence/v2/repository').StorageV2Repository;
  readonly databaseName: string;
  readonly generationId: string;
  readonly priorGenerationId: string;
  readonly subjectId: string;
  readonly otherSubjectId: string;
  /** Real payload bytes for the stored attachment. */
  readonly payloadBytes: ReadonlyMap<string, Uint8Array>;
  /** The record values the nasty generation was staged from. */
  readonly staged: GenerationRecordValues;
  /** The progress record the other subject holds, which must never change. */
  readonly otherProgression: ProgressionRecordValue;
  /** Per-store record counts the gate asserts against. */
  readonly expectedRecordCounts: Readonly<Record<string, number>>;
}

/**
 * Stage and activate the nasty device: two subjects, every hazard, and a prior
 * generation so retention has something to retain.
 *
 * The legacy `localStorage` mirror is seeded too, so a fingerprint comparison is a
 * statement about real key/value bytes rather than an empty store.
 */
export async function createNastySubjectDevice(databaseName: string): Promise<NastyDevice> {
  resetLegacyStorage();
  const payload = nastyPayload();
  const subjects = [
    stamp(NASTY_SUBJECT_ID, nastySnapshot()),
    stamp(NASTY_OTHER_SUBJECT_ID, otherSubjectSnapshot()),
  ];
  const nasty = nastyProgression(payload);
  const otherProgression: ProgressionRecordValue = {
    subjectId: NASTY_OTHER_SUBJECT_ID,
    sourceVersion: 3,
    rank: 'Novice',
    xpTotal: 10,
    bySubject: {
      [NASTY_OTHER_SUBJECT_ID]: {
        subjectId: NASTY_OTHER_SUBJECT_ID,
        xpTotal: 10,
        rank: 'Novice',
        badges: [],
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
        extraFields: { otherField: 'preserve-this-synthetic-other-field' },
      },
    },
    crossSubjectAchievements: ['achievement-data-gate-other'],
  };
  const sessions = nastySessions();
  const attachments = nastyAttachmentRecords(payload);

  const staged: GenerationRecordValues = {
    subjects,
    progression: [nasty, otherProgression],
    sessions,
    preferences: preferences(),
    shortcuts: shortcuts(),
    assistance: nastyAssistance(),
    attachmentMetadata: attachments.metadata,
    attachmentBlobs: attachments.blobs,
    customSprites: [],
    recovery: recovery(),
    migrationReceipts: [receipt(NASTY_GENERATION_ID)],
  };

  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock(NASTY_DEVICE_NOW),
    idFactory: createDeterministicIdFactory('nasty'),
  });

  await repository.stageGeneration({
    generationId: NASTY_PRIOR_GENERATION_ID,
    source: 'legacy-migration',
    records: { subjects: [subjects[0] as SubjectRecordValue] },
  });
  await repository.activateGeneration(NASTY_PRIOR_GENERATION_ID);

  await repository.stageGeneration({
    generationId: NASTY_GENERATION_ID,
    source: 'local-edit',
    parentGenerationId: NASTY_PRIOR_GENERATION_ID,
    records: staged,
  });
  await repository.activateGeneration(NASTY_GENERATION_ID);

  window.localStorage.setItem(
    'knowledge-dungeon:v1:subjects',
    JSON.stringify(subjects.map((subject) => subject.subjectId)),
  );
  for (const subject of subjects) {
    window.localStorage.setItem(
      `knowledge-dungeon:v1:subject:${subject.subjectId}`,
      JSON.stringify(subject.snapshot),
    );
  }
  window.localStorage.setItem('knowledge-dungeon:v1:activeSubjectId', NASTY_SUBJECT_ID);
  window.localStorage.setItem('knowledge-dungeon:locale', 'en-GB');

  // Non-vacuity: the fixture must itself satisfy storage-v2's own activation rules,
  // or every gate built on it would be measuring a device the repository refuses.
  const validation = await repository.validateGeneration(NASTY_GENERATION_ID);
  if (!validation.ok) {
    throw new Error(
      `The nasty fixture does not validate: ${validation.problems
        .map((problem) => `${problem.severity}:${problem.scope}:${problem.code}:${problem.count}`)
        .join(',')}`,
    );
  }

  return {
    repository,
    databaseName,
    generationId: NASTY_GENERATION_ID,
    priorGenerationId: NASTY_PRIOR_GENERATION_ID,
    subjectId: NASTY_SUBJECT_ID,
    otherSubjectId: NASTY_OTHER_SUBJECT_ID,
    payloadBytes: new Map([[NASTY_ATTACHMENT_IDS.stored, payload.bytes]]),
    staged,
    otherProgression,
    expectedRecordCounts: {
      meta: 0,
      subjects: 2,
      progression: 2,
      sessions: 3,
      preferences: 2,
      shortcuts: 1,
      assistance: 1,
      attachments: 3,
      customSprites: 0,
      recovery: 1,
      migrationReceipts: 1,
    },
  };
}

/** The legacy store is cleared between gates; IndexedDB is per-database. */
export { resetLegacyStorage };
