/**
 * Identifier remapping for a `.kdsubject` **Create copy** import.
 *
 * Plan section 7.3 makes remapping the defining behaviour of the default import
 * mode: a copy "remaps subject, room, edge, fish, session, and attachment
 * identifiers". Everything else about copy mode follows from that. Two copies of
 * one subject that shared a room id would share a *room*: a room cleared in the
 * copy would appear cleared in the original, an attachment pointed at by id would
 * be the same attachment, and a session's `roomsVisited` would be a claim about
 * a room the copy does not have. So this module exists to make that impossible
 * rather than unlikely.
 *
 * ## Everything this module does *not* do
 *
 * It does not read a repository, open a database, or touch a clock. It is a
 * **pure function of (the exported records, the identifiers already on the
 * destination device, and an injected id generator)**, exported standalone so the
 * remapping rules can be tested without a `.kdsubject`, a ZIP codec, or
 * `fake-indexeddb`. `subjectBackup.ts` owns the archive and the generation
 * transaction; this module owns only "which id becomes which id, and what else in
 * the record named it".
 *
 * It does not hand-roll a ZIP. It imports no archive module at all.
 *
 * ## The three remapping passes
 *
 * **Pass 1 - declared locations.** Every place the domain contract says an
 * identifier lives is rewritten by declaration, not by inspection:
 *
 * | Location | Rule |
 * | --- | --- |
 * | `SubjectRecordValue.subjectId` | subject id |
 * | `snapshot.rooms` **keys** | room id |
 * | `RoomMetadata.roomId` | room id |
 * | `RoomMetadata.notePath`, `RoomMetadata.artifactPath` | room id, **whole path segment** |
 * | `RoomMetadata.attachments[].attachmentId` | attachment id |
 * | `DungeonMetadata.dungeonId` | subject id, **only when it equals the record's own `subjectId`** - see below |
 * | `DungeonMetadata.rootRoomId` | room id |
 * | `DungeonMetadata.rooms[].roomId` | room id |
 * | `DungeonMetadata.edges[].fromRoomId`, `.toRoomId` | room id |
 * | `DungeonMetadata.tagIndex.<tag>[]` | room id, in the **values** |
 * | `ProgressionRecordValue.subjectId` | subject id |
 * | `ProgressionRecordValue.bySubject` **key** | subject id, **only for the key equal to the record's own `subjectId`** - see below |
 * | `bySubject.<subject>.collectedNotes[].noteId` | note id |
 * | `bySubject.<subject>.collectedNotes[].dungeonId` | subject id |
 * | `bySubject.<subject>.collectedNotes[].roomId` | room id |
 * | `bySubject.<subject>.fishCollection[].id` | fish entry id |
 * | `bySubject.<subject>.fishCollection[].subjectId` | subject id |
 * | `bySubject.<subject>.inventory[].id` | loot item id |
 * | `bySubject.<subject>.equippedItems[].id` | loot item id |
 * | `SessionRecordValue.subjectId` | subject id |
 * | `SessionRecordValue.roomsVisited[]` | room id |
 * | `AttachmentMetadataRecordValue.subjectId` | subject id |
 * | `AttachmentMetadataRecordValue.roomId` | room id |
 * | `AttachmentMetadataRecordValue.attachmentId` | attachment id |
 * | `AttachmentBlobRecordValue.attachmentId` | attachment id |
 * | `AssistanceRecordValue.assistanceId` | assistance id |
 * | `SessionRecordValue.sessionId` | session id |
 *
 * ### The two conditional rows, and why they are conditional
 *
 * Both `DungeonMetadata.dungeonId` and the `bySubject` key are *usually* the
 * record's own `subjectId`, and both were previously handled without being declared:
 * the whole-token sweep happened to rewrite the matching value and happened to
 * rewrite the own key, which is the right answer for the right reason about half
 * the time and no answer at all otherwise.
 *
 * - `dungeonId` **is** this application's subject id - `subjectPersistence.ts` mints
 *   it with `generateId('subject')`, `tagDomain.ts` submits it as `subjectId`,
 *   `subjectActivation.ts` treats it as the active subject, and the migration reads
 *   `snapshot.dungeon.dungeonId || subject.subjectId`. So on a real device it agrees
 *   with the record and is rewritten. When a record **disagrees with itself** - a
 *   shape the validator does not refuse, and a hand-made archive can carry - a
 *   disagreeing value is not a reference this product can resolve: it names no
 *   subject the archive knows, and inventing a mapping for it would mint an
 *   identifier for an identity that does not exist. It is carried verbatim and
 *   disclosed as a `stale-subject-dungeon-id` so the copy is not silently wrong
 *   about which subject it is.
 * - A `bySubject` **key** that is not the record's own `subjectId` is *another
 *   subject's* learner state sharing this record, and its whole subtree is carried
 *   verbatim. See "A progression record is not owned by the subject it is keyed on"
 *   below.

 *
 * **Pass 2 - undeclared locations, by whole token.** An unknown app-owned field
 * can hold a room id, and if it does and the copy does not rewrite it, the copy is
 * silently broken. Pass 1 cannot know about a field this build has never heard of,
 * so pass 2 walks the *entire* record tree and rewrites any string that is
 * **exactly** one of the mapped identifiers, or a `/`-separated path one of whose
 * **segments** is. That is a token rule, not a substring rule, which is what makes
 * it safe:
 *
 * - `room-1` and `room-1a` are different tokens. Replacing `room-1` never touches
 *   `room-1a`'s path, and `room-1a`'s own path is rewritten because its *own*
 *   segment matches. This is the same class of bug Phase 5's `custom-sprites`
 *   member-path gate covers for member names.
 * - A room id containing `.`, `(`, `)`, `[`, `]`, `{`, `}`, `+`, `*`, `?`, `|`, `^`,
 *   `$`, or a non-ASCII character is compared with `===`. No regular expression is
 *   ever built from a learner-controlled id, so no metacharacter is ever special
 *   and no escaping can be got wrong.
 * - A string is never searched for an id *inside* it. See the policy below.
 *
 * **Pass 3 - protected fields, carried verbatim.** A *value* that happens to equal
 * a room id is not always a reference, for two separate reasons, and each has its own
 * declared set so the rules stay independently testable.
 *
 * - {@link PROTECTED_TEXT_FIELDS} - the value is the learner's own words. A room
 *   topic of `room-1`, a tag named `room-1`, a badge named `room-1`, a fish
 *   `subjectName` of `room-1`, a subject name of `room-1`: rewriting any of them
 *   corrupts content to fix nothing. This is why a room id which equals a tag name
 *   survives as a tag name.
 * - {@link FIXED_VOCABULARY_FIELDS} - the value comes from a closed vocabulary *this
 *   application owns*, so it can never be a reference. `DungeonMetadata.biome` is the
 *   case the Phase 6 fixture caught: a biome name that happens to equal a room id,
 *   which a value sweep turns into an id and leaves the subject with a biome that does
 *   not exist. Every `PHASE_STATES`, `ROOM_STATES`, `EDGE_RELATION_TYPES`,
 *   `EDGE_PHASES`, `AssistanceMode`, `AttachmentAvailability`, `RankTier`,
 *   `EquipSlot`, and `FishRarity` member is on that list for the same reason.
 *
 * A protected field is honoured wherever it appears - declared, unknown, or nested -
 * because the rule is about what the *field* means, not where it sits.
 * {@link PROTECTED_FIELDS} is the union the rewrite path consults.
 *
 * {@link PATH_FIELDS_REWRITTEN_BY_SEGMENT} is the deliberate exception, and it is the
 * specific defect this module exists to prevent: `notePath` and `artifactPath` are
 * paths, they *do* embed a room id (`rooms/<roomId>/notes.md`), and a room whose note
 * path points at a room that no longer exists is silently broken. They are therefore
 * not protected, and they are listed as their own set so
 * {@link PROTECTED_TEXT_FIELDS} cannot grow them back by accident.
 *
 * Object **keys** are never rewritten by pass 2 either, outside the two declared
 * key locations (`snapshot.rooms` and `progression.bySubject`). A key is at least
 * as likely to be a tag name, a field name, a badge token, or a criterion name as
 * it is to be an identifier, and there is no way to tell from the record alone.
 *
 * ## The residual, and why it is disclosed rather than guessed
 *
 * A string **value** that contains a mapped id as a *substring* but not as a whole
 * token - prose such as `"go to room-1 first"`, a subject name, a note - is carried
 * **verbatim** and counted in {@link SubjectRemapResult.unresolvedReferenceCount}.
 * Rewriting it would corrupt the learner's own text to fix a reference that may
 * not exist; dropping it would be data loss. Counting it is the only honest third
 * option, and it is surfaced on the import result so a screen can say "N strings
 * that mention an identifier were carried verbatim" rather than implying a perfect
 * rewrite.
 *
 * That number means **exactly** that: string values, mentions, not whole tokens.
 * It does not count:
 *
 * - an id in an object **key**, which is neither swept nor counted. A key is at
 *   least as likely to be a tag name, a field name, a badge token, or a criterion
 *   name as it is to be an identifier, there is no way to tell from the record
 *   alone, and rewriting keys is the specific corruption the `tagIndex` rule above
 *   exists to prevent. An unknown field keyed by a room id is therefore carried
 *   verbatim and is **not** disclosed by this count. That is a known, accepted gap
 *   and it is stated here rather than papered over: the alternative - rewriting
 *   every key that happens to equal an id - corrupts content that is far more
 *   common than the case it would fix.
 * - a string carried verbatim **by a declared rule** rather than by failing to
 *   match. Those are counted in
 *   {@link SubjectRemapResult.verbatimDisclosures}, one count per closed code, so
 *   a screen can say *why* a value was left alone. See that field's documentation.

 *
 * ## A progression record is not owned by the subject it is keyed on
 *
 * `ProgressionRecordValue` carries **both** a `subjectId` and a
 * `bySubject: Record<string, unknown>`, and storage-v2 keys the record on
 * `record.subjectId`. One record can therefore hold more than one subject's learner
 * state, and the shape the legacy writer produced does exactly that: the canonical
 * v3 `localStorage` envelope was a single progression record whose `bySubject` map
 * was filled with every subject on the device, and `normalizeProgressionRecord`
 * preserves every key it finds.
 *
 * So a `bySubject` key equal to `record.subjectId` is *this* subject's entry and is
 * remapped with everything nested inside it, and **every other key belongs to
 * somebody else** and is carried verbatim - key, fish ids, note ids, loot ids, and
 * any unknown field inside it. That is not politeness. `progressionEnvelopeFrom`
 * flattens every record's `bySubject` into one map, last writer wins, with the
 * records ordered by `record.subjectId`, so a second record holding a *remapped*
 * copy of another subject's entry is a fork whose winner is decided by a string
 * sort of two opaque identifiers. The learner would find a subject they never
 * touched reporting a different set of fish under a minted id.
 *
 * The identifiers collected from a foreign entry are therefore not minted either,
 * so the reported mapping does not claim a rewrite that did not happen.
 *
 * ## Unknown app-owned fields
 *
 * A field this build does not recognise is carried through **verbatim** apart from
 * the identifier rewrite in pass 2. Nothing is normalized, defaulted, re-derived,
 * dropped, or re-keyed: `extraFields` keeps its own structure, an unknown field on
 * a room keeps its own value, and an unknown field holding a room id gets the room
 * id rewritten. That is the Phase 5 contract (plan section 7.3: "The import must
 * preserve unknown app-owned fields") applied to copy mode, and it is why the
 * Phase 0 unknown-fields fixture is the right thing to test against.
 *
 * ## Collision avoidance
 *
 * A minted id is never accepted while it is:
 *
 * 1. already present on the destination device - supplied as
 *    {@link ExistingIdentifiers.taken}, which the caller builds from **every**
 *    record the active generation holds, of every subject;
 * 2. a value that could not be reported safely, which is
 *    {@link isSanitizedDetailText} - the application's own rule for a detail that is
 *    safe to log. A generated identifier becomes a database key *and* may legitimately
 *    appear in a `StorageV2Error`, so a candidate containing a space would be both an
 *    unkeyable record and a `TypeError` waiting to happen. The rule is borrowed rather
 *    than re-derived so the two cannot drift, and it subsumes the prototype rule: no
 *    name on `Object.prototype` satisfies it.
 *
 * A source id is deliberately **not** reserved. On the device a backup came from - the
 * case the independence gate measures - the source ids are in `taken` already, because
 * they are the destination's own records, so a copy provably shares nothing with them.
 * On a *different* device, where a shared room id would be harmless because there is no
 * shared state, reusing it is what makes a copy readable if a learner carries it home
 * again. Forbidding it would buy a stronger-sounding sentence and a worse product.
 *
 * The generator is **injected**, so its output is data like any other: a candidate
 * the generator returns that fails either check is discarded and the next one is asked
 * for, with a bounded number of attempts and a typed refusal when the bound is
 * reached. Nothing here trusts the generator to produce something safe.
 *
 * Renderer-neutral: no renderer, no UI, no network, no clock of its own.
 */

