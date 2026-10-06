/**
 * The deterministic card model: a counts-only projection of learner state.
 *
 * ## What this function is
 *
 * `buildShareCardModel(input, selection)` is the whole renderer-neutral half of a
 * share card. It answers one question - *given this learner state and these chosen
 * fields, what may a card say?* - and returns plain data a canvas, a DOM preview, or a
 * test can consume without the domain knowing any of them exist.
 *
 * ## The four properties it guarantees
 *
 * **1. Deterministic.** Same input plus same selection gives byte-identical output.
 * There is no clock, no randomness, no locale API, no `Intl`, no storage, no network.
 * Phase 19 found `Date.parse` reading an offset-less timestamp as *local* time changed
 * a ranked assistance result between UTC and Asia/Kolkata, and found
 * `findSubjectIdForRoom` reading `subjects` in caller order so two subjects sharing a
 * room id flipped the answer. Both are the same failure - a value that varies with
 * something outside the input. Every order here is either a fixed declaration order or
 * an explicit sort by code unit, and the only sort comparator is `<`, never
 * `localeCompare` (which is locale-dependent, and therefore the same bug wearing a
 * different hat).
 *
 * **2. Counts only.** Every row is an integer count, a closed-vocabulary label, or a
 * ratio of two caller-supplied integers. The input interface has no field a note body
 * or a room id could be put in, and {@link ShareCardModelInput} carries badge **ids**
 * only because they are resolved to canonical labels here - never passed through.
 *
 * **3. No date, no timestamp, no generated-at line.** The pre-Phase-20 exporter drew
 * `Generated: ${new Date().toLocaleString()}`, which is host-locale and host-time-zone
 * dependent. There is no `now` parameter here to pass, which is the structural form of
 * "this card has no clock": adding one would be a visible API change, not a silent
 * one. If a future card needs a date it must take one as an explicit input.
 *
 * **4. Order-stable.** Rows come out in {@link availableFieldsFor} order, never the
 * caller's selection order, so ticking four boxes in a different order produces the
 * same card. Badge labels are sorted by label text, and unknown ids are dropped rather
 * than sorted somewhere arbitrary.
 *
 * ## The badge rule
 *
 * A badge id is app-owned data, not a label. `canonicalBadgeLabel(id)` returns
 * `undefined` for an id the content module does not recognise, and **that produces no
 * row** - the pre-Phase-20 defect was `BADGE_LABELS[badgeId] ?? badgeId`, which put
 * `CreatorPhaseComplete` on an image. The `?? id` fallback is the single thing this
 * module exists to make impossible, so there is deliberately no fallback here.
 *
 * The count is preserved even when the label is not: a learner with three unrecognised
 * ids still owns three badges, and `badgeCount` reports `3` while `badgeLabels` reports
 * nothing. That is the honest reading - the model can count what it cannot name.
 *
 * ## Assistance
 *
 * {@link ShareCardAssistanceInput} has one integer in it. The Phase 19 state - per-room
 * suggestions, ids, reason codes, priorities, dismissal counts - has nowhere to go. And
 * `assistanceSummary` is in no kind's default selection, so it appears only when a
 * learner asks for it.
 */
import { RANK_TIERS } from '@/core/progression/types';

import {
  canonicalBadgeLabel,
  SHARE_CARD_FIELD_LABELS,
  shareCardCaption,
  shareCardTitle,
} from './shareCardContent';
import {
  availableFieldsFor,
  DEFAULT_SELECTION_BY_KIND,
  normalizeShareCardSelection,
} from './shareCardPolicy';
import type {
  ShareCardBadgeListRow,
  ShareCardBadgeRow,
  ShareCardBuildInput,
  ShareCardCountRow,
  ShareCardField,
  ShareCardGroupRow,
  ShareCardKind,
  ShareCardModel,
  ShareCardModelInput,
  ShareCardRatioRow,
  ShareCardRow,
  ShareCardSelection,
  ShareCardTextRow,
} from './types';

/** The closed rank vocabulary, folded for validation. `Novice` -> `novice`. */
const RANK_VALUES: ReadonlySet<string> = new Set(RANK_TIERS.map((tier) => tier.rank));

