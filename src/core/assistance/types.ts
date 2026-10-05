/**
 * The renderer-neutral contracts of adaptive learner assistance (plan section 8).
 *
 * ## What this module is
 *
 * Types and closed vocabularies only. Every rule, every score, and every
 * explanation lives in `./assistanceEngine`, which is a pure function of the input
 * this file describes. Nothing here imports a store, a service, a renderer, the
 * DOM, or the network, and `tests/phase19/assistanceDomainBoundary.test.ts` walks
 * the runtime import graph of this directory and fails on any edge outside
 * `src/core/`.
 *
 * ## Why the engine takes a *reduced* view of a subject
 *
 * {@link AssistanceSubjectInput} is not a `SubjectSnapshot`. A snapshot carries
 * `noteText` and `artifactMarkdown` - the learner's own prose - and an engine that
 * accepted one could put a sentence into a suggestion, an explanation, or a log
 * line. That is precisely what plan section 8 forbids ("no raw learner behaviour
 * leaves the device", and working rule 6's ban on learner data in reports), and a
 * prohibition enforced by remembering not to quote a field is a prohibition one
 * refactor removes.
 *
 * So the engine's input carries **counts, enum codes, app-minted ids, and boolean
 * facts only**. There is no field a sentence could be put in. `toAssistanceSubjectInput`
 * is the one adapter that knows the snapshot shape, it is the only place that reads a
 * snapshot at all, and it copies the six numeric/enum fields it needs out of a
 * snapshot that has no sentence-shaped field to copy.
 *
 * ## Why the assistance mode is redeclared here rather than imported
 *
 * `@/services/persistence/v2/schema` owns the *persisted* `AssistanceMode`. This
 * module owns the *engine's* mode vocabulary, and a `src/core/` module must not
 * reach into `src/services/` even for a type, because that edge is what eventually
 * turns into a runtime import the next time someone needs a value.
 *
 * The two declarations are held together by a bidirectional assignability assertion
 * in `src/store/assistanceStore.ts`, which *may* import the persistence schema. So a
 * rename in either place is a **typecheck failure**, not a runtime surprise and not a
 * silent divergence. There are exactly three modes, named exactly as plan section 8
 * names them; a fourth is a plan change, not an implementation detail.
 */

/**
 * The three assistance modes, in the plan's own words (plan section 8).
 *
 * - `off` - no proactive suggestions.
 * - `gentle` - short steps, stronger cues, examples, and more generous timing.
 * - `standard` - contextual hints after hesitation, repeated attempts, or low recall.
 *
 * Held in **ascending order of intrusiveness**, which is the order the
 * {@link ASSISTANCE_MODES} array uses and the order every threshold table in
 * `./assistanceEngine` indexes by. The array is the single enumeration: nothing
 * elsewhere may add a mode, and {@link isAssistanceMode} is total over it.
 */
export type AssistanceMode = 'off' | 'gentle' | 'standard';

/** Every mode, ascending in intrusiveness. The one enumeration in the domain. */
export const ASSISTANCE_MODES: readonly AssistanceMode[] = Object.freeze([
  'off',
  'gentle',
  'standard',
] as const);

/** Narrow an untrusted value to a mode, or `null`. Total, and never throws. */
export function isAssistanceMode(value: unknown): value is AssistanceMode {
  return typeof value === 'string' && (ASSISTANCE_MODES as readonly string[]).includes(value);
}

/**
 * The modes that may produce a proactive suggestion.
 *
 * `Exclude<AssistanceMode, 'off'>` is the whole off-mode enforcement story at the
 * type level: every rule constructor in `./assistanceEngine` takes this type, so a
 * function that can build a suggestion **cannot be handed `off`**. `off` is not a
 * runtime filter somewhere downstream - it is a mode that does not typecheck as an
 * input to suggestion production at all.
 *
 * {@link proactiveModeFor} is the only narrowing a caller needs, and it returns
 * `null` for `off` so the caller has an explicit branch rather than a coerced value.
 */
