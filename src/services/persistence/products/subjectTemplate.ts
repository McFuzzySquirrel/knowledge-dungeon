/**
 * The blank reusable template product: `.kdtemplate`.
 *
 * Plan section 7.3 fixes what a template is, and this module is the whole of it:
 *
 * ```text
 * Template name and description.
 * Root topic.
 * Room topics.
 * Edge and cross-link structure.
 * User-approved non-private tags.
 * Optional biome preference.
 * ```
 *
 * and, immediately after, what it is not:
 *
 * ```text
 * Templates exclude notes, drafts, artifacts, validation, review state, SM-2 data,
 * progression, fish, inventory, assistance history, original IDs, attachments,
 * filenames, and private metadata.
 * ```
 *
 * ## The format is JSON, and there is no archive codec
 *
 * Section 7.3 says "**JSON** containing only:" and then, at the end of the whole
 * section, "The archive format must use a small audited open-source library
 * selected during implementation. Do not hand-roll ZIP encoding or decoding."
 * Those two sentences are about different things. The first names `.kdtemplate` as a
 * JSON document. The second constrains *archive* formats - the `.kdbak` and
 * `.kdsubject` ZIP layouts, which are the two products that actually are archives -
 * and its whole content is the instruction not to hand-roll ZIP. So this product
 * needs **no codec at all**: it is `canonicalJsonStringify` over a closed object, and
 * `JSON.parse` on read. Nothing here imports `fflate`, and the boundary gate asserts
 * that neither this module nor anything it reaches names a ZIP module - which is the
 * mechanical form of "adding `fflate` to a JSON path would be a mistake".
 *
 * ## The privacy property is true by construction, from an allowlist
 *
 * The central claim of this phase is that **a `.kdtemplate` cannot contain private
 * learner data**. That claim is not achieved by deleting fields; it is achieved by
 * never having a code path that could copy one.
 *
 * The reason a denylist is the wrong shape is specific to this repository. Plan
 * section 7.3 requires the `.kdbak` import to "preserve unknown app-owned fields", and
 * Phases 4, 5 and 6 all built on that: a subject snapshot may carry a field this
 * build has never heard of, at any depth, holding anything. A denylist is a list of
 * names somebody remembered, so it would carry every unknown field straight into a
 * file the learner is about to hand to someone else - and the leak would be
 * invisible, because the field would look exactly like a field the build *does* know.
 *
 * So the document is built from an allowlist, and the allowlist is the six things
 * section 7.3 permits, and every key in the emitted document is **declared** in one
 * of the `SUBJECT_TEMPLATE_*_KEYS` constants below. There is no second place a key
 * can come from, which is what makes "assert the key set for equality" a real gate
 * rather than a description.
 *
 * Concretely, the exporter reads **exactly six things** out of a subject snapshot:
 *
 * | Read | From | Why it is permitted |
 * | --- | --- | --- |
 * | room ids | `Object.keys(snapshot.rooms)` | as handles only - never emitted |
 * | room topics | `RoomMetadata.topic` | "Room topics" |
 * | room tags | `RoomMetadata.tags` | intersected with the caller's approved list |
 * | edge endpoints | `DungeonEdge.fromRoomId` / `.toRoomId` | "Edge and cross-link structure" |
 * | edge relation types | `DungeonEdge.relationType` | app-owned closed vocabulary |
 * | edge authorship | `DungeonEdge.createdByPhase` | app-owned closed vocabulary |
 * | the root | `DungeonMetadata.rootRoomId` | as a handle only - never emitted |
 *
 * Nothing else. Not `subjectName`, not `dungeonId`, not `noteText`,
 * not `artifactMarkdown`, not `validationState`, not `reviewPassCount`, not the five
 * SM-2 fields, not `attachments`, not `progression`, not `tagIndex`, not `biome`, not
 * a room's `notePath` or `artifactPath`, not `createdAt` or `updatedAt`, not a
 * top-level unknown field, not a room-level unknown field. The determinism gate
 * proves this by exporting two snapshots that differ in **all** of those and requiring
 * byte-identical documents.
 *
 * ## Why rooms are addressed by array index
 *
 * A room id cannot appear in the file - as a value, as an object key, or embedded in a
 * path-shaped string - because "original IDs" is on section 7.3's exclusion list and
 * because an identifier is exactly the kind of thing that survives into a screenshot
 * of a shared file. So a room is addressed by its **position in `graph.rooms`**, and
 * every edge carries `from` / `to` as integers into that array. The exporter resolves
 * ids to indices internally and emits nothing; the importer mints a fresh id per index
 * and rewrites every endpoint into it.
 *
 * The room **order** is therefore load-bearing, and it cannot be a function of the
 * source ids, or two subjects with the same graph and different ids would emit
 * different bytes. {@link canonicalRoomOrder} gives the order that is a function of
 * the graph's *content* - breadth-first from the root, siblings by topic then tags,
 * then a bounded refinement pass over incident edges - and the byte-identity gate
 * requires two differently-identified but structurally identical subjects to produce
 * the same bytes. The one residual is stated there and not hidden.
 *
 * ## Topics and tags are permitted because the user approves them
 *
 * A room's topic is learner-authored text, and so is a tag name. Section 7.3 permits
 * both - "Room topics" and "User-approved non-private tags" - and this module takes
 * that permission seriously by making the approval a **parameter with no default that
 * can supply itself**:
 *
 * - `approvedTags` is a list the caller passes. Absent means **empty**. There is no
 *   code path in this file that reads a tag out of a snapshot into the document, so
 *   "the export ran" cannot imply "the tags were approved".
 * - `approvedBiome` is the same. The exporter does **not** read
 *   `DungeonMetadata.biome`; the caller passes it, so "carry my biome" is a decision
 *   somebody made rather than a consequence of pressing export.
 * - A room's own `tags` are **intersected** with the approved list, so an unapproved
 *   tag that happens to sit in the subject cannot reach the file even by accident.
 * - {@link SubjectTemplateExportResult.approvedTags} carries the exact normalised,
 *   sorted, deduplicated list that is in the file, so a screen can show the learner
 *   precisely what is about to leave the device. That is the "recorded" half of the
 *   approval: a *measurement* of the file's contents, not a boolean claiming that
 *   somebody asked. A boolean in the document would be a claim the reader cannot
 *   check; the empty-by-default behaviour and the returned list are both checkable.
 *
 * Topics are different in one respect and the same in another. They are *always*
 * exported, because a template without them is not a template - section 7.3 lists
 * "Room topics" unconditionally, and the whole point of the product is that the
 * learner chooses to share a skeleton's structure. They are still learner content,
 * which is why **no reported surface** in this module - the preview, the import
 * result, the file name, any `StorageV2Error` - carries one. The file carries them;
 * nothing a caller logs or shows in a report does.
 *
 * ## Determinism, and the absence of a clock
 *
 * The export reads no clock, generates no identifier, and calls no random source.
 * `now` is a required parameter. Two exports of the same snapshot with the same
 * `now` are byte-identical, and two exports of two differently-identified but
 * structurally identical snapshots with the same `now` are byte-identical too. The
 * second half is the load-bearing one: it is only possible because the document
 * contains no identifier, and any identifier that leaked would differ.
 *
 * The importer takes an **injected id generator** and an injected clock for the same
 * reason, so the whole of the phase is testable without a wall clock and without
 * `Math.random`.
 *
 * ## Why importing is a single additive write and not a generation transaction
 *
 * Plan section 5.2 requires that "Data imports never partially overwrite the active
 * data generation", and Phases 5 and 6 both satisfy it by staging a complete new
 * generation and flipping a pointer. A template import does not need that, and
 * {@link importSubjectTemplate} explains why at the point where it matters: the
 * operation adds exactly one record under a freshly minted subject id that has been
 * checked against every subject and room identifier the device already holds, and it
 * deletes and updates nothing. There is no overwrite to be partial, so the rollback
 * is a single delete of a record that did not exist before the call.
 *
 * ## What this module does not do
 *
 * No ZIP, no `navigator.share`, no `fetch`, no `XMLHttpRequest`, no `sendBeacon`, no
 * `URL.createObjectURL`, no `localStorage`, no renderer, no UI, and no file-system or
 * file-picker access. It returns text and a constant file name; turning that into a
 * file is a user-interface concern. Every refusal is a {@link StorageV2Error} whose
 * details are codes, counts, booleans, and code-shaped field tokens - never a topic, a
 * tag, a filename, a URL, or an identifier, because the constructor refuses any string
 * detail that is not code-shaped.
 *
 * The legacy `exportSubjectAsTemplate` / `createSubjectFromTemplate` pair in
 * `../subjectPersistence` is a *different, pre-Phase-7* template path, retained for
 * the plan's rollback and **not** re-exported, wrapped, or deprecated from here. See
 * that file's own comment for which is which and why.
 */