/**
 * The app-owned rarity vocabulary, in the order a card must draw them.
 *
 * Fixed here rather than read from the caller's object, because
 * `Object.keys` order on a caller-supplied record is not a contract - it is insertion
 * order, and it changes between two objects with the same content. `common`, `rare`,
 * `epic` is the rarest-last order the fish domain uses everywhere else.
 */
const RARITY_ORDER: readonly string[] = Object.freeze(['common', 'rare', 'epic'] as const);

/** Longest subject name a card will carry, in code units. */
const MAX_SUBJECT_NAME_LENGTH = 80;

/** Non-finite and negative-safe integer coercion. `-5`, `NaN`, `Infinity` -> `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * A subject name, normalized but **never emptied by invention**.
 *
 * A name that is empty, whitespace-only, or longer than
 * {@link MAX_SUBJECT_NAME_LENGTH} becomes `null`, not a placeholder: the caller has a
 * real branch for "no name on this card", and a fabricated name would be a false claim
 * about the learner's own subject. Truncation keeps a real name usable at a card's
 * width while bounding the bytes.
 *
 * No whitespace normalization beyond a trim, and **no** bidi or control-character
 * stripping: the name is the learner's own text, and mangling someone's script to make
 * an image render would be worse than letting a long string truncate. The bound is the
 * defence.
 */
function toSubjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_SUBJECT_NAME_LENGTH ? trimmed.slice(0, MAX_SUBJECT_NAME_LENGTH) : trimmed;
}

/** The field's display label, or the field id when the content module lacks it. */
function fieldLabel(field: ShareCardField): string {
  const label = SHARE_CARD_FIELD_LABELS[field];
  return typeof label === 'string' && label.length > 0 ? label : field;
}

function countRow(field: ShareCardField, value: number): ShareCardCountRow {
  return { field, label: fieldLabel(field), value, isEmpty: value === 0 };
}

function ratioRow(
  field: ShareCardField,
  numerator: number,
  denominator: number,
): ShareCardRatioRow {
  const safeNumerator = toCount(numerator);
  const safeDenominator = toCount(denominator);
  // Clamped: a caller that passes `correct > total` gets `1`, not `1.4`, because a
  // ratio above one is not a fact about anybody.
  const clampedNumerator =
    safeDenominator === 0 ? 0 : Math.min(safeNumerator, safeDenominator);
  const ratio =
    safeDenominator === 0 ? 0 : Math.round((clampedNumerator / safeDenominator) * 10_000) / 10_000;
  return {
    field,
    label: fieldLabel(field),
    numerator: clampedNumerator,
    denominator: safeDenominator,
    ratio,
  };
}

/**
 * The rarity group row, or `null` when the caller supplied no fish record.
 *
 * A group with every count at zero is **not** null: the learner has a fish collection
 * and it is empty, which is a different claim from "this device has never fished".
 * Only an absent `countsByRarity` is absent.
 */
function fishGroupRow(
  field: 'fishRarityCounts',
  fish: ShareCardModelInput['fish'],
): ShareCardGroupRow | null {
  if (!fish || typeof fish.countsByRarity !== 'object' || fish.countsByRarity === null) {
    return null;
  }
  const counts: Record<string, number> = {};
  // Iterate the fixed order, never the caller's keys, so an unknown key and an
  // insertion-order difference cannot change the row.
  for (const rarity of RARITY_ORDER) {
    counts[rarity] = toCount((fish.countsByRarity as Record<string, unknown>)[rarity]);
  }
  return { field, label: fieldLabel(field), counts, order: RARITY_ORDER };
}

/**
 * The badges row, or `null` when no badge id resolved to a canonical label.
 *
 * `null` rather than an empty list, so "no badges" (nothing to say) and "badges I
 * cannot name" are not drawn as the same row. Either way no raw id appears.
 */
