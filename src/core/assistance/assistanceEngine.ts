/**
 * The deterministic ranked-assistance engine (plan section 8, Phase 19).
 *
 * ## The claim this module has to make true
 *
 * *"Ensure identical state always produces identical suggestions."* Every design choice
 * below exists to make that claim falsifiable rather than aspirational, and the module
 * header names each one so a future edit knows what it is about to break.
 *
 * ## Every source of nondeterminism is injected
 *
 * There is no `Date.now()`, no `new Date()`, no `Math.random()`, no `crypto`, no
 * `performance`, no `Intl`, and no ambient module state in this file. Time arrives as
 * {@link AssistanceEngineInput.nowIso}, a string the caller supplies, and it is the only
 * time input. `tests/phase19/assistanceDeterminism.test.ts` scans the executable code of
 * this directory for those tokens and fails on any of them, so the property is enforced
 * by a gate rather than by this paragraph.
 *
 * ## Locale-dependent ordering is banned, and `localeCompare` is the specific trap
 *
 * Nothing here sorts or compares strings with `localeCompare`. That is not stylistic
 * pedantry: `localeCompare`'s result depends on the host's ICU collation data and on the
 * active locale, so two devices holding byte-identical learner state can order two
 * topics differently - `'a'.localeCompare('B')` is `-1` under the `en-US` collation that
 * a GitHub runner has, because that collation is case-insensitive at the primary level,
 * while a code-unit comparison puts `'B'` (U+0042) before `'a'` (U+0061). Anything that
 * *looks* at the comparison result - a tie-break, a "first" pick, a slice - would then
 * produce different suggestions on different devices from identical state, which is
 * exactly the property this phase promises.
 *
 * The existing {@link compareCodeUnits} is used for every ordering decision here, including
 * the final ranking tie-break. `src/core/graph/navigation.ts` uses `localeCompare` for a
 * *presentation* order; that is a different question with a different right answer, and
 * this engine deliberately does not reuse it.
 *
 * ## Every collection is put in a total order before it is read
 *
 * `Object.keys` order is insertion order for string keys, so two objects that are
 * `toEqual` can iterate in different orders. Every candidate list is therefore built by
 * iterating {@link ASSISTANCE_SIGNAL_KEYS} or {@link ASSISTANCE_SUGGESTION_KINDS} - the
 * declared closed arrays - rather than over an object's own keys, and every `Array`
 * derived from caller data is sorted with {@link compareCodeUnits} before anything reads
 * it. The final sort's comparator is a **total order**: `priority` descending, then
 * `kind`, then `targetId`, and because `suggestionId` is derived from exactly `(kind,
 * targetId)` and candidates are de-duplicated by it, no two entries in the sorted list can
 * tie on all three. That matters because relying on `Array.prototype.sort` stability would
 * make the *input* order load-bearing, which is the leak this module is built to avoid.
 *
 * ## Scores are integers
 *
 * {@link AssistancePriority} and every increment are whole numbers, and the result is
 * clamped to `0..100`. Floating-point accumulation is a real determinism hazard across
 * engines - `0.1 + 0.2 !== 0.3` is harmless in one direction and catastrophic in the other,
 * and summing ten fractions of a rubric score can land on either side of a threshold
 * depending on association order. Integer arithmetic has neither problem, and it has the
 * second property that a score is meaningful inside a checksummed fixture.
 *
 * ## `off` removes suggestions structurally, and the proof is observable
 *
 * `off` is not a filter. Every rule in this module is a function whose parameter type is
 * {@link ProactiveAssistanceMode} - `Exclude<AssistanceMode, 'off'>` - so *no rule can be
 * handed `off`*; the typechecker rejects it. {@link rankAssistance} is the only entry
 * that accepts a raw {@link AssistanceMode}, and in `off` mode it returns before any rule
 * is called. Two independent backstops sit behind that:
 *
 * 1. {@link rankProactiveAssistance} throws if a JavaScript caller - a `as never` cast, a
 *    hand-edited bundle, a `postMessage` - hands it `off` at run time.
 * 2. {@link AssistanceResult.evaluatedRuleKinds} names every rule that **executed**. In
 *    `off` mode it is always empty, and a test asserts that rather than asserting only the
 *    visible (already empty) list. "No proactive suggestions are shown" and "no
 *    proactive suggestion was ever computed" are different claims, and only the second one
 *    is the one the plan means.
 *
 * ## Suggestions are advisory, and the proof is the module graph
 *
 * A suggestion is frozen data: no call signatures, no store handle, no repository handle.
 * An `AssistanceAction` describes what *could* be offered - "offer a cross-link to this
 * room" - and offers nothing. So the engine needs no write capability to exist, which is a
 * stronger property than a comment promising the code is careful. The mechanical half is
 * enforced by `tests/phase19/assistanceDomainBoundary.test.ts`: this directory's **runtime**
 * import closure is `src/core/` only, so there is no repository, no `localStorage`, no
 * `indexedDB`, and no network reachable from a suggestion by construction.
 *
 * Nothing here can change a deterministic learning outcome, because nothing here can
 * write. Validation stays in `evaluateNoteValidation`, SM-2 stays in `updateSm2State`, and
 * every reward stays in its own awarded-once ledger. When assistance disagrees with those,
 * those are right and this module is advisory - which is why every suggestion carries a
 * {@link AssistanceReasonCode} and every explanation is a pure derivation rather than a
 * stored sentence.
 *
 * ## Time is UTC, deliberately, and this disagrees with the dashboard on purpose
 *
 * Due-date arithmetic here is UTC epoch arithmetic (one canonical parse, then whole-day
 * differences), not the *local* calendar `src/core/statistics/localCalendar.ts` uses, and
 * it does not use `daysUntilReview`/`daysSinceReviewDue` at all. Two reasons, both
 * required:
 *
 * - `daysUntilReview` defaults `now` to `new Date().toISOString()`, so calling it without
 *   an argument reads an ambient clock - forbidden here.
 * - It compares `Date.prototype.toDateString()`, which is rendered in the **host's** time
 *   zone. A learner in UTC+13 and a learner in UTC-8 holding identical room state would
 *   receive different assistance, which is the failure this module exists to prevent. The
 *   local calendar is the right rule for *displaying* "today" to a human, and it was the
 *   right call for the Phase 18 dashboard; it is the wrong rule for a value that must be
 *   reproducible from state alone.
 *
 * The cost is a named, accepted inconsistency: the assistance card and the statistics
 * dashboard can disagree about whether a review is due "today" for a learner far from
 * UTC. That is recorded rather than silently reconciled, because reconciling it would
 * mean reintroducing the host clock. {@link daysUntilDue} is exported so the difference is
 * one named function rather than a scattering of arithmetic.
 *
 * ## `Date.parse` is not the rule; `readUtcEpochMs` is
 *
 * The sentence "compared by UTC epoch, so the host time zone cannot change the answer" is
 * only true of a timestamp that **carries its own offset**. `Date.parse` reads an
 * ISO-8601 date-time with no offset - `2026-03-17T04:00:00` - in the **host's** time zone,
 * and its legacy fallback parser does the same for non-ISO shapes like
 * `March 17, 2026 04:00:00`. So the engine used to answer `1` under UTC and under
 * America/New_York and `0` under Asia/Kolkata, Australia/Adelaide and Pacific/Chatham, for
 * one stored string and one `nowIso`: identical restored state, three different ranked
 * results. That is this module's own failure mode, reached through a real `.kdsubject`
 * restore that the archive validator accepts.
 *
 * {@link readUtcEpochMs} is therefore the **only** function in this directory that parses a
 * timestamp, and it accepts exactly two things:
 *
 * 1. An ISO-8601 date or date-time that carries an explicit offset - `Z`, `z`, `±HH:MM`,
 *    `±HHMM`, or `±HH` - resolved through that offset. A date-only value is UTC by
 *    specification, so it is read directly.
 * 2. An ISO-8601 date-time that carries **no** offset, read as **UTC wall clock**.
 *
 * Everything else is `null`. The rule in (2) is the decision this module makes about
 * ambiguous data, and it is made once, in one function, so no caller can disagree with it
 * about what a stored `sm2NextReviewDate` means.
 *
 * ### Why "read it as UTC" and not "refuse it"
 *
 * Refusing an offset-less value - the alternative - is defensible on principle, and it was
 * weighed. It was rejected for one reason: **silence is the more damaging failure.** A
 * refused due date is not one missing card, it is a room that the Archaeologist rules and
 * `device.due-today` can never speak about again until a review pass rewrites the field,
 * so a learner with one mangled timestamp silently loses the prioritisation feature for
 * that room *and* the device-wide review summary it feeds. A UTC reading is a wrong-by-at-
 * most-one-offset-interval answer that is identical on every device, is corrected by the
 * next review, and never hides the fact that a review is scheduled. Refusing trades a
 * visible, bounded, deterministic imprecision for an invisible, unbounded, permanent loss.
 *
 * UTC is also the right wall clock to assume rather than a coin flip: **every** value this
 * app writes is UTC with a `Z` (`addDaysToIso` returns `new Date(...).toISOString()`, and
 * `toISOString` always emits the marker), so the offset-less values that reach here come
 * from a writer that stripped or never had the marker, and every common generator of that
 * shape - `toISOString().slice(0, 19)`, a SQL `DATETIME` of a UTC-stored value, a SOAP
 * payload, a hand edit - was writing UTC wall clock. The residual cost is stated rather
 * than assumed away: a value that a foreign tool wrote in **its own local** wall clock is
 * read as UTC and is therefore off by that tool's offset, deterministically and
 * identically on every device, until the next review rewrites it.
 *
 * The counter-case that is **not** a defect: an offset-less value written with local
 * getters and read back on the same device was stable before this fix too, because write-
 * local and read-local cancel. It is stable only on *that* device, and the archive can
 * travel. Cross-device is the whole claim.
 */