import {
  CANONICAL_SUBJECT_SCHEMA_VERSION,
  isSanitizedDetailText,
  StorageV2Error,
  STORAGE_V2_GENERATION_FORMAT_VERSION,
  STORAGE_V2_STORE_NAMES,
  type StorageV2StoreName,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
import { canonicalJsonStringify, checksumValue, sha256Hex } from '@/services/persistence/v2/checksum';
import { writeSubjectToActiveGeneration } from '@/services/persistence/v2/appRepository';
import type { GenerationSnapshot, StorageV2Repository } from '@/services/persistence/v2/repository';
import {
  DATA_PRODUCT_FORMAT_VERSIONS,
  EDGE_PHASES,
  EDGE_RELATION_TYPES,
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DataProductKind,
  type EdgeCreatedByPhase,
  type EdgeRelationType,
  type RoomState,
  type SubjectSnapshot,
} from '@/core/validation/persistence/types';
import * as tagDomain from '@/core/graph/tagDomain';

const { rebuildTagIndex } = tagDomain;
import { assertImportableSubjectSnapshot } from '@/core/validation/persistence/subjectValidation';
import { isPrototypeMemberName } from '@/services/persistence/v2/prototypeNames';
import {
  collectExistingIdentifiers,
  subjectIdentifierGroups,
  SUBJECT_ID_KIND_PREFIX,
  SUBJECT_ID_MINT_ATTEMPTS,
  type SubjectIdGenerator,
  type SubjectIdKind,
} from './idRemapping';

// ── Product identity, versions, and the file name ─────────────────────────

/** Which product this module writes and reads. */
export const SUBJECT_TEMPLATE_PRODUCT: DataProductKind = 'kdtemplate';

/**
 * The `.kdtemplate` document version this build writes and accepts.
 *
 * `DATA_PRODUCT_FORMAT_VERSIONS` already reserved `kdtemplate: 1` in Phase 3, and this
 * is the payload that contract was waiting for. It is a **product format** version and
 * is not the subject schema version and not the storage generation version, which is
 * plan section 12, rule 4.
 */
export const SUBJECT_TEMPLATE_FORMAT_VERSION = DATA_PRODUCT_FORMAT_VERSIONS[SUBJECT_TEMPLATE_PRODUCT];

/**
 * The three version contracts, as three keys, refused three ways.
 *
 * The same rule the `.kdbak` and `.kdsubject` products apply, restated because this
 * product has no manifest to carry them: a single flat document has nowhere else to
 * put them, so they sit at the top level and each is checked against its own
 * contract. The subject-schema refusal is the one that stops a newer template being
 * read by an older build.
 */
export const SUBJECT_TEMPLATE_VERSION_KEYS = [
  'formatVersion',
  'storageGenerationFormatVersion',
  'subjectSchemaVersion',
] as const;

export type SubjectTemplateVersionKey = (typeof SUBJECT_TEMPLATE_VERSION_KEYS)[number];

/**
 * The file name a download should be offered under.
 *
 * Fixed and content-free. Plan section 12, rule 6 forbids learner data in a filename:
 * no subject name (the subject name is exactly what must not travel), no template name
 * (a name the learner typed), and no timestamp (which would make an otherwise
 * deterministic export look like it varied). The product returns the constant; the
 * user interface applies it.
 */
export const SUBJECT_TEMPLATE_FILE_NAME = 'knowledge-dungeon-subject-template.kdtemplate';

/** The extension the constant file name carries, asserted by the boundary gate. */
export const SUBJECT_TEMPLATE_FILE_EXTENSION = '.kdtemplate';

/**
 * The destination subject name an import uses when the caller supplies none and the
 * template declares none.
 *
 * A **constant**, and never the source subject's name: a template carries no subject
 * name at all, so there is nothing else it could default to. `'Templated Subject'` is
 * the same default the pre-Phase-7 legacy importer used, which keeps the two paths
 * describing the same outcome for a caller that switches between them.
 */
export const SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME = 'Templated Subject';

/** The blank room state every imported room starts in. */
export const SUBJECT_TEMPLATE_BLANK_ROOM_STATE: RoomState = 'Created';

/** The blank progression mirror every imported subject starts with. */
export const SUBJECT_TEMPLATE_BLANK_PROGRESSION = Object.freeze({
  xpTotal: 0,
  rank: 'Novice',
  badges: [] as readonly string[],
  fishCollection: [] as readonly unknown[],
});

/** The phase state an imported subject starts in: Creator, with nothing written. */
export const SUBJECT_TEMPLATE_BLANK_PHASE_STATE = 'CreatorActive' as const;

// ── Resource limits ────────────────────────────────────────────────────────

/**
 * The largest `.kdtemplate` this build will read, in bytes.
 *
 * A template is a graph skeleton: a room is a topic string and a short tag list, and
 * an edge is three small fields. One mebibyte therefore holds thousands of rooms, and
 * {@link SUBJECT_TEMPLATE_MAX_ROOMS} is the real structural bound. The byte cap is the
 * outer one, checked **before** the text is parsed, so a four-megabyte file is refused
 * without a parser ever seeing it.
 */
export const SUBJECT_TEMPLATE_MAX_BYTES = 1024 * 1024;

/**
 * The deepest nesting a document may have.
 *
 * This document's own grammar is four levels deep (document, `graph`, `rooms[]`,
 * nothing below), so anything deeper is not a template. The bound is measured by a
 * lexical pre-scan rather than left to the parser, because a hostile file nested
 * hundreds of thousands deep can exhaust the parser's own stack - and a refusal the
 * parser produced by throwing would not be a typed refusal.
 */
export const SUBJECT_TEMPLATE_MAX_DEPTH = 8;

/** The most rooms a document may declare. */
export const SUBJECT_TEMPLATE_MAX_ROOMS = 4096;

/** The most approved tags a document may declare. */
export const SUBJECT_TEMPLATE_MAX_TAGS = 256;

/** The most edges - structure plus cross-links - a document may declare. */
export const SUBJECT_TEMPLATE_MAX_EDGES = 16384;

/**
 * The longest permitted topic, tag list entry, template name, description, or biome.
 *
 * A bound rather than a rejection policy, because a topic is learner text and a
 * template with a ten-megabyte topic is not a skeleton. 400 characters is longer than
 * any room heading and shorter than anything that would be mistaken for a note.
 */
export const SUBJECT_TEMPLATE_MAX_TEXT_LENGTH = 400;

/**
 * How many times the canonical room order's tiebreak may be applied.
 *
 * A bound rather than a convergence promise. The tiebreak only ever permutes rooms that
 * the breadth-first pass already left tied, and it reads its neighbour positions from a
 * snapshot of the order taken before it starts - so it settles in one application for any
 * graph and the bound is a belt-and-braces guarantee that a future change cannot make the
 * export's cost unbounded. It is a constant rather than a loop condition because a fixed
 * bound is what makes the export's runtime a function of the input's size and nothing
 * else.
 */
export const SUBJECT_TEMPLATE_CANONICAL_PASSES = 8;

// ── The closed key sets ────────────────────────────────────────────────────

/**
 * The document's exact key set. Eight keys, nothing added, nothing dropped.
 *
 * `product` and `createdAt` are the only two that are not one of section 7.3's six
 * permitted things, and both are constants rather than content: the product tag is how
 * a reader knows what it is holding before it reads anything else, and the injected
 * clock is what makes the document non-ambient. `formatVersion`,
 * `storageGenerationFormatVersion` and `subjectSchemaVersion` are the three separate
 * contracts plan section 12, rule 4 keeps apart, and {@link SUBJECT_TEMPLATE_VERSION_KEYS}
 * names them separately so each can be refused separately.
 *
 * `name` and `description` are section 7.3's "Template name and description", and are
 * `null` rather than absent when the caller supplied none - so the key set is the same
 * for every document this build writes, and "the key set equals the declared set" is an
 * equality rather than a per-value check.
 */
export const SUBJECT_TEMPLATE_DOCUMENT_KEYS = [
  'product',
  ...SUBJECT_TEMPLATE_VERSION_KEYS,
  'createdAt',
  'name',
  'description',
  'graph',
] as const;

export type SubjectTemplateDocumentKey = (typeof SUBJECT_TEMPLATE_DOCUMENT_KEYS)[number];

/**
 * The `graph` sub-document's exact key set. Six keys: section 7.3's other four
 * permitted things, plus the root and the room array that carry "Root topic".
 *
 * `rooms` is an **array**, and every reference to a room is an index into it. That is
 * the whole "no original IDs" mechanism, and it is why `rootRoomId` and `roomId` are
 * not keys anywhere in this document.
 *
 * `structureEdges` and `crossLinks` are two arrays rather than one, and the split is
 * the domain's own rather than this product's invention: `graphDomain.addCrossLink`
 * creates an edge with a relation that is not `subtopic`, `addLinkedRooms` and
 * `reparentRoom` create and move `subtopic` edges, and `navigation.ts` walks the tree
 * by filtering for exactly `subtopic`. So "Edge and cross-link structure" is the
 * hierarchy in one array and the lateral relations in the other, and the importer
 * re-merges them into `DungeonMetadata.edges` in a fixed order.
 *
 * `tags` is the approved tag vocabulary, and `biome` is the approved biome preference.
 * Both are `null`/empty rather than absent when unapproved, for the same reason the
 * document's own optional keys are.
 */
export const SUBJECT_TEMPLATE_GRAPH_KEYS = [
  'rootIndex',
  'rooms',
  'structureEdges',
  'crossLinks',
  'tags',
  'biome',
] as const;

export type SubjectTemplateGraphKey = (typeof SUBJECT_TEMPLATE_GRAPH_KEYS)[number];

/** A room entry's exact key set: its approved topic and its approved tags. */
export const SUBJECT_TEMPLATE_ROOM_KEYS = ['topic', 'tags'] as const;

/**
 * A structure edge's exact key set.
 *
 * No `relationType`, because membership in `structureEdges` *is* the relation: an edge
 * in this array is `subtopic` by definition, and carrying the value as well would be
 * redundant state that could disagree with itself. `createdByPhase` is carried, because
 * it is a real authoring fact from the application's own three-value vocabulary and
 * carrying it means the import invents nothing at all.
 */
export const SUBJECT_TEMPLATE_STRUCTURE_EDGE_KEYS = ['from', 'to', 'createdByPhase'] as const;

/** A cross-link's exact key set. `relationType` here is a real choice, so it is kept. */
export const SUBJECT_TEMPLATE_CROSS_LINK_KEYS = [
  'from',
  'to',
  'relationType',
  'createdByPhase',
] as const;

// ── The document shape ─────────────────────────────────────────────────────

export interface SubjectTemplateRoom {
  /** The room's approved topic. Learner text, and the reason a template is worth sharing. */
  readonly topic: string;
  /** The approved tags on this room, sorted, deduplicated, and a subset of `graph.tags`. */
  readonly tags: readonly string[];
}

export interface SubjectTemplateStructureEdge {
  /** Index into `graph.rooms`. */
  readonly from: number;
  /** Index into `graph.rooms`. */
  readonly to: number;
  readonly createdByPhase: EdgeCreatedByPhase;
}

export interface SubjectTemplateCrossLink {
  readonly from: number;
  readonly to: number;
  readonly relationType: EdgeRelationType;
  readonly createdByPhase: EdgeCreatedByPhase;
}

export interface SubjectTemplateGraph {
  /** Index into `rooms` of the root room. Never `null` in a document this build writes. */
  readonly rootIndex: number;
  readonly rooms: readonly SubjectTemplateRoom[];
  readonly structureEdges: readonly SubjectTemplateStructureEdge[];
  readonly crossLinks: readonly SubjectTemplateCrossLink[];
  /** The approved tag vocabulary, sorted and deduplicated. */
  readonly tags: readonly string[];
  /** The approved biome preference, or `null`. */
  readonly biome: string | null;
}

export interface SubjectTemplateDocument {
  readonly product: DataProductKind;
  readonly formatVersion: number;
  readonly storageGenerationFormatVersion: number;
  readonly subjectSchemaVersion: string;
  readonly createdAt: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly graph: SubjectTemplateGraph;
}

// ── The sanitized surfaces ─────────────────────────────────────────────────

/**
 * The sanitized view of a `.kdtemplate`: everything a preview may show and a report
 * may carry, and **no learner text at all**.
 *
 * This is stricter than the `.kdsubject` preview in one respect and it is deliberate.
 * A `.kdsubject` preview omits learner content because a subject backup is private. A
 * `.kdtemplate` legitimately contains approved topics, tags, a name and a description -
 * so the temptation is to show them, and the file is *meant* to be shared. The preview
 * still refuses: a preview is a **reported** surface, it is rendered into a status line
 * and copied into an error report, and section 12, rule 6 governs reported strings. A
 * Data Center that needs to show the template's title shows the destination subject
 * name the user is typing instead, which is their own text and was never in the file.
 *
 * What the preview *does* carry is everything a learner needs to decide: how many
 * rooms, how much structure, how many cross-links, how many approved tags, whether a
 * biome was approved, and the three version contracts. That is enough to say "this is a
 * 12-room skeleton with 3 approved tags" before committing, and it is true of a
 * *rejected* file too, so it leaks nothing.
 */
export interface SubjectTemplatePreview {
  readonly product: DataProductKind;
  readonly formatVersion: number;
  readonly storageGenerationFormatVersion: number;
  readonly subjectSchemaVersion: string;
  readonly createdAt: string;
  readonly roomCount: number;
  readonly structureEdgeCount: number;
  readonly crossLinkCount: number;
  /** How many tags the writer approved. A count, never the names. */
  readonly approvedTagCount: number;
  /** Whether a biome preference was approved. A boolean, never the value. */
  readonly hasBiome: boolean;
  /** Whether a template name was declared. A boolean, never the text. */
  readonly hasName: boolean;
  /** Whether a description was declared. A boolean, never the text. */
  readonly hasDescription: boolean;
  /** The content-free file name this product would offer. */
  readonly fileName: string;
}

// ── Export ─────────────────────────────────────────────────────────────────

/**
 * Everything the export needs beyond the snapshot.
 *
 * `now` is **required** and has no default: the product reads no clock, so an export is
 * a pure function of its arguments and two exports of the same inputs are byte-identical.
 *
 * `approvedTags` and `approvedBiome` are the approval step, and **both default to
 * nothing**. The exporter does not read `DungeonMetadata.biome` and does not read any
 * `RoomMetadata.tags` into the document except as an intersection with `approvedTags`,
 * so a caller that passes neither produces a template with no tags and no biome. That
 * is the property the privacy gate measures, and it is why hitting export is not the
 * same as approving anything.
 */
export interface SubjectTemplateExportRequest {
  /** Injected clock. The only time value in the document. */
  readonly now: string;
  /**
   * The tags the user has approved for sharing.
   *
   * Normalised with the application's own {@link normalizeTag} rule, deduplicated, and
   * sorted before they reach the document, and the resulting list is returned on
   * {@link SubjectTemplateExportResult.approvedTags} so a screen can show the learner
   * exactly what is in the file. Absent means none.
   */
  readonly approvedTags?: readonly string[];
  /** The biome preference the user has approved. Absent or `null` means none. */
  readonly approvedBiome?: string | null;
  /** The template's own name. `null` is legal and means the document carries none. */
  readonly name?: string | null;
  /** The template's own description. `null` is legal. */
  readonly description?: string | null;
}

export interface SubjectTemplateExportResult {
  /** The `.kdtemplate`: canonical JSON, sorted keys, no insignificant whitespace. */
  readonly template: string;
  /** The content-free file name. Never derived from the subject or the template name. */
  readonly fileName: string;
  /**
   * The exact approved tag list the document carries, after normalisation.
   *
   * This is the record of the approval, and it is a **measurement of the file** rather
   * than a claim about the user: a caller renders it, and the gate asserts it equals
   * the document's own `graph.tags`. Empty when nothing was approved, and the empty
   * case is the one the privacy gate holds.
   */
  readonly approvedTags: readonly string[];
  /** The exact biome preference the document carries, or `null`. */
  readonly approvedBiome: string | null;
  readonly roomCount: number;
  readonly structureEdgeCount: number;
  readonly crossLinkCount: number;
  /** SHA-256 of the document bytes. A digest: it cannot be read back into content. */
  readonly contentChecksum: string;
}

// ── Import ─────────────────────────────────────────────────────────────────

/**
 * The identifier source. Injected, so the whole import is a pure function of its
 * arguments and a test can drive it with a counter.
 *
 * Structurally the same one-method interface the `.kdsubject` copy remapper takes, and
 * re-exported below, so a caller that already holds one works unchanged.
 */
export type { SubjectIdGenerator };

/**
 * The subject name a minted subject gets, and where it came from.
 *
 * Three sources, in order, and the order is the decision:
 *
 * 1. `caller` - the destination name the user typed. Section 7.3's "destination subject
 *    name" is an *input* to the import, so it wins.
 * 2. `template-name` - the template's own declared `name`, which the writer approved for
 *    sharing, so reusing it cannot disclose anything the file did not already contain.
 * 3. `default` - {@link SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME}, a constant.
 *
 * A template never carries the *source* subject's name, so there is no fourth source
 * and no way for an import to put a subject name in a file.
 */
export type SubjectTemplateNameSource = 'caller' | 'template-name' | 'default';

export interface SubjectTemplateMintRequest {
  /** Injected clock, stamped on the minted subject and its rooms. */
  readonly now: string;
  /** Injected source of fresh identifiers. Required: nothing here mints on its own. */
  readonly generator: SubjectIdGenerator;
  /** The destination subject name the user chose. Wins over the template's own name. */
  readonly destinationSubjectName?: string | null;
  /**
   * Identifiers the destination already holds, which a minted identifier may not equal.
   *
   * Optional, so the pure half of this module is testable without a device.
   * {@link importSubjectTemplate} supplies it from the active generation, and
   * `tests/data` asserts that an import refuses rather than colliding.
   */
  readonly taken?: ReadonlySet<string>;
}

export interface SubjectTemplateMintResult {
  /** The sanitized preview of the document that was read. No learner text. */
  readonly preview: SubjectTemplatePreview;
  /** A new subject: fresh identifiers everywhere, and blank room state everywhere. */
  readonly snapshot: SubjectSnapshot;
  /** The freshly minted subject id. An opaque identifier. */
  readonly subjectId: string;
  /** Fresh room ids, index-aligned with the document's `graph.rooms`. */
  readonly roomIds: readonly string[];
  /** The fresh id of the room `graph.rootIndex` named, or `null` for an empty graph. */
  readonly rootRoomId: string | null;
  readonly subjectName: string;
  readonly subjectNameSource: SubjectTemplateNameSource;
  /** How many identifier candidates the mint asked for, across both kinds. */
  readonly mintAttempts: number;
}

export interface SubjectTemplateImportRequest extends SubjectTemplateMintRequest {
  readonly repository: StorageV2Repository;
  /** The `.kdtemplate` text. A string, because the product is a JSON product. */
  readonly template: string;
}

export interface SubjectTemplateImportResult extends SubjectTemplateMintResult {
  /** The generation the record was written into. */
  readonly generationId: string;
  /** The generation that was active before the import, and that is still active. */
  readonly previousActiveGenerationId: string | null;
  /**
   * Always `additive-single-record`.
   *
   * The import wrote one record under a freshly minted subject id and deleted and
   * updated nothing, so plan section 5.2's "never partially overwrite the active data
   * generation" is satisfied by the operation's shape rather than by a pointer flip.
   */
  readonly writePolicy: 'additive-single-record';
  /** One line, code-shaped, naming what the rollback is. */
  readonly rollback: 'delete-the-created-subject-record';
  /** Per-store record counts of the generation after the import, read back. */
  readonly recordCounts: Readonly<Record<StorageV2StoreName, number>>;
  /** The generator used to mint identifiers, for a caller that wants to log it. */
  readonly generator: SubjectIdGenerator;
}

// ── Typed refusals ─────────────────────────────────────────────────────────

/**
 * Every refusal this module can make, as one closed set of code-shaped reasons.
 *
 * A closed set for the same reason {@link SUBJECT_TEMPLATE_VERSION_KEYS} is one: the
 * reason is what a screen renders and what a gate asserts, so it cannot be a free string
 * that drifts between two call sites. And every one of them is a **property**, never a
 * value - "an unexpected key is present" rather than "the key `noteText` is present" -
 * so a rejected file cannot leak its own contents through its own error.
 */
export const SUBJECT_TEMPLATE_REFUSAL_REASONS = [
  // Size and shape of the file itself.
  'template-too-large',
  'template-nested-too-deeply',
  'template-not-json',
  'legacy-template-format-refused',
  // The three version contracts, one reason each.
  'unsupported-product-format-version',
  'unsupported-storage-format-version',
  'unsupported-subject-schema-version',
  // The closed key sets, at every level.
  'document-unexpected-field',
  'document-missing-field',
  'graph-unexpected-field',
  'graph-missing-field',
  'room-unexpected-field',
  'room-missing-field',
  'structure-edge-unexpected-field',
  'structure-edge-missing-field',
  'cross-link-unexpected-field',
  'cross-link-missing-field',
  // Shapes.
  'document-wrong-shape',
  'graph-wrong-shape',
  'room-wrong-shape',
  'edge-wrong-shape',
  'label-wrong-shape',
  'text-too-long',
  'too-many-rooms',
  'too-many-tags',
  'too-many-edges',
  // Tags.
  'tag-not-approved-shape',
  'tag-is-a-reserved-word',
  'tag-not-in-the-approved-list',
  'duplicate-approved-tag',
  // Graph structure, shared by the exporter and the importer.
  'edge-names-a-room-that-does-not-exist',
  'self-loop-edge',
  'duplicate-edge',
  'room-has-two-structure-parents',
  'graph-has-no-rooms',
  'graph-has-no-root',
  // The source snapshot, exporter only.
  'snapshot-has-no-rooms',
  'snapshot-has-no-resolvable-root',
  'snapshot-room-key-disagrees-with-its-room-id',
  'snapshot-room-summary-without-payload',
  'snapshot-room-topic-is-not-text',
  'snapshot-edge-is-malformed',
  'snapshot-edge-vocabulary-is-unknown',
  // Identifiers.
  'no-free-identifier',
  // The device.
  'template-import-read-back-failed',
] as const;

export type SubjectTemplateRefusalReason = (typeof SUBJECT_TEMPLATE_REFUSAL_REASONS)[number];

/**
 * Which spelling of a tag the reserved-word refusal was about.
 *
 * Declared as a closed set and exported for the same reason the refusal reasons are: the
 * value lands in a `StorageV2Error` detail, so it is part of what a screen renders and what
 * a gate asserts, and a free string would be a value no consumer could enumerate.
 *
 * The two are different failures and merging them would hide one. See
 * {@link assertTagIsRepresentable}.
 */
export const SUBJECT_TEMPLATE_TAG_FORM_TOKENS = ['raw', 'normalised'] as const;

export type SubjectTemplateTagFormToken = (typeof SUBJECT_TEMPLATE_TAG_FORM_TOKENS)[number];

/**
 * Build a typed refusal.
 *
 * `reason` is drawn from {@link SUBJECT_TEMPLATE_REFUSAL_REASONS} rather than typed as
 * a free string, so a typo is a compile error instead of a reason no screen has copy for.
 * `field` and `index` are this product's own vocabulary - a key name from one of the
 * declared key sets, or a numeric position - so they are code-shaped.
 *
 * ## The one trap in this function, and why the field token must be a bare key name
 *
 * `StorageV2Error`'s constructor **refuses** a string detail that is not code-shaped, and
 * its rule is `/^[A-Za-z0-9._-]{1,64}$/` minus anything ending in `.` plus a short extension
 * - because it cannot otherwise tell `gen-synthetic-0001` from `photo-of-my-cat.png`. So a
 * field token of `dungeon.rooms` or `dungeon.edges` is *refused by the constructor*, and the
 * caller gets a `TypeError` rather than this module's typed refusal. That is the one way a
 * malformed file escapes the code/reason contract every other refusal obeys, and it is
 * exactly what happened the first time this was written: the hostile-input gate found it.
 * Hence the rule: **a `field` token is always a bare key name from one of the declared key
 * sets**, never a path into the source record, and the gate asserts every string detail is
 * drawn from the product's own exported vocabulary.
 */
function refuse(reason: SubjectTemplateRefusalReason, details: Record<string, string | number | boolean> = {}): never {
  throw new StorageV2Error('VALIDATION_FAILED', { reason, ...details });
}

/**
 * A closed key set, checked in both directions.
 *
 * An **unexpected** key is reported as a *count* and never by name. A key in an
 * untrusted document is attacker-controlled, and naming one in a `StorageV2Error` detail
 * would either be refused by the constructor - turning a typed refusal into a
 * `TypeError`, the one way a malformed file escapes the code/reason contract - or, worse,
 * succeed and put a learner's own field name into a report. The count says what a caller
 * needs and cannot leak. A **missing** key is named, because the list of names searched
 * is this product's own closed vocabulary and therefore always code-shaped.
 *
 * This is also the mechanism that makes a prototype-named key a refusal rather than a
 * hazard: `JSON.parse` creates `__proto__` as a genuine own data property, so
 * `Object.keys` reports it, it is not in the required list, and the count goes above
 * zero. Nothing in this module ever assigns an untrusted string onto a plain object.
 */
function closedKeyCheck(
  value: Record<string, unknown>,
  required: readonly string[],
  reasons: {
    readonly unexpected: SubjectTemplateRefusalReason;
    readonly missing: SubjectTemplateRefusalReason;
  },
  field: string,
): void {
  const declared = Object.keys(value).sort();
  const unexpected = declared.filter((key) => !required.includes(key)).length;
  if (unexpected > 0) {
    refuse(reasons.unexpected, { field, keyCount: unexpected });
  }
  for (const key of required) {
    if (!declared.includes(key)) refuse(reasons.missing, { field });
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isSemver(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function isOneOf<T extends string>(value: unknown, vocabulary: readonly T[]): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value);
}

/** Code-unit order, so every sort in this module is locale-independent. */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ── Tag approval ───────────────────────────────────────────────────────────

/**
 * The one tag rule, applied to both the raw and the normalised form.
 *
 * A tag is refused when **either** form is a name that cannot be an ordinary own key of
 * a plain object, and there is a separate reason for each. The two halves are different
 * failures and one rule would hide the other:
 *
 * - The **raw** form is refused because accepting it would mean *silently renaming* the
 *   user's tag. `normalizeTag('__proto__')` is `'proto'`, so a template that accepted
 *   the raw form would ship a file whose tag is not the tag the user approved - and the
 *   user would have no way to see that. A refusal is the honest answer.
 * - The **normalised** form is refused because of where tags end up. The importer
 *   rebuilds `DungeonMetadata.tagIndex` with the application's own
 *   {@link rebuildTagIndex}, which returns a **plain** object, and on a plain object a
 *   `__proto__` key is a prototype assignment rather than a member. A tag that
 *   normalised to a prototype name would be lost from the index with no error anywhere.
 *
 * Every other prototype name is refused for the same reason it is refused as an archive
 * member name: it shadows an inherited method, and a name this build cannot represent
 * as a key is not a name this build should adopt.
 */
function assertTagIsRepresentable(value: string, form: SubjectTemplateTagFormToken): string {
  if (isPrototypeMemberName(value)) {
    refuse('tag-is-a-reserved-word', { form });
  }
  return value;
}

/**
 * Normalise, dedupe, sort, and bound an approved tag list.
 *
 * The application's own {@link normalizeTag} is the rule - trim, lowercase, strip
 * anything that is not `[a-z0-9 -]`, collapse runs of dashes, drop leading and trailing
 * dashes, cap at 64 characters - borrowed rather than re-derived, so a tag written by
 * the app and a tag approved for a template are the same string. A tag that normalises
 * to nothing is dropped rather than refused: an all-punctuation tag is a tag the app
 * would not have stored either.
 *
 * A duplicate is refused rather than silently collapsed. A duplicate means the same tag
 * was approved twice, which for a *privacy* approval step is a signal something is
 * wrong upstream; and the dedupe is only needed because the document is canonical.
 */
function normaliseApprovedTags(approved: readonly string[]): string[] {
  if (approved.length > SUBJECT_TEMPLATE_MAX_TAGS) {
    refuse('too-many-tags', { count: approved.length });
  }
  const seen = new Set<string>();
  for (const raw of approved) {
    if (typeof raw !== 'string') refuse('tag-not-approved-shape');
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    assertTagIsRepresentable(trimmed, 'raw');
    const normalized = normalizeTag(trimmed);
    if (normalized.length === 0) continue;
    assertTagIsRepresentable(normalized, 'normalised');
    if (seen.has(normalized)) refuse('duplicate-approved-tag');
    seen.add(normalized);
  }
  return [...seen].sort(byCodeUnit);
}

/**
 * A re-export of the application's tag rule, so the two uses in this module cannot drift.
 *
 * `tagDomain.normalizeTag` is the *only* definition of what a tag is: the store
 * normalises with it, the index rebuilds with it, and this product's approval list
 * normalises with it. Re-stating it here would be a second dialect of the same rule, and
 * a tag the app stored as `vector-maths` and a tag this product approved as
 * `vector-maths+` would then be different strings - which is precisely the confusion that
 * makes an approval list untrustworthy.
 */
const { normalizeTag } = tagDomain;

// ── Reading a document ─────────────────────────────────────────────────────

/**
 * Measure a template's byte length and nesting depth without parsing it.
 *
 * A lexical scan, not a parse, and it exists for two reasons. The byte length is checked
 * before `JSON.parse` ever sees the text, so a four-megabyte file is refused without a
 * parser allocating for it. The depth is checked for the same reason
 * {@link SUBJECT_TEMPLATE_MAX_DEPTH} exists: a document nested far deeper than this
 * grammar allows can exhaust the parser's own stack, and a refusal the parser produced
 * by throwing a `RangeError` would be the one failure this module could not classify.
 *
 * The scan tracks string literals and escapes, so a brace inside a topic does not count
 * as nesting.
 */
export function measureSubjectTemplate(raw: string): {
  readonly byteLength: number;
  readonly maxDepth: number;
} {
  let maxDepth = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
      continue;
    }
    if (character === '}' || character === ']') {
      depth -= 1;
    }
  }
  return { byteLength: new TextEncoder().encode(raw).byteLength, maxDepth };
}

