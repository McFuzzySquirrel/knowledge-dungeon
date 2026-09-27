/**
 * Phase 7 verifier fixture: the nastiest subject this product could be handed.
 *
 * ## Why this file exists and shares nothing
 *
 * `tests/data/templateSubject.ts` is the implementers' fixture. Reusing it would only
 * re-test their assumptions about what a subject can carry, so this file is built from
 * the plan and the type declarations instead: every field plan section 7.3 puts on the
 * exclusion list is populated here, and the Phase 0 unknown-fields fixture is
 * re-identified with fresh markers on top of its own.
 *
 * ## The marker discipline
 *
 * Every piece of private content in this subject is a **unique** string carrying the
 * {@link MARK} prefix. The gates then do not assert "the right fields are present" -
 * they assert that **no marker appears anywhere in the emitted document**, which is a
 * falsifiable statement about the bytes rather than a description of a shape. A leak
 * through a field nobody enumerated still leaves a marker in the file, and a leak
 * through a permitted key that quietly aliases a forbidden one still leaves a marker.
 *
 * The markers are deliberately *also* used as values the product is expected to emit
 * (the room topics and the approved tags), because a template that is only private when
 * the subject is empty is not private. {@link PERMITTED_MARKERS} names those, and the
 * privacy gate checks for the forbidden set only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EDGE_PHASES,
  type EdgeCreatedByPhase,
  type EdgeRelationType,
  type SubjectSnapshot,
} from '@/core/validation/persistence/types';

/** Every private string in this fixture starts with this. */
export const MARK = 'P7-LEAK-CANARY-';

/**
 * The markers the product is *allowed* to emit, because plan section 7.3 permits room
 * topics and user-approved tags.
 *
 * Everything else carrying {@link MARK} is private and must not appear.
 */
export const PERMITTED_MARKERS: readonly string[] = [
  `${MARK}TOPIC-ROOT`,
  `${MARK}TOPIC-CHILD-A`,
  `${MARK}TOPIC-CHILD-B`,
  `${MARK}TOPIC-ORPHAN`,
  `${MARK}TAG-APPROVED-A`,
  `${MARK}TAG-APPROVED-B`,
];

/** Fixed clock for every deterministic read in the gates. */
export const NOW = '2026-09-27T09:00:00.000Z';

/** The room identifiers this fixture uses, deliberately unlike the subject's own. */
export const ROOM = {
  root: 'room-verifier-0001',
  childA: 'room-verifier-0002',
  childB: 'room-verifier-0003',
  orphan: 'room-verifier-0004',
} as const;

/** The subject's own identifier - the thing that must never reach a file. */
export const SUBJECT_ID = 'subject-verifier-7f3a91';

/** Approved tags: these two are what a caller passes to the exporter. */
export const APPROVED_TAGS: readonly string[] = [
  `${MARK}TAG-APPROVED-A`.toLowerCase(),
  `${MARK}TAG-APPROVED-B`.toLowerCase(),
];

/**
 * The subject's own tags, as the application would store them: the two approved ones
 * plus three that were never approved and must therefore never reach a file.
 */
const SUBJECT_TAGS = [
  `${MARK}TAG-APPROVED-A`.toLowerCase(),
  `${MARK}TAG-APPROVED-B`.toLowerCase(),
  `${MARK}TAG-SECRET-UNAPPROVED-1`.toLowerCase(),
  `${MARK}TAG-SECRET-UNAPPROVED-2`.toLowerCase(),
  `${MARK}TAG-SECRET-UNAPPROVED-3`.toLowerCase(),
];