import {
  isSanitizedDetailText,
  StorageV2Error,
  type AssistanceRecordValue,
  type AttachmentBlobRecordValue,
  type AttachmentMetadataRecordValue,
  type ProgressionRecordValue,
  type SessionRecordValue,
  type SubjectRecordValue,
} from '@/services/persistence/v2/schema';
// Phase 7, RAIL CHANGE, recorded in `tests/data/subjectProductBoundary.test.ts`. This was
// `import { isPrototypeMemberName } from './archiveValidation'`, and the file is correct
// about the rule - but `archiveValidation.ts` imports the ZIP codec, so every consumer of
// this module inherited `fflate` in its static closure to ask one two-clause question. The
// rule's definition moved to `@/services/persistence/v2/prototypeNames`, a leaf that imports
// nothing, and this module names the leaf. `archiveValidation.ts` still re-exports the
// predicate, so no other import path changed and no behaviour changed.
import { isPrototypeMemberName } from '@/services/persistence/v2/prototypeNames';

// ── The id kinds ───────────────────────────────────────────────────────────

/**
 * Every kind of identifier a copy may have to mint.
 *
 * A closed set, not a free string: the kind is part of the minted id's prefix, so
 * two different kinds can never collide with each other even before the
 * destination check, and a reviewer can see the whole id vocabulary in one place.
 */
export const SUBJECT_ID_KINDS = [
  'subject',
  'room',
  'attachment',
  'session',
  'assistance',
  'fish',
  'note',
  'loot',
] as const;

