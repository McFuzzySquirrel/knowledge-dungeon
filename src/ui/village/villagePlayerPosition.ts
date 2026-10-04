/**
 * Publishes the learner's village tile as `data-village-player` on the screen root.
 *
 * ## The gap this file exists to close
 *
 * The village published a *distance* to each nearby structure and never a *position*. A
 * walker - a keyboard learner pressing arrow keys, or an end-to-end harness doing the
 * same - therefore had no way to know where it was standing, so every leg aimed at a
 * structure's centre while pressing from wherever the previous leg ended. Measured over
 * an instrumented walk, each leg started **30.8 px and 41.6 px** off its aim point on a
 * 48 px tile, and the next leg then aimed a 25-tile heading from a position it was never
 * at. One run polled 212 times with a correct heading, never once saw the pond row, and
 * walked off the map.
 *
 * Two harness-side repairs were tried and both were rejected on evidence. So this is the
 * product-side fix: the village now states where the learner is, in the one coordinate
 * system the world itself uses.
 *
 * ## Why a tile, and why this exact spelling
 *
 * `"<gridX>,<gridY>"` - two integers, comma-separated, no spaces, no sign padding. A
 * **tile**, not a pixel, because the tile is the unit collision and interaction are
 * computed in: `VILLAGE_MAP.tileSize` on the Phaser lane and `VILLAGE_TILE_SIZE` on the
 * Pixi lane are the same 48 px, and both scenes place a structure at
 * `(gridX + width / 2) * tile`. A consumer that aims at a structure's `gridX/gridY` and
 * its own published tile is then working in the same frame as the renderer, so a heading
 * it computes is a heading the renderer will agree with.
 *
 * The attribute name is a **static literal**. Nothing is interpolated into it, ever, and
 * the value is a numeric coordinate pair and nothing else.
 *
 * ## Privacy: a grid position is not personal data and cannot become any
 *
 * The value is a tile index into an authored map. It is not a subject id, not a quest
 * step, not a timestamp, not a location in the world a learner can be recognised from -
 * two learners standing on the same tile publish the identical string. There is nothing
 * here for a plan 10.1 privacy boundary to exempt, because there is nothing personal in
 * it. The one place a learner value *could* leak is the mistake of putting one in the
 * name or the value, and the name is a literal in this file while the value is built
 * from two validated integers.
 *
 * ## The seam: a renderer-neutral read, feature-detected
 *
 * `src/ui/village/**` may not reach `@/renderers`, and the whole point of that gate is
 * that a DOM surface never *needs* a renderer object. So this file does not take one. It
 * takes an `unknown` handle and asks it, optionally, for a grid position:
 *
 * - The member is `readPlayerGridPosition()`, the renderer-neutral capability read that
 *   belongs beside `readPoi()` and `readNpcSnapshot()` on `VillageRendererCapabilities`
 *   in `src/application/contracts/renderer.ts`. That contract **declares** the member and
 *   exports {@link WorldGridPosition}, and it is renderer-free by construction - its header
 *   says "Nothing here names a Phaser or PixiJS type", and it names none - so importing the
 *   type from it crosses no boundary and is not the thing the `@/renderers` gate forbids.
 *   This file reaches the member through that contract's own declaration rather than through
 *   a hand-rolled copy of it: one declaration of the member name, its optionality and its
 *   return type, in the file that owns them. What is still local is the *runtime* check, in
 *   the same optional-member convention `readNpcSnapshot?` and `invokeAction?` set on that
 *   contract: no member, or a member that is not callable, means the adapter has not caught
 *   up, and the answer is `null`.
 * - **An adapter that does not implement it publishes nothing.** Not `0,0`, not the map
 *   origin, not the last known value. See "A lying attribute is worse than an absent one"
 *   below.
 *
 * The alternative - reading the position off the canvas, or off a renderer import - is
 * refused twice over: by the gate, and by the fact that a canvas pixel is not a tile.
 *
 * ## A lying attribute is worse than an absent one
 *
 * This attribute exists so something can *trust* it. Every guard below exists to keep it
 * trustworthy, and the rule they add up to is: **publish a tile, or publish nothing.**
 *
 * - {@link formatVillagePlayerPosition} accepts only a finite integer pair inside the
 *   authored map. `NaN`, `Infinity`, a float, a missing member, a negative, an
 *   off-the-map tile, and anything that is not an object are all refused.
 * - {@link publishVillagePlayerPosition} **removes** the attribute for a refused value
 *   rather than leaving the previous one. A stale tile from before a renderer restart is
 *   well-formed and still wrong, and this file's readers cannot tell it from a live one.
 * - A refused value costs one `removeAttribute` and no lie.
 *
 * ## The cost: a throttled sampler and no React render
 *
 * **There is no `useState` in this file.** The published tile is a read-out of a
 * measurement, and a measurement is not application state - the same argument
 * `CompassOverlay.tsx` makes, in the same directory, for the same reason.
 *
 * - The hook samples on `setInterval` and writes `setAttribute` straight to the node held
 *   in a ref. React rendered the markup once and never hears about it again, so **walking
 *   causes zero renders**, no matter how long the walk is.
 * - The write is conditional on the formatted pair differing from what is already on the
 *   element. At `PLAYER_SPEED` (120 px/s) on a 48 px tile a learner crosses a tile about
 *   **2.5 times a second**, so a walking learner costs at most ~2.5 attribute writes per
 *   second and a stationary one costs none.
 * - `setInterval`, not `requestAnimationFrame`, for the reasons the compass documents: a
 *   60 Hz sample of a value a consumer reads at a human or CDP cadence is fifteen to sixty
 *   times more work than the read can use, and a rAF loop keeps burning frames in a tab
 *   that is merely visible.
 *
 * ## The one honest cost of throttling: staleness, and its bound
 *
 * A throttled publish is a *slightly* stale publish, and this file will not pretend
 * otherwise. At the 100 ms default and 120 px/s the published tile can be at most
 * **12 px (a quarter of a tile) behind** where the learner actually is. That is a real
 * bound and not a rounding: at 200 ms it would be 24 px, half a tile, and half a tile is
 * the size of the error being fixed here - so 100 ms is chosen, and a consumer that needs
 * less must be told to press a key and let the interval tick rather than to poll harder.
 *
 * The alternative - writing on every frame - would buy 12 px and cost a React render per
 * frame, which is a worse trade than the error it removes. Staleness of a quarter tile is
 * bounded and small; a render per frame in the village is a regression on every device.
 *
 * ## Long-lived element
 *
 * The target is the **village screen root** - the `.village-screen` element that already
 * carries `data-theme` and `data-world`, is rendered unconditionally, and is never
 * remounted while the village route is active. It is the same element Phase 17's fishing
 * signal uses, so a consumer reads both facts off one node, and it outlives every panel,
 * every dialog, and every scene swap within the route: switching to the fishing world is a
 * canvas scene swap, not a route change, so the attribute stays published throughout.
 */
