/**
 * The village compass: a heading to whatever the renderer says is nearest.
 *
 * ## The problem this file exists to solve
 *
 * Before Phase 12 the compass took `readPoi: () => WorldPointOfInterest | null` -
 * a callback that reaches a *renderer object* - and React called it on a 250 ms
 * `setInterval`, holding the answer in `useState`. Phase 11 had already taken the
 * per-frame `requestAnimationFrame` loop down to 250 ms, and the phase-12
 * deliverable is explicit: **"No animation-frame React updates caused by transient
 * scene state."** Throttling the interval was not enough, because the defect is
 * not the *frequency* of the sample, it is the *coupling*: a moving player changes
 * `angle` and `distance` continuously, so every sample while walking was a
 * `setState` and therefore a React render of this subtree, at four hertz, for a
 * value that changed by a fraction of a degree between samples. The bailed-out
 * comparison in the old version only helped when the player stood still.
 *
 * ## The model that replaced it
 *
 * **The needle is written imperatively; React never hears about it.**
 *
 * The compass is a *read-out of a measurement*, and a measurement is not
 * application state. So:
 *
 * - There is **no `useState` in this component at all**. Not a "bail out if
 *   unchanged" guard - no state at all, which is why the next point is structural
 *   rather than a matter of tuning.
 * - A throttled `setInterval` samples `readPoi()` into three DOM nodes held by
 *   refs: the root's `hidden`, the needle's `style.transform`, and the label's
 *   `textContent`. React rendered that markup once, and the interval only writes
 *   attributes React does not own - the JSX declares no `hidden`, no `transform`,
 *   and no children for the label, so reconciliation has nothing to overwrite.
 * - The whole component is `memo`ized, and the only prop the screen passes is a
 *   `useCallback`ed reader, so a re-render of `VillageScreen` does not reach it
 *   either.
 *
 * The result is a compass that costs one attribute write per sample while walking
 * and **zero React renders**, no matter how long the player walks.
 *
 * ## Why the sample is throttled rather than per-frame
 *
 * `setInterval` at `sampleIntervalMs`, not `requestAnimationFrame`. Two reasons,
 * both of which the previous version got wrong in different ways: a 60 Hz sample
 * of a value displayed at 36 CSS pixels is sixteen times more samples than the
 * display can show, and a rAF loop keeps running at full rate in a tab that is
 * merely *visible but not being looked at*. A throttled sample also stops
 * entirely on a coarse-pointer device that has scrolled the world off screen, and
 * the pointer-events-none overlay is not something a learner is reading while
 * they walk.
 *
 * ## Accessibility: this is decoration, and says so
 *
 * `aria-hidden="true"`, because a needle rotation is not information a screen
 * reader can use and announcing a direction four times a second would be noise.
 * That is a *claim*, not a shrug: the accessible equivalent of "there is
 * something over there" is the DOM nearby-action list
 * (`NearbyActionList.tsx`), which names each target in words and offers it as a
 * real button. The compass is the visual redundancy for a learner who can see the
 * canvas; the list is the route for a learner who cannot. `tests/phase12/` pins
 * both halves.
 *
 * The tooltip (`title`) is set imperatively alongside the label, because a
 * tooltip that lagged the label by one React render would be worse than none.
 */
import { memo, useLayoutEffect, useRef, type JSX } from 'react';

import type { WorldPointOfInterest } from '@/application/contracts/world';

export interface CompassOverlayProps {
  /**
   * Reads the renderer's current point of interest, or `null` for none.
   *
   * Held in a ref and called only from the sampling interval, so React never
   * invokes it and a new function identity on the caller does not resubscribe.
   */
  readonly readPoi: () => WorldPointOfInterest | null;
  /** Milliseconds between samples. Tests pass a small value; the default is 200. */
  readonly sampleIntervalMs?: number;
  /** Hide the compass once the target is closer than this, in world pixels. */
  readonly showBeyondDistance?: number;
  /** Characters kept from the target's name. The pre-Phase-12 display used 10. */
  readonly maxLabelLength?: number;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 200;
const DEFAULT_SHOW_BEYOND_DISTANCE = 96;
const DEFAULT_MAX_LABEL_LENGTH = 10;

/** Live tunables, so the sampling effect never has to re-subscribe. */
interface CompassConfig {
  readonly intervalMs: number;
  readonly showBeyondDistance: number;
  readonly maxLabelLength: number;
}

function CompassOverlayImpl({
  readPoi,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  showBeyondDistance = DEFAULT_SHOW_BEYOND_DISTANCE,
  maxLabelLength = DEFAULT_MAX_LABEL_LENGTH,
}: CompassOverlayProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const needleRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);

  // Latest-value refs. The read is the only one that can change identity between
  // renders (the screen's `useCallback` depends on which renderer is mounted), and
  // the tunables are props, so both are held here rather than in dependencies.
  const readRef = useRef(readPoi);
  readRef.current = readPoi;
  const configRef = useRef<CompassConfig>({ intervalMs: 0, showBeyondDistance: 0, maxLabelLength: 0 });
  configRef.current = { intervalMs: sampleIntervalMs, showBeyondDistance, maxLabelLength };

  // A layout effect, not a passive one: the first sample has to land before the
  // browser paints, or the compass is visible for one frame with no rotation and
  // no label.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const needle = needleRef.current;
    const label = labelRef.current;
    if (root === null || needle === null || label === null) return;

    // Written only when it changes, so the common "still walking toward the same
    // thing" case writes the transform and touches nothing else.
    let shownName: string | null = null;
    let shown: boolean | null = null;

    const sample = (): void => {
      const poi = readRef.current();
      const { showBeyondDistance: near, maxLabelLength: limit } = configRef.current;

      if (poi === null) {
        if (shown !== false) {
          root.hidden = true;
          shown = false;
        }
        return;
      }

      const visible = poi.distance >= near;
      if (visible !== shown) {
        root.hidden = !visible;
        shown = visible;
      }
      if (!visible) return;

      // The needle points along the bearing: the renderer reports `0` as "up",
      // and CSS `rotate()` has `0deg` as "up" too, so the only correction is the
      // screen-space offset the previous version used.
      needle.style.transform = `rotate(${(poi.angle * 180) / Math.PI + 90}deg)`;

      if (shownName !== poi.name) {
        shownName = poi.name;
        label.textContent = poi.name.slice(0, limit);
        root.title = poi.name;
      }
    };

    sample();
    const timer = window.setInterval(sample, Math.max(1, configRef.current.intervalMs));
    return () => window.clearInterval(timer);
  }, []);

  // No `hidden`, no `transform`, no label children: reconciliation owns nothing on
  // these three nodes, so the sampler above can write to them freely. The one
  // thing React does own is the structure, which is why a re-render - if one ever
  // happened - would rebuild the same markup rather than fight the sampler.
  return (
    <div className="village-compass" data-village-compass="true" aria-hidden="true" ref={rootRef}>
      <div className="village-compass-ring">
        <div className="village-compass-needle" ref={needleRef} />
      </div>
      <span className="village-compass-label" ref={labelRef} />
    </div>
  );
}

/**
 * The memoized export.
 *
 * `memo` is what keeps a `VillageScreen` re-render - a quest step change, a
 * subject list refresh, the study flow's own state - from reaching this subtree
 * at all. The single prop is a `useCallback`ed reader, so identity is stable
 * across those re-renders and the comparison is a pointer compare.
 */
export const CompassOverlay = memo(CompassOverlayImpl);