export type SubjectIdKind = (typeof SUBJECT_ID_KINDS)[number];

/** Prefix each kind's minted identifiers carry. Fixed vocabulary, never learner data. */
export const SUBJECT_ID_KIND_PREFIX: Readonly<Record<SubjectIdKind, string>> = {
  subject: 'kc-subject',
  room: 'kc-room',
  attachment: 'kc-attachment',
  session: 'kc-session',
  assistance: 'kc-assistance',
  fish: 'kc-fish',
  note: 'kc-note',
  loot: 'kc-loot',
};

// ── The injected generator ─────────────────────────────────────────────────

/**
 * The caller-supplied source of new identifiers.
 *
 * Deliberately minimal: one method, and it returns a plain string that this module
 * then *validates* against the destination's contents. An `idFactory` from
 * `database.ts` satisfies it, and so does a counter in a test, and so does a
 * generator that returns the same string forever - which is why the bounds and the
 * typed refusal below exist rather than being an assumption about the caller.
 */
export interface SubjectIdGenerator {
  next(): string;
}

/** How many candidates this module will ask for before refusing a kind. */
export const SUBJECT_ID_MINT_ATTEMPTS = 64;

// ── Inputs and outputs ─────────────────────────────────────────────────────

/**
 * Every identifier already in use on the destination device.
 *
 * The caller builds this from the **active generation's whole record set**, not
 * just the subject being replaced: a copy that collided with a *different*
 * subject's room would be indistinguishable from a reference into that subject.
 * `taken` is flattened to one set so a caller cannot accidentally leave a kind out.
 */
export interface ExistingIdentifiers {
  /** Every subject id, room id, attachment id, session id, fish, note and loot id. */
  readonly taken: ReadonlySet<string>;
}

export interface SubjectRemapInput {
  /** The exported subject record. The subject id is remapped unless ids are preserved. */
  readonly subject: SubjectRecordValue;
  /** The exported progression records, already filtered to this subject. */
  readonly progression: readonly ProgressionRecordValue[];
  /** The exported sessions, already filtered to this subject. */
  readonly sessions: readonly SessionRecordValue[];
  /** The exported assistance records. Carried because the plan's layout includes them. */
  readonly assistance: readonly AssistanceRecordValue[];
  /** The exported attachment metadata records, already filtered to this subject. */
  readonly attachmentMetadata: readonly AttachmentMetadataRecordValue[];
  /** The exported attachment blob records, matching `attachmentMetadata`. */
  readonly attachmentBlobs: readonly AttachmentBlobRecordValue[];
  /** Identifiers already in use on the destination device. */
  readonly existing: ExistingIdentifiers;
  /** The injected source of new identifiers. */
  readonly generator: SubjectIdGenerator;
  /**
   * The time stamped on records this function creates.
   *
   * There is exactly one value a copy does not carry verbatim - the blob records'
   * `storedAt` - and it is a value *about the device the copy is being written
   * to*, so it is the caller's clock and not the source's. Injected, so the whole
   * remapping stays a pure function of its arguments.
   */
  readonly now: string;
}

/** One identifier's before and after, by kind. */
export interface SubjectIdMappingEntry {
  readonly kind: SubjectIdKind;
  readonly from: string;
  readonly to: string;
}

/** Every identifier the copy rewrote, ordered by kind then by source id. */
export type SubjectIdMapping = readonly SubjectIdMappingEntry[];

/**
 * Why a string was carried verbatim, as a closed set of codes.
 *
 * A closed set for the same reason {@link SUBJECT_ID_KINDS} is one: the code is
 * what a screen renders and what a gate asserts, so it cannot be a free string that
 * drifts between two callers.
 */
export const SUBJECT_VERBATIM_DISCLOSURE_CODES = [
  /**
   * A `relativePath` naming an id this copy remapped.
   *
   * The path addresses a file in the Electron `userData` filesystem that this copy
   * did not move, so the room id in it is still a **true** statement about where the
   * original file is. Rewriting it would name a directory that was never created.
   */
  'attachment-relative-path-names-a-remapped-id',
  /**
   * A `DungeonMetadata.dungeonId` that did not equal the record's own `subjectId`.
   *
   * The record disagrees with itself, which the validator does not refuse and a
   * hand-made archive can carry. The value names no subject the archive declares,
   * so no mapping is minted for it; it is carried verbatim and disclosed, because a
   * copy whose own dungeon id is stale is wrong about which subject it is and must
   * not say so silently.
   */
  'stale-subject-dungeon-id',
] as const;

export type SubjectVerbatimDisclosureCode = (typeof SUBJECT_VERBATIM_DISCLOSURE_CODES)[number];

/**
 * One count of strings carried verbatim by a declared rule.
 *
 * **Counts only, never identifiers.** The result is serialized onto a log, a
 * disclosure screen, and an import report, and a bystander subject's id or fish id
 * appearing in any of those would be a privacy leak rather than a disclosure.
 */
export interface SubjectVerbatimDisclosure {
  readonly code: SubjectVerbatimDisclosureCode;
  readonly count: number;
}

export interface SubjectRemapResult {
  /** The subject record with every identifier rewritten. */
  readonly subject: SubjectRecordValue;
  readonly progression: ProgressionRecordValue[];
  readonly sessions: SessionRecordValue[];
  readonly assistance: AssistanceRecordValue[];
  readonly attachmentMetadata: AttachmentMetadataRecordValue[];
  readonly attachmentBlobs: AttachmentBlobRecordValue[];
  /** Every rewrite, in a stable order, for reporting and for the gate's assertions. */
  readonly mapping: SubjectIdMapping;
  /**
   * Strings that mention a mapped identifier without *being* one, carried verbatim.
   *
   * Non-zero is not a failure. It is the disclosed residual described in the module
   * header, and the caller reports it rather than pretending the rewrite was total.
   * It counts string **values** only - see the header for what it deliberately does
   * not count, and {@link SubjectRemapResult.verbatimDisclosures} for the values
   * carried verbatim by a declared rule.
   */
  readonly unresolvedReferenceCount: number;
  /**
   * Values carried verbatim because a declared rule says to, by code and count.
   *
   * A separate disclosure from `unresolvedReferenceCount` rather than a fifth entry
   * in it, because they mean different things and merging them would make one
   * number describe two unrelated situations. This one is *actionable* - a screen
   * can say "N attachment paths still point at the machine that wrote them" - while
   * the other is a note's prose. Empty when nothing needed disclosing.
   */
  readonly verbatimDisclosures: readonly SubjectVerbatimDisclosure[];
  /** How many candidates the generator had to be asked for, across all kinds. */
  readonly mintAttempts: number;
}

// ── Plain-data guards ──────────────────────────────────────────────────────

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordObject);
}

// ── The protected text fields ──────────────────────────────────────────────

