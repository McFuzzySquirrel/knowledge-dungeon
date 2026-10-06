/**
 * The eight village scene callbacks, bound to the study flow.
 *
 * ## Why this is a module and not a `useEffect` in the screen
 *
 * The bag is the *whole* of the screen's conversation with a renderer: three
 * structure events, four NPC events, and readiness. It is also where the
 * pre-Phase-12 screen's NPC dialogue logic lived - the Keeper's quest promotion,
 * the wanderer's random quote, the cycling line cursor - so it was the
 * second-largest block in the file after the flow's port literals.
 *
 * Both of those are now elsewhere, and what is left here is one honest translation
 * table: renderer event in, application state out.
 *
 * ## Why the bag is created once and mutated in place
 *
 * The renderer captures the bag at mount and holds it for the world's whole life,
 * so a bag rebuilt on every render would either be captured stale (the renderer's
 * callbacks would call the first render's closures) or would churn. The pre-Phase-12
 * screen solved this with `callbacksRef` plus an effect that `Object.assign`ed the
 * current implementations into it, and that is preserved exactly: the *shape* is
 * created once with no-op members, and the *implementations* are re-assigned
 * whenever their inputs change. A renderer that fires an event between two renders
 * therefore reaches a working callback rather than a no-op.
 *
 * ## Why the line cursor is a ref here and not screen state
 *
 * The pre-Phase-12 screen kept `keeperDialogueIndex` in `useState` and advanced it
 * from inside a *functional* `setState` updater - which is the only reason the
 * cycling was correct, and it meant the index was React state that existed solely
 * to compute a string. Here the cursor is a ref beside the bag it belongs to: it
 * has no UI, it must survive re-renders without causing one, and it is reset by
 * exactly the two events that ended or began a conversation. `resetConversation`
 * is still a prop, because the quest board's "choose a step" action resets the same
 * cursor and that is a *DOM* action, not a renderer event.
 *
 * ## This module is the single owner of line selection
 *
 * It used to be one of three. The contract declared the policy as a pure function,
 * the Pixi controller called it with `questStep: ''`, the Phaser adapter called it
 * with `questStep: ''`, and this module re-implemented `open`/`advance` inline - so
 * the same question had three answers, and the two renderer-side ones were wrong by
 * construction: a renderer does not know the learner's quest step, so the Keeper
 * fell through to her greeting instead of the tutorial script.
 *
 * The renderers no longer call it at all, and this module is now the only caller,
 * passing the **real** step from `useSessionStore`. That is the layer that *can*
 * answer the question: the quest step is application state, and a renderer reaching
 * for it would break the Phase 9 rule and create a second source of truth.
 *
 * So the split is by capability, not by preference - the renderer measures, the
 * application decides what to say.
 */
import { useEffect, useRef, type RefObject } from 'react';

import { VILLAGE_MAP, type VillageNpc } from '@/data/villageLayout';
import { useSessionStore } from '@/store/sessionStore';

import type { StudyFlowController } from '@/application/studyFlow';
import {
  selectVillageNpcLine,
  type VillageNpcDialogAnchor,
  type VillageNpcLineCursor,
  type VillageNpcLineSelection,
} from '@/application/contracts/villageNpc';

/**
 * The eight callbacks, with every member required.
 *
 * Stated locally so this UI module imports no renderer type: the shape is
 * structurally assignable to both the Phaser `VillageSceneEvents` and the Pixi
 * `VillageSceneCallbacks` (whose `onNpc*` members are optional), which is what
 * lets one bag feed either renderer.
 */
export interface VillageCallbacks {
  onStructureApproached: (structureId: string) => void;
  onStructureLeft: (structureId: string) => void;
  onStructureInteract: (structureId: string) => void;
  onNpcApproached: (npcId: string) => void;
  onNpcLeft: (npcId: string) => void;
  onNpcInteract: (npcId: string) => void;
  onNpcDialogPosition: (anchor: VillageNpcDialogAnchor) => void;
  onReady: () => void;
}

const NO_OPS: VillageCallbacks = {
  onStructureApproached: () => {},
  onStructureLeft: () => {},
  onStructureInteract: () => {},
  onNpcApproached: () => {},
  onNpcLeft: () => {},
  onNpcInteract: () => {},
  onNpcDialogPosition: () => {},
  onReady: () => {},
};