import { QUALITY_SCORE_KEYS } from '@/core/validation/persistence/types';
import { REQUIRED_NOTE_SECTIONS } from '@/core/validation/notes/types';

export type { AssistanceStudyInput } from './types';

import {
  ASSISTANCE_SUGGESTION_KINDS,
  resolveAssistanceSignals,
  type AssistanceAction,
  type AssistanceActionKind,
  type AssistanceEmptyReason,
  type AssistanceEvidence,
  type AssistanceEvidenceKey,
  type AssistanceExplanation,
  type AssistanceIntensity,
  type AssistanceMode,
  type AssistanceReasonCode,
  type AssistanceResult,
  type AssistanceRoomInput,
  type AssistanceSignalKey,
  type AssistanceSignals,
  type AssistanceStudyInput,
  type AssistanceSubjectInput,
  type AssistanceSuggestion,
  type AssistanceSuggestionKind,
  type AssistanceSurface,
  type ProactiveAssistanceMode,
} from './types';

// ── Small deterministic primitives ───────────────────────────────────────────

/**
 * Compare two strings by **UTF-16 code unit**, ascending.
 *
 * `a < b` in JavaScript is already a code-unit comparison (`<` on strings uses
 * `codePointAt`-free UTF-16 ordering), so this is a spelling-out of the rule rather than a
 * new algorithm - and the spelling matters, because the natural alternative in this
 * repository is `localeCompare`, which is host-dependent. Written as explicit branches so
 * no reader has to know that and no refactor can reach for `localeCompare`.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Milliseconds in a UTC day. Used only for whole-day *differences*, never for a date key. */
const MS_PER_DAY = 86_400_000;

/**
 * An ISO-8601 date **only**: `YYYY-MM-DD`, nothing else.
 *
 * A date-only value is UTC by specification, so it needs no offset appended and is the one
 * offset-less shape that `Date.parse` already reads unambiguously.
 */
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ISO-8601 date-time **prefix**: `YYYY-MM-DD` followed by `T` or a space and `HH:MM`.
 *
 * Deliberately a prefix match rather than a whole-string match. It decides *which strings
 * are candidates for the UTC reading*, and a candidate that is not valid ISO - a bad month,
 * a 25th hour - still falls out as `null` from the parse. What the shape must exclude is
 * the shapes `Date.parse` accepts through its legacy fallback parser, because that parser is
 * the second way the host time zone used to reach the answer: `'March 17, 2026 04:00:00'`
 * parses, it parses as **local** time, and it is not ISO-8601.
 */
const ISO_DATE_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * An explicit UTC designator or numeric offset at the **end** of an ISO date-time.
 *
 * `Z`, `z`, `±HH:MM`, `±HHMM`, and the hour-only `±HH` the ES grammar accepts. Only ever
 * tested on a string that already matched {@link ISO_DATE_TIME_PREFIX}, which is what keeps
 * the `-17` in a date from reading as an offset: `'2026-03-17'` is handled by
 * {@link ISO_DATE_ONLY} and never reaches this.
 */
const EXPLICIT_OFFSET_SUFFIX = /(?:[Zz]|[+-]\d{2}:?\d{2}|[+-]\d{2})$/;

/**
 * The one place in the assistance domain that turns a timestamp string into an epoch.
 *
 * Returns `null` for anything it does not positively recognise as an ISO-8601 UTC-anchored
 * instant, and - the reason this function exists - it **never** consults the host time zone.
 * See the module header, "Date.parse is not the rule", for the measured failure this
 * replaces and for why an offset-less value is read as UTC rather than refused.
 *
 * Total, never throws, and takes no ambient input: the only inputs are the string and the
 * three closed-shape constants above.
 */
function readUtcEpochMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const dateOnly = ISO_DATE_ONLY.test(iso);
  if (!dateOnly && !ISO_DATE_TIME_PREFIX.test(iso)) return null;
  // Append the marker an offset-less date-time is missing, so `Date.parse` is told UTC
  // instead of being left to assume the host's zone. A date-only value is already UTC.
  const canonical =
    !dateOnly && !EXPLICIT_OFFSET_SUFFIX.test(iso) ? `${iso}Z` : iso;
  const ms = Date.parse(canonical);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whole UTC days from `fromIso` until `toIso`, **truncated toward zero**.
 *
 * ## Why `trunc` and not `floor` or `ceil`
 *
 * This function answers two questions with one number: "is it due yet" (sign) and "how far
 * past due" (magnitude). The truncation rule that makes both answers correct is the one that
 * rounds toward zero:
 *
 * | Difference | `trunc` | `floor` | `ceil` | Which is honest |
 * | --- | --- | --- | --- | --- |
 * | +12.5 h (due later today) | `0` | `0` | `1` | `trunc`: "0 days until" is true; "1 day until" for a room due in half a day is not. |
 * | -1 h (one hour late) | `0` | `-1` → **1 day overdue** | `0` | `trunc`: one hour late is not one day overdue. |
 * | -25 h | `-1` → 1 day overdue | `-2` → **2 days overdue** | `-1` | `trunc` and `ceil` agree; `floor` over-reports. |
 *
 * **`floor` was the first implementation and it was wrong**, which an attack found rather
 * than a reading: `floor` turns "one hour late" into "one day overdue", so the
 * `archaeologist.due-room` priority would rank a room that is five minutes behind the same
 * as one that is twenty-three hours behind. Truncation is the fix and the test pins all
 * three rows above.
 *
 * ## Exactness
 *
 * The division is exact for every whole-day multiple: both operands are integers below
 * `2^53`, and IEEE-754 division returns the correctly rounded value of the exact quotient, so
 * a quotient that *is* a representable integer comes back as that integer rather than one ULP
 * below it. `trunc` then has nothing to round. That is what keeps a room due "in exactly 7
 * days" out of the "6 days" bucket on some engines and not others - the failure
 * `Math.floor` would have introduced had the quotient been even slightly imprecise.
 *
 * ## `null` rather than a guess
 *
 * A timestamp this module cannot place on the UTC timeline returns `null`, not `0`. A room
 * whose `sm2NextReviewDate` is corrupt - `'not-a-timestamp'`, `'March 17, 2026'`, a
 * non-ISO string the engine does not recognise - should produce no due-room suggestion, not
 * a suggestion about a day that does not exist. Callers treat `null` as "no evidence", which
 * is the same answer a device with no such room gives - and distinguishing "no evidence" from
 * "due now" is what keeps a corrupted timestamp from silently manufacturing an urgent
 * suggestion.
 *
 * `null` is **not** the answer for an offset-less timestamp, which is ambiguous but not
 * corrupt: that is read as UTC by {@link readUtcEpochMs}. The distinction is worth stating
 * because both end in "no suggestion" for some inputs, and only one of them is a permanent
 * loss of the review schedule.
 */
export function daysUntilDue(toIso: string | null | undefined, fromIso: string): number | null {
  const toMs = readUtcEpochMs(toIso);
  const fromMs = readUtcEpochMs(fromIso);
  if (toMs === null || fromMs === null) return null;
  const whole = Math.trunc((toMs - fromMs) / MS_PER_DAY);
  // Normalise `-0` to `0`.
  //
  // `Math.trunc(-0.04)` is `-0`, and `Object.is(-0, 0)` is `false` - so a `-0` leaving this
  // function breaks every `toBe(0)` a consumer writes about it, and (worse) makes
  // `Object.is`-keyed caches treat a room one hour past due as different from a room due now.
  // An attack found this, not a reading: the boundary test for "exactly one hour before the
  // due instant" failed on `expected -0 to be +0` against an implementation that was otherwise
  // correct. `+ 0` is the standard normalisation and costs one operation.
  return whole + 0 === 0 ? 0 : whole;
}

/**
 * Whole UTC days past due, floored at zero.
 *
 * The `Math.max(0, ...)` is the whole rule, and it is a *different* rule from clamping the
 * "days until" value at zero: a review three days late must be able to say "3", because a
 * surface that cannot distinguish "due this morning" from "three days late" cannot
 * prioritise. This mirrors `daysSinceReviewDue` in `src/core/review/spacedRepetition.ts`
 * with the two changes that make it deterministic - epoch arithmetic instead of
 * `Date.prototype.toDateString()`, and truncation instead of a floor that would report a
 * room one hour late as one day overdue.
 */
export function daysOverdue(dueIso: string | null | undefined, nowIso: string): number {
  const until = daysUntilDue(dueIso, nowIso);
  if (until === null) return 0;
  return until >= 0 ? 0 : -until;
}

/** Clamp to the inclusive integer range `0..100`. The whole scoring range. */
function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated < 0) return 0;
  if (truncated > MAX_PRIORITY) return MAX_PRIORITY;
  return truncated;
}

/** Highest priority any suggestion may carry. */
export const MAX_PRIORITY = 100;

// ── Mode policy ──────────────────────────────────────────────────────────────

