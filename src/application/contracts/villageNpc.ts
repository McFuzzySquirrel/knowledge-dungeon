/**
 * Renderer-neutral village NPC contract.
 *
 * ## Why this file exists
 *
 * Phase 11 shipped a Pixi village behind `VITE_PIXI_VILLAGE` and deliberately left
 * NPC interaction unimplemented, so the Pixi scene accepts the `onNpc*` callbacks
 * and never emits them. The NPC *data* was already renderer-neutral
 * (`VillageNpc` in `src/data/villageLayout.ts`), and the NPC *events* were already
 * declared in `WorldEventPayloadMap`. What did not exist was the middle: a named,
 * renderer-neutral description of (a) which of those events a village host reports,
 * (b) what the React shell needs to *read* about nearby NPCs, (c) how a DOM control
 * *asks* the world to act on one, and (d) where a dialogue anchors.
 *
 * Declaring those four things here is what lets the Pixi scene and the Phaser
 * adapter satisfy one contract instead of two near-identical callback objects, and
 * what lets a React panel render a nearby-action list and a quest overview without
 * knowing which renderer is mounted.
 *
 * ## What this file is not allowed to be
 *
 * It names no Phaser type, no PixiJS type, no DOM global, and no store. The one
 * import from `@/data/villageLayout` is the renderer-neutral NPC record and the two
 * proximity radii that Phase 11 already extracted so the two renderers read one set
 * of numbers. Quest-step *vocabulary* is deliberately **not** modelled here: the
 * quest step is an opaque `string` that indexes `questDialogue`, because the study
 * flow owns what a step means and a second mirror of that union would be a second
 * thing to drift.
 *
 * ## What is deliberately absent
 *
 * The world, not the contract, decides who is nearby; this file says how a reported
 * measurement becomes the ordered list a DOM control renders. Dialogue *state*
 * (what line is showing, whether a conversation is open) is application state and is
 * read back through the capability port, not stored here. **Quest promotion is absent
 * too.** This contract takes the step the learner is on and returns the line for it;
 * which step a conversation moves the learner to is decided by the application layer,
 * which is the only layer that knows the quest vocabulary, and it applies that step
 * *before* it asks this file for a line. See {@link selectVillageNpcLine}.
 */
import {
  INTERACT_RADIUS,
  STRUCTURE_APPROACH_RADIUS,
  type VillageNpc,
} from '@/data/villageLayout';
import type { WorldEventHandlers, WorldEventName, WorldEventPayload } from './events';

/* -------------------------------------------------------------------------- */
/* Compile-time assertion helpers                                              */
/* -------------------------------------------------------------------------- */

/** Exact-type equality; the distributive conditional defeats `A extends B`. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/** Compile-time assertion: fails `npm run typecheck` when false, not just the tests. */
type AssertTrue<T extends true> = T;

/* -------------------------------------------------------------------------- */
/* 1. Events: which of the declared world events a village host reports         */
/* -------------------------------------------------------------------------- */

/**
 * Every renderer-neutral village NPC event name.
 *
 * Derived from `WorldEventPayloadMap` rather than written out, so an NPC event
 * added to the contract in `events.ts` joins this slice automatically and this file
 * cannot quietly fall behind it.
 */
export type VillageNpcEventName = Extract<WorldEventName, `village:npc-${string}`>;

/**
 * The handler bag an application layer binds to receive a village host's NPC
 * events.
 *
 * `Required` on purpose: the Phaser `VillageSceneEvents` and the Pixi
 * `VillageSceneCallbacks` both declare the `onNpc*` members optional, which is
 * right for a *renderer* (an adapter that never emits one should not have to
 * declare it) and wrong for an *application layer* (a screen that renders a
 * nearby-action list and a quest overview needs all four or it is shipping dead
 * branches). This is the shape the application binds; the renderer projects onto it.
 *
 * It is a `WorldEventHandlers` bag keyed by event name and receiving the whole
 * payload, so it feeds `createWorldEventSink` directly - the existing mechanism,
 * not a second bus.
 */
export type VillageNpcEventHandlers = Required<Pick<WorldEventHandlers, VillageNpcEventName>>;

/**
 * Compile-time proof that the NPC slice is exactly the four declared
 * `village:npc-*` events and that `Required` really made every one of them
 * mandatory. Exported so it is a module export rather than an unused local, in the
 * spirit of `SessionUnionParity` in `src/store/sessionStore.ts`.
 */