/** A note body no template may carry. */
const NOTE_BODY = `${MARK}NOTE-BODY-the-summarised-version-of-my-own-work`;
/** An artifact body no template may carry. */
const ARTIFACT_BODY = `${MARK}ARTIFACT-BODY-my-written-answer`;
/** A draft no template may carry. */
const DRAFT_BODY = `${MARK}DRAFT-BODY-unsaved-scribe-draft`;
/** An attachment file name no template may carry. */
const ATTACHMENT_FILE_NAME = `${MARK}ATTACHMENT-FILENAME-private-photo.png`;
/** Alt text no template may carry. */
const ATTACHMENT_ALT_TEXT = `${MARK}ALT-TEXT-my-child-in-the-garden`;
/** An external URL no template may carry. */
const EXTERNAL_URL = `https://p7-leak-canary.example/${MARK}EXTERNAL-URL/path?q=1`;
/** Assistance history no template may carry. */
const ASSISTANCE_MARKER = `${MARK}ASSISTANCE-HISTORY`;
/** A recovery record no template may carry. */
const RECOVERY_MARKER = `${MARK}RECOVERY-RECORD`;
/** A custom sprite no template may carry. */
const CUSTOM_SPRITE_MARKER = `${MARK}CUSTOM-SPRITE-SVG-BODY`;
/** A migration receipt no template may carry. */
const MIGRATION_RECEIPT_MARKER = `${MARK}MIGRATION-RECEIPT`;
/** A progression / inventory / fish marker. */
const PROGRESSION_MARKER = `${MARK}PROGRESSION-XP`;
/** An SM-2 marker. */
const SM2_MARKER = `${MARK}SM2-REVIEW-SCHEDULE`;
/** A review-pass marker. */
const REVIEW_MARKER = `${MARK}REVIEW-PASS-COUNT`;
/** A validation-state marker. */
const VALIDATION_MARKER = `${MARK}VALIDATION-STATE`;

/** A room with everything on it, as a plain object. */
function fullRoom(
  roomId: string,
  topic: string,
  tags: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    roomId,
    topic,
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-02-03T04:05:06.000Z',
    state: 'ArtifactCollected',
    notePath: `rooms/${roomId}/notes.md`,
    artifactPath: `rooms/${roomId}/artifact.md`,
    noteText: NOTE_BODY,
    artifactMarkdown: ARTIFACT_BODY,
    draftText: DRAFT_BODY,
    validationState: {
      wordCount: 412,
      requiredSectionsPresent: true,
      manualConfirmed: true,
      criterionScores: {
        sectionCompleteness: 4,
        conceptTermCoverage: 3,
        linkReferences: 2,
        recallQuestionQuality: 5,
        clarityReadability: 4,
      },
      failedChecks: [VALIDATION_MARKER],
      qualityBonus: 12,
      finalPass: true,
      marker: VALIDATION_MARKER,
    },
    reviewPassCount: 7,
    reviewHistory: [REVIEW_MARKER],
    attachments: [
      {
        attachmentId: `${MARK}ATTACHMENT-ID-local`,
        sourceType: 'local',
        fileName: ATTACHMENT_FILE_NAME,
        mimeType: 'image/png',
        altText: ATTACHMENT_ALT_TEXT,
        byteLength: 2048,
        bytes: [0x89, 0x50, 0x4e, 0x47],
        addedAt: '2026-03-04T05:06:07.000Z',
      },
      {
        attachmentId: `${MARK}ATTACHMENT-ID-external`,
        sourceType: 'external',
        fileName: ATTACHMENT_FILE_NAME,
        mimeType: 'image/png',
        altText: ATTACHMENT_ALT_TEXT,
        externalUrl: EXTERNAL_URL,
        addedAt: '2026-03-04T05:06:08.000Z',
      },
    ],
    tags: [...tags],
    sm2QualityResponse: 5,
    sm2EaseFactor: 3.1,
    sm2IntervalDays: 21,
    sm2NextReviewDate: '2026-12-01T00:00:00.000Z',
    sm2ConsecutiveCorrect: 6,
    sm2Marker: SM2_MARKER,
    // The Phase 0 "unknown app-owned field" shape, re-identified per room.
    fixtureRoomField: `${MARK}UNKNOWN-ROOM-FIELD`,
    ...extra,
  };
}