/**
 * What each *proactive* mode changes.
 *
 * `off` is absent by construction: this table is keyed by {@link ProactiveAssistanceMode},
 * so there is no cell to consult and no "what does off mean here" question to answer
 * wrongly. The mode differences are the plan's own - Gentle is "short steps, stronger cues,
 * examples, and more generous timing", Standard is "contextual hints after hesitation,
 * repeated attempts, or low recall" - which means **lower thresholds, more suggestions, and
 * a stronger intensity** for Gentle.
 */
interface ModePolicy {
  /** Suggestions scoring below this are dropped. Gentle keeps more. */
  readonly minimumPriority: number;
  /** How many suggestions the result may carry. Gentle keeps more. */
  readonly limit: number;
  /** Priority at or above which Gentle shows an example rather than a step. */
  readonly strongIntensityAt: number;
}

const MODE_POLICY: Readonly<Record<ProactiveAssistanceMode, ModePolicy>> = Object.freeze({
  gentle: Object.freeze({ minimumPriority: 10, limit: 6, strongIntensityAt: 40 }),
  standard: Object.freeze({ minimumPriority: 25, limit: 4, strongIntensityAt: 70 }),
});

/**
 * The intensity a mode presents a given priority at.
 *
 * A pure function of two integers, so it cannot drift between renders, and it is exported
 * so a surface reads the engine's answer rather than re-deriving one and disagreeing with
 * the ranking that produced it.
 */
export function intensityFor(mode: ProactiveAssistanceMode, priority: number): AssistanceIntensity {
  const policy = MODE_POLICY[mode];
  if (mode === 'gentle') {
    return priority >= policy.strongIntensityAt ? 'example' : priority >= 20 ? 'step' : 'cue';
  }
  return priority >= policy.strongIntensityAt ? 'step' : 'cue';
}

// ── Engine input ─────────────────────────────────────────────────────────────

/**
 * The fishing half of the input.
 *
 * Present only while a pond visit is in progress. `lastMissedRoomId` is the room whose
 * recall question the learner did not answer - an **app-minted room id**, which is the
 * whole reason it is allowed to appear here: it is the navigation target the plan's
 * "navigation after a missed recall question" deliverable needs, and it says nothing about
 * what the learner knows.
 *
 * A navigation suggestion is never produced from the signal count alone; without a named
 * room there is nowhere to navigate to, and inventing a target would be an answer.
 */
export interface AssistanceFishingInput {
  readonly subjectId: string;
  readonly lastMissedRoomId: string | null;
  /** How many recall questions this pond visit has missed. A count. */
  readonly missedThisVisit: number;
}

/** Everything the engine is a pure function of. */
export interface AssistanceEngineInput {
  /**
   * The mode. `'off'` short-circuits before any rule runs - see the module header.
   */
  readonly mode: AssistanceMode;
  /**
   * The persisted signal map. Unknown keys are ignored rather than trusted, and every
   * known key is coerced to a non-negative integer by {@link resolveAssistanceSignals}.
   */
  readonly signals: AssistanceSignals | null | undefined;
  /** Every subject the caller wants assistance for. */
  readonly subjects: readonly AssistanceSubjectInput[];
  /**
   * The injected clock, as an ISO-8601 string. **The only time input in this module.**
   *
   * Placed on the UTC timeline by {@link readUtcEpochMs} under the module header's one rule:
   * an explicit offset is honoured, an offset-less ISO date-time is read as UTC, and
   * anything else yields no evidence. So the host time zone cannot change the answer - which
   * is a property of *that parser*, not of `Date.parse`, and `Date.parse` alone does not have
   * it.
   */
  readonly nowIso: string;
  /** Device-wide study aggregate, when the caller has one. */
  readonly study?: AssistanceStudyInput;
  /** The fishing context, when a pond visit is in progress. */
  readonly fishing?: AssistanceFishingInput;
  /**
   * Whether the Phase 19 feature flag is on for this build.
   *
   * Passed in rather than read here: `src/config/featureFlags.ts` is the flag registry and
   * a `src/core/` module must not reach into `src/config/` (or anything else outside
   * `src/core/`) to find out. When `false`, the engine reports
   * {@link AssistanceEmptyReason} `'flag-disabled'` - which is how the Phase 19 rollback
   * ("Set `VITE_ADAPTIVE_ASSISTANCE=false` and leave locally stored assistance records
   * untouched") becomes a *behavioural* result and not merely an unreachable import.
   */
  readonly flagEnabled: boolean;
}

/** The input to the proactive half, which structurally cannot carry `off`. */
export type ProactiveAssistanceEngineInput = Omit<AssistanceEngineInput, 'mode'> & {
  readonly mode: ProactiveAssistanceMode;
};

// ── Rule plumbing ────────────────────────────────────────────────────────────

/**
 * The unit each rule is scored in.
 *
 * Priority is an integer, so a unit is an integer too. The constants are collected here
 * rather than written inline so a reader can see the whole scoring scale in one place and
 * a test can assert that every rule's base is a whole number.
 */
const AssistancePriority = Object.freeze({
  /** A structural observation about the graph. */
  structural: 20,
  /** One failing required section named by the deterministic validator. */
  missingSection: 35,
  /** A blocking validation criterion the deterministic validator failed. */
  validationFailed: 45,
  /** A rubric criterion scored zero. */
  rubricLow: 30,
  /** One room past its SM-2 due date. */
  reviewDue: 40,
  /** One room overdue by at least a week. */
  reviewLongOverdue: 15,
  /** One room whose last recall rating was below the pass threshold. */
  lowRecall: 35,
  /** One missed fishing recall question. */
  fishingMiss: 50,
  /** The device has at least one reviewable room due. */
  deviceReviewsDue: 25,
});

/** Added once per extra occurrence, so a count raises priority without dominating it. */
const AssistancePriorityIncrement = Object.freeze({
  /** Per additional missing required section, capped at four. */
  extraMissingSection: 5,
  /** Per additional failed blocking criterion, capped at two. */
  extraFailedCheck: 8,
  /** Per additional low-scoring rubric criterion, capped at four. */
  extraRubricCriterion: 6,
  /** Per additional adjacent related room an edge is missing between. */
  extraUnlinkedRoom: 7,
  /** Per additional due room in the device-wide summary. */
  extraDueRoom: 3,
  /** Per additional repeated draft, capped at three. */
  extraRepeatedDraft: 9,
  /** Per additional missed recall question, capped at three. */
  extraFishingMiss: 10,
});

/** Caps on the increments, so a pathological count cannot dominate the ranking. */
const AssistancePriorityCap = Object.freeze({
  extraMissingSection: 4,
  extraFailedCheck: 2,
  extraRubricCriterion: 4,
  extraUnlinkedRoom: 3,
  extraDueRoom: 6,
  extraRepeatedDraft: 3,
  extraFishingMiss: 3,
});

/** `min(count, cap)` with both operands whole numbers. Never negative. */
function cappedCount(count: number, cap: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const truncated = Math.trunc(count);
  return truncated < cap ? truncated : cap;
}

/** The SM-2 pass threshold. Below this, the recall rating counts as low. */
export const LOW_RECALL_QUALITY_THRESHOLD = 3;

/**
 * What one rule hands the assembler.
 *
 * A rule never touches the ranking, the sort, or the de-duplication; it returns a
 * candidate and the assembler decides. That split is what lets `evaluatedRuleKinds` be
 * recorded truthfully: a rule that produced nothing still ran, and is still reported.
 */
interface AssistanceCandidate {
  readonly kind: AssistanceSuggestionKind;
  readonly surface: AssistanceSurface;
  /** The room, or `''` for a device-wide candidate. */
  readonly targetId: string;
  readonly priority: number;
  readonly reasonCode: AssistanceReasonCode;
  readonly signalKey: AssistanceSignalKey | null;
  readonly signalValue: number;
  readonly actionKind: AssistanceActionKind;
  readonly actionRoomId: string | null;
  readonly actionDetail: string | null;
}

/**
 * The shared context a rule reads.
 *
 * `mode` is {@link ProactiveAssistanceMode}, which is the structural off-mode guarantee
 * restated at the parameter. A rule that wanted to behave differently in `off` could not
 * typecheck.
 */
interface RuleContext {
  readonly mode: ProactiveAssistanceMode;
  readonly signals: ReturnType<typeof resolveAssistanceSignals>;
  readonly subjects: readonly AssistanceSubjectInput[];
  readonly nowIso: string;
  readonly study: AssistanceStudyInput | null;
  readonly fishing: AssistanceFishingInput | null;
  /**
   * Rule kinds that have actually run.
   *
   * A `Set` for membership and an ordered array for reporting: the reported list is emitted
   * in {@link ASSISTANCE_SUGGESTION_KINDS} declaration order rather than execution order,
   * so `evaluatedRuleKinds` is a property of the input and not of the code path that
   * happened to reach a rule first.
   */
  readonly executed: Set<AssistanceSuggestionKind>;
}

type AssistanceRule = (context: RuleContext) => readonly AssistanceCandidate[];

/**
 * Separator between a suggestion's `kind` and its `targetId` in {@link AssistanceSuggestion.suggestionId}.
 *
 * A newline cannot occur in an app-minted room id or in a kebab-case kind, so two
 * different `(kind, target)` pairs cannot produce one identity - which is what makes the
 * identity safe to de-duplicate on and safe to use as the final ranking tie-break.
 */
