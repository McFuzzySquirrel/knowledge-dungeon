/**
 * The pure layer between the assistance engine and the DOM.
 *
 * ## The one decision this module exists to make: render nothing
 *
 * Plan section 19's exit criterion is "Off mode removes proactive suggestions", and the engine
 * has already made that structural - `rankAssistance` returns before it reads the mode when the
 * flag is off, and returns before any rule runs when the mode is `off`, so
 * `evaluatedRuleKinds` is `[]` in both cases. This module's job is the half the engine cannot
 * do: making those two states, and a learner with nothing due, **indistinguishable from the
 * feature not existing**.
 *
 * The rule is a single condition, and it is deliberately single:
 *
 * ```
 * buildAssistanceCardModel(...) === null   ⟺   there is nothing to say
 * ```
 *
 * `null` covers all four ways a learner can reach "nothing to say" - `flag-disabled`,
 * `mode-off`, `no-suggestions`, and "suggestions exist but none belong to this surface" - and
 * it is checked **before** any row is built, so there is no branch downstream that can produce
 * an empty card, an empty heading, a placeholder, or a stray heading. A caller that renders
 * `null` renders no element at all, which is the only thing a learner can fail to notice.
 *
 * ## Why the emptiness test is `suggestions.length === 0` and not `emptyReason`
 *
 * Reading `emptyReason` would make this module branch on four strings to reach one outcome, and
 * would make a *fifth* reason - one a future rule family invents - fall through to "render
 * something", which is the opposite of the safe default. Testing the list is the property the
 * engine actually guarantees and the one a reviewer can check by eye.
 *
 * ## Why this module resolves room ids to topics
 *
 * `AssistanceAction.roomId` and `.detail` are app-minted ids or app-owned vocabulary. Plan §10.1
 * and the phase brief both forbid internal ids in anything a learner sees, and an id in a
 * screenshot is worse than a missing label. So the target's **visible topic** is looked up
 * here, and a suggestion whose room cannot be found resolves to `null` and is **dropped**: a
 * suggestion the learner cannot locate is not worth rendering, and rendering it with an empty
 * name would put a bare heading on screen.
 *
 * Framework-free and renderer-neutral: no React, no store, no engine internals, no `fetch`.
 */
import type { AssistanceEngineInput } from '@/core/assistance/assistanceEngine';
import type {
  AssistanceExplanation,
  AssistanceEvidence,
  AssistanceIntensity,
  AssistanceResult,
  AssistanceSubjectInput,
  AssistanceSuggestion,
} from '@/core/assistance/types';
import type { SupportedLocale } from '@/i18n';

import { ASSISTANCE_ACTION_COPY, ASSISTANCE_CHROME } from './assistanceCopy';
import { assistanceMessage } from './assistanceMessages';

/** The engine's intensity, re-published so a card cannot re-derive it. */
export type { AssistanceIntensity } from '@/core/assistance/types';

/** Which flow a card is being built for. Matches the engine's `AssistanceSurface`. */
export type AssistanceSurfaceFilter = 'creator' | 'scribe' | 'archaeologist' | 'fishing' | 'device';

export interface AssistanceEvidenceRow {
  /** The evidence's own app-owned vocabulary, for the DOM attribute and for a test. */
  readonly labelKey: string;
  /** The count. A number, never a formatted string. */
  readonly value: number;
  /** The label in the learner's language. */
  readonly label: string;
  /** The evidence value with its unit, already localized. */
  readonly text: string;
}

export interface AssistanceSuggestionRow {
  /** The engine's deterministic identity. Used as a React key; never rendered as text. */
  readonly suggestionId: string;
  /** The suggestion kind, app-owned vocabulary. Published as an attribute. */
  readonly kind: string;
  /** The reason code, app-owned vocabulary. Published as an attribute. */
  readonly reasonCode: string;
  /** The engine's integer priority, `0..100`. Published as a number, never as a word. */
  readonly priority: number;
  /** The engine's intensity, republished. */
  readonly intensity: AssistanceIntensity;
  /** The title, resolved from the nested catalogue. */
  readonly title: string;
  /** The one-sentence reason, resolved from the nested catalogue. */
  readonly detail: string;
  /** The evidence rows, in the engine's deterministic order. */
  readonly evidence: readonly AssistanceEvidenceRow[];
  /** The advisory offer, phrased as something on offer. `null` when the action names nothing. */
  readonly offer: string | null;
  /**
   * The visible topic the offer is about, or `null` for a device-wide suggestion.
   *
   * The card renders this beside the offer so the learner can find the room without reading an
   * id. Never the id itself.
   */
  readonly targetTopic: string | null;
}

