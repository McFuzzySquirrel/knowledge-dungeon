/**
 * The village camera, as arithmetic.
 *
 * `src/renderers/pixi/camera/CameraRig.ts` imports no renderer, so every policy it
 * owns - zoom clamping, bounds clamping, follow smoothing, and world/screen
 * projection - is exercised here with no DOM, no canvas, and no GPU. The zoom
 * numbers are read from the authored village layout, so this file also pins the
 * contract that the rig starts at the village's default and clamps to the
 * village's range.
 *
 * What this file deliberately does not prove: that a mounted PixiJS scene *uses*
 * the rig. `village-scene.test.ts` drives the scene and reads the player's world
 * position; the two files together are what make "the camera is this arithmetic"
 * and "the scene applies this camera" separate, checkable claims.
 *
 * Hermeticity: no `dist/`, no network, no commit, no clock. Every number the test
 * uses is a literal.
 */
import { describe, expect, it } from 'vitest';

import { clampZoom, createCameraRig } from '../../src/renderers/pixi/camera/CameraRig';
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from '../../src/data/villageLayout';

const near = (received: number, expected: number, precision = 9): void => {
  expect(received).toBeCloseTo(expected, precision);
};

describe('the delivered zoom range is the village layout\'s', () => {
  it('is [0.6, 2.4], defaulting at 1.2', () => {
    expect(ZOOM_MIN).toBe(0.6);
    expect(ZOOM_MAX).toBe(2.4);
    expect(ZOOM_DEFAULT).toBe(1.2);
  });

  it('clampZoom clamps both edges and answers a non-finite input with the default', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    // A `NaN` is the realistic failure: a pinch ratio divided by a zero start
    // distance. It must not snap the view to its widest, so it lands on the default.
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(ZOOM_DEFAULT);
    // A per-rig override, so the module is usable by a world with a different range.
    expect(clampZoom(1, 2, 3)).toBe(2);
    expect(clampZoom(9, 2, 3)).toBe(3);
    expect(clampZoom(2.5, 2, 3)).toBe(2.5);
  });
});

describe('a rig starts centred at the default zoom', () => {
  it('reports the centre and the viewport it was built with', () => {
    const rig = createCameraRig({
      worldWidth: 1000,
      worldHeight: 800,
      viewportWidth: 400,
      viewportHeight: 300,
    });
    expect(rig.zoom).toBe(ZOOM_DEFAULT);
    const state = rig.getState();
    expect(state.centerX).toBe(500);
    expect(state.centerY).toBe(400);
    expect(state.viewportWidth).toBe(400);
    expect(state.viewportHeight).toBe(300);
  });

  it('honours a starting zoom, clamped into range', () => {
    const rig = createCameraRig({
      worldWidth: 1000,
      worldHeight: 800,
      viewportWidth: 400,
      viewportHeight: 300,
      zoom: 99,
    });
    expect(rig.zoom).toBe(ZOOM_MAX);
    rig.setZoom(0.01);
    expect(rig.zoom).toBe(ZOOM_MIN);
  });
});

describe('the centre is clamped inside the world', () => {
  const rig = (): ReturnType<typeof createCameraRig> =>
    createCameraRig({
      worldWidth: 1000,
      worldHeight: 800,
      viewportWidth: 400,
      viewportHeight: 300,
    });

  it('clamps a snap at each corner to the half-view inset, at the current zoom', () => {
    const camera = rig();
    // zoom 1.2: half-width is 400 / 2.4 = 166.67, half-height 300 / 2.4 = 125.
    camera.snapTo(0, 0);
    expect(camera.getState().centerX).toBeCloseTo(166.6667, 3);
    expect(camera.getState().centerY).toBeCloseTo(125, 3);
    camera.snapTo(5000, 5000);
    expect(camera.getState().centerX).toBeCloseTo(833.3333, 3);
    expect(camera.getState().centerY).toBeCloseTo(675, 3);
  });

  it('re-clamps when the zoom changes', () => {
    const camera = rig();
    camera.snapTo(166.6667, 125);
    camera.setZoom(ZOOM_DEFAULT);
    // Zooming in halves the half-view, so the same point stays legal.
    camera.setZoom(ZOOM_MAX);
    const state = camera.getState();
    expect(state.centerX).toBeGreaterThanOrEqual(400 / (2 * ZOOM_MAX));
    expect(state.centerY).toBeGreaterThanOrEqual(300 / (2 * ZOOM_MAX));
  });

  it('centres an axis whose world is smaller than the view, rather than pinning an edge', () => {
    const camera = createCameraRig({
      worldWidth: 100,
      worldHeight: 100,
      viewportWidth: 400,
      viewportHeight: 400,
      zoom: 1,
    });
    camera.snapTo(0, 0);
    expect(camera.getState().centerX).toBe(50);
    expect(camera.getState().centerY).toBe(50);
    camera.snapTo(100, 100);
    expect(camera.getState().centerX).toBe(50);
    expect(camera.getState().centerY).toBe(50);
  });

  it('re-clamps after a resize, so a larger view pulls the centre in', () => {
    const camera = createCameraRig({
      worldWidth: 1000,
      worldHeight: 800,
      viewportWidth: 400,
      viewportHeight: 300,
      zoom: 1,
    });
    camera.snapTo(0, 0);
    expect(camera.getState().centerX).toBe(200);
    camera.setViewport(200, 200);
    // The half-view is now 100, but the centre is still 200 - inside the new range,
    // so unchanged. A snap to the corner is what proves the re-clamp happened.
    camera.snapTo(0, 0);
    expect(camera.getState().centerX).toBe(100);
    expect(camera.getState().centerY).toBe(100);
  });
});

