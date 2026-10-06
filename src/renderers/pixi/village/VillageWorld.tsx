/**
 * The village screen's PixiJS surface: a canvas plus the DOM controls that mirror it.
 *
 * ## Why this component exists
 *
 * It is the dynamic-import target for the village chunk. `VillageScreen` reaches
 * it only through `import()`, and this module is what pulls in the renderer, the
 * scene, and - transitively - PixiJS. The legacy Phaser path never fetches it, so
 * `VITE_PIXI_VILLAGE=false` leaves the default build exactly as it was.
 *
 * ## The accessibility contract, in this component
 *
 * The canvas is `aria-hidden` and not focusable (the Phase 9 host sets both before
 * a renderer exists). Everything a learner can do with a pointer on the canvas has
 * a real DOM control here:
 *
 * - **Interact** - a labelled, keyboard-operable button at least 44 CSS pixels on
 *   each side. It calls the same capability the touch path calls, and that
 *   capability goes through the host's dispatch, so the canvas, the keyboard, and
 *   this button are one action rather than three.
 * - **Movement** - arrows and WASD are the DOM-equivalent route for the canvas
 *   drag; they are handled by the scene's input controller, so no second control is
 *   needed for a channel that is already fully keyboard-operable.
 * - **Readiness, quality, and motion** - a polite live sentence, in words, so no
 *   state is carried by colour alone.
 *
 * ## Why the renderer is created here rather than through `PixiWorldHost`
 *
 * `PixiWorldHost` is the Phase 9 demonstration screen: it renders a generic mirror
 * from `WorldAction[]` and knows a test world. The village needs a specific
 * control (interact), specific callbacks, and a capability handle its parent can
 * poll for the compass; this component owns those, and calls the same
 * `createPixiVillageRenderer` a future non-React host would.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
  type CSSProperties,
} from 'react';

import { PixiCanvas } from '@/renderers/pixi/runtime/PixiCanvas';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { useWorldQuality } from '@/renderers/pixi/runtime/useWorldQuality';
import type { CameraState } from '@/renderers/pixi/camera/CameraRig';
import type { VillageNpcHost, WorldGridPosition } from '@/application/contracts/renderer';
import { createVillageNpcSnapshot } from '@/application/contracts/villageNpc';
import type { WorldPointOfInterest, VillageWorldModel } from '@/application/contracts/world';
import type { VillageStructure } from '@/data/villageLayout';
import { VILLAGE_ZOOM_STEP } from './createVillageScene';
import {
  createPixiVillageRenderer,
  type PixiVillageRenderer,
  type VillageSceneCallbacks,
  type VillageSpawnPoint,
} from './VillageRenderer';

/** The surface and DOM-control group this component renders. */
export interface VillageWorldProps {
  readonly world: VillageWorldModel;
  readonly callbacks: VillageSceneCallbacks;
  readonly spawn?: VillageSpawnPoint;
  readonly colorTheme?: string;
  /** Test hook and stable id prefix. Defaults to `pixi-village-world`. */
  readonly surfaceId?: string;
  /** Called once, after the first frame has been presented. */
  readonly onReady?: () => void;
}

/**
 * The imperative handle a parent screen holds.
 *
 * It is the renderer's capability port plus the two lifecycle reads a React screen
 * needs but the port does not carry, so a caller can drive the world through a ref
 * without ever naming PixiJS.
 *
 * Extends {@link VillageNpcHost} rather than the base `VillageRendererCapabilities`
 * because the handle is *this component's* declaration of what a screen may ask the
 * world. Typed against the base port, the object literal below compiled while
 * silently omitting `readNpcSnapshot` and `invokeAction`: a nearby-action panel that
 * feature-detected read `undefined` and rendered its rows permanently disabled, with
 * no type error anywhere and nothing in the build to say so. That was found in a
 * real browser, not by reading the code. The narrowed port is what turns a missing
 * member into a `typecheck` failure.
 */