/**
 * Field names whose values are the learner's own words, never a reference.
 *
 * This is the load-bearing list behind "a room id that equals a tag name must
 * survive". Each name is taken from the domain contract in
 * `src/core/validation/persistence/types.ts`, `src/core/fishing/fishingTypes.ts`,
 * and `src/core/progression/canonicalProgression.ts` - not from this product's
 * convenience:
 *
 * - `topic`, `noteText`, `artifactMarkdown`, `artifactPreview`, `noteMarkdown` - a
 *   room's authored text.
 * - `subjectName` - the learner's name for the subject. It appears on the subject,
 *   on every fish entry, and on a legacy session; none of them is a reference.
 * - `tags`, `tagIndex` - the cross-subject tag index is *keyed by tag name* and its
 *   values are room ids, which is exactly why a naive key rewrite would rename a
 *   tag that happens to equal a room id.
 * - `badges` - cross-subject achievement tokens.
 * - `crossSubjectAchievements` - the same.
 * - `name`, `label`, `labelKey`, `description`, `floorLabel` - display text.
 * - `fileName`, `externalUrl`, `altText`, `mimeType` - the attachment description.
 * - `relativePath` - **not** because a room id in it is a coincidence, which is what
 *   this list used to say and was wrong about. It is a path into the **Electron
 *   `userData` filesystem**, not into this generation: `electron/main.ts` builds
 *   `rooms/<roomId>/attachments/<file>`, and that directory is a real directory on
 *   the machine that wrote the file, created before any `.kdsubject` existed. A copy
 *   is written on a different machine, where that directory does not exist, so
 *   rewriting the room id would replace a true statement about a real file with a
 *   false one naming a directory that was never created. Attachment **bytes** are
 *   carried by `AttachmentBlobRecordValue` and addressed by `attachmentId`, which
 *   *is* remapped; the path is a locator for a file this product did not move. It
 *   is left verbatim and, when it names a remapped id, disclosed as
 *   `attachment-relative-path-names-a-remapped-id`.
 * - `key`, `preferenceId` - not present in a subject archive, listed so a future
 *   member of one of these stores cannot silently gain a rewrite.

 *
 * A protected field is carried verbatim wherever it appears - declared, unknown, or
 * nested - because the rule is about what the *field* means, not where it sits.
 */
export const PROTECTED_TEXT_FIELDS: ReadonlySet<string> = new Set([
  'topic',
  'topics',
  'noteText',
  'noteMarkdown',
  'artifactMarkdown',
  'artifactPreview',
  'subjectName',
  'tags',
  'tagIndex',
  'badges',
  'crossSubjectAchievements',
  'name',
  'label',
  'labelKey',
  'description',
  'floorLabel',
  'fileName',
  'externalUrl',
  'altText',
  'mimeType',
  'relativePath',
  'key',
  'preferenceId',
]);

/**
 * Fields whose value comes from a closed vocabulary **this application owns**.
 *
 * A second and distinct reason for protection, stated separately because the rule is
 * different: a fixed-vocabulary value is never a reference, so rewriting one could
 * only ever be a corruption. `DungeonMetadata.biome` is the case the Phase 6 fixture
 * caught - a biome name that happens to equal a room id, which a value sweep turns
 * into an id and leaves the subject with a biome that does not exist. The same
 * reasoning covers every `PHASE_STATES`, `ROOM_STATES`, `EDGE_RELATION_TYPES`,
 * `EDGE_PHASES`, `AssistanceMode`, `AttachmentAvailability`, `RankTier`,
 * `EquipSlot`, and `FishRarity` member, plus the three version fields, whose values
 * are version strings rather than anything a learner chose.
 *
 * A room id equal to `'CreatorComplete'` is absurd, and it is protected anyway: the
 * protection costs nothing, and the absence of it would be a silent corruption with
 * no symptom to notice.
 */
export const FIXED_VOCABULARY_FIELDS: ReadonlySet<string> = new Set([
  'biome',
  'state',
  'phaseState',
  'status',
  'relationType',
  'createdByPhase',
  'rank',
  'equipSlot',
  'equipped',
  'rarity',
  'sourceType',
  'availability',
  'mode',
  'schemaVersion',
  'formatVersion',
  'storageGenerationFormatVersion',
  'failedChecks',
  'criterionScores',
]);

/**
 * Every field whose value the undeclared-location sweep carries verbatim.
 *
 * The union of {@link PROTECTED_TEXT_FIELDS} and
 * {@link FIXED_VOCABULARY_FIELDS}, so the rewrite path consults one set and the two
 * reasons stay separately documented and separately testable.
 */
export const PROTECTED_FIELDS: ReadonlySet<string> = new Set([
  ...PROTECTED_TEXT_FIELDS,
  ...FIXED_VOCABULARY_FIELDS,
]);

/**
 * Field names that are **not** protected even though they look like text.
 *
 * `notePath` and `artifactPath` are the interesting pair: they *are* paths, and they
 * *do* embed a room id (`rooms/<roomId>/notes.txt`). They are declared
 * whole-segment rewrites in pass 1 and are deliberately absent from
 * {@link PROTECTED_TEXT_FIELDS}, because leaving them alone is the specific defect
 * the brief names: a room whose note path points at a room that no longer exists.
 * They are listed here so a reader can see the pairing, and so the set above can
 * never grow them back by accident.
 */
export const PATH_FIELDS_REWRITTEN_BY_SEGMENT: ReadonlySet<string> = new Set([
  'notePath',
  'artifactPath',
]);

// ── The rewriter ───────────────────────────────────────────────────────────

/**
 * The single mutable state a rewrite pass needs: the token table and the residual
 * counter. A class rather than a closure so the recursion is typed and the state
 * is obviously per-call.
 */
class IdRewriter {
  /** A mapped id to its replacement. A `Map`, not an object: ids are data. */
  private readonly table = new Map<string, string>();

  /** Ids that must never be produced or consumed, whatever a rewrite would say. */
  private readonly sourceIds = new Set<string>();

  /**
   * The values this module minted.
   *
   * Needed because the undeclared sweep runs over records whose declared locations
   * have *already* been rewritten, so it sees the new values too. Without this set a
   * minted value that happened to contain a source id - which a generator is free to
   * produce, and which the collision check does not forbid because it is not an
   * *equality* collision - would be reported as an unresolved reference, inflating
   * the one number in this module a screen shows to a learner. The check is for
   * equality against the table, so it costs one set lookup.
   */
  private readonly minted = new Set<string>();

  private residual = 0;

  /**
   * One count per declared verbatim rule, keyed by its closed code.
   *
   * Deliberately separate from `residual`: a value left alone *by rule* is a
   * different statement from a value that *failed to match*, and a caller that has
   * to guess which one a number means cannot report it. See
   * {@link SUBJECT_VERBATIM_DISCLOSURE_CODES}.
   */
  private readonly verbatim = new Map<SubjectVerbatimDisclosureCode, number>();

  map(id: string): string | undefined {
    return this.table.get(id);
  }

  /**
   * Record that `count` strings were carried verbatim under `code`.
   *
   * Takes the code from the closed set rather than a free string so a typo is a
   * compile error rather than a disclosure code no screen has copy for.
   */
  noteVerbatim(code: SubjectVerbatimDisclosureCode, count = 1): void {
    this.verbatim.set(code, (this.verbatim.get(code) ?? 0) + count);
  }

  /**
   * True when this string names a mapped identifier as a whole token or a whole path
   * segment - that is, when rewriting it *would* have happened had the field not been
   * carried verbatim.
   *
   * Used only to decide whether a disclosure is worth making. It has no side effects,
   * which matters: it is called on values the rewrite pass has already walked, so
   * anything that counted residuals would double the number a screen shows.
   */
  namesMappedIdentifier(value: string): boolean {
    if (this.table.size === 0) return false;
    if (this.table.has(value) || this.minted.has(value)) return true;
    if (!value.includes('/')) return false;
    return value.split('/').some((segment) => this.table.has(segment));
  }