const SUGGESTION_ID_SEPARATOR = '\n';

/** The deterministic identity of a suggestion. See {@link SUGGESTION_ID_SEPARATOR}. */
export function suggestionIdentity(kind: AssistanceSuggestionKind, targetId: string): string {
  return `${kind}${SUGGESTION_ID_SEPARATOR}${targetId}`;
}

// ── Derived graph facts ──────────────────────────────────────────────────────

/** Sorted, de-duplicated room ids of a subject. */
function sortedRoomIds(subject: AssistanceSubjectInput): string[] {
  return [
    ...new Set(subject.rooms.map((room) => room.roomId).filter((id) => id.length > 0)),
  ].sort(compareCodeUnits);
}

/** The room record for an id, or `undefined`. */
function roomById(subject: AssistanceSubjectInput, roomId: string): AssistanceRoomInput | undefined {
  return subject.rooms.find((room) => room.roomId === roomId);
}

/**
 * Every room reachable from `roomId` by one edge, in either direction, de-duplicated and
 * sorted by code unit.
 *
 * Derived from `subject.edges` directly rather than through
 * `src/core/graph/navigation.ts`, for two reasons that both matter: that module's ordering
 * is a *display* order built with `localeCompare`, and its parent map folds several
 * `subtopic` edges into one parent, neither of which is the question this engine asks. Here
 * adjacency is a symmetric set with an explicit total order, which is what a
 * "related room" rule needs.
 */
function adjacentRoomIds(subject: AssistanceSubjectInput, roomId: string): string[] {
  const adjacent = new Set<string>();
  for (const edge of subject.edges) {
    if (edge.fromRoomId === roomId && edge.toRoomId !== roomId) adjacent.add(edge.toRoomId);
    if (edge.toRoomId === roomId && edge.fromRoomId !== roomId) adjacent.add(edge.fromRoomId);
  }
  return [...adjacent].sort(compareCodeUnits);
}

/**
 * True when *any* edge already relates two rooms, in either direction.
 *
 * "Relates", not "is of relation type X": a `subtopic` edge between two rooms is already a
 * relationship, so proposing a cross-link for them would be advising the learner to add a
 * second, redundant edge to a pair the graph has already decided about.
 */
function hasAnyEdge(subject: AssistanceSubjectInput, leftRoomId: string, rightRoomId: string): boolean {
  return subject.edges.some(
    (edge) =>
      (edge.fromRoomId === leftRoomId && edge.toRoomId === rightRoomId) ||
      (edge.fromRoomId === rightRoomId && edge.toRoomId === leftRoomId),
  );
}

/** Sorted tag names on a room, lower-cased by the caller that compares them. */
function normalizedTags(room: AssistanceRoomInput): string[] {
  return [
    ...new Set(
      room.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ].sort(compareCodeUnits);
}

/**
 * Rooms sharing at least one tag with `roomId`, excluding itself, de-duplicated and
 * sorted.
 *
 * A shared tag is graph structure the learner created, so it is an honest basis for
 * "these two rooms look related" - and it is the basis the plan's "graph structure and
 * related topics" names. It says nothing about *why* the tag was applied.
 */
function roomsSharingTags(subject: AssistanceSubjectInput, roomId: string): string[] {
  const room = roomById(subject, roomId);
  if (room === undefined) return [];
  const tags = new Set(normalizedTags(room));
  if (tags.size === 0) return [];
  const matches = new Set<string>();
  for (const candidate of sortedRoomIds(subject)) {
    if (candidate === roomId) continue;
    const other = roomById(subject, candidate);
    if (other === undefined) continue;
    for (const tag of normalizedTags(other)) {
      if (tags.has(tag)) {
        matches.add(candidate);
        break;
      }
    }
  }
  return [...matches].sort(compareCodeUnits);
}

/**
 * Rubric criteria the room's last validation scored zero, in
 * {@link QUALITY_SCORE_KEYS} declaration order.
 *
 * Iterates the app's closed criterion vocabulary rather than the room's own
 * `criterionScores` keys, for the same reason everything else here iterates a closed array:
 * object key order is insertion order, and a room built by two different code paths can
 * hold the same five scores in a different order. A rule that iterated the map and ranked
 * "first zero criterion" would then disagree with itself between those two rooms.
 */
function lowRubricCriteria(room: AssistanceRoomInput): string[] {
  const low: string[] = [];
  for (const criterion of QUALITY_SCORE_KEYS) {
    const score = room.criterionScores[criterion];
    if (typeof score === 'number' && score === 0) low.push(criterion);
  }
  return low;
}

/**
 * Required section names the deterministic validator reported missing, in
 * {@link REQUIRED_NOTE_SECTIONS} declaration order.
 *
 * Same closed-vocabulary reasoning as {@link lowRubricCriteria}: the room's stored
 * `missingSections` is an array whose order comes from the validator that wrote it, and a
 * suggestion that listed them in that order would leak validator iteration order into the
 * learner's UI. Filtering the app's declared list by membership keeps the order a property
 * of the code rather than of the data.
 */
function missingRequiredSections(room: AssistanceRoomInput): string[] {
  const stored = new Set(
    room.missingSections.filter((section): section is string => typeof section === 'string'),
  );
  return REQUIRED_NOTE_SECTIONS.filter((section) => stored.has(section));
}

// ── Rules ────────────────────────────────────────────────────────────────────

/**
 * **Creator: the root room has no branch.**
 *
 * A subject whose root room has no outgoing `subtopic` edge has a one-room graph, and the
 * plan's Creator deliverable is "suggestions for missing branches". Purely structural, so
 * it reads no signal and is therefore available from the first study session - a learner
 * with no history has nothing else to be told, and inventing urgency from an empty signal
 * map would be dishonest.
 *
 * `targetId` is the subject id rather than a room id: the thing to fix is the subject, and
 * two of a learner's subjects each missing a branch must produce two distinguishable
 * suggestions rather than one.
 */
const creatorMissingBranchRule: AssistanceRule = (context) => {
  context.executed.add('creator.missing-branch');
  const candidates: AssistanceCandidate[] = [];
  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    const hasBranch = subject.edges.some(
      (edge) => edge.fromRoomId === subject.rootRoomId && edge.relationType === 'subtopic',
    );
    if (hasBranch) continue;
    const isBare = subject.rooms.length <= 1;
    candidates.push({
      kind: 'creator.missing-branch',
      surface: 'creator',
      targetId: subject.subjectId,
      // A one-room subject is the clearer case and outranks a larger graph whose root
      // simply has not been expanded yet.
      priority: clampPriority(AssistancePriority.structural + (isBare ? 10 : 0)),
      reasonCode: 'graph-no-branch',
      signalKey: null,
      signalValue: 0,
      actionKind: 'offer-navigation',
      actionRoomId: subject.rootRoomId.length > 0 ? subject.rootRoomId : null,
      actionDetail: null,
    });
  }
  return candidates;
};

/**
 * **Creator: two rooms share a tag and no edge relates them.**
 *
 * The plan's "meaningful cross-links". "Meaningful" is doing real work in that sentence, so
 * this rule needs a *stated* basis for "related" and it uses the learner's own tags - which
 * they applied deliberately - rather than a string similarity over topics, which would be
 * both a locale-sensitive comparison and an inference about content.
 *
 * One candidate per **subject**, naming the lexicographically first unlinked pair, rather
 * than one per pair: a subject with forty rooms sharing a tag would otherwise produce
 * hundreds of near-identical suggestions, and a ranked list of duplicates is not assistance.
 * `actionDetail` names the target room so a surface can offer a concrete link.
 */
const creatorCrossLinkRule: AssistanceRule = (context) => {
  context.executed.add('creator.cross-link');
  const candidates: AssistanceCandidate[] = [];
  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    const roomIds = sortedRoomIds(subject);
    let firstPair: readonly [string, string] | null = null;
    for (let index = 0; index < roomIds.length && firstPair === null; index += 1) {
      for (const other of roomsSharingTags(subject, roomIds[index])) {
        if (hasAnyEdge(subject, roomIds[index], other)) continue;
        firstPair = [roomIds[index], other];
        break;
      }
    }
    if (firstPair === null) continue;
    candidates.push({
      kind: 'creator.cross-link',
      surface: 'creator',
      targetId: subject.subjectId,
      priority: clampPriority(AssistancePriority.structural),
      reasonCode: 'graph-related-tag-unlinked',
      signalKey: null,
      signalValue: 0,
      actionKind: 'offer-cross-link',
      actionRoomId: firstPair[0],
      actionDetail: firstPair[1],
    });
  }
  return candidates;
};

/**
 * **Scribe: the deterministic validator named missing required sections.**
 *
 * The plan's "section scaffolds" and "progressively stronger rubric hints", driven by the
 * strongest signal the plan permits: *failed note-validation criteria*.
 *
 * It reads the validator's own `failedChecks`/`missingSections` and re-presents them. It
 * does **not** re-evaluate the note, does not relax a criterion, and does not fill a
 * section - a scaffold is an offer of headings, and the words in them are the learner's to
 * write. The priority bump from the persisted `repeatedDraft` count is what makes the cue
 * *progressively stronger*, and it is the only thing in the engine that does: a learner who
 * has re-saved the same failing note three times gets a stronger cue, not a different
 * suggestion.
 *
 * Because the rule reads the validator's stored output rather than the note, it cannot
 * produce a scaffold for a section the validator did not report - which is exactly the
 * property that keeps it from becoming a way to auto-complete a note.
 */