/**
 * Refuse a document whose three version contracts this build cannot honour.
 *
 * Three refusals with three reasons, because they fail for three different reasons and a
 * caller that merged them would not know which contract it was violating. The
 * subject-schema one is the one that stops a *newer* template being read by an older
 * build and silently losing structure.
 */
function assertSupportedVersions(
  formatVersion: number,
  storageGenerationFormatVersion: number,
  subjectSchemaVersion: string,
): void {
  if (formatVersion !== SUBJECT_TEMPLATE_FORMAT_VERSION) {
    refuse('unsupported-product-format-version', { field: 'formatVersion' });
  }
  if (storageGenerationFormatVersion !== STORAGE_V2_GENERATION_FORMAT_VERSION) {
    refuse('unsupported-storage-format-version', { field: 'storageGenerationFormatVersion' });
  }
  if (subjectSchemaVersion !== CANONICAL_SUBJECT_SCHEMA_VERSION) {
    refuse('unsupported-subject-schema-version', { field: 'subjectSchemaVersion' });
  }
}

/** A bounded, non-empty string, or `null` when the document declared none. */
function readOptionalLabel(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') refuse('label-wrong-shape', { field });
  if (value.length === 0) refuse('label-wrong-shape', { field });
  if (value.length > SUBJECT_TEMPLATE_MAX_TEXT_LENGTH) refuse('text-too-long', { field });
  return value;
}