  /** The declared verbatim disclosures, ordered by code so a report is stable. */
  get verbatimDisclosures(): readonly SubjectVerbatimDisclosure[] {
    return [...this.verbatim.entries()]
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([code, count]) => ({ code, count }));
  }

  learnSourceId(id: string | null | undefined): void {
    if (typeof id === 'string' && id.length > 0) this.sourceIds.add(id);
  }

  declare(from: string, to: string): void {
    this.table.set(from, to);
    this.minted.add(to);
  }

  noteResidual(count: number): void {
    this.residual += count;
  }

  get unresolvedReferenceCount(): number {
    return this.residual;
  }

  /**
   * Rewrite one string, if it names a mapped identifier as a whole token.
   *
   * A `/`-separated path is rewritten **segment-wise**: a segment that is exactly a
   * mapped identifier becomes its replacement, and every other segment - including
   * one that merely *contains* an identifier - is left alone. That is what makes
   * `room-1` and `room-1a` independent.
   *
   * A plain string is rewritten only on an exact match, and a string that contains
   * an identifier as a substring but not as a whole token is **not** rewritten: the
   * learner's own prose is not a reference, and rewriting it would corrupt content
   * to fix nothing. It is counted instead, and the caller discloses the count.
   */
  rewriteString(value: string): string {
    if (this.table.size === 0) return value;
    // Already rewritten by a declared location, or it is a value this module minted.
    // Either way it is not a source identifier, so it is neither a candidate for
    // replacement nor a residual.
    if (this.minted.has(value)) return value;
    const exact = this.table.get(value);
    if (exact !== undefined) return exact;

    if (!value.includes('/')) {
      // Not a path and not an exact match. A substring mention is a residual.
      for (const id of this.sourceIds) {
        if (id.length > 0 && value.includes(id)) {
          this.residual += 1;
          break;
        }
      }
      return value;
    }

    const segments = value.split('/');
    let changed = false;
    for (let index = 0; index < segments.length; index += 1) {
      const replacement = this.table.get(segments[index] as string);
      if (replacement === undefined) continue;
      segments[index] = replacement;
      changed = true;
    }
    if (changed) return segments.join('/');
    // A path that merely mentions an identifier in a segment is a residual too.
    for (const id of this.sourceIds) {
      if (id.length > 0 && value.includes(id)) {
        this.residual += 1;
        break;
      }
    }
    return value;
  }

  /**
   * Walk an arbitrary JSON-shaped value, rewriting strings by whole token.
   *
   * `protectedKeys` names the fields whose values are carried verbatim; a protected
   * field is honoured at **every** depth, because the rule is about what the field
   * means. Object **keys** are never rewritten.
   *
   * A protected `relativePath` is the one case that is *disclosed* when it names a
   * mapped id, because the field's whole reason for being protected is that it
   * points at a file this copy did not move - see the module header. The check
   * counts nothing in `unresolvedReferenceCount`: that number means "a mention the
   * sweep could not rewrite", and a rule-respecting verbatim value is a different
   * statement.
   */
  rewriteValue(value: unknown, protectedKeys: ReadonlySet<string>): unknown {
    if (typeof value === 'string') return this.rewriteString(value);
    if (Array.isArray(value)) return value.map((entry) => this.rewriteValue(entry, protectedKeys));
    if (!isRecordObject(value)) return value;
    // A **null prototype is preserved**, and that is a real property rather than a
    // detail. A `rooms` map that is a plain object answers `rooms['__proto__']` with
    // `Object.prototype` instead of `undefined`, so a reader looking for a room that
    // is not there is handed an object it can mistake for one. The source map is
    // built null-prototype for the same reason, and the sweep must not quietly undo
    // that.
    const out: Record<string, unknown> =
      Object.getPrototypeOf(value) === null ? (Object.create(null) as Record<string, unknown>) : {};
    for (const [key, entry] of Object.entries(value)) {
      if (!protectedKeys.has(key)) {
        out[key] = this.rewriteValue(entry, protectedKeys);
        continue;
      }
      if (
        key === 'relativePath' &&
        typeof entry === 'string' &&
        this.namesMappedIdentifier(entry)
      ) {
        this.noteVerbatim('attachment-relative-path-names-a-remapped-id');
      }
      out[key] = entry;
    }
    return out;
  }
}

// ── Minting ────────────────────────────────────────────────────────────────

/**
 * Mint one identifier that is free on the destination device.
 *
 * `reserved` is everything that must not be produced: the destination's own
 * identifiers, and the source's. The generator's output is data, so every candidate
 * is re-checked rather than trusted; a generator that returns a blank string, a
 * prototype name, or the same taken value forever is refused with a typed error
 * rather than producing a record that cannot be stored.
 *
 * The check is on the **minted** value, after the kind prefix is applied, and it is
 * {@link isSanitizedDetailText} - the application's own rule for a value that is safe
 * to put in an error detail. A generated identifier becomes a database key *and* may
 * legitimately appear in a `StorageV2Error`, so a candidate containing a space would
 * be both an unkeyable record and a `TypeError` waiting to happen. The rule is
 * borrowed rather than re-derived so the two cannot drift.
 */
function mintId(
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
    reserved.add(candidate);
    // The kind prefix is applied to the *candidate sequence*, not to the whole
    // candidate, so a generator that already namespaced its output is not
    // double-prefixed into something unreadable.
    const minted = candidate.startsWith(SUBJECT_ID_KIND_PREFIX[kind])
      ? candidate
      : `${SUBJECT_ID_KIND_PREFIX[kind]}-${candidate}`;
    // The prefixed form is what actually becomes a record key, so it is the value
    // that has to be collision-checked - and a candidate that only collides after
    // prefixing is not reserved twice for nothing.
    if (!isSanitizedDetailText(minted) || reserved.has(minted)) continue;
    reserved.add(minted);
    return minted;
  }
  throw new StorageV2Error('RECORD_INVALID', { field: 'idGenerator', reason: 'no-free-identifier' });
}

// ── Reading the source identifiers out ─────────────────────────────────────

interface SourceIdentifiers {
  readonly subjectId: string;
  readonly roomIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly assistanceIds: readonly string[];
  readonly fishIds: readonly string[];
  readonly noteIds: readonly string[];
  readonly lootIds: readonly string[];
}

/**
 * Every identifier the exported records use, collected in a fixed order.
 *
 * A room id is read from the `rooms` **keys** - the record's own identity - and the
 * `RoomMetadata.roomId` values are read separately so a subject that disagrees with
 * itself contributes both ids to the table. That is deliberate: a disagreement is
 * disclosed by the reader, and remapping only one half of it would *create* a
 * disagreement the source did not have.
 *
 * The nested progression identifiers - fish, note, and loot ids - are read from the
 * `bySubject` entry keyed by the record's own `subjectId` and from **no other
 * entry**. A foreign entry belongs to another subject and is carried verbatim, so
 * minting a mapping for one of its ids would put a rewrite on the report that never
 * happened, and would burn a mint from a bounded attempt pool on somebody else's
 * data.
 */
