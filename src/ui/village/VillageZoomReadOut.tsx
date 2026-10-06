/**
 * The village's zoom read-out: the current zoom factor, in words, wherever the learner can hear it.
 *
 * ## Why this exists
 *
 * The renderer exposes `readCameraState()`, and Phase 21 found that nothing read it. The village has
 * zoom controls - two buttons, a wheel notch, and a pinch, all reaching one `zoomBy` - and after any
 * of them the only evidence a learner had was that the picture changed. That is not a state anyone
 * can read back: a screen-reader user who zoomed in has no way to know whether the press registered,
 * and a learner who zoomed too far has no way to tell how far to zoom back out.
 *
 * The dungeon already had this and got the wording right: `createDungeonScene.ts:853` answers a zoom
 * action with `Zoom in. Now 1.25 times.` - a sentence that names the **action** and the **new factor**.
 * This is the same shape, for the same reason.
 *
 * ## Why the number is in words and not bare
 *
 * `1.25` alone is a number a learner has to interpret: it is not obviously "how zoomed in am I". The
 * sentence is `Zoom is now one and a quarter times normal`, which is comparable across sessions and
 * across devices without arithmetic. The raw factor is still on `data-village-zoom`, so a test can
 * read it - but it is an attribute, not the accessible name, and nothing in the sentence depends on
 * the learner seeing it.
 *
 * ## Why a sampler rather than a subscription
 *
 * `readCameraState` is a **read**, not a subscription - deliberately, per `VillageWorld`'s own header:
 * the camera's centre changes every frame while the learner walks, and a per-frame publish would
 * re-render this subtree sixty times a second. So this samples the zoom on an interval, the same
 * shape `CompassOverlay` uses for `readPoi`, and writes `textContent` directly.
 *
 * **Only the zoom is sampled, not the centre**, and that is what makes the interval safe: the centre
 * genuinely changes per frame, the zoom changes only on a deliberate gesture. 250ms is fast enough
 * that the sentence is current when a learner looks and slow enough to cost nothing.
 *
 * ## Nothing is rendered before the world exists
 *
 * `readCameraState()` answers `null` before the renderer mounts - the same "before a world exists"
 * case `readPoi` answers `null` for. The read-out renders `hidden` and empty then, rather than a
 * placeholder factor, because a read-out that says `Zoom is now one times normal` on a screen with no
 * world is stating something false.
 *
 * ## No learner data
 *
 * A zoom factor and a boolean. No subject, no structure, no room, no name.
 */
import { memo, useLayoutEffect, useRef, type JSX } from 'react';

/**
 * Whole numbers this can spell.
 *
 * Three, not twenty, and that is a **clamp** rather than a shortcut. `CameraRig` builds from
 * `ZOOM_MIN = 0.6` and `ZOOM_MAX = 2.4` in `src/data/villageLayout.ts`, so a village zoom can never have a
 * whole part above two - and a list of nineteen words that cannot be reached is nineteen words of entry
 * payload for nothing. Anything above the table falls through to the digits, which keeps the sentence
 * truthful if the clamp is ever widened rather than silently saying "undefined".
 */
const WHOLE_WORDS: readonly string[] = Object.freeze(['zero', 'one', 'two']);

/** The fractions a quarter-step actually produces, by hundredths. */
const FAMILIAR_FRACTIONS: Readonly<Record<number, string>> = Object.freeze({
  25: 'a quarter',
  50: 'a half',
  75: 'three quarters',
});

/**
 * The zoom factor as a phrase a learner can compare across sessions.
 *
 * Whole numbers get no fraction - `2.00` reads as "two times", not "two and no hundredths" - and a
 * fractional part reads as hundredths where it is not a familiar fraction, because the village camera
 * steps by `VILLAGE_ZOOM_STEP` and a learner is far more likely to recognise "one and a quarter" than
 * "one and eighteen hundredths".
 */
export function zoomSentence(zoom: number): string {
  if (!Number.isFinite(zoom) || zoom <= 0) return 'Zoom is not set yet.';
  const rounded = Math.round(zoom * 100) / 100;
  const whole = Math.floor(rounded);
  const hundredths = Math.round((rounded - whole) * 100);
  const wholeWord = WHOLE_WORDS[whole] ?? String(whole);
  const fractionWord = FAMILIAR_FRACTIONS[hundredths];

  if (hundredths === 0) return `Zoom is now ${wholeWord} times normal.`;
  if (fractionWord !== undefined) {
    return whole === 0
      ? `Zoom is now ${fractionWord} of normal.`
      : `Zoom is now ${wholeWord} and ${fractionWord} times normal.`;
  }
  // Not a familiar fraction: say the hundredths, which is still a comparison a learner can make.
  return `Zoom is now ${wholeWord} and ${hundredths} hundredths times normal.`;
}

export interface VillageZoomReadOutProps {
  /**
   * Reads the renderer's camera, or `null` before the world exists.
   *
   * Held in a ref and called only from the sampling interval, so React never invokes it and a new
   * function identity on the caller does not re-subscribe.
   */
  readonly readZoom: () => number | null;
  /** Milliseconds between samples. Tests pass a small value; the default is 250. */
  readonly sampleIntervalMs?: number;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 250;

function VillageZoomReadOutImpl({
  readZoom,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
}: VillageZoomReadOutProps): JSX.Element {
  const rootRef = useRef<HTMLParagraphElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  const readRef = useRef(readZoom);
  readRef.current = readZoom;

  // A layout effect, for the same reason `CompassOverlay` uses one: the first sample must land
  // before the browser paints, or the read-out is briefly visible saying nothing.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const text = textRef.current;
    if (root === null || text === null) return;

    let shown: string | null = null;
    let shownZoom: number | null = null;

    const sample = (): void => {
      const zoom = readRef.current();
      if (zoom === null) {
        if (shown !== 'none') {
          root.hidden = true;
          shown = 'none';
        }
        return;
      }
      const sentence = zoomSentence(zoom);
      // Written only when the **factor** changed, so walking - which does not change the zoom - costs
      // nothing at all.
      if (zoom !== shownZoom) {
        shownZoom = zoom;
        root.hidden = false;
        root.dataset.villageZoom = zoom.toFixed(2);
        if (sentence !== shown) {
          shown = sentence;
          text.textContent = sentence;
        }
      }
    };

    sample();
    const timer = window.setInterval(sample, Math.max(1, sampleIntervalMs));
    return () => window.clearInterval(timer);
  }, [sampleIntervalMs]);

  /*
   * `role="status"` and **not** `aria-live` on the element itself: `role="status"` already implies a
   * polite live region, and writing both is the duplicate-announcement shape Phase 19's Scribe shell
   * header warns about.
   *
   * `aria-live="off"` on the interval's own writes is not what is done here - a zoom change genuinely
   * should be announced, because a learner who pressed "zoom in" and heard nothing cannot tell whether
   * the press landed. So the region is polite and the announcement is the point.
   */
  return (
    <p className="village-zoom-readout" role="status" hidden ref={rootRef} data-village-zoom-readout="true">
      <span className="village-zoom-readout__text" ref={textRef} />
    </p>
  );
}

/**
 * Memoized, for the same reason `CompassOverlay` is: a `VillageScreen` re-render - a quest step, a
 * subject refresh, the study flow's own state - should not reach this subtree, and the single prop is
 * a `useCallback`ed reader so the comparison is a pointer compare.
 */
export const VillageZoomReadOut = memo(VillageZoomReadOutImpl);
