/**
 * The Phase 7 template fixture: a subject nastier than anything Phase 5 or Phase 6
 * shipped, plus a re-identified twin of it.
 *
 * ## Why this is a separate fixture and not a reuse of `nastySubject.ts`
 *
 * Phase 6's `nastySubject.ts` is adversarial about **identifier remapping**: substring
 * collisions, regex metacharacters, an `Object.prototype` room name, a room id that is
 * also a tag name. Every one of those hazards exists because a plausible copy-mode
 * rewrite gets it wrong. This phase has the opposite problem shape, and reusing that
 * fixture would test the wrong things:
 *
 * - The template exporter **never emits an identifier**, so a substring-collision room id
 *   has nothing to collide with. What matters here is that the id is *absent*, and a
 *   fixture full of exotic ids is a weaker demonstration of absence than one where every
 *   id is a distinctive, greppable token.
 * - The template exporter's real hazards are the **fields it must not read**. A privacy
 *   gate is only as strong as the surface it hides behind, and `nastySubject.ts` hides
 *   nothing a template could leak: it has no migration receipt on the room, no
 *   device-global record, no custom sprite, and its subject name is a *prefix* of a room
 *   id rather than a value that would be unmistakable in a file.
 *
 * So this fixture is built to be **maximally loud about the forbidden fields** and
 * **maximally quiet about identifiers**, and it carries three things the Phase 6 fixture
 * does not:
 *
 * 1. **The learner-content marker in every surface a template could possibly leak** -
 *    the subject name, a room topic, a note, an artifact, a validation `failedChecks`
 *    entry, an attachment filename, an attachment's alt text, an external URL, a
 *    recovery payload, a custom sprite's SVG body, a migration receipt's id - so the
 *    absence assertions cannot be satisfied by a surface that was empty anyway.
 * 2. **A re-identified twin.** {@link reidentifiedSnapshot} is the same graph with the
 *    same topics and the same tags, under a completely different set of identifiers.
 *    The byte-identity gate requires the two to export to the same bytes, which is only
 *    possible if no identifier reached the file - and the twin's ids are chosen so that a
 *    naive sort by room id would put the rooms in a *different* order, so the gate also
 *    fails an implementation that orders by id rather than by content.
 * 3. **The Phase 0 unknown-fields fixture, re-identified.** `unknownTopLevelField`,
 *    `unknownTopLevelPathField`, `unknownTopLevelProseField` and the `fixture*` fields
 *    Phase 0 established, with a value planted that is *both* a room id and a
 *    path-shaped string, so "preserve unknown app-owned fields" and "a template cannot
 *    carry one" are tested against the same record.
 *
 * ## Every field a template must exclude is present and non-empty
 *
 * The list below is the gate's non-vacuity control, and it is **measured** by
 * {@link forbiddenSurfacesAreActuallyPresent}, which walks the snapshot and reports which
 * of the named surfaces genuinely held something. A gate that asserted "the marker is
 * absent from the document" without first asserting "the marker was present in the
 * subject" would be satisfied by a fixture that leaked nothing because it held nothing.
 *
 * Privacy: every string is synthetic and self-describing. The only host named anywhere
 * is the reserved `example.invalid`, and no path in this file names a learner, a device,
 * or a real subject.
 */

import type {
  EdgeCreatedByPhase,
  EdgeRelationType,
  RoomState,
  SubjectSnapshot,
} from '@/core/validation/persistence/types';
import { CANONICAL_SUBJECT_SCHEMA_VERSION } from '@/services/persistence/v2/schema';
import { platformSha256 } from './hashes';
import {
  MARKER_ARTIFACT_BODY,
  MARKER_ATTACHMENT_ALT_TEXT,
  MARKER_ATTACHMENT_FILE_NAME,
  MARKER_NOTE_BODY,
  MARKER_ROOM_TOPIC,
  MARKER_SUBJECT_NAME,
  MARKER_TOKEN,
} from './marker';

// ── Clocks ─────────────────────────────────────────────────────────────────

/**
 * The clock the template gates inject.
 *
 * Nowhere near any plausible wall clock and nowhere near the device clock Phase 6 used,
 * so a gate that "passed" because the wall clock happened to agree could not exist.
 */
export const TEMPLATE_NOW = '2013-06-07T08:09:10.000Z';

/** A second clock, used only to prove the clock is a real input and not decoration. */
export const TEMPLATE_OTHER_NOW = '2047-11-12T13:14:15.000Z';

