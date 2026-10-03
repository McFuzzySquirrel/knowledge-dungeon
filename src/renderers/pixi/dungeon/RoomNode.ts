/**
 * One dungeon room, as a set of display objects with a state contract.
 *
 * ## Why a node rather than a draw function
 *
 * The Phaser scene drew a room in one pass and then re-drew all of them whenever the
 * floor changed, room overlay states arrived, or a room was collected. That is a fine
 * design for a scene that owns everything, and it is the wrong one for a scene that has
 * to be *asserted*: "is this room's cleared chest drawn" and "does this room's wall
 * have a gap where the door is" were both unanswerable without reading pixels.
 *
 * A node keeps the geometry it was given and exposes {@link RoomNode.apply}, which
 * takes a plain {@link RoomNodeState} and makes the drawing match it. The tests drive
 * `apply` and read the labelled children; the scene drives `apply` from its own state.
 * One description, two readers.
 *
 * ## No colour-only state
 *
 * Plan 10.1 forbids communicating a room's state with colour alone, and the Phaser scene
 * did communicate it that way: the wall stroke was the only difference between a
 * cleared room and an unvisited one. Every state here therefore has a *shape* as well as
 * a tint - an open lid, a closed bar, a chevron pointing the way you must walk - so a
 * learner who cannot distinguish the hues still reads the room. The topic label repeats
 * the state in words for the same reason.
 *
 * ## The art
 *
 * All of it procedural, in the same style as the village: `Graphics` and `Text`, no
 * image files. The dungeon sprites under `public/assets/sprites/` are
 * `legacy-unverified` and the CC0 gate admits none of them to a Pixi bundle, so drawing
 * them procedurally is not a simplification - it is the only admitted path today.
 */
import { Container, Graphics, Text } from 'pixi.js';