export interface AssistanceCardModel {
  /** The suggestions for this surface, in the engine's ranked order. */
  readonly suggestions: readonly AssistanceSuggestionRow[];
  /**
   * The locale every string in this model was built in.
   *
   * A field rather than a prop so the card cannot pair one locale's copy with another's
   * intensity words. It is not a cached value in the Phase 17 sense: the model is rebuilt from
   * scratch on every render, so this is the locale of the text immediately beside it.
   */
  readonly locale: SupportedLocale;
  /** The heading. */
  readonly heading: string;
  /** The heading over the evidence rows. */
  readonly whyHeading: string;
  /** The heading over the offer. */
  readonly offerHeading: string;
  /** The advisory note. */
  readonly advisoryNote: string;
  /** The Dismiss verb. */
  readonly dismissLabel: string;
  /** The sentence a dismissed suggestion is replaced with. */
  readonly dismissedLabel: string;
}

export interface AssistanceCardInput {
  /** The locale the card renders in. */
  readonly locale: SupportedLocale;
  /** Which surface is asking. Suggestions for other surfaces are dropped, not rendered. */
  readonly surface: AssistanceSurfaceFilter;
  /** Whether this build has the Phase 19 flag on. */
  readonly flagEnabled: boolean;
  /** The engine's complete answer. */
  readonly result: AssistanceResult;
  /**
   * One explanation per suggestion, in the same order as `result.suggestions`.
   *
   * A **map** rather than a call to `explainAssistanceSuggestion` inside this module, for one
   * reason that matters: the engine's explanation is a pure derivation and this module is
   * allowed to be neither pure nor complete about it. Keeping the derivation at the call site
   * means a suggestion with no matching explanation is a `null` row here, not a re-derived
   * guess.
   */
  readonly explanations: ReadonlyMap<string, AssistanceExplanation>;
  /** The subject graphs, for resolving a room id to a visible topic. */
  readonly subjects: readonly AssistanceSubjectInput[];
}

/**
 * The model for this surface, or `null` when there is nothing at all to say.
 *
 * See the module header for why `null` is a single condition covering four states. The flag and
 * the mode are checked here **as well as** in the engine: the engine's checks are the guarantee,
 * and these are what make the DOM agree with it rather than depending on a caller having
 * filtered first.
 */
export function buildAssistanceCardModel(
  input: AssistanceCardInput,
): AssistanceCardModel | null {
  if (!input.flagEnabled) return null;
  if (input.result.mode === 'off') return null;
  const rows = buildRows(input);
  if (rows.length === 0) return null;
  return Object.freeze({
    suggestions: Object.freeze(rows),
    locale: input.locale,
    heading: ASSISTANCE_CHROME.cardHeading[input.locale],
    whyHeading: ASSISTANCE_CHROME.whyHeading[input.locale],
    offerHeading: ASSISTANCE_CHROME.offerHeading[input.locale],
    advisoryNote: ASSISTANCE_CHROME.advisoryNote[input.locale],
    dismissLabel: ASSISTANCE_CHROME.dismiss[input.locale],
    dismissedLabel: ASSISTANCE_CHROME.dismissed[input.locale],
  });
}

/** The rows for this surface, in the engine's ranked order, with unlocatable targets dropped. */
function buildRows(input: AssistanceCardInput): AssistanceSuggestionRow[] {
  const rows: AssistanceSuggestionRow[] = [];
  for (const suggestion of input.result.suggestions) {
    // A device-wide suggestion belongs on the device surface only. Rendering it inside the
    // Creator workspace would put "See what is due for review" above a topic the learner is
    // editing, which is advice about a different screen.
    if (!belongsOnSurface(suggestion, input.surface)) continue;
    const explanation = input.explanations.get(suggestion.suggestionId);
    if (explanation === undefined) continue;
    const topic = topicForTarget(suggestion, input.subjects);
    if (topic === null) continue;
    rows.push(toRow(suggestion, explanation, topic, input.locale));
  }
  return rows;
}

/**
 * Whether a suggestion may appear on this surface.
 *
 * `surface` on the suggestion is the authority, and `'device'` is never another surface's
 * suggestion. Two rules, both one line, and neither is "does this look relevant" - that
 * judgement belongs to the engine.
 */
function belongsOnSurface(
  suggestion: AssistanceSuggestion,
  surface: AssistanceSurfaceFilter,
): boolean {
  return suggestion.surface === surface;
}