const scribeMissingSectionRule: AssistanceRule = (context) => {
  context.executed.add('scribe.missing-section');
  const candidates: AssistanceCandidate[] = [];
  const repeatedDrafts = context.signals.repeatedDraft;
  const draftBonus =
    AssistancePriorityIncrement.extraRepeatedDraft *
    cappedCount(repeatedDrafts, AssistancePriorityCap.extraRepeatedDraft);

  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    for (const roomId of sortedRoomIds(subject)) {
      const room = roomById(subject, roomId);
      if (room === undefined || room.finalPass) continue;
      const missing = missingRequiredSections(room);
      const failed = room.failedChecks.filter(
        (check): check is string => typeof check === 'string' && check.length > 0,
      );
      // Two reasons to speak, and one reason not to. A room with neither a named missing
      // section nor a named blocking failure has no evidence this rule may act on - its
      // rubric scores being low is `scribe.rubric-hint`'s business, and duplicating it here
      // would produce two suggestions about one room's one note.
      if (missing.length === 0 && failed.length === 0) continue;
      const priority = clampPriority(
        AssistancePriority.missingSection +
          AssistancePriorityIncrement.extraMissingSection *
            cappedCount(missing.length - 1, AssistancePriorityCap.extraMissingSection) +
          AssistancePriorityIncrement.extraFailedCheck *
            cappedCount(failed.length - 1, AssistancePriorityCap.extraFailedCheck) +
          draftBonus,
      );
      candidates.push({
        kind: 'scribe.missing-section',
        surface: 'scribe',
        targetId: roomId,
        priority,
        // `missing.length > 0` is exactly the case where the caller held the live validator
        // output, and therefore the only case where naming a section is honest. See
        // `toAssistanceRoom`'s header for why this is not inferred from a boolean.
        reasonCode: missing.length > 0 ? 'note-missing-required-section' : 'note-validation-failed',
        // The signal that made the cue *stronger*, named so the explanation can show it.
        signalKey: repeatedDrafts > 0 ? 'repeatedDraft' : 'noteValidationFailure',
        signalValue: repeatedDrafts > 0 ? repeatedDrafts : context.signals.noteValidationFailure,
        actionKind: 'offer-section-scaffold',
        actionRoomId: roomId,
        // The first missing section in the app's declared order - a name from
        // `REQUIRED_NOTE_SECTIONS`, never text from the note. `null` when the section is
        // unknown, which the surface renders as a generic scaffold offer.
        actionDetail: missing.length > 0 ? missing[0] : null,
      });
    }
  }
  return candidates;
};

/**
 * **Scribe: the note scored zero on cross-references and the room has somewhere to point at.**
 *
 * The plan's "related-topic links". The evidence is the room's own `linkReferences` rubric
 * score - a number the deterministic validator already computed - plus the existence of at
 * least one adjacent room. The rule never reads the note to decide whether a link is
 * *missing*, because that question can only be answered by reading the learner's prose, and
 * an engine that read prose could leak it.
 *
 * The trade is named rather than hidden: this can suggest linking when the note does in
 * fact reference an adjacent room's name but scored zero for another reason. That produces
 * an advisory the learner can dismiss, and it is strictly better than the alternative,
 * which is a suggestion that depends on the learner's sentences.
 *
 * ## Why this rule suppresses nothing, and that is deliberate
 *
 * `scribeRubricHintRule` skips a room that `scribeMissingSectionRule` already claimed, on the
 * grounds that "two suggestions about one room's one failing note is one too many". This
 * rule applies no such skip, so a room with a missing required section *and* a zero
 * `linkReferences` score gets two cards - `scribe.missing-section` **and**
 * `scribe.related-topic` - and a room with a failing rubric and no missing section gets
 * `scribe.related-topic` **and** `scribe.rubric-hint`. That asymmetry was an undocumented,
 * unpinned accident until an attack measured it and asked which of the two was the intent.
 *
 * The intent, decided here and on the evidence rather than by symmetry, is that the co-firing
 * is **intended**: this rule's claim is a different claim.
 *
 * | Rule | Claim | Basis |
 * | --- | --- | --- |
 * | `scribe.missing-section` | "this note is incomplete" | the validator's named missing sections / blocking failures |
 * | `scribe.rubric-hint` | "this note is thin, here is the weakest criterion" | a rubric score of `0` |
 * | `scribe.related-topic` | "your graph has a link this note is not making" | a zero `linkReferences` score **and** an adjacent room that exists |
 *
 * `missing-section` and `rubric-hint` are two readings of one note's quality, so the second
 * one standing adds nothing. `related-topic` is half a claim about the **graph** - "there is
 * a room next door and your note does not point at it" - and that half stays true however the
 * note's prose is fixed. Suppressing it would mean: a learner who writes the missing Summary
 * section but still never links the adjacent room would silently stop being told about the
 * adjacent room, because the fix for an unrelated defect had silenced this rule. The cost of
 * co-firing is one extra dismissible card in a list that is already ranked and capped by the
 * mode policy; the cost of suppressing is a fact that disappears.
 *
 * Both rules are keyed on `targetId`, so this is deterministic, and the behaviour is pinned as
 * an assertion in `tests/unit/assistanceEngine.test.ts` ("two scribe rules fire on one room")
 * rather than left as a comment nobody can check. Changing it is a deliberate change.
 */
const scribeRelatedTopicRule: AssistanceRule = (context) => {
  context.executed.add('scribe.related-topic');
  const candidates: AssistanceCandidate[] = [];
  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    for (const roomId of sortedRoomIds(subject)) {
      const room = roomById(subject, roomId);
      if (room === undefined || room.finalPass) continue;
      const linkScore = room.criterionScores.linkReferences;
      if (typeof linkScore !== 'number' || linkScore > 0) continue;
      const adjacent = adjacentRoomIds(subject, roomId);
      if (adjacent.length === 0) continue;
      candidates.push({
        kind: 'scribe.related-topic',
        surface: 'scribe',
        targetId: roomId,
        priority: clampPriority(AssistancePriority.structural),
        reasonCode: 'note-adjacent-room-unreferenced',
        signalKey: null,
        signalValue: 0,
        actionKind: 'offer-cross-link',
        actionRoomId: roomId,
        actionDetail: adjacent[0],
      });
    }
  }
  return candidates;
};

/**
 * **Scribe: a rubric criterion is scored zero.**
 *
 * The "progressively stronger rubric hints" half. Reads the *scores* the deterministic
 * validator assigned, never the note, and names the criterion by its app-owned key - so the
 * hint can say "concept term coverage scored zero" and cannot say what concept the learner
 * was missing.
 *
 * A room that already has a {@link scribeMissingSectionRule} candidate is skipped: two
 * suggestions about one room's one failing note is one too many, and the section scaffold
 * is the more actionable of the two. The skip is on `targetId`, which is deterministic.
 *
 * {@link scribeRelatedTopicRule} deliberately does **not** apply the same skip, and its own
 * header says why in a table: this rule and `scribeMissingSectionRule` are two readings of one
 * note's quality, while `scribe.related-topic` is a claim about a room that exists next
 * door. The two rules are asymmetric on purpose, and the comment here is the other half of
 * that decision so neither reads as an oversight.
 */
const scribeRubricHintRule: AssistanceRule = (context) => {
  context.executed.add('scribe.rubric-hint');
  const candidates: AssistanceCandidate[] = [];
  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    for (const roomId of sortedRoomIds(subject)) {
      const room = roomById(subject, roomId);
      if (room === undefined || room.finalPass) continue;
      const low = lowRubricCriteria(room);
      if (low.length === 0) continue;
      // A room whose section or blocking failure is already being scaffolded is skipped:
      // two suggestions about one room's one failing note is one too many, and the scaffold
      // is the more actionable of the two. The skip is on `targetId`, which is deterministic.
      if (missingRequiredSections(room).length > 0) continue;
      if (room.failedChecks.length > 0) continue;
      candidates.push({
        kind: 'scribe.rubric-hint',
        surface: 'scribe',
        targetId: roomId,
        priority: clampPriority(
          AssistancePriority.rubricLow +
            AssistancePriorityIncrement.extraRubricCriterion *
              cappedCount(low.length - 1, AssistancePriorityCap.extraRubricCriterion) +
            (context.signals.repeatedDraft > 0
              ? AssistancePriorityIncrement.extraRepeatedDraft *
                cappedCount(context.signals.repeatedDraft, AssistancePriorityCap.extraRepeatedDraft)
              : 0),
        ),
        reasonCode: 'note-rubric-criterion-low',
        signalKey: context.signals.repeatedDraft > 0 ? 'repeatedDraft' : 'noteValidationFailure',
        signalValue:
          context.signals.repeatedDraft > 0
            ? context.signals.repeatedDraft
            : context.signals.noteValidationFailure,
        actionKind: 'offer-hint',
        actionRoomId: roomId,
        actionDetail: low[0],
      });
    }
  }
  return candidates;
};

/**
 * **Archaeologist: a room is due, or overdue.**
 *
 * The plan's "prioritization for due rooms". Reads the room's SM-2 `nextReviewDate` and
 * compares it to the injected `nowIso` in UTC epoch arithmetic - see the module header for
 * why this is deliberately not the local calendar.
 *
 * `targetId` is the room, because the suggestion is about a room. The priority is monotone
 * in how overdue the room is (capped), which makes "more overdue ranks higher" a property
 * of the score rather than of the sort, and means a learner can be told *why* one room
 * outranks another.
 */