import type { DungeonDoor, DungeonRoom } from '@/core/layout/dungeonTypes';
import { cozyTextStyle, type CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import {
  describeDungeonArtifactMarkerSuffix,
  isDungeonArtifactMarkerDrawn,
  type DungeonArtifactMarkerState,
} from './dungeonArtifact';
import { roomWallSegments } from './CorridorLayer';
import { lightenHex, resolveRoomDecor, resolveRoomGuidePosition } from './WalkabilityController';

/** Wall stroke weight, in world pixels. */
const WALL_STROKE = 3;

/** Inset of the inner floor band inside the room shell, in world pixels. */
const FLOOR_INSET = 4;

/** How far above the room centre the artifact marker and the stairs sit, as a room fraction. */
const MARKER_LIFT = 0.25;

/** Review dot and picture-frame offsets, as fractions of the room's pixel size. */
const REVIEW_OFFSET_X = 0.31;
const REVIEW_OFFSET_Y = 0.34;
const IMAGE_OFFSET_X = 0.3;
const IMAGE_OFFSET_Y = 0.28;

/** Drawn sizes, in world pixels. */
const ARTIFACT_MARKER_SIZE = 26;
const REVIEW_MARKER_SIZE = 9;
const IMAGE_MARKER_SIZE = 20;
const PORTAL_MARKER_SIZE = 28;
const GUIDE_MARKER_SIZE = 28;
const DECOR_SIZE = 24;

/** Which way the stairs in this room go. */
export type RoomPortalDirection = 'up' | 'down';

/**
 * Everything about a room that can change without the room changing.
 *
 * All plain data, so a test can build one and a scene can build one from its own
 * fields. `overlayState` falls back to the map's own `room.status` when a caller has
 * nothing better, which is what the Phaser scene did and is why a freshly generated
 * subject still shows cleared rooms as cleared.
 */
export interface RoomNodeState {
  /** Dynamic room state (`Created`, `EncounterDefeated`, …), or the map status. */
  readonly overlayState: string;
  /** The stairs this room holds, or `null`. */
  readonly portal: RoomPortalDirection | null;
  /** Whether the player is standing in this room right now. */
  readonly focused: boolean;
  /**
   * What this room's artifact marker is doing.
   *
   * One field rather than `artifactVisible` plus `artifactCollected`, because the two
   * booleans could only be combined downstream and every combination was a state nobody
   * had named: "an artifact exists but may not be picked up right now" is not "no
   * artifact", and a room that had been collected is not "not yet collected". The marker
   * and the room label now read the same decision.
   */
  readonly artifactMarker: DungeonArtifactMarkerState;
  /** Whether this room already carries a review marker. */
  readonly reviewed: boolean;
  /** Whether this room has image attachments. */
  readonly imageAttachment: boolean;
  /** The floor id, which seeds decor and guide placement. */
  readonly floorId: string;
}

export interface CreateRoomNodeOptions {
  readonly room: DungeonRoom;
  readonly tileSize: number;
  readonly theme: CozyWorldTheme;
  readonly parent: Container;
  /** The floor's wall tint, from the biome palette. */
  readonly wallTint: number;
  /** Every door on this room's perimeter. */
  readonly doors: readonly DungeonDoor[];
}

/**
 * A room, drawn.
 *
 * `apply` is idempotent and cheap: sub-containers are built once and `apply` toggles
 * their visibility and tints, redrawing only the walls - the one thing whose geometry
 * changes with the portal and status - and only when the style it depends on actually
 * changed.
 */
export interface RoomNode {
  readonly roomId: string;
  readonly container: Container;
  apply(state: RoomNodeState): void;
  destroy(): void;
}

/** The label a room's container is drawn under. Stable, and what the tests read. */
export function roomNodeLabel(roomId: string): string {
  return `dungeon-room-${roomId}`;
}

/** The wall colour for a room state. The Phaser scene's `statusColor`, unchanged. */
export function roomStatusColor(status: string, portalColor: number): number {
  if (status === 'EncounterDefeated' || status === 'ArtifactCollected') return 0x4fd1a5;
  if (status === 'NotesDrafted') return 0x7be3ff;
  if (status === 'NeedsRevalidation') return 0xff7676;
  if (status === 'Visited') return 0x7fb2ff;
  return portalColor;
}

/** Build a room node and draw its initial state. */
export function createRoomNode(options: CreateRoomNodeOptions): RoomNode {
  const { room, tileSize, theme } = options;
  const left = room.gridX * tileSize;
  const top = room.gridY * tileSize;
  const width = room.width * tileSize;
  const height = room.height * tileSize;
  const centerX = left + width / 2;
  const centerY = top + height / 2;

  const container = new Container();
  container.label = roomNodeLabel(room.roomId);
  container.position.set(0, 0);
  options.parent.addChild(container);

  // ── Shell and floor band ────────────────────────────────────────────────
  const shell = new Graphics();
  shell.label = 'dungeon-room-shell';
  shell.rect(left, top, width, height).fill({ color: options.wallTint, alpha: 1 });
  container.addChild(shell);

  const floorBand = new Graphics();
  floorBand.label = 'dungeon-room-floor';
  floorBand
    .rect(left + FLOOR_INSET, top + FLOOR_INSET, width - FLOOR_INSET * 2, height - FLOOR_INSET * 2)
    .fill({ color: lightenHex(options.wallTint, 24), alpha: 0.65 });
  container.addChild(floorBand);

  const walls = new Graphics();
  walls.label = 'dungeon-room-walls';
  container.addChild(walls);

  // ── Deterministic decor ──────────────────────────────────────────────────
  const decor = new Container();
  decor.label = 'dungeon-room-decor';
  container.addChild(decor);

  // ── State markers ────────────────────────────────────────────────────────
  const overlay = new Graphics();
  overlay.label = 'dungeon-room-overlay';
  container.addChild(overlay);

  const portal = new Graphics();
  portal.label = 'dungeon-room-portal';
  container.addChild(portal);

  const artifact = new Graphics();
  artifact.label = 'dungeon-room-artifact';
  container.addChild(artifact);

  const guide = new Graphics();
  guide.label = 'dungeon-room-guide';
  container.addChild(guide);

  const review = new Graphics();
  review.label = 'dungeon-room-review';
  review
    .circle(centerX + width * REVIEW_OFFSET_X, centerY - height * REVIEW_OFFSET_Y, REVIEW_MARKER_SIZE / 2)
    .fill({ color: theme.color.accent, alpha: 0.95 })
    .stroke({ width: theme.border.hairline, color: theme.color.borderStrong, alpha: 0.9 });
  container.addChild(review);

  const imageMarker = new Graphics();
  imageMarker.label = 'dungeon-room-image';
  imageMarker
    .roundRect(
      centerX + width * IMAGE_OFFSET_X - IMAGE_MARKER_SIZE / 2,
      centerY + height * IMAGE_OFFSET_Y - IMAGE_MARKER_SIZE / 2,
      IMAGE_MARKER_SIZE,
      IMAGE_MARKER_SIZE * 0.8,
      theme.radius.sm,
    )
    .fill({ color: theme.color.surfaceRaised, alpha: 0.9 })
    .stroke({ width: theme.border.state, color: theme.color.borderControl, alpha: 1 });
  container.addChild(imageMarker);

  const focusRing = new Graphics();
  focusRing.label = 'dungeon-room-focus';
  focusRing
    .roundRect(left - 2, top - 2, width + 4, height + 4, theme.radius.sm)
    .stroke({ width: theme.focus.ringWidth, color: theme.color.borderFocus, alpha: 0.9 });
  container.addChild(focusRing);

  // ── Label ───────────────────────────────────────────────────────────────
  // The topic wraps to the room's own width rather than overflowing it, which is the
  // Phaser scene's `wordWrap: { width: w - 8 }` in PixiJS's spelling. The wrap width is
  // part of the style rather than a later assignment because a `Text` re-measures its
  // bounds from the style, and a label wider than its room overlaps the next one.
  const label = new Text({
    text: room.topic,
    style: {
      ...cozyTextStyle(theme, { size: 'xs', color: 'textPrimary' }),
      align: 'center',
      wordWrap: true,
      wordWrapWidth: Math.max(16, width - 8),
    },
  });
  label.label = 'dungeon-room-label';
  label.anchor.set(0.5, 1);
  label.position.set(centerX, top + height - 12);
  container.addChild(label);

  let wallStyleKey = '';
  let currentFloorId: string | null = null;

  function drawWalls(state: RoomNodeState): void {
    const isPortal = state.portal !== null;
    const color = roomStatusColor(state.overlayState, theme.color.accent);
    const key = `${isPortal ? 'portal' : state.overlayState}`;
    if (key === wallStyleKey) return;
    wallStyleKey = key;
    walls.clear();
    for (const segment of roomWallSegments(room, options.doors, tileSize)) {
      walls.moveTo(segment.x1, segment.y1).lineTo(segment.x2, segment.y2);
    }
    walls.stroke({
      width: WALL_STROKE,
      color: isPortal ? theme.color.accent : color,
      alpha: 1,
    });
    // The portal tint and the state tint are two different channels, so a portal room
    // that also happens to be cleared still reads as a portal.
    if (isPortal) {
      walls.moveTo(left, top).lineTo(left + width, top);
      walls.stroke({ width: WALL_STROKE / 2, color, alpha: 0.9 });
    }
  }

  function drawOverlay(state: RoomNodeState): void {
    overlay.clear();
    if (state.portal !== null) return;
    const markerX = centerX;
    const markerY = centerY - 4;
    if (state.overlayState === 'EncounterDefeated' || state.overlayState === 'ArtifactCollected') {
      // An open chest: a body, a raised lid, and a gap between them. The lid is the
      // part that says "open", which is the state rather than the colour.
      const bodyWidth = 20;
      const bodyHeight = 12;
      overlay
        .roundRect(markerX - bodyWidth / 2, markerY, bodyWidth, bodyHeight, theme.radius.sm)
        .fill({ color: theme.color.surfaceRaised, alpha: 1 })
        .stroke({ width: theme.border.state, color: theme.color.borderStrong, alpha: 1 });
      overlay
        .moveTo(markerX - bodyWidth / 2, markerY - 2)
        .lineTo(markerX - bodyWidth / 2 + 2, markerY - 8)
        .lineTo(markerX + bodyWidth / 2 - 2, markerY - 8)
        .lineTo(markerX + bodyWidth / 2, markerY - 2)
        .stroke({ width: theme.border.state, color: theme.color.accent, alpha: 1 });
      return;
    }
    if (state.overlayState === 'Created') {
      // A locked plate across the east wall: bars, not a colour change.
      const doorX = left + width - 6;
      const doorY = centerY;
      const barWidth = 3;
      const barHeight = tileSize * 0.7;
      overlay
        .roundRect(doorX - barWidth, doorY - barHeight / 2, barWidth * 2, barHeight, theme.radius.sm)
        .fill({ color: theme.color.surfacePanel, alpha: 1 })
        .stroke({ width: theme.border.state, color: theme.color.textMuted, alpha: 1 });
      for (let offset = -barHeight / 4; offset <= barHeight / 4; offset += barHeight / 4) {
        overlay
          .moveTo(doorX - barWidth, doorY + offset)
          .lineTo(doorX + barWidth, doorY + offset)
          .stroke({ width: theme.border.hairline, color: theme.color.textMuted, alpha: 0.9 });
      }
    }
  }

  function drawPortal(direction: RoomPortalDirection | null): void {
    portal.clear();
    if (direction === null) return;
    const x = centerX;
    const y = centerY - height * MARKER_LIFT;
    const steps = direction === 'up' ? 2 : 3;
    const unit = PORTAL_MARKER_SIZE * 0.22;
    for (let i = 0; i < steps; i += 1) {
      const offset = (i - (steps - 1) / 2) * unit * 1.6;
      const tipY = y + (direction === 'up' ? -offset : offset);
      portal
        .moveTo(x - unit * 1.2, tipY + (direction === 'up' ? unit : -unit))
        .lineTo(x, tipY)
        .lineTo(x + unit * 1.2, tipY + (direction === 'up' ? unit : -unit));
    }
    portal.stroke({ width: theme.border.state, color: theme.color.accent, alpha: 1 });
    portal
      .roundRect(x - PORTAL_MARKER_SIZE / 2, y - PORTAL_MARKER_SIZE / 2, PORTAL_MARKER_SIZE, PORTAL_MARKER_SIZE, theme.radius.pill)
      .stroke({ width: theme.border.hairline, color: theme.color.borderStrong, alpha: 0.7 });
  }

  /**
   * Draw the artifact marker.
   *
   * A diamond in a soft disc - a silhouette that is not a colour - and it is drawn for
   * `collectible` only. A collected artifact draws *nothing*: the pickup is over, and the
   * open chest in {@link drawOverlay} plus the words `apply` writes into the room label are
   * how the room says so. A room whose artifact exists but may not be picked up in the
   * current phase also draws nothing, because offering a marker the pickup would refuse is
   * worse than offering nothing.
   */
  function drawArtifact(state: DungeonArtifactMarkerState): void {
    artifact.clear();
    if (!isDungeonArtifactMarkerDrawn(state)) return;
    const x = centerX;
    const y = centerY - height * MARKER_LIFT;
    artifact
      .circle(x, y, ARTIFACT_MARKER_SIZE)
      .fill({ color: theme.color.accentDeep, alpha: 0.2 })
      .circle(x, y, ARTIFACT_MARKER_SIZE * 0.6)
      .fill({ color: theme.color.accentSoft, alpha: 0.35 })
      // A diamond, so the marker has a silhouette that is not a disc.
      .poly([x, y - 8, x + 6, y, x, y + 8, x - 6, y])
      .fill({ color: theme.color.accent, alpha: 1 })
      .stroke({ width: theme.border.hairline, color: theme.color.surfacePage, alpha: 0.9 });
  }

  function drawDecor(floorId: string): void {
    decor.removeChildren().forEach((child) => child.destroy());
    for (const placement of resolveRoomDecor(room, floorId, tileSize)) {
      const piece = new Graphics();
      const half = DECOR_SIZE / 2;
      switch (placement.kind) {
        case 'bookshelf':
          piece
            .roundRect(placement.x - half / 2, placement.y - half, half, half * 2, theme.radius.sm)
            .fill({ color: theme.color.surfacePanel, alpha: 1 })
            .stroke({ width: theme.border.hairline, color: theme.color.borderStrong, alpha: 1 });
          break;
        case 'brazier':
          piece
            .roundRect(placement.x - half / 2, placement.y - half / 2, half, half, theme.radius.sm)
            .fill({ color: theme.color.surfaceRaised, alpha: 1 })
            .stroke({ width: theme.border.hairline, color: theme.color.borderStrong, alpha: 1 });
          piece
            .circle(placement.x, placement.y - half / 2, half * 0.4)
            .fill({ color: theme.color.accent, alpha: 0.9 });
          break;
        default:
          piece
            .circle(placement.x, placement.y, half * 0.7)
            .fill({ color: theme.color.surfaceRaised, alpha: 0.95 })
            .stroke({ width: theme.border.hairline, color: theme.color.borderControl, alpha: 1 });
          break;
      }
      decor.addChild(piece);
    }
  }

  function drawGuide(floorId: string): void {
    guide.clear();
    const position = resolveRoomGuidePosition(room, floorId, tileSize);
    const half = GUIDE_MARKER_SIZE / 2;
    guide
      .circle(position.x, position.y + half * 0.6, half * 0.7)
      .fill({ color: theme.color.surfacePage, alpha: 0.35 })
      .circle(position.x, position.y, half * 0.55)
      .fill({ color: theme.color.surfaceRaised, alpha: 1 })
      .stroke({ width: theme.border.state, color: theme.color.accent, alpha: 1 })
      .circle(position.x, position.y - half * 0.2, half * 0.22)
      .fill({ color: theme.color.textPrimary, alpha: 0.9 });
    // An eye, so the guide is recognisable without its colour.
    guide
      .circle(position.x, position.y - half * 0.2, half * 0.1)
      .fill({ color: theme.color.surfacePage, alpha: 1 });
  }

  function apply(state: RoomNodeState): void {
    if (currentFloorId !== state.floorId) {
      currentFloorId = state.floorId;
      drawDecor(state.floorId);
      drawGuide(state.floorId);
      wallStyleKey = '';
    }
    drawWalls(state);
    drawOverlay(state);
    drawPortal(state.portal);
    drawArtifact(state.artifactMarker);

    const isPortal = state.portal !== null;
    floorBand.alpha = isPortal ? 1 : 0.65;
    label.style.fill = isPortal ? theme.color.accent : theme.color.textPrimary;
    // The room label repeats the artifact state in words, because the marker is a shape:
    // a diamond means "collectible" to someone who can see the canvas and to nobody else.
    // It previously appended a `✓` for the collected case, which covered one of three
    // states and was a symbol rather than a sentence.
    const artifactSuffix = describeDungeonArtifactMarkerSuffix(state.artifactMarker);
    const roomName = `${room.topic}${artifactSuffix}`;
    label.text = `${state.portal === 'up' ? '↑ ' : state.portal === 'down' ? '↓ ' : ''}${roomName}`;

    // The accessible name is set as well as drawn, so the state has a carrier that is not
    // a glyph even for a consumer reading the scene graph rather than the pixels. The
    // dungeon's canvas is `aria-hidden` today, so nothing consumes these yet - they are set
    // because the alternative is a host that turns the accessibility system on and finds a
    // room whose name says nothing about the artifact standing in it.
    container.accessibleTitle = roomName;
    artifact.accessibleTitle = roomName;
    artifact.accessibleHint =
      state.artifactMarker === 'collectible'
        ? 'Walk onto the marker to collect this artifact into the journal.'
        : null;

    review.visible = state.reviewed;
    imageMarker.visible = state.imageAttachment;
    focusRing.visible = state.focused;
    guide.visible = state.focused;
    decor.visible = !isPortal;
  }

  return {
    roomId: room.roomId,
    container,
    apply,
    destroy(): void {
      container.removeChildren().forEach((child) => child.destroy());
      container.destroy();
    },
  };
}