/**
 * The visible topic a suggestion is about, or `null` when it names something unlocatable.
 *
 * ## `targetId` is polymorphic, and this is the trap
 *
 * Reading `targetId` as a room id is wrong for **three of the nine** kinds. Verified against
 * `src/core/assistance/assistanceEngine.ts`:
 *
 * | Kind | `targetId` is | `action.roomId` is |
 * | --- | --- | --- |
 * | `creator.missing-branch` | a **subject** | the root room |
 * | `creator.cross-link` | a **subject** | the other room of the pair |
 * | `scribe.*` (three kinds) | a room | that room |
 * | `archaeologist.*` (two kinds) | a room | that room |
 * | `fishing.navigation-after-miss` | a room | that room |
 * | `device.due-today` | a **subject** | `null` |
 *
 * A creator rule that reads "the root room has no branches" and ranks a suggestion about the
 * **subject** is right: the finding is a property of the subject's shape, and naming a single
 * room for it would be a guess. So the resolution is three ordered lookups rather than one:
 *
 * 1. `action.roomId`, when present - it is the room the *offer* is about, which for a subject-level
 *    finding is the room the offer would change.
 * 2. `targetId` as a room id.
 * 3. `targetId` as a subject id.
 *
 * A room is preferred over a subject in step 2/3 because a card's headline should name the room
 * a learner can walk to.
 *
 * ## Why `null` drops the suggestion
 *
 * An unlocatable target means the learner has been told something is wrong with a room or subject
 * they cannot identify. Rendering it anyway would put a title with no subject on screen and a
 * Dismiss button with nothing behind it. Dropping it is the only honest option, and it is why
 * `tests/phase19/assistanceUiSilence.test.tsx` can assert that a snapshot with no rooms renders
 * nothing.
 */
function topicForTarget(
  suggestion: AssistanceSuggestion,
  subjects: readonly AssistanceSubjectInput[],
): string | null {
  const offeredRoom = roomTopic(subjects, suggestion.action.roomId);
  if (offeredRoom !== null) return offeredRoom;
  const targetRoom = roomTopic(subjects, suggestion.targetId);
  if (targetRoom !== null) return targetRoom;
  const subject = subjects.find(
    (candidate) => candidate.subjectId === suggestion.targetId,
  );
  return subject === undefined ? null : subject.subjectName;
}

/** The topic of a named room in any supplied subject, or `null`. */
function roomTopic(
  subjects: readonly AssistanceSubjectInput[],
  roomId: string | null,
): string | null {
  if (roomId === null || roomId.length === 0) return null;
  for (const subject of subjects) {
    const room = subject.rooms.find((candidate) => candidate.roomId === roomId);
    if (room !== undefined) return room.topic;
  }
  return null;
}

/** Build one row. Pure: no clock, no store, no side effect. */
function toRow(
  suggestion: AssistanceSuggestion,
  explanation: AssistanceExplanation,
  topic: string,
  locale: SupportedLocale,
): AssistanceSuggestionRow {
  return Object.freeze({
    suggestionId: suggestion.suggestionId,
    kind: suggestion.kind,
    reasonCode: suggestion.reasonCode,
    priority: suggestion.priority,
    intensity: explanation.intensity,
    title: assistanceMessage(locale, explanation.titleKey),
    detail: assistanceMessage(locale, explanation.detailKey),
    evidence: Object.freeze(explanation.evidence.map((row) => toEvidenceRow(row, locale))),
    offer: offerFor(suggestion, locale),
    targetTopic: topic,
  });
}

/** One evidence row, with its count published as a number and its label resolved. */
function toEvidenceRow(row: AssistanceEvidence, locale: SupportedLocale): AssistanceEvidenceRow {
  const label = assistanceMessage(locale, row.labelKey);
  return Object.freeze({
    labelKey: row.labelKey,
    value: row.value,
    label,
    text: `${row.value} × ${label}`,
  });
}

/**
 * The advisory offer, phrased as an offer.
 *
 * `action.detail` is a required section's name or a room id. A room id is **never** rendered:
 * the `offer-cross-link` and `offer-navigation` templates take a topic, and an id that cannot
 * be resolved yields `null` rather than a sentence with a raw identifier in it.
 */
function offerFor(
  suggestion: AssistanceSuggestion,
  locale: SupportedLocale,
): string | null {
  const template = ASSISTANCE_ACTION_COPY[suggestion.action.kind];
  if (template === undefined) return null;
  const sentence = template[locale];
  const detail = suggestion.action.detail;
  if (detail === null || detail.length === 0) return sentence.includes('%s') ? null : sentence;
  return sentence.includes('%s') ? sentence.replace('%s', detail) : sentence;
}

/**
 * Assemble the engine input for a surface from the pieces a host has.
 *
 * Exported so the four integration points cannot each build a differently-shaped input - the
 * failure mode that would make "identical state yields identical assistance" a claim about one
 * screen rather than about the feature.
 *
 * `nowIso` is a **required** field rather than one with a default, and that is the whole point
 * of the function existing: the only reliable way to stop an integration point reading a clock
 * is to make handing it one unavoidable. There is no optional `nowIso`, no `Date.now()`
 * fallback, and no path through this signature that leaves the engine's only time input unset.
 */
export function assistanceEngineInputFor(input: AssistanceEngineInput): AssistanceEngineInput {
  return Object.freeze({
    mode: input.mode,
    signals: input.signals,
    subjects: input.subjects,
    nowIso: input.nowIso,
    ...(input.study === undefined ? {} : { study: input.study }),
    ...(input.fishing === undefined ? {} : { fishing: input.fishing }),
    flagEnabled: input.flagEnabled,
  });
}