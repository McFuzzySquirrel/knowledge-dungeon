/**
 * The village screen's fishing: one session, one catch transaction, four outcomes.
 *
 * ## Why this is a hook and not a block in `VillageScreen.tsx`
 *
 * A gate, and a second reason. `tests/phase12/village-shell-split.test.ts` holds
 * `VillageScreen.tsx` under **900 lines** on the reasoning that "the composition root is the
 * *small* thing", and the Phase 17 DOM work - six controls, three recall outcomes, a redesigned
 * collection view, and a session lifecycle - took the screen from 879 to over 1100. The gate is
 * telling the truth it was written to tell: the catch flow is a unit, so it gets a unit.
 *
 * Independently, a screen that owns the catch transaction *and* the renderer switch *and* the
 * HUD factory is three concerns in one function body, and only one of them is composition.
 *
 * So this module owns **all** of the fishing state the screen used to hold inline - the session,
 * the catch context, the recall question, the status sentence, and the controls factory - and
 * hands the screen a small object. The screen keeps exactly one line per concern, which is what
 * its own header table promises.
 *
 * ## Why it lives in `src/ui/screens/` and not `src/ui/fishing/`
 *
 * `tests/phase17/fishing-control-ids.test.ts` holds `src/ui/fishing/**` renderer-free, and this
 * hook is where the lane's *renderer* switch is read. So the DOM-only components live in
 * `src/ui/fishing/**` and this wiring lives beside the two modules that already talk to a
 * renderer: `PixiFishingLane.tsx` (the flag and the chunk) and `VillageScreen.tsx` (the village
 * renderer handle). Both are in `src/ui/screens/`, which is where the repository already puts
 * type-only renderer reaches - `VillageScreen`'s `VillageWorldHandle` and `GameScreen`'s
 * `DungeonWorldHandle` are the precedent.
 *
 * ## What this hook replaced, and what it fixed
 *
 * `VillageScreen.handleKeepFish` was the whole catch transaction, in three non-transactional store
 * writes, with the subject derived as `Object.keys(bySubject)[length - 1]` - described in its own
 * comment as "the most recently active one", which is insertion order and therefore the most
 * recently *created* record - falling back to the literal string `'village'`.
 *
 * It now:
 *
 * - mints **one** session context at pond entry, from the active subject and the pond the learner
 *   cast from, so eligibility, recall selection, and persistence are derived from one value;
 * - commits the whole catch as **one** command through `fishing/catch-keep`, one record write,
 *   deduplicated on (context, catalogue id, cast number);
 * - commits one of **four** outcomes rather than "correct or nothing", which is what makes "kept
 *   with no recall material" a distinct event paying no XP; and
 * - **logs nothing**. The two `console.log`s that printed the XP, the rank, and the joined badge
 *   ids on every catch are gone, and nothing replaced them: the reward is a sentence the learner
 *   reads.
 *
 * `src/ui/fishing/fishingSession.ts` owns the decisions and is documented in full; this is the
 * wiring of them.
 *
 * ## The ordering problem this hook exists partly to solve
 *
 * `studyFlow.enterFishing(structureId)` calls `prepareFishingSession()` **before**
 * `fishing.enter(...)`, and `prepareFishingSession` receives no arguments. So at the moment the
 * session must be minted, the only pond identifier the screen has is the one it recorded itself
 * in `onCastLine`. Two mechanisms bridge that, and both are needed:
 *
 * 1. `beginFishing(structureId)` is called from `prepareFishing`, seeded with the recorded
 *    structure id.
 * 2. The lane's `onSessionStarted(pondId)` re-runs the begin with the identifier the flow itself
 *    resolved, and `beginSessionRef` is what lets the hook's own `beginFishing` be called from
 *    inside a callback the hook hands to the lane - a direct reference would be a
 *    temporal-dead-zone read if the flow invoked it before the hook returned.
 *
 * Both values are the same structure id, which is exactly the point: eligibility, the session,
 * and persistence now read one identifier rather than three derivations.
 *
 * ## No renderer, no engine, no learner data
 *
 * Nothing here names a subject, a room, or a fish in an id or an attribute.
 *
 * ## The one flag both lanes have to agree about
 *
 * `active` is the single fact behind `data-world="fishing"`, behind the "You have started
 * fishing" live region, and behind whether the catch surfaces exist at all. It is set in exactly
 * one place - the flow's `prepareFishingSession`, which runs only after the flow's own mount
 * guard proved a world host exists - and cleared in exactly one function, `endSession`.
 *
 * That single clear is the point. The two lanes report their own endings through different doors:
 * the Pixi pond's return control calls the lane's teardown directly, while `FishingScene`'s
 * `ESC` binding and its in-scene return button both dispatch the same handler, which reaches the
 * flow's `fishing/exit` and therefore this hook's `endSession` through `villageStudyFlow`. Wiring
 * only the first door is how the rollback lane - the artifact that ships - learned to say "You have
 * started fishing" to a learner standing in the village. See `endSession`'s own table.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { useSubjectStore } from '@/store/subjectStore';
import { getClearedRooms, pullRecallQuestion } from '@/core/fishing/fishingMechanics';
import type { SelfCheckPrompt } from '@/core/review/types';
import type { FishRarity } from '@/core/fishing/fishingTypes';
import { FishingHud } from '@/ui/fishing/FishingHud';
import type { FishingHudPort } from '@/ui/fishing/fishingHudPort';
import {
  beginFishingSession,
  endFishingSession,
  fishingRewardSentence,
  keepFishingCatch,
  readFishingSession,
  releaseFishingCatch,
  type FishingCatchContext,
} from '@/ui/fishing/fishingSession';
import type { RecallRoomDestination } from '@/ui/fishing/fishingRecallNavigation';
import { usePixiFishingLane, type PixiFishingLane } from '@/ui/screens/PixiFishingLane';
import type { FishingRecallChoice } from '@/ui/components/FishingRecallModal';
import type { VillageFishCatch } from '@/ui/village/VillageLaunchers';

/** What the catch card needs, as the screen's flow ports carry it. */
export interface CaughtFish {
  readonly fishName: string;
  readonly rarity: FishRarity;
  readonly catalogId: string;
  readonly description: string;
}

