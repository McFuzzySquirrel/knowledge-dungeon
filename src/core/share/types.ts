/**
 * The renderer-neutral contract of private share cards (plan section 20).
 *
 * ## What this module is
 *
 * Types, the closed field vocabulary, and the per-kind availability table. Every
 * rule lives in `./shareCardPolicy` and every projection in `./shareCardModel`;
 * nothing here imports a store, a service, a renderer, the DOM, the network, or a
 * clock. `tests/phase20/shareCardPolicy.test.ts` walks the runtime import graph of
 * `src/core/share/` and fails on any edge outside `src/core/`.
 *
 * ## What a card is, and what it is never
 *
 * A share card is a **picture a learner chooses to send to one other human**. It is
 * not a product export, not a support bundle, and not a profile. That distinction is
 * the whole reason this vocabulary is an allowlist rather than a denylist: a card is
 * assembled from named fields, and a field that is not named cannot be drawn. See
 * {@link SHARE_CARD_FIELDS} for the complete list - there are seventeen of them, and
 * every one is a count, a bounded label, or the learner's own subject name.
 *
 * The denylist in `./shareCardPolicy` exists anyway, and it is executable rather than
 * documentary, because the failure mode this plan section is fixing is real and
 * demonstrated: the pre-Phase-20 exporter printed raw badge ids
 * (`CreatorPhaseComplete`) onto an image. An allowlist stops that. The denylist
 * stops the *next* thing - a future field, or a caller that builds a selection by
 * hand - and it is testable.
 *
 * ## Why there is no date on a card
 *
 * `src/ui/utils/progressionShareExport.ts` drew `Generated: ${new Date()
 * .toLocaleString()}`. That string is a function of the host locale **and** the host
 * time zone, so two devices rendering the same archive produced two different
 * images - the exact defect class Phase 19 found in `assistanceEngine`, where
 * `Date.parse` reading an offset-less timestamp as local time changed a ranked
 * result between UTC and Asia/Kolkata.
 *
 * So there is no timestamp field, no generated-at field, and no `now` parameter
 * anywhere in `src/core/share/`. A card is a pure function of learner state. If a
 * future card genuinely needs a date, it takes one as an explicit caller-supplied
 * input, formatted by the content module - never read from a clock here.
 */

/** The four card templates this phase ships. */
export const SHARE_CARD_KINDS = ['subject-summary', 'collection', 'fish', 'statistics'] as const;

/** One card template. */
export type ShareCardKind = (typeof SHARE_CARD_KINDS)[number];

/** Narrow an untrusted value to a card kind, or `null`. Total, and never throws. */
export function isShareCardKind(value: unknown): value is ShareCardKind {
  return typeof value === 'string' && (SHARE_CARD_KINDS as readonly string[]).includes(value);
}

/**
 * The complete allowlist of selectable fields.
 *
 * This array is the contract. A field that is not in it cannot be selected, cannot
 * be defaulted, and cannot be rendered, in any kind, under any code path - because
 * {@link buildShareCardModel} resolves every row through
 * {@link isFieldAllowed}, and the table in {@link SHARE_CARD_FIELDS_BY_KIND} is
 * written only from this array.
 *
 * Grouped by what the value **is**, not by which screen shows it:
 *
 * - **Identity, one row, learner-chosen:** `subjectName`. The learner's own subject
 *   name is theirs to publish, and phase 20 makes publishing it an explicit choice
 *   rather than a default.
 * - **Rank vocabulary:** `rank`. One of `Novice`, `Scholar`, `Master` - app-owned
 *   content with a closed set, never a free string.
 * - **Counts:** `xpTotal`, `roomsCleared`, `roomTotal`, `badgeCount`,
 *   `inventoryCount`, `collectedNoteCount`, `fishTotal`, `fishUniqueTypes`,
 *   `studyStreakDays`, `activeStudyDays`, `sessionsCompleted`.
 * - **Derived counts with an explicit denominator:** `fishRarityCounts` (three
 *   counts), `recallAccuracy` (a ratio of two counts the caller supplies).
 * - **Human labels resolved through the content module:** `badgeLabels`. Never raw
 *   badge ids - see {@link ShareCardBadgeRow} and the unknown-id rule below.
 * - **An aggregate, opt-in:** `assistanceSummary`. A count of sessions, nothing more.
 */