// ── Identifiers, which must never reach the document ───────────────────────

/**
 * Every identifier the fixture uses, and the distinctive token each one carries.
 *
 * The ids are deliberately **loud**: each carries a token that appears nowhere else in the
 * repository, so "no id leaked" is a claim about strings a gate can search for rather than
 * a claim about a structure.
 *
 * The `alpha` and `beta` sets are the two halves of the re-identified twin, and their
 * **sort orders are exact reverses**: alpha numbers its rooms 1-6 in declaration order and
 * beta numbers the same six rooms 6-1. An exporter that ordered its rooms by room id would
 * therefore emit the twin's rooms in *opposite* orders and fail the byte-identity gate by
 * the largest possible margin. A fixture whose two id sets sorted the same way would let
 * that bug pass silently, which is why the numbering reverses rather than merely differing
 * in its prefix - and the gate asserts the reversal rather than assuming it.
 */
export const TEMPLATE_IDS = {
  alpha: {
    subject: 'subject-7kq-template-alpha-0001',
    root: 'room-7kq-alpha-1-root',
    leaf: 'room-7kq-alpha-2-leaf',
    meta: 'room-7kq-alpha-3-meta',
    cross: 'room-7kq-alpha-4-cross',
    twin: 'room-7kq-alpha-5-twin',
    orphan: 'room-7kq-alpha-6-orphan',
    attachment: 'att-7kq-template-alpha-0001',
    session: 'session-7kq-template-alpha-0001',
  },
  beta: {
    subject: 'subject-zz-template-beta-9999',
    root: 'room-zz-beta-6-root',
    leaf: 'room-zz-beta-5-leaf',
    meta: 'room-zz-beta-4-meta',
    cross: 'room-zz-beta-3-cross',
    twin: 'room-zz-beta-2-twin',
    orphan: 'room-zz-beta-1-orphan',
    attachment: 'att-zz-template-beta-9999',
    session: 'session-zz-template-beta-9999',
  },
} as const;

export type TemplateIdSet = 'alpha' | 'beta';

/** One identifier set, by name. The two sets are the fixture's re-identified twins. */
export function templateIds(set: TemplateIdSet): (typeof TEMPLATE_IDS)[TemplateIdSet] {
  return TEMPLATE_IDS[set];
}

/**
 * The fixture's five rooms, in a fixed declaration order: root, leaf, meta, cross-link,
 * orphan. The order is the *label* order the fixture uses to build its `dungeon.rooms`
 * summaries, and it is deliberately **not** the order the rooms sort into under either
 * identifier set, so a summary list that were taken as the export order would fail the
 * byte-identity gate.
 */
export const TEMPLATE_ROOM_LABELS: readonly (keyof typeof TEMPLATE_IDS.alpha)[] = [
  'root',
  'leaf',
  'meta',
  'twin',
  'cross',
  'orphan',
];

/** Every identifier the `alpha` set uses, for the "no id anywhere" gate. */
export const ALPHA_IDENTIFIERS: readonly string[] = Object.values(TEMPLATE_IDS.alpha);

/** Every identifier the `beta` set uses. */
export const BETA_IDENTIFIERS: readonly string[] = Object.values(TEMPLATE_IDS.beta);

/**
 * The tag vocabulary the export gate approves, and the tags it deliberately does not.
 *
 * Two tags are **not** in the approved list, and both are planted in the subject's rooms.
 * That is the non-vacuity control for the approval step: a template exported with
 * `TEMPLATE_APPROVED_TAGS` must carry none of the others, and a template exported with
 * **no** approval request at all must carry none of *any* of them - which is the
 * assertion that hitting export is not the same as approving a tag.
 */
export const TEMPLATE_APPROVED_TAGS: readonly string[] = ['vectors', 'linear-algebra'];
export const TEMPLATE_UNAPPROVED_TAGS: readonly string[] = [MARKER_TOKEN, 'private-tag'];

/** A tag spelled the way a learner would type it, to exercise the normalisation rule. */
export const TEMPLATE_UNNORMALISED_TAG = 'Matrix Theory!';

/** The approved biome preference, and the one the subject itself carries. */
export const TEMPLATE_APPROVED_BIOME = 'cozy-meadow';
export const TEMPLATE_SUBJECT_BIOME = `${MARKER_TOKEN}-biome`;

/** The template's own name and description, both of which are approved content. */
export const TEMPLATE_NAME = `Synthetic Template Name ${MARKER_TOKEN}`;
export const TEMPLATE_DESCRIPTION = `Synthetic template description ${MARKER_TOKEN}`;

