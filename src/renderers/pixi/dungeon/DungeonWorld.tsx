/**
 * The PixiJS dungeon surface and its DOM mirror.
 *
 * ## What this component is
 *
 * The `PixiCanvas` surface the renderer draws into, plus the controls that plan section
 * 10.1 requires: "a DOM equivalent for every Pixi interaction". Every world verb this
 * dungeon offers - interact, ascend, descend, zoom in, zoom out - has a labelled button
 * here at `theme.touchTargetMin` or larger, keyboard operable by construction because
 * they are real `<button>` elements, and never colour-coded: each says in words what it
 * will do and, where it does not apply, says so and is disabled rather than silently
 * doing nothing.
 *
 * ## Why the room list is here and not only in the full map
 *
 * The full map and the minimap are React surfaces owned by `ui-engineer`, and the plan
 * keeps them there. But a full map is a modal that covers the world, and the exit
 * criterion is "every world interaction has a DOM equivalent" - which for a dungeon means
 * a learner who cannot use the canvas at all still needs a route to *move between rooms*
 * that does not require opening a modal and closing it again for each hop. This is that
 * route: the rooms on the current floor, as a plain button list, filtered by the same
 * `visibleRoomIds` the renderer uses, so it cannot offer a room the world is hiding.
 *
 * The list deliberately does not *move* the player frame by frame. Teleporting is a
 * renderer-neutral flow action with a cooldown, and it is reached through the same
 * `onNavigateToRoom` callback the map uses, so the cooldown is enforced in exactly one
 * place.
 *
 * ## The canvas itself
 *
 * `aria-hidden` and not focusable, set by the Phase 9 host before the renderer exists. A
 * screen reader therefore gets the status sentence, the controls, and the room list, and
 * nothing is lost.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';

import { PixiCanvas } from '@/renderers/pixi/runtime/PixiCanvas';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { useWorldQuality } from '@/renderers/pixi/runtime/useWorldQuality';
import type { DungeonRendererCapabilities } from '@/application/contracts/renderer';
import type { DungeonWorldModel } from '@/application/contracts/world';
import type { WorldActionState } from '@/renderers/pixi/runtime/types';
import {
  DUNGEON_ACTIONS,
  DUNGEON_INTERACT_ACTION_ID,
  describeDungeonActionSentence,
  isDungeonActionUnavailable,
} from './createDungeonScene';
import {
  createPixiDungeonRenderer,
  type DungeonSceneCallbacks,
  type PixiDungeonRenderer,
} from './DungeonRenderer';

/** The surface and DOM-control group this component renders. */
export interface DungeonWorldProps {
  readonly world: DungeonWorldModel;
  readonly callbacks: DungeonSceneCallbacks;
  readonly colorTheme?: string;
  /** Test hook and stable id prefix. Defaults to `pixi-dungeon-world`. */
  readonly surfaceId?: string;
  /**
   * Navigate to a room by its id.
   *
   * A screen passes the renderer-neutral flow's teleport, so the shared teleport
   * cooldown applies. Left absent, the room buttons are rendered disabled rather than
   * as controls that do nothing.
   */
  readonly onNavigateToRoom?: (roomId: string) => void;
  /** Called once, after the first frame has been presented. */
  readonly onReady?: () => void;
}

/**
 * The imperative handle a parent screen holds.
 *
 * The narrowed capability port plus the two lifecycle members, which is what turns a
 * forgotten member into a `typecheck` failure rather than a runtime undefined.
 */
export interface DungeonWorldHandle extends DungeonRendererCapabilities {
  isReady(): boolean;
  restart(): void;
  /** Perform a named world action the way a DOM control does. */
  activateFromDom(actionId: string): void;
}

/**
 * ## `onState` is deliberately *not* on this handle
 *
 * It was, once, with a comment claiming `GameScreen` needed it because that screen pushes
 * the capability calls. `GameScreen` never subscribed - it re-renders from its own stores -
 * so the member had no production consumer and the comment asserted a use that did not
 * exist. That is the D1 defect class in miniature: a public member nobody reads, which
 * compiles cleanly and then drifts.
 *
 * Deleting it is stronger than documenting it. An unused member can be depended on by a
 * future caller and then silently change meaning; a missing member is a `typecheck` error.
 * The real consumer is this component, which subscribes to `PixiDungeonRenderer.onState`
 * directly and renders the per-control live regions, and `DungeonRenderer` is still where
 * the status comes from.
 */

