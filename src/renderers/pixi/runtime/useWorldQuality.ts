/**
 * Choosing a quality profile and reading the motion preference, in React.
 *
 * ## What this is for
 *
 * Plan section 10.2 asks for "lower resolution and antialiasing profiles for
 * constrained devices" and section 10.1 for `prefers-reduced-motion` support in
 * Pixi. Both are *observations*, and this hook is the only place the React host
 * makes them. The policy that turns an observation into a decision lives in
 * `createPixiWorldHost.ts` and `cozyWorldTheme.ts`, neither of which imports React -
 * so a scene author reading the host does not have to reason about a component to
 * find out what reduced motion does.
 *
 * ## What it deliberately does not do
 *
 * It does not measure. A frame-time sampler would give a better answer than any
 * device heuristic, and it would also run for as long as the world is open, cost a
 * ticker callback, and produce a different profile on every navigation. Plan
 * section 10.2 lists a measured frame-time target for the dungeon phase, not for
 * the host; a profile that is a *decision* rather than a *measurement* is also
 * reproducible, which is what makes a leak or a regression report comparable between
 * two runs.
 *
 * The heuristic is three signals, in the order they can veto each other:
 *
 * 1. **Coarse pointer.** A touch-only device is a constrained device, and this is
 *    the one signal that is about how the world will be *used* rather than what it
 *    is made of.
 * 2. **Hardware concurrency.** Below four logical cores, a WebGL context with
 *    antialiasing is competing with everything else the tab is doing.
 * 3. **Device pixel ratio.** Above 2, a backing store at the full ratio quadruples
 *    the pixels of a retina desktop display; the `high` profile already caps at 2,
 *    so a 3x phone is treated as `high` rather than as "even more".
 *
 * Every one of them is optional. A browser that reports none of them gets
 * `balanced`, which is the profile that is defensible without a measurement.
 */
import { useEffect, useMemo, useState } from 'react';

import { resolveWorldQualityProfile, type WorldQualityId, type WorldQualityProfile } from './types';

/** The two media queries the heuristic reads. Static, and they carry no data. */
export const WORLD_QUALITY_MEDIA_QUERIES = Object.freeze({
  coarsePointer: '(pointer: coarse)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
});

/**
 * The device facts the heuristic reads.
 *
 * A plain record so the policy in {@link resolveWorldQuality} is a pure function
 * of it, and so a test can state a device as data rather than by installing four
 * different stubs on four different globals.
 */
export interface WorldQualitySignals {
  /** `(pointer: coarse)` matched. */
  readonly coarsePointer: boolean;
  /** `navigator.hardwareConcurrency`, or `null` when the browser does not report it. */
  readonly hardwareConcurrency: number | null;
  /** `window.devicePixelRatio`. Clamped to a finite positive number by the reader. */
  readonly devicePixelRatio: number;
  /** The observed `prefers-reduced-motion` state. Not a heuristic input. */
  readonly reducedMotion: boolean;
}

/** The profile the host uses when nothing is known. */
export const DEFAULT_WORLD_QUALITY_SIGNALS: WorldQualitySignals = Object.freeze({
  coarsePointer: false,
  hardwareConcurrency: null,
  devicePixelRatio: 1,
  reducedMotion: false,
});

/** Below this many logical cores a device is treated as constrained. */
export const CONSTRAINED_CORE_THRESHOLD = 4;

/** At or above this device pixel ratio, a display already gets everything the high profile offers. */
export const HIGH_RESOLUTION_DPR_THRESHOLD = 2;

/**
 * The profile these signals mean.
 *
 * Total over its input and monotone in the two costs that matter: a coarse pointer
 * or few cores picks `constrained` regardless of the pixel ratio, because halving
 * the frame rate and quartering the pixels are the same decision made for different
 * reasons. `high` is never selected automatically from a pixel ratio alone - a 3x
 * phone is still a phone - which is why the `high` profile exists as a choice rather
 * than as an outcome.
 */
export function resolveWorldQuality(signals: WorldQualitySignals): WorldQualityProfile {
  const cores = signals.hardwareConcurrency;
  const dpr = Number.isFinite(signals.devicePixelRatio) && signals.devicePixelRatio > 0
    ? signals.devicePixelRatio
    : 1;
  if (signals.coarsePointer || (cores !== null && cores > 0 && cores < CONSTRAINED_CORE_THRESHOLD)) {
    return resolveWorldQualityProfile('constrained');
  }
  // `high` needs a *reported* core count as well as a dense display. Treating an
  // unreported count as "enough" would put a 3x phone - the most likely device to be
  // slow, and the one whose battery matters most - on the most expensive profile,
  // because a phone that declines to report its cores is a phone.
  if (dpr >= HIGH_RESOLUTION_DPR_THRESHOLD && cores !== null && cores >= CONSTRAINED_CORE_THRESHOLD) {
    return resolveWorldQualityProfile('high');
  }
  return resolveWorldQualityProfile(null);
}