import { useLayoutEffect, useRef } from 'react';

import type {
  VillageRendererCapabilities,
  WorldGridPosition,
} from '@/application/contracts/renderer';
import { VILLAGE_MAP } from '@/data/villageLayout';

/**
 * The attribute name, as a literal.
 *
 * A constant rather than an inline string so the tests, the harness, and this file cannot
 * drift apart, and so "the name is static" is a value one can point at.
 */
export const VILLAGE_PLAYER_ATTRIBUTE = 'data-village-player';

/**
 * The default publish interval.
 *
 * 100 ms, not the compass's 200 ms, and the reason is in the header: at 120 px/s a 200 ms
 * sample can be half a tile stale, which is the size of the error this attribute exists to
 * remove. 100 ms bounds it at a quarter of a tile. See "The one honest cost of throttling".
 */
export const DEFAULT_VILLAGE_PLAYER_SAMPLE_MS = 100;

/** The minimal shape of the ref the hook writes through, so it takes no React generic. */
export interface VillagePlayerPositionTargetRef {
  readonly current: Element | null;
}

/**
 * Ask a renderer-neutral handle where the learner is, or `null` for "cannot say".
 *
 * `handle` is `unknown` on purpose, and the cast inside is the only one in this module.
 * The cast names the contract that owns the member - so the member's name, its optionality,
 * and its return type cannot drift from `src/application/contracts/renderer.ts` - while the
 * runtime check that follows stays a check on `unknown`. That split is the whole reason to
 * reach through the contract instead of declaring a local port: the contract types what the
 * adapter *promises*, and this file must still verify what the adapter *delivers*, because
 * a mis-implemented member is answered with no attribute rather than a wrong one. Typing
 * the handle as `VillageRendererCapabilities` at the boundary would delete that verification
 * and buy nothing, since a caller holding a real adapter gets the same check either way.
 */