export interface VillageWorldHandle extends VillageNpcHost {
  isReady(): boolean;
  restart(): void;
  /**
   * Re-declared as required, for the reason the header gives for `VillageNpcHost`:
   * this handle is *this component's* declaration of what a screen may ask the world,
   * and it answers `null` for "not mounted yet" rather than omitting the member. A
   * screen that feature-detected would get a truthy-or-`undefined` answer with no
   * distinction between "cannot say" and "said nothing", and the one thing this value
   * must never be is a tile the renderer did not measure.
   */
  readPlayerGridPosition(): WorldGridPosition | null;
  /**
   * Zoom the camera by a delta in zoom units.
   *
   * Added in Phase 21 so a screen can offer the village zoom from a control of its own.
   * The two buttons this component renders are the in-app route; this is the seam a
   * surface that wants its own zoom placement - a drawer, a settings row - drives, and
   * it is the same `zoomBy` the buttons use, so there is one zoom.
   */
  zoomBy(delta: number): void;
  /**
   * The camera as one value, or `null` before the renderer exists.
   *
   * Present so a surface can state the current zoom rather than leaving the factor to be
   * guessed at from the picture. A read, never a subscription: the camera changes every
   * frame while the learner walks, and a per-frame publish would re-render every
   * `aria-live` region in the mirror sixty times a second.
   */
  readCameraState(): CameraState | null;
}

const DEFAULT_SURFACE_ID = 'pixi-village-world';

/**
 * The snapshot a panel gets before the renderer exists.
 *
 * One frozen shared value rather than a fresh allocation per call: this runs in a
 * React effect that a panel can re-run freely, and the answer is the same "nothing
 * is in reach" every time. `createVillageNpcSnapshot` still builds it, so the shape
 * is the contract's and not a hand-written literal that could drift from it.
 */
const EMPTY_NPC_SNAPSHOT = createVillageNpcSnapshot({
  candidates: [],
  anchor: null,
});

const px = (value: number): string => `${value}px`;

function cssHex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

/**
 * The status sentence under the canvas.
 *
 * Words, not colour and not an icon: plan 10.1 forbids colour-only state, and a
 * learner who cannot see the canvas still needs to know whether it started, which
 * quality profile is running, and whether motion is reduced.
 */
function statusSentence(
  isReady: boolean,
  reducedMotion: boolean,
  qualityId: string,
  failure: string | null,
): string {
  if (failure !== null) return `Village renderer stopped: ${failure}`;
  const parts = [
    isReady ? 'Village presented' : 'Village starting',
    reducedMotion ? 'Reduced motion: no travel' : 'Motion enabled',
    `Quality profile: ${qualityId}`,
  ];
  return `${parts.join('. ')}.`;
}