const archaeologistDueRoomRule: AssistanceRule = (context) => {
  context.executed.add('archaeologist.due-room');
  const candidates: AssistanceCandidate[] = [];
  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    for (const roomId of sortedRoomIds(subject)) {
      const room = roomById(subject, roomId);
      if (room === undefined || room.sm2NextReviewDate === null) continue;
      const until = daysUntilDue(room.sm2NextReviewDate, context.nowIso);
      if (until === null || until > 0) continue;
      const overdue = -until;
      candidates.push({
        kind: 'archaeologist.due-room',
        surface: 'archaeologist',
        targetId: roomId,
        priority: clampPriority(
          AssistancePriority.reviewDue +
            AssistancePriorityIncrement.extraUnlinkedRoom *
              cappedCount(Math.floor(overdue / 7), AssistancePriorityCap.extraUnlinkedRoom),
        ),
        reasonCode: 'review-due',
        signalKey: null,
        signalValue: overdue,
        actionKind: 'offer-prioritisation',
        actionRoomId: roomId,
        actionDetail: null,
      });
    }
  }
  return candidates;
};

/**
 * **Archaeologist: the room's last recall rating was below the pass threshold.**
 *
 * The plan's "adjusted retrieval prompts after low recall", and its clearest reading of
 * "recall ratings" from the permitted list.
 *
 * The threshold is SM-2's own: `updateSm2State` treats `quality < 3` as a reset of the
 * interval and the consecutive-correct counter, so `3` is where "the learner did not
 * recall this" begins *by the deterministic algorithm's own definition*. Reading that
 * threshold from SM-2's semantics rather than inventing one is what keeps this suggestion
 * from contradicting the review schedule the learner can see.
 *
 * The persisted `lowRecallRating` count is added as corroboration, so a room rated low once
 * and a room rated low five times produce different priorities - a count of a real event,
 * never a trait, and never a statement about ability.
 */
const archaeologistLowRecallRule: AssistanceRule = (context) => {
  context.executed.add('archaeologist.low-recall');
  const candidates: AssistanceCandidate[] = [];
  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    for (const roomId of sortedRoomIds(subject)) {
      const room = roomById(subject, roomId);
      if (room === undefined || room.sm2QualityResponse === null) continue;
      if (room.sm2QualityResponse >= LOW_RECALL_QUALITY_THRESHOLD) continue;
      candidates.push({
        kind: 'archaeologist.low-recall',
        surface: 'archaeologist',
        targetId: roomId,
        priority: clampPriority(
          AssistancePriority.lowRecall +
            AssistancePriorityIncrement.extraRubricCriterion *
              cappedCount(
                Math.max(0, LOW_RECALL_QUALITY_THRESHOLD - 1 - room.sm2QualityResponse),
                AssistancePriorityCap.extraRubricCriterion,
              ),
        ),
        reasonCode: 'review-low-recall',
        signalKey: 'lowRecallRating',
        signalValue: context.signals.lowRecallRating,
        actionKind: 'offer-hint',
        actionRoomId: roomId,
        actionDetail: null,
      });
    }
  }
  return candidates;
};

/**
 * **Fishing: navigate back to the room whose recall question was missed.**
 *
 * The plan's "guidance and navigation after a missed recall question", and the one
 * suggestion whose target comes from a *runtime event* rather than from stored graph state.
 *
 * Two conditions, both required:
 *
 * 1. the caller passed a `fishing` context naming a missed room, and that room exists in
 *    the subject the context names. The subject check is what keeps a fishing suggestion
 *    from navigating into a different subject's graph - plan 5.3's
 *    "fishing eligibility, recall selection, and persistence may use different subject
 *    contexts", and Phase 17's fix for it. A context naming a room this device does not
 *    hold produces no suggestion rather than a link to nowhere.
 * 2. the persisted `fishingRecallMiss` count is at least one. Without a recorded miss there
 *    is nothing to navigate away from, and a navigation offer would be unfounded.
 *
 * `actionRoomId` is the navigation target. Nothing here navigates.
 */
const fishingNavigationRule: AssistanceRule = (context) => {
  context.executed.add('fishing.navigation-after-miss');
  const fishing = context.fishing;
  if (fishing === null) return [];
  if (fishing.lastMissedRoomId === null || fishing.lastMissedRoomId.length === 0) return [];
  if (context.signals.fishingRecallMiss < 1) return [];
  const subject = context.subjects.find(
    (candidate) => candidate.subjectId === fishing.subjectId,
  );
  if (subject === undefined) return [];
  const room = roomById(subject, fishing.lastMissedRoomId);
  if (room === undefined) return [];
  return [
    {
      kind: 'fishing.navigation-after-miss',
      surface: 'fishing',
      targetId: fishing.lastMissedRoomId,
      priority: clampPriority(
        AssistancePriority.fishingMiss +
          AssistancePriorityIncrement.extraFishingMiss *
            cappedCount(
              fishing.missedThisVisit - 1,
              AssistancePriorityCap.extraFishingMiss,
            ),
      ),
      reasonCode: 'fishing-recall-missed',
      signalKey: 'fishingRecallMiss',
      signalValue: context.signals.fishingRecallMiss,
      actionKind: 'offer-navigation',
      actionRoomId: fishing.lastMissedRoomId,
      actionDetail: null,
    },
  ];
};

/**
 * **Device: at least one room in the subject is due for review.**
 *
 * The plan's "review due dates" in its aggregate form, and the only suggestion with no room
 * target.
 *
 * The Standard-mode condition is worth stating because it is the one place the engine reads
 * the *study* aggregate to decide whether to speak at all: Standard speaks only once the
 * learner has cleared at least one room, because until then "reviews are due" is a statement
 * about an empty schedule. Gentle speaks regardless, which is what "more generous timing"
 * means. `evidence.active-study-days` and `evidence.rooms-cleared` come along as evidence so
 * the learner sees the aggregate the claim rests on.
 */
const deviceReviewsDueRule: AssistanceRule = (context) => {
  context.executed.add('device.due-today');
  if (context.mode === 'standard') {
    if (context.study === null || context.study.roomsCleared < 1) return [];
  }
  const candidates: AssistanceCandidate[] = [];
  for (const subject of [...context.subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    let dueRooms = 0;
    let overdueRooms = 0;
    for (const roomId of sortedRoomIds(subject)) {
      const room = roomById(subject, roomId);
      if (room === undefined || room.sm2NextReviewDate === null) continue;
      const until = daysUntilDue(room.sm2NextReviewDate, context.nowIso);
      if (until === null || until > 0) continue;
      dueRooms += 1;
      if (until < 0) overdueRooms += 1;
    }
    if (dueRooms === 0) continue;
    candidates.push({
      kind: 'device.due-today',
      surface: 'device',
      targetId: subject.subjectId,
      priority: clampPriority(
        AssistancePriority.deviceReviewsDue +
          AssistancePriorityIncrement.extraDueRoom *
            cappedCount(dueRooms - 1, AssistancePriorityCap.extraDueRoom) +
          // Overdue rooms rank above merely-due ones, and the bump is per overdue room so
          // "how far behind is this subject" is a property of the score rather than of the
          // sort. Same increment weight as an extra due room: the two counts are the same
          // kind of fact, and weighting them differently would be a taste decision dressed
          // as a rule.
          AssistancePriorityIncrement.extraDueRoom *
            cappedCount(overdueRooms, AssistancePriorityCap.extraDueRoom),
      ),
      reasonCode: 'device-reviews-due',
      signalKey: null,
      signalValue: dueRooms,
      actionKind: 'offer-prioritisation',
      actionRoomId: null,
      actionDetail: null,
    });
  }
  return candidates;
};

/**
 * Every rule, in a **fixed declaration order**.
 *
 * The order is a property of the module, not of the input, and it is the order in which
 * candidates are collected before de-duplication. Since de-duplication keeps the
 * higher-priority candidate and, at equal priority, the first seen, a rule's position in
 * this array is load-bearing for ties - which is precisely why the array is a literal here
 * rather than, say, an `Object.entries` over a rule map.
 */
const RULES: readonly AssistanceRule[] = Object.freeze([
  scribeMissingSectionRule,
  scribeRubricHintRule,
  scribeRelatedTopicRule,
  archaeologistDueRoomRule,
  archaeologistLowRecallRule,
  fishingNavigationRule,
  deviceReviewsDueRule,
  creatorMissingBranchRule,
  creatorCrossLinkRule,
]);

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Total order over suggestions: priority descending, then `kind`, then `targetId`.
 *
 * Three keys, and **no ties are possible**: `suggestionId` is
 * `kind + '\n' + targetId`, candidates are de-duplicated by it, so two entries that tie on
 * `kind` and `targetId` are the same entry. That is what lets this comparator omit a
 * final tie-break and still be total - and omitting it is deliberate, because
 * `Array.prototype.sort`'s stability (specified from ES2019, but still an implementation
 * detail a reader may not know) would otherwise become the thing that decides the output,
 * and the *input* order would leak into the result.
 *
 * Every comparison is by code unit, never by locale collation; see the module header for the
 * ICU argument.
 */
