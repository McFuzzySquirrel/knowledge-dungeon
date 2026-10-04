/**
 * The fishing screen's PixiJS surface: a canvas, a status sentence, and a handle.
 *
 * ## Why this component exists
 *
 * It is the dynamic-import target for the fishing chunk. A host reaches it only through
 * `import()`, and this module is what pulls in the renderer, the scene, and - transitively
 * - PixiJS. With `VITE_PIXI_FISHING` unset, the build-time literal that guards that import
 * is false, so this module is deleted along with the `import()` and the default artifact
 * ships no Pixi fishing chunk at all.
 *
 * ## The accessibility contract, in this component
 *
 * The canvas is `aria-hidden` and not focusable - the Phase 9 host sets both before a
 * renderer exists - and **this component renders no fishing controls at all**. That is the
 * deliberate difference from `VillageWorld.tsx`, which renders its own "Interact" button,
 * and the reason is ownership rather than convenience:
 *
 * - Plan 6.2 gives instructional text, forms, dialogs, and accessible controls to React DOM.
 * - `ui-engineer` owns the fishing HUD, the catch panel, and the recall modal, and the pond
 *   has *five* learner-triggerable transitions rather than one. Five controls - three of
 *   them press-and-hold - plus the catch panel that consumes a reveal payload are a UI
 *   surface, not a canvas accessory.
 * - So this component does the one thing the DOM cannot do for itself: it publishes a typed
 *   capability port, {@link FishingWorldHandle}, that those controls drive. What is *not*
 *   on that port cannot be reached from a button, and what is on it is reached from a canvas
 *   tap, a key press, and a button alike - which is the only reading of plan 10.1's "a DOM
 *   equivalent for every Pixi interaction" that survives review.
 *
 * ## The status sentence
 *
 * One polite live region naming **readiness, motion, quality, and phase, in words**. Plan
 * 10.1 forbids colour-only state communication, and a learner who cannot see the canvas still
 * needs to know whether it started, whether it is moving, what it is costing, and which of
 * the eight cast phases the session is in. The phase is a fact from the readout, not copy;
 * `ui-engineer` turns it into the instruction, with `fishingPhaseHint` from the state machine
 * as its shared starting point.
 *
 * ## Teardown
 *
 * The mount effect's cleanup calls `renderer.destroy()`, which is the renderer's one teardown:
 * host unmount - frame subscription, key listener, visibility and reduced-motion
 * subscriptions, size observer, scene destroy, `Application.destroy({releaseGlobalResources:
 * true})`, canvas removal - followed by the asset bundle's `dispose`. Nothing else holds a
 * reference to the renderer, and `destroy` is idempotent, so React's StrictMode
 * mount/unmount/mount cannot strand a first GPU context. Phase 17's exit criterion, "returning
 * to Village destroys fishing GPU resources cleanly", is measured in
 * `tests/phase17/fishing-scene-teardown.test.ts`.
 */