function readSourceIdentifiers(input: SubjectRemapInput): SourceIdentifiers {
  const snapshot = input.subject.snapshot as unknown as Record<string, unknown>;
  const rooms = isRecordObject(snapshot.rooms) ? snapshot.rooms : {};
  const dungeon = isRecordObject(snapshot.dungeon) ? snapshot.dungeon : {};

  // Every room id read out of the record must be **non-empty**. An empty `rootRoomId`
  // is a real thing - a subject created but not yet given a root room - and minting
  // a replacement for the empty string would put a mapping on the result that names
  // no room, and on the report a screen shows.
  const roomIds: string[] = Object.keys(rooms).filter((key) => key.length > 0);
  for (const room of Object.values(rooms)) {
    if (!isRecordObject(room)) continue;
    const declared = readString(room, 'roomId');
    if (declared !== null && !roomIds.includes(declared)) roomIds.push(declared);
  }
  for (const summary of readRecordArray(dungeon.rooms)) {
    const declared = readString(summary, 'roomId');
    if (declared !== null && !roomIds.includes(declared)) roomIds.push(declared);
  }
  const rootRoomId = readString(dungeon, 'rootRoomId');
  if (rootRoomId !== null && rootRoomId.length > 0 && !roomIds.includes(rootRoomId)) {
    roomIds.push(rootRoomId);
  }
  for (const edge of readRecordArray(dungeon.edges)) {
    for (const key of ['fromRoomId', 'toRoomId'] as const) {
      const declared = readString(edge, key);
      if (declared !== null && !roomIds.includes(declared)) roomIds.push(declared);
    }
  }
  if (isRecordObject(dungeon.tagIndex)) {
    for (const roomIdsForTag of Object.values(dungeon.tagIndex)) {
      if (!Array.isArray(roomIdsForTag)) continue;
      for (const entry of roomIdsForTag) {
        if (typeof entry === 'string' && !roomIds.includes(entry)) roomIds.push(entry);
      }
    }
  }

  const attachmentIds: string[] = [];
  for (const record of input.attachmentMetadata) {
    if (!attachmentIds.includes(record.attachmentId)) attachmentIds.push(record.attachmentId);
  }
  // A room's own `attachments[]` may name an attachment that has no metadata
  // record - the Phase 0 fixture does exactly that. Its id is still an id the copy
  // must not share, so it is minted even though no record will carry it.
  for (const room of Object.values(rooms)) {
    if (!isRecordObject(room)) continue;
    for (const attachment of readRecordArray(room.attachments)) {
      const declared = readString(attachment, 'attachmentId');
      if (declared !== null && !attachmentIds.includes(declared)) attachmentIds.push(declared);
    }
  }

  const fishIds: string[] = [];
  const noteIds: string[] = [];
  const lootIds: string[] = [];
  for (const record of input.progression) {
    const bySubject = isRecordObject(record.bySubject) ? record.bySubject : {};
    // This subject's own entry only. See the note on `readSourceIdentifiers`.
    const perSubject = bySubject[record.subjectId];
    if (!isRecordObject(perSubject)) continue;
    {
      for (const fish of readRecordArray(perSubject.fishCollection)) {
        const declared = readString(fish, 'id');
        if (declared !== null && !fishIds.includes(declared)) fishIds.push(declared);
      }
      for (const note of readRecordArray(perSubject.collectedNotes)) {
        const declared = readString(note, 'noteId');
        if (declared !== null && !noteIds.includes(declared)) noteIds.push(declared);
      }
      for (const key of ['inventory', 'equippedItems'] as const) {
        for (const item of readRecordArray(perSubject[key])) {
          const declared = readString(item, 'id');
          if (declared !== null && !lootIds.includes(declared)) lootIds.push(declared);
        }
      }
    }
  }

  return {
    subjectId: input.subject.subjectId,
    roomIds,
    attachmentIds,
    sessionIds: input.sessions.map((session) => session.sessionId),
    assistanceIds: input.assistance.map((record) => record.assistanceId),
    fishIds,
    noteIds,
    lootIds,
  };
}

// ── The declared-location rewrites ─────────────────────────────────────────

/**
 * The subject record's own rewrite.
 *
 * `rooms` keys are rebuilt first, because every other room reference in the record
 * is resolved against them. The rebuilt `rooms` object is a **null-prototype**
 * object: a room id is data, and a room id that happened to be `__proto__` would
 * otherwise change the object's prototype and lose the room - exactly the
 * member-name hazard the ZIP codec has to guard against for member names.
 */
function rewriteSubject(
  subject: SubjectRecordValue,
  rewriter: IdRewriter,
  subjectId: string,
): SubjectRecordValue {
  const snapshot = subject.snapshot as unknown as Record<string, unknown>;
  const dungeon = isRecordObject(snapshot.dungeon) ? snapshot.dungeon : {};
  const sourceRooms = isRecordObject(snapshot.rooms) ? snapshot.rooms : {};

  // A room's whole subtree, with the declared room-id locations handled first and
  // the undeclared ones swept by token afterwards.
  // A **null-prototype** map, because a room id is data: a room whose id is
  // `__proto__` would otherwise change this object's prototype and vanish, with no
  // error anywhere. That is the same hazard the ZIP codec has to guard against for
  // member names, and the same fix.
  const rooms = Object.create(null) as Record<string, unknown>;
  for (const [roomId, room] of Object.entries(sourceRooms)) {
    const target = rewriter.map(roomId) ?? roomId;
    if (!isRecordObject(room)) {
      rooms[target] = room;
      continue;
    }
    const next: Record<string, unknown> = { ...room };
    next.roomId = rewriter.map(readString(room, 'roomId') ?? '') ?? room.roomId;
    for (const key of PATH_FIELDS_REWRITTEN_BY_SEGMENT) {
      const value = readString(room, key);
      if (value !== null) next[key] = rewriter.rewriteString(value);
    }
    if (Array.isArray(room.attachments)) {
      next.attachments = room.attachments.map((attachment) =>
        isRecordObject(attachment)
          ? {
              ...attachment,
              attachmentId:
                rewriter.map(readString(attachment, 'attachmentId') ?? '') ??
                attachment.attachmentId,
            }
          : attachment,
      );
    }
    // Only the declared room-id locations are handled here. The undeclared
    // pass runs exactly once, over the whole snapshot, further down - running it
    // per room as well would visit every room's strings twice and so **double the
    // disclosed residual count**, which is the one number in this module a screen
    // shows to a learner.
    rooms[target] = next;
  }

  const nextDungeon: Record<string, unknown> = { ...dungeon };
  // `dungeonId` is this application's subject id - `subjectPersistence.ts` mints it
  // with `generateId('subject')` and `subjectActivation.ts` reads it as the active
  // subject - so it is a **declared** subject-id location rather than a value the
  // sweep happened to catch. Only the record's own id is mapped: a value that
  // disagrees names no subject the archive declares, and minting a mapping for it
  // would invent an identity. A disagreement is disclosed instead.
  const dungeonId = readString(dungeon, 'dungeonId');
  if (dungeonId !== null) {
    if (dungeonId === subject.subjectId) {
      nextDungeon.dungeonId = rewriter.map(dungeonId) ?? dungeonId;
    } else {
      rewriter.noteVerbatim('stale-subject-dungeon-id');
    }
  }
  const rootRoomId = readString(dungeon, 'rootRoomId');
  if (rootRoomId !== null) nextDungeon.rootRoomId = rewriter.map(rootRoomId) ?? rootRoomId;
  if (Array.isArray(dungeon.rooms)) {
    nextDungeon.rooms = dungeon.rooms.map((summary) =>
      isRecordObject(summary)
        ? { ...summary, roomId: rewriter.map(readString(summary, 'roomId') ?? '') ?? summary.roomId }
        : summary,
    );
  }
  if (Array.isArray(dungeon.edges)) {
    nextDungeon.edges = dungeon.edges.map((edge) => {
      if (!isRecordObject(edge)) return edge;
      const from = readString(edge, 'fromRoomId');
      const to = readString(edge, 'toRoomId');
      return {
        ...edge,
        ...(from === null ? {} : { fromRoomId: rewriter.map(from) ?? from }),
        ...(to === null ? {} : { toRoomId: rewriter.map(to) ?? to }),
      };
    });
  }
  if (isRecordObject(dungeon.tagIndex)) {
    // The tag **keys** are the learner's tag names and are carried verbatim; only
    // the values, which are room ids, are rewritten.
    const tagIndex = Object.create(null) as Record<string, unknown>;
    for (const [tag, roomIdsForTag] of Object.entries(dungeon.tagIndex)) {
      tagIndex[tag] = Array.isArray(roomIdsForTag)
        ? roomIdsForTag.map((entry) => (typeof entry === 'string' ? rewriter.rewriteString(entry) : entry))
        : roomIdsForTag;
    }
    nextDungeon.tagIndex = tagIndex;
  }
  const nextSnapshot = rewriter.rewriteValue({ ...snapshot, dungeon: nextDungeon, rooms }, PROTECTED_FIELDS);

  return {
    ...subject,
    subjectId,
    snapshot: nextSnapshot as unknown as SubjectRecordValue['snapshot'],
  };
}

