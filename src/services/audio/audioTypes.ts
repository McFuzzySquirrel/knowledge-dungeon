/**
 * The audio id space and its shared option shapes.
 *
 * ## Why the ids live here and not in `audioManager.ts`
 *
 * `audioManager.ts` re-exports every symbol here, so `FishingScene` and the other
 * legacy callers keep importing from the path they have always used. But the
 * providers, the gesture source, and the preferences store all need the *same* id
 * vocabulary, and a type that lives in the module a Phaser scene imports would
 * drag a renderer dependency into the audio providers by way of a type import. The
 * eslint renderer-boundary rule lists `src/services/persistence/v2/**` and
 * `src/theme/**` as renderer-neutral layers rather than trusting the tree it is in,
 * and this module is the same situation: it is imported by something that must
 * never be able to name an engine, so it holds no imports at all.
 *
 * ## Why the unions are closed
 *
 * `AudioTrack` and `SfxKind` are closed unions, and every member has a recipe in
 * `audioRecipes.ts`. That is enforced rather than hoped for: the recipe tables are
 * typed as `Record<string, ...>` rather than `Record<AudioTrack, ...>` on purpose,
 * because a recipe table typed to the union would report a compile error for a
 * *missing* row (good) while making it impossible to write a row for an id that
 * nothing asks for yet (also good) - but it would not catch the reverse defect,
 * which is the one that bites: a union member with no recipe silently produces no
 * sound and a learner never learns why. The test asserts coverage in both
 * directions instead, so the compiler stays out of it.
 */

/** A background track id. One recipe per id in `MUSIC_RECIPES`. */
export type AudioTrack = 'bgm-dungeon' | 'bgm-village' | 'bgm-boss';

/** Every sound effect the application asks for. One recipe each in `SFX_RECIPES`. */
export type SfxKind =
  | 'ui-click'
  | 'ui-hover'
  | 'encounter-start'
  | 'encounter-success'
  | 'xp-earn'
  | 'artifact-collect'
  | 'npc-greet'
  | 'door-open'
  | 'boss-encounter'
  | 'achievement-unlock'
  | 'loot-drop'
  | 'portal-enter'
  | 'fish-cast'
  | 'fish-splash'
  | 'fish-bite'
  | 'fish-reel'
  | 'fish-catch'
  | 'fish-miss';

/** Either id space, for a provider that takes one string. */
export type AudioAssetId = AudioTrack | SfxKind;

/** Every valid track id, for iteration and for the coverage test. */
export const AUDIO_TRACK_IDS: readonly AudioTrack[] = Object.freeze([
  'bgm-dungeon',
  'bgm-village',
  'bgm-boss',
]);

/** Every valid effect id, for iteration and for the coverage test. */
export const SFX_KIND_IDS: readonly SfxKind[] = Object.freeze([
  'ui-click',
  'ui-hover',
  'encounter-start',
  'encounter-success',
  'xp-earn',
  'artifact-collect',
  'npc-greet',
  'door-open',
  'boss-encounter',
  'achievement-unlock',
  'loot-drop',
  'portal-enter',
  'fish-cast',
  'fish-splash',
  'fish-bite',
  'fish-reel',
  'fish-catch',
  'fish-miss',
]);

/** The event types the gesture source may listen for. */
export type AudioGestureEventName = 'pointerdown' | 'keydown' | 'touchend';

/**
 * The documented defaults for a device with no stored audio preference.
 *
 * These live here rather than in `audioManager.ts` because the preferences store
 * needs them too, and a default declared in two places is a default that will
 * differ in two places. The store's pre-hydration state and the manager's initial
 * state are the same object of values for the same reason.
 *
 * Music is quieter than effects by default because music is continuous and effects
 * are not: a learner who finds music too loud turns music down and keeps the
 * feedback that tells them a click landed.
 */
export const DEFAULT_MUSIC_VOLUME = 0.4;
export const DEFAULT_SFX_VOLUME = 0.6;
export const DEFAULT_MUTED = false;
export const DEFAULT_MUSIC_ENABLED = true;
export const DEFAULT_SFX_ENABLED = true;

/** A resolved gain, always in 0..1 and always a number. */
export type AudioVolume = number;