/** The external URL the subject carries, which the application never fetches. */
export const TEMPLATE_EXTERNAL_URL = `https://example.invalid/${MARKER_TOKEN}-external.png`;

/**
 * The SHA-256 of the fixture's four payload bytes.
 *
 * Real rather than a made-up 64-hex string, because storage-v2 refuses a blob record whose
 * `contentHash` is not the digest of its own bytes - and because a template must not
 * reference the *actual* digest of bytes that exist on the device, which is a stronger
 * assertion than "it did not carry a plausible-looking hash".
 */
export const TEMPLATE_BLOB_CONTENT_HASH = platformSha256(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
);

// ── The graph the fixture describes ────────────────────────────────────────

/**
 * The graph, declared once as data so the exporter, the importer and the gates all agree
 * on what "the same structure" means.
 *
 * Four structural edges, so the hierarchy is a real tree with a branching root rather
 * than a chain, and **no room with two `subtopic` parents** - which is the invariant the
 * product refuses to violate, and which this fixture therefore satisfies rather than
 * breaking.
 *
 * Three cross-links, every one with a relation type that is **not** `subtopic`: the
 * domain's own distinction between a hierarchy edge and a cross-link, and the reason the
 * document has two edge arrays. They use two of the four non-`subtopic` relation types and
 * two of the three authorship phases, so both closed vocabularies are exercised on values
 * the importer has to carry rather than default.
 *
 * One room - the orphan - is reachable **only** by a cross-link and has no `subtopic`
 * parent at all. That is not a defect in the fixture, it is the case the canonical order's
 * "then everything the root cannot reach" step exists for, and it gives the refinement pass
 * an incident edge to key on that is not a structure edge.
 */
export const TEMPLATE_STRUCTURE: ReadonlyArray<{
  readonly from: keyof typeof TEMPLATE_IDS.alpha;
  readonly to: keyof typeof TEMPLATE_IDS.alpha;
  readonly createdByPhase: EdgeCreatedByPhase;
}> = [
  { from: 'root', to: 'leaf', createdByPhase: 'Creator' },
  { from: 'root', to: 'twin', createdByPhase: 'Creator' },
  { from: 'root', to: 'meta', createdByPhase: 'Creator' },
  { from: 'leaf', to: 'cross', createdByPhase: 'Scribe' },
];

export const TEMPLATE_CROSS_LINKS: ReadonlyArray<{
  readonly from: keyof typeof TEMPLATE_IDS.alpha;
  readonly to: keyof typeof TEMPLATE_IDS.alpha;
  readonly relationType: EdgeRelationType;
  readonly createdByPhase: EdgeCreatedByPhase;
}> = [
  { from: 'cross', to: 'orphan', relationType: 'analogy', createdByPhase: 'Archaeologist' },
  { from: 'root', to: 'cross', relationType: 'related', createdByPhase: 'Scribe' },
  { from: 'meta', to: 'cross', relationType: 'analogy', createdByPhase: 'Creator' },
];

// ── The non-vacuity inventory ──────────────────────────────────────────────

/**
 * Every surface a template must exclude, with the value planted in it.
 *
 * Each entry is `{key, value, where}`: the key is a *field name* on some record, the value
 * is what is in it, and `where` says which record the value lives on. The `where` split is
 * real rather than cosmetic: plan section 7.3's exclusion list covers both the subject
 * snapshot ("notes, drafts, artifacts, validation, review state, SM-2 data") and things
 * that live beside it in storage-v2 ("progression, fish, inventory, assistance history"),
 * and a template that started from the snapshot alone could not demonstrate the second
 * half was excluded. So the gate stages the device-global records too and checks both.
 *
 * Every `value` is a **distinct** string. That is what makes each absence assertion
 * independent: with a shared value, one leaked field would fail one assertion and the
 * others would pass by accident, and the gate would be weaker than it reads.
 *
 * `key` is a field name and `value` is a planted string, and both are safe to put in a
 * test's own assertion messages: they are code-shaped or synthetic marker strings, never
 * a real subject, a real note, or a real path.
 */
export interface ForbiddenSurface {
  readonly key: string;
  readonly value: string;
  /** Which record the value is planted on. */
  readonly where: 'subject' | 'device';
  /** Why the plan excludes it, in the plan's own words where it has them. */
  readonly excludedBy: string;
}