const DEFAULT_SURFACE_ID = 'pixi-dungeon-world';

const px = (value: number): string => `${value}px`;

function cssHex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

const visuallyHidden: CSSProperties = {
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

/**
 * The status sentence under the canvas.
 *
 * Words, not colour and not an icon: plan 10.1 forbids colour-only state, and a learner
 * who cannot see the canvas still needs to know whether it started, which quality
 * profile is running, whether motion is reduced, and which floor they are on.
 */
function statusSentence(
  isReady: boolean,
  reducedMotion: boolean,
  qualityId: string,
  failure: string | null,
): string {
  if (failure !== null) return `Dungeon renderer stopped: ${failure}`;
  const parts = [
    isReady ? 'Dungeon presented' : 'Dungeon starting',
    reducedMotion ? 'Reduced motion: no zoom transitions' : 'Motion enabled',
    `Quality profile: ${qualityId}`,
  ];
  return `${parts.join('. ')}.`;
}

/**
 * The empty status a control shows before the scene has published one.
 *
 * Deliberately a sentence rather than an empty string, because an empty `aria-live`
 * region announces nothing at all and a control whose state is unknown must say so rather
 * than read as "nothing to report".
 */
const PENDING_STATUS = 'The dungeon is still starting.';

/** The button style every control in the mirror group shares. */
function controlStyle(theme: ReturnType<typeof resolveCozyWorldTheme>, disabled: boolean): CSSProperties {
  return {
    minWidth: px(theme.touchTargetMin),
    minHeight: px(theme.touchTargetMin),
    padding: `${px(theme.space['2'])} ${px(theme.space['4'])}`,
    fontFamily: theme.fontFamily.body,
    fontSize: px(theme.fontSize.md),
    fontWeight: theme.fontWeight.medium,
    lineHeight: theme.lineHeight.normal,
    color: cssHex(disabled ? theme.color.textMuted : theme.color.textPrimary),
    background: cssHex(theme.color.surfaceRaised),
    border: `${px(theme.border.state)} solid ${cssHex(theme.color.borderControl)}`,
    borderRadius: px(theme.radius.md),
    cursor: disabled ? 'not-allowed' : 'pointer',
    touchAction: 'manipulation',
    textAlign: 'left',
  };
}

const DungeonWorld = forwardRef<DungeonWorldHandle, DungeonWorldProps>(function DungeonWorld(
  props,
  ref,
): JSX.Element {
  const {
    world,
    callbacks,
    colorTheme,
    surfaceId = DEFAULT_SURFACE_ID,
    onNavigateToRoom,
    onReady,
  } = props;
  const { profile, reducedMotion } = useWorldQuality();

  const theme = useMemo(
    () => resolveCozyWorldTheme({ theme: colorTheme ?? null, reducedMotion }),
    [colorTheme, reducedMotion],
  );

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<PixiDungeonRenderer | null>(null);
  const callbacksRef = useRef(callbacks);
  const worldRef = useRef(world);
  const onReadyRef = useRef(onReady);

  const [isReady, setIsReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * The scene's per-action status, republished on every dispatch and every capability call.
   *
   * This is the fix for the dungeon mirror having no state channel at all: the host has
   * published `WorldActionState` since Phase 9 and this component subscribed only to
   * `onReady`, so every sentence the scene wrote - including "there are no stairs up in
   * this room" - reached no learner and the Ascend and Descend controls were focusable but
   * inert.
   */
  const [actionState, setActionState] = useState<WorldActionState>({});

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);
  useEffect(() => {
    worldRef.current = world;
  }, [world]);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  /**
   * One stable callback bag for the lifetime of the mount.
   *
   * The scene is built once and reports through these functions; forwarding into a ref
   * means a screen that re-creates its callbacks on every render does not tear the world
   * down, which is the difference between a HUD update and a remount.
   */
  const stableCallbacks = useMemo<DungeonSceneCallbacks>(
    () => ({
      onRoomEntered: (roomId) => callbacksRef.current.onRoomEntered(roomId),
      onInteract: (roomId) => callbacksRef.current.onInteract(roomId),
      onNpcInteract: (payload) => callbacksRef.current.onNpcInteract?.(payload),
      onNpcDialogPosition: (payload) => callbacksRef.current.onNpcDialogPosition?.(payload),
      onNpcOutOfRange: (roomId) => callbacksRef.current.onNpcOutOfRange?.(roomId),
      onArtifactCollected: (roomId) => callbacksRef.current.onArtifactCollected?.(roomId),
      onFloorTransition: (payload) => callbacksRef.current.onFloorTransition?.(payload),
    }),
    [],
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;

    const renderer = createPixiDungeonRenderer({
      host: surface,
      world: worldRef.current,
      callbacks: stableCallbacks,
      colorTheme,
      quality: profile.id,
    });
    rendererRef.current = renderer;

    const stopReady = renderer.onReady(() => {
      setIsReady(true);
      onReadyRef.current?.();
    });
    // Subscribed beside `onReady` rather than instead of it: readiness says the world
    // started, and this says what the world is currently offering.
    const stopState = renderer.onState(setActionState);

    try {
      renderer.mount();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The dungeon renderer could not start.');
    }

    return () => {
      stopReady();
      stopState();
      renderer.unmount();
      rendererRef.current = null;
      setIsReady(false);
      setActionState({});
    };
  }, [stableCallbacks, colorTheme, profile.id]);

  useImperativeHandle(
    ref,
    () => ({
      isReady: () => rendererRef.current?.isReady() ?? false,
      restart: () => rendererRef.current?.restart(),
      activateFromDom: (actionId) => rendererRef.current?.activateFromDom(actionId),
      setFloorVisibility: (visibility) => rendererRef.current?.setFloorVisibility(visibility),
      teleportToRoom: (roomId) => rendererRef.current?.teleportToRoom(roomId),
      setArtifactRooms: (roomIds, visible) => rendererRef.current?.setArtifactRooms(roomIds, visible),
      setCollectedArtifactRooms: (roomIds) =>
        rendererRef.current?.setCollectedArtifactRooms(roomIds),
      setReviewedArtifactRooms: (roomIds) =>
        rendererRef.current?.setReviewedArtifactRooms(roomIds),
      setImageRooms: (roomIds) => rendererRef.current?.setImageRooms(roomIds),
      setRoomOverlayStates: (states) => rendererRef.current?.setRoomOverlayStates(states),
      triggerInteract: () => rendererRef.current?.triggerInteract(),
    }),
    [],
  );

  /**
   * The rooms this floor shows, as navigation rows.
   *
   * Filtered by `world.floor.visibleRoomIds` here rather than trusting a caller, so the
   * list cannot offer a room the renderer is hiding - a mismatch would be a button that
   * teleports into a corridor that does not exist.
   */
  const visibleRooms = useMemo(() => {
    const visible = new Set(world.floor.visibleRoomIds);
    return world.map.rooms.filter((room) => visible.has(room.roomId));
  }, [world.floor.visibleRoomIds, world.map.rooms]);

  const canNavigate = onNavigateToRoom !== undefined;

  const onInteract = useCallback(() => {
    rendererRef.current?.triggerInteract();
  }, []);

  /**
   * One activation route for every named action, built from the scene's own action table.
   *
   * The table is the single declaration of what the dungeon offers and in what order, so
   * the control group below is a function of data rather than five hand-written buttons
   * that can drift from `DUNGEON_ACTIONS`. It also means a new action cannot be added
   * without a control appearing for it, and a control cannot appear without the scene
   * declaring it.
   *
   * `Interact` goes through `triggerInteract` rather than this route because that is the
   * Phase 2 capability the screens already speak, and the capability forwards to the
   * same dispatcher; the difference is naming, not behaviour.
   */
  const activateById = useCallback((actionId: string) => {
    rendererRef.current?.activateFromDom(actionId);
  }, []);

  return (
    <div
      className="pixi-dungeon-world"
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
        label="Dungeon canvas"
        description="Rooms, corridors, doors, floor portals, and the player for the subject dungeon. Move with the arrow keys or WASD, interact with E or Space, or use the dungeon actions below."
      >
        <p
          role="status"
          // Announced when it changes, and never the only way the state is conveyed: the
          // sentence names readiness, motion, and the quality profile in words.
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

      {/*
        The action group, rendered from `DUNGEON_ACTIONS`.

        Every control is described by two elements: a hint that says what the action does,
        and a per-control `aria-live` status line carrying the sentence the scene published
        for it. The status line is *visible* rather than hidden, for two reasons: a
        disabled control is not focusable, so a reason reachable only through
        `aria-describedby` would be unreachable exactly when it matters most; and plan 10.1
        forbids colour-only state, so the words must be on the page, not in an attribute.

        `disabled` is read from the same published sentence that is displayed. There is no
        second availability channel to disagree with it - which is what stops Ascend and
        Descend being focusable-but-inert, the Phase 12 defect class.
      */}
      <div
        role="group"
        aria-label="Dungeon actions"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: px(theme.space['3']),
          alignItems: 'flex-start',
        }}
      >
        {DUNGEON_ACTIONS.map((action) => {
          const hintId = `${surfaceId}-${action.id}-hint`;
          const statusId = `${surfaceId}-${action.id}-status`;
          const published = actionState[action.id];
          const unavailable = isDungeonActionUnavailable(published);
          const status = published === undefined ? PENDING_STATUS : describeDungeonActionSentence(published);
          const isInteract = action.id === DUNGEON_INTERACT_ACTION_ID;
          return (
            <div
              key={action.id}
              style={{ display: 'flex', flexDirection: 'column', gap: px(theme.space['1']) }}
            >
              <button
                type="button"
                // Unavailable until the scene says otherwise, so a control is never
                // focusable-but-inert.
                disabled={unavailable}
                aria-describedby={`${hintId} ${statusId}`}
                aria-label={action.label}
                data-action-id={action.id}
                onClick={() => (isInteract ? onInteract() : activateById(action.id))}
                style={controlStyle(theme, unavailable)}
              >
                {action.label}
              </button>
              <span id={hintId} style={visuallyHidden}>
                {action.hint}
              </span>
              <span
                id={statusId}
                aria-live="polite"
                data-action-status={action.id}
                style={{
                  maxWidth: px(theme.space['12'] * 8),
                  fontFamily: theme.fontFamily.body,
                  fontSize: px(theme.fontSize.sm),
                  lineHeight: theme.lineHeight.snug,
                  color: cssHex(theme.color.textSecondary),
                  background: 'transparent',
                }}
              >
                {status}
              </span>
            </div>
          );
        })}
      </div>

      {/*
        The room list is the DOM route to a *different room*. The map is a modal; this
        is not, and it is filtered by the same floor visibility the renderer uses, so a
        row can never name a room the world is hiding. `canNavigate` rather than a
        no-op handler: a caller that did not supply a navigator gets a described,
        disabled list instead of a control that silently does nothing.
      */}
      <div
        role="group"
        aria-label="Room navigation"
        style={{ display: 'flex', flexDirection: 'column', gap: px(theme.space['2']) }}
      >
        <span style={{ fontSize: px(theme.fontSize.sm), color: cssHex(theme.color.textSecondary) }}>
          Rooms on this floor
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: px(theme.space['2']) }}>
          {visibleRooms.length === 0 ? (
            <span style={visuallyHidden}>No rooms are visible on this floor.</span>
          ) : (
            visibleRooms.map((room) => (
              <button
                key={room.roomId}
                type="button"
                disabled={!canNavigate}
                onClick={() => onNavigateToRoom?.(room.roomId)}
                aria-label={`Go to ${room.topic}`}
                style={controlStyle(theme, !canNavigate)}
              >
                {room.topic}
              </button>
            ))
          )}
        </div>
        {!canNavigate ? (
          <span style={{ fontSize: px(theme.fontSize.sm), color: cssHex(theme.color.textMuted) }}>
            Room navigation is unavailable in this view. Use the full map to travel.
          </span>
        ) : null}
      </div>
    </div>
  );
});

export default DungeonWorld;