export type VillageNpcEventHandlersCoverTheContract = AssertTrue<
  Exact<
    VillageNpcEventName,
    'village:npc-approached' | 'village:npc-left' | 'village:npc-interact' | 'village:npc-dialog-position'
  >
>;

/* -------------------------------------------------------------------------- */
/* 4. The dialog anchor                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where a village NPC's dialogue should attach, in **CSS viewport pixels**.
 *
 * Renderer-neutral in the sense that matters for a DOM consumer: the numbers are
 * already in the coordinate space the dialog is positioned in, so the React shell
 * places the dialog without owning a camera, and neither renderer can hand over
 * its own screen space and quietly ask the DOM to do the projection. Each renderer
 * converts at its own edge - the Phaser scene adds the canvas bounding rect to its
 * camera-projected point, a Pixi scene adds the canvas rect to its container-local
 * point - and both land here.
 *
 * The field names are the historical `village:npc-dialog-position` payload fields,
 * kept so the Phaser adapter's emitted object is this type without translation. The
 * parity assertion below is what makes that a checked fact rather than a hope.
 */
export interface VillageNpcDialogAnchor {
  /** The NPC the dialogue belongs to. */
  npcId: string;
  /** Horizontal position, CSS pixels from the viewport's left edge. */
  clientX: number;
  /** Vertical position, CSS pixels from the viewport's top edge. */
  clientY: number;
}

/**
 * Compile-time proof that the named anchor and the declared event payload are the
 * same shape, field for field. If `events.ts` gains, loses, or renames a field,
 * `npm run typecheck` fails here instead of a renderer emitting an object no panel
 * can read.
 */
export type VillageNpcDialogAnchorMatchesTheEvent = AssertTrue<
  Exact<VillageNpcDialogAnchor, WorldEventPayload<'village:npc-dialog-position'>>
>;

/* -------------------------------------------------------------------------- */
/* 2. Capability reads: the nearby-action list                                */
/* -------------------------------------------------------------------------- */

/** What kind of thing a nearby-action row is. */
export type VillageNearbyTargetKind = 'structure' | 'npc';

/**
 * The proximity radii, keyed by target kind.
 *
 * Read from `src/data/villageLayout.ts` rather than restated, because those two
 * numbers are already the single source both renderers compare against and a third
 * copy here is exactly the drift Phase 11 removed. The two differ on purpose: an
 * NPC must be nearly on top of you to be talked to, while a building has a front
 * you approach.
 */
export const VILLAGE_NEARBY_RANGES: Readonly<Record<VillageNearbyTargetKind, number>> =
  Object.freeze({
    structure: STRUCTURE_APPROACH_RADIUS,
    npc: INTERACT_RADIUS,
  });

/**
 * A proximity measurement a renderer reported, before the contract has decided
 * which measurements become a DOM row.
 *
 * Raw on purpose. A renderer knows where its sprites are; it does not know how a
 * React panel orders or filters them, and a snapshot that arrives pre-filtered
 * makes that policy a per-renderer decision that can differ between Phaser and
 * Pixi. Keeping the measurement raw and the selection here is what makes the two
 * renderers produce the *same* list.
 */
export interface VillageNearbyCandidate {
  readonly kind: VillageNearbyTargetKind;
  /** Structure id or NPC id, exactly as the matching event reports it. */
  readonly id: string;
  /** Human-facing name, already the fallback the renderer would use. */
  readonly label: string;
  /** Distance from the player, in world pixels. */
  readonly distance: number;
  /** Radius within which the target can be acted on, in world pixels. */
  readonly range: number;
}

/**
 * One row of the DOM nearby-action list, after the contract's selection rules.
 *
 * Carries the target identity rather than a closure, so a control can be a plain
 * `button` that reports an intent and a renderer can decide whether it can honour
 * that intent.
 */
export interface VillageNearbyTarget {
  readonly kind: VillageNearbyTargetKind;
  readonly id: string;
  readonly label: string;
  /** Distance from the player, in world pixels. Rounded for display stability. */
  readonly distance: number;
  /**
   * The action id a DOM control passes to `invokeAction` for this row.
   *
   * Always {@link VILLAGE_ACTION_INTERACT} in Phase 12: the village still has one
   * interact verb, and the *target* is what distinguishes the rows. It is a field
   * so a second village verb can be added without reshaping the list.
   */
  readonly actionId: VillageActionId;
}