export const FORBIDDEN_SUBJECT_SURFACES: readonly ForbiddenSurface[] = [
  { key: 'unknownTopLevelField', value: TEMPLATE_IDS.alpha.leaf, where: 'subject', excludedBy: 'original IDs' },
  {
    key: 'unknownTopLevelPathField',
    value: `rooms/${TEMPLATE_IDS.alpha.meta}/notes.md`,
    where: 'subject',
    excludedBy: 'private metadata',
  },
  {
    key: 'unknownTopLevelProseField',
    value: `see room ${MARKER_TOKEN}-prose`,
    where: 'subject',
    excludedBy: 'private metadata',
  },
  { key: 'fixtureDungeonField', value: `${MARKER_TOKEN}-dungeon`, where: 'subject', excludedBy: 'private metadata' },
  { key: 'fixtureRoomField', value: `${MARKER_TOKEN}-room`, where: 'subject', excludedBy: 'private metadata' },
  { key: 'fixtureEdgeField', value: `${MARKER_TOKEN}-edge`, where: 'subject', excludedBy: 'private metadata' },
  {
    key: 'fixtureValidationField',
    value: `${MARKER_TOKEN}-validation`,
    where: 'subject',
    excludedBy: 'private metadata',
  },
  { key: 'subjectName', value: MARKER_SUBJECT_NAME, where: 'subject', excludedBy: 'a subject name is not a permitted thing' },
  { key: 'noteText', value: MARKER_NOTE_BODY, where: 'subject', excludedBy: 'notes' },
  { key: 'artifactMarkdown', value: MARKER_ARTIFACT_BODY, where: 'subject', excludedBy: 'artifacts' },
  {
    key: 'notePath',
    value: `rooms/${TEMPLATE_IDS.alpha.root}/notes.md`,
    where: 'subject',
    excludedBy: 'original IDs',
  },
  {
    key: 'artifactPath',
    value: `rooms/${TEMPLATE_IDS.alpha.root}/artifact.md`,
    where: 'subject',
    excludedBy: 'original IDs',
  },
  { key: 'fileName', value: MARKER_ATTACHMENT_FILE_NAME, where: 'subject', excludedBy: 'filenames' },
  { key: 'altText', value: MARKER_ATTACHMENT_ALT_TEXT, where: 'subject', excludedBy: 'filenames' },
  { key: 'externalUrl', value: TEMPLATE_EXTERNAL_URL, where: 'subject', excludedBy: 'attachments' },
  {
    key: 'failedChecks',
    value: `${MARKER_TOKEN}-section-thin`,
    where: 'subject',
    excludedBy: 'validation',
  },
  { key: 'sm2NextReviewDate', value: '2031-01-01T00:00:00.000Z', where: 'subject', excludedBy: 'SM-2 data' },
];

/**
 * The surfaces that live **beside** the subject, in storage-v2's own stores.
 *
 * A template is produced from a snapshot, so a gate that only looked at the snapshot could
 * not show that the exclusion list's second half - progression, fish, inventory,
 * assistance history, custom sprites, recovery records, migration receipts - was honoured
 * rather than merely unimplemented. The gate stages these on a real device and requires
 * that none of their values reaches the document.
 */
export const FORBIDDEN_DEVICE_SURFACES: readonly ForbiddenSurface[] = [
  {
    key: 'fixtureProgressionField',
    value: `${MARKER_TOKEN}-progression`,
    where: 'device',
    excludedBy: 'progression',
  },
  {
    key: 'raw',
    value: `{"marker":"${MARKER_TOKEN}-recovery"}`,
    where: 'device',
    excludedBy: 'recovery records',
  },
  { key: 'content', value: `${MARKER_TOKEN}-sprite`, where: 'device', excludedBy: 'custom sprites' },
  {
    key: 'receiptId',
    value: `receipt-${MARKER_TOKEN}-receipt`,
    where: 'device',
    excludedBy: 'migration receipts',
  },
  {
    key: `${MARKER_TOKEN}-assist`,
    value: `${MARKER_TOKEN}-assist`,
    where: 'device',
    excludedBy: 'assistance history',
  },
  { key: 'eventId', value: `event-${MARKER_TOKEN}-event`, where: 'device', excludedBy: 'sessions' },
  { key: 'value', value: `en-GB-${MARKER_TOKEN}-pref`, where: 'device', excludedBy: 'preferences' },
  { key: 'contentHash', value: TEMPLATE_BLOB_CONTENT_HASH, where: 'device', excludedBy: 'attachments' },
  { key: 'fixtureFishField', value: `${MARKER_TOKEN}-fish`, where: 'device', excludedBy: 'fish' },
  { key: 'fixtureLootField', value: `${MARKER_TOKEN}-loot`, where: 'device', excludedBy: 'inventory' },
];