export const SHARE_CARD_FIELDS = [
  'subjectName',
  'rank',
  'xpTotal',
  'roomsCleared',
  'roomTotal',
  'badgeCount',
  'badgeLabels',
  'inventoryCount',
  'collectedNoteCount',
  'fishTotal',
  'fishUniqueTypes',
  'fishRarityCounts',
  'studyStreakDays',
  'activeStudyDays',
  'sessionsCompleted',
  'recallAccuracy',
  'assistanceSummary',
] as const;

/** One selectable field. */
export type ShareCardField = (typeof SHARE_CARD_FIELDS)[number];

/** Narrow an untrusted value to a field, or `null`. Total, and never throws. */
export function isShareCardField(value: unknown): value is ShareCardField {
  return typeof value === 'string' && (SHARE_CARD_FIELDS as readonly string[]).includes(value);
}

/**
 * A field selection: which fields a learner chose for one kind.
 *
 * `readonly` and a `ReadonlySet` on the read side, because a selection is a decision
 * the UI owns and the domain only reads.
 */
export type ShareCardSelection = Readonly<Partial<Record<ShareCardKind, readonly ShareCardField[]>>>;

/**
 * The field availability table: which fields exist for which kind.
 *
 * Deliberately **narrower per kind than the global list**, so the mistake of showing a
 * statistics card's `roomsCleared` row as `roomTotal` when no graph exists is a
 * policy question answered here rather than a rendering branch in the canvas code.
 *
 * `assistanceSummary` appears in exactly two kinds, and in **neither default**:
 * assistance is a private study aid, plan section 8 keeps its history off the device's
 * shared surfaces, and a learner should have to ask for that row.
 */
export const SHARE_CARD_FIELDS_BY_KIND: Readonly<Record<ShareCardKind, readonly ShareCardField[]>> =
  Object.freeze({
    'subject-summary': Object.freeze([
      'subjectName',
      'rank',
      'xpTotal',
      'roomsCleared',
      'roomTotal',
      'badgeCount',
      'badgeLabels',
      'inventoryCount',
      'collectedNoteCount',
      'studyStreakDays',
      'activeStudyDays',
      'assistanceSummary',
    ] as const),
    collection: Object.freeze([
      'subjectName',
      'rank',
      'xpTotal',
      'badgeCount',
      'badgeLabels',
      'inventoryCount',
      'collectedNoteCount',
      'fishTotal',
      'fishUniqueTypes',
      'fishRarityCounts',
    ] as const),
    fish: Object.freeze([
      'subjectName',
      'rank',
      'fishTotal',
      'fishUniqueTypes',
      'fishRarityCounts',
    ] as const),
    statistics: Object.freeze([
      'subjectName',
      'rank',
      'roomsCleared',
      'roomTotal',
      'badgeCount',
      'collectedNoteCount',
      'fishTotal',
      'fishUniqueTypes',
      'studyStreakDays',
      'activeStudyDays',
      'sessionsCompleted',
      'recallAccuracy',
      'assistanceSummary',
    ] as const),
  });

/**
 * Every field a kind may show, in a **stable render order**.
 *
 * Order is the table's own order, not the caller's selection order, so two learners
 * who tick the same four boxes in different orders get byte-identical cards - and a
 * canvas that lays rows out top to bottom has one defined answer.
 */
export const SHARE_CARD_FIELD_ORDER: Readonly<Record<ShareCardKind, readonly ShareCardField[]>> =
  SHARE_CARD_FIELDS_BY_KIND;

/** The default selection per kind: what a card shows before anyone chooses anything. */
export type ShareCardDefaults = Readonly<Record<ShareCardKind, readonly ShareCardField[]>>;