/** The recall question, as the flow's data shapes it. */
export interface FishingRecallQuestion {
  readonly prompt: SelfCheckPrompt;
  readonly roomId: string;
}

export interface UseVillageFishing {
  /** The lane the screen renders. Pass it to `PixiFishingLaneSurface`. */
  readonly lane: PixiFishingLane;
  /** The DOM controls factory, or `null` on a build with no Pixi pond. */
  readonly renderControls: ((port: FishingHudPort) => JSX.Element) | null;
  /**
   * Whether a fishing session is open, on **either** lane.
   *
   * The single fact behind `data-world`, the "You have started fishing" live region, and the
   * catch surfaces, so those three cannot disagree with one another or with the world. See
   * {@link UseVillageFishing.endSession} for what keeps it honest.
   */
  readonly active: boolean;
  /** The catch being offered, or `null`. */
  readonly catch: VillageFishCatch | null;
  /** Whether the recall dialog is open - separately from whether it has a question. */
  readonly recallOpen: boolean;
  /** The recall question, or `null` when the pond had none. */
  readonly recallQuestion: FishingRecallQuestion | null;
  /** Where the question's "open that room" route goes, or `null`. */
  readonly recallDestination: RecallRoomDestination | null;
  /** One sentence about what the last catch decision did, or `null`. */
  readonly status: string | null;
  /**
   * The flow's `prepareFishingSession` port.
   *
   * Called by `studyFlow.enterFishing` **after** its own mount guard has passed, so a pond that
   * never mounts never mints a context and no command can commit against one.
   */
  readonly prepareSession: () => void;
  /**
   * The flow's `finishFishingSession` port: a session ended on a lane that cannot report it
   * itself.
   *
   * Bind it to `createVillageStudyFlow`'s `finishFishingSession` option. The **Phaser** rollback
   * lane's world stops its own scenes and reports nothing to the DOM, so before this existed the
   * learner walked out of `FishingScene` with `data-world="fishing"` and a live region still
   * announcing "You have started fishing". Wired to the flow's single `fishing/exit`, it now
   * covers every route out of that scene - its `ESC` binding and its in-scene return button -
   * because both dispatch the same `onReturnToVillage` handler.
   */
  readonly endSession: () => void;
  /** The flow's `setFishCaught` port. */
  readonly onFishCaught: (data: CaughtFish | null) => void;
  /** Record the structure the learner cast from, then enter. */
  readonly castFrom: (structureId: string) => void;
  readonly onKeep: () => void;
  readonly onRelease: () => void;
  readonly onDecide: (choice: FishingRecallChoice, roomId: string | null) => void;
  readonly onCancelRecall: () => void;
}