/** Both halves, for the gates that only need the whole inventory. */
export const FORBIDDEN_SURFACES: readonly ForbiddenSurface[] = [
  ...FORBIDDEN_SUBJECT_SURFACES,
  ...FORBIDDEN_DEVICE_SURFACES,
];

/**
 * Which of the **subject** surfaces this snapshot genuinely holds.
 *
 * The non-vacuity control, and it is measured rather than asserted from a comment. The
 * gate requires the result to be the whole subject inventory, so a fixture edit that
 * quietly emptied one of these fields would fail the gate that depends on it rather than
 * turning an absence assertion into a vacuous one. The device surfaces are not checked
 * here - they are not in a snapshot - and have their own control in the gate, which stages
 * them and measures the same way.
 */
export function forbiddenSurfacesAreActuallyPresent(snapshot: SubjectSnapshot): string[] {
  const present = new Set<string>();
  const visit = (value: unknown, key: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.length > 0) present.add(key);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      present.add(key);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, childKey);
      }
    }
  };
  visit(snapshot, 'snapshot');
  return FORBIDDEN_SUBJECT_SURFACES
    .map((surface) => surface.key)
    .filter((key) => present.has(key))
    .sort();
}

/**
 * Which of the **device** surfaces a staged record set genuinely holds.
 *
 * The same non-vacuity control for the second half of the plan's exclusion list. The
 * record set is passed as plain data so this works on a staged generation and on a read
 * back one, and it is a real measurement: a record the fixture declared but failed to
 * stage would be reported absent, and the gate fails.
 */
export function forbiddenDeviceSurfacesAreActuallyPresent(
  records: Readonly<Record<string, unknown[]>>,
): string[] {
  const present = new Set<string>();
  const visit = (value: unknown, key: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.length > 0) present.add(key);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      present.add(key);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, childKey);
      }
    }
  };
  visit(records, 'device');
  return FORBIDDEN_DEVICE_SURFACES.map((surface) => surface.key)
    .filter((key) => present.has(key))
    .sort();
}

// ── The snapshot ───────────────────────────────────────────────────────────

/**
 * Half of these topics carry the marker and half deliberately do not.
 *
 * The split is what makes "the marker appears only where the graph declares a topic" a
 * falsifiable assertion rather than a tautology: if every topic carried it, then a
 * document with **no** topics at all would satisfy it too, and the assertion would be
 * measuring nothing. {@link TOPIC_MARKER_COUNT} carries the measured number so a gate
 * asserts a value rather than restating a literal here.
 */
export const TOPIC_MARKER_COUNT = 3;

const TOPIC_BY_ROOM: Readonly<Record<string, string>> = {
  root: `Root topic ${MARKER_TOKEN}`,
  leaf: MARKER_ROOM_TOPIC,
  // Deliberately marker-free, and each with a distinct prefix so the canonical room order
  // can separate them.
  meta: 'Synthetic unmarked metadata topic',
  cross: 'Synthetic unmarked cross-linked topic',
  twin: 'Synthetic unmarked sibling topic',
  orphan: `Orphan topic ${MARKER_TOKEN}`,
};

const STATE_BY_ROOM: Readonly<Record<string, RoomState>> = {
  root: 'ArtifactCollected',
  leaf: 'EncounterDefeated',
  meta: 'NeedsRevalidation',
  twin: 'Created',
  cross: 'NotesDrafted',
  orphan: 'Visited',
};

function blankProgress() {
  return {
    xpTotal: 7420,
    rank: 'Scholar',
    badges: [`badge-${MARKER_TOKEN}`],
    fishCollection: [
      {
        id: `fish-${MARKER_TOKEN}`,
        name: `Synthetic Gate Fish ${MARKER_TOKEN}`,
        rarity: 'epic' as const,
        subjectId: TEMPLATE_IDS.alpha.subject,
        subjectName: MARKER_SUBJECT_NAME,
        caughtAt: '2026-04-04T00:00:00.000Z',
      },
    ],
    inventory: [{ id: `loot-${MARKER_TOKEN}`, name: `Synthetic Ledger ${MARKER_TOKEN}` }],
    equippedItems: [{ id: `equip-${MARKER_TOKEN}`, name: `Synthetic Lantern ${MARKER_TOKEN}` }],
  };
}