/** One progression record's rewrite, including the fish, notes, and loot ids. */
function rewriteProgression(
  record: ProgressionRecordValue,
  rewriter: IdRewriter,
  subjectId: string,
): ProgressionRecordValue {
  const bySubject = isRecordObject(record.bySubject) ? record.bySubject : {};
  const nextBySubject = Object.create(null) as Record<string, unknown>;
  for (const [key, perSubject] of Object.entries(bySubject)) {
    // A `bySubject` key equal to the record's own `subjectId` is *this* subject's
    // entry: its key is the subject id and everything nested inside it is this
    // subject's own learner state, so all of it is remapped.
    //
    // Every other key belongs to **another subject** sharing this record - the shape
    // the canonical v3 envelope produced - and the whole subtree is carried verbatim.
    // Remapping it would be a fork: `progressionEnvelopeFrom` flattens every record's
    // `bySubject` into one map, last writer wins, ordered by `record.subjectId`, so
    // the winner would be decided by a string sort of two opaque ids and a subject
    // the learner never touched would start reporting fish under a minted id. The
    // foreign subtree is not even swept for undeclared mentions: it is not this
    // copy's data, and rewriting a mention inside it would be a silent edit to
    // somebody else's record.
    if (key !== record.subjectId) {
      nextBySubject[key] = perSubject;
      continue;
    }
    const target = subjectId;
    if (!isRecordObject(perSubject)) {
      nextBySubject[target] = perSubject;
      continue;
    }
    const next: Record<string, unknown> = { ...perSubject };
    if (Array.isArray(perSubject.fishCollection)) {
      next.fishCollection = perSubject.fishCollection.map((fish) =>
        isRecordObject(fish)
          ? {
              ...fish,
              id: rewriter.map(readString(fish, 'id') ?? '') ?? fish.id,
              // `subjectId` on a fish entry *is* a reference - plan section 5.2
              // requires one explicit subject context from pond entry through
              // collection - so it is rewritten. `subjectName` is the learner's
              // display name and is protected.
              subjectId:
                typeof fish.subjectId === 'string' ? rewriter.map(fish.subjectId) ?? fish.subjectId : fish.subjectId,
            }
          : fish,
      );
    }
    if (Array.isArray(perSubject.collectedNotes)) {
      next.collectedNotes = perSubject.collectedNotes.map((note) => {
        if (!isRecordObject(note)) return note;
        const dungeonId = readString(note, 'dungeonId');
        const roomId = readString(note, 'roomId');
        return {
          ...note,
          ...(typeof note.noteId === 'string'
            ? { noteId: rewriter.map(note.noteId) ?? note.noteId }
            : {}),
          ...(dungeonId === null ? {} : { dungeonId: rewriter.map(dungeonId) ?? dungeonId }),
          ...(roomId === null ? {} : { roomId: rewriter.map(roomId) ?? roomId }),
        };
      });
    }
    for (const key2 of ['inventory', 'equippedItems'] as const) {
      if (!Array.isArray(perSubject[key2])) continue;
      next[key2] = perSubject[key2].map((item) =>
        isRecordObject(item)
          ? { ...item, id: rewriter.map(readString(item, 'id') ?? '') ?? item.id }
          : item,
      );
    }
    nextBySubject[target] = rewriter.rewriteValue(next, PROTECTED_FIELDS);
  }

  return {
    ...record,
    subjectId,
    bySubject: nextBySubject,
    // `crossSubjectAchievements` are cross-subject facts, and a copy of one subject
    // cannot own one. They are carried verbatim and the import discloses the count:
    // dropping them would discard the learner's history, and minting them would
    // invent an achievement nobody earned.
  };
}

/** One session's rewrite. `subjectName` is protected; `roomsVisited` is not. */
function rewriteSession(record: SessionRecordValue, rewriter: IdRewriter, subjectId: string): SessionRecordValue {
  return rewriter.rewriteValue(
    {
      ...record,
      subjectId,
      roomsVisited: Array.isArray(record.roomsVisited)
        ? record.roomsVisited.map((roomId) => rewriter.rewriteString(roomId))
        : record.roomsVisited,
    },
    PROTECTED_TEXT_FIELDS,
  ) as unknown as SessionRecordValue;
}

/** One assistance record's rewrite. `signals` are counts, and are carried verbatim. */
function rewriteAssistance(record: AssistanceRecordValue, assistanceId: string): AssistanceRecordValue {
  return { ...record, assistanceId };
}

function rewriteAttachmentMetadata(
  record: AttachmentMetadataRecordValue,
  rewriter: IdRewriter,
  attachmentId: string,
  subjectId: string,
): AttachmentMetadataRecordValue {
  return {
    ...record,
    attachmentId,
    subjectId,
    roomId: rewriter.map(record.roomId) ?? record.roomId,
  };
}

// ── The exported function ──────────────────────────────────────────────────

/**
 * Rewrite every identifier in one exported subject's records.
 *
 * Pure: no repository, no database, no clock, no randomness, no I/O. The result is
 * a function of `input` alone, which is what lets the gates test the remapping
 * rules against records no archive ever carried.
 *
 * The `reserved` set starts as the destination's identifiers and grows with every
 * minted id, so two mints can never produce the same value either. The source's own
 * identifiers are added to the rewriter's *table* (so they are rewritten) and to its
 * *residual check* (so a mention is counted), but they are deliberately **not**
 * reserved: an id the source used and the destination does not hold is free to be
 * reused, and reusing it would be the cheapest possible copy. Requiring
 * non-reuse is strictly stronger than "shares no id with the source", and it is
 * what "no collision with the destination" needs, so both hold.
 */