export interface VillageSceneCallbackSetters {
  readonly setActiveNpcId: (npcId: string | null) => void;
  readonly setActiveNpcLabel: (label: string | null) => void;
  readonly setKeeperDialogue: (line: string | null) => void;
  readonly setNpcDialogAnchor: (anchor: VillageNpcDialogAnchor | null) => void;
  readonly setVillageReady: (ready: boolean) => void;
}

/**
 * The Keeper's opening line for a quest step, or its greeting when it has none.
 *
 * Named because two places need it - approaching the Keeper, and choosing a step
 * from the quest board. It delegates to `selectVillageNpcLine` rather than reaching
 * into `questDialogue` itself, so this is a *name* for "the opening line" and not a
 * second implementation of how it is chosen: when the two call sites needed the same
 * answer, re-deriving it in each was how they drifted.
 *
 * `cursor: null` is what asks for the opening line rather than the next one.
 */
export function keeperLineFor(questStep: string): string | null {
  const keeper = VILLAGE_MAP.npcs.find((npc) => npc.id === 'keeper');
  if (keeper === undefined) return null;
  return selectVillageNpcLine({ npc: keeper, questStep, cursor: null }).line;
}

export interface VillageSceneCallbackOptions {
  /**
   * Phase 21: called with the structure identifier **immediately before** `flow.structureInteract`.
   *
   * ## Why this door, and not somewhere else
   *
   * This bag is the single route from any world into the flow. The Phaser scene's `interactStructure`,
   * the Pixi scene's `invokeAction`, the nearby-action row's shared data handler, and the `E` key all
   * arrive at `onStructureInteract` here, and there is no other path a renderer can take. A fact that
   * has to be true for *every* route belongs here rather than at each call site.
   *
   * ## What it is for: the pond identifier
   *
   * `studyFlow.structureInteract` calls its **own module-local** `enterFishing`, which calls
   * `villageUi.prepareFishingSession()` **before** `fishing.enter(...)` and passes it no arguments. So
   * by the time the fishing session is minted, the identifier the flow resolved is gone - and only the
   * pond panel's `Cast Line` button had recorded it.
   *
   * Every other route therefore entered the pond with no session context: `beginFishing(null)` returned
   * early, `catchKeep` refused with `NO_OPEN_SESSION`, and the learner was told *"This catch has no open
   * pond session, so the question cannot be asked."* That is the product's core loop, unreachable by
   * keyboard and by touch on the **shipping** renderer - `pixiFishing`'s production default is `false`,
   * and the Phaser pond adapter ignores `handlers.pondId`, so the Pixi lane's `onSessionStarted`
   * backstop does not exist on the default build.
   *
   * ## Why it records **every** identifier, not only ponds
   *
   * Because `structureIdRef` is consulted only when the flow has already decided to enter a pond, and
   * the flow's fishing branch is reachable only through this callback. So a library, a fountain or a
   * signpost writes a value that is never read - and the value it is overwritten with before it could
   * be is the pond the learner actually walked to.
   *
   * The alternative, filtering on `structure.type === 'fishing-pond'` here, would put a **second**
   * copy of the flow's structure-type dispatch in the UI: a second answer to "what is a pond", free to
   * drift from the one the flow actually enters on. This repository's headers are explicit that the
   * flow owns that table, and this is the case where following that rule is also the simpler code.
   *
   * ## Optional, so nothing else changes
   *
   * `undefined` means "no recording", which is the correct answer for every caller that does not need
   * it - and the only production caller that passes one passes it for this reason.
   */
  readonly onBeforeStructureInteract?: (structureId: string) => void;
}

/**
 * A stable bag whose implementations follow the latest render.
 *
 * `useEffect` rather than an assignment during render, because the renderers are
 * the only consumers and they act outside React: an assignment during render would
 * be a side effect of rendering, and a discarded render (StrictMode, a suspended
 * sibling) would have left a callback pointing at state from a commit that never
 * happened.
 */
