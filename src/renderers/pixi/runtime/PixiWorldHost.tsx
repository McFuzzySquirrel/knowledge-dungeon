/**
 * The PixiJS world host screen, and the dynamic-import target for the Pixi bundle.
 *
 * ## This module is the chunk boundary
 *
 * `src/ui/App.tsx` reaches this file *only* through `import(...)`, and this file
 * reaches `pixi.js` only through static imports. That is the shape
 * `tests/phase9/renderer-chunk-boundary.test.ts` describes: the entry chunk
 * dynamically imports this one, and this one statically imports the vendor chunk.
 * Two properties follow, and both are load-bearing:
 *
 * - Vite emits a `modulepreload` for every chunk *statically* reachable from the
 *   entry, so a plain `import` of a host that names PixiJS would fetch PixiJS on
 *   Welcome. The dynamic import is what keeps it off the first paint, and the
 *   `writeBundle` audit in `vite.config.ts` is what makes that structural rather
 *   than incidental.
 * - The component is *not* rendered at all unless `VITE_WORLD_RENDERER=pixi`, so
 *   even the lazy chunk is never fetched on the default build. See the
 *   `pixiWorldHostFactory` in `App.tsx`.
 *
 * This file is the composition root: the one place that knows both the concrete
 * PixiJS binding and the concrete test world, and the one place a `WorldApplication`
 * is bound to a `PixiApplication`. Everything above it speaks the port.
 *
 * ## What the screen is, and is not
 *
 * It is a runtime-host test surface: a labelled region, a canvas, and a DOM mirror
 * with one control per world action. It is **not** a replacement for `GameScreen`,
 * and it does not attempt the dungeon - Phase 9's non-goals rule that out, and a
 * half-built dungeon behind a renderer switch would be worse than an honest test
 * world. `App.tsx` therefore routes at the *screen* level for the flagged build:
 * the Phaser path is not touched at all, and Phase 11 replaces this component with
 * the Village host at the same seam.
 *
 * ## Accessibility, and what the canvas is not allowed to be
 *
 * The canvas carries `aria-hidden` (set in `createPixiWorldHost` before the renderer
 * is created) and is not focusable. Everything it can do, the mirror group beside
 * it can do with a real button: two controls, both at least 44 by 44 CSS pixels,
 * both labelled, both reachable by Tab, both with a visible focus ring and a text
 * status line. Nothing here is hover-only, and no state is signalled by colour.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { asPixiApplication, createPixiApplication } from './createPixiApplication';
import { createPixiWorldHost } from './createPixiWorldHost';
import { resolveCozyWorldTheme } from './cozyWorldTheme';
import { PixiCanvas } from './PixiCanvas';
import { useWorldQuality } from './useWorldQuality';
import { currentWorldEnvironment } from './worldEnvironment';
import {
  type PixiWorldHost,
  type WorldAction,
  type WorldActionState,
  type WorldApplication,
  type WorldApplicationFactory,
  type WorldScene,
  type WorldSceneFactory,
} from './types';
import { createTestWorld } from '@/renderers/pixi/testworld/createTestWorld';
import { TestWorldActions } from '@/renderers/pixi/testworld/TestWorldActions';

export interface PixiWorldHostProps {
  /**
   * Overrides the renderer binding.
   *
   * Typed against the neutral {@link WorldApplicationFactory}, not against PixiJS,
   * so a test can supply a renderer with no GPU - and so Phase 10 can supply one
   * that pre-loads an asset bundle. Absent in production, where the real
   * `createPixiApplication` is used.
   */
  readonly applicationFactory?: WorldApplicationFactory;
  /**
   * Overrides the world.
   *
   * Absent in production, where the Phase 9 test world is used. Phase 11, 13, and 17
   * replace it with the Village, dungeon, and fishing scenes through this same prop
   * rather than by forking the host.
   */
  readonly sceneFactory?: WorldSceneFactory<WorldApplication, WorldScene>;
  /** A Cozy theme name, or a persisted legacy colour-theme string. */
  readonly colorTheme?: string;
}

const DEFAULT_SURFACE_ID = 'pixi-test-world';

/**
 * The default scene factory: the test world, bound to the concrete application.
 *
 * ## The binding, and what it is not
 *
 * This is the composition root, so it is where a `WorldApplication` is bound to a
 * PixiJS `Application`, and the binding is a **checked narrowing** rather than a
 * cast. `createPixiApplication` returns a nine-member lifecycle facade; `createTestWorld`
 * draws, so it needs `stage` and `screen`; and the facade has neither. The two ways
 * to pretend otherwise are both ruled out:
 *
 * - `application as unknown as PixiApplication` was the code that shipped. It
 *   type-checked, compiled, passed every unit test in the phase, and produced a
 *   runtime `TypeError` in the only place the two are actually bound together, so
 *   **no Pixi world has ever rendered in a browser**. A cast cannot fail; that is
 *   the whole problem with it.
 * - Declaring `stage` and `screen` on the port would put a scene graph into a
 *   renderer-neutral lifecycle contract for the convenience of one scene.
 *
 * What is there instead is `asPixiApplication`, which reads the facade's
 * `WorldApplication.native` and throws unless it really is a PixiJS `Application`.
 * The value behind that member is the object `createPixiApplication` created, so the
 * check is a fact about the value and not a hope about it. Phase 11 replaces this
 * line with the Village scene and nothing else: the scene factory keeps its
 * `PixiApplication` parameter, and the narrowing keeps the port out of the contract.
 */
