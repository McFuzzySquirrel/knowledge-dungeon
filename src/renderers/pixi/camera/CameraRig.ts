/**
 * The camera, as arithmetic.
 *
 * ## Why this is not in the scene
 *
 * A camera is a projection between two coordinate spaces plus four policies -
 * zoom clamping, bounds clamping, follow smoothing, and resize. None of those
 * needs a GPU, a canvas, or a scene graph, and all of them are the kind of thing
 * that is wrong in a way a screenshot only sometimes shows: a view that drifts a
 * pixel per frame, a follow that converges at a different speed on a 120 Hz
 * display, a zoom that clamps at one edge and not the other. So the whole of it
 * lives here, in a module that imports no renderer and can be exercised in a
 * realm with no DOM.
 *
 * The camera is stored as the **centre** of the view in world coordinates rather
 * than as a top-left scroll offset. The centre is what `follow` interpolates and
 * what bounds clamping is symmetric about; a top-left offset would need the
 * viewport size subtracted in every policy and every projection.
 *
 * ## Where the numbers come from
 *
 * The zoom floor, ceiling, and default are the village's, and they live in
 * `src/data/villageLayout.ts` beside every other village constant so there is one
 * authored source. They are read as defaults here and can be overridden per rig,
 * which is what keeps this module usable by a dungeon whose zoom range differs.
 */
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from '@/data/villageLayout';

/** How much of the remaining distance a follow closes per 60 Hz frame. */
const DEFAULT_FOLLOW_LERP = 0.08;

/** The 60 Hz frame the follow lerp is authored against. */
const FRAME_MS = 1000 / 60;

/** A point in either space. */
export interface CameraPoint {
  readonly x: number;
  readonly y: number;
}