function badgeRow(
  field: 'badgeLabels',
  badgeIds: readonly string[] | null | undefined,
): ShareCardBadgeListRow | null {
  if (!Array.isArray(badgeIds)) return null;

  // Deduplicate first, then resolve. A record that lists the same id twice earns the
  // badge once; counting it twice would be a false claim about the learner's progress.
  const unique = Array.from(new Set(badgeIds.filter((id): id is string => typeof id === 'string')));

  const byLabel = new Map<string, number>();
  for (const id of unique) {
    // `undefined` for an unrecognised id, and there is deliberately no `?? id`:
    // `canonicalBadgeLabel` exists so a raw id cannot reach an image.
    const label = canonicalBadgeLabel(id);
    if (typeof label !== 'string' || label.length === 0) continue;
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
  }
  if (byLabel.size === 0) return null;

  // Sort by label code unit, not by id and not by input order: two devices holding the
  // same set of badges in different orders must lay the rows out identically.
  const labels = Array.from(byLabel.keys()).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const badges: readonly ShareCardBadgeRow[] = labels.map((label) => ({
    label,
    count: byLabel.get(label) ?? 0,
  }));
  return { field, label: fieldLabel(field), badges };
}

/** The rank row, or `null` when the value is not one of the three published tiers. */
function rankRow(field: ShareCardField, rank: unknown): ShareCardTextRow | null {
  if (typeof rank !== 'string') return null;
  const trimmed = rank.trim();
  if (trimmed.length === 0 || !RANK_VALUES.has(trimmed)) return null;
  return { field, label: fieldLabel(field), value: trimmed };
}

/**
 * Build the card model for a kind under a selection.
 *
 * ## Order of operations, and why
 *
 * 1. **Normalize the selection first.** `normalizeShareCardSelection` drops anything not
 *    in the allowlist, not in this kind's table, denied by the denylist, or duplicated,
 *    and returns the survivors in the kind's declared order. Every row below is built
 *    only for a field that survived, so **no code path can produce a row the policy
 *    forbids** - there is no second filter to forget.
 * 2. **Then read the input.** A field whose input is missing produces no row and
 *    appears in `omittedFields`, which is how a renderer distinguishes "omitted" from
 *    "shown as zero".
 *
 * `selection` is optional; omitting it uses {@link DEFAULT_SELECTION_BY_KIND}, so the
 * default card is reachable without the caller restating it - and the defaults are
 * themselves normalized, so the two paths cannot drift.
 *
 * Pure, total, and never throws: an unknown kind, a hostile selection, an absent
 * subject, and a subject with a 500-character emoji-and-RTL name all return a model.
 */
export function buildShareCardModel(
  input: ShareCardBuildInput,
  selection?: ShareCardSelection | readonly ShareCardField[] | null,
): ShareCardModel {
  const kind: ShareCardKind = input.kind;
  // An absent selection means "the defaults". `null` and an explicit array are not the same
  // thing: `null` says "the caller has no preference recorded", which is the fresh-dialog case,
  // while a per-kind record with no entry for this kind is that kind's default.
  const requested = Array.isArray(selection)
    ? selection
    : ((selection as ShareCardSelection | null | undefined | undefined)?.[kind] ??
       DEFAULT_SELECTION_BY_KIND[kind]);
  const fields = normalizeShareCardSelection(kind, requested);

  const rows: ShareCardRow[] = [];
  const omittedFields: ShareCardField[] = [];

  // `subjectName` is handled here rather than in `buildRow`: it is the model's own property, not
  // a row, so it must not be reported as an omitted row when it is absent. A learner who chose not
  // to publish their subject's name and a learner whose subject has no name are different states,
  // and both are visible as `subjectName === null`.
  const subjectNameSelected = fields.includes('subjectName');
  if (subjectNameSelected && toSubjectName(input.subjectName) === null) {
    omittedFields.push('subjectName');
  }

  for (const field of fields) {
    if (field === 'subjectName') continue;
    const row = buildRow(field, input);
    if (row === null) {
      omittedFields.push(field);
      continue;
    }
    rows.push(row);
  }

  return {
    kind,
    subjectName: subjectNameSelected ? toSubjectName(input.subjectName) : null,
    rows,
    omittedFields,
  };
}

/**
 * One row for one allowed field, or `null` when the field has no data.
 *
 * A `switch` over the closed field vocabulary rather than a lookup table of closures,
 * so the compiler reports a missing field when one is added: a new
 * {@link ShareCardField} that nobody handled becomes a typecheck error here, which is
 * the review gate the phase needs.
 */