export function remapSubjectRecords(input: SubjectRemapInput): SubjectRemapResult {
  const rewriter = new IdRewriter();
  const attempts = { count: 0 };
  const reserved = new Set(input.existing.taken);
  const source = readSourceIdentifiers(input);
  const mapping: SubjectIdMappingEntry[] = [];

  const assign = (kind: SubjectIdKind, from: string): string => {
    const existing = rewriter.map(from);
    if (existing !== undefined) return existing;
    const minted = mintId(kind, input.generator, reserved, attempts);
    rewriter.declare(from, minted);
    rewriter.learnSourceId(from);
    mapping.push({ kind, from, to: minted });
    return minted;
  };

  const subjectId = assign('subject', source.subjectId);
  for (const roomId of source.roomIds) assign('room', roomId);
  for (const attachmentId of source.attachmentIds) assign('attachment', attachmentId);
  for (const sessionId of source.sessionIds) assign('session', sessionId);
  for (const assistanceId of source.assistanceIds) assign('assistance', assistanceId);
  for (const fishId of source.fishIds) assign('fish', fishId);
  for (const noteId of source.noteIds) assign('note', noteId);
  for (const lootId of source.lootIds) assign('loot', lootId);

  // The source's own ids are learned *after* the table is complete, so the residual
  // check can tell "this string names an identifier" from "this string is one".
  for (const id of source.roomIds) rewriter.learnSourceId(id);

  const subject = rewriteSubject(input.subject, rewriter, subjectId);
  const progression = input.progression.map((record) => rewriteProgression(record, rewriter, subjectId));
  const sessions = input.sessions.map((record) => {
    const mappedSessionId = rewriter.map(record.sessionId) ?? record.sessionId;
    const recordSubject = rewriter.map(record.subjectId) ?? record.subjectId;
    return rewriteSession({ ...record, sessionId: mappedSessionId }, rewriter, recordSubject);
  });
  const assistance = input.assistance.map((record) => {
    const mapped = rewriter.map(record.assistanceId) ?? record.assistanceId;
    return rewriteAssistance(record, mapped);
  });
  const attachmentMetadata = input.attachmentMetadata.map((record) => {
    const mappedAttachment = rewriter.map(record.attachmentId) ?? record.attachmentId;
    const mappedSubject = rewriter.map(record.subjectId) ?? record.subjectId;
    return rewriteAttachmentMetadata(record, rewriter, mappedAttachment, mappedSubject);
  });
  const attachmentBlobs = input.attachmentBlobs.map((record) => ({
    ...record,
    attachmentId: rewriter.map(record.attachmentId) ?? record.attachmentId,
    // `storedAt` is a fact about the device the copy is written to, not about the
    // source, so it is the injected clock. Every other blob field - including the
    // bytes and the content hash - is carried verbatim.
    storedAt: input.now,
  }));

  return {
    subject,
    progression,
    sessions,
    assistance,
    attachmentMetadata,
    attachmentBlobs,
    mapping: [...mapping].sort(
      (left, right) =>
        left.kind === right.kind
          ? left.from < right.from
            ? -1
            : left.from > right.from
              ? 1
              : 0
          : left.kind < right.kind
            ? -1
            : 1,
    ),
    unresolvedReferenceCount: rewriter.unresolvedReferenceCount,
    verbatimDisclosures: rewriter.verbatimDisclosures,
    mintAttempts: attempts.count,
  };
}

/**
 * Every identifier a set of record values uses, flattened.
 *
 * Exported because the import has to build {@link ExistingIdentifiers} from the
 * destination device, and because the gates need to assert disjointness between two
 * subjects' identifier sets. Flattened rather than per-kind on purpose: a caller
 * that has to remember to check eight kinds is a caller that will check seven.
 */
export function collectExistingIdentifiers(
  records: ReadonlyArray<{ readonly kind: SubjectIdKind; readonly ids: readonly string[] }>,
): ExistingIdentifiers {
  const taken = new Set<string>();
  for (const group of records) {
    for (const id of group.ids) {
      if (typeof id === 'string' && id.length > 0) taken.add(id);
    }
  }
  return { taken };
}

/**
 * Every identifier one subject's records use, as groups.
 *
 * The mirror of {@link collectExistingIdentifiers}: the export and the gates both
 * need "this subject's ids" from a record set, and writing it twice is how the two
 * directions start disagreeing about what an identifier is.
 *
 * Nested progression identifiers are collected from **every** `bySubject` entry,
 * including entries belonging to other subjects that happen to share the record. That
 * is deliberate and the opposite of {@link readSourceIdentifiers}' rule: this
 * function builds the set a copy must **not** collide with, where a foreign subject's
 * fish id is exactly as real a collision as the exported subject's own, and omitting
 * it would let a copy mint an id another subject already holds.
 */
export function subjectIdentifierGroups(subject: SubjectRecordValue, progression: readonly ProgressionRecordValue[]): ReadonlyArray<{
  kind: SubjectIdKind;
  ids: readonly string[];
}> {
  const snapshot = subject.snapshot as unknown as Record<string, unknown>;
  const rooms = isRecordObject(snapshot.rooms) ? snapshot.rooms : {};
  const dungeon = isRecordObject(snapshot.dungeon) ? snapshot.dungeon : {};
  const attachmentIds: string[] = [];
  for (const room of Object.values(rooms)) {
    if (!isRecordObject(room)) continue;
    for (const attachment of readRecordArray(room.attachments)) {
      const declared = readString(attachment, 'attachmentId');
      if (declared !== null && !attachmentIds.includes(declared)) attachmentIds.push(declared);
    }
  }
  const fishIds: string[] = [];
  const noteIds: string[] = [];
  const lootIds: string[] = [];
  for (const record of progression) {
    const bySubject = isRecordObject(record.bySubject) ? record.bySubject : {};
    for (const perSubject of Object.values(bySubject)) {
      if (!isRecordObject(perSubject)) continue;
      for (const fish of readRecordArray(perSubject.fishCollection)) {
        const declared = readString(fish, 'id');
        if (declared !== null && !fishIds.includes(declared)) fishIds.push(declared);
      }
      for (const note of readRecordArray(perSubject.collectedNotes)) {
        const declared = readString(note, 'noteId');
        if (declared !== null && !noteIds.includes(declared)) noteIds.push(declared);
      }
      for (const key of ['inventory', 'equippedItems'] as const) {
        for (const item of readRecordArray(perSubject[key])) {
          const declared = readString(item, 'id');
          if (declared !== null && !lootIds.includes(declared)) lootIds.push(declared);
        }
      }
    }
  }
  const roomIds: string[] = [...Object.keys(rooms)];
  const rootRoomId = readString(dungeon, 'rootRoomId');
  if (rootRoomId !== null && rootRoomId.length > 0 && !roomIds.includes(rootRoomId)) {
    roomIds.push(rootRoomId);
  }
  return [
    { kind: 'subject', ids: [subject.subjectId] },
    { kind: 'room', ids: roomIds },
    { kind: 'attachment', ids: attachmentIds },
    { kind: 'session', ids: [] },
    { kind: 'assistance', ids: [] },
    { kind: 'fish', ids: fishIds },
    { kind: 'note', ids: noteIds },
    { kind: 'loot', ids: lootIds },
  ];
}