const defaultSceneFactory: WorldSceneFactory<WorldApplication, WorldScene> = (application, init) =>
  createTestWorld(asPixiApplication(application), init);

export default function PixiWorldHost(props: PixiWorldHostProps = {}): JSX.Element {
  const { profile, reducedMotion } = useWorldQuality();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<PixiWorldHost | null>(null);

  const [actions, setActions] = useState<readonly WorldAction[]>([]);
  const [state, setState] = useState<WorldActionState>({});
  const [isReady, setIsReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const theme = useMemo(
    () => resolveCozyWorldTheme({ theme: props.colorTheme ?? null, reducedMotion }),
    [props.colorTheme, reducedMotion],
  );

  const { applicationFactory, sceneFactory } = props;
  const createApplication = applicationFactory ?? createPixiApplication;
  const createScene = sceneFactory ?? defaultSceneFactory;
  const quality = profile;
  const motionReduced = reducedMotion;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;

    const host = createPixiWorldHost({
      host: surface,
      createApplication,
      createScene,
      theme,
      quality,
      reducedMotion: motionReduced,
      environment: currentWorldEnvironment(),
    });
    hostRef.current = host;

    const stopReady = host.onReady(() => setIsReady(true));
    const stopState = host.onState((next) => {
      setState(next);
      setActions(host.actions);
    });

    // A failed mount is a state the screen has to show, not an unhandled rejection:
    // the learner would otherwise be left looking at an empty region with no
    // explanation, and a screen reader would have nothing to announce.
    let cancelled = false;
    host.mount().catch((error: unknown) => {
      if (cancelled) return;
      setFailure(error instanceof Error ? error.message : 'The world renderer could not start.');
    });

    return () => {
      cancelled = true;
      stopReady();
      stopState();
      host.unmount();
      hostRef.current = null;
      setIsReady(false);
      setActions([]);
      setState({});
    };
    // `theme` and `quality` are objects, so re-creating the host on every render
    // would remount the world on every state change. They are memoised above, and
    // the two factories are the only other values that can change the binding.
  }, [createApplication, createScene, motionReduced, quality, theme]);

  // The host needs to know which element is the mirror, so its keydown guard can
  // tell "this keystroke is already handled by a control" from "this keystroke is a
  // world shortcut". Set after the ref attaches and cleared on unmount, because a
  // stale element would silently disable the guard for the next world.
  useEffect(() => {
    hostRef.current?.setMirrorElement(mirrorRef.current);
  });

  const onActivate = useCallback((actionId: string) => {
    hostRef.current?.activateFromDom(actionId);
  }, []);

  return (
    <div
      className="pixi-world-host"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: px(theme.space['4']),
        padding: px(theme.space['4']),
        minHeight: px(theme.touchTargetMin),
        color: cssHex(theme.color.textPrimary),
        background: cssHex(theme.color.surfacePage),
        fontFamily: theme.fontFamily.body,
      }}
    >
      <h1 style={{ margin: 0, fontSize: px(theme.fontSize.xl), fontFamily: theme.fontFamily.display }}>
        PixiJS runtime host
      </h1>
      <p style={{ margin: 0, fontSize: px(theme.fontSize.md), color: cssHex(theme.color.textSecondary) }}>
        A Phase 9 test world on the PixiJS 8 host. Every action below also works from the canvas, and
        every canvas action has a control here.
      </p>

      <PixiCanvas
        surfaceId={DEFAULT_SURFACE_ID}
        surfaceRef={(element) => {
          surfaceRef.current = element;
        }}
        theme={theme}
        label="Test world canvas"
        description="A lantern and a bell drawn on a canvas. The buttons below perform the same actions."
      >
        <p
          // Announced when it changes, and never the only way the state is conveyed:
          // the sentence says which of reduced motion, the ticker, and readiness is
          // in play, in words.
          aria-live="polite"
          style={{ margin: 0, fontSize: px(theme.fontSize.sm), color: cssHex(theme.color.textMuted) }}
        >
          {statusSentence(isReady, motionReduced, profile.id, failure)}
        </p>
      </PixiCanvas>

      {failure !== null ? (
        <p role="alert" style={{ margin: 0, color: cssHex(theme.color.bad) }}>
          {failure}
        </p>
      ) : null}

      <TestWorldActions
        theme={theme}
        actions={actions}
        state={state}
        onActivate={onActivate}
        label="Test world actions"
        idPrefix={DEFAULT_SURFACE_ID}
        innerRef={(element) => {
          mirrorRef.current = element;
        }}
      />
    </div>
  );
}

/**
 * The status sentence under the canvas.
 *
 * Words, not colour and not an icon, because plan 10.1 forbids colour-only state
 * and an icon alone would be a shape a learner has to be told to interpret.
 */
function statusSentence(
  isReady: boolean,
  reducedMotion: boolean,
  qualityId: string,
  failure: string | null,
): string {
  if (failure !== null) return `World renderer stopped: ${failure}`;
  const parts = [
    isReady ? 'World presented' : 'World starting',
    reducedMotion ? 'Reduced motion: no travel' : 'Motion enabled',
    `Quality profile: ${qualityId}`,
  ];
  return `${parts.join('. ')}.`;
}

const px = (value: number): string => `${value}px`;

function cssHex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}