/** A required, bounded, non-empty string. */
function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) refuse('label-wrong-shape', { field });
  if (value.length > SUBJECT_TEMPLATE_MAX_TEXT_LENGTH) refuse('text-too-long', { field });
  return value;
}

/** An array of tags: validated, deduplicated, sorted. */
function readTagList(value: unknown, approved: readonly string[]): string[] {
  if (!Array.isArray(value)) refuse('tag-not-approved-shape', { field: 'tags' });
  if (value.length > SUBJECT_TEMPLATE_MAX_TAGS) refuse('too-many-tags', { count: value.length });
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length === 0) {
      refuse('tag-not-approved-shape', { field: 'tags' });
    }
    assertTagIsRepresentable(raw, 'raw');
    const normalized = normalizeTag(raw);
    if (normalized.length === 0) refuse('tag-not-approved-shape', { field: 'tags' });
    assertTagIsRepresentable(normalized, 'normalised');
    if (normalized !== raw) {
      // A hand-made document that spells a tag in a form the application would never
      // store is refused rather than normalised. The exporter only ever writes the
      // normalised form, so a document that differs is one this build did not write, and
      // silently rewriting it would mean the file the learner approved is not the file
      // that got imported.
      refuse('tag-not-approved-shape', { field: 'tags' });
    }
    if (!approved.includes(normalized)) refuse('tag-not-in-the-approved-list', { field: 'tags' });
    if (seen.has(normalized)) refuse('duplicate-approved-tag', { field: 'tags' });
    seen.add(normalized);
  }
  return [...seen].sort(byCodeUnit);
}

/** The approved vocabulary itself: validated, deduplicated, sorted. */
function readApprovedVocabulary(value: unknown): string[] {
  if (!Array.isArray(value)) refuse('tag-not-approved-shape', { field: 'tags' });
  if (value.length > SUBJECT_TEMPLATE_MAX_TAGS) refuse('too-many-tags', { count: value.length });
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length === 0) {
      refuse('tag-not-approved-shape', { field: 'tags' });
    }
    assertTagIsRepresentable(raw, 'raw');
    const normalized = normalizeTag(raw);
    if (normalized.length === 0) refuse('tag-not-approved-shape', { field: 'tags' });
    assertTagIsRepresentable(normalized, 'normalised');
    if (normalized !== raw) refuse('tag-not-approved-shape', { field: 'tags' });
    if (seen.has(normalized)) refuse('duplicate-approved-tag', { field: 'tags' });
    seen.add(normalized);
  }
  return [...seen].sort(byCodeUnit);
}

/**
 * Read the `graph` sub-document into a normalised, validated graph.
 *
 * Normalising here is what makes a hand-made document behave like a written one: tag
 * lists are sorted, and the array order is whatever the file says. The *room order* is
 * **not** re-derived, because the file's room order is already the exporter's canonical
 * order and re-deriving it would silently reorder a document somebody hand-edited - so
 * the importer preserves the file's order exactly, which is also what "Imported graph
 * structure matches the export" asks for.
 */