function roomRecord(input: {
  readonly roomId: string;
  readonly key: string;
  readonly withAttachment: boolean;
}): Record<string, unknown> {
  return {
    roomId: input.roomId,
    topic: TOPIC_BY_ROOM[input.key] as string,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    state: STATE_BY_ROOM[input.key] as RoomState,
    notePath: `rooms/${input.roomId}/notes.md`,
    artifactPath: `rooms/${input.roomId}/artifact.md`,
    noteText: `${MARKER_NOTE_BODY}\n${input.roomId}`,
    artifactMarkdown: `${MARKER_ARTIFACT_BODY}\n${input.roomId}`,
    validationState: {
      wordCount: 1180,
      requiredSectionsPresent: true,
      manualConfirmed: true,
      criterionScores: {
        sectionCompleteness: 4,
        conceptTermCoverage: 3,
        linkReferences: 5,
        recallQuestionQuality: 4,
        clarityReadability: 4,
      },
      // A value a template must not carry, in the one field the plan's phrase "validation"
      // covers most directly.
      failedChecks: [`${MARKER_TOKEN}-section-thin`],
      qualityBonus: 4,
      finalPass: true,
      // The Phase 0 unknown field, re-identified, holding its own marker-bearing value.
      fixtureValidationField: `${MARKER_TOKEN}-validation`,
    },
    reviewPassCount: 3,
    sm2QualityResponse: 4,
    sm2EaseFactor: 2.6,
    sm2IntervalDays: 21,
    sm2NextReviewDate: '2031-01-01T00:00:00.000Z',
    sm2ConsecutiveCorrect: 5,
    // Two approved tags, two unapproved ones, and one in a form the application would
    // have normalised. Only the two approved ones may reach a template.
    tags: [
      ...TEMPLATE_APPROVED_TAGS,
      ...TEMPLATE_UNAPPROVED_TAGS,
      TEMPLATE_UNNORMALISED_TAG,
    ],
    attachments: input.withAttachment
      ? [
          {
            attachmentId: TEMPLATE_IDS.alpha.attachment,
            sourceType: 'local',
            fileName: MARKER_ATTACHMENT_FILE_NAME,
            mimeType: 'image/png',
            relativePath: `rooms/${input.roomId}/attachments/${MARKER_ATTACHMENT_FILE_NAME}`,
            altText: MARKER_ATTACHMENT_ALT_TEXT,
            addedAt: '2026-03-03T00:00:00.000Z',
            // The real digest of the fixture's four payload bytes. A template must not
            // reference it by value or by name, and a fake 64-hex string would be a value
            // a document could carry without violating any of storage-v2's rules.
            contentHash: TEMPLATE_BLOB_CONTENT_HASH,
          },
          {
            attachmentId: 'att-7kq-template-alpha-external',
            sourceType: 'external',
            fileName: 'synthetic-template-external.png',
            mimeType: 'image/png',
            externalUrl: TEMPLATE_EXTERNAL_URL,
            altText: `synthetic external alt text ${MARKER_TOKEN}`,
            addedAt: '2026-03-04T00:00:00.000Z',
          },
        ]
      : [],
    // The Phase 0 unknown room field, re-identified, holding a marker-bearing value
    // rather than the room's own id - so its absence in the document is an assertion
    // about a value that could not be mistaken for anything structural.
    fixtureRoomField: `${MARKER_TOKEN}-room`,
  };
}

/**
 * The Phase 7 fixture snapshot, for one of the two identifier sets.
 *
 * The two snapshots differ in **identifiers only**: the topics, the tags, the edges, the
 * relation types, and the authorship phases are the same strings. That is what makes the
 * byte-identity gate a proof rather than a comparison, and the gate asserts the two
 * snapshots really do differ in identifiers and really do agree in everything else.
 */
