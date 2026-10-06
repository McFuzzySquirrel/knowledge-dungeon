import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useSessionStore, type QuestStep } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { usePreferencesStore, type ColorTheme } from '@/store/preferencesStore';
import { useProgressionStore } from '@/store/progressionStore';
import { useLoadSubjectFlow } from '@/ui/hooks/useLoadSubjectFlow';
import { type VillageStructure, getDungeonPortalSlots } from '@/data/villageLayout';
import type { PlayerClassId } from '@/game/systems/playerClasses';
import type { VillageWorldModel, WorldPointOfInterest } from '@/application/contracts/world';
import type { VillageRendererCapabilities, WorldRenderer } from '@/application/contracts/renderer';
import type { VillageNpcSnapshot } from '@/application/contracts/villageNpc';
import type { VillageWorldHandle } from '@/renderers/pixi/village/VillageWorld';
import type { StudyFlowVillageInfoPanel } from '@/application/studyFlow';
import type { FloorBiomeId } from '@/core/biomes';
import { pixiFishing, PixiFishingLaneSurface } from '@/ui/screens/PixiFishingLane';
import { useVillageFishing } from '@/ui/screens/useVillageFishing';
import { runtimeConfig } from '@/config/featureFlags';
import { listSubjectIds, loadSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { createTutorialSubject, TUTORIAL_SUBJECT_ID } from '@/data/tutorialSubject';
import { computeSessionStats } from '@/services/sessionTracker';
import type { StudyFlowController } from '@/application/studyFlow';
import {
  createVillageStudyFlow,
  type VillageFishingHost,
} from '@/ui/village/villageStudyFlow';
import { keeperLineFor, useVillageSceneCallbacks } from '@/ui/village/villageSceneCallbacks';

import { CompassOverlay } from '@/ui/village/CompassOverlay';
import { VillageZoomReadOut } from '@/ui/village/VillageZoomReadOut';
import { useVillageZoomReader } from '@/ui/village/useVillageZoomReader';
import { CreateSubjectDialog } from '@/ui/village/CreateSubjectDialog';
import { DataManagementDialog } from '@/ui/village/DataManagementDialog';
import { NpcDialog } from '@/ui/village/NpcDialog';
import { QuestBoard } from '@/ui/village/QuestBoard';
import {
  StructurePanel,
  structureAnnouncement,
  useVillageFishingHint,
} from '@/ui/village/StructurePanel';
import { useVillageActionHandler } from '@/ui/village/NearbyActionList';
import {
  readVillagePlayerGridPosition,
  useVillagePlayerPositionAttribute,
} from '@/ui/village/villagePlayerPosition';
import { useVillageNpcSurface, type VillageActionBridge } from '@/ui/village/useVillageNpcSurface';
import { useVillageSurfaceMode } from '@/ui/village/useVillageSurfaceMode';
import { VillageHud } from '@/ui/village/VillageHud';
import { VillageLaunchers } from '@/ui/village/VillageLaunchers';
import { AssistanceSlot } from '@/ui/assistance/AssistanceSlot';
import type { VillageCollectionTotals, VillageStudyTotals, VillageSubjectSummary } from '@/ui/village/villageTypes';

// The panel-arrival announcement this screen renders is the only thing here that
// needs a village stylesheet directly; the panels import it themselves.
import '@/ui/village/villagePanels.css';

/**
 * The build-time village renderer switch (Phase 11).
 *
 * ## Why the comparison is against a literal
 *
 * `import.meta.env.VITE_PIXI_VILLAGE` is substituted as a string literal at build
 * time, so a *literal* `=== 'true'` lets the bundler fold the branch and delete
 * the other arm - along with the dynamic `import()` inside it, and therefore with
 * the whole renderer chunk that import pulls in. A normalising call first
 * (`String(raw).trim().toLowerCase()`) reads the same at run time and defeats the
 * folding, so the default build keeps a Pixi village chunk it would never fetch.
 * This mirrors `src/ui/App.tsx`'s `VITE_WORLD_RENDERER` switch exactly.
 *
 * The parsed run-time value is `runtimeConfig.pixiVillage`. The two are used for
 * two jobs, as in App.tsx: this literal decides what the bundler may delete, and
 * the parsed flag produces a defined mismatch message below instead of a silent
 * fallback when the environment value was not literally `true`.
 */
const pixiVillageFactory =
  import.meta.env.VITE_PIXI_VILLAGE === 'true'
    ? () => import('@/renderers/pixi/village/VillageWorld')
    : null;

const phaserVillageFactory =
  import.meta.env.VITE_PIXI_VILLAGE === 'true'
    ? null
    : () => import('@/game/createVillageGame');

/**
 * The lazy Pixi village chunk, or `null` on a build that did not request it.
 *
 * Computed once at module scope: a `lazy()` call inside the component would mint a new
 * component type on every render and remount the world.
 */
const LazyPixiVillageWorld = pixiVillageFactory !== null ? lazy(pixiVillageFactory) : null;

/**
 * The renderer handle this screen drives, in renderer-neutral terms.
 *
 * It is the Phase 2 lifecycle plus the village capability port. `onReady` and
 * `fishing` are the Phaser adapter's additions, stated as optional members so the
 * type is structural rather than a static import of a renderer module. The Pixi
 * path reports readiness through `VillageWorld`'s `onReady` prop instead and does
 * not mount a `rendererRef` at all.
 */
type VillageRendererHandle = WorldRenderer &
  VillageRendererCapabilities & {
    onReady?: (listener: () => void) => () => void;
    fishing?: () => VillageFishingHost;
  };

/** The glyph each NPC is drawn with in the dialogue bubble. */
const NPC_ICONS: Readonly<Record<string, string>> = Object.freeze({
  keeper: '🧙',
  'villager-1': '📚',
  'villager-2': '🧭',
  'villager-3': '❓',
  'villager-4': '🦉',
  'villager-5': '📜',
});

/**
 * Read and clear the one-shot village spawn override.
 *
 * Consumed exactly once per screen mount, so both renderer paths receive the same
 * point and the key is removed before either can mount.
 */
function readVillageSpawnPoint(): { gridX: number | null; gridY: number | null } {
  let gridX: number | null = null;
  let gridY: number | null = null;
  try {
    const raw = localStorage.getItem('kd-village-spawn');
    if (raw) {
      const parsed = JSON.parse(raw) as { gridX?: number | null; gridY?: number | null };
      gridX = parsed.gridX ?? null;
      gridY = parsed.gridY ?? null;
      localStorage.removeItem('kd-village-spawn');
    }
  } catch { /* ignore */ }
  return { gridX, gridY };
}

/**
 * The village screen: the composition root for the whole village route.
 *
 * ## What this file owns now, and what it delegates
 *
 * Phase 12 split this screen, which was 1798 lines, into `src/ui/village/**`. What
 * is left here is the composition root and nothing else:
 *
 * | Concern                                        | Owner                                |
 * |------------------------------------------------|---------------------------------------|
 * | The build-time Phaser/Pixi switch                | here, deliberately                    |
 * | The imperative handles for whichever renderer     | here                                  |
 * | The study-flow controller and its store ports     | here (the flow is application logic)  |
 * | Subject loading and the portal-slot projection    | here (a renderer-neutral world model) |
 * | Everything else - HUD, panels, compass, nearby actions, zoom read-out | `src/ui/village/**` |
 *
 * The switch stays here for two reasons that are not about tidiness: it is the module the bundler folds and
 * it must be a *literal* `=== 'true'` comparison in one place, and it decides which of two renderer handles
 * exists, which is a fact about the whole screen rather than any one panel.
 *
 * ## The renderer reads, and the two models on top of them
 *
 * `readPoi`, `readNpcSnapshot`, `readCameraState` and `invokeAction` are read through this screen so no
 * panel has to know which renderer is mounted. Two models sit on top of them:
 *
 * - **Sampled, never polled per frame.** `CompassOverlay` holds `readPoi` in a ref and samples it on a
 *   throttled interval, writing the needle's transform straight to the DOM; it has no state at all, so a
 *   moving player cannot cause a render. `VillageZoomReadOut` (Phase 21) is the same shape and reads only
 *   `readCameraState().zoom` - the centre changes every frame and is read by nothing. See their files.
 * - **Derived to a value, then compared.** `useVillageNpcSurface` turns `readNpcSnapshot` into at most two
 *   derived rows rather than a scene reference, and compares them before committing, so walking costs a
 *   comparison and crossing a proximity boundary costs one render. An NPC event is a nudge that samples
 *   immediately, never the source of truth.
 *
 * ## Feature detection, and what happens when an adapter has not caught up
 *
 * `readNpcSnapshot`, `readCameraState` and `invokeAction` are optional on the capability port. This screen
 * passes them down **as functions or as `undefined`**, never as a stub that does nothing, and the DOM
 * decides what to say about it: no snapshot means an empty list with a sentence, no dispatcher means the rows
 * are present, disabled, and described, no camera means the zoom read-out is hidden. There is no state in
 * which a village button silently does nothing.
 */
export function VillageScreen(): JSX.Element {
  const setPhase = useSessionStore((s) => s.setPhase);
  const setSelectedClass = useSessionStore((s) => s.setSelectedClass);
  const selectedClass = useSessionStore((s) => s.selectedClass);
  const setActiveScreen = useSessionStore((s) => s.setActiveScreen);
  const questStep = useSessionStore((s) => s.questStep);
  const setQuestStep = useSessionStore((s) => s.setQuestStep);
  const advanceQuestStep = useSessionStore((s) => s.advanceQuestStep);
  const importSnapshot = useSubjectStore((s) => s.importSnapshot);
  const loadSubjectFlow = useLoadSubjectFlow();
  const colorTheme = usePreferencesStore((s) => s.colorTheme);
  const setColorTheme = usePreferencesStore((s) => s.setColorTheme);
  const sceneRestartCounter = useSessionStore((s) => s.sceneRestartCounter);
  const initSubject = useSubjectStore((s) => s.initSubject);
  const bySubject = useProgressionStore((s) => s.bySubject);
  const xpTotal = useProgressionStore((s) => s.xpTotal);
  const rank = useProgressionStore((s) => s.rank);
  const sessionStats = useMemo(() => computeSessionStats(), []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // The Phaser path's own handle; null on the Pixi path, which owns its renderer behind the ref below.
  const rendererRef = useRef<VillageRendererHandle | null>(null);
  const pixiVillageRef = useRef<VillageWorldHandle | null>(null);

  // Build-time branch: `pixiVillageFactory` is non-null only on a build whose
  // `VITE_PIXI_VILLAGE` was literally `true`. `pixiVillageMismatch` distinguishes
  // that build-time fact from the parsed run-time flag, so a spelled-differently
  // value produces a visible message rather than a silent Phaser fallback.
  const pixiVillage = pixiVillageFactory !== null;
  const pixiVillageMismatch = runtimeConfig.pixiVillage && pixiVillageFactory === null;


  // The one-shot spawn override, read once and shared by whichever renderer
  // mounts. The ref guard keeps StrictMode's double render from consuming it on
  // the first pass and seeing an already-cleared key on the second.
  const spawnRef = useRef<{ gridX: number | null; gridY: number | null } | null>(null);
  if (spawnRef.current === null) {
    spawnRef.current = readVillageSpawnPoint();
  }
  const spawn = spawnRef.current;

  const [subjects, setSubjects] = useState<VillageSubjectSummary[]>([]);
  const [infoPanel, setInfoPanel] = useState<StudyFlowVillageInfoPanel | null>(null);
  const [keeperDialogue, setKeeperDialogue] = useState<string | null>(null);
  const [activeNpcId, setActiveNpcId] = useState<string | null>(null);
  const [activeNpcLabel, setActiveNpcLabel] = useState<string | null>(null);
  const [npcDialogAnchor, setNpcDialogAnchor] = useState<
    { npcId: string; clientX: number; clientY: number } | null
  >(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [villageReady, setVillageReady] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [makeItYoursOpen, setMakeItYoursOpen] = useState(false);
  const [showFishStand, setShowFishStand] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState<string | null>(null);

  const surfaceMode = useVillageSurfaceMode();
  const showFishingHint = useVillageFishingHint(infoPanel?.type ?? null);

  const totals = useMemo<VillageCollectionTotals>(
    () => ({
      badges: Object.values(bySubject).reduce((sum, entry) => sum + entry.badges.length, 0),
      artifacts: Object.values(bySubject).reduce((sum, entry) => sum + entry.inventory.length, 0),
      notes: Object.values(bySubject).reduce((sum, entry) => sum + entry.collectedNotes.length, 0),
      dungeons: subjects.length,
    }),
    [bySubject, subjects],
  );

  const studyTotals = useMemo<VillageStudyTotals>(
    () => ({
      totalSessions: sessionStats.totalSessions,
      totalMinutesStudied: sessionStats.totalMinutesStudied,
      totalNotesSubmitted: sessionStats.totalNotesSubmitted,
      totalReviewsCompleted: sessionStats.totalReviewsCompleted,
      recentStreak: sessionStats.recentStreak,
      rank,
      xpTotal,
    }),
    [sessionStats, rank, xpTotal],
  );

  const refreshSubjects = useCallback(async () => {
    try {
      const ids = await listSubjectIds();
      const snapshots = await Promise.all(ids.map((id) => loadSubjectSnapshot(id)));
      const summaries: VillageSubjectSummary[] = ids.map((id, i) => {
        const s = snapshots[i];
        return {
          id,
          subjectName: s?.dungeon.subjectName ?? id,
          roomCount: s?.dungeon.rooms.length ?? 0,
          clearedRoomCount: s
            ? Object.values(s.rooms).filter((r) => r.validationState.finalPass).length
            : 0,
        };
      });
      setSubjects(summaries);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshSubjects();
  }, [refreshSubjects]);

  // Advance quest when archetype selected
  useEffect(() => {
    if (selectedClass && questStep === 'pick-archetype') {
      advanceQuestStep();
    }
  }, [selectedClass, questStep, advanceQuestStep]);

  const dynamicStructures = useMemo((): VillageStructure[] => {
    const slots = getDungeonPortalSlots();
    return subjects.slice(0, slots.length).map((subj, i) => ({
      id: `portal-${subj.id}`,
      type: 'portal-icon' as const,
      label: subj.subjectName,
      gridX: slots[i].gridX,
      gridY: slots[i].gridY,
      width: 2,
      height: 3,
      subjectId: subj.id,
      subjectName: subj.subjectName,
      roomCount: subj.roomCount,
      clearedCount: subj.clearedRoomCount,
    }));
  }, [subjects]);

  // The renderer-neutral model this screen presents, shared by the Pixi `world`
  // prop and the Phaser mount below. `VillageWorld` syncs changes to this prop in
  // place, so it is the single source of truth for either renderer.
  const worldModel = useMemo<VillageWorldModel>(
    () => ({ kind: 'village', structures: dynamicStructures, playerClass: selectedClass }),
    [dynamicStructures, selectedClass],
  );

  /**
   * The active renderer, whichever one is mounted.
   *
   * The restart, world sync, and touch interact read through these so the rest of
   * the screen does not branch on the renderer. On the Pixi path the renderer
   * lives behind `VillageWorld`'s ref; on the Phaser path it is this screen's own.
   * Each returns/does nothing until its renderer has mounted.
   */
  const readPoi = useCallback((): WorldPointOfInterest | null => {
    if (pixiVillage) return pixiVillageRef.current?.readPoi() ?? null;
    return rendererRef.current?.readPoi() ?? null;
  }, [pixiVillage]);


  /**
   * The mounted handle, or `null`.
   *
   * One named function rather than the same ternary twice, because the two reads
   * below must never disagree about *which* renderer they are talking to - a
   * snapshot from one adapter and an invocation routed to the other would produce
   * a list whose rows name targets the other world does not have.
   */
  const activeCapabilities = useCallback((): VillageRendererCapabilities | null => {
    return pixiVillage ? pixiVillageRef.current : rendererRef.current;
  }, [pixiVillage]);

  // Phase 21: the village's zoom, read without naming a renderer - see `useVillageZoomReader`.
  const readZoom = useVillageZoomReader(activeCapabilities);

  /**
   * The mounted handle's NPC snapshot read, or `undefined` if it has none.
   *
   * The optional-chaining chain is the feature detection, and it is *here* rather
   * than in the panel so no panel has to name the capability port. `undefined` is
   * passed all the way down rather than a no-op function, because "the world cannot
   * answer" and "the world answered with nothing" have to stay distinguishable.
   */
  const readNpcSnapshot = useCallback((): VillageNpcSnapshot | undefined => {
    return activeCapabilities()?.readNpcSnapshot?.();
  }, [activeCapabilities]);

  /**
   * The live route from a DOM control to a world action.
   *
   * Both members ask the *live* handle, and neither is memoized against the
   * handle's existence, because the handle arrives through a ref during the child
   * component's commit - after this screen's last render. A `useCallback` that
   * captured "the renderer is not mounted yet" would have made the DOM list report
   * a permanent `false` and the rows permanently disabled, which is the silent
   * no-op the exit criterion forbids in the other direction.
   *
   * `canInvoke` is the whole reason this is an object rather than a bare callback:
   * the screen *always* has a function to hand down, so "can the world act?" has
   * to be a question asked of the handle, not a fact about this screen.
   */
  const villageActionBridge = useMemo<VillageActionBridge>(
    () => ({
      canInvoke: () => activeCapabilities()?.invokeAction != null,
      invoke: (invocation) => {
        const handle = activeCapabilities();
        if (handle?.invokeAction == null) return false;
        handle.invokeAction(invocation);
        return true;
      },
    }),
    [activeCapabilities],
  );

  const triggerInteract = useCallback((): void => {
    if (pixiVillage) {
      pixiVillageRef.current?.triggerInteract();
      return;
    }
    rendererRef.current?.triggerInteract();
  }, [pixiVillage]);

  /**
   * The learner's village tile, published as `data-village-player` on this screen's root.
   *
   * Read through the *neutral* capability port, feature-detected, from whichever adapter is
   * mounted, so each lane reads it from its own renderer and this screen never learns which
   * one that is. A ref plus a direct attribute write, not state: a moving learner must not
   * cost a render of this subtree. `villagePlayerPosition.ts` carries the reasoning, the
   * refusals, and the staleness bound.
   */
  const villagePlayerRef = useVillagePlayerPositionAttribute(
    useCallback(() => readVillagePlayerGridPosition(activeCapabilities()), [activeCapabilities]),
  );

  const restart = useCallback((): void => {
    if (pixiVillage) {
      pixiVillageRef.current?.restart();
      return;
    }
    rendererRef.current?.restart();
  }, [pixiVillage]);

  const setDynamicStructures = useCallback((structures: readonly VillageStructure[]): void => {
    if (pixiVillage) {
      pixiVillageRef.current?.setDynamicStructures(structures);
      return;
    }
    rendererRef.current?.setDynamicStructures(structures);
  }, [pixiVillage]);

  const setPlayerClass = useCallback((playerClass: PlayerClassId | null): void => {
    if (pixiVillage) {
      pixiVillageRef.current?.setPlayerClass(playerClass);
      return;
    }
    rendererRef.current?.setPlayerClass(playerClass);
  }, [pixiVillage]);

  /**
   * The screen's fishing surface: the lane, the session, the catch transaction, and the controls.
   *
   * A hook, and the reason is a gate as much as a size: `tests/phase12/village-shell-split.test.ts` holds
   * this file under 900 lines because "the composition root is the *small* thing". The screen's
   * contribution is the `flow` declaration below and four JSX lines.
   */
  // Ref-based callbacks: the world captures the ref, always reads fresh values
  const subjectsRef = useRef(subjects);
  subjectsRef.current = subjects;
  const dynamicStructuresRef = useRef(dynamicStructures);
  dynamicStructuresRef.current = dynamicStructures;

  /*
   * The shared renderer-neutral learning flow, created exactly once - a second controller would reset the
   * interaction bookkeeping the tutorial depends on - and declared **above** the fishing hook because the two
   * hold each other: the flow's ports come from the hook's lane, so neither can be initialised first and the
   * hook's `enterFishing` reads this ref at call time. Its ports live in `villageStudyFlow.ts`; the Phase 21
   * pond-identifier rationale lives at `VillageSceneCallbackOptions`.
   */
  const flowRef = useRef<StudyFlowController | null>(null);

  /*
   * Phase 21: the pond identifier, recorded on **every** route into a pond.
   *
   * ## The defect this closes
   *
   * `studyFlow.enterFishing(structureId)` calls `villageUi.prepareFishingSession()` **before**
   * `fishing.enter(...)`, and `prepareFishingSession` receives no arguments. So at the moment the
   * fishing session has to be minted, the identifier the flow resolved is gone - and only the pond
   * panel's `Cast Line` button had recorded it, via `fishing.castFrom`.
   *
   * Every other route therefore entered the pond with no context: a **nearby-action row**, or the `E`
   * key, called `flow.structureInteract` → `enterFishing` → `prepareFishingSession` →
   * `beginFishing(null)` → early return. No session, so `catchKeep` refused with `NO_OPEN_SESSION` and
   * the learner was told *"This catch has no open pond session, so the question cannot be asked."*
   *
   * That is the **shipping** renderer, not a flagged lane: `pixiFishing`'s production default is
   * `false`, so the default build uses the Phaser pond, whose adapter ignores `handlers.pondId` and
   * reports no session of its own. The Pixi lane's `onSessionStarted` backstop that masks this there
   * simply does not exist on the artifact a learner downloads.
   *
   * ## Why the callback bag, not a wrapper around `flow.enterFishing`
   *
   * That was the first attempt here and it does not work, which is worth recording because the reason
   * is not obvious from the outside: `studyFlow.structureInteract` calls **its own** module-local
   * `enterFishing`, not the one this screen passes to the hook. Wrapping the screen's binding therefore
   * fixed only the route that already worked and left the defective route untouched - and the first
   * version of this test caught exactly that.
   *
   * `useVillageSceneCallbacks`' `onStructureInteract` is the **single door** from any renderer into the
   * flow: the Phaser scene, the Pixi scene, the nearby-action row, and the `E` key all arrive through
   * it. Recording there covers every existing route and every future one, and needs no knowledge of
   * which structures are ponds - see that module's note on why recording *every* identifier is correct
   * rather than sloppy.
   */
  /*
   * `enterFishing`, read through the ref so its **identity is stable** - `fishing.castFrom` and the
   * `StructurePanel`'s `onCastLine` prop must not change on every render. It is *not* where the pond is
   * recorded: `studyFlow.structureInteract` calls the flow's own module-local `enterFishing`.
   */
  const enterFishing = useCallback((structureId: string) => {
    flowRef.current?.enterFishing(structureId);
  }, []);
  const fishing = useVillageFishing(enterFishing, pixiFishing);
  // The lane, under the name the flow's port and the flag gate both refer to it by.
  const { lane: pixiFishingLane } = fishing;

  if (flowRef.current === null) {
    flowRef.current = createVillageStudyFlow({
      readPhaserHandle: () => rendererRef.current,
      readPixiFishingHost: pixiFishingLane.readHost,
      readDynamicStructures: () => dynamicStructuresRef.current,
      readSubjects: () => subjectsRef.current,
      setInfoPanel,
      setWelcomeMessage,
      setCreateOpen,
      setMakeItYoursOpen,
      setShowStats,
      setFishCaught: fishing.onFishCaught,
      prepareFishingSession: () => {
        setInfoPanel(null);
        // The hook closes every catch surface, begins the session, and sets the one
        // DOM-observable consequence of starting a fishing session. The flow has already proved a
        // world host is mounted, so by here "fishing is starting" is true rather than attempted.
        //
        // Phase 21: the pond identifier is **not** passed here, because by this point it is out of
        // scope - `studyFlow.enterFishing(structureId)` resolves it, calls this port, and the flow's own
        // argument is gone. It is recorded one layer earlier instead, at the single door every world
        // uses to reach the flow. See `useVillageSceneCallbacks`'s `onBeforeStructureInteract` note.
        fishing.prepareSession();
      },
      // The other half of the same pair, and the reason the rollback lane's Escape is honest:
      // `FishingScene` stops its own scenes and reports nothing to the DOM, so the flow tells
      // the hook when a session ended. See `useVillageFishing`'s `endSession`.
      finishFishingSession: () => {
        fishing.endSession();
      },
    });
  }
  const flow = flowRef.current;

  const { callbacks: callbacksRef, resetConversation } = useVillageSceneCallbacks(
    flow,
    { setActiveNpcId, setActiveNpcLabel, setKeeperDialogue, setNpcDialogAnchor, setVillageReady },
    // Phase 21: the pond identifier, recorded at the one door every world uses to reach the flow. See
    // {@link VillageSceneCallbackOptions} for why this door and not a wrapper around `flow.enterFishing`.
    { onBeforeStructureInteract: fishing.recordPond },
  );

  // Mount the Phaser village world once - it reads from callbacksRef. Only the
  // Phaser path mounts here; the Pixi component manages its own mount/unmount in
  // React through the JSX below, so the two can never be mounted at once.
  useEffect(() => {
    if (phaserVillageFactory === null) return;
    const container = containerRef.current;
    if (!container || rendererRef.current) return;
    const ref = callbacksRef;
    let cancelled = false;
    let renderer: VillageRendererHandle | null = null;
    let stopWaitingForReady: (() => void) | null = null;
    // The build-time literal factory resolves asynchronously, so a cleanup that
    // arrives before it settles is honoured rather than mounting after unmount.
    void phaserVillageFactory().then((mod) => {
      if (cancelled) return;
      renderer = mod.createVillageGame({
        parent: container,
        world: worldModel,
        callbacks: {
          onStructureApproached: (id) => ref.current.onStructureApproached(id),
          onStructureLeft: (id) => ref.current.onStructureLeft(id),
          onStructureInteract: (id) => ref.current.onStructureInteract(id),
          onNpcApproached: (id) => ref.current.onNpcApproached(id),
          onNpcLeft: (id) => ref.current.onNpcLeft(id),
          onNpcInteract: (id) => ref.current.onNpcInteract(id),
          onNpcDialogPosition: (p) => ref.current.onNpcDialogPosition(p),
          onReady: () => ref.current.onReady(),
        },
        spawn,
      });
      rendererRef.current = renderer;
      stopWaitingForReady = renderer.onReady?.(() => setVillageReady(true)) ?? null;
      renderer.mount();
    });
    return () => {
      cancelled = true;
      stopWaitingForReady?.();
      renderer?.unmount();
      rendererRef.current = null;
    };
    // Mount once, with the spawn and initial world captured deliberately; later
    // structure and class changes flow through the sync effect and `worldModel`.
  }, []);

  // Restart the village world when the user saves custom sprites and clicks "Apply Changes"
  useEffect(() => {
    if (sceneRestartCounter === 0) return;
    if (pixiVillage) {
      if (!pixiVillageRef.current) return;
    } else if (!rendererRef.current) {
      return;
    }
    setVillageReady(false);
    // The adapter revokes the old blob URLs and restarts the scene in place.
    restart();
  }, [sceneRestartCounter, pixiVillage, restart]);

  // Sync world state whenever the world is ready OR the data changes. The Pixi
  // component syncs its `world` prop in place, so this stays a Phaser-path effect
  // and the two renderers are never driven twice.
  useEffect(() => {
    if (pixiVillage) return;
    if (!rendererRef.current) return;
    setDynamicStructures(dynamicStructures);
    setPlayerClass(selectedClass);
  }, [pixiVillage, villageReady, dynamicStructures, selectedClass, setDynamicStructures, setPlayerClass]);

  // Show welcome message on village entry
  const handleStartTutorial = useCallback(async () => {
    const tutorial = createTutorialSubject();
    await importSnapshot(tutorial);
    setPhase('scribe');
    setSelectedClass('scholar');
    setQuestStep('enter-dungeon');
    await loadSubjectFlow(TUTORIAL_SUBJECT_ID);
    setActiveScreen('game');
  }, [importSnapshot, loadSubjectFlow, setActiveScreen, setPhase, setQuestStep, setSelectedClass]);

  const handleCreateSubject = useCallback(
    async (input: { name: string; topic: string; biome: FloorBiomeId }) => {
      // The dialog already refuses to submit an empty pair, so this guard is the
      // screen's own defence against a caller that is not the dialog.
      if (input.name.trim() === '' || input.topic.trim() === '') return;
      await initSubject({ subjectName: input.name, rootTopic: input.topic, biome: input.biome });
      await refreshSubjects();
      advanceQuestStep();
      setCreateOpen(false);
    },
    [advanceQuestStep, initSubject, refreshSubjects],
  );

  // The one conversation identity the nearby surface is nudged by. It changes when
  // a different NPC is being talked to, which is the only NPC event that moves the
  // nearby list. See `useVillageNpcSurface` for why it is a nudge and not the truth.
  const conversationKey = keeperDialogue === null ? null : activeNpcId;

  const npcSurface = useVillageNpcSurface({
    readNpcSnapshot,
    action: villageActionBridge,
    conversationKey,
  });
  const onInvokeNearby = useVillageActionHandler(npcSurface.invoke);

  const handleSelectQuestStep = useCallback(
    (step: QuestStep) => {
      setQuestStep(step);
      // Choosing a step begins a *new* conversation with the Keeper, so it resets
      // the same cursor a fresh approach resets. The screen holds no cursor of its
      // own; it lives beside the callback bag that advances it.
      resetConversation();
      setKeeperDialogue(keeperLineFor(step));
    },
    [keeperLineFor, resetConversation, setQuestStep],
  );

  return (
    <div
      className="village-screen ui-skin screen-fade-in"
      data-theme={colorTheme}
      ref={villagePlayerRef}
      // Which world this screen is currently presenting. `fishing` is not a
      // screen change - it is a Phaser scene swap inside the same canvas - so
      // without this the DOM could not tell a learner (or a test) that the
      // village they walked into had become the pond they are fishing in.
      data-world={fishing.active ? 'fishing' : 'village'}
    >
      <VillageHud
        questStep={questStep}
        subjects={subjects}
        selectedClass={selectedClass}
        onSelectClass={(cls) => setSelectedClass(cls as PlayerClassId ?? null)}
        onCreateSubject={() => setCreateOpen(true)}
        onOpenData={() => setDataOpen(true)}
        colorTheme={colorTheme}
        onColorThemeChange={(theme) => setColorTheme(theme as ColorTheme)}
        onQuestClick={handleSelectQuestStep}
        onStatsClick={() => setShowStats(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        nearbyTargets={npcSurface.targets}
        nearbyListAvailable={npcSurface.listAvailable}
        nearbyInvokeAvailable={npcSurface.invokeAvailable}
        onInvokeNearby={onInvokeNearby}
        // Two surfaces that both want the bottom of a touch viewport: opening one
        // closes the other. A wide viewport has room for both and never fires this.
        onDrawerOpenChange={(open) => {
          if (open) setInfoPanel(null);
        }}
      />

      <div className="village-game-area">
        {pixiVillage && LazyPixiVillageWorld !== null ? (
          // The Pixi chunk is lazy, so a build that requested it shows this status
          // sentence for the frames before it evaluates. `VillageWorld` supplies
          // its own labelled interact control, so the Phaser touch button below is
          // deliberately not rendered here.
          <Suspense
            fallback={
              <p role="status" className="village-renderer-status">
                Loading the village…
              </p>
            }
          >
            <LazyPixiVillageWorld
              ref={pixiVillageRef}
              world={worldModel}
              callbacks={callbacksRef.current}
              spawn={spawn}
              colorTheme={colorTheme}
              onReady={() => setVillageReady(true)}
            />
          </Suspense>
        ) : (
          <>
            <div className="village-canvas" ref={containerRef} />
            <button type="button" className="touch-interact-btn"
              aria-label="Interact" style={{ zIndex: 150 }}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
              onClick={() => {
                triggerInteract();
              }}>
              <span aria-hidden="true">⚔</span>
            </button>
          </>
        )}
        {pixiVillageMismatch ? (
          <p role="alert" className="village-renderer-status">
            This build was asked for the PixiJS village renderer but contains no PixiJS
            village chunk. Build it with VITE_PIXI_VILLAGE=true.
          </p>
        ) : null}

        <PixiFishingLaneSurface
          lane={pixiFishingLane}
          colorTheme={colorTheme}
          renderControls={fishing.renderControls}
        />

        <CompassOverlay readPoi={readPoi} />
        {/* Phase 21: the zoom read-out. See `VillageZoomReadOut` for the wording and the sampling. */}
        <VillageZoomReadOut readZoom={readZoom} />
      </div>

      {infoPanel !== null ? (
        infoPanel.type === 'quest-board' ? (
          <QuestBoard
            questStep={questStep}
            mode={surfaceMode}
            onClose={() => setInfoPanel(null)}
            onSelectStep={handleSelectQuestStep}
            onCompleteManualStep={() => advanceQuestStep()}
            nearbyTargets={npcSurface.targets}
            invoke={npcSurface.invoke}
            onInvoke={onInvokeNearby}
            colorTheme={colorTheme}
          />
        ) : (
          <StructurePanel
            infoPanel={infoPanel}
            onClose={() => setInfoPanel(null)}
            mode={surfaceMode}
            colorTheme={colorTheme}
            subjects={subjects}
            totals={totals}
            studyTotals={studyTotals}
            selectedClass={selectedClass}
            onEnterDungeon={(subjectId) => {
              setPhase('scribe');
              setSelectedClass(selectedClass ?? 'scholar');
              void loadSubjectFlow(subjectId).then(() => {
                setActiveScreen('game');
              });
            }}
            onCreateSubject={() => setCreateOpen(true)}
            onStartTutorial={() => { void handleStartTutorial(); }}
            onOpenSpriteEditor={() => setMakeItYoursOpen(true)}
            onOpenFishCollection={() => { setInfoPanel(null); setShowFishStand(true); }}
            onCastLine={fishing.castFrom}
            showFishingHint={showFishingHint}
          />
        )
      ) : null}

      {keeperDialogue !== null ? (
        <NpcDialog
          line={keeperDialogue}
          npcId={activeNpcId}
          label={activeNpcLabel}
          anchor={npcDialogAnchor}
          icon={activeNpcId === null ? undefined : NPC_ICONS[activeNpcId] ?? '🧙'}
          colorTheme={colorTheme}
        />
      ) : null}

      {/*
        The structure panel is opened by *walking*, not by activating a control, and
        a side panel deliberately never takes focus. So the change is announced in
        words instead - the structure's name and what it is for - which is what
        plan 10.1's "no state by colour alone" means for a surface that arrives on
        its own.
      */}
      {infoPanel !== null ? (
        <p className="village-visually-hidden" role="status" aria-live="polite">
          {structureAnnouncement(infoPanel)}
        </p>
      ) : null}

      {/*
        Starting a fishing session is a scene swap, not a route change, so nothing
        in the DOM moves and focus stays exactly where it was - on the very button
        that was pressed, which by then has been unmounted with its panel. The one
        way a screen-reader user learns the world changed is a live region, so
        this is the whole of the fishing world's accessibility surface on the DOM
        side, and it says only that fishing began and how to leave.

        Deliberately a literal, with no interpolation: this text is read aloud,
        and a subject name or a fish name here would be learner data in a place
        plan 10.1's privacy boundary does not exempt.
      */}
      {fishing.active ? (
        <p className="village-visually-hidden" role="status" aria-live="polite">
          You have started fishing. Use the Return to Village control in the world to come back.
        </p>
      ) : null}

      {/*
        What the last catch decision did, in words.

        A *visible* sentence, not a `visually-hidden` one and not a toast: the reward for a
        catch is the single most important thing this activity says, and the pre-Phase-17 build
        said it in two `console.log` calls - which is to say, nowhere a learner can read it.
        Rendered whenever there is something to say, so a decision's outcome survives the dialog
        closing, and announced politely because it replaces what was on screen.
      */}
      {fishing.status !== null ? (
        <p className="fishing-recall__outcome" role="status" aria-live="polite">
          {fishing.status}
        </p>
      ) : null}

      {/*
        Phase 19: the fishing suggestion card, mounted here rather than inside either fishing lane.

        Two reasons, and both are about the rollback lane. `renderControls` is the Pixi lane's HUD
        hook and the Phaser \`FishingScene\` has its own DOM, so mounting in either would leave the
        other without the feature; mounting here covers both because this screen is the parent of
        both. And with the production default \`VITE_ADAPTIVE_ASSISTANCE=false\` the slot renders
        \`null\`, so the Phaser rollback lane is byte-identical to what it was.

        Gated on \`fishing.assistance !== null\`, which is the hook's own "a recall question was
        actually missed on this visit" fact - so on the common visit the card is never mounted and
        its lazily-loaded chunk is never requested.
      */}
      {fishing.assistance === null ? null : (
        <AssistanceSlot
          surface="fishing"
          snapshot={fishing.assistance.snapshot}
          fishing={fishing.assistance.fishing}
        />
      )}

      <DataManagementDialog
        open={dataOpen}
        subjects={subjects}
        onClose={() => setDataOpen(false)}
      />

      <CreateSubjectDialog
        open={createOpen}
        onCreate={handleCreateSubject}
        onClose={() => setCreateOpen(false)}
      />

      <VillageLaunchers
        colorTheme={colorTheme}
        showStats={showStats}
        onCloseStats={() => setShowStats(false)}
        settingsOpen={settingsOpen}
        onThemeChange={(theme) => setColorTheme(theme)}
        onCloseSettings={() => setSettingsOpen(false)}
        spriteEditorOpen={makeItYoursOpen}
        onCloseSpriteEditor={() => setMakeItYoursOpen(false)}
        fishStandOpen={showFishStand}
        onCloseFishStand={() => setShowFishStand(false)}
        fishCatch={fishing.catch}
        onKeepFish={fishing.onKeep}
        onReleaseFish={fishing.onRelease}
        showRecallModal={fishing.recallOpen}
        recallQuestion={fishing.recallQuestion}
        onRecallDecision={fishing.onDecide}
        onCancelRecall={fishing.onCancelRecall}
        recallDestination={fishing.recallDestination}
        welcomeMessage={welcomeMessage}
        onDismissWelcome={() => setWelcomeMessage(null)}
      />
    </div>
  );
}