export function compareAssistanceSuggestions(
  left: AssistanceSuggestion,
  right: AssistanceSuggestion,
): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  const byKind = compareCodeUnits(left.kind, right.kind);
  if (byKind !== 0) return byKind;
  return compareCodeUnits(left.targetId, right.targetId);
}

/**
 * Run every rule, de-duplicate, rank, and truncate to the mode's limit.
 *
 * The single place a suggestion becomes a frozen {@link AssistanceSuggestion}. Every field
 * comes from a candidate and the mode policy; nothing is read from ambient state, and
 * nothing is formatted.
 */
export function rankProactiveAssistance(
  input: ProactiveAssistanceEngineInput,
): AssistanceResult {
  // Defence in depth for a caller the type system could not stop - a `as never` cast, a
  // value out of `localStorage`, a `postMessage`. The *type* is the guarantee; this is the
  // assertion that the guarantee is not resting on the type alone.
  if ((input.mode as string) === 'off') {
    throw new Error(
      'rankProactiveAssistance was called with mode "off". Off mode must be handled by ' +
        'rankAssistance, which returns before any rule runs.',
    );
  }

  const policy = MODE_POLICY[input.mode];
  const executed = new Set<AssistanceSuggestionKind>();
  const context: RuleContext = {
    mode: input.mode,
    signals: resolveAssistanceSignals(input.signals),
    subjects: input.subjects,
    nowIso: input.nowIso,
    study: input.study ?? null,
    fishing: input.fishing ?? null,
    executed,
  };

  /** De-duplicated by identity, keeping the higher priority and then the first seen. */
  const byId = new Map<string, AssistanceCandidate>();
  for (const rule of RULES) {
    for (const candidate of rule(context)) {
      const id = suggestionIdentity(candidate.kind, candidate.targetId);
      const existing = byId.get(id);
      if (existing === undefined) {
        byId.set(id, candidate);
        continue;
      }
      if (candidate.priority > existing.priority) byId.set(id, candidate);
    }
  }

  const suggestions: AssistanceSuggestion[] = [];
  for (const [id, candidate] of byId) {
    const priority = clampPriority(candidate.priority);
    if (priority < policy.minimumPriority) continue;
    const action: AssistanceAction = Object.freeze({
      kind: candidate.actionKind,
      subjectId:
        candidate.actionRoomId === null
          ? candidate.targetId
          : findSubjectIdForRoom(input.subjects, candidate.actionRoomId),
      roomId: candidate.actionRoomId,
      detail: candidate.actionDetail,
    });
    suggestions.push(
      Object.freeze({
        suggestionId: id,
        kind: candidate.kind,
        surface: candidate.surface,
        targetId: candidate.targetId,
        priority,
        reasonCode: candidate.reasonCode,
        signalKey: candidate.signalKey,
        signalValue: candidate.signalValue,
        intensity: intensityFor(input.mode, priority),
        action,
      }),
    );
  }

  suggestions.sort(compareAssistanceSuggestions);
  const ranked = suggestions.slice(0, policy.limit);

  return Object.freeze({
    mode: input.mode,
    suggestions: Object.freeze(ranked),
    emptyReason: ranked.length === 0 ? ('no-suggestions' as AssistanceEmptyReason) : null,
    evaluatedRuleKinds: Object.freeze(reportExecutedRules(executed)),
  });
}

/**
 * The rule kinds that ran, in {@link ASSISTANCE_SUGGESTION_KINDS} declaration order.
 *
 * Never in execution order and never in `Set` insertion order: both would make the field a
 * property of which rule reached a candidate first, which is exactly the kind of leak this
 * module is built to avoid. In `off` mode the set is empty and this returns `[]`, which is
 * the observable half of the structural off-mode guarantee.
 */
function reportExecutedRules(executed: ReadonlySet<AssistanceSuggestionKind>): AssistanceSuggestionKind[] {
  return ASSISTANCE_SUGGESTION_KINDS.filter((kind) => executed.has(kind));
}

/**
 * The subject that owns a room id, or `''`.
 *
 * A room id is unique within a subject and the caller is expected to pass one subject graph
 * at a time to the flows that own rooms, so this is a lookup, not a search across the
 * device. But it *is* a search when two subjects happen to hold the same room id, and the
 * answer must not then be a property of the caller's array order - the same reason every
 * rule in this module sorts a copy of `subjects` by `subjectId` before reading it.
 *
 * **This used to return the first match in the caller's order**, so `[subject-aaa,
 * subject-zzz]` and `[subject-zzz, subject-aaa]` produced different `action.subjectId` for
 * the same state: an output field a surface renders and a dismissal is recorded against.
 * The shipping id factory mints room ids uniquely per device, which is why that was MEDIUM
 * and not HIGH, and why it survived a mutation probe aimed at the array order - the probe
 * measured a number that did not move. The order dependence was real, and a comment in this
 * file claimed a gate for it that did not exist; both the sort and the gate are here now,
 * and `tests/phase19/assistanceDeterminism.test.ts` pins the multi-subject case explicitly.
 *
 * The tie-break is the code-unit-first `subjectId`, chosen over "first wins" because a
 * stable, stated tie-break produces the same bytes on every device and the same bytes after
 * any reordering of the input.
 */