export type ProactiveAssistanceMode = Exclude<AssistanceMode, 'off'>;

/** Narrow a mode to one that may produce proactive suggestions, or `null` for `off`. */
export function proactiveModeFor(mode: AssistanceMode): ProactiveAssistanceMode | null {
  return mode === 'off' ? null : mode;
}

// ── Signals ──────────────────────────────────────────────────────────────────

/**
 * The persisted signal vocabulary: a **closed set of device-wide counters**.
 *
 * ## Why the keys carry no identifier
 *
 * `AssistanceRecordValue.signals` is a flat `Record<string, number>`, and
 * `src/services/persistence/products/idRemapping.ts` rewrites an assistance record's
 * `assistanceId` while carrying `signals` **verbatim** - its own comment says "signals
 * are counts, and are carried verbatim". Those two facts together decide the shape:
 *
 * - A key naming a room (`draft.repeat:room-7f3a`) would survive a subject-copy import
 *   while naming a room that does not exist in the copy, because the copy's rooms are
 *   re-minted. The imported record would then assert something about the wrong graph.
 * - A key naming nothing would be carried verbatim and still mean the same thing on the
 *   destination device, because it is a fact about *this learner's history*, not about
 *   a graph.
 *
 * So every key here is device-wide and every value is a plain count. No subject id, no
 * room id, no timestamp, no free text. The subject-specific part of a suggestion is
 * derived at read time from the live graph, which is also the only way it can stay true
 * as the graph changes.
 *
 * ## Where each counter's truth lives
 *
 * | Key | Counted fact | Re-derivable from live state? |
 * | --- | --- | --- |
 * | `noteValidationFailure` | A note evaluation whose deterministic validator failed a blocking criterion | Yes - `RoomMetadata.validationState.failedChecks` |
 * | `lowRecallRating` | An SM-2 recall rating below the pass threshold | Yes - `RoomMetadata.sm2QualityResponse` |
 * | `repeatedDraft` | A note re-saved while still failing validation | **No** - there is no per-room draft history in any record |
 * | `fishingRecallMiss` | A fishing recall question the learner did not answer | **No** - the statistics ledger records *kept* catches only |
 *
 * The first two are re-derivable, so the engine prefers the live derivation and the
 * persisted counter only widens the signal over time. The last two are genuinely
 * historical and exist nowhere else, which is why the record carries them at all.
 */
export const ASSISTANCE_SIGNAL_KEYS = [
  'noteValidationFailure',
  'lowRecallRating',
  'repeatedDraft',
  'fishingRecallMiss',
] as const;

/** One persisted signal key. */
export type AssistanceSignalKey = (typeof ASSISTANCE_SIGNAL_KEYS)[number];

/** Narrow an untrusted key to the persisted vocabulary, or `null`. */
export function isAssistanceSignalKey(value: unknown): value is AssistanceSignalKey {
  return typeof value === 'string' && (ASSISTANCE_SIGNAL_KEYS as readonly string[]).includes(value);
}

/**
 * A whole persisted signal map, with unknown keys preserved.
 *
 * `index signature` rather than the four known keys, for the same reason
 * `GenerationRecordValues` keeps unknown app-owned fields: a record written by a newer
 * build, or hand-edited, must round-trip through this device without losing the keys
 * this build does not understand. {@link collectAssistanceSignals} reads only the four
 * known keys; {@link mergeAssistanceSignals} writes back only the keys it was given, so
 * an unknown key is carried, never dropped and never overwritten with a guess.
 */
export type AssistanceSignals = Readonly<Record<string, number>>;

/** The four known keys resolved to integers, with every other key ignored. */
export type ResolvedAssistanceSignals = Readonly<Record<AssistanceSignalKey, number>>;

/** Every known signal at zero. The signal half of the pre-hydration state. */
export function emptyAssistanceSignals(): ResolvedAssistanceSignals {
  return {
    noteValidationFailure: 0,
    lowRecallRating: 0,
    repeatedDraft: 0,
    fishingRecallMiss: 0,
  };
}