export function templateSnapshot(set: TemplateIdSet = 'alpha'): SubjectSnapshot {
  const ids = TEMPLATE_IDS[set];
  const rooms: Record<string, Record<string, unknown>> = {};
  rooms[ids.root] = roomRecord({ roomId: ids.root, key: 'root', withAttachment: true });
  rooms[ids.leaf] = roomRecord({ roomId: ids.leaf, key: 'leaf', withAttachment: false });
  rooms[ids.meta] = roomRecord({ roomId: ids.meta, key: 'meta', withAttachment: false });
  rooms[ids.twin] = roomRecord({ roomId: ids.twin, key: 'twin', withAttachment: false });
  rooms[ids.cross] = roomRecord({ roomId: ids.cross, key: 'cross', withAttachment: false });
  rooms[ids.orphan] = roomRecord({ roomId: ids.orphan, key: 'orphan', withAttachment: false });

  return {
    // The Phase 0 unknown top-level fields, re-identified. One holds a room id, one holds
    // a path-shaped string, and one holds prose containing the marker - so "preserve
    // unknown app-owned fields" and "a template cannot carry one" are tested against the
    // same record, which is the whole reason the allowlist is the right shape.
    unknownTopLevelField: ids.leaf,
    unknownTopLevelPathField: `rooms/${ids.meta}/notes.md`,
    unknownTopLevelProseField: `see room ${MARKER_TOKEN}-prose is the tricky one`,
    fixtureFormat: 'knowledge-dungeon-phase-7-synthetic',
    dungeon: {
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      dungeonId: ids.subject,
      subjectName: MARKER_SUBJECT_NAME,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
      phaseState: 'ArchaeologistActive',
      rootRoomId: ids.root,
      rooms: TEMPLATE_ROOM_LABELS.map((label) => ({
        roomId: ids[label],
        topic: TOPIC_BY_ROOM[label] as string,
        status: STATE_BY_ROOM[label] as RoomState,
      })),
      edges: [
        ...TEMPLATE_STRUCTURE.map((edge) => ({
          fromRoomId: ids[edge.from],
          toRoomId: ids[edge.to],
          relationType: 'subtopic' as const,
          createdAt: '2026-01-02T00:00:00.000Z',
          createdByPhase: edge.createdByPhase,
        })),
        ...TEMPLATE_CROSS_LINKS.map((link) => ({
          fromRoomId: ids[link.from],
          toRoomId: ids[link.to],
          relationType: link.relationType,
          createdAt: '2026-01-03T00:00:00.000Z',
          createdByPhase: link.createdByPhase,
        })),
        // An unknown field on an edge, so the edge level is covered by the unknown-field
        // inventory as well as the room and document levels. `depends_on` is the fourth
        // non-`subtopic` relation type, so all four are exercised.
        {
          fromRoomId: ids.twin,
          toRoomId: ids.orphan,
          relationType: 'depends_on' as const,
          createdAt: '2026-01-04T00:00:00.000Z',
          createdByPhase: 'Scribe' as const,
          fixtureEdgeField: `${MARKER_TOKEN}-edge`,
        },
      ],
      progression: blankProgress(),
      biome: TEMPLATE_SUBJECT_BIOME,
      tagIndex: {
        [TEMPLATE_APPROVED_TAGS[0] as string]: [ids.root, ids.leaf],
        [TEMPLATE_APPROVED_TAGS[1] as string]: [ids.meta],
        [TEMPLATE_UNAPPROVED_TAGS[0] as string]: [ids.cross],
      },
      // The Phase 0 unknown dungeon field, re-identified.
      fixtureDungeonField: `${MARKER_TOKEN}-dungeon`,
    },
    rooms,
  } as unknown as SubjectSnapshot;
}

/** The twin: the same graph, the same content, and a completely different set of ids. */
export function reidentifiedSnapshot(): SubjectSnapshot {
  return templateSnapshot('beta');
}

/**
 * The device-global records a template must exclude, as a record set the gates can put on
 * a device.
 *
 * These are not part of the subject snapshot - the plan calls them out separately -
 * so they are returned as a plain object and the gates stage them alongside the subject.
 * Every value carries the marker, so their absence from a document is an assertion about
 * a full surface rather than an empty one.
 */