/**
 * A closed-vocabulary label: the rank tier, and nothing else.
 *
 * Its own row type rather than a count, because `Novice` is not `0` and a renderer
 * that read it as a number would draw nonsense. The value is validated against
 * {@link RANK_TIERS} by the model, so a free string from a future rank can never
 * reach a card.
 */
export interface ShareCardTextRow {
  readonly field: ShareCardField;
  readonly label: string;
  readonly value: string;
}

/** A count, or a set of counts under one label. */
export interface ShareCardCountRow {
  readonly field: ShareCardField;
  /** The field's display label, resolved from `SHARE_CARD_FIELD_LABELS`. */
  readonly label: string;
  /** Integer, always `>= 0`. Never `NaN`, never fractional, never negative. */
  readonly value: number;
  /** `true` when the value is structurally `0` rather than merely small. */
  readonly isEmpty: boolean;
}

/**
 * A ratio of two caller-supplied counts.
 *
 * A ratio rather than a percentage string, because a renderer formats and a domain
 * does not. `denominator: 0` is representable and the caller decides what to show -
 * the honest answer there is "no data", not `0%`.
 */
export interface ShareCardRatioRow {
  readonly field: ShareCardField;
  readonly label: string;
  readonly numerator: number;
  readonly denominator: number;
  /**
   * `numerator / denominator` rounded to four places, or `0` when `denominator` is `0`.
   *
   * Rounded rather than raw so the value is byte-stable across engines, and pinned to
   * four places because that is more than enough resolution for a ratio displayed as a
   * percentage and short enough that no float-printing difference can reach the card.
   */
  readonly ratio: number;
}

/**
 * A group of counts under one label.
 *
 * Used by `fishRarityCounts`, whose three rarities are app-owned content with a
 * closed set - never a list of fish names and never a list of catalogue ids.
 */
export interface ShareCardGroupRow {
  readonly field: ShareCardField;
  readonly label: string;
  /** `{ common: n, rare: n, epic: n }`. Keys are app-owned rarity ids. */
  readonly counts: Readonly<Record<string, number>>;
  /** Keys in the order they must be drawn. Never the caller's insertion order. */
  readonly order: readonly string[];
}

/**
 * One badge, named by its **canonical label**.
 *
 * The pre-Phase-20 defect is visible in this type: there is no `badgeId` field to
 * populate by accident. `label` comes from
 * `canonicalBadgeLabel(id)`, and an id the content module does not recognise produces
 * no row at all - the model omits it rather than falling back to the id.
 */
export interface ShareCardBadgeRow {
  readonly label: string;
  /** The count the learner earned, as an integer. */
  readonly count: number;
}

/** The badges row: canonical labels only, in a stable order. */
export interface ShareCardBadgeListRow {
  readonly field: 'badgeLabels';
  readonly label: string;
  readonly badges: readonly ShareCardBadgeRow[];
}

/** Any row a card can carry. A union, so a renderer switch is exhaustive. */
export type ShareCardRow =
  | ShareCardTextRow
  | ShareCardCountRow
  | ShareCardRatioRow
  | ShareCardGroupRow
  | ShareCardBadgeListRow;

/**
 * The finished, renderer-neutral card model.
 *
 * Everything a canvas needs and nothing it could use to learn anything private: rows,
 * a title and caption from the content module, and no date.
 */
export interface ShareCardModel {
  readonly kind: ShareCardKind;
  /**
   * The subject name, or `null` when the learner deselected it or the device has
   * none.
   *
   * Separated from the rows so a renderer can place it as a heading without parsing
   * rows, and so "the learner chose not to publish their subject's name" is a
   * distinguishable state rather than an empty row.
   */
  readonly subjectName: string | null;
  readonly rows: readonly ShareCardRow[];
  /**
   * Fields that were selected but produced no row.
   *
   * An unstarted subject has no room total; a subject with no fishing record has no
   * fish counts. Reporting them is how a renderer can decide between "omitted" and
   * "shown as zero", which are different claims.
   */
  readonly omittedFields: readonly ShareCardField[];
}