function readGraph(value: unknown): SubjectTemplateGraph {
  if (!isRecordObject(value)) refuse('graph-wrong-shape', { field: 'graph' });
  closedKeyCheck(
    value,
    [...SUBJECT_TEMPLATE_GRAPH_KEYS],
    { unexpected: 'graph-unexpected-field', missing: 'graph-missing-field' },
    'graph',
  );

  if (!Array.isArray(value.rooms)) refuse('graph-wrong-shape', { field: 'rooms' });
  if (value.rooms.length > SUBJECT_TEMPLATE_MAX_ROOMS) {
    refuse('too-many-rooms', { count: value.rooms.length });
  }
  const tags = readApprovedVocabulary(value.tags);
  const rooms: SubjectTemplateRoom[] = value.rooms.map((entry, index) => {
    if (!isRecordObject(entry)) refuse('room-wrong-shape', { field: 'rooms', index });
    closedKeyCheck(
      entry,
      [...SUBJECT_TEMPLATE_ROOM_KEYS],
      { unexpected: 'room-unexpected-field', missing: 'room-missing-field' },
      'rooms',
    );
    return {
      topic: readRequiredText(entry.topic, 'topic'),
      tags: readTagList(entry.tags, tags),
    };
  });

  const structureEdgeCount = Array.isArray(value.structureEdges) ? value.structureEdges.length : -1;
  const crossLinkCount = Array.isArray(value.crossLinks) ? value.crossLinks.length : -1;
  if (structureEdgeCount < 0) refuse('graph-wrong-shape', { field: 'structureEdges' });
  if (crossLinkCount < 0) refuse('graph-wrong-shape', { field: 'crossLinks' });
  if (structureEdgeCount + crossLinkCount > SUBJECT_TEMPLATE_MAX_EDGES) {
    refuse('too-many-edges', { count: structureEdgeCount + crossLinkCount });
  }

  const structureEdges = (value.structureEdges as unknown[]).map((entry, index) => {
    if (!isRecordObject(entry)) refuse('edge-wrong-shape', { field: 'structureEdges', index });
    closedKeyCheck(
      entry,
      [...SUBJECT_TEMPLATE_STRUCTURE_EDGE_KEYS],
      { unexpected: 'structure-edge-unexpected-field', missing: 'structure-edge-missing-field' },
      'structureEdges',
    );
    if (!isInteger(entry.from) || !isInteger(entry.to)) {
      refuse('edge-wrong-shape', { field: 'structureEdges', index });
    }
    if (!isOneOf(entry.createdByPhase, EDGE_PHASES)) {
      refuse('edge-wrong-shape', { field: 'structureEdges', index });
    }
    return {
      from: entry.from,
      to: entry.to,
      createdByPhase: entry.createdByPhase,
    };
  });

  const crossLinks = (value.crossLinks as unknown[]).map((entry, index) => {
    if (!isRecordObject(entry)) refuse('edge-wrong-shape', { field: 'crossLinks', index });
    closedKeyCheck(
      entry,
      [...SUBJECT_TEMPLATE_CROSS_LINK_KEYS],
      { unexpected: 'cross-link-unexpected-field', missing: 'cross-link-missing-field' },
      'crossLinks',
    );
    if (!isInteger(entry.from) || !isInteger(entry.to)) {
      refuse('edge-wrong-shape', { field: 'crossLinks', index });
    }
    if (!isOneOf(entry.relationType, EDGE_RELATION_TYPES)) {
      refuse('edge-wrong-shape', { field: 'crossLinks', index });
    }
    if (!isOneOf(entry.createdByPhase, EDGE_PHASES)) {
      refuse('edge-wrong-shape', { field: 'crossLinks', index });
    }
    return {
      from: entry.from,
      to: entry.to,
      relationType: entry.relationType,
      createdByPhase: entry.createdByPhase,
    };
  });

  const biome = readOptionalLabel(value.biome, 'biome');
  if (!isInteger(value.rootIndex)) refuse('graph-wrong-shape', { field: 'rootIndex' });

  const graph: SubjectTemplateGraph = { rootIndex: value.rootIndex, rooms, structureEdges, crossLinks, tags, biome };
  assertGraphWellFormed(graph);
  return graph;
}

/**
 * The graph rules, shared by the exporter and the importer.
 *
 * One function, two callers, and that is the point: "Imported graph structure matches
 * the export" is only a meaningful claim if both ends hold the *same* rules, and two
 * hand-written copies of "an edge must name a room that exists" is how they start
 * disagreeing. So the exporter normalises a snapshot into this same shape and runs this
 * same function before it writes, and the importer runs it after it reads.
 *
 * The five rules, and why each is a refusal rather than a repair:
 *
 * 1. **At least one room, and a root that names one.** Section 7.3 lists "Root topic" as
 *    one of the six permitted things, and the app's own validator requires a non-empty
 *    `rootRoomId`, so a template with no root cannot become a subject the learner can
 *    open. Refusing is better than minting a root the author did not choose.
 * 2. **Every endpoint in range.** An index the rooms array does not contain is a
 *    dangling reference. Carrying it would produce a subject with an edge to nowhere.
 * 3. **No self-loop.** `graphDomain.addCrossLink` refuses one, so a template that
 *    contained one could not have been produced by the application.
 * 4. **No duplicate edge pair.** Same reason, same function: `addCrossLink` refuses an
 *    edge that already exists.
 * 5. **One structure parent per room.** The root-and-direct-children floor model
 *    (plan section 5.2) assumes a room has one parent, and `reparentRoom` removes the
 *    previous `subtopic` edge to enforce it. Two `subtopic` edges into one room is the
 *    same room declared twice in the hierarchy, and it is the failure the floor model
 *    cannot represent.
 */
function assertGraphWellFormed(graph: SubjectTemplateGraph): void {
  if (graph.rooms.length === 0) refuse('graph-has-no-rooms', { field: 'graph' });
  if (graph.rootIndex < 0 || graph.rootIndex >= graph.rooms.length) {
    refuse('graph-has-no-root', { field: 'rootIndex' });
  }
  const roomCount = graph.rooms.length;
  const parents = new Set<number>();
  const pairs = new Set<string>();
  const inRange = (index: number): boolean => index >= 0 && index < roomCount;

  for (const edge of graph.structureEdges) {
    if (!inRange(edge.from) || !inRange(edge.to)) {
      refuse('edge-names-a-room-that-does-not-exist', { field: 'structureEdges' });
    }
    if (edge.from === edge.to) refuse('self-loop-edge', { field: 'structureEdges' });
    if (pairs.has(`${edge.from}>${edge.to}`)) refuse('duplicate-edge', { field: 'structureEdges' });
    pairs.add(`${edge.from}>${edge.to}`);
    if (parents.has(edge.to)) refuse('room-has-two-structure-parents', { field: 'structureEdges' });
    parents.add(edge.to);
  }
  for (const link of graph.crossLinks) {
    if (!inRange(link.from) || !inRange(link.to)) {
      refuse('edge-names-a-room-that-does-not-exist', { field: 'crossLinks' });
    }
    if (link.from === link.to) refuse('self-loop-edge', { field: 'crossLinks' });
    if (pairs.has(`${link.from}>${link.to}`)) refuse('duplicate-edge', { field: 'crossLinks' });
    pairs.add(`${link.from}>${link.to}`);
  }
}

/**
 * Read a `.kdtemplate` and refuse anything this build cannot honour, touching nothing.
 *
 * The order of the checks is the order a person would use: is the file small and shallow
 * enough to parse at all, is it JSON, is it *this* product, are the three version
 * contracts ones this build honours, and only then is its shape walked. A file that is
 * not JSON is told it is not JSON rather than being told its sixth key is unexpected.
 *
 * Returns the normalised graph and the sanitized preview. The preview carries no learner
 * text, so a caller may render it, log it, and attach it to a report.
 */
export function readSubjectTemplate(raw: string): {
  readonly graph: SubjectTemplateGraph;
  readonly preview: SubjectTemplatePreview;
  readonly createdAt: string;
  readonly name: string | null;
} {
  const measured = measureSubjectTemplate(raw);
  if (measured.byteLength > SUBJECT_TEMPLATE_MAX_BYTES) {
    refuse('template-too-large', { byteLength: measured.byteLength });
  }
  if (measured.maxDepth > SUBJECT_TEMPLATE_MAX_DEPTH) {
    refuse('template-nested-too-deeply', { depth: measured.maxDepth });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse('template-not-json');
  }
  if (!isRecordObject(parsed)) refuse('document-wrong-shape', { field: 'document' });
  // The pre-Phase-7 legacy document gets its own reason rather than a generic
  // "unexpected field", because it is the one hostile shape a real user of this
  // repository could plausibly have on disk: a file written by the Welcome screen's
  // template button before cutover. It carried `roomId`s, `attachments`, filenames and
  // the subject name, so it is refused outright and never partially read.
  if (parsed.format === 'knowledge-dungeon-template') {
    refuse('legacy-template-format-refused');
  }

  closedKeyCheck(
    parsed,
    [...SUBJECT_TEMPLATE_DOCUMENT_KEYS],
    { unexpected: 'document-unexpected-field', missing: 'document-missing-field' },
    'document',
  );
  if (parsed.product !== SUBJECT_TEMPLATE_PRODUCT) {
    refuse('unsupported-product-format-version', { field: 'product' });
  }
  if (!isInteger(parsed.formatVersion)) refuse('document-wrong-shape', { field: 'formatVersion' });
  if (!isInteger(parsed.storageGenerationFormatVersion)) {
    refuse('document-wrong-shape', { field: 'storageGenerationFormatVersion' });
  }
  if (!isSemver(parsed.subjectSchemaVersion)) {
    refuse('document-wrong-shape', { field: 'subjectSchemaVersion' });
  }
  assertSupportedVersions(
    parsed.formatVersion,
    parsed.storageGenerationFormatVersion,
    parsed.subjectSchemaVersion,
  );
  if (typeof parsed.createdAt !== 'string' || parsed.createdAt.length === 0) {
    refuse('document-wrong-shape', { field: 'createdAt' });
  }
  const name = readOptionalLabel(parsed.name, 'name');
  const description = readOptionalLabel(parsed.description, 'description');
  const graph = readGraph(parsed.graph);

  return {
    graph,
    createdAt: parsed.createdAt,
    name,
    preview: previewOf({
      createdAt: parsed.createdAt,
      graph,
      hasName: name !== null,
      hasDescription: description !== null,
    }),
  };
}

function previewOf(input: {
  readonly createdAt: string;
  readonly graph: SubjectTemplateGraph;
  readonly hasName: boolean;
  readonly hasDescription: boolean;
}): SubjectTemplatePreview {
  return {
    product: SUBJECT_TEMPLATE_PRODUCT,
    formatVersion: SUBJECT_TEMPLATE_FORMAT_VERSION,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt: input.createdAt,
    roomCount: input.graph.rooms.length,
    structureEdgeCount: input.graph.structureEdges.length,
    crossLinkCount: input.graph.crossLinks.length,
    approvedTagCount: input.graph.tags.length,
    hasBiome: input.graph.biome !== null,
    hasName: input.hasName,
    hasDescription: input.hasDescription,
    fileName: SUBJECT_TEMPLATE_FILE_NAME,
  };
}

/** {@link readSubjectTemplate} as a preview, for a UI that renders the failure. */
export type SubjectTemplateInspection =
  | { readonly ok: true; readonly preview: SubjectTemplatePreview }
  | {
      readonly ok: false;
      readonly error: ReturnType<StorageV2Error['toReport']>;
    };