export interface NastySubjectOptions {
  /** Change this to make the graph structurally identical but the identifiers different. */
  readonly subjectId?: string;
  /** Change this to permute which room id sits on which topic. */
  readonly roomIds?: { root: string; childA: string; childB: string; orphan: string };
  /** The biome the subject uses. `null` for a subject with none. */
  readonly biome?: string | null;
  /** The subject's own name. */
  readonly subjectName?: string;
  /** Extra top-level fields, for the unknown-field case. */
  readonly extraTopLevel?: Record<string, unknown>;
  /** Extra fields on the root room only, for the per-room unknown-field case. */
  readonly extraRootRoom?: Record<string, unknown>;
  /** Extra fields on `dungeon` itself. */
  readonly extraDungeon?: Record<string, unknown>;
}

/**
 * Build the nastiest subject this gate can describe.
 *
 * The graph is deliberately not trivial: a root with two children, one of which has
 * two cross-links, and one **orphan** room the root cannot reach, so the exporter's
 * "everything the root cannot reach" branch is exercised. The orphan has a topic and
 * tags like every other room, so it is a real part of the structure and must survive
 * into the file - which is what makes "the orphan is missing" a detectable loss rather
 * than an invisible one.
 */
export function nastySubject(options: NastySubjectOptions = {}): SubjectSnapshot {
  const subjectId = options.subjectId ?? SUBJECT_ID;
  const ids = options.roomIds ?? ROOM;
  const biome = options.biome === undefined ? `${MARK}BIOME` : options.biome;
  const subjectName = options.subjectName ?? `${MARK}SUBJECT-NAME`;

  const rootId = ids.root;
  const childA = ids.childA;
  const childB = ids.childB;
  const orphan = ids.orphan;

  const edges: Array<Record<string, unknown>> = [
    { fromRoomId: rootId, toRoomId: childA, relationType: 'subtopic', createdAt: '2026-01-02T03:04:05.000Z', createdByPhase: 'Creator' },
    { fromRoomId: rootId, toRoomId: childB, relationType: 'subtopic', createdAt: '2026-01-02T03:04:06.000Z', createdByPhase: 'Creator' },
    { fromRoomId: childA, toRoomId: childB, relationType: 'analogy', createdAt: '2026-01-02T03:04:07.000Z', createdByPhase: 'Scribe' },
    { fromRoomId: childB, toRoomId: childA, relationType: 'prerequisite', createdAt: '2026-01-02T03:04:08.000Z', createdByPhase: 'Archaeologist' },
    { fromRoomId: orphan, toRoomId: rootId, relationType: 'related', createdAt: '2026-01-02T03:04:09.000Z', createdByPhase: 'Creator' },
  ];

  const rooms: Record<string, unknown> = {
    [rootId]: fullRoom(rootId, `${MARK}TOPIC-ROOT`, SUBJECT_TAGS, options.extraRootRoom ?? {}),
    [childA]: fullRoom(childA, `${MARK}TOPIC-CHILD-A`, [SUBJECT_TAGS[0] as string, SUBJECT_TAGS[2] as string]),
    [childB]: fullRoom(childB, `${MARK}TOPIC-CHILD-B`, [SUBJECT_TAGS[1] as string]),
    [orphan]: fullRoom(orphan, `${MARK}TOPIC-ORPHAN`, SUBJECT_TAGS.slice(0, 2)),
  };

  return {
    fixtureFormat: 'knowledge-dungeon-phase-7-verifier',
    unknownTopLevelField: { marker: `${MARK}UNKNOWN-TOP-LEVEL-FIELD` },
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: subjectId,
      subjectName,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      phaseState: 'ArchaeologistActive',
      rootRoomId: rootId,
      rooms: [
        { roomId: rootId, topic: `${MARK}TOPIC-ROOT`, status: 'ArtifactCollected' },
        { roomId: childA, topic: `${MARK}TOPIC-CHILD-A`, status: 'ArtifactCollected' },
        { roomId: childB, topic: `${MARK}TOPIC-CHILD-B`, status: 'ArtifactCollected' },
        { roomId: orphan, topic: `${MARK}TOPIC-ORPHAN`, status: 'ArtifactCollected' },
      ],
      edges,
      progression: {
        xpTotal: 9871,
        rank: 'Scholar',
        badges: [PROGRESSION_MARKER],
        fishCollection: [
          { id: `${MARK}FISH-ID`, name: `${MARK}FISH-NAME`, rarity: 'epic', subjectId, subjectName, caughtAt: '2026-05-05T05:05:05.000Z' },
        ],
        inventory: [PROGRESSION_MARKER],
        marker: PROGRESSION_MARKER,
      },
      ...(biome === null ? {} : { biome }),
      tagIndex: {
        [`${MARK}tag-approved-a`.toLowerCase()]: [rootId, childA, orphan],
        [`${MARK}tag-approved-b`.toLowerCase()]: [rootId, orphan],
        [`${MARK}tag-secret-unapproved-1`.toLowerCase()]: [rootId],
      },
      assistance: { history: [ASSISTANCE_MARKER], marker: ASSISTANCE_MARKER },
      recovery: { records: [RECOVERY_MARKER], marker: RECOVERY_MARKER },
      customSprites: [{ id: `${MARK}SPRITE-ID`, svg: CUSTOM_SPRITE_MARKER }],
      migrationReceipts: [{ receiptId: `${MARK}RECEIPT-ID`, marker: MIGRATION_RECEIPT_MARKER }],
      reviewState: { marker: REVIEW_MARKER, sm2: SM2_MARKER },
      marker: `${MARK}UNKNOWN-DUNGEON-FIELD`,
      ...(options.extraDungeon ?? {}),
    },
    rooms,
    ...(options.extraTopLevel ?? {}),
  } as unknown as SubjectSnapshot;
}