/** Structure rows come first: see {@link selectVillageNearbyTargets}. */
const TARGET_KIND_ORDER: Readonly<Record<VillageNearbyTargetKind, number>> = Object.freeze({
  structure: 0,
  npc: 1,
});

/**
 * Round to tenths of a world pixel; the list is a read-out, not a measurement
 * instrument.
 *
 * **Tenths, and upward-biased** - `Math.round` is round-half-up, so a distance of
 * `47.96` publishes as exactly `48`. That is the whole reason this function exists
 * as a named indirection: a *consumer* must not re-derive the selection threshold
 * from the published number. `selectVillageNearbyTargets` admits a measurement when
 * `distance < range`, so a legitimately selected row can publish a value equal to
 * the radius, and a test or a panel asserting `published < range` asserts something
 * the contract never promised. The claim a caller can make is "a row exists", which
 * the contract's own selection already establishes.
 *
 * (An earlier comment here said "Whole pixels", which was wrong twice over: the
 * divisor is ten, and the rounding is what makes the equality case reachable.)
 */
function roundDistance(distance: number): number {
  return Math.round(distance * 10) / 10;
}

/**
 * Turn reported proximity measurements into the ordered nearby-action list.
 *
 * ## The rules, and why each one is here
 *
 * 1. **A measurement must be usable.** A non-finite or negative distance, or a
 *    `range` that is not a positive number, is dropped rather than shown. A
 *    renderer mid-frame can report a placeholder, and a list that renders
 *    `NaN` to a learner is worse than a list that renders one row fewer.
 * 2. **In range means strictly inside.** `distance < range`, not `<=`. The Phaser
 *    scene seeds its nearest-target search with the radius and accepts a strict
 *    improvement, so the boundary tile is *not* interactive there; using `<=` here
 *    would make a DOM row exist that the canvas refuses to act on.
 * 3. **One row per kind, nearest wins.** At most one structure and one NPC, because
 *    that is exactly what a single interact verb can reach: `VillageScene.handleInteract`
 *    resolves a structure first and an NPC only when no structure is in range. Ties
 *    break on `id` so two renderers reporting the same world produce the same list.
 * 4. **Structures first, then NPCs.** The order matches the priority the world's
 *    own interact key already has, so the first row of the DOM list is the action a
 *    learner would get by pressing the key. A list sorted by distance would
 *    routinely lead with an NPC the key press would never talk to.
 *
 * Total and side-effect free: a bad measurement is dropped, an empty input is an
 * empty list, and the input array is never mutated.
 */