/** The resolved camera, in world coordinates for the centre and CSS pixels for the view. */
export interface CameraState {
  /** World x of the centre of the view. */
  readonly centerX: number;
  /** World y of the centre of the view. */
  readonly centerY: number;
  readonly zoom: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface CameraRigOptions {
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Starting zoom. Clamped into range. Defaults to {@link ZOOM_DEFAULT}. */
  readonly zoom?: number;
  /**
   * Follow smoothing, per 60 Hz frame. `0` never moves the camera on its own;
   * `1` snaps. Applied frame-rate independently in {@link CameraRig.update}.
   */
  readonly followLerp?: number;
  readonly zoomMin?: number;
  readonly zoomMax?: number;
}

export interface CameraRig {
  /** The current zoom, already clamped. */
  readonly zoom: number;
  /** The drawing surface changed size, in CSS pixels. */
  setViewport(width: number, height: number): void;
  /** The world changed size, in world units. */
  setBounds(width: number, height: number): void;
  setZoom(zoom: number): void;
  /** Add a zoom delta (a wheel notch, a pinch approximation). Clamped. */
  addZoom(delta: number): void;
  /** Multiply the zoom (a pinch ratio). Non-positive and non-finite factors are ignored. */
  multiplyZoom(factor: number): void;
  /** Centre the camera somewhere immediately, and make it the follow target. */
  snapTo(worldX: number, worldY: number): void;
  /** Set the follow target. The camera reaches it over subsequent `update`s. */
  follow(worldX: number, worldY: number): void;
  /** Advance the follow smoothing by `deltaMs` milliseconds. */
  update(deltaMs: number): void;
  /** Project a world point into viewport pixels. */
  worldToScreen(worldX: number, worldY: number): CameraPoint;
  /** Project a viewport pixel into world coordinates. */
  screenToWorld(screenX: number, screenY: number): CameraPoint;
  getState(): CameraState;
}

/** Clamp a number, total over non-finite input by returning `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp a zoom into `[min, max]`, with a defined answer for a non-finite value.
 *
 * A `NaN` zoom is the realistic failure: it reaches here from a pinch ratio
 * divided by a zero starting distance. Falling back to the default rather than to
 * the floor keeps a malformed gesture from snapping the view to its widest.
 */
export function clampZoom(zoom: number, min: number = ZOOM_MIN, max: number = ZOOM_MAX): number {
  if (!Number.isFinite(zoom)) return ZOOM_DEFAULT;
  return clamp(zoom, min, max);
}

/**
 * Build a camera rig.
 *
 * The rig is a plain closure with no frame subscription of its own: a caller owns
 * the ticker and calls {@link CameraRig.update}, which is what lets the same rig
 * be driven by a PixiJS ticker, a test loop, or a single resize.
 */
export function createCameraRig(options: CameraRigOptions): CameraRig {
  let worldWidth = Math.max(1, options.worldWidth);
  let worldHeight = Math.max(1, options.worldHeight);
  let viewportWidth = Math.max(1, options.viewportWidth);
  let viewportHeight = Math.max(1, options.viewportHeight);

  const zoomMin = options.zoomMin ?? ZOOM_MIN;
  const zoomMax = options.zoomMax ?? ZOOM_MAX;
  let zoom = clampZoom(options.zoom ?? ZOOM_DEFAULT, zoomMin, zoomMax);
  const followLerp = clamp(options.followLerp ?? DEFAULT_FOLLOW_LERP, 0, 1);

  let centerX = worldWidth / 2;
  let centerY = worldHeight / 2;
  let targetX = centerX;
  let targetY = centerY;

  /**
   * Pull the centre back inside the bounds.
   *
   * When the view is larger than the world on an axis, the axis is centred rather
   * than clamped, which is why the `else` branch sets `worldSize / 2` instead of
   * the ordinary clamp's floor: `worldSize / 2` is the only centre that shows the
   * whole dimension with equal margins, and a naive clamp would pin it to one
   * edge and show empty space on the other.
   */
  function clampCenter(): void {
    const halfWidth = viewportWidth / (2 * zoom);
    const halfHeight = viewportHeight / (2 * zoom);
    centerX =
      worldWidth <= halfWidth * 2 ? worldWidth / 2 : clamp(centerX, halfWidth, worldWidth - halfWidth);
    centerY =
      worldHeight <= halfHeight * 2
        ? worldHeight / 2
        : clamp(centerY, halfHeight, worldHeight - halfHeight);
  }

  clampCenter();

  function setZoom(next: number): void {
    zoom = clampZoom(next, zoomMin, zoomMax);
    clampCenter();
  }

  function addZoom(delta: number): void {
    if (!Number.isFinite(delta)) return;
    setZoom(zoom + delta);
  }

  function multiplyZoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    setZoom(zoom * factor);
  }

  function snapTo(worldX: number, worldY: number): void {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    centerX = worldX;
    centerY = worldY;
    targetX = worldX;
    targetY = worldY;
    clampCenter();
  }

  function follow(worldX: number, worldY: number): void {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    targetX = worldX;
    targetY = worldY;
  }

  function update(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const t = followLerp >= 1 ? 1 : 1 - Math.pow(1 - followLerp, deltaMs / FRAME_MS);
    centerX += (targetX - centerX) * t;
    centerY += (targetY - centerY) * t;
    clampCenter();
  }

  function worldToScreen(worldX: number, worldY: number): CameraPoint {
    return {
      x: (worldX - centerX) * zoom + viewportWidth / 2,
      y: (worldY - centerY) * zoom + viewportHeight / 2,
    };
  }

  function screenToWorld(screenX: number, screenY: number): CameraPoint {
    return {
      x: (screenX - viewportWidth / 2) / zoom + centerX,
      y: (screenY - viewportHeight / 2) / zoom + centerY,
    };
  }

  return {
    get zoom(): number {
      return zoom;
    },
    setViewport(width: number, height: number): void {
      viewportWidth = Math.max(1, width);
      viewportHeight = Math.max(1, height);
      clampCenter();
    },
    setBounds(width: number, height: number): void {
      worldWidth = Math.max(1, width);
      worldHeight = Math.max(1, height);
      clampCenter();
    },
    setZoom,
    addZoom,
    multiplyZoom,
    snapTo,
    follow,
    update,
    worldToScreen,
    screenToWorld,
    getState(): CameraState {
      return { centerX, centerY, zoom, viewportWidth, viewportHeight };
    },
  };
}