export function readVillagePlayerGridPosition(handle: unknown): WorldGridPosition | null {
  if (handle === null || typeof handle !== 'object') return null;
  const reader = (handle as VillageRendererCapabilities).readPlayerGridPosition;
  if (typeof reader !== 'function') return null;
  const answer: unknown = reader.call(handle);
  // The same validator the formatter uses, so this can never hand a caller a value the
  // attribute would refuse: "the world can answer" and "the world may publish" are one
  // question here, and the alternative was two answers to it.
  return isGridPosition(answer) ? answer : null;
}

/** An integer tile index, or `null`. `Number.isInteger` already refuses `NaN`/`Infinity`. */
function asTileIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * The single validator: is this value a position this file is willing to act on?
 *
 * One predicate, not two, and that is the point. {@link readVillagePlayerGridPosition} and
 * {@link formatVillagePlayerPosition} used to each ask the question with their own rules,
 * and the pair drifted: the reader accepted a negative tile the formatter then refused, so a
 * caller using the reader directly would have acted on a value the attribute would never
 * carry. A validator that is written once cannot drift from the string.
 *
 * Refused: `null`, `undefined`, a non-object, a missing member, a string member, a float,
 * `NaN`, `Infinity`, a negative tile, a tile at or past the map's edge, and any object with
 * no such members. Accepted: two finite integers inside the authored map. `-0` is accepted
 * and stringifies to `"0"`, which is the correct tile.
 */
function isGridPosition(value: unknown): value is WorldGridPosition {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { gridX?: unknown; gridY?: unknown };
  const gridX = asTileIndex(candidate.gridX);
  const gridY = asTileIndex(candidate.gridY);
  if (gridX === null || gridY === null) return false;
  if (gridX < 0 || gridY < 0) return false;
  return gridX < VILLAGE_MAP.width && gridY < VILLAGE_MAP.height;
}

/**
 * The published spelling of one tile, or `null` for a value that must not be published.
 *
 * `"<gridX>,<gridY>"`: two integers, comma-separated, no spaces, no sign, no decimal point,
 * no padding, no brackets. Template interpolation of an integer cannot produce any of the
 * things it is forbidden from producing, so the format needs no formatting code - what it
 * does need is the refusal, and that is {@link isGridPosition}'s job rather than this
 * function's, so the reader and this cannot disagree about what a position is.
 */
export function formatVillagePlayerPosition(value: unknown): string | null {
  if (!isGridPosition(value)) return null;
  return `${value.gridX},${value.gridY}`;
}

/**
 * Write one tile to `target`, or remove the attribute when the value is refused.
 *
 * Returns the string now on the element, or `null` when nothing is published - which is the
 * value a caller asserts on.
 *
 * Three decisions, each load-bearing:
 *
 * - **Removal, not retention, on a refused value.** The previous tile is well-formed and
 *   stale, and this file's readers cannot distinguish a stale tile from a live one. A
 *   restarting renderer therefore drops the attribute and republishes it, which is a
 *   truthful "not known right now" rather than a confident wrong answer.
 * - **No write when the value is unchanged.** A stationary learner walks past nothing, so
 *   the common sample writes nothing at all. This is also what keeps a re-render from
 *   looking like movement.
 * - **Write when it is unchanged but missing.** A consumer that removed the attribute, or a
 *   React reconciliation that rebuilt the node, gets it restored on the next sample.
 */