/**
 * {@link readSubjectTemplate} as a result rather than a throw.
 *
 * A preview is the one place where a failure is an expected outcome rather than an
 * exception, so this returns the same sanitized report the typed error carries and never
 * re-throws. An untyped throw is reported with a fixed code and a fixed reason, because
 * a reason the reader cannot classify is not a refusal.
 */
export function inspectSubjectTemplate(raw: string): SubjectTemplateInspection {
  try {
    return { ok: true, preview: readSubjectTemplate(raw).preview };
  } catch (error) {
    if (error instanceof StorageV2Error) return { ok: false, error: error.toReport() };
    return {
      ok: false,
      error: { code: 'ARCHIVE_MALFORMED' as const, details: { reason: 'template-unreadable' } },
    };
  }
}

// ── Building a graph out of a subject snapshot ─────────────────────────────

/** Separates the parts of a composite content key: rooms, and the fields within one. */
const KEY_UNIT = '\u0000';
const KEY_FIELD = '\u0001';

/** A room, while it is still identified by its source id and not yet by an index. */
interface InternalRoom {
  readonly roomId: string;
  readonly topic: string;
  readonly tags: readonly string[];
}

interface InternalEdge {
  readonly from: string;
  readonly to: string;
  readonly relationType: EdgeRelationType;
  readonly createdByPhase: EdgeCreatedByPhase;
}

interface InternalGraph {
  readonly rootRoomId: string | null;
  readonly rooms: InternalRoom[];
  readonly structureEdges: InternalEdge[];
  readonly crossLinks: InternalEdge[];
  readonly tags: readonly string[];
  readonly biome: string | null;
}

/**
 * Normalise a subject snapshot into the same graph shape a document describes.
 *
 * This is the **allowlist**, written as code. It is a function that reads six things and
 * returns a fresh structure built from declared fields; there is no `...room` anywhere in
 * it, no `Object.entries` walk of a record, and no branch that copies a field nobody
 * enumerated. That is what makes the property structural rather than a matter of
 * discipline, and it is why the determinism gate can require two snapshots differing in
 * every unlisted field to produce identical bytes.
 *
 * The refusals are the exporter's own, and each is a source this build refuses to encode
 * rather than encode lossily:
 *
 * - a room whose map key disagrees with its own `roomId`, because the exporter cannot
 *   decide which of the two is the room;
 * - a `dungeon.rooms` summary with no payload, which the app's own importer refuses too;
 * - a room with no rooms at all, and a subject with rooms but no resolvable root, because
 *   a template with no root cannot be imported and a template this build writes must be
 *   importable by this build;
 * - an edge naming a room the subject does not have, or carrying a relation type or
 *   authoring phase outside the application's own vocabulary, because the importer would
 *   refuse the resulting document and a silently dropped edge is data loss in a file.
 */
function graphFromSnapshot(
  snapshot: SubjectSnapshot,
  approvedTags: readonly string[],
  approvedBiome: string | null,
): InternalGraph {
  const dungeon = snapshot.dungeon;
  if (!isRecordObject(dungeon)) refuse('snapshot-edge-is-malformed', { field: 'dungeon' });

  const entries = Object.entries(snapshot.rooms ?? {});
  const rooms: InternalRoom[] = [];
  const known = new Set<string>();
  for (const [roomId, room] of entries) {
    if (!isRecordObject(room)) refuse('snapshot-room-topic-is-not-text', { field: 'rooms' });
    if (room.roomId !== roomId) {
      refuse('snapshot-room-key-disagrees-with-its-room-id', { field: 'rooms' });
    }
    if (typeof room.topic !== 'string' || room.topic.length === 0) {
      refuse('snapshot-room-topic-is-not-text', { field: 'rooms' });
    }
    if (room.topic.length > SUBJECT_TEMPLATE_MAX_TEXT_LENGTH) {
      refuse('text-too-long', { field: 'rooms' });
    }
    // The intersection. A tag that is in the subject but was not approved cannot reach
    // the document, which is the whole point of `approvedTags` being a parameter.
    const roomTags = Array.isArray(room.tags) ? room.tags : [];
    const tags = roomTags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => normalizeTag(tag))
      .filter((tag) => tag.length > 0 && approvedTags.includes(tag));
    rooms.push({ roomId, topic: room.topic, tags: [...new Set(tags)].sort(byCodeUnit) });
    known.add(roomId);
  }
  if (rooms.length === 0) refuse('snapshot-has-no-rooms');
  if (rooms.length > SUBJECT_TEMPLATE_MAX_ROOMS) {
    refuse('too-many-rooms', { count: rooms.length });
  }

  if (Array.isArray(dungeon.rooms)) {
    for (const summary of dungeon.rooms) {
      if (!isRecordObject(summary) || typeof summary.roomId !== 'string') {
        refuse('snapshot-edge-is-malformed', { field: 'rooms' });
      }
      if (!known.has(summary.roomId)) {
        refuse('snapshot-room-summary-without-payload', { field: 'rooms' });
      }
    }
  }

  const structureEdges: InternalEdge[] = [];
  const crossLinks: InternalEdge[] = [];
  const rawEdges = Array.isArray(dungeon.edges) ? dungeon.edges : [];
  if (rawEdges.length > SUBJECT_TEMPLATE_MAX_EDGES) {
    refuse('too-many-edges', { count: rawEdges.length });
  }
  for (const raw of rawEdges) {
    if (!isRecordObject(raw)) refuse('snapshot-edge-is-malformed', { field: 'dungeon.edges' });
    const { fromRoomId, toRoomId, relationType, createdByPhase } = raw;
    if (typeof fromRoomId !== 'string' || typeof toRoomId !== 'string') {
      refuse('snapshot-edge-is-malformed', { field: 'edges' });
    }
    if (!known.has(fromRoomId) || !known.has(toRoomId)) {
      refuse('edge-names-a-room-that-does-not-exist', { field: 'edges' });
    }
    if (!isOneOf(relationType, EDGE_RELATION_TYPES)) {
      refuse('snapshot-edge-vocabulary-is-unknown', { field: 'relationType' });
    }
    if (!isOneOf(createdByPhase, EDGE_PHASES)) {
      refuse('snapshot-edge-vocabulary-is-unknown', { field: 'createdByPhase' });
    }
    const edge: InternalEdge = { from: fromRoomId, to: toRoomId, relationType, createdByPhase };
    // The split, and it is the domain's own: `navigation.ts` walks the hierarchy by
    // filtering for exactly `subtopic`, and `addCrossLink` creates everything else.
    if (relationType === 'subtopic') structureEdges.push(edge);
    else crossLinks.push(edge);
  }

  const rootRoomId =
    typeof dungeon.rootRoomId === 'string' && known.has(dungeon.rootRoomId) ? dungeon.rootRoomId : null;
  if (rootRoomId === null) refuse('snapshot-has-no-resolvable-root');

  return { rootRoomId, rooms, structureEdges, crossLinks, tags: approvedTags, biome: approvedBiome };
}

// ── The canonical room order ───────────────────────────────────────────────

/**
 * The room order, as a function of the graph's **content** and never of its identifiers.
 *
 * This is the load-bearing piece of "no original IDs", and it is easy to get wrong in a
 * way that looks correct. The obvious orderings both fail the byte-identity gate:
 * sorting by room id makes two subjects with the same graph and different ids emit
 * different bytes, and sorting by nothing at all makes the order a function of JavaScript
 * key insertion order, which is a function of how the learner built the graph. So:
 *
 * 1. **Breadth-first from the root** along the structure edges, so the hierarchy reads in
 *    the order a person would draw it, and so the document's room array is a legible
 *    skeleton rather than a scramble.
 * 2. **Within a level, by content**: `topic`, then the room's tag list. A deterministic,
 *    identifier-free comparison.
 * 3. **Then everything the root cannot reach**, by the same content comparison, so a cycle
 *    or an orphan in a hand-edited subject still gets a position.
 * 4. **Then one tiebreak, and only between rooms the first three steps could not tell
 *    apart.** Two rooms with the same topic and the same tag list are ordered by their
 *    incident edges: each edge's relation type together with the **position from steps
 *    1-3** of the room at its other end. Those positions are themselves content-derived,
 *    so the key is identifier-free, and only genuinely-tied rooms are moved - which is
 *    what keeps the hierarchy readable while still making the order a function of the
 *    graph rather than of the ids that happened to be in it.
 *
 * The residual, stated rather than hidden: two rooms that are indistinguishable by topic,
 * tags, depth, **and** incident-edge structure are interchangeable, and the order between
 * them is whatever step 3 produced. Such a pair is either a learner who authored the same
 * heading twice - in which case either order is a faithful encoding of what they made -
 * or a genuinely isomorphic pair of nodes, which no ordering-based canonical form
 * distinguishes short of full graph canonisation. The gate's fixture is built so that
 * every room is distinguishable, and this paragraph is the honest boundary of the property
 * rather than a claim the code does not deliver.
 */
function canonicalRoomOrder(graph: InternalGraph): string[] {
  // Two separators, written as escapes so the source file stays plain text, and chosen
  // because a learner-authored topic cannot contain either of them: a composite sort key
  // whose parts can be confused with each other would order two different rooms the same
  // way, and the order is what makes the export byte-identical across subjects.

  const roomById = new Map(graph.rooms.map((room) => [room.roomId, room]));
  const childrenOf = new Map<string, string[]>();
  for (const edge of graph.structureEdges) {
    const siblings = childrenOf.get(edge.from);
    if (siblings === undefined) childrenOf.set(edge.from, [edge.to]);
    else siblings.push(edge.to);
  }
  const contentKey = (roomId: string): string => {
    const room = roomById.get(roomId) as InternalRoom;
    return `${room.topic}${KEY_UNIT}${room.tags.join(KEY_FIELD)}`;
  };
  const byContent = (left: string, right: string): number => {
    const difference = byCodeUnit(contentKey(left), contentKey(right));
    return difference !== 0 ? difference : byCodeUnit(left, right);
  };

  const order: string[] = [];
  const placed = new Set<string>();
  if (graph.rootRoomId !== null) {
    let level: string[] = [graph.rootRoomId];
    placed.add(graph.rootRoomId);
    order.push(graph.rootRoomId);
    while (level.length > 0) {
      const next: string[] = [];
      for (const parent of level) {
        for (const child of childrenOf.get(parent) ?? []) {
          if (placed.has(child)) continue;
          placed.add(child);
          next.push(child);
        }
      }
      next.sort(byContent);
      order.push(...next);
      level = next;
    }
  }
  const remaining = graph.rooms
    .map((room) => room.roomId)
    .filter((roomId) => !placed.has(roomId))
    .sort(byContent);
  order.push(...remaining);

  // ── The tiebreak, and only between rooms the first three steps could not separate ──
  //
  // The positions are taken **once**, from the order steps 1-3 produced, and the pass
  // never changes them. That is what makes this a tiebreak rather than a second sort: a
  // room that is already in its place because of its topic cannot be moved by an edge
  // key, so the readable hierarchy survives. The pass is also bounded rather than
  // run-until-stable, because "each room's key mentions its neighbours' positions" is a
  // recurrence that a sufficiently symmetric graph could fail to settle, and a
  // deterministic bound is worth more than a convergence claim.
  const positions = new Map<string, number>();
  order.forEach((roomId, index) => positions.set(roomId, index));
  const incidentKey = (roomId: string): string =>
    [...graph.structureEdges, ...graph.crossLinks]
      .filter((edge) => edge.from === roomId || edge.to === roomId)
      .map((edge) => {
        const other = edge.from === roomId ? edge.to : edge.from;
        return `${edge.relationType}:${positions.get(other) as number}`;
      })
      .sort(byCodeUnit)
      .join(',');

  // Rooms grouped by the content key that left them tied, in base order.
  const tiedPositions = new Map<string, number[]>();
  order.forEach((roomId, index) => {
    const key = contentKey(roomId);
    const group = tiedPositions.get(key);
    if (group === undefined) tiedPositions.set(key, [index]);
    else group.push(index);
  });

  for (const indices of tiedPositions.values()) {
    if (indices.length < 2) continue;
    const members = indices.map((index) => order[index] as string);
    const decorated = members.map((roomId, order) => ({ roomId, order, key: incidentKey(roomId) }));
    decorated.sort((left, right) => {
      const difference = byCodeUnit(left.key, right.key);
      // The base position is the final tiebreak, so the comparison is total and the pass
      // cannot reorder two rooms it genuinely cannot tell apart.
      return difference !== 0 ? difference : left.order - right.order;
    });
    decorated.forEach((entry, offset) => {
      order[indices[offset] as number] = entry.roomId;
    });
  }
  return order;
}

