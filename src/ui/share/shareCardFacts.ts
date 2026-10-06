/**
 * The bridge from what the application holds to what a card may say.
 *
 * ## The shape of this problem
 *
 * `ShareCardModelInput` (`src/core/share/types.ts`) is deliberately reduced: it has no field a note
 * body, a room id, or a raw badge id could be put in. That is the domain's privacy guarantee, and it
 * works - but it means somebody has to *count* the things the application actually stores and hand
 * the domain only the counts. This module is that somebody.
 *
 * It is the only place in `src/ui/share/` that reads application-shaped data, and the conversion is
 * a projection rather than a copy: notes become a length, badges become an id list for the domain
 * to resolve to canonical labels, rooms become two integers.
 *
 * ## Why this is a separate module and not part of the dialog
 *
 * Two reasons, one of which is load-bearing.
 *
 * 1. **The dialog must be provably count-free.** `tests/phase20/shareCardDialog.test.tsx` renders
 *    the dialog with a `ShareCardFacts` object and then asserts that nothing private is reachable
 *    from what it rendered. That assertion is only meaningful if the facts object is the whole
 *    input, which it is not - the panel has note bodies in hand - so the *conversion* has to be the
 *    boundary, and a conversion inside the dialog component would put application-shaped data in the
 *    same file as the rendering.
 * 2. **It is testable without a DOM.** The privacy claim here is about which fields cross the
 *    boundary, and a test for that needs no canvas and no rendering.
 *
 * ## What is deliberately not carried
 *
 * Not carried, and there is no parameter to carry it in:
 *
 * - note bodies, topics, previews, or markdown - only `collectedNotes.length`;
 * - room ids, room names, floor labels, or a room list - only `{ total, cleared }`;
 * - subject ids - the subject is named, never identified;
 * - per-room anything at all, so there is no field a dungeon layout could ride out in;
 * - fish **names** and catalogue ids - only the three rarity counts and the two totals;
 * - the Phase 19 assistance state. `sessionsWithAssistance` is a count a caller may supply, and this
 *   module supplies it only when the caller has already reduced it, so the suggestion ids, reason
 *   codes, and dismissal records have no parameter to arrive in.
 */
import type {
  ShareCardAssistanceInput,
  ShareCardBuildInput,
  ShareCardFishInput,
  ShareCardKind,
  ShareCardRoomsInput,
  ShareCardStatisticsInput,
} from '@/core/share/types';

/**
 * The application-shaped counts one subject's cards are built from.
 *
 * Every member is a count, a name, or a badge **id**. Note that `collectedNotes` and `inventory` are
 * declared as `number`, not as arrays: the panel has the arrays in hand and this module takes only
 * their length, so there is no parameter through which a note body could be passed at all. That is
 * the difference between "the adapter is careful" and "the adapter cannot be careless".
 */
export interface ShareCardFacts {
  /** The learner's own subject name. Publishable only when the learner leaves it selected. */
  readonly subjectName: string;
  /** Total XP for this subject. */
  readonly xpTotal: number;
  /** The rank tier the progression record holds. Never recomputed here. */
  readonly rank: string;
  /** Rooms cleared in this subject. */
  readonly clearedRoomCount: number;
  /** Rooms in this subject's graph. */
  readonly totalRoomCount: number;
  /** Badge **ids**. Resolved to canonical labels inside the domain; never printed as ids. */
  readonly badgeIds: readonly string[];
  /** Inventory size. A count. */
  readonly inventoryCount: number;
  /** Collected-note count. A count - never the notes. */
  readonly collectedNoteCount: number;
  /**
   * Fish collection counts for this subject.
   *
   * Counts and rarity buckets only. There is no parameter for a fish name or a catalogue id, so
   * neither can reach a card even by mistake.
   */
  readonly fish?: ShareCardFishInput | null;
  /**
   * Study statistics counts for this subject.
   *
   * Counts and a recall ratio as two integers. `generatedAt` and `todayKey`, which the statistics
   * snapshot carries, have no field here.
   */
  readonly statistics?: ShareCardStatisticsInput | null;
  /**
   * A reduced assistance count.
   *
   * Optional and null by default. A caller that has not already reduced the Phase 19 state to a
   * count leaves this null, and the `assistanceSummary` row is then **omitted** rather than shown as
   * zero - which is the honest difference between "I chose not to share assistance" and "no
   * assistance happened".
   */
  readonly assistance?: ShareCardAssistanceInput | null;
}

/** Non-negative integer coercion, the same rule the statistics and progression modules apply. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Build the domain's input for one kind.
 *
 * Pure, total, and does not read a clock: every member of the result is a function of `facts` alone,
 * which is what makes two devices with the same facts produce byte-identical cards.
 */
export function toShareCardBuildInput(
  facts: ShareCardFacts,
  kind: ShareCardKind,
): ShareCardBuildInput {
  const rooms: ShareCardRoomsInput = {
    total: toCount(facts.totalRoomCount),
    cleared: toCount(facts.clearedRoomCount),
  };
  return {
    kind,
    subjectName: facts.subjectName,
    progression: { xpTotal: toCount(facts.xpTotal), rank: facts.rank },
    rooms,
    badges: facts.badgeIds,
    inventoryCount: toCount(facts.inventoryCount),
    collectedNoteCount: toCount(facts.collectedNoteCount),
    fish: facts.fish ?? null,
    statistics: facts.statistics ?? null,
    assistance: facts.assistance ?? null,
  };
}

/**
 * Does this device hold enough for a card of this kind to say something?
 *
 * A dialog uses it to explain an empty preview rather than showing a card of zeros. It answers a
 * question about *availability of inputs*, not about rows - a subject with zero rooms cleared still
 * has a room total, and "no data yet" is different from "a record of nothing", which is the same
 * distinction `isEmptyShareCardModel` exists to preserve.
 */
export function hasFactsForKind(facts: ShareCardFacts, kind: ShareCardKind): boolean {
  if (kind === 'fish') return facts.fish !== null && facts.fish !== undefined;
  if (kind === 'statistics') return facts.statistics !== null && facts.statistics !== undefined;
  // A summary or a collection card needs at least a subject and a progression record.
  return facts.subjectName.trim().length > 0 || facts.xpTotal > 0;
}