export function publishVillagePlayerPosition(target: Element | null, value: unknown): string | null {
  if (target === null) return null;
  const formatted = formatVillagePlayerPosition(value);
  if (formatted === null) {
    target.removeAttribute(VILLAGE_PLAYER_ATTRIBUTE);
    return null;
  }
  if (target.getAttribute(VILLAGE_PLAYER_ATTRIBUTE) !== formatted) {
    target.setAttribute(VILLAGE_PLAYER_ATTRIBUTE, formatted);
  }
  return formatted;
}

export interface VillagePlayerPositionPublisherOptions {
  /**
   * The long-lived element that carries the attribute.
   *
   * A ref rather than an element, because the node exists only after commit and the sample
   * must run against the *current* one. Read inside the sample, never captured into the
   * effect's closure.
   */
  readonly targetRef: VillagePlayerPositionTargetRef;
  /**
   * Reads the learner's tile from the mounted renderer, or `null` for "cannot say".
   *
   * The read is renderer-neutral and is the only thing this file knows about the world.
   */
  readonly read: () => unknown;
  /** Milliseconds between samples. Tests pass a small value. */
  readonly sampleIntervalMs?: number;
}

/**
 * Publish the learner's tile on a long-lived element, on a throttled interval.
 *
 * **No `useState` anywhere in this module**, which is the structural reason walking costs
 * zero React renders: the tick writes an attribute through a ref on a node React does not
 * own a value for, and the component that owns the node renders it once. A
 * `useState`+`useEffect` version would be a render of the whole village subtree at the
 * sample rate, which is the regression the header rules out.
 *
 * The effect runs once and never re-subscribes: `targetRef` is a ref object, stable for
 * the component's life, and both the reader and the interval are held in refs so a new
 * reader identity or a new interval on a later render does not restart the sampler.
 *
 * A layout effect rather than a passive one, so the first sample lands before the browser
 * paints: a consumer that measures the attribute immediately after mount must not observe
 * a frame without one.
 */
export function useVillagePlayerPositionPublisher(
  options: VillagePlayerPositionPublisherOptions,
): void {
  const { targetRef, read, sampleIntervalMs = DEFAULT_VILLAGE_PLAYER_SAMPLE_MS } = options;

  const readRef = useRef(read);
  readRef.current = read;
  const intervalRef = useRef(sampleIntervalMs);
  intervalRef.current = sampleIntervalMs;

  useLayoutEffect(() => {
    const sample = (): void => {
      publishVillagePlayerPosition(targetRef.current, readRef.current());
    };

    sample();
    const timer = window.setInterval(sample, Math.max(1, intervalRef.current));
    return () => window.clearInterval(timer);
  }, [targetRef]);
}

/**
 * The screen's whole share of this concern: one hook call and one `ref` on the root.
 *
 * Returns the ref to spread onto the long-lived element and keeps
 * {@link useVillagePlayerPositionPublisher} inside this module, so the composition root
 * grows by a single line rather than by a ref, a reader, a callback, and an effect. That
 * is the Phase 12 split's actual point applied to a Phase 17 concern: `village-shell-split`
 * holds `VillageScreen.tsx` under 900 lines on the reasoning that the composition root is
 * the *small* thing, and a new published fact does not get to spend that budget.
 *
 * `read` is the caller's own reader - normally
 * `() => readVillagePlayerGridPosition(activeCapabilities())`, so the value still comes from
 * whichever adapter is mounted and this file never learns which.
 */
export function useVillagePlayerPositionAttribute(
  read: () => unknown,
  sampleIntervalMs: number = DEFAULT_VILLAGE_PLAYER_SAMPLE_MS,
): { readonly current: HTMLDivElement | null } {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useVillagePlayerPositionPublisher({ targetRef, read, sampleIntervalMs });
  return targetRef;
}