describe('world and screen coordinates round-trip', () => {
  it('returns the original point for a spread of points', () => {
    const camera = createCameraRig({
      worldWidth: 2000,
      worldHeight: 2000,
      viewportWidth: 800,
      viewportHeight: 600,
      zoom: 1.5,
    });
    camera.snapTo(700, 900);
    for (const [x, y] of [
      [0, 0],
      [1234.5, 678.9],
      [700, 900],
      [1999, 1999],
    ]) {
      const screen = camera.worldToScreen(x, y);
      const back = camera.screenToWorld(screen.x, screen.y);
      near(back.x, x);
      near(back.y, y);
    }
  });

  it('maps the centre to the middle of the viewport, whatever the zoom', () => {
    const camera = createCameraRig({
      worldWidth: 2000,
      worldHeight: 2000,
      viewportWidth: 800,
      viewportHeight: 600,
      zoom: 0.6,
    });
    camera.snapTo(1000, 1000);
    const centre = camera.worldToScreen(1000, 1000);
    expect(centre.x).toBe(400);
    expect(centre.y).toBe(300);
  });
});

describe('follow is a frame-rate-independent interpolation', () => {
  function followingRig(): ReturnType<typeof createCameraRig> {
    const camera = createCameraRig({
      worldWidth: 4000,
      worldHeight: 4000,
      viewportWidth: 400,
      viewportHeight: 300,
      zoom: 1,
    });
    camera.snapTo(1000, 1000);
    return camera;
  }

  it('moves part of the way on one frame and converges over many', () => {
    const camera = followingRig();
    camera.follow(2000, 2000);
    const before = camera.getState();
    camera.update(1000 / 60);
    const after = camera.getState();
    expect(after.centerX).toBeGreaterThan(before.centerX);
    expect(after.centerX).toBeLessThan(2000);
    for (let frame = 0; frame < 600; frame += 1) camera.update(1000 / 60);
    near(camera.getState().centerX, 2000, 3);
    near(camera.getState().centerY, 2000, 3);
  });

  it('is frame-rate independent: two half-frames equal one whole frame', () => {
    const whole = followingRig();
    const split = followingRig();
    whole.follow(3000, 2500);
    split.follow(3000, 2500);
    whole.update(1000 / 60);
    split.update(500 / 60);
    split.update(500 / 60);
    expect(split.getState().centerX).toBeCloseTo(whole.getState().centerX, 6);
    expect(split.getState().centerY).toBeCloseTo(whole.getState().centerY, 6);
  });

  it('a lerp of 1 snaps and a lerp of 0 never moves on its own', () => {
    const snapping = createCameraRig({
      worldWidth: 4000,
      worldHeight: 4000,
      viewportWidth: 400,
      viewportHeight: 300,
      zoom: 1,
      followLerp: 1,
    });
    snapping.snapTo(1000, 1000);
    snapping.follow(2000, 2000);
    snapping.update(1);
    expect(snapping.getState().centerX).toBe(2000);

    const frozen = createCameraRig({
      worldWidth: 4000,
      worldHeight: 4000,
      viewportWidth: 400,
      viewportHeight: 300,
      zoom: 1,
      followLerp: 0,
    });
    frozen.snapTo(1000, 1000);
    frozen.follow(2000, 2000);
    frozen.update(1000);
    expect(frozen.getState().centerX).toBe(1000);
  });

  it('ignores non-finite targets and non-positive deltas rather than producing a NaN', () => {
    const camera = followingRig();
    camera.follow(Number.NaN, Number.POSITIVE_INFINITY);
    camera.update(Number.NaN);
    camera.update(0);
    camera.update(-16);
    const state = camera.getState();
    expect(Number.isFinite(state.centerX)).toBe(true);
    expect(Number.isFinite(state.centerY)).toBe(true);
    expect(state.centerX).toBe(1000);
  });
});

describe('zoom deltas are clamped, and a malformed one is ignored', () => {
  it('addZoom clamps and ignores a non-finite delta', () => {
    const camera = createCameraRig({
      worldWidth: 4000,
      worldHeight: 4000,
      viewportWidth: 400,
      viewportHeight: 300,
    });
    camera.addZoom(100);
    expect(camera.zoom).toBe(ZOOM_MAX);
    camera.addZoom(-100);
    expect(camera.zoom).toBe(ZOOM_MIN);
    camera.addZoom(Number.NaN);
    expect(camera.zoom).toBe(ZOOM_MIN);
  });

  it('multiplyZoom ignores a non-positive or non-finite factor', () => {
    const camera = createCameraRig({
      worldWidth: 4000,
      worldHeight: 4000,
      viewportWidth: 400,
      viewportHeight: 300,
      zoom: 1,
    });
    camera.multiplyZoom(0);
    expect(camera.zoom).toBe(1);
    camera.multiplyZoom(-2);
    expect(camera.zoom).toBe(1);
    camera.multiplyZoom(Number.NaN);
    expect(camera.zoom).toBe(1);
    camera.multiplyZoom(2);
    expect(camera.zoom).toBe(2);
  });
});