/**
 * Read the four known signals out of a persisted map, coercing each to a
 * non-negative integer.
 *
 * Total by construction: the map is untrusted input (a restored `.kdbak`, a
 * `.kdsubject`, a hand-edited `localStorage` value), and `validateAssistanceRecord`
 * accepts a `NaN` here because `typeof NaN === 'number'`. A `NaN` that reached a score
 * would poison every comparison it took part in - and the Phase 18 lesson is that the
 * worst time to discover a poisoned total is when a learner is being shown a hint that
 * silently stopped ranking. So the coercion is total and a non-finite value becomes `0`,
 * which is the honest answer for "this device recorded no such event".
 *
 * Never returns `NaN`, `Infinity`, or a negative count for any key.
 */
export function resolveAssistanceSignals(signals: AssistanceSignals | null | undefined): ResolvedAssistanceSignals {
  const source = signals ?? {};
  const read = (key: AssistanceSignalKey): number => {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
  };
  return {
    noteValidationFailure: read('noteValidationFailure'),
    lowRecallRating: read('lowRecallRating'),
    repeatedDraft: read('repeatedDraft'),
    fishingRecallMiss: read('fishingRecallMiss'),
  };
}

/**
 * Merge a known-key patch over a persisted map **without dropping unknown keys**.
 *
 * The write half of {@link resolveAssistanceSignals}'s contract. `patch` carries only
 * the keys a caller is changing; every key of `base` the patch does not name is carried
 * through untouched, so a device whose record holds a key a future build wrote keeps it
 * across a save on this build.
 *
 * Result keys are emitted in {@link ASSISTANCE_SIGNAL_KEYS} order first and then in
 * ascending code-unit order of the unknown keys, so the produced object is byte-stable
 * for a given input - which is what lets a test compare a record with `toEqual` without
 * depending on the order a previous `JSON.parse` happened to produce.
 */
export function mergeAssistanceSignals(
  base: AssistanceSignals | null | undefined,
  patch: Partial<Record<AssistanceSignalKey, number>> | null | undefined,
): Record<string, number> {
  const merged: Record<string, number> = {};
  const source = base ?? {};
  for (const key of ASSISTANCE_SIGNAL_KEYS) {
    const incoming = patch?.[key];
    const current = source[key];
    const next = incoming === undefined ? current : incoming;
    if (next !== undefined) merged[key] = toStoredCount(next);
  }
  // The unknown keys are **sorted**, not carried in `Object.keys(source)` order.
  //
  // This is a real fix, not a tidiness one, and it was found by an attack rather than by
  // reading. `Object.keys` order is insertion order, so the same three unknown keys merged
  // over two records that were themselves written in different orders would produce two
  // `signals` objects holding the same pairs in a different sequence. That record goes into a
  // checksummed storage-v2 generation, into a `.kdbak`, and into a `.kdsubject`, so its key
  // order is a byte-level property of a persisted value - and a byte-level property that
  // varied with the order of unrelated earlier writes would make two devices holding
  // identical assistance state emit different archive bytes.
  const unknownKeys = Object.keys(source)
    .filter((key) => !(ASSISTANCE_SIGNAL_KEYS as readonly string[]).includes(key))
    .sort(compareSignalKeys);
  for (const key of unknownKeys) {
    const value = source[key];
    merged[key] = typeof value === 'number' ? toStoredCount(value) : 0;
  }
  return merged;
}

/**
 * Code-unit comparison, named here so the sort above reads as deliberate.
 *
 * Deliberately **not** `localeCompare`: this ordering decides the byte order of a persisted
 * record, and `localeCompare`'s answer depends on the host's ICU collation data, so two
 * devices could emit the same assistance state with different bytes. No module under
 * `src/core/assistance/` contains `Intl` or `localeCompare`, and
 * `tests/phase19/assistanceDeterminism.test.ts` scans for both.
 */
function compareSignalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** A stored count: finite, non-negative, integral. `NaN` and friends become `0`. */
function toStoredCount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

// ── Engine input ─────────────────────────────────────────────────────────────