function findSubjectIdForRoom(
  subjects: readonly AssistanceSubjectInput[],
  roomId: string,
): string {
  for (const subject of [...subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    if (subject.rooms.some((room) => room.roomId === roomId)) return subject.subjectId;
  }
  return '';
}

/**
 * The engine's single entry point. Accepts a raw mode, including `off`.
 *
 * ## The three exits, in order
 *
 * 1. **`flagEnabled: false`** - the Phase 19 rollback. Returns before reading `mode`, so a
 *    build with the flag off reports `flag-disabled` whatever mode is stored, and stored
 *    records are left exactly as they are (nothing here writes).
 * 2. **`mode: 'off'`** - returns *before any rule is constructed or called*.
 *    `evaluatedRuleKinds` is therefore empty, and that is the claim a test asserts.
 * 3. **otherwise** - delegates to {@link rankProactiveAssistance}, whose input type cannot
 *    carry `off`.
 *
 * The narrowing in step 3 uses {@link proactiveModeFor}-equivalent logic inline rather than
 * calling it, so there is no value conversion between the two functions at all: `off` is
 * handled by returning, and everything that reaches the proactive half is provably not
 * `off`.
 */
export function rankAssistance(input: AssistanceEngineInput): AssistanceResult {
  if (!input.flagEnabled) {
    return Object.freeze({
      mode: input.mode,
      suggestions: Object.freeze([] as AssistanceSuggestion[]),
      emptyReason: 'flag-disabled' as AssistanceEmptyReason,
      evaluatedRuleKinds: Object.freeze([] as AssistanceSuggestionKind[]),
    });
  }
  if (input.mode === 'off') {
    return Object.freeze({
      mode: 'off' as AssistanceMode,
      suggestions: Object.freeze([] as AssistanceSuggestion[]),
      emptyReason: 'mode-off' as AssistanceEmptyReason,
      evaluatedRuleKinds: Object.freeze([] as AssistanceSuggestionKind[]),
    });
  }
  return rankProactiveAssistance({ ...input, mode: input.mode });
}

// ── Signal collection ────────────────────────────────────────────────────────

/**
 * Assemble the signal map a caller should persist, from live state over the stored map.
 *
 * Two of the four counters are re-derivable from the subject inputs and one is not:
 *
 * | Signal | Live derivation | Stored counter |
 * | --- | --- | --- |
 * | `noteValidationFailure` | Rooms whose stored validator output has a blocking failure, **plus** the stored total | `max(derived, stored)` |
 * | `lowRecallRating` | Rooms whose last SM-2 rating is below the pass threshold, plus the stored total | `max(derived, stored)` |
 * | `repeatedDraft` | None - no per-room draft history exists in any record | stored only |
 * | `fishingRecallMiss` | None - the statistics ledger records *kept* catches only | stored only |
 *
 * `max(derived, stored)` rather than `derived`, and the reason is a counter, not a
 * history: the live derivation counts what is *currently* true, while the stored counter
 * counts what has *happened*. A learner who fixed a room still has that room's failure in
 * their history, and a signal that forgot it would make assistance weaker every time they
 * succeeded - a perverse incentive. Taking the larger of the two keeps the cue monotone in
 * the learner's history while never inventing a count the device did not record.
 *
 * Returns a **new** map: the input is never mutated, so a caller can compare before and
 * after and a test can assert the pure-function property directly.
 */
export function collectAssistanceSignals(
  input: {
    readonly subjects: readonly AssistanceSubjectInput[];
    readonly stored: AssistanceSignals | null | undefined;
  },
): Record<string, number> {
  const stored = resolveAssistanceSignals(input.stored);
  let derivedValidationFailures = 0;
  let derivedLowRecall = 0;
  for (const subject of input.subjects) {
    for (const roomId of sortedRoomIds(subject)) {
      const room = roomById(subject, roomId);
      if (room === undefined) continue;
      if (room.failedChecks.length > 0) derivedValidationFailures += 1;
      if (
        room.sm2QualityResponse !== null &&
        room.sm2QualityResponse < LOW_RECALL_QUALITY_THRESHOLD
      ) {
        derivedLowRecall += 1;
      }
    }
  }
  return {
    noteValidationFailure: Math.max(derivedValidationFailures, stored.noteValidationFailure),
    lowRecallRating: Math.max(derivedLowRecall, stored.lowRecallRating),
    repeatedDraft: stored.repeatedDraft,
    fishingRecallMiss: stored.fishingRecallMiss,
  };
}

// ── Explanation ──────────────────────────────────────────────────────────────

/** What {@link explainAssistanceSuggestion} reads besides the suggestion itself. */
export interface AssistanceExplanationInput {
  readonly subjects: readonly AssistanceSubjectInput[];
  readonly signals: AssistanceSignals | null | undefined;
  readonly study?: AssistanceStudyInput;
  readonly nowIso: string;
}

/**
 * Why one suggestion appeared, as i18n keys plus counted evidence.
 *
 * ## Pure derivation, and why that is the feature
 *
 * `AssistanceRecordValue.signals` is a `Record<string, number>`, so an explanation
 * **cannot be stored** - there is no field for it, and no migration would create one. That
 * constraint is the reason the determinism criterion is provable rather than merely
 * asserted: an explanation is recomputed from `(suggestion, input)` every time it is shown,
 * so it cannot go stale, cannot disagree with the suggestion it explains, and cannot
 * differ between two devices holding the same state. There is no stored sentence anywhere
 * to invalidate.
 *
 * ## Why it emits keys and never a sentence
 *
 * `titleKey` and `detailKey` are i18n keys. An engine that produced English prose would
 * need a locale, and a locale is a source of nondeterminism this module is trying to have
 * none of; it would also mean translating in two places. Keys move that decision to the
 * surface, where a locale already exists.
 *
 * `evidence` rows are `{ labelKey, value, roomId, subjectId }` - a count, a key, and
 * app-minted ids. A surface composes the sentence; the engine holds no text at all.
 *
 * Evidence rows are emitted sorted by `labelKey` code unit, then `roomId`, then
 * `subjectId`, so two devices produce the same row order and a test can compare the whole
 * explanation with `toEqual`.
 */
export function explainAssistanceSuggestion(
  suggestion: AssistanceSuggestion,
  input: AssistanceExplanationInput,
): AssistanceExplanation {
  const signals = resolveAssistanceSignals(input.signals);
  const evidence: AssistanceEvidence[] = [];
  const subjectId = suggestion.action.subjectId;
  const subject =
    subjectId.length > 0
      ? input.subjects.find((candidate) => candidate.subjectId === subjectId)
      : undefined;
  const room =
    subject !== undefined && suggestion.targetId.length > 0
      ? roomById(subject, suggestion.targetId)
      : undefined;

  const push = (
    labelKey: AssistanceEvidenceKey,
    value: number,
    scope: { roomId: string | null; subjectId: string | null },
  ): void => {
    if (!Number.isFinite(value) || value <= 0) return;
    evidence.push({ labelKey, value: Math.trunc(value), roomId: scope.roomId, subjectId: scope.subjectId });
  };

  switch (suggestion.reasonCode) {
    case 'graph-no-branch': {
      // The room count **in this subject**, not a clear count and not a hardcoded `1`.
      //
      // This arm used to publish `evidence.rooms-cleared` with a literal `1`, which claimed a
      // learner had cleared a room on a subject that may have five rooms and no study history
      // at all. The honest evidence for a purely structural observation is the size of the
      // graph it is about: "your subject has 5 rooms and none of them branch off the root" is
      // the fact that makes the suggestion worth acting on, and it is a fact about rooms
      // *existing*. `sortedRoomIds` rather than `subject.rooms.length`, so this counts the same
      // way every other arm in this switch does - de-duplicated, and skipping an empty id.
      //
      // `subject === undefined` publishes nothing rather than a `0`: a row is a claim, and the
      // engine will not make one it cannot source.
      const roomCount = subject === undefined ? 0 : sortedRoomIds(subject).length;
      push('evidence.subject-rooms', roomCount, { roomId: null, subjectId: suggestion.targetId });
      break;
    }
    case 'graph-related-tag-unlinked':
      push('evidence.unlinked-related-rooms', 1, {
        roomId: suggestion.action.roomId,
        subjectId,
      });
      break;
    case 'note-missing-required-section': {
      const missing = room === undefined ? [] : missingRequiredSections(room);
      push('evidence.missing-sections', missing.length, {
        roomId: suggestion.targetId,
        subjectId,
      });
      if (missing.length === 0 && suggestion.action.detail !== null) {
        push('evidence.missing-sections', 1, { roomId: suggestion.targetId, subjectId });
      }
      push('evidence.failed-checks', room === undefined ? 0 : room.failedChecks.length, {
        roomId: suggestion.targetId,
        subjectId,
      });
      push('evidence.repeated-drafts', signals.repeatedDraft, {
        roomId: null,
        subjectId: null,
      });
      break;
    }
    case 'note-validation-failed':
      push('evidence.failed-checks', room === undefined ? 0 : room.failedChecks.length, {
        roomId: suggestion.targetId,
        subjectId,
      });
      // The section is not named (the caller had only the persisted boolean), so the only
      // corroboration available is the repeated-draft count that strengthened the cue.
      push('evidence.repeated-drafts', signals.repeatedDraft, {
        roomId: null,
        subjectId: null,
      });
      break;
    case 'note-adjacent-room-unreferenced':
      push('evidence.low-rubric-criteria', 1, { roomId: suggestion.targetId, subjectId });
      push('evidence.unlinked-related-rooms', 1, {
        roomId: suggestion.targetId,
        subjectId,
      });
      break;
    case 'note-rubric-criterion-low':
      push('evidence.low-rubric-criteria', room === undefined ? 0 : lowRubricCriteria(room).length, {
        roomId: suggestion.targetId,
        subjectId,
      });
      push('evidence.repeated-drafts', signals.repeatedDraft, {
        roomId: null,
        subjectId: null,
      });
      break;
    case 'review-due': {
      const overdue =
        room === undefined ? 0 : daysOverdue(room.sm2NextReviewDate, input.nowIso);
      push('evidence.review-due-rooms', 1, { roomId: suggestion.targetId, subjectId });
      // **Days**, so `evidence.overdue-days`. This arm and `device-reviews-due` used to share
      // `evidence.overdue-rooms` while counting two different things - days here, rooms there -
      // which left no wording that was true under both. Split by unit; the key that keeps the
      // name is the one whose value is a count of rooms, which is the device arm.
      push('evidence.overdue-days', overdue, { roomId: suggestion.targetId, subjectId });
      break;
    }
    case 'review-low-recall':
      push('evidence.low-recall-ratings', Math.max(1, signals.lowRecallRating), {
        roomId: suggestion.targetId,
        subjectId,
      });
      break;
    case 'fishing-recall-missed':
      push('evidence.fishing-recall-misses', Math.max(1, signals.fishingRecallMiss), {
        roomId: suggestion.targetId,
        subjectId,
      });
      break;
    case 'device-reviews-due': {
      let dueRooms = 0;
      let overdueRooms = 0;
      if (subject !== undefined) {
        for (const roomId of sortedRoomIds(subject)) {
          const candidate = roomById(subject, roomId);
          if (candidate === undefined || candidate.sm2NextReviewDate === null) continue;
          const until = daysUntilDue(candidate.sm2NextReviewDate, input.nowIso);
          if (until === null || until > 0) continue;
          dueRooms += 1;
          if (until < 0) overdueRooms += 1;
        }
      }
      push('evidence.review-due-rooms', dueRooms, { roomId: null, subjectId: suggestion.targetId });
      // **Rooms**, so `evidence.overdue-rooms` - the unit its name states. This is the arm that
      // owns that key; `review-due` publishes `evidence.overdue-days` instead. Do not re-merge
      // them: the merge is what forced one label to be false on one of the two cards.
      push('evidence.overdue-rooms', overdueRooms, { roomId: null, subjectId: suggestion.targetId });
      push('evidence.active-study-days', input.study?.activeDays ?? 0, {
        roomId: null,
        subjectId: null,
      });
      push('evidence.rooms-cleared', input.study?.roomsCleared ?? 0, {
        roomId: null,
        subjectId: null,
      });
      break;
    }
    default:
      // Unreachable for a declared `AssistanceReasonCode`. Present so that adding a reason
      // code without an explanation arm is a **typecheck-visible** edit: the switch becomes
      // non-exhaustive and `noFallthroughCasesInSwitch` plus the explicit `default` block
      // make the omission a decision rather than a silent empty explanation.
      break;
  }

  evidence.sort(
    (left, right) =>
      compareCodeUnits(left.labelKey, right.labelKey) ||
      compareCodeUnits(left.roomId ?? '', right.roomId ?? '') ||
      compareCodeUnits(left.subjectId ?? '', right.subjectId ?? ''),
  );

  return Object.freeze({
    suggestionId: suggestion.suggestionId,
    titleKey: `assistance.title.${suggestion.kind}`,
    detailKey: `assistance.detail.${suggestion.reasonCode}`,
    evidence: Object.freeze(evidence),
    intensity: suggestion.intensity,
  });
}

/**
 * The room for a subject, or `null`.
 *
 * Exported so a caller assembling a subject input from a snapshot cannot accidentally
 * produce a room record with a different shape than the one the rules read.
 */
export function assistanceRoomFor(
  subject: AssistanceSubjectInput,
  roomId: string,
): AssistanceRoomInput | null {
  return roomById(subject, roomId) ?? null;
}