/**
 * The Phase 0 unknown-fields fixture, re-identified.
 *
 * Loaded from `tests/fixtures/persistence` - a Phase 0 characterisation asset, not an
 * implementer fixture - and then given this gate's markers on every field a template
 * must exclude, so a leak out of a *real* legacy payload is distinguishable from a leak
 * out of a hand-built one.
 */
export function reidentifiedPhase0Subject(): SubjectSnapshot {
  const raw = readFileSync(
    join(process.cwd(), 'tests/fixtures/persistence/subject/subject-1.1.0-full-unknown-fields.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const dungeon = parsed.dungeon as Record<string, unknown>;
  const rooms = parsed.rooms as Record<string, Record<string, unknown>>;
  for (const [index, room] of Object.entries(rooms)) {
    room.noteText = `${MARK}P0-NOTE-${index}`;
    room.artifactMarkdown = `${MARK}P0-ARTIFACT-${index}`;
    room.notePath = `${MARK}P0-NOTEPATH-${index}`;
    room.artifactPath = `${MARK}P0-ARTIFACTPATH-${index}`;
    room.attachments = [
      {
        attachmentId: `${MARK}P0-ATTACHMENT-ID`,
        sourceType: 'external',
        fileName: `${MARK}P0-FILENAME`,
        mimeType: 'image/png',
        altText: `${MARK}P0-ALT`,
        externalUrl: `https://p7-leak-canary.example/${MARK}P0-URL`,
      },
    ];
    room.tags = [`${MARK}p0-tag`.toLowerCase()];
  }
  dungeon.subjectName = `${MARK}P0-SUBJECT-NAME`;
  dungeon.phaseState = 'ArchaeologistActive';
  return parsed as unknown as SubjectSnapshot;
}

/** Every marker this gate planted, minus the ones a template is allowed to carry. */
export function forbiddenMarkers(planted: readonly string[]): readonly string[] {
  return planted.filter((marker) => !PERMITTED_MARKERS.includes(marker));
}

/** A generator that returns `prefix-n`, so two mints are visibly different. */
export function countingGenerator(prefix: string): { next: () => string } {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-${String(counter).padStart(4, '0')}`;
    },
  };
}

/** The closed edge vocabularies, re-exported so a gate can build an edge without a cast. */
export const EDGE_RELATION = EDGE_RELATIONS();
function EDGE_RELATIONS(): readonly EdgeRelationType[] {
  return ['subtopic', 'analogy', 'prerequisite', 'related', 'depends_on'];
}
export const EDGE_PHASE: readonly EdgeCreatedByPhase[] = EDGE_PHASES;