/**
 * One room, reduced to facts a suggestion may be derived from.
 *
 * Every field is a count, an enum code, a boolean, or an app-minted id. There is no
 * `noteText` and no `artifactMarkdown`, by construction - see the module header.
 *
 * `failedChecks` holds the deterministic validator's own failure codes
 * (`VAL_REQUIRED_SECTION_MISSING`, `VAL_MANUAL_CONFIRM_REQUIRED`), which are app-owned
 * vocabulary rather than learner text, so a suggestion may name one of them verbatim and
 * still say nothing about what the learner wrote.
 */
export interface AssistanceRoomInput {
  readonly roomId: string;
  /** The room's own topic. A subject title, which the learner chose - never logged. */
  readonly topic: string;
  /** A `RoomState` value, passed as a string so this module depends on no enum. */
  readonly state: string;
  /** Words in the note, from the room's own recorded validation state. Never the text. */
  readonly noteWordCount: number;
  /** Required section names the note is missing. App-owned vocabulary. */
  readonly missingSections: readonly string[];
  /** Deterministic validator failure codes. App-owned vocabulary. */
  readonly failedChecks: readonly string[];
  /** Rubric scores, keyed by the app's `QualityScoreKey` names. */
  readonly criterionScores: Readonly<Record<string, number>>;
  /** Whether deterministic validation passed. The engine never changes it. */
  readonly finalPass: boolean;
  /** How many full review passes this room has recorded. */
  readonly reviewPassCount: number;
  /** The last SM-2 recall rating, or `null` when the room has never been reviewed. */
  readonly sm2QualityResponse: number | null;
  /**
   * The room's SM-2 next-review timestamp, or `null` for "no evidence".
   *
   * Carried **verbatim** from storage, unvalidated, and interpreted in exactly one place -
   * `readUtcEpochMs` in `./assistanceEngine`. An ISO-8601 date-time with an explicit offset is
   * honoured; one with **no** offset is read as **UTC wall clock**, never as the host's local
   * time, which is what keeps the ranked result identical across devices holding byte-
   * identical state. A value that is not ISO-8601 yields no evidence rather than a guess.
   *
   * A caller does not have to normalise this field, and must not.
   */
  readonly sm2NextReviewDate: string | null;
  /** Tags the learner assigned. Used for related-topic derivation only. */
  readonly tags: readonly string[];
}

/** One graph edge, reduced the same way a room is. */
export interface AssistanceEdgeInput {
  readonly fromRoomId: string;
  readonly toRoomId: string;
  /** An `EdgeRelationType` value, passed as a string. */
  readonly relationType: string;
}

/** One subject, as the engine sees it. */
export interface AssistanceSubjectInput {
  readonly subjectId: string;
  readonly subjectName: string;
  readonly rootRoomId: string;
  /** A `PhaseState` value, passed as a string. */
  readonly phaseState: string;
  readonly rooms: readonly AssistanceRoomInput[];
  readonly edges: readonly AssistanceEdgeInput[];
}

/**
 * Device-wide study aggregate, supplied by the caller.
 *
 * Phase 18's `StatisticsSnapshot` has exactly this shape, so the caller can hand it
 * straight through. It is an **optional** input because it is genuinely optional: a
 * caller with no statistics store installed still gets graph- and review-derived
 * suggestions, and the engine asserts nothing it does not have rather than inventing
 * zeros that look like evidence.
 */
export interface AssistanceStudyInput {
  /** Rooms cleared across every subject, from the durable room-clear ledger. */
  readonly roomsCleared: number;
  /** Notes that validated and cleared a room. */
  readonly notesSubmitted: number;
  /** Completed review passes. */
  readonly reviewsCompleted: number;
  /** Distinct local calendar days with recorded activity. */
  readonly activeDays: number;
  /** Kept catches. */
  readonly fishKept: number;
}

/** Which flow a suggestion belongs to. Drives which surface may show it. */
export type AssistanceSurface = 'creator' | 'scribe' | 'archaeologist' | 'fishing' | 'device';

