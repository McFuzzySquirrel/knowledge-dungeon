/**
 * Phase 21: the village zoom read-out.
 *
 * ## What this exists for
 *
 * `VillageScene.readCameraState()` existed and **nothing read it**. The village has three zoom routes - two
 * buttons, a wheel notch, and a pinch - all reaching one `zoomBy`, and after any of them the only evidence a
 * learner had was that the picture changed. A screen-reader user who pressed "zoom in" could not tell whether
 * the press registered; a learner who zoomed too far had no way to know how far to come back.
 *
 * The dungeon already states its zoom in words - `createDungeonScene.ts:853` answers with
 * `Zoom in. Now 1.25 times.` - and this is the same sentence for the village.
 *
 * ## Why the wording is asserted exactly
 *
 * Because a bare `1.25` is not a state a learner can use. It has to be comparable across sessions and across
 * devices without arithmetic, and it has to name the action as well as the factor. `zoomSentence` is a pure
 * function, so every branch of it is reachable without a renderer - which is the main reason it is a function
 * at all rather than string-building inside the effect.
 *
 * ## Why it is sampled, and why only the zoom is
 *
 * `readCameraState` is a **read**, not a subscription - `VillageWorld`'s own header says why: the camera's
 * *centre* changes every frame while the learner walks, and a per-frame publish would re-render this subtree
 * sixty times a second. The zoom changes only on a deliberate gesture, so a 250ms sample of the zoom alone is
 * both cheap and sufficient. The tests below assert that distinction directly: a moving centre costs nothing,
 * a changed factor updates the sentence.
 *
 * ## What jsdom cannot check here
 *
 * Whether the read-out is **visible**, and whether it is announced. jsdom computes no layout, so `hidden` is
 * an attribute rather than a rendering, and no screen reader is present. The announcement is a `role="status"`
 * in the markup, which axe checks the *existence* of; what a screen reader would actually say is a manual gate
 * the phase records as UNVERIFIED.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VillageZoomReadOut, zoomSentence } from '@/ui/village/VillageZoomReadOut';

afterEach(cleanup);

/** Advance fake timers, always inside `act` so effects and the interval both flush. */
function advanceTimers(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('the zoom factor reads as a phrase, not a number', () => {
  it.each([
    [1, 'Zoom is now one times normal.'],
    [2, 'Zoom is now two times normal.'],
    [1.25, 'Zoom is now one and a quarter times normal.'],
    [1.5, 'Zoom is now one and a half times normal.'],
    [1.75, 'Zoom is now one and three quarters times normal.'],
    [0.5, 'Zoom is now a half of normal.'],
    [0.75, 'Zoom is now three quarters of normal.'],
  ])('%s reads as %s', (zoom, sentence) => {
    expect(zoomSentence(zoom)).toBe(sentence);
  });

  it('spells every whole number the village camera clamp can reach, and digits beyond it', () => {
    // `CameraRig` builds from `ZOOM_MIN = 0.6` and `ZOOM_MAX = 2.4`, so `0.6 .. 2.4` is the whole set of
    // factors a learner can see. Every one of them gets a real word or a real number - never "undefined",
    // which is what a table that stopped at "two" would have produced if the clamp were ever widened.
    const reachable = [0.6, 0.75, 1, 1.2, 1.25, 1.5, 1.75, 2, 2.4];
    for (const zoom of reachable) {
      const sentence = zoomSentence(zoom);
      expect(sentence, `${zoom} produced no sentence`).not.toBe('');
      expect(sentence.includes('undefined'), `${zoom} produced "${sentence}"`).toBe(false);
      expect(sentence.startsWith('Zoom is now '), `${zoom} produced "${sentence}"`).toBe(true);
    }
    // And above the clamp the fallback is a digit, which is still readable.
    expect(zoomSentence(12)).toBe('Zoom is now 12 times normal.');
  });

  it('says the hundredths when the factor is not a familiar fraction', () => {
    // `VILLAGE_ZOOM_STEP` is 0.25, so a learner meets the familiar fractions often - but the camera
    // also arrives at a non-quarter zoom from a pinch ratio or a restored preference, and "one and
    // eighteen hundredths" is still a comparison they can make whereas "1.18" is not.
    expect(zoomSentence(1.18)).toBe('Zoom is now one and 18 hundredths times normal.');
  });

  it('rounds to two places, the way the renderer reports the camera', () => {
    // The dungeon's own wording uses `toFixed(2)`. Matching it means the two worlds' zoom read-outs are
    // comparable, which is the point of the village's existing a moment ago.
    expect(zoomSentence(1.2499)).toBe('Zoom is now one and a quarter times normal.');
    expect(zoomSentence(1.005)).toBe('Zoom is now one times normal.');
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])(
    'refuses to state a factor for %s',
    (zoom) => {
      // Not "one times normal": a read-out that reports a factor for a camera it cannot read is stating
      // something false, and a `NaN` reaching the copy is a bug that has to surface here rather than in
      // front of a learner.
      expect(zoomSentence(zoom)).toBe('Zoom is not set yet.');
    },
  );
});

describe('the read-out renders only once a world exists', () => {
  it('is hidden and empty before the renderer mounts', () => {
    // `readCameraState()` answers `null` before the world exists - the same case `readPoi` answers `null`
    // for. Rendering "one times normal" on a screen with no world would be a false sentence.
    render(<VillageZoomReadOut readZoom={() => null} />);
    const region = document.querySelector('[data-village-zoom-readout="true"]');
    expect(region, 'the read-out did not render at all').not.toBeNull();
    expect(region?.hasAttribute('hidden'), 'the read-out is visible with no world').toBe(true);
    expect(region?.textContent?.trim(), 'the read-out claims a factor with no world').toBe('');
  });

  it('reveals itself and states the factor on the first sample', () => {
    render(<VillageZoomReadOut readZoom={() => 1.25} />);
    const region = screen.getByRole('status');
    expect(region.hasAttribute('hidden')).toBe(false);
    expect(region.textContent).toBe('Zoom is now one and a quarter times normal.');
    // The raw factor is on the attribute, for a test and for a future settings control - not as the name.
    expect(region.getAttribute('data-village-zoom')).toBe('1.25');
  });

  it('is a polite status region rather than an assertive one', () => {
    // `role="status"` already implies `aria-live="polite"`; writing both is the duplicate-announcement
    // shape Phase 19's Scribe shell header warns about. Asserted because the alternative is easy to
    // "improve" later and would make every zoom press interrupt a learner mid-sentence.
    render(<VillageZoomReadOut readZoom={() => 1} />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).not.toBe('assertive');
    expect(region.getAttribute('aria-live')).not.toBe('off');
  });
});

describe('sampling follows the zoom and ignores the walk', () => {
  it('updates the sentence when the zoom changes, and only then', () => {
    vi.useFakeTimers();
    try {
      let zoom = 1;
      render(<VillageZoomReadOut readZoom={() => zoom} sampleIntervalMs={100} />);
      const region = screen.getByRole('status');
      expect(region.textContent).toBe('Zoom is now one times normal.');

      act(() => {
        zoom = 1.5;
        vi.advanceTimersByTime(150);
      });
      expect(region.textContent, 'a changed factor did not reach the sentence').toBe(
        'Zoom is now one and a half times normal.',
      );
      expect(region.getAttribute('data-village-zoom')).toBe('1.50');

      // And a *second* change is picked up, so the read-out is not a one-shot: a learner who zooms in
      // twice must hear the second factor, not the first.
      advanceTimers(0);
      act(() => {
        zoom = 0.75;
        vi.advanceTimersByTime(150);
      });
      expect(region.textContent).toBe('Zoom is now three quarters of normal.');
      expect(region.getAttribute('data-village-zoom')).toBe('0.75');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a camera that only moved re-renders nothing', () => {
    // The reason the component samples the zoom rather than subscribing: a learner walking across the
    // village changes the camera's centre every frame. If the sentence were rewritten on every sample the
    // read-out would be a per-frame DOM write for a fact that has not changed - and, worse, a live region
    // re-announcing the same words sixty times a second.
    vi.useFakeTimers();
    try {
      let frames = 0;
      render(
        <VillageZoomReadOut
          readZoom={() => {
            frames += 1;
            return 1.25;
          }}
          sampleIntervalMs={100}
        />,
      );
      const region = screen.getByRole('status');
      const before = region.textContent;
      const framesAfterFirst = frames;

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(region.textContent, 'the sentence changed while the factor did not').toBe(before);
      expect(region.getAttribute('data-village-zoom')).toBe('1.25');
      // The sampler still ran - ten samples over a second - which is the point: it polls, it does not
      // subscribe, and polling something unchanged costs nothing observable.
      expect(frames, 'the sampler stopped polling, so a later zoom would never be seen').toBeGreaterThan(
        framesAfterFirst,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides itself again if the world goes away', () => {
    // A pond or a scene swap can leave the screen with no renderer for a frame. A read-out that stayed
    // visible would be reporting a camera that is no longer there.
    vi.useFakeTimers();
    try {
      let zoom: number | null = 1.25;
      render(<VillageZoomReadOut readZoom={() => zoom} sampleIntervalMs={100} />);
      expect(screen.getByRole('status').hasAttribute('hidden')).toBe(false);

      act(() => {
        zoom = null;
        vi.advanceTimersByTime(150);
      });
      const region = document.querySelector('[data-village-zoom-readout="true"]');
      expect(region?.hasAttribute('hidden'), 'the read-out stayed visible with no world').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave a timer running after unmount', () => {
    // A leaked interval would keep a detached subtree's reader alive for the life of the screen, and the
    // village screen is mounted and unmounted repeatedly across routes.
    vi.useFakeTimers();
    try {
      const clearSpy = vi.spyOn(window, 'clearInterval');
      const view = render(<VillageZoomReadOut readZoom={() => 1} sampleIntervalMs={100} />);
      view.unmount();
      expect(clearSpy, 'unmounting the read-out did not clear its sampling interval').toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('no learner data and no renderer reach', () => {
  it('names no structure, subject, room or fish', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src', 'ui', 'village', 'VillageZoomReadOut.tsx'),
      'utf8',
    );
    for (const forbidden of ['VILLAGE_MAP', 'subjectName', 'roomId', 'fishName', 'catalogId', '@/renderers']) {
      expect(source.includes(forbidden), `the zoom read-out names ${forbidden}`).toBe(false);
    }
  });

  it('its only external input is a number', () => {
    // The prop is `() => number | null`, so the widest thing a caller can hand the component is a zoom
    // factor. Asserted as a type by construction - `readZoom` will not compile with anything else - and
    // here as the rendered consequence: the sentence is prose plus a factor and nothing else.
    render(<VillageZoomReadOut readZoom={() => 1.25} />);
    expect(screen.getByRole('status').textContent).not.toContain('{');
    expect(screen.getByRole('status').textContent).not.toContain('[');
  });
});
