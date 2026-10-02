/**
 * The compass does not drive React.
 *
 * ## What this file is for
 *
 * Phase 12's deliverable list contains one item that is not a feature:
 * **"No animation-frame React updates caused by transient scene state."** The
 * pre-Phase-12 `CompassOverlay` took a `readPoi()` callback that reached a renderer
 * object, sampled it on a 250 ms `setInterval`, and held the answer in
 * `useState`. Throttling the interval did not fix the defect, because the defect
 * is the coupling: `angle` and `distance` change continuously while a player walks,
 * so every sample during movement was a `setState` and therefore a render.
 *
 * The replacement writes the needle's transform and the label straight to the DOM
 * from a throttled sampler, and the component holds no state at all. This file
 * pins that, in the only way that is falsifiable: it makes the sampler's input
 * change on every tick and then measures *both* halves of the result.
 *
 * | Assertion                          | What it rules out                                  |
 * |------------------------------------|----------------------------------------------------|
 * | the needle's transform did change  | a sampler that stopped working entirely            |
 * | the Profiler recorded no new commit| "no renders" achieved by not updating at all        |
 * | the source has no `useState`       | the same property reached by a bail-out guard      |
 * | the source has no rAF             | a frame loop re-introduced by a later edit         |
 *
 * The pair is the point. Either assertion alone passes for the wrong reason; both
 * together are the deliverable.
 *
 * Hermeticity: no canvas, no renderer, no network, no `dist/`, no commit. The
 * `readPoi` double is a function returning a plain object, which is exactly the
 * renderer-neutral shape the capability port declares.
 */
import { Profiler } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompassOverlay } from '../../src/ui/village/CompassOverlay';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../phase9/support/phase9Build';

interface CompassNode {
  readonly root: HTMLElement;
  readonly needle: HTMLElement;
  readonly label: HTMLElement;
}