/**
 * Turn the internal graph into the document's index-addressed graph.
 *
 * The only place ids become indices, and it runs once, on the way out. Edges are then
 * sorted by `(from, to, relationType, createdByPhase)` so the array order is a function of
 * the graph rather than of the snapshot's edge insertion order - the same reason the
 * `.kdsubject` product sorts its records by derived id rather than by cursor order.
 */
function graphWithIndices(graph: InternalGraph): SubjectTemplateGraph {
  const order = canonicalRoomOrder(graph);
  const indexOf = new Map(order.map((roomId, index) => [roomId, index]));
  const roomById = new Map(graph.rooms.map((room) => [room.roomId, room]));
  const at = (roomId: string): number => indexOf.get(roomId) as number;

  const structureEdges = graph.structureEdges
    .map((edge) => ({
      from: at(edge.from),
      to: at(edge.to),
      createdByPhase: edge.createdByPhase,
    }))
    .sort(
      (left, right) =>
        left.from - right.from ||
        left.to - right.to ||
        byCodeUnit(left.createdByPhase, right.createdByPhase),
    );
  const crossLinks = graph.crossLinks
    .map((edge) => ({
      from: at(edge.from),
      to: at(edge.to),
      relationType: edge.relationType,
      createdByPhase: edge.createdByPhase,
    }))
    .sort(
      (left, right) =>
        left.from - right.from ||
        left.to - right.to ||
        byCodeUnit(left.relationType, right.relationType) ||
        byCodeUnit(left.createdByPhase, right.createdByPhase),
    );

  const out: SubjectTemplateGraph = {
    rootIndex: at(graph.rootRoomId as string),
    rooms: order.map((roomId) => {
      const room = roomById.get(roomId) as InternalRoom;
      return { topic: room.topic, tags: room.tags };
    }),
    structureEdges,
    crossLinks,
    tags: graph.tags,
    biome: graph.biome,
  };
  // The same five rules the importer runs. See `assertGraphWellFormed`.
  assertGraphWellFormed(out);
  return out;
}

// ── Writing a document ─────────────────────────────────────────────────────

/**
 * Produce a `.kdtemplate` from one subject snapshot.
 *
 * A **pure function** of `(snapshot, approvedTags, approvedBiome, name, description,
 * now)`. It reads no clock, mints no identifier, and calls no random source, so two
 * calls with equal arguments produce byte-identical text, and two calls on two
 * differently-identified but structurally identical subjects produce byte-identical text
 * too.
 *
 * The document is assembled from a literal, one key per line, from
 * {@link SUBJECT_TEMPLATE_DOCUMENT_KEYS}. There is no spread, no `Object.fromEntries`,
 * and no copy of a source field: a key that is not written here cannot be in the file.
 */
export function exportSubjectTemplate(
  snapshot: SubjectSnapshot,
  request: SubjectTemplateExportRequest,
): SubjectTemplateExportResult {
  if (typeof request.now !== 'string' || request.now.length === 0) {
    refuse('document-wrong-shape', { field: 'now' });
  }
  const approvedTags = normaliseApprovedTags(request.approvedTags ?? []);
  const approvedBiome = readOptionalLabel(request.approvedBiome ?? null, 'biome');
  const name = readOptionalLabel(request.name ?? null, 'name');
  const description = readOptionalLabel(request.description ?? null, 'description');

  const internal = graphFromSnapshot(snapshot, approvedTags, approvedBiome);
  const graph = graphWithIndices(internal);
  const document: SubjectTemplateDocument = {
    product: SUBJECT_TEMPLATE_PRODUCT,
    formatVersion: SUBJECT_TEMPLATE_FORMAT_VERSION,
    storageGenerationFormatVersion: STORAGE_V2_GENERATION_FORMAT_VERSION,
    subjectSchemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
    createdAt: request.now,
    name,
    description,
    graph,
  };
  const template = canonicalJsonStringify(document);
  const bytes = new TextEncoder().encode(template);

  return {
    template,
    fileName: SUBJECT_TEMPLATE_FILE_NAME,
    // The measurement of what is in the file, not a claim about the user. See
    // `SubjectTemplateExportResult.approvedTags`.
    approvedTags: graph.tags,
    approvedBiome: graph.biome,
    roomCount: graph.rooms.length,
    structureEdgeCount: graph.structureEdges.length,
    crossLinkCount: graph.crossLinks.length,
    contentChecksum: sha256Hex(bytes),
  };
}

// ── Minting a subject ──────────────────────────────────────────────────────

/**
 * Mint one identifier that is free on the destination.
 *
 * The generator's output is **data**, not a trusted value, so every candidate is
 * re-checked rather than assumed: it must be a non-empty string, it must not be a name
 * that cannot be an ordinary object key, it must not already be in use here or on the
 * destination, and the kind-prefixed form - the value that actually becomes a database
 * key - must be safe to put in a `StorageV2Error` detail. The last check is
 * {@link isSanitizedDetailText}, the application's own rule, borrowed rather than
 * re-derived, and it subsumes the prototype rule.
 *
 * The attempt bound is {@link SUBJECT_ID_MINT_ATTEMPTS}, the same bound the `.kdsubject`
 * copy remapper uses, so a generator that returns the same value forever is refused with
 * a typed error rather than producing two subjects that share an identifier - which is
 * the failure mode "Two imports create independent subjects" exists to rule out.
 */
function mintIdentifier(
  kind: SubjectIdKind,
  generator: SubjectIdGenerator,
  reserved: Set<string>,
  attempts: { count: number },
): string {
  for (let attempt = 0; attempt < SUBJECT_ID_MINT_ATTEMPTS; attempt += 1) {
    attempts.count += 1;
    const candidate = generator.next();
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    if (isPrototypeMemberName(candidate)) continue;
    if (reserved.has(candidate)) continue;
    const minted = candidate.startsWith(SUBJECT_ID_KIND_PREFIX[kind])
      ? candidate
      : `${SUBJECT_ID_KIND_PREFIX[kind]}-${candidate}`;
    if (!isSanitizedDetailText(minted) || reserved.has(minted)) continue;
    reserved.add(minted);
    reserved.add(candidate);
    return minted;
  }
  refuse('no-free-identifier', { kind });
}

/**
 * Create a new subject from a `.kdtemplate`: fresh identifiers, blank room state.
 *
 * Pure, and the pure half of the import. It reads no repository and opens no database, so
 * the whole of "Imported graph structure matches the export" and "Two imports create
 * independent subjects" is testable without `fake-indexeddb`.
 *
 * What is blank, and how completely:
 *
 * - every room is {@link SUBJECT_TEMPLATE_BLANK_ROOM_STATE} with
 *   {@link makeEmptyRoomMetadata}'s empty note text, `null` artifact, and
 *   {@link makeEmptyValidationState} validation state;
 * - `reviewPassCount` is `0` and `attachments` is `[]`, so there is no review state, no
 *   SM-2 history beyond the blank defaults, and no attachment metadata of any kind -
 *   not a filename, not an alt text, not a URL, not a byte;
 * - `dungeon.progression` is a blank mirror and **no** progression record is written, so
 *   there is no XP, no rank history, no badges, and no fish;
 * - `dungeon.phaseState` is `CreatorActive`, which is plan section 7.3's "Creator state";
 * - the only SM-2 values are the application's own blank defaults, stamped with the
 *   injected clock, which is what a migrated 1.0.0 room would carry and nothing more.
 *
 * `DungeonMetadata.tagIndex` is **rebuilt** with the application's own
 * {@link rebuildTagIndex} from the room tags, rather than being carried: the document
 * stores which approved tags a room has, and an index is derived from that, so writing
 * one into the file would be duplicating state that could disagree with itself. The
 * imported index is therefore always consistent with the imported rooms.
 *
 * The room map is built as a **null-prototype** object. A room id is data, and an id that
 * happened to be `__proto__` would otherwise change the object's prototype and lose the
 * room with no error anywhere - the same hazard the ZIP codec has to guard against for
 * member names. The gate asserts the imported room **count**, which is the only way to
 * notice.
 */