/** Read the signals from a realm. Every global is optional. */
export function readWorldQualitySignals(win: Window | undefined): WorldQualitySignals {
  const dpr = win?.devicePixelRatio;
  const cores = win?.navigator?.hardwareConcurrency;
  return {
    coarsePointer: matches(win, WORLD_QUALITY_MEDIA_QUERIES.coarsePointer),
    hardwareConcurrency: typeof cores === 'number' && Number.isFinite(cores) ? cores : null,
    devicePixelRatio: typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1,
    reducedMotion: matches(win, WORLD_QUALITY_MEDIA_QUERIES.reducedMotion),
  };
}

/**
 * Whether a media query matches, or `false` where it cannot be asked.
 *
 * A refusal is `false` rather than a throw: a webview that does not know
 * `(pointer: coarse)` has not told us the device is constrained, and answering
 * "constrained" on its say-so would put a capable desktop on the phone profile
 * because of an embed. The same reasoning makes `(prefers-reduced-motion: reduce)`
 * answer `false`, which is the state a realm that cannot observe the preference is
 * in, and the safe default for an opt-in accessibility preference.
 */
function matches(win: Window | undefined, query: string): boolean {
  if (!win || typeof win.matchMedia !== 'function') return false;
  try {
    return win.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * The quality profile and the motion preference, kept current.
 *
 * Both are re-read whenever the media queries they depend on change, so a learner
 * who plugs in a display or turns reduced motion on gets the change without a
 * reload. The listener is removed on unmount; a hook that leaves a `MediaQueryList`
 * handler attached would keep the whole component alive across a navigation, which
 * is the leak this phase is about.
 */
export function useWorldQuality(): {
  readonly profile: WorldQualityProfile;
  readonly reducedMotion: boolean;
  /** A named profile a caller can pin, or `null` to let the heuristic decide. */
  readonly pin: (id: WorldQualityId | null) => void;
} {
  const [signals, setSignals] = useState<WorldQualitySignals>(() => readWorldQualitySignals(globalWindow()));
  const [pinned, setPinned] = useState<WorldQualityId | null>(null);

  useEffect(() => {
    const win = globalWindow();
    if (!win) return;

    const read = () => setSignals(readWorldQualitySignals(win));
    const queries = [
      win.matchMedia(WORLD_QUALITY_MEDIA_QUERIES.coarsePointer),
      win.matchMedia(WORLD_QUALITY_MEDIA_QUERIES.reducedMotion),
    ];
    const previous = queries.map((query) => query.onchange);
    const onChange = () => read();
    queries.forEach((query) => {
      query.onchange = onChange;
    });

    // A window resize is the other way a device pixel ratio changes, and it is the
    // only event a browser fires for a monitor swap.
    win.addEventListener('resize', read);
    return () => {
      queries.forEach((query, index) => {
        if (query.onchange === onChange) query.onchange = previous[index] ?? null;
      });
      win.removeEventListener('resize', read);
    };
  }, []);

  const reducedMotion = signals.reducedMotion;
  const profile = useMemo(
    () => (pinned === null ? resolveWorldQuality(signals) : resolveWorldQualityProfile(pinned)),
    [pinned, signals],
  );

  return { profile, reducedMotion, pin: setPinned };
}

/** The window of the current realm, or `undefined` where there is no DOM. */
function globalWindow(): Window | undefined {
  const scope = globalThis as { window?: Window };
  return typeof scope.window === 'object' && scope.window !== null ? scope.window : undefined;
}

/**
 * The quality profile and motion preference for a realm, without React.
 *
 * Present because a renderer host is not only a component: Phase 11's Village is
 * a scene, and a scene driven from a store or a test needs the same decision
 * without a render cycle. It reads once and never subscribes, so a caller that
 * needs the live version uses the hook.
 */
export function readWorldQuality(): { readonly profile: WorldQualityProfile; readonly reducedMotion: boolean } {
  const signals = readWorldQualitySignals(globalWindow());
  return { profile: resolveWorldQuality(signals), reducedMotion: signals.reducedMotion };
}

/** Re-exported so a screen can name the value it received without a second import. */
export type { WorldQualityId, WorldQualityProfile };