const VillageWorld = forwardRef<VillageWorldHandle, VillageWorldProps>(function VillageWorld(
  props,
  ref,
): JSX.Element {
  const { world, callbacks, spawn, colorTheme, surfaceId = DEFAULT_SURFACE_ID, onReady } = props;
  const { profile, reducedMotion } = useWorldQuality();

  const theme = useMemo(
    () => resolveCozyWorldTheme({ theme: colorTheme ?? null, reducedMotion }),
    [colorTheme, reducedMotion],
  );

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<PixiVillageRenderer | null>(null);
  const callbacksRef = useRef(callbacks);
  const worldRef = useRef(world);
  const spawnRef = useRef(spawn);
  const onReadyRef = useRef(onReady);

  const [isReady, setIsReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);
  useEffect(() => {
    worldRef.current = world;
  }, [world]);
  useEffect(() => {
    spawnRef.current = spawn;
  }, [spawn]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  /**
   * One stable callback bag for the lifetime of the mount.
   *
   * The scene is built once and reports through these functions; forwarding into a
   * ref means a screen that re-creates its callbacks on every render does not tear
   * the world down, which is the difference between a HUD update and a remount.
   */
  const stableCallbacks = useMemo<VillageSceneCallbacks>(
    () => ({
      onStructureApproached: (id) => callbacksRef.current.onStructureApproached(id),
      onStructureLeft: (id) => callbacksRef.current.onStructureLeft(id),
      onStructureInteract: (id) => callbacksRef.current.onStructureInteract(id),
      onNpcApproached: (id) => callbacksRef.current.onNpcApproached?.(id),
      onNpcLeft: (id) => callbacksRef.current.onNpcLeft?.(id),
      onNpcInteract: (id) => callbacksRef.current.onNpcInteract?.(id),
      onNpcDialogPosition: (anchor) => callbacksRef.current.onNpcDialogPosition?.(anchor),
      onReady: () => callbacksRef.current.onReady(),
    }),
    [],
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;

    const renderer = createPixiVillageRenderer({
      host: surface,
      world: worldRef.current,
      callbacks: stableCallbacks,
      spawn: spawnRef.current,
      colorTheme,
      quality: profile.id,
    });
    rendererRef.current = renderer;

    const stopReady = renderer.onReady(() => {
      setIsReady(true);
      onReadyRef.current?.();
    });

    try {
      renderer.mount();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The village renderer could not start.');
    }

    return () => {
      stopReady();
      renderer.unmount();
      rendererRef.current = null;
      setIsReady(false);
    };
  }, [stableCallbacks, colorTheme, profile.id]);

  // Structure and class changes sync in place rather than remounting, so the
  // player keeps their position and the camera keeps its follow target.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null || !isReady) return;
    renderer.setDynamicStructures(world.structures);
    renderer.setPlayerClass(world.playerClass);
  }, [isReady, world.structures, world.playerClass]);

  useImperativeHandle(
    ref,
    () => ({
      isReady: () => rendererRef.current?.isReady() ?? false,
      restart: () => rendererRef.current?.restart(),
      setDynamicStructures: (structures: readonly VillageStructure[]) =>
        rendererRef.current?.setDynamicStructures(structures),
      setPlayerClass: (playerClass) => rendererRef.current?.setPlayerClass(playerClass),
      triggerInteract: () => rendererRef.current?.triggerInteract(),
      readPoi: (): WorldPointOfInterest | null => rendererRef.current?.readPoi() ?? null,
      // The learner's tile, forwarded like every other member. `null` while the
      // renderer ref is empty - which is the whole "before a world exists" case on
      // this lane, and the reason the handle's answer is `null` rather than a
      // default tile. No state, no subscription, no render: the read is a measurement
      // and the caller's cadence is the caller's business.
      readPlayerGridPosition: (): WorldGridPosition | null =>
        rendererRef.current?.readPlayerGridPosition() ?? null,
      // Phase 12's NPC surface, forwarded like every other member. A DOM
      // nearby-action panel reads the snapshot and sends an invocation; the scene
      // measures and the contract decides what a row means.
      readNpcSnapshot: () =>
        rendererRef.current?.readNpcSnapshot() ?? EMPTY_NPC_SNAPSHOT,
      invokeAction: (invocation) => rendererRef.current?.invokeAction(invocation),
      // Phase 21's camera members, forwarded like every other one. `readCameraState`
      // answers `null` while the renderer ref is empty, which is the same "before a world
      // exists" case `readPoi` answers `null` for.
      zoomBy: (delta) => rendererRef.current?.zoomBy(delta),
      readCameraState: (): CameraState | null => rendererRef.current?.readCameraState() ?? null,
    }),
    [],
  );

  const onInteract = useCallback(() => {
    rendererRef.current?.triggerInteract();
  }, []);

  /**
   * Zoom one step in each direction, through the renderer's camera members.
   *
   * `VILLAGE_ZOOM_STEP` rather than a number here, so a button press and a wheel notch move
   * the camera by the same amount: a learner who tries both finds them consistent, and a
   * learner who only has one of them is not left with a control that behaves differently
   * from the gesture its own label describes.
   */
  const onZoomIn = useCallback(() => {
    rendererRef.current?.zoomBy(VILLAGE_ZOOM_STEP);
  }, []);

  const onZoomOut = useCallback(() => {
    rendererRef.current?.zoomBy(-VILLAGE_ZOOM_STEP);
  }, []);

  /**
   * The one button style every control in this component shares.
   *
   * Hoisted out of the interact button because there are now three controls and the
   * `touchTargetMin` floor is a property of *all* of them: an inline copy pasted into a
   * fourth button is how a 30-pixel control appears in a group that is otherwise keyboard-
   * and touch-usable. Memoized on the theme so the object identity is stable across renders
   * and React skips the style diff on every unrelated state change.
   */
  const controlStyle: CSSProperties = useMemo(
    () => ({
      minWidth: px(theme.touchTargetMin),
      minHeight: px(theme.touchTargetMin),
      padding: `${px(theme.space['2'])} ${px(theme.space['4'])}`,
      fontFamily: theme.fontFamily.body,
      fontSize: px(theme.fontSize.md),
      fontWeight: theme.fontWeight.medium,
      lineHeight: theme.lineHeight.normal,
      color: cssHex(theme.color.textPrimary),
      background: cssHex(theme.color.surfaceRaised),
      border: `${px(theme.border.state)} solid ${cssHex(theme.color.borderControl)}`,
      borderRadius: px(theme.radius.md),
      cursor: 'pointer',
      touchAction: 'manipulation',
    }),
    [theme],
  );

  return (
    <div
      className="pixi-village-world"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: px(theme.space['3']),
        width: '100%',
        color: cssHex(theme.color.textPrimary),
        fontFamily: theme.fontFamily.body,
      }}
    >
      <PixiCanvas
        surfaceId={surfaceId}
        surfaceRef={(element) => {
          surfaceRef.current = element;
        }}
        theme={theme}
        label="Village world"
        description="The village, drawn on a canvas: paths, buildings, subject portals, and a player marker. The controls below perform the same actions as the canvas."
      >
        <p
          // Announced when it changes, and never the only way the state is conveyed:
          // the sentence names readiness, motion, and the quality profile in words.
          aria-live="polite"
          style={{ margin: 0, fontSize: px(theme.fontSize.sm), color: cssHex(theme.color.textMuted) }}
        >
          {statusSentence(isReady, reducedMotion, profile.id, failure)}
        </p>
      </PixiCanvas>

      {failure !== null ? (
        <p role="alert" style={{ margin: 0, color: cssHex(theme.color.bad) }}>
          {failure}
        </p>
      ) : null}

      <div
        role="group"
        aria-label="Village actions"
        style={{ display: 'flex', flexWrap: 'wrap', gap: px(theme.space['3']) }}
      >
        <button
          type="button"
          onClick={onInteract}
          aria-describedby={`${surfaceId}-interact-hint`}
          style={controlStyle}
        >
          Interact (E or Space)
        </button>
        <span id={`${surfaceId}-interact-hint`} style={visuallyHidden}>
          Interacts with the nearest structure or non-player character. You can also press E or Space,
          or tap the village on the canvas.
        </span>

        {/*
          Zoom, which Phase 21's audit found to be the one canvas gesture with no DOM route.

          The village zooms from a wheel notch and from a pinch, and both are pointer-only - so
          before these two buttons the village camera had **no keyboard route at all**, which is
          exactly the canvas-only shape plan 10.1 forbids. They could not be `WorldAction`s:
          `VILLAGE_ACTIONS` is pinned to length 1 by
          `tests/phase12/village-npc-renderer.test.ts` so that it matches the closed
          `VillageActionId` union in the renderer-neutral contract, and widening it needs a
          contract change `core-logic-engineer` owns. So they reach the renderer's own camera
          members, which is where the dungeon's zoom lives too.

          Real `<button>`s, so Enter and Space activate them by the browser's own behaviour, each
          at the 44 by 44 CSS-pixel minimum, and each with a hidden hint that names the pointer
          gestures as well - so a learner who discovers zoom by scrolling the page learns that
          these are the same two controls.
        */}
        <button
          type="button"
          onClick={onZoomIn}
          aria-describedby={`${surfaceId}-zoom-in-hint`}
          data-village-action="zoom-in"
          style={controlStyle}
        >
          Zoom in
        </button>
        <span id={`${surfaceId}-zoom-in-hint`} style={visuallyHidden}>
          Moves the village view closer, one step. You can also scroll the mouse wheel over the
          village, or pinch the canvas with two fingers.
        </span>
        <button
          type="button"
          onClick={onZoomOut}
          aria-describedby={`${surfaceId}-zoom-out-hint`}
          data-village-action="zoom-out"
          style={controlStyle}
        >
          Zoom out
        </button>
        <span id={`${surfaceId}-zoom-out-hint`} style={visuallyHidden}>
          Moves the village view further away, one step. You can also scroll the mouse wheel over
          the village, or pinch the canvas with two fingers.
        </span>
      </div>
    </div>
  );
});

const visuallyHidden: Record<string, string | number> = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: '0',
};

export default VillageWorld;