export function createSubjectFromTemplateSnapshot(
  raw: string,
  request: SubjectTemplateMintRequest,
): SubjectTemplateMintResult {
  const read = readSubjectTemplate(raw);
  const graph = read.graph;

  const reserved = new Set<string>(request.taken ?? []);
  const attempts = { count: 0 };
  const subjectId = mintIdentifier('subject', request.generator, reserved, attempts);
  const roomIds: string[] = [];
  for (let index = 0; index < graph.rooms.length; index += 1) {
    roomIds.push(mintIdentifier('room', request.generator, reserved, attempts));
  }
  const rootRoomId = roomIds[graph.rootIndex] as string;

  const { subjectName, subjectNameSource } = resolveSubjectName(read.name, request.destinationSubjectName);

  // A null-prototype map, for the reason documented above.
  const rooms = Object.create(null) as Record<string, ReturnType<typeof makeEmptyRoomMetadata>>;
  const summaries = graph.rooms.map((room, index) => {
    const roomId = roomIds[index] as string;
    const metadata = {
      ...makeEmptyRoomMetadata({ roomId, topic: room.topic, nowIso: request.now }),
      // Explicit rather than inherited from `makeEmptyRoomMetadata`, which does not set
      // them: these are the application's own blank SM-2 defaults, and an imported room
      // is in exactly the shape a migrated 1.0.0 room is in.
      validationState: makeEmptyValidationState(),
      tags: [...room.tags],
      sm2QualityResponse: 3,
      sm2EaseFactor: 2.5,
      sm2IntervalDays: 1,
      sm2NextReviewDate: request.now,
      sm2ConsecutiveCorrect: 0,
    };
    rooms[roomId] = metadata;
    return { roomId, topic: room.topic, status: SUBJECT_TEMPLATE_BLANK_ROOM_STATE };
  });

  // Structure edges first, then cross-links, in each case in the document's own order -
  // so the imported edge list is a deterministic function of the document.
  const edges = [
    ...graph.structureEdges.map((edge) => ({
      fromRoomId: roomIds[edge.from] as string,
      toRoomId: roomIds[edge.to] as string,
      relationType: 'subtopic' as const,
      createdAt: request.now,
      createdByPhase: edge.createdByPhase,
    })),
    ...graph.crossLinks.map((link) => ({
      fromRoomId: roomIds[link.from] as string,
      toRoomId: roomIds[link.to] as string,
      relationType: link.relationType,
      createdAt: request.now,
      createdByPhase: link.createdByPhase,
    })),
  ];

  const snapshot = {
    dungeon: {
      schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
      dungeonId: subjectId,
      subjectName,
      createdAt: request.now,
      updatedAt: request.now,
      phaseState: SUBJECT_TEMPLATE_BLANK_PHASE_STATE,
      rootRoomId,
      rooms: summaries,
      edges,
      progression: {
        xpTotal: SUBJECT_TEMPLATE_BLANK_PROGRESSION.xpTotal,
        rank: SUBJECT_TEMPLATE_BLANK_PROGRESSION.rank,
        badges: [],
        fishCollection: [],
      },
      ...(graph.biome === null ? {} : { biome: graph.biome }),
    },
    rooms,
  } as unknown as SubjectSnapshot;

  // The index is derived here, with the application's own rule, from the rooms this
  // function just built. Every tag is one that passed `assertTagIsRepresentable`, so the
  // plain object `rebuildTagIndex` returns cannot lose a key to a prototype name.
  (snapshot.dungeon as unknown as { tagIndex: Record<string, string[]> }).tagIndex =
    rebuildTagIndex(snapshot);

  // The product's own post-condition: a template this build writes, this build can open.
  // A refusal here is a bug in this module rather than in the input, and it is cheaper to
  // find it here than to find it in a subject the learner cannot open.
  assertImportableSubjectSnapshot(snapshot);

  return {
    preview: read.preview,
    snapshot,
    subjectId,
    roomIds,
    rootRoomId,
    subjectName,
    subjectNameSource,
    mintAttempts: attempts.count,
  };
}

/** The three-way name resolution, documented on {@link SubjectTemplateNameSource}. */
function resolveSubjectName(
  templateName: string | null,
  destinationSubjectName: string | null | undefined,
): { readonly subjectName: string; readonly subjectNameSource: SubjectTemplateNameSource } {
  if (typeof destinationSubjectName === 'string') {
    const trimmed = destinationSubjectName.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > SUBJECT_TEMPLATE_MAX_TEXT_LENGTH) {
        refuse('text-too-long', { field: 'destinationSubjectName' });
      }
      return { subjectName: trimmed, subjectNameSource: 'caller' };
    }
  }
  if (templateName !== null) {
    return { subjectName: templateName, subjectNameSource: 'template-name' };
  }
  return {
    subjectName: SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME,
    subjectNameSource: 'default',
  };
}

// ── The device half ────────────────────────────────────────────────────────

/**
 * Per-store record counts, with a zero for any store the descriptor omits.
 *
 * `GenerationDescriptor.recordCounts` is a partial record, so spreading it straight onto the
 * result would give a caller a `number | undefined` for eleven stores and force every one of
 * them to guess. A missing store is zero - a store with no records has none - so the count
 * the result reports is always complete and always eleven keys long.
 */
function storeCountsOf(descriptor: { readonly recordCounts?: Readonly<Partial<Record<StorageV2StoreName, number>>> } | null): Record<StorageV2StoreName, number> {
  const counts = {} as Record<StorageV2StoreName, number>;
  for (const store of STORAGE_V2_STORE_NAMES) {
    counts[store] = descriptor?.recordCounts?.[store] ?? 0;
  }
  return counts;
}

/**
 * Every subject and room identifier the device already holds.
 *
 * Deliberately **narrower** than the set the `.kdsubject` copy remapper avoids, and
 * narrower on purpose: this product mints a subject id and room ids and nothing else - no
 * attachment, session, assistance, fish, note or loot identifier exists in a template -
 * so avoiding collisions with kinds it never mints would be work whose only effect is a
 * slower import. The two shared primitives are reused rather than reimplemented
 * ({@link collectExistingIdentifiers} and `subjectIdentifierGroups` from `./idRemapping`),
 * so "what counts as a room id" has exactly one definition in the product tree.
 */
function deviceSubjectAndRoomIdentifiers(snapshot: GenerationSnapshot): ReadonlySet<string> {
  const groups: Array<{ readonly kind: SubjectIdKind; readonly ids: string[] }> = [];
  const roomIds: string[] = [];
  for (const envelope of snapshot.records.subjects) {
    const record = envelope.value as SubjectRecordValue;
    groups.push({ kind: 'subject', ids: [record.subjectId] });
    for (const group of subjectIdentifierGroups(record, [])) {
      if (group.kind === 'room') roomIds.push(...group.ids);
    }
  }
  const taken = new Set(collectExistingIdentifiers(groups).taken);
  for (const roomId of roomIds) taken.add(roomId);
  return taken;
}

/**
 * Import a `.kdtemplate` as a new subject, and change nothing else.
 *
 * ## Why this is one additive write and not a generation transaction
 *
 * Phases 5 and 6 both satisfy plan section 5.2 - "Data imports never partially overwrite
 * the active data generation" - by staging a complete new generation and flipping the
 * `activeGeneration` pointer, because both of those products *merge into* data the device
 * already holds. A template import has no merge. It adds exactly one record, under a
 * subject id that has just been minted and checked against every subject and room
 * identifier the active generation holds, and it deletes and updates nothing at all.
 *
 * There is therefore no overwrite for it to be partial, which is a **stronger** property
 * than the pointer flip rather than a weaker one, and the rollback becomes a single delete
 * of a record that did not exist before the call. Staging a whole generation here would
 * churn every record on the device, replace eleven stores' worth of byte-identical data,
 * and re-open the migration-receipt question Phase 6 had to answer - all to perform an
 * append.
 *
 * The gate in `tests/data/templateImportIsolation.test.ts` proves the property rather than
 * asserting it: it fingerprints every generation, every record envelope, and the whole
 * legacy `localStorage` key set before and after, requires that the **only** differences
 * are the one added record and the three derived descriptor fields, and separately proves
 * that the fingerprint can move.
 *
 * ## The order of operations, and what each failure costs
 *
 * 1. Read and validate the document. **Nothing has been touched**, so every one of the
 *    refusals leaves the device byte-identical.
 * 2. Read the active generation and build the taken-identifier set. Still nothing written.
 *    A device with no active generation has nothing to collide with, and
 *    `writeSubjectToActiveGeneration` creates the initial one - a real, visible
 *    generation, which the result reports as `previousActiveGenerationId: null`.
 * 3. Mint, and assert the minted snapshot is one the application's own importer accepts.
 *    Still nothing written, so a bad template fails before the device moves.
 * 4. Write the single record.
 * 5. Read it back and confirm it is there, and confirm the generation still validates.
 *    A failure here is an anomaly rather than a bad input, so the record is **deleted** and
 *    the error re-thrown; the records return to their prior state and the generation
 *    descriptor's `updatedAt` differs, which is the one thing a rollback cannot restore
 *    and which is stated here rather than papered over.
 */
export async function importSubjectTemplate(
  request: SubjectTemplateImportRequest,
): Promise<SubjectTemplateImportResult> {
  const { repository, template } = request;

  // ── 1. Read and validate. Nothing has been touched. ──
  //
  // The document is parsed **twice** on purpose, and the first result is deliberately
  // discarded. The first parse proves the document is one this build honours *before any
  // storage is read at all*, so every malformed-input refusal is a refusal with nothing
  // touched - which is the property `templateImportIsolation.test.ts` measures by
  // fingerprinting the device around each one. The second parse is the mint path's own, and
  // reusing the first one's result would mean the device half's correctness rested on a
  // parse cache this function would then have to keep honest. The cost is one extra parse of
  // a document the reader has already bounded to one mebibyte.
  readSubjectTemplate(template);

  // ── 2. The destination's identifiers ──
  const previousActiveGenerationId = await repository.readActiveGenerationId();
  const taken =
    previousActiveGenerationId === null
      ? new Set<string>()
      : deviceSubjectAndRoomIdentifiers(await repository.readRecords(previousActiveGenerationId));

  // ── 3. Mint, and prove the result is a subject this build can open ──
  const minted = createSubjectFromTemplateSnapshot(template, { ...request, taken });

  // ── 4. The single write ──
  await writeSubjectToActiveGeneration(
    repository,
    minted.subjectId,
    minted.snapshot,
    request.now,
  );

  // ── 5. Read back, and roll the record back if the device disagrees ──
  const generationId = previousActiveGenerationId ?? (await repository.readActiveGenerationId());
  if (generationId === null) {
    refuse('template-import-read-back-failed', { stage: 'generation' });
  }
  try {
    const reread = await repository.readRecords(generationId);
    const written = reread.records.subjects.find((entry) => entry.value.subjectId === minted.subjectId);
    // The comparison is against the record's own `snapshot`, not against the whole record
    // value: `writeSubjectToActiveGeneration` wraps the snapshot in a `SubjectRecordValue`,
    // and comparing the wrapper to the snapshot would compare two different shapes and
    // always disagree.
    if (written === undefined || checksumValue(written.value.snapshot) !== checksumValue(minted.snapshot)) {
      refuse('template-import-read-back-failed', { stage: 'records' });
    }
    // ...and the record's own subject id is the one this import minted, so a record written
    // under somebody else's id would be caught even if its value matched.
    if (written.value.subjectId !== minted.subjectId) {
      refuse('template-import-read-back-failed', { stage: 'identity' });
    }
    const validation = await repository.validateGeneration(generationId);
    if (!validation.ok) {
      // The only thing this import added is one subject record that step 3 proved the
      // application's own importer accepts, and the generation was the active one, so a
      // blocking problem here is not a bad template. It is an anomaly, and the record is
      // removed rather than left in a generation this build would not activate.
      refuse('template-import-read-back-failed', { stage: 'validate' });
    }
  } catch (error) {
    await repository.deleteRecords(generationId, { subjects: [minted.subjectId] });
    throw error;
  }

  const active = await repository.readGeneration(generationId);
  return {
    ...minted,
    generationId,
    previousActiveGenerationId,
    writePolicy: 'additive-single-record',
    rollback: 'delete-the-created-subject-record',
    // Read back from the descriptor rather than echoed from what was written: what the device
    // holds, not what this function believes it wrote.
    recordCounts: storeCountsOf(active?.descriptor ?? null),
    generator: request.generator,
  };
}