export function selectVillageNearbyTargets(
  candidates: readonly VillageNearbyCandidate[],
): readonly VillageNearbyTarget[] {
  const usable = candidates.filter(
    (candidate) =>
      Number.isFinite(candidate.distance) &&
      candidate.distance >= 0 &&
      Number.isFinite(candidate.range) &&
      candidate.range > 0 &&
      candidate.distance < candidate.range,
  );

  const ordered = [...usable].sort((left, right) => {
    const byKind = TARGET_KIND_ORDER[left.kind] - TARGET_KIND_ORDER[right.kind];
    if (byKind !== 0) return byKind;
    if (left.distance !== right.distance) return left.distance - right.distance;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const seen = new Set<VillageNearbyTargetKind>();
  const selected: VillageNearbyTarget[] = [];
  for (const candidate of ordered) {
    if (seen.has(candidate.kind)) continue;
    seen.add(candidate.kind);
    selected.push({
      kind: candidate.kind,
      id: candidate.id,
      label: candidate.label,
      distance: roundDistance(candidate.distance),
      actionId: VILLAGE_ACTION_INTERACT,
    });
  }
  return Object.freeze(selected);
}

/* -------------------------------------------------------------------------- */
/* 3. Invoking an action from the DOM                                          */
/* -------------------------------------------------------------------------- */

/**
 * The village actions a DOM control can ask for.
 *
 * The literal is deliberately the one the Pixi village scene already declares as
 * `VILLAGE_INTERACT_ACTION_ID`, so a Pixi host satisfies this contract with no
 * translation table between the id the DOM sends and the id the scene's action
 * table answers to. `tests/phase12/village-npc-contract.test.ts` pins the two
 * together, so the day someone renames one of them the gate is red rather than the
 * DOM control quietly doing nothing.
 *
 * It is a single-member union rather than a bare `string` because the whole point of
 * the port is that a renderer is handed a *name it declared*, not an arbitrary
 * value from a panel. A second member is a deliberate addition here.
 */
export type VillageActionId = 'village-interact';

/** The canonical value of {@link VillageActionId}, shared by DOM and renderers. */
export const VILLAGE_ACTION_INTERACT: VillageActionId = 'village-interact';

/**
 * Which input path performed an action.
 *
 * The same three literals the Pixi world host already threads through its
 * dispatcher (`WorldActionSource`), restated here so the contract layer does not
 * import the renderer tree to name them - they are structurally identical, so an
 * adapter can forward `invocation.source` straight into its own dispatcher. A
 * renderer may report the source and must never branch on it to change behaviour.
 */
export type VillageActionSource = 'keyboard' | 'pointer' | 'dom';

/** The thing a DOM control names. Omitted by the bare "interact with what is nearest" verb. */
export interface VillageActionTarget {
  readonly kind: VillageNearbyTargetKind;
  readonly id: string;
}

/**
 * A renderer-neutral request to act on the village.
 *
 * ## Why this is a value and not a callback
 *
 * The Phase 9 rule is that a scene may *ask* the host to act and only the host may
 * answer, because answering is also what republishes state to the DOM. This value
 * is the DOM half of that: a control builds one of these, hands it to
 * `VillageNpcHost.invokeAction`, and the adapter routes it through its own dispatch
 * so the canvas tap, the keyboard shortcut, and the button remain one action.
 *
 * ## What `target` is for
 *
 * A nearby-action row says *which* thing it means ("Talk to the Keeper"), and a
 * renderer with a single interact verb may not be able to honour that: the Phaser
 * `handleInteract` always resolves a structure first. So `target` is a **named
 * intent**, not a guarantee. An adapter that cannot honour it may fall back to the
 * nearest interactible, and a control must therefore label its action by target
 * rather than implying the target is exclusive. The alternative - dropping the
 * request - is worse: a learner who pressed a labelled control and saw nothing
 * happen learns that the control lies.
 */
export interface VillageActionInvocation {
  readonly actionId: VillageActionId;
  /**
   * The target the control named, or `null` for the bare nearest interact.
   *
   * `null` is the whole-village verb and is what the canvas tap, the `E` key, and
   * the existing "Interact" button all produce.
   */
  readonly target: VillageActionTarget | null;
  readonly source: VillageActionSource;
}

/* -------------------------------------------------------------------------- */
/* Dialogue selection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Which pool of lines an NPC's dialogue was drawn from.
 *
 * `'greeting'` is a real answer and not a special case folded into `'dialogue'`:
 * a fresh conversation with an NPC that has no script for the current quest step
 * opens on its `greeting` and then cycles its ambient `dialogue`. Splitting them
 * lets a panel style an unscripted exchange differently from a scripted one
 * without re-deriving which pool it is looking at.
 */
export type VillageNpcLineSource = 'quest' | 'quote' | 'greeting' | 'dialogue';

/**
 * Where a conversation stands, so the next line is deterministic.
 *
 * A value and not a mutable cursor object: the application layer owns the state and
 * hands it back in, so a re-render, a StrictMode double-effect, and a renderer that
 * reports the same interact twice all resolve to the same line instead of
 * depending on how many times a callback ran.
 */
export interface VillageNpcLineCursor {
  /** Index within the pool the last selection used. `-1` before the first line. */
  readonly index: number;
  /**
   * The quest step the last selection was resolved against.
   *
   * Stored because a conversation outlives a quest step: when the step changes
   * under an open conversation the index belongs to a script that is no longer on
   * screen, so {@link selectVillageNpcLine} restarts at the opening line. The
   * village screen's own quest-board click already resets to the first line, so
   * this is the same rule applied to every way a step can move.
   */
  readonly questStep: string;
}

/** Everything {@link selectVillageNpcLine} needs to choose a line. */
export interface VillageNpcLineRequest {
  readonly npc: VillageNpc;
  /**
   * The quest step the learner is on, and the step the pool is resolved against.
   *
   * Opaque here; it indexes `questDialogue`. It is the *only* thing that chooses the
   * pool, and there is deliberately no second input that could substitute another
   * step - see {@link VillageNpcLineRequestHasNoPromotionInput} and
   * {@link selectVillageNpcLine}.
   */
  readonly questStep: string;
  /** The conversation's cursor, or `null` when the conversation just began. */
  readonly cursor: VillageNpcLineCursor | null;
  /**
   * Index into the quote pool for a wanderer's *first* line.
   *
   * Injected rather than generated so this function stays deterministic and
   * testable: a wanderer's opening line is a random quote today, the caller
   * supplies the randomness, and every later line in that conversation is a
   * deterministic cycle through the same pool. A value that is absent,
   * non-finite, fractional, or outside `[0, pool length)` resolves to `0`, so a
   * caller that forgets the field - or passes an un-clamped random - still gets a
   * defined line rather than a hole. A value that is merely fractional *inside*
   * the range truncates downward, because rounding up would read past the index the
   * caller asked for.
   */
  readonly quoteIndex?: number;
}

/**
 * Compile-time proof that the line request carries **no promotion input**, and that
 * it stayed that way.
 *
 * There was a `promoteQuestStep?: string` here, reported back as
 * `questStepToApply`. Nothing in the application ever passed or read either: the
 * quest promotion is applied by `useVillageSceneCallbacks` through the store, and
 * *before* it asks this function for a line, so the pool is resolved against the
 * promoted step. The field therefore described the opposite of what shipped, beside
 * a doc that claimed the pre-promotion pool "is the behaviour the village screen has
 * today" - and the shipped screen had shown `meet-keeper[0]` since Phase 12 WP-1.2,
 * not `intro[0]`.
 *
 * Written as a negation over `keyof`, so `npm run typecheck` fails the moment anyone
 * re-adds it - including under a different name, because the check is over every key
 * rather than a hand-listed pair. This is the same idiom as
 * {@link VillageNpcSnapshotHasNoDialogueMember}: a test cannot observe a type, and a
 * field that came back would be silently accepted by every caller.
 */
export type VillageNpcLineRequestHasNoPromotionInput = AssertTrue<
  Exact<
    Extract<'promoteQuestStep' | 'questStepToApply', keyof VillageNpcLineRequest>,
    never
  >
>;

/**
 * Compile-time proof that the selection reports **no promotion output**, for the same
 * reason as {@link VillageNpcLineRequestHasNoPromotionInput} and with the same idiom.
 */
export type VillageNpcLineSelectionHasNoPromotionOutput = AssertTrue<
  Exact<
    Extract<'promoteQuestStep' | 'questStepToApply', keyof VillageNpcLineSelection>,
    never
  >
>;

/** The line a selection resolved to, and everything a panel needs to show it. */
export interface VillageNpcLineSelection {
  readonly npcId: string;
  readonly label: string;
  /** Which pool `line` came from. */
  readonly source: VillageNpcLineSource;
  /** Index within that pool. */
  readonly index: number;
  /**
   * How many slots the cursor cycles through.
   *
   * A floor of `1` for the no-content fallback, so a caller can render
   * "1 of N" without a divide-by-zero. It is a count of *positions*, not a promise
   * that every position holds text - see {@link VillageNpcLineSelection.line}.
   */
  readonly lineCount: number;
  /**
   * The line to show.
   *
   * **May be empty, and that is a content signal rather than a contract bug.** An
   * NPC whose `greeting` is `''` and which has no `questDialogue` entry, no
   * `quotes`, and an empty `dialogue` has no authored line anywhere, and the
   * fallback chain has nothing left to return. The contract reports that honestly
   * rather than substituting a sentence: a renderer-neutral module that invented
   * dialogue would be deciding product copy, and it would hide an authoring mistake
   * behind plausible text. No NPC in `VILLAGE_MAP` is in this state, so this is a
   * reachable-by-construction case, not a shipped one.
   *
   * A panel should therefore treat an empty `line` as "nothing to say" - render no
   * dialog rather than an empty one - and must not treat it as a transient state to
   * retry. The invariant it may rely on is that the line is `''` *only* when the NPC
   * has no authored content, which
   * `tests/phase12/village-npc-contract.test.ts` pins.
   */
  readonly line: string;
  /**
   * The quest step the pool was resolved against - always the one the caller passed.
   *
   * There is no companion "step to apply" field, and there was: see
   * {@link VillageNpcLineSelectionHasNoPromotionOutput} for why it was removed and
   * why it must not come back.
   */
  readonly questStep: string;
  /** The cursor to store for the next selection. */
  readonly cursor: VillageNpcLineCursor;
}

const NO_LINES: readonly string[] = Object.freeze([]);

/** `questDialogue[questStep]`, or nothing when the step has no script. */
function questLinesFor(npc: VillageNpc, questStep: string): readonly string[] {
  const lines = npc.questDialogue?.[questStep];
  return Array.isArray(lines) && lines.length > 0 ? lines : NO_LINES;
}

/** Whether this NPC is scripted by quest step at all (today: only the Keeper). */
function hasQuestScript(npc: VillageNpc): boolean {
  return npc.questDialogue != null;
}

/** Wrap any index into `[0, length)`. This is the cycling arithmetic. */
function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((Math.trunc(index) % length) + length) % length;
}

/**
 * Resolve a caller-supplied opening index.
 *
 * Distinct from {@link wrapIndex} on purpose. Cycling is a modulo because it is
 * always advancing from a known-good index, whereas an opening index is a *choice*
 * a caller made and an out-of-range one is a caller mistake (an un-clamped random,
 * an off-by-one, a `Date.now()`-ish thing) rather than a request to wrap. Silently
 * wrapping it would answer a wanderer's opening line from the far end of the pool;
 * refusing it answers with the first line, which is a defined, explainable result.
 */
function openingIndex(index: number | undefined, length: number): number {
  if (length <= 0) return 0;
  if (index === undefined || !Number.isFinite(index)) return 0;
  const whole = Math.trunc(index);
  return whole >= 0 && whole < length ? whole : 0;
}

interface ResolvedLinePool {
  readonly source: VillageNpcLineSource;
  readonly lines: readonly string[];
  /** The line a *fresh* conversation opens on, which is not always `lines[0]`. */
  readonly openingLine: string;
}

/**
 * Resolve the pool of lines an NPC speaks at a quest step, and the line a fresh
 * conversation opens on.
 *
 * Precedence, in order: this quest step's script, then the NPC's quotes, then its
 * ambient dialogue opened by its greeting, then the greeting alone. The order is
 * asserted against the whole shipped roster in
 * `tests/phase12/village-npc-contract.test.ts`; note that a hypothetical
 * quest-giver that *also* carried quotes would open on a quote rather than its
 * greeting, and no such NPC exists in `VILLAGE_MAP`.
 */
function resolveLinePool(
  npc: VillageNpc,
  questStep: string,
  quoteIndex: number | undefined,
): ResolvedLinePool {
  const questLines = questLinesFor(npc, questStep);
  if (questLines.length > 0) {
    return { source: 'quest', lines: questLines, openingLine: questLines[0] };
  }

  const quotes = npc.quotes;
  if (Array.isArray(quotes) && quotes.length > 0) {
    return {
      source: 'quote',
      lines: quotes,
      openingLine: quotes[openingIndex(quoteIndex, quotes.length)],
    };
  }

  const dialogue = npc.dialogue;
  if (Array.isArray(dialogue) && dialogue.length > 0) {
    // The opening line prefers the greeting and falls back to the first ambient
    // line. The fallback is not cosmetic: an NPC can have a `greeting` of `''` and
    // a non-empty `dialogue`, and returning the greeting unconditionally made that
    // NPC open on an *empty* line while authored text sat right there in the pool -
    // so "empty means the NPC has nothing to say" would have been false. Every
    // shipped NPC has a non-empty greeting, so this changes nothing today; it is
    // here so the invariant a panel relies on actually holds.
    return { source: 'greeting', lines: dialogue, openingLine: npc.greeting || dialogue[0] };
  }

  return { source: 'dialogue', lines: NO_LINES, openingLine: npc.greeting };
}

/**
 * Choose the line a conversation shows next.
 *
 * Total and pure: no clock, no randomness of its own, no store, no renderer, and the
 * input NPC is never mutated. Every field of the result is derived, so two callers
 * with the same request always get the same line - which is what makes a re-render,
 * a StrictMode double-effect, and a renderer that reports the same interact twice
 * indistinguishable from one deliberate interact.
 *
 * ## The pool is resolved against exactly `request.questStep`
 *
 * Stated as a fact because the opposite used to be documented here as deliberate: the
 * selection used to accept a `promoteQuestStep`, resolve the pool against the step
 * *before* it, and hand the promotion back as `questStepToApply`. That described the
 * pre-Phase-12 screen, which read a stale zustand snapshot after promoting and so
 * showed the Keeper's `intro` opening line on a first approach and skipped
 * `meet-keeper[0]` altogether. Since Phase 12 WP-1.2 the application promotes through
 * the store and only then calls this function, so the first approach from `intro`
 * shows `meet-keeper[0]`. `tests/phase12/village-line-selection-owner.test.tsx` pins
 * that, and this function must not be given a way to undo it - which is why the
 * promotion input and output are gone rather than merely unused.
 */
export function selectVillageNpcLine(request: VillageNpcLineRequest): VillageNpcLineSelection {
  const { npc, questStep, cursor, quoteIndex } = request;
  const pool = resolveLinePool(npc, questStep, quoteIndex);

  // A conversation that has just begun opens on the pool's first line, and a cursor
  // from a different quest step restarts there too: its index belonged to a script
  // that is no longer the one on screen.
  const isOpening = cursor === null || cursor.questStep !== questStep;
  const length = pool.lines.length;
  // An empty pool cycles onto itself, so the modulo guard is `|| 1` rather than a
  // separate branch: the answer is index 0 either way, and the line falls back
  // below.
  const index = isOpening ? 0 : wrapIndex(cursor.index + 1, length || 1);
  const line = isOpening ? pool.openingLine : pool.lines[index] ?? pool.openingLine;

  return {
    npcId: npc.id,
    label: npc.label,
    source: pool.source,
    index,
    lineCount: Math.max(pool.lines.length, 1),
    line,
    questStep,
    cursor: { index, questStep },
  };
}

/* -------------------------------------------------------------------------- */
/* Quest overview                                                              */
/* -------------------------------------------------------------------------- */

/** One row of the DOM quest overview. */
export interface VillageNpcQuestRow {
  readonly npcId: string;
  readonly label: string;
  /**
   * Quest steps this NPC has scripted dialogue for, in the key order
   * `questDialogue` declares them.
   *
   * Object key order, not sorted: the declaration order is the authored order of
   * the tutorial, and a sorted list would reorder `create-subject` before
   * `complete` for reasons no learner could reconstruct.
   */
  readonly questSteps: readonly string[];
  /** Whether the learner is on a step this NPC can speak to. */
  readonly speaksCurrentStep: boolean;
}

/**
 * Describe which NPCs can speak about the current quest step.
 *
 * A pure derivation over the static roster, not a renderer read: the roster is
 * renderer-neutral content, and the current quest step is application state, so a
 * quest overview needs nothing from either renderer. Wanderers have no
 * `questDialogue` and are therefore not rows - a quest board listing five villagers
 * who cannot speak about the quest is noise, not coverage.
 */
export function describeVillageNpcQuests(
  npcs: readonly VillageNpc[],
  questStep: string,
): readonly VillageNpcQuestRow[] {
  const rows: VillageNpcQuestRow[] = [];
  for (const npc of npcs) {
    if (!hasQuestScript(npc)) continue;
    const questSteps = Object.keys(npc.questDialogue ?? {}).filter(
      (step) => questLinesFor(npc, step).length > 0,
    );
    if (questSteps.length === 0) continue;
    // The row is frozen as well as the array: freezing only the array leaves the row
    // objects writable, so a caller could flip `speaksCurrentStep` on a row the
    // board is already holding and have the next render claim the NPC can speak
    // about a step she has no script for.
    rows.push(
      Object.freeze({
        npcId: npc.id,
        label: npc.label,
        questSteps: Object.freeze(questSteps),
        speaksCurrentStep: questSteps.includes(questStep),
      }),
    );
  }
  return Object.freeze(rows);
}

/* -------------------------------------------------------------------------- */
/* The snapshot a renderer reports back                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything a React panel needs to know about a mounted village's NPCs, as one
 * value.
 *
 * One read rather than several polled callbacks, for two reasons. A panel that
 * rendered "nearby NPCs" and "current dialogue" from two polls could observe them
 * at different instants and show a dialogue for an NPC no longer in range; and a
 * poll that reaches for a renderer object is the pattern Phase 11 replaced for the
 * compass. This is data out of a capability port, in the same shape as
 * `readPoi()` but carrying the whole NPC surface at once.
 *
 * ## Why there is no `dialogue` member
 *
 * There was one, and it was removed because it was dead: both renderers computed it,
 * and nothing ever read it. `VillageNpcSurface` - the React bridge that consumes this
 * snapshot - never declared a `dialogue` member, so the bubble a learner sees comes
 * entirely from application state the `village:npc-*` handlers wrote. A field both
 * renderers computed, neither of which could name the learner's quest step, and no
 * consumer read, is not a contract surface: it is a second answer to "what does this
 * NPC say" that was wrong whenever the quest step mattered, kept alive only because
 * computing it was cheap.
 *
 * ## What is deliberately *not* the replacement
 *
 * The obvious repair - putting the quest step on the snapshot so a renderer could
 * compute the right line - was rejected. A renderer does not reach into a store (that
 * is a Phase 9 rule), so the step would have to be pushed in, which makes the
 * snapshot a second source of quest truth: the store would hold a step, the snapshot
 * would hold a copy of it, and a panel reading the copy could disagree with the flow
 * writing the original.
 *
 * So the line is chosen by the application layer, which is the only layer that
 * *knows* the step, and the renderer reports only what it can see: where people are,
 * and where a dialog would attach. `anchor` survives that narrowing because it is a
 * geometric fact about a sprite, not a question about quest state.
 */
export interface VillageNpcSnapshot {
  /**
   * Raw proximity measurements, for {@link selectVillageNearbyTargets}.
   *
   * Measurements and not rows, so the ordering policy lives in one place. A host
   * that has nothing nearby reports an empty array; it never reports a distance of
   * `Infinity` to mean "nothing".
   */
  readonly candidates: readonly VillageNearbyCandidate[];
  /** The selected rows, in order. Derived by {@link createVillageNpcSnapshot}. */
  readonly nearby: readonly VillageNearbyTarget[];
  /**
   * Where a dialogue anchored to the NPC now in range attaches, or `null` when
   * nobody is in range.
   *
   * Survives the `dialogue` removal because it is geometry, not dialogue: it says
   * *where* a panel should put a bubble, and both renderers can answer that from
   * their own scene graph without knowing anything about quests.
   */
  readonly anchor: VillageNpcDialogAnchor | null;
}

/** The measurements a host hands to {@link createVillageNpcSnapshot}. */
export interface VillageNpcSnapshotInput {
  readonly candidates: readonly VillageNearbyCandidate[];
  readonly anchor?: VillageNpcDialogAnchor | null;
}

/**
 * Build a snapshot, applying the nearby-selection rules exactly once.
 *
 * The two fields cannot disagree because one is computed from the other, which is
 * the whole reason this is a factory rather than two independently-filled fields. An
 * empty snapshot is a value, not a special case: an NPC-less village reports
 * `{ candidates: [], nearby: [], anchor: null }` and a panel renders nothing rather
 * than branching on `undefined`.
 */
export function createVillageNpcSnapshot(input: VillageNpcSnapshotInput): VillageNpcSnapshot {
  return Object.freeze({
    candidates: Object.freeze([...input.candidates]),
    nearby: selectVillageNearbyTargets(input.candidates),
    anchor: input.anchor ?? null,
  });
}

/**
 * Compile-time proof that `dialogue` is gone from the snapshot, and that it stayed
 * gone.
 *
 * Written as a negation of `keyof`, so it fails `npm run typecheck` the moment
 * anybody re-adds the field - including as an optional one, and including as a
 * differently-named replacement, because the check is over *every* key rather than
 * over a hand-listed set of the ones that should be there.
 *
 * It is here rather than only in a test because a test cannot observe a type. A
 * `dialogue` that reappears would be assignable to every reader the moment it did,
 * and the only thing that would notice is a consumer reading it and finding `null`.
 */
export type VillageNpcSnapshotHasNoDialogueMember = AssertTrue<
  Exact<Extract<'dialogue', keyof VillageNpcSnapshot>, never>
>;

/**
 * Compile-time proof of the snapshot's exact member set, so the narrowing above is
 * an enumeration rather than a deletion nobody notices.
 *
 * `Exact<>` over `keyof` both ways: an added member fails, and so does a renamed or
 * removed one.
 */
export type VillageNpcSnapshotMembersAreExactlyThese = AssertTrue<
  Exact<keyof VillageNpcSnapshot, 'candidates' | 'nearby' | 'anchor'>
>;