/**
 * The screen's fishing surface.
 *
 * @param enterFishing the flow's `enterFishing(structureId)`, so `castFrom` can record the pond
 *   and enter it in that order without this module importing the flow.
 * @param pondPresent whether **this build** has a Pixi fishing pond. A parameter rather than an
 *   import of the lane module's `pixiFishing` flag, for the reason this module reaches no
 *   renderer at all: the screen is the composition root, it already reads the flag, and a
 *   boolean parameter is a smaller coupling than a module import.
 */
export function useVillageFishing(
  enterFishing: (structureId: string) => void,
  pondPresent: boolean,
): UseVillageFishing {
  const [sessionOpen, setSessionOpen] = useState(false);
  const [fishCaughtData, setFishCaughtData] = useState<VillageFishCatch | null>(null);
  const [showRecallModal, setShowRecallModal] = useState(false);
  const [recallQuestionData, setRecallQuestionData] = useState<FishingRecallQuestion | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /**
   * The catch's identity for the transaction: canonical catalogue id, rarity, and the cast that
   * produced it.
   *
   * Recorded when the catch is **revealed**, not when the learner decides, because the catch
   * identity is (session, catalogue id, cast number) and a number assigned at decision time
   * would describe the click order rather than the catch.
   */
  const [catchContext, setCatchContext] = useState<FishingCatchContext | null>(null);

  /**
   * The structure the learner cast from.
   *
   * `studyFlow.enterFishing(structureId)` receives it and `prepareFishingSession()` does not, so
   * it is recorded here before the flow runs. It is the same value the flow uses as its
   * `pondId`.
   */
  const structureIdRef = useRef<string | null>(null);

  /**
   * The pond identity, for the same reason - and a ref rather than state, because the session is
   * begun from a port that is created once and closes over whatever this render's values were.
   */
  const pondIdRef = useRef<string | null>(null);

  /**
   * `beginFishing`, published for the lane's callback.
   *
   * A ref, not a direct reference: the lane's `enter` fires while the flow is mid-`enterFishing`,
   * and a direct call would be a temporal-dead-zone read if it happened before this hook returned.
   */
  const beginRef = useRef<(pondId: string | null) => void>(() => {});
  /**
   * The lane's session-started callback, with a **stable identity**.
   *
   * It was an inline arrow, which the lane then depended on: `VillageScreen` builds its study
   * flow once inside a ref guard, so the `readPixiFishingHost` it keeps for the life of the
   * screen closes over one lane object. A lane whose host is rebuilt every render would be
   * publishing a different host to a caller that kept the first one.
   */
  const handleSessionStarted = useCallback((pondId: string) => {
    if (pondId.length > 0) beginRef.current(pondId);
  }, []);
  /**
   * Close every surface a fishing session owns, and say the session is over.
   *
   * ## One function, reached from every exit route
   *
   * Four routes end a fishing session, and they reach this by two doors:
   *
   * | route | lane | door |
   * | --- | --- | --- |
   * | the renderer's own return control (HUD button, canvas action) | Pixi | `lane.onSessionChange(false)` |
   * | the flow's `fishing/exit`, from any screen-level exit | Pixi | `flow.finishFishingSession` → `host.returnToVillage()` |
   * | `FishingScene`'s `ESC` binding | Phaser | `flow.finishFishingSession` |
   * | `FishingScene`'s in-scene return button | Phaser | `flow.finishFishingSession` |
   * | the screen unmounting | either | the cleanup effect below |
   *
   * Before this existed, only the two Pixi rows cleared the flag, so on the **rollback** lane -
   * the one that ships by default - `Escape` left `data-world="fishing"` and the live region
   * still announcing "You have started fishing" while the learner stood in the village. That is
   * a learner-visible false sentence, and it was false precisely on the lane with the least
   * scrutiny.
   *
   * `status` is deliberately **not** cleared. It is the one learner-visible record of what a
   * catch decision did, it is deliberately rendered independently of the dialog's lifetime, and
   * the pond closing is not a reason to withdraw a sentence that is still true.
   */
  const endSession = useCallback(() => {
    setSessionOpen(false);
    setFishCaughtData(null);
    setCatchContext(null);
    setShowRecallModal(false);
    setRecallQuestionData(null);
  }, []);
  /**
   * The lane's open/closed signal, with a **stable identity**.
   *
   * Stable because the lane's published host is memoised on it, and
   * `VillageScreen`'s study flow keeps whichever host its first render published.
   */
  const handleSessionChange = useCallback(
    (active: boolean) => {
      // `true` is the lane saying a session opened; `false` is it saying one closed. Routing
      // both through one function is what keeps `sessionOpen` and the lane's own `session` from
      // being two flags with two teardowns.
      if (active) setSessionOpen(true);
      else endSession();
    },
    [endSession],
  );
  const lane = usePixiFishingLane(handleSessionChange, handleSessionStarted);
  const laneRef = useRef(lane);
  laneRef.current = lane;

  /**
   * The pond's DOM controls.
   *
   * A **factory**, because `FishingHud` needs the world's imperative handle and that handle is a
   * `useImperativeHandle` that exists only after the lazy chunk's commit.
   *
   * `null` - no factory - is the honest "this build has no Pixi pond", and the lane renders
   * nothing at all in that case, so `VITE_PIXI_FISHING=false` is unchanged by this phase.
   */
  const renderControls = useMemo<((port: FishingHudPort) => JSX.Element) | null>(
    () => (pondPresent ? (port: FishingHudPort) => <FishingHud port={port} /> : null),
    [pondPresent],
  );

  /** Begin the one fishing session, or refuse visibly. */
  const beginFishing = useCallback((structureId: string | null) => {
    pondIdRef.current = structureId;
    const pondId = laneRef.current.session?.pondId ?? structureId;
    if (pondId === null || pondId.length === 0) return;
    const snapshot = useSubjectStore.getState().snapshot;
    // The **active subject**, deliberately, rather than the village layout's nearest portal
    // slot - which is the derivation `fishingCommands`' own header records as the one that let
    // eligibility and persistence disagree.
    const subjectId = snapshot?.dungeon.dungeonId ?? '';
    const subjectName = snapshot?.dungeon.subjectName ?? '';
    if (beginFishingSession({ pondId, subjectId, subjectName }) === null) {
      // No context means every later `catchKeep` refuses with `NO_OPEN_SESSION`. Say so where the
      // learner is entering the pond, rather than after a catch they thought they kept.
      setStatus('This pond could not be opened for study, so catches here cannot be saved.');
    }
  }, []);

  useEffect(() => {
    beginRef.current = beginFishing;
  }, [beginFishing]);

  /** Close the session, so nothing can commit after the pond does. */
  const finishFishing = useCallback(() => {
    endFishingSession();
    pondIdRef.current = null;
  }, []);

  // Two triggers, both needed: `sessionOpen` going false covers every exit route (the Pixi
  // lane's own teardown, the flow's `fishing/exit`, and the Phaser scene's return control once
  // they all reach `endSession`); the mount/unmount effect covers the screen itself being torn
  // down, where a stale context would otherwise outlive the surface that minted it.
  useEffect(() => {
    if (sessionOpen) return;
    finishFishing();
  }, [sessionOpen, finishFishing]);
  useEffect(() => finishFishing, [finishFishing]);

  /**
   * A revealed catch, with the cast number that identifies it.
   *
   * `takePendingCatch` is *consuming*, so two reveals in a row cannot both claim the same cast
   * number - which is the failure mode that would deduplicate the second catch in the reward
   * ledger and lose a fish.
   */
  const onFishCaught = useCallback((data: CaughtFish | null) => {
    if (data === null) {
      setFishCaughtData(null);
      setCatchContext(null);
      return;
    }
    const pending = laneRef.current.takePendingCatch();
    const castNumber =
      pending !== null && pending.catalogId === data.catalogId ? pending.castNumber : 1;
    setCatchContext({ catalogId: data.catalogId, rarity: data.rarity, castNumber });
    setFishCaughtData(data);
  }, []);

  /**
   * The flow's `prepareFishingSession` port: the surfaces a *new* session owns, closed.
   *
   * The mirror image of {@link endSession}, and deliberately clearing the same set plus `status`
   * - a pond that refused to open leaves no sentence from a previous trip behind it. Called only
   * after the flow's own mount guard passed, so `sessionOpen` going true is a fact rather than an
   * attempt.
   */
  const prepareSession = useCallback(() => {
    setFishCaughtData(null);
    setShowRecallModal(false);
    setRecallQuestionData(null);
    setCatchContext(null);
    setStatus(null);
    setSessionOpen(true);
    beginFishing(structureIdRef.current);
  }, [beginFishing]);

  /** Record the pond, then enter it. Order matters; `enterFishing` is synchronous. */
  const castFrom = useCallback(
    (structureId: string) => {
      structureIdRef.current = structureId;
      enterFishing(structureId);
    },
    [enterFishing],
  );

  /**
   * Open the recall question, or keep the fish without one.
   *
   * The question is pulled from the **session's** subject rather than from `activeSubjectId`,
   * which is plan 5.3's second derivation removed: a learner could be asked a question from one
   * subject and have the fish filed under another.
   */
  const onKeep = useCallback(() => {
    const session = readFishingSession();
    if (session === null) {
      setStatus('This catch has no open pond session, so the question cannot be asked.');
      setRecallQuestionData(null);
    } else {
      const snapshot = useSubjectStore.getState().snapshot;
      let question: FishingRecallQuestion | null = null;
      // Only the session's own subject supplies material. A different loaded subject is a
      // different learner's state, and reading it would be the very mismatch this avoids.
      if (snapshot !== null && snapshot.dungeon.dungeonId === session.subjectId) {
        question = pullRecallQuestion({
          clearedRooms: getClearedRooms(snapshot.rooms),
          dungeonRooms: snapshot.dungeon.rooms,
          subjectName: snapshot.dungeon.subjectName,
        });
      }
      setRecallQuestionData(question);
    }
    setShowRecallModal(true);
  }, []);

  /**
   * Commit the learner's decision, as one transaction.
   *
   * **One** call for all three choices, deliberately. The failed-recall case used to be
   * special-cased here as `setFishCaughtData(null)`, which awarded nothing *by omission* - the
   * same result, reached by a branch that said nothing about it, so nothing stopped the next edit
   * from writing something. Now the transaction itself declines: no fish, no XP, no badge, no
   * ledger row.
   */
  const onDecide = useCallback(
    (choice: FishingRecallChoice, roomId: string | null) => {
      if (fishCaughtData === null || catchContext === null) return;
      setStatus(fishingRewardSentence(keepFishingCatch(catchContext, choice, roomId)));
      setFishCaughtData(null);
      setShowRecallModal(false);
      setRecallQuestionData(null);
      setCatchContext(null);
    },
    [catchContext, fishCaughtData],
  );

  /**
   * Release the catch.
   *
   * `fishing/catch-release` writes nothing at all - it does not even call the progression port -
   * so this is a rule in the command layer and not a promise this callback makes.
   */
  const onRelease = useCallback(() => {
    if (catchContext !== null) {
      setStatus(fishingRewardSentence(releaseFishingCatch(catchContext)));
    }
    setFishCaughtData(null);
    setShowRecallModal(false);
    setRecallQuestionData(null);
    setCatchContext(null);
  }, [catchContext]);

  /** Dismiss the recall dialog without committing. Writes nothing, and loses nothing. */
  const onCancelRecall = useCallback(() => {
    setFishCaughtData(null);
    setShowRecallModal(false);
    setRecallQuestionData(null);
    setCatchContext(null);
  }, []);

  /**
   * Where the question's "open that room" route goes.
   *
   * `sessionOpen` is a dependency on purpose: the session slot is cleared when the pond closes,
   * and a route built from a slot that has since emptied would send a learner to a room
   * belonging to a pond that is no longer open.
   */
  const recallDestination = useMemo<RecallRoomDestination | null>(() => {
    const session = readFishingSession();
    if (session === null || recallQuestionData === null) return null;
    return { subjectId: session.subjectId, roomId: recallQuestionData.roomId };
  }, [recallQuestionData, sessionOpen]);

  return {
    lane,
    renderControls,
    active: sessionOpen,
    catch: fishCaughtData,
    recallOpen: showRecallModal,
    recallQuestion: recallQuestionData,
    recallDestination,
    status,
    prepareSession,
    endSession,
    onFishCaught,
    castFrom,
    onKeep,
    onRelease,
    onDecide,
    onCancelRecall,
  };
}