export function useVillageSceneCallbacks(
  flow: StudyFlowController,
  setters: VillageSceneCallbackSetters,
  options: VillageSceneCallbackOptions = {},
): {
  readonly callbacks: RefObject<VillageCallbacks>;
  readonly resetConversation: () => void;
} {
  const ref = useRef<VillageCallbacks>({ ...NO_OPS });
  const settersRef = useRef(setters);
  settersRef.current = setters;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // The conversation cursor. `null` means "no conversation yet", which is exactly
  // what the contract's `VillageNpcLineRequest` reads to mean "open on the first
  // line" - so the two cannot disagree about what a fresh conversation is.
  const cursor = useRef<VillageNpcLineCursor | null>(null);

  const resetConversation = (): void => {
    cursor.current = null;
  };

  useEffect(() => {
    const apply = settersRef.current;

    /**
     * Choose the next line for `npc` and publish it.
     *
     * One call into the contract, and it is the only place in the application that
     * does. `cursor: null` opens a conversation on its opening line; passing the
     * stored cursor advances one line and cycles. Both cases are the contract's rule,
     * not a modulo written here, which is what the inline `open`/`advance` pair this
     * replaced was - and that pair disagreed with the contract on the unscripted
     * fallback, answering `dialogue[0]` where the contract answers the greeting.
     *
     * The quest step is read from the store on every turn rather than captured: a
     * conversation can outlive the step it opened on, and the contract decides what
     * to do when they differ (it restarts at the opening line, because the stored
     * index belonged to a script that is no longer on screen).
     */
    const show = (npc: VillageNpc, fresh: boolean): void => {
      const selection: VillageNpcLineSelection = selectVillageNpcLine({
        npc,
        questStep: useSessionStore.getState().questStep,
        cursor: fresh ? null : cursor.current,
        // A wanderer opens on a random quote. The randomness is supplied *here*,
        // rather than generated inside the contract, so the contract stays a pure
        // function and a test can pin the opening line.
        quoteIndex: fresh ? Math.floor(Math.random() * Math.max(1, npc.quotes?.length ?? 0)) : undefined,
      });
      cursor.current = selection.cursor;
      apply.setKeeperDialogue(selection.line);
    };

    const next: VillageCallbacks = {
      onStructureApproached: (structureId) => flow.structureApproached(structureId),
      onStructureLeft: (structureId) => flow.structureLeft(structureId),
      onStructureInteract: (structureId) => {
        // Phase 21: record first, then dispatch. The order is the whole fix - the recording has to
        // land before the flow runs, because the flow's own `prepareFishingSession` call is what reads
        // it, and that call happens synchronously inside `structureInteract`.
        optionsRef.current.onBeforeStructureInteract?.(structureId);
        flow.structureInteract(structureId);
      },
      onNpcApproached: (npcId) => {
        const npc = VILLAGE_MAP.npcs.find((candidate) => candidate.id === npcId);
        if (npc === undefined) return;
        apply.setActiveNpcId(npcId);
        apply.setActiveNpcLabel(npc.label);
        if (npcId === 'keeper') {
          const session = useSessionStore.getState();
          // The promotion goes through the store rather than through the screen's
          // setter, so a renderer event and a DOM action take the same path.
          if (session.questStep === 'intro' || session.questStep === 'meet-keeper') {
            session.setQuestStep('meet-keeper');
          }
        }
        show(npc, true);
      },
      onNpcLeft: () => {
        resetConversation();
        apply.setKeeperDialogue(null);
        apply.setActiveNpcId(null);
        apply.setActiveNpcLabel(null);
      },
      onNpcInteract: (npcId) => {
        const npc = VILLAGE_MAP.npcs.find((candidate) => candidate.id === npcId);
        if (npc === undefined) return;
        show(npc, false);
      },
      onNpcDialogPosition: (anchor) => {
        apply.setNpcDialogAnchor(anchor);
      },
      onReady: () => {
        // The Pixi path signals readiness through `VillageWorld`'s `onReady` prop;
        // the Phaser scene calls this bag. There is no renderer ref guard because
        // on the Pixi path there is deliberately no `rendererRef`.
        apply.setVillageReady(true);
      },
    };
    Object.assign(ref.current, next);
  }, [flow]);

  return { callbacks: ref, resetConversation };
}