function findCompass(container: HTMLElement): CompassNode {
  const root = container.querySelector<HTMLElement>('[data-village-compass]');
  if (root === null) throw new Error('the compass did not render');
  const needle = root.querySelector<HTMLElement>('.village-compass-needle');
  const label = root.querySelector<HTMLElement>('.village-compass-label');
  if (needle === null || label === null) throw new Error('the compass is missing a part');
  return { root, needle, label };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a moving target updates the needle without re-rendering anything', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('moves the needle and leaves the Profiler commit count alone', () => {
    // A target that is far away (so the compass is shown), and whose bearing - and
    // therefore whose CSS rotation - changes on every single sample. This is the
    // exact input that used to be four React renders a second.
    let bearing = 0;
    const readPoi = () => {
      bearing += 0.35;
      return { name: 'Keeper of Knowledge', angle: bearing, distance: 400 };
    };

    const commits: number[] = [];
    const { container } = render(
      <Profiler id="village-compass" onRender={() => { commits.push(1); }}>
        <CompassOverlay readPoi={readPoi} sampleIntervalMs={10} />
      </Profiler>,
    );

    const { root, needle, label } = findCompass(container);
    const commitsAfterMount = commits.length;
    const transformAfterMount = needle.style.transform;
    expect(commitsAfterMount, 'the mount itself must be a commit, or this proves nothing').toBe(1);
    expect(transformAfterMount, 'the first sample must land before paint').not.toBe('');

    // Thirty samples at 10 ms: a second and a half of continuous movement.
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // The half that says the sampler still works.
    expect(needle.style.transform, 'the needle did not move').not.toBe(transformAfterMount);
    expect(needle.style.transform).toMatch(/^rotate\(-?[\d.]+deg\)$/);
    // Truncated to the ten characters the pre-Phase-12 display used.
    expect(label.textContent, 'the label was never written').toBe('Keeper of ');
    expect(root.hidden, 'a far-away target must leave the compass shown').toBe(false);

    // The half that says React never saw any of it.
    expect(commits.length, 'transient scene state caused a React commit').toBe(commitsAfterMount);
  });

  it('shows and hides the compass as the target crosses the near threshold, still without a commit', () => {
    let distance = 400;
    const readPoi = () => ({ name: 'Guild Hall', angle: 1.2, distance });

    const commits: number[] = [];
    const { container } = render(
      <Profiler id="village-compass-threshold" onRender={() => { commits.push(1); }}>
        <CompassOverlay readPoi={readPoi} sampleIntervalMs={10} showBeyondDistance={96} />
      </Profiler>,
    );
    const { root, label } = findCompass(container);
    const commitsAfterMount = commits.length;
    expect(root.hidden).toBe(false);
    expect(label.textContent).toBe('Guild Hall');

    // Close enough to be standing on it: the compass is noise at that range.
    distance = 12;
    act(() => { vi.advanceTimersByTime(20); });
    expect(root.hidden, 'a nearby target must hide the compass').toBe(true);

    // Back out of range.
    distance = 400;
    act(() => { vi.advanceTimersByTime(20); });
    expect(root.hidden).toBe(false);

    expect(commits.length).toBe(commitsAfterMount);
  });

  it('hides the compass when the world reports no point of interest at all', () => {
    const commits: number[] = [];
    const { container } = render(
      <Profiler id="village-compass-none" onRender={() => { commits.push(1); }}>
        <CompassOverlay readPoi={() => null} sampleIntervalMs={10} />
      </Profiler>,
    );
    const { root } = findCompass(container);
    expect(root.hidden, 'no point of interest must leave nothing on screen').toBe(true);
    expect(commits.length).toBe(1);
  });

  it('stops sampling when it unmounts, so a dismissed screen leaks no timer', () => {
    const readPoi = vi.fn(() => ({ name: 'Fountain', angle: 0, distance: 400 }));
    const view = render(<CompassOverlay readPoi={readPoi} sampleIntervalMs={10} />);
    act(() => { vi.advanceTimersByTime(35); });
    const callsWhileMounted = readPoi.mock.calls.length;
    expect(callsWhileMounted).toBeGreaterThan(1);

    view.unmount();
    act(() => { vi.advanceTimersByTime(100); });
    expect(readPoi.mock.calls.length, 'the interval outlived the component').toBe(callsWhileMounted);
  });

  it('holds the reader in a ref, so a new function identity does not resubscribe', () => {
    // The screen's `readPoi` is a `useCallback` on the renderer branch. If this
    // component depended on it, a re-render with a new identity would tear the
    // interval down and build a new one - which is how a "throttled" poll becomes
    // a per-render poll. The sampler is installed exactly once, in an empty
    // dependency list, and reads the latest reader through a ref.
    const first = vi.fn(() => ({ name: 'A', angle: 0, distance: 400 }));
    const second = vi.fn(() => ({ name: 'B', angle: 0, distance: 400 }));
    const view = render(<CompassOverlay readPoi={first} sampleIntervalMs={10} />);
    act(() => { vi.advanceTimersByTime(20); });
    view.rerender(<CompassOverlay readPoi={second} sampleIntervalMs={10} />);
    act(() => { vi.advanceTimersByTime(20); });

    expect(second.mock.calls.length, 'the newest reader is never called').toBeGreaterThan(0);
  });
});

describe('the source cannot drift back into a React-driven compass', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'src', 'ui', 'village', 'CompassOverlay.tsx'),
    'utf8',
  );
  // Comments are stripped so this file is allowed to explain the rules it pins.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('holds no state at all, so there is nothing for a sample to re-render', () => {
    expect(code, 'a state hook is how a scene measurement reaches React').not.toMatch(
      /\buse(State|Reducer|SyncExternalStore)\b/,
    );
  });

  it('has no animation frame loop, so there is no per-frame path back in', () => {
    expect(code).not.toMatch(/requestAnimationFrame/);
  });

  it('samples on a throttled interval rather than a bare recursive timeout', () => {
    expect(code).toMatch(/setInterval/);
    expect(code, 'a self-scheduling timeout has no interval to clear on unmount').not.toMatch(
      /setTimeout\s*\(\s*sample/,
    );
  });

  it('is decorative, and says so, because the DOM list is the accessible route', () => {
    // The claim "no Pixi object is required to understand a village action" is only
    // true if the accessible route exists *and* the decorative one is hidden from
    // assistive technology rather than merely quiet.
    expect(code).toMatch(/aria-hidden="true"/);
  });
});
