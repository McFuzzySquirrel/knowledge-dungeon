/**
 * Which Creator tools are prominent, for which archetype.
 *
 * ## What this file is *not*
 *
 * It is not a suggestion engine. `TopicSuggestionInput` is declared in
 * `src/core/graph/types.ts` and unused; Phase 19 owns adaptive graph suggestions, and
 * Phase 14's non-goals list them. Nothing here ranks topics, proposes edges, or looks
 * at the learner's history - so there is no way for this file to quietly become the
 * suggestion feature it is adjacent to.
 *
 * ## What it is
 *
 * The plan's exit-criterion-adjacent scope line is "make player archetype differences
 * affect actual tool prominence or behavior rather than unsupported claims", and the
 * Cartographer's declared perk - "cross-link suggestions appear sooner in the room-info
 * panel" - is not implementable without the Phase 19 engine. Inventing a weaker
 * suggestion to satisfy the perk text would be the "unsupported claim" the plan is
 * warning about.
 *
 * So the archetype changes something that is *real*: which regions are open when the
 * workspace mounts, in what order they are read, and which next action leads. Three
 * things a learner can observe and a test can assert:
 *
 * - `order` - the DOM order of the tool regions.
 * - `expandedByDefault` - which regions start open. A Cartographer's graph is open on
 *   arrival; a Scholar's topic tools are.
 * - `primaryNextAction` - which step the "Next:" region leads with.
 *
 * Every tool stays reachable in every archetype. Prominence is ordering and openness,
 * never capability: a Scholar can open the graph, an Archivist can create topics, and
 * this module is what says so.
 *
 * ## Deliberately untouched
 *
 * The Scholar's and the Archivist's *perks* - the quality-bonus floor and the
 * self-check prompt cap - belong to Phases 15 and 16 and are implemented in their
 * domain code. This file does not restate, approximate, or override them.
 */
import type { PlayerClassId } from '@/application/contracts/world';

/** The tool regions a Creator workspace composes, in the neutral order. */
export const CREATOR_REGION_IDS = [
  'current-topic',
  'related-topics',
  'graph-structure',
  'topic-tools',
] as const;

export type CreatorRegionId = (typeof CREATOR_REGION_IDS)[number];

/**
 * How the archetype reads the workspace.
 *
 * - `graph-first` - the Cartographer: the structure leads.
 * - `topic-first` - the Scholar: the current topic and its tools lead.
 * - `connection-first` - the Archivist: what is already connected leads.
 * - `balanced` - no archetype chosen yet, so nothing is reordered.
 */
export type CreatorEmphasis = 'graph-first' | 'topic-first' | 'connection-first' | 'balanced';

export interface CreatorToolPlan {
  readonly emphasis: CreatorEmphasis;
  /** Region ids, in the order the workspace renders them. */
  readonly order: readonly CreatorRegionId[];
  /** Region ids that start open. Everything else starts collapsed but reachable. */
  readonly expandedByDefault: readonly CreatorRegionId[];
  /**
   * Which step leads the "Next:" region.
   *
   * A key from the workspace's own next-action table, not a sentence: the text lives
   * with the step so the two cannot disagree.
   */
  readonly primaryNextAction: CreatorNextActionKey;
  /** The one sentence the header shows. Built from the plan, so it cannot over-claim. */
  readonly note: string;
}

/** The next steps a Creator workspace can recommend. */
export const CREATOR_NEXT_ACTION_KEYS = [
  'add-child-topics',
  'cross-link',
  'review-structure',
  'handle-revalidation',
  'start-scribe',
] as const;

export type CreatorNextActionKey = (typeof CREATOR_NEXT_ACTION_KEYS)[number];

const BALANCED_ORDER: readonly CreatorRegionId[] = CREATOR_REGION_IDS;

const PLANS: Readonly<Record<PlayerClassId, CreatorToolPlan>> = Object.freeze({
  /*
   * The Cartographer maps relationships, so the graph is the first thing open and the
   * first thing led with. This replaces the "suggestions appear sooner" perk with a
   * prominence rule that is true the moment the workspace mounts, and it is stated to
   * the learner in the header rather than in a perk list nobody re-reads.
   */
  cartographer: Object.freeze({
    emphasis: 'graph-first',
    order: Object.freeze(['graph-structure', 'current-topic', 'related-topics', 'topic-tools'] as const),
    expandedByDefault: Object.freeze(['graph-structure', 'related-topics'] as const),
    primaryNextAction: 'cross-link',
    note: 'Cartographer: the graph and its links lead, and open on arrival.',
  }),
  /*
   * The Scholar is methodical about the topic in hand, so the topic and its tools come
   * first and the structure stays one toggle away.
   */
  scholar: Object.freeze({
    emphasis: 'topic-first',
    order: Object.freeze(['current-topic', 'topic-tools', 'related-topics', 'graph-structure'] as const),
    expandedByDefault: Object.freeze(['current-topic', 'topic-tools'] as const),
    primaryNextAction: 'add-child-topics',
    note: 'Scholar: the current topic and its tools lead.',
  }),
  /*
   * The Archivist works from what already exists, so the connections lead and the graph
   * opens beside them rather than instead of them.
   */
  archivist: Object.freeze({
    emphasis: 'connection-first',
    order: Object.freeze(['related-topics', 'current-topic', 'graph-structure', 'topic-tools'] as const),
    expandedByDefault: Object.freeze(['related-topics', 'graph-structure'] as const),
    primaryNextAction: 'review-structure',
    note: 'Archivist: existing connections lead, with the graph open beside them.',
  }),
});

/**
 * The plan for an archetype, or the neutral plan when none is chosen.
 *
 * A `null` archetype is a real state - the tutorial reaches the dungeon before the
 * pick-archetype step - so it gets a plan of its own rather than a `??` that hides it.
 */
export function resolveCreatorToolPlan(archetype: PlayerClassId | null | undefined): CreatorToolPlan {
  if (archetype == null) {
    return {
      emphasis: 'balanced',
      order: BALANCED_ORDER,
      expandedByDefault: CREATOR_REGION_IDS,
      primaryNextAction: 'add-child-topics',
      note: 'No archetype chosen yet: every Creator tool is open.',
    };
  }
  return PLANS[archetype];
}

/**
 * Whether a region starts open.
 *
 * A single place that answers it, so a plan and the rendered tree cannot disagree: the
 * workspace asks this for every region it renders, including the ones its order did not
 * mention.
 */
export function isExpandedByDefault(
  plan: CreatorToolPlan,
  regionId: CreatorRegionId,
): boolean {
  return plan.expandedByDefault.includes(regionId);
}