export function deviceOnlyRecords(): {
  readonly progression: Record<string, unknown>[];
  readonly assistance: Record<string, unknown>[];
  readonly sessions: Record<string, unknown>[];
  readonly recovery: Record<string, unknown>[];
  readonly customSprites: Record<string, unknown>[];
  readonly migrationReceipts: Record<string, unknown>[];
  readonly preferences: Record<string, unknown>[];
  readonly attachmentBlobs: Record<string, unknown>[];
} {
  return {
    progression: [
      {
        subjectId: TEMPLATE_IDS.alpha.subject,
        sourceVersion: 3,
        rank: 'Scholar',
        xpTotal: 7420,
        bySubject: {
          [TEMPLATE_IDS.alpha.subject]: {
            subjectId: TEMPLATE_IDS.alpha.subject,
            subjectName: MARKER_SUBJECT_NAME,
            xpTotal: 7420,
            rank: 'Scholar',
            badges: [`badge-${MARKER_TOKEN}-badge`],
            fishCollection: [
              {
                id: `fish-${MARKER_TOKEN}-id`,
                name: 'Synthetic Gate Fish',
                rarity: 'epic',
                subjectId: TEMPLATE_IDS.alpha.subject,
                caughtAt: '2026-04-04T00:00:00.000Z',
                // The Phase 0 unknown-field pattern, at the fish-entry level.
                extraFields: { fixtureFishField: `${MARKER_TOKEN}-fish` },
              },
            ],
            collectedNotes: [],
            inventory: [
              {
                id: `loot-${MARKER_TOKEN}-id`,
                name: 'Synthetic Ledger',
                rarity: 'rare',
                acquiredAt: '2026-04-05T00:00:00.000Z',
                extraFields: { fixtureLootField: `${MARKER_TOKEN}-loot` },
              },
            ],
            equippedItems: [],
          },
        },
        crossSubjectAchievements: [],
        // The Phase 0 unknown progression field, re-identified.
        extraFields: { fixtureProgressionField: `${MARKER_TOKEN}-progression` },
      },
    ],
    assistance: [
      {
        assistanceId: `assistance-${MARKER_TOKEN}`,
        mode: 'gentle',
        // `AssistanceRecordValue.signals` is `Record<string, number>` - aggregate local
        // signals, never raw keystrokes and never a trait (plan section 8). The marker's
        // *key* carries it, so the inventory can still require the record to be present and
        // the document to be free of the token.
        signals: { hintRequests: 4, [`${MARKER_TOKEN}-assist`]: 1 },
        dismissalCount: 2,
        updatedAt: '2026-05-06T00:00:00.000Z',
      },
    ],
    sessions: [
      {
        sessionId: TEMPLATE_IDS.alpha.session,
        subjectId: TEMPLATE_IDS.alpha.subject,
        subjectName: MARKER_SUBJECT_NAME,
        eventId: `event-${MARKER_TOKEN}-event`,
        startedAt: '2026-05-01T09:00:00.000Z',
        endedAt: '2026-05-01T10:00:00.000Z',
        roomsVisited: [...ALPHA_IDENTIFIERS.slice(1, 4)],
        notesSubmitted: 2,
        reviewsCompleted: 1,
        xpEarned: 180,
      },
    ],
    recovery: [
      {
        kind: 'unindexed-subject',
        subjectId: `subject-${MARKER_TOKEN}-vanished`,
        raw: `{"marker":"${MARKER_TOKEN}-recovery"}`,
        capturedAt: '2026-05-07T00:00:00.000Z',
      },
    ],
    customSprites: [
      {
        spritePath: `characters/synthetic/gate-${MARKER_TOKEN}.svg`,
        // `CustomSpriteRecordValue`'s real shape: a `kind` from its own three-value
        // vocabulary and a verbatim `content` string. Plan section 3.2 defers new custom
        // sprite editing but requires existing data to survive, so the record has to be
        // genuinely valid for the device to activate with it.
        kind: 'override',
        content: `<svg data-marker="${MARKER_TOKEN}-sprite"><title>s</title></svg>`,
        updatedAt: '2026-05-08T00:00:00.000Z',
      },
    ],
    migrationReceipts: [
      {
        receiptId: `receipt-${MARKER_TOKEN}-receipt`,
        migrationId: 'legacy-localstorage-to-storage-v2',
        fromStorage: 'legacy-localstorage',
        toStorage: 'storage-v2',
        stagedGenerationId: `gen-${MARKER_TOKEN}`,
        previousActiveGenerationId: null,
        status: 'activated',
        createdAt: '2026-05-09T00:00:00.000Z',
        storageGenerationFormatVersion: 1,
        subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      },
    ],
    preferences: [
      { preferenceId: 'locale', value: `en-GB-${MARKER_TOKEN}-pref`, updatedAt: '2026-05-10T00:00:00.000Z' },
    ],
    attachmentBlobs: [
      {
        attachmentId: TEMPLATE_IDS.alpha.attachment,
        // The blob's identity is the digest of its own bytes, and storage-v2's validator
        // refuses a record whose hash does not match - so the fixture computes it rather
        // than asserting one, and the gate can then require the *real* digest to be absent
        // from the document.
        contentHash: platformSha256(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
        byteLength: 4,
        storedAt: '2026-05-11T00:00:00.000Z',
      },
    ],
  };
}
