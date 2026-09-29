/**
 * Clamping and coercion for audio preferences.
 *
 * ## Why these are here and not in the store
 *
 * Two independent producers hand a volume or a flag to the audio manager: a learner
 * dragging a slider, and a `localStorage` payload written by some earlier version of
 * this build (or by hand, or by a corrupted write). The second is untrusted, and the
 * defect it prevents is specific: `localStorage` is the one place in this application
 * where a value can arrive that no code path validated. A stored `"0.4"` would reach
 * `AudioParam.value` as `NaN` and silently mute that bus forever for the session; a
 * stored `1e9` would drive the graph to a value the platform clamps, so the slider
 * would read as broken while audio played.
 *
 * So the rule is stated once, here, and both producers go through it:
 *
 * - a **clamp** for a value from a live control, because the learner asked for
 *   something and the nearest legal value is closer to their intent than the default;
 * - a **coerce** for a stored value, because a stored value that is not a legal one
 *   is not a preference anyone expressed - it is data damage - so it becomes the
 *   documented default rather than something the application guesses at.
 *
 * `Number.isFinite` is the load-bearing check in both. `NaN` survives arithmetic
 * comparisons in ways that are the opposite of what a clamp looks like
 * (`Math.min(1, Math.max(0, NaN)` is `NaN`), so a clamp built on `Math` alone passes
 * `NaN` straight through to Web Audio.
 *
 * ## Why no learner data appears in this module
 *
 * It is pure numeric coercion with no logging, no identifiers, and no storage access,
 * which is what lets it be called from the hydration path - the one place in the
 * application that reads a persisted payload.
 */

import {
  DEFAULT_MUTED,
  DEFAULT_MUSIC_ENABLED,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_SFX_ENABLED,
  DEFAULT_SFX_VOLUME,
  type AudioVolume,
} from './audioTypes';

/**
 * Clamp a live volume request into 0..1.
 *
 * A non-finite request falls back to the documented default rather than to 0 or 1,
 * because both of those are *decisions* the learner did not make: a `NaN` from a
 * slider calculation would otherwise become silence, which reads as "the app broke"
 * rather than "that control is disabled".
 */
export function clampAudioVolume(value: number, fallback: AudioVolume): AudioVolume {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Resolve a stored volume.
 *
 * Any stored value that is not a finite number in 0..1 becomes the default. This is
 * stricter than {@link clampAudioVolume} on purpose, and the difference is the whole
 * reason the two functions exist: a stored `2` is not a learner who wants it louder
 * than possible, it is a payload this build did not write, and honouring it would
 * mean guessing which unit it was in.
 */
export function coerceStoredAudioVolume(
  value: unknown,
  fallback: AudioVolume,
): AudioVolume {
if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}


/**
 * Resolve a stored boolean.
 *
 * Strictly `true` or `false`. A stored `"false"` - a plausible result of a payload
 * that was stringified carelessly - becomes the default rather than a negation:
 * guessing which way a string was meant to read is how a learner ends up with audio
 * they did not turn on.
 */
export function coerceStoredBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The documented audio defaults, as one value. */
export const DEFAULT_AUDIO_PREFERENCES = Object.freeze({
  musicVolume: DEFAULT_MUSIC_VOLUME,
  sfxVolume: DEFAULT_SFX_VOLUME,
  muted: DEFAULT_MUTED,
  musicEnabled: DEFAULT_MUSIC_ENABLED,
  sfxEnabled: DEFAULT_SFX_ENABLED,
});

/** The five audio fields, resolved. */
export interface ResolvedAudioPreferences {
  readonly musicVolume: AudioVolume;
  readonly sfxVolume: AudioVolume;
  readonly muted: boolean;
  readonly musicEnabled: boolean;
  readonly sfxEnabled: boolean;
}
