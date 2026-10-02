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
} from 'react';

import { PixiCanvas } from '@/renderers/pixi/runtime/PixiCanvas';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { useWorldQuality } from '@/renderers/pixi/runtime/useWorldQuality';
import type { VillageNpcHost } from '@/application/contracts/renderer';
import { createVillageNpcSnapshot } from '@/application/contracts/villageNpc';
import type { WorldPointOfInterest, VillageWorldModel } from '@/application/contracts/world';
import type { VillageStructure } from '@/data/villageLayout';
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
      // Phase 12's NPC surface, forwarded like every other member. A DOM
      // nearby-action panel reads the snapshot and sends an invocation; the scene
      // measures and the contract decides what a row means.
      readNpcSnapshot: () =>
        rendererRef.current?.readNpcSnapshot() ?? EMPTY_NPC_SNAPSHOT,
      invokeAction: (invocation) => rendererRef.current?.invokeAction(invocation),
    }),
    [],
  );

  const onInteract = useCallback(() => {
    rendererRef.current?.triggerInteract();
  }, []);

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
          style={{
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
          }}
        >
          Interact (E or Space)
        </button>
        <span id={`${surfaceId}-interact-hint`} style={visuallyHidden}>
          Interacts with the nearest structure or non-player character. You can also press E or Space,
          or tap the village on the canvas.
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