function buildRow(field: ShareCardField, input: ShareCardBuildInput): ShareCardRow | null {
  switch (field) {
    // Unreachable: `buildShareCardModel` handles `subjectName` before the row loop, because it is
    // not a row. Present so the switch stays exhaustive over the closed vocabulary, which is what
    // makes a new field a typecheck error here rather than a silently missing row.
    case 'subjectName':
      return null;
    case 'rank':
      return rankRow(field, input.progression?.rank ?? null);
    case 'xpTotal':
      return input.progression ? countRow(field, toCount(input.progression.xpTotal)) : null;
    case 'roomsCleared':
      return input.rooms ? countRow(field, toCount(input.rooms.cleared)) : null;
    case 'roomTotal':
      return input.rooms ? countRow(field, toCount(input.rooms.total)) : null;
    case 'badgeCount':
      return Array.isArray(input.badges)
        ? countRow(field, new Set(input.badges.filter((id) => typeof id === 'string')).size)
        : null;
    case 'badgeLabels':
      return badgeRow(field, input.badges);
    case 'inventoryCount':
      return typeof input.inventoryCount === 'number' ? countRow(field, toCount(input.inventoryCount)) : null;
    case 'collectedNoteCount':
      return typeof input.collectedNoteCount === 'number'
        ? countRow(field, toCount(input.collectedNoteCount))
        : null;
    case 'fishTotal':
      return input.fish ? countRow(field, toCount(input.fish.total)) : null;
    case 'fishUniqueTypes':
      return input.fish ? countRow(field, toCount(input.fish.uniqueTypes)) : null;
    case 'fishRarityCounts':
      return fishGroupRow(field, input.fish);
    case 'studyStreakDays':
      return input.statistics ? countRow(field, toCount(input.statistics.studyStreakDays)) : null;
    case 'activeStudyDays':
      return input.statistics ? countRow(field, toCount(input.statistics.activeDays)) : null;
    case 'sessionsCompleted':
      return input.statistics ? countRow(field, toCount(input.statistics.sessionsCompleted)) : null;
    case 'recallAccuracy':
      // Absent recall input omits the row; a present one with `total: 0` is kept, so
      // "no recalls yet" is distinguishable from "no statistics record".
      return input.statistics?.recall
        ? ratioRow(field, input.statistics.recall.correct, input.statistics.recall.total)
        : null;
    case 'assistanceSummary':
      return input.assistance
        ? countRow(field, toCount(input.assistance.sessionsWithAssistance))
        : null;
    default:
      // Unreachable for a well-typed field; a hostile runtime value cannot reach it
      // either, because `normalizeShareCardSelection` already filtered it out.
      return null;
  }
}

/**
 * The card's title, for a kind.
 *
 * Re-exported through the model so a renderer makes one import for the whole contract
 * and cannot reach past the policy to a string literal.
 */
export function titleForKind(kind: ShareCardKind): string {
  return shareCardTitle(kind);
}

/** The card's caption, for a kind. Same single-import reason as {@link titleForKind}. */
export function captionForKind(kind: ShareCardKind): string {
  return shareCardCaption(kind);
}

/**
 * Does this model carry any row at all?
 *
 * A learner with nothing started gets a truthful empty card rather than a card of
 * zeros, and this is the question a renderer asks before drawing anything. Note it is
 * **not** `subjectName !== null || rows.length > 0`: a card showing only a subject name
 * is a card with no metrics, which is a real and slightly sad state worth handling
 * differently from a card with nothing on it.
 */
export function isEmptyShareCardModel(model: ShareCardModel): boolean {
  return model.rows.length === 0;
}

/**
 * Every field in a model's rows, in row order.
 *
 * A convenience for the renderer's "is this field on the card?" check and for the
 * tests' denylist probes - it reads the **built** rows rather than the requested
 * selection, so it answers what actually rendered.
 */
export function fieldsInModel(model: ShareCardModel): readonly ShareCardField[] {
  return model.rows.map((row) => row.field);
}

/** Every field available to a kind, re-exported so the renderer needs one import. */
export { availableFieldsFor };