/**
 * The closed set of things assistance may suggest.
 *
 * One member per plan-section-8 deliverable, plus `device` for the one suggestion that
 * is not tied to a room. Closed on purpose: adding a member is a reviewable change to
 * what this application is willing to advise about, which is the property the plan's
 * "no sensitive-trait inference" and "no automatic writing" non-goals rest on.
 */
export const ASSISTANCE_SUGGESTION_KINDS = [
  'creator.missing-branch',
  'creator.cross-link',
  'scribe.missing-section',
  'scribe.related-topic',
  'scribe.rubric-hint',
  'archaeologist.due-room',
  'archaeologist.low-recall',
  'fishing.navigation-after-miss',
  'device.due-today',
] as const;

/** One kind of suggestion. */
export type AssistanceSuggestionKind = (typeof ASSISTANCE_SUGGESTION_KINDS)[number];

/** Narrow an untrusted value to a suggestion kind, or `null`. */
export function isAssistanceSuggestionKind(value: unknown): value is AssistanceSuggestionKind {
  return (
    typeof value === 'string' && (ASSISTANCE_SUGGESTION_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Why a suggestion appeared.
 *
 * A closed code set, never a sentence. A reason code is what makes the explanation a
 * **pure derivation** rather than a stored string: `explainAssistanceSuggestion` turns
 * `(reasonCode, signalValue, evidence)` into text at render time, so two devices with
 * the same state produce the same explanation and no string ever has to be persisted,
 * migrated, or invalidated.
 */
export type AssistanceReasonCode =
  /** The subject's root room has no subtopic edges below it. */
  | 'graph-no-branch'
  /** Two rooms share a tag and no edge relates them. */
  | 'graph-related-tag-unlinked'
  /** The deterministic validator named a missing required section. */
  | 'note-missing-required-section'
  /** The deterministic validator failed a blocking criterion. */
  | 'note-validation-failed'
  /**
   * The room's `linkReferences` rubric score is zero and it has an adjacent room.
   *
   * Stated as the *score*, never as the prose. The engine does not read the note, so a note that
   * **does** reference an adjacent room and scored zero for some other reason produces this
   * same advisory; "an adjacent room the note never references" describes a condition the
   * engine cannot observe, and a reader who believed it would be misled about when this fires.
   * See `scribeRelatedTopicRule`, which names that trade explicitly.
   */
  | 'note-adjacent-room-unreferenced'
  /** A rubric criterion is scored zero on the room's last validation. */
  | 'note-rubric-criterion-low'
  /** The room's SM-2 next-review timestamp is at or before `nowIso`. */
  | 'review-due'
  /** The room's last SM-2 rating is below the pass threshold. */
  | 'review-low-recall'
  /** The learner did not answer a fishing recall question. */
  | 'fishing-recall-missed'
  /** At least one reviewable room in the subject is due. */
  | 'device-reviews-due';

/**
 * How strongly a suggestion should present itself.
 *
 * The plan's mode difference is a presentation difference ("short steps, stronger cues,
 * examples, and more generous timing" for Gentle; "contextual hints after hesitation,
 * repeated attempts, or low recall" for Standard), so the engine's mode output is an
 * intensity rather than a different set of suggestions. A surface reads this and decides
 * how much to say; it never has to re-derive it from the mode.
 */
export type AssistanceIntensity = 'step' | 'cue' | 'example';

/**
 * A proposed action, as **data**.
 *
 * There is no callable anywhere in a suggestion. That is the structural half of the
 * advisory-only guarantee: a suggestion cannot be invoked, so it cannot be a write path,
 * and the engine's module needs no write handle to exist. `tests/phase19/` asserts both
 * halves - this type has no call signature, and `src/core/assistance/**`'s runtime import
 * closure contains no store, no service, no DOM, and no network.
 */
export type AssistanceActionKind =
  /** Offer a scaffold for a required section. The learner decides whether to use it. */
  | 'offer-section-scaffold'
  /** Offer a cross-link to a named room. Never applied automatically. */
  | 'offer-cross-link'
  /** Offer a navigation target. Never navigates by itself. */
  | 'offer-navigation'
  /** Offer to re-order the Archaeologist queue. Never re-orders it. */
  | 'offer-prioritisation'
  /** Show a hint or example. Never inserted into the learner's note. */
  | 'offer-hint';

/** One advisory action proposal. */
export interface AssistanceAction {
  readonly kind: AssistanceActionKind;
  /** The app-minted id the action concerns, or `''` for a device-wide action. */
  readonly subjectId: string;
  /** The room the action concerns, or `null` for a device-wide action. */
  readonly roomId: string | null;
  /**
   * One required section name for `offer-section-scaffold`, one related room id for
   * `offer-cross-link`, and `null` otherwise. A **name from app-owned vocabulary or an
   * app-minted id** - never a fragment of the learner's prose.
   */
  readonly detail: string | null;
}

/**
 * One suggestion.
 *
 * Frozen data, no function members, no store handle, no repository handle. Every field
 * is a number, a closed-vocabulary string, or an app-minted id, so a suggestion can be
 * logged, snapshotted in a test, or compared byte-for-byte without carrying anything the
 * learner wrote.
 *
 * `priority` is an **integer** in `0..100` by construction (see
 * `scoreAssistanceSuggestion` in `./assistanceEngine`). Integer scores are the reason
 * two devices cannot disagree by a rounding error, and the reason a score is meaningful
 * in a checksummed test fixture.
 */
export interface AssistanceSuggestion {
  /**
   * A deterministic identity: `kind` and `targetId` joined by a separator that cannot
   * occur in either. Not a random id and not a counter, so the same state yields the
   * same identity and a test can name a suggestion without holding a reference to it.
   */
  readonly suggestionId: string;
  readonly kind: AssistanceSuggestionKind;
  readonly surface: AssistanceSurface;
  /** The room this concerns, or `''` for a device-wide suggestion. */
  readonly targetId: string;
  /** Integer `0..100`. Higher ranks first; ties break on `(kind, targetId)`. */
  readonly priority: number;
  readonly reasonCode: AssistanceReasonCode;
  /** The signal this suggestion is derived from, or `null` for a purely structural one. */
  readonly signalKey: AssistanceSignalKey | null;
  /** That signal's resolved value, or `0` when the suggestion is purely structural. */
  readonly signalValue: number;
  readonly intensity: AssistanceIntensity;
  readonly action: AssistanceAction;
}

// ── Explanation ──────────────────────────────────────────────────────────────

/**
 * The evidence a surface shows under a suggestion, as **counts and ids only**.
 *
 * `value` is always a count: an overdue room count, a missing-section count, a
 * repeated-draft count. A surface that wants a sentence composes it from `labelKey`
 * and `value`; the engine supplies no prose, so there is no prose to leak and no prose
 * to translate twice.
 */
export interface AssistanceEvidence {
  /** An app-owned evidence vocabulary member. See {@link ASSISTANCE_EVIDENCE_KEYS}. */
  readonly labelKey: AssistanceEvidenceKey;
  readonly value: number;
  /** The room the evidence concerns, or `null` for a device-wide fact. */
  readonly roomId: string | null;
  /** The subject the evidence concerns, or `null` for a device-wide fact. */
  readonly subjectId: string | null;
}

/**
 * The closed evidence vocabulary.
 *
 * Every member names a *count of things*, which is the shape the plan permits: "failed
 * note-validation criteria", "repeated drafts", "graph structure and related topics",
 * "review due dates and recall ratings", "fishing recall results", "aggregate local
 * study behaviour". There is deliberately no member for a trait, a mood, a skill level,
 * a confidence, or a difficulty estimate - those are the inferences plan section 8
 * forbids, and a closed vocabulary is what makes "this application never infers a trait"
 * a checkable statement rather than a promise.
 *
 * ## One key, one unit
 *
 * A key's **name is its contract**, and the noun it names is the unit the value is counted in.
 * `evidence.overdue-rooms` is a count of rooms and may never hold a number of days; a key whose
 * unit is days says `days` (`evidence.overdue-days`), and a key whose subject is a subject says
 * so (`evidence.subject-rooms`) rather than borrowing a key that is scoped to the device or to a
 * clear event. Two arms publishing different units under one key force every label to be worded
 * false under one of them, which is how a card ends up claiming a learner cleared a room they
 * never opened. A row that has no honest key is **omitted**, not re-labelled.
 */
export const ASSISTANCE_EVIDENCE_KEYS = [
  'evidence.failed-checks',
  'evidence.missing-sections',
  'evidence.repeated-drafts',
  'evidence.low-recall-ratings',
  'evidence.review-due-rooms',
  /** Whole **days** past the due date. Never a count of rooms - that is `overdue-rooms`. */
  'evidence.overdue-days',
  /** A count of **rooms**, device- or subject-wide. Never days. */
  'evidence.overdue-rooms',
  'evidence.unlinked-related-rooms',
  'evidence.low-rubric-criteria',
  'evidence.fishing-recall-misses',
  'evidence.active-study-days',
  /**
   * Rooms **cleared**, across the device. Only for an arm that has the durable clear ledger;
   * a structural fact about rooms *existing* uses `subject-rooms` instead, because the learner
   * has cleared nothing by having a room.
   */
  'evidence.rooms-cleared',
  /** A count of **rooms in one subject**. Never a clear count, never days. */
  'evidence.subject-rooms',
] as const;

/** One evidence label. */
export type AssistanceEvidenceKey = (typeof ASSISTANCE_EVIDENCE_KEYS)[number];

/**
 * Why one suggestion appeared, in the shape a surface renders.
 *
 * Derived, never stored. `explainAssistanceSuggestion` is a pure function of
 * `(suggestion, input)`, which is the property that makes "show why each suggestion
 * appears" and "identical state yields identical assistance" the same claim: there is
 * nowhere for a stale explanation to live.
 *
 * `titleKey` and `detailKey` are **i18n keys**, not sentences, so the explanation
 * reaches the DOM as localized text without the engine ever producing a string that
 * would then need translating, and without the engine holding a locale.
 */
export interface AssistanceExplanation {
  readonly suggestionId: string;
  readonly titleKey: string;
  readonly detailKey: string;
  /** Every evidence row the surface should show, in a deterministic order. */
  readonly evidence: readonly AssistanceEvidence[];
  /**
   * The intensity the engine chose, republished so a surface cannot re-derive it and
   * cannot disagree with the ranking that produced it.
   */
  readonly intensity: AssistanceIntensity;
}

// ── Result ───────────────────────────────────────────────────────────────────

/**
 * Why a result is empty.
 *
 * An empty list is not a failure and not a bug: a learner with nothing due and nothing
 * failing gets nothing, and a surface needs to say *why* it is saying nothing. Naming
 * the four reasons is what lets a card render "nothing to suggest" honestly instead of
 * leaving the learner to wonder whether the feature is broken.
 */
export type AssistanceEmptyReason = 'mode-off' | 'no-suggestions' | 'flag-disabled';

/** The engine's complete answer for one input. */
export interface AssistanceResult {
  /** The mode this answer was produced under, echoed so a surface cannot assume. */
  readonly mode: AssistanceMode;
  /** Ranked suggestions. **Always empty when `mode` is `'off'`.** */
  readonly suggestions: readonly AssistanceSuggestion[];
  /** Why `suggestions` is empty. `null` when it is not. */
  readonly emptyReason: AssistanceEmptyReason | null;
  /**
   * Which rule families were **executed**.
   *
   * Present because "off mode removes proactive suggestions" is only a real claim if no
   * rule ran: a filter applied after every rule has already read the learner's state is
   * not removal, it is concealment. In `off` mode this is always empty, and a test
   * asserts it rather than asserting only the visible list.
   */
  readonly evaluatedRuleKinds: readonly AssistanceSuggestionKind[];
}