/**
 * Everything {@link buildShareCardModel} reads.
 *
 * Structured rather than a `StatisticsSnapshot` or a `CanonicalSubjectProgression`,
 * for the reason `src/core/assistance/types.ts` gives its reduced input: this model
 * has no field a note body, a room id, or a raw badge id could be put in. The caller
 * - the application layer - copies counts out of the authoritative records, and this
 * module cannot be handed something sensitive even by mistake.
 *
 * All inputs are optional. A device with nothing - no subject, no progression, no
 * statistics, no fish - is a real state, and the card it produces is empty, not an
 * error.
 */
export interface ShareCardModelInput {
  /** The learner's subject name. Rendered only when `subjectName` is selected. */
  readonly subjectName?: string | null;
  /** `xpTotal` and the rank tier derived from it. */
  readonly progression?: ShareCardProgressionInput | null;
  /** Room counts. `roomTotal` comes from the graph; `roomsCleared` from the ledger. */
  readonly rooms?: ShareCardRoomsInput | null;
  /** The subject's progression record counts. Badge **ids**, resolved to labels here. */
  readonly badges?: readonly string[] | null;
  /** Inventory size. */
  readonly inventoryCount?: number | null;
  /** Collected notes. A **count** - note bodies are not in this interface. */
  readonly collectedNoteCount?: number | null;
  /** Fish collection counts. */
  readonly fish?: ShareCardFishInput | null;
  /** Statistics. */
  readonly statistics?: ShareCardStatisticsInput | null;
  /**
   * Assistance summary. A count of sessions, supplied by the caller.
   *
   * The Phase 19 state - suggestion ids, reason codes, dismissal records, per-room
   * signals - is deliberately **absent from this interface**, so there is no field it
   * could be copied into. See {@link ShareCardAssistanceInput}.
   */
  readonly assistance?: ShareCardAssistanceInput | null;
}

/** XP and rank. Both derived from the progression record, never recomputed here. */
export interface ShareCardProgressionInput {
  readonly xpTotal: number;
  readonly rank: string | null;
}

/** Room totals and clears. */
export interface ShareCardRoomsInput {
  readonly total: number;
  readonly cleared: number;
}

/** Fish collection counts, all derived from a canonical collection by the caller. */
export interface ShareCardFishInput {
  readonly total: number;
  readonly uniqueTypes: number;
  readonly countsByRarity: Readonly<Record<string, number>>;
}

/** Statistics counts. */
export interface ShareCardStatisticsInput {
  readonly sessionsCompleted: number;
  readonly activeDays: number;
  readonly studyStreakDays: number;
  /**
   * Recall accuracy as two counts, never a pre-formatted string.
   *
   * A domain has no opinion about `%` versus `percent`, and a pre-formatted value
   * would be a place a locale could enter the card.
   */
  readonly recall?: ShareCardRecallInput | null;
}

/** Recall accuracy's own numerator and denominator. */
export interface ShareCardRecallInput {
  readonly correct: number;
  readonly total: number;
}

/**
 * Assistance, reduced to one count.
 *
 * The complete Phase 19 state is a per-room suggestion list with ids, reason codes,
 * priorities, evidence keys, and dismissal counts. None of that can be represented
 * here: the interface has one optional integer and nothing else. The model's own
 * `assistanceSummary` field is excluded from every default selection, so even this
 * count appears only when a learner asks for it.
 */
export interface ShareCardAssistanceInput {
  /** Sessions in which assistance was shown. A count of sessions, not of suggestions. */
  readonly sessionsWithAssistance: number;
}

/**
 * {@link ShareCardModelInput} plus the kind, because a card's fields are a function of
 * its kind and a model cannot be built without one.
 *
 * The kind is typed as {@link ShareCardKind}, but the policy functions accept
 * `unknown` in the kind position too, so a value read from a restored preference is
 * safe to pass here without narrowing first - a kind this build does not know yields
 * an empty model rather than a throw.
 */
export interface ShareCardBuildInput extends ShareCardModelInput {
  readonly kind: ShareCardKind;
}