import {
  forwardRef,
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
import type { FishingWorldModel } from '@/application/contracts/world';
import type { FishingAudioHook } from '@/core/fishing/fishingStateMachine';
import {
  createPixiFishingRenderer,
  FISHING_IDLE_PRESENTATION,
  FISHING_IDLE_READOUT,
  type FishingCatchReveal,
  type FishingController,
  type FishingReadout,
  type PixiFishingRenderer,
} from './FishingController';

/** The session inputs a reproducible run needs; forwarded to the scene verbatim. */
export interface FishingSceneInputs {
  /** `YYYY-MM-DD` the gameplay stream is seeded from. Defaults to today. */
  readonly sessionDate?: string;
  /** The cosmetic stream, separate from the gameplay stream the machine owns. */
  readonly cosmeticRng?: () => number;
  /** The session's start on the scene's own clock. Defaults to `0`. */
  readonly nowMs?: number;
}

/** The surface and the handles this component renders. */
export interface FishingWorldProps {
  /** Renderer-neutral model: archetype, eligibility, and subject context. */
  readonly world: FishingWorldModel;
  /** Leave the pond for the village. */
  readonly onReturnToVillage: () => void;
  /** Play one audio hook. Defaults to Phase 10's `audioManager`. */
  readonly playAudioHook?: (hook: FishingAudioHook) => void;
  /** A Cozy theme name, or a persisted legacy colour-theme string. */
  readonly colorTheme?: string | null;
  /** Test hook and stable id prefix. Defaults to `pixi-fishing-world`. */
  readonly surfaceId?: string;
  /** Called once, after the first frame has been presented. */
  readonly onReady?: () => void;
  /**
   * Called for every revealed catch.
   *
   * A convenience, not a requirement: the handle exposes the same port, so a parent that
   * subscribes through the ref needs this prop not to be passed at all.
   */
  readonly onCatchRevealed?: (reveal: FishingCatchReveal) => void;
  /** Session inputs forwarded to the scene, for a reproducible run. */
  readonly scene?: FishingSceneInputs;
}

/**
 * The imperative handle a parent screen holds.
 *
 * Typed against {@link FishingController}, the renderer's own narrow port, and **not**
 * against the structural `FishingRendererCapabilities`. `VillageWorld.tsx`'s header records
 * why: typed against a broad structural base, that component's handle compiled while silently
 * omitting `readNpcSnapshot` and `invokeAction`, and a nearby-action panel feature-detected
 * `undefined` and rendered its rows permanently disabled - with no type error anywhere and
 * nothing in the build to say so. Every learner action this world accepts is a named member
 * here, so a control that reaches for one fails `typecheck` rather than at runtime.
 */
export interface FishingWorldHandle extends FishingController {
  /** Subscribe to the readout. Never fires per frame. */
  onPhase(listener: (readout: FishingReadout) => void): () => void;
  /** Subscribe to revealed catches. */
  onCatchRevealed(listener: (reveal: FishingCatchReveal) => void): () => void;
}

const DEFAULT_SURFACE_ID = 'pixi-fishing-world';

const px = (value: number): string => `${value}px`;

function cssHex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

/**
 * The status sentence, in words.
 *
 * Readiness, motion, quality, and phase - none of them carried by colour or by an icon. The
 * failure branch names the failure and stops, because "stopped" plus three more clauses is a
 * sentence about a world that is not running.
 */
export function fishingStatusSentence(input: {
  readonly isReady: boolean;
  readonly reducedMotion: boolean;
  readonly qualityId: string;
  readonly phase: FishingReadout['phase'];
  readonly failure: string | null;
}): string {
  if (input.failure !== null) return `Fishing pond renderer stopped: ${input.failure}`;
  const parts = [
    input.isReady ? 'Fishing pond presented' : 'Fishing pond starting',
    input.reducedMotion ? 'Reduced motion: no travel' : 'Motion enabled',
    `Quality profile: ${input.qualityId}`,
    `Cast phase: ${input.phase.replace('-', ' ')}`,
  ];
  return `${parts.join('. ')}.`;
}

const FishingWorld = forwardRef<FishingWorldHandle, FishingWorldProps>(function FishingWorld(
  props,
  ref,
): JSX.Element {
  const {
    world,
    onReturnToVillage,
    playAudioHook,
    colorTheme,
    surfaceId = DEFAULT_SURFACE_ID,
    onReady,
    onCatchRevealed,
    scene,
  } = props;
  const { profile, reducedMotion } = useWorldQuality();

  const theme = useMemo(
    () => resolveCozyWorldTheme({ theme: colorTheme ?? null, reducedMotion }),
    [colorTheme, reducedMotion],
  );

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<PixiFishingRenderer | null>(null);

  // Live values the mount effect reads through closures, so a parent that re-creates its
  // handlers on every render does not tear the pond down and rebuild a PixiJS `Application`.
  const onReturnRef = useRef(onReturnToVillage);
  const onReadyRef = useRef(onReady);
  const onCatchRef = useRef(onCatchRevealed);
  const playHookRef = useRef(playAudioHook);

  const [isReady, setIsReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [readout, setReadout] = useState<FishingReadout>(FISHING_IDLE_READOUT);

  useEffect(() => {
    onReturnRef.current = onReturnToVillage;
  }, [onReturnToVillage]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  useEffect(() => {
    onCatchRef.current = onCatchRevealed;
  }, [onCatchRevealed]);
  useEffect(() => {
    playHookRef.current = playAudioHook;
  }, [playAudioHook]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;

    const renderer = createPixiFishingRenderer({
      host: surface,
      world,
      onReturnToVillage: () => onReturnRef.current(),
      playAudioHook: (hook) => playHookRef.current?.(hook),
      colorTheme,
      quality: profile.id,
      // Captured deliberately rather than re-read: the pond's inputs are the archetype and
      // the eligibility flag, both consumed when the scene is constructed. Changing subject
      // unmounts and remounts this surface, which is the only way a pond is rebuilt - so
      // this effect depends on the theme and the quality profile and on nothing else.
      scene,
    });
    rendererRef.current = renderer;

    const stopReady = renderer.onReady(() => {
      setIsReady(true);
      onReadyRef.current?.();
    });
    // A *phase* channel, never a per-frame one, so holding the subscription for the life of
    // the mount is safe: it fires on the host's initial publish, after every dispatch, and on
    // the transitions the scene made to itself.
    const stopPhase = renderer.onPhase((value) => setReadout(value));
    const stopCatch = renderer.onCatchRevealed((reveal) => onCatchRef.current?.(reveal));

    try {
      renderer.mount();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The fishing pond could not start.');
    }

    return () => {
      stopPhase();
      stopCatch();
      stopReady();
      // The renderer's one teardown. Not `unmount`: the handle names it `destroy`, and
      // naming it once here means the component has exactly one exit path.
      renderer.destroy();
      rendererRef.current = null;
      setIsReady(false);
      setReadout(FISHING_IDLE_READOUT);
    };
  }, [colorTheme, profile.id]);

  useImperativeHandle(
    ref,
    (): FishingWorldHandle => ({
      isReady: () => rendererRef.current?.isReady() ?? false,
      destroy: () => rendererRef.current?.destroy(),
      beginPower: () => rendererRef.current?.beginPower(),
      release: () => rendererRef.current?.release(),
      hook: () => rendererRef.current?.hook(),
      reset: () => rendererRef.current?.reset(),
      move: (intent) => rendererRef.current?.move(intent),
      resize: (width, height) => rendererRef.current?.resize(width, height),
      readReadout: () => rendererRef.current?.readReadout() ?? FISHING_IDLE_READOUT,
      readPresentation: () => rendererRef.current?.readPresentation() ?? FISHING_IDLE_PRESENTATION,
      getCaughtCount: () => rendererRef.current?.getCaughtCount() ?? 0,
      setPlayerClass: (playerClass) => rendererRef.current?.setPlayerClass(playerClass),
      returnToVillage: () => rendererRef.current?.returnToVillage(),
      onPhase: (listener) => rendererRef.current?.onPhase(listener) ?? (() => {}),
      onCatchRevealed: (listener) => rendererRef.current?.onCatchRevealed(listener) ?? (() => {}),
    }),
    [],
  );

  // Words, not colour and not an icon: plan 10.1 forbids colour-only state, and a learner
  // who cannot see the canvas still needs to know whether it started, what it is costing, and
  // which cast phase the session is in.
  const sentence = fishingStatusSentence({
    isReady,
    reducedMotion,
    qualityId: profile.id,
    phase: readout.phase,
    failure,
  });

  return (
    <div
      className="pixi-fishing-world"
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
        label="Fishing pond"
        description="The pond, drawn on a canvas: a night sky over water, a shoreline, an angler with a rod, and a float. Every action on this surface is also available from the fishing controls in the page around it."
      >
        <p
          // Announced when it changes, and never the only way the state is conveyed: the
          // sentence names readiness, motion, quality, and phase in words.
          aria-live="polite"
          role="status"
          style={{ margin: 0, fontSize: px(theme.fontSize.sm), color: cssHex(theme.color.textMuted) }}
        >
          {sentence}
        </p>
      </PixiCanvas>

      {failure !== null ? (
        <p role="alert" style={{ margin: 0, color: cssHex(theme.color.bad) }}>
          {failure}
        </p>
      ) : null}
    </div>
  );
});

export default FishingWorld;