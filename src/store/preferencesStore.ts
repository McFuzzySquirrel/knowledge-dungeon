/**
 * Preferences store for persistent UI preferences.
 *
 * The `graphicsMode` and `colorTheme` fields are persisted so the current UI
 * theme selection survives reloads.
 *
 * Phase 4: this store no longer reads `localStorage` at module load. Hydration is
 * explicit - `hydratePreferences` is called by the application bootstrap with
 * whatever the selected repository produced, before the first render. The
 * initial state is the documented default, and the resolution rules are
 * unchanged, so a device with no stored preference hydrates to exactly what the
 * old module-load read produced.
 *
 * A change is written to the selected repository: storage-v2 is primary and the
 * legacy key is the rollback mirror. See {@link persist}.
 *
 * Phase 10 adds the five audio preferences - music volume, SFX volume, mute, and
 * the two enabled toggles - through exactly the existing path: a documented default
 * for the pre-hydration state, a `resolveInitial*` function per field, no
 * `localStorage` read at module load, explicit `hydratePreferences`, and every write
 * through the same `persist()` dual write. Nothing about hydration or persistence
 * changed shape, which is why no rollback procedure is needed for this addition: a
 * device that stored only `colorTheme` hydrates with the documented audio defaults,
 * and a rollback build reads a payload with keys it ignores.
 *
 * The one thing that *did* change structurally is {@link persistedPayloadFor}: the
 * Phase 4 setters each built their own three-key object literal, which would have
 * meant five more literals - or a setter that wrote a partial payload and dropped
 * every other preference on reload. See the comment there.
 */
import { create } from 'zustand';

import {
  COZY_FALLBACK_THEME,
  LEGACY_COLOR_THEME_VALUES,
  cozyThemeForColorTheme,
} from '@/theme/legacyThemeMap';
import type { CozyTheme } from '@/theme/cozyTokens';
import {
  clampAudioVolume,
  coerceStoredAudioVolume,
  coerceStoredBoolean,
  DEFAULT_AUDIO_PREFERENCES,
  type ResolvedAudioPreferences,
} from '@/services/audio/audioPreferenceValues';
import { audioManager } from '@/services/audioManager';
import type { PersistedPreferencesValue } from '@/services/persistence/v2/appState';
import { writeThroughInBackground } from '@/services/persistence/v2/dualWrite';
import { currentStorageV2Repository } from '@/services/persistence/v2/repositorySelection';

export type GraphicsMode = 'rpg';
export type ColorTheme = 'dark' | 'colorful' | 'aurora';

/**
 * Phase 10: the persisted audio fields.
 *
 * Every one is optional and separately defaulted, and that is the compatibility
 * requirement, not a convenience. The stored payload is shared with every build
 * that has ever written this key, so:
 *
 * - a device that stored only `colorTheme` has none of these keys, and hydrates with
 *   the documented audio defaults;
 * - a device written by a rollback build that predates this phase reads a payload
 *   containing keys it does not know, and ignores them - which is why the audio
 *   fields are additive and never replace an existing one.
 *
 * The types are `unknown`-ish on the way *in* and resolved on the way out: the
 * payload arrives from `localStorage` or from a storage-v2 generation, which is the
 * one untrusted boundary in the application, so the store never trusts a stored type
 * and coerces instead. See `resolveInitialMusicVolume` for the rule and why it is
 * stricter than the clamp a live slider gets.
 */
export interface PersistedAudioPreferences {
  musicVolume?: unknown;
  sfxVolume?: unknown;
  muted?: unknown;
  musicEnabled?: unknown;
  sfxEnabled?: unknown;
}

export interface PersistedPreferences extends PersistedAudioPreferences {
  graphicsMode?: GraphicsMode;
  colorTheme?: ColorTheme | 'light' | 'sepia';
  activeSpritePack?: string | null;
}

const PREFERENCES_STORAGE_KEY = 'knowledge-dungeon:session:preferences';

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Read the persisted preferences. The legacy repository's half of hydration. */
export function readPersistedPreferences(): PersistedPreferences | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPreferences;
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writePersisted(prefs: PersistedPreferences): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota or privacy-mode failures are non-fatal; the in-memory store still
    // works for the current session.
  }
}

/**
 * Persist a preference change to the selected repository.
 *
 * With storage-v2 selected it is the primary repository, so the change also has
 * to reach the active generation or a reload on the build the learner changed
 * the preference on would lose it - the change would sit in the rollback mirror
 * and nowhere else, which is the defect this closes.
 *
 * The legacy key is written first and synchronously, because that is what this
 * build has always done, what a rollback build reads, and what the default
 * artifact's behaviour must not change. The generation write follows it, so the
 * ordering that matters holds: a preference the flagged build lost is also absent
 * from storage-v2, never present in it and missing from the mirror.
 *
 * Synchronous by contract - a store action cannot await - and lazy, because the
 * storage-v2 record adapter is not part of the default artifact. A failure
 * becomes a sanitized report and never a rejected promise or a thrown error, so a
 * preference always applies in the current session even if the write did not land.
 */
function persist(value: PersistedPreferences): void {
  writePersisted(value);
  const repository = currentStorageV2Repository();
  if (repository === null) return;
  writeThroughInBackground({
    operation: 'preferences',
    primary: () =>
      import('@/services/persistence/v2/appRepository').then((records) =>
        records.publishPreferencesToActiveGeneration(repository, value, new Date().toISOString()),
      ),
    // The mirror already happened above, before the primary, so it cannot fail
    // here. Reported as a success so the operation is not counted twice.
    mirror: () => true,
  });
}

/**
 * The graphics mode for a persisted payload.
 *
 * `rpg` is the only mode, so a stored value and the default agree; the stored
 * payload is still read so the resolution rule stays in one place.
 */
export function resolveInitialGraphicsMode(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): GraphicsMode {
  return persisted?.graphicsMode === 'rpg' ? 'rpg' : 'rpg';
}

/** The color theme for a persisted payload, including the legacy aliases. */
export function resolveInitialColorTheme(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): ColorTheme {
  switch (persisted?.colorTheme) {
    case 'dark':
    case 'colorful':
    case 'aurora':
      return persisted.colorTheme;
    case 'light':
    case 'sepia':
      return 'dark';
    default:
      return 'dark';
  }
}

/**
 * The music volume for a persisted payload.
 *
 * Coerced, not clamped, and the difference is the whole reason this is not
 * `clampAudioVolume`. A stored value that is not a finite number in 0..1 is not a
 * preference someone expressed - `localStorage` is writable by hand, corrupted by a
 * partial write, and shared with older builds that stored different units - so it
 * becomes the documented default. Clamping it would instead be a guess about intent,
 * and the worst case of that guess is a bus that never makes sound while the slider
 * claims it is at full volume.
 */
export function resolveInitialMusicVolume(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): number {
  return coerceStoredAudioVolume(persisted?.musicVolume, DEFAULT_AUDIO_PREFERENCES.musicVolume);
}

/** The sound-effect volume for a persisted payload. Same rule as the music volume. */
export function resolveInitialSfxVolume(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): number {
  return coerceStoredAudioVolume(persisted?.sfxVolume, DEFAULT_AUDIO_PREFERENCES.sfxVolume);
}

/**
 * The mute flag for a persisted payload.
 *
 * A stored non-boolean becomes the default rather than a negation. `"false"` is a
 * plausible result of a payload that was stringified carelessly, and reading it as
 * `true` would mute a learner who stored nothing; reading it as `false` would
 * un-mute one who muted. Neither guess is better, so the documented default wins.
 */
export function resolveInitialMuted(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): boolean {
  return coerceStoredBoolean(persisted?.muted, DEFAULT_AUDIO_PREFERENCES.muted);
}

/** The music-enabled flag for a persisted payload. */
export function resolveInitialMusicEnabled(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): boolean {
  return coerceStoredBoolean(persisted?.musicEnabled, DEFAULT_AUDIO_PREFERENCES.musicEnabled);
}

/** The sound-effect enabled flag for a persisted payload. */
export function resolveInitialSfxEnabled(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): boolean {
  return coerceStoredBoolean(persisted?.sfxEnabled, DEFAULT_AUDIO_PREFERENCES.sfxEnabled);
}

/** The initial state for a persisted payload, or for no payload at all. */
export function initialPreferencesState(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): Pick<
  PreferencesState,
  'graphicsMode' | 'colorTheme' | 'activeSpritePack' | 'musicVolume' | 'sfxVolume' | 'muted' | 'musicEnabled' | 'sfxEnabled'
> {
  return {
    graphicsMode: resolveInitialGraphicsMode(persisted),
    colorTheme: resolveInitialColorTheme(persisted),
    activeSpritePack: persisted?.activeSpritePack ?? null,
    musicVolume: resolveInitialMusicVolume(persisted),
    sfxVolume: resolveInitialSfxVolume(persisted),
    muted: resolveInitialMuted(persisted),
    musicEnabled: resolveInitialMusicEnabled(persisted),
    sfxEnabled: resolveInitialSfxEnabled(persisted),
  };
}

/**
 * The five audio fields, ready for `audioManager.applyPreferences`.
 *
 * This is the whole seam between the two owners of an audio preference. The store
 * owns the *persisted* value and this is a projection of live store state onto it;
 * `src/services/audioManager.ts` owns the *running* mix and takes exactly this
 * shape. Neither reaches for the other's storage: the manager never reads
 * `localStorage`, and the store never touches an `AudioContext`. Keeping them
 * separate is what makes both testable on their own, and it is why a settings
 * control has two obvious calls to make (set the store, apply to the manager)
 * rather than one ambiguous one.
 *
 * Returned as a fresh object so a caller cannot hold a reference into store state.
 */
export function selectAudioPreferences(
  state: Pick<
    PreferencesState,
    'musicVolume' | 'sfxVolume' | 'muted' | 'musicEnabled' | 'sfxEnabled'
  >,
): ResolvedAudioPreferences {
  return {
    musicVolume: state.musicVolume,
    sfxVolume: state.sfxVolume,
    muted: state.muted,
    musicEnabled: state.musicEnabled,
    sfxEnabled: state.sfxEnabled,
  };
}

/** The audio half of the initial state, for the audio manager to apply. */
export function initialAudioPreferencesState(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): ResolvedAudioPreferences {
  return {
    musicVolume: resolveInitialMusicVolume(persisted),
    sfxVolume: resolveInitialSfxVolume(persisted),
    muted: resolveInitialMuted(persisted),
    musicEnabled: resolveInitialMusicEnabled(persisted),
    sfxEnabled: resolveInitialSfxEnabled(persisted),
  };
}

/**
 * Phase 8: the Cozy theme a persisted colour preference maps onto.
 *
 * This is a *mapping*, not a migration. The store keeps storing and hydrating
 * exactly the `colorTheme` string it always did, so a device that set
 * `VITE_COZY_VISUALS=false` and a device that set it `true` read the same
 * `localStorage` entry and neither can lose the other's preference. Changing the
 * stored value would have been the one thing that could break an existing
 * installation, so nothing is rewritten.
 *
 * No store field is added for the result. Theme reaches the DOM as
 * `data-theme={colorTheme}` on `.ui-skin` elements, and `src/styles/cozy-tokens.css`
 * maps that attribute onto a Cozy palette, so a new field would be state nothing
 * reads until a later phase owns the theme picker. These selectors exist for
 * that phase and for tests.
 *
 * Deliberately not gated on `VITE_COZY_VISUALS`: the mapping is a pure function
 * of the stored string, so it is identical with the flag on or off, and gating
 * it would only make the two paths harder to compare.
 */
export function selectCozyTheme(state: Pick<PreferencesState, 'colorTheme'>): CozyTheme {
  return cozyThemeForColorTheme(state.colorTheme);
}

/** The Cozy theme for a persisted payload, including the legacy aliases. */
export function resolveInitialCozyTheme(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): CozyTheme {
  return cozyThemeForColorTheme(persisted?.colorTheme);
}

/**
 * The `data-theme` value for a Cozy theme, for a screen that wants to be
 * explicit. Returns the canonical legacy spelling so the CSS mapping in
 * `cozy-tokens.css` resolves it.
 */
export function legacyThemeValueForCozyTheme(theme: CozyTheme): ColorTheme | 'light' | 'sepia' {
  switch (theme) {
    case 'cozy-parchment':
      return 'light';
    case 'cozy-berry':
      return 'colorful';
    case 'cozy-firelight':
      return 'aurora';
    case 'cozy-ink':
      return 'dark';
    default:
      // Unreachable for a declared CozyTheme; keeps a future theme from
      // silently rendering as a mismatched palette.
      return 'dark';
  }
}

/**
 * The whole payload for one write.
 *
 * Every setter goes through this, including the ones Phase 4 wrote. That is a
 * deliberate change: the Phase 4 setters each built a three-key object literal, so
 * adding audio fields would have meant either a fifth literal per setter or -
 * worse - a setter that wrote a partial payload and silently dropped the other
 * fields on reload. One builder means a new field is persisted by every action
 * without any action knowing it exists, which is what keeps "change the music
 * volume, reload, the colour theme is still set" true.
 *
 * It reads from `state` rather than from the action's argument for every field, so
 * there is no ordering question: the payload is always the post-change state.
 */
/**
 * Push the resolved audio preferences into the running audio service.
 *
 * The store owns the *persisted* value and `audioManager` owns the *running* mix,
 * so something has to carry one to the other. It is here, in the store, rather than
 * in the settings surface for one reason: every path that changes an audio
 * preference - hydration at boot, a slider, a mute button, a test - goes through a
 * store action, and a publish inside the action is the one place that cannot be
 * forgotten. Wiring it in the UI would mean the setting silently stopped applying
 * the moment it was set from anywhere else.
 *
 * The direction is deliberate and one-way. `audioManager` does not import this
 * module and never reads storage, so there is no cycle and the audio service stays
 * testable with a fake gesture source and no store.
 */
type PersistedFields = Pick<
  PreferencesState,
  | 'graphicsMode'
  | 'colorTheme'
  | 'activeSpritePack'
  | 'musicVolume'
  | 'sfxVolume'
  | 'muted'
  | 'musicEnabled'
  | 'sfxEnabled'
>;

function publishAudioPreferences(state: PersistedFields): void {
  audioManager.applyPreferences(selectAudioPreferences(state));
}

function persistedPayloadFor(state: PersistedFields): PersistedPreferences {
  return {
    graphicsMode: state.graphicsMode,
    colorTheme: state.colorTheme,
    activeSpritePack: state.activeSpritePack,
    musicVolume: state.musicVolume,
    sfxVolume: state.sfxVolume,
    muted: state.muted,
    musicEnabled: state.musicEnabled,
    sfxEnabled: state.sfxEnabled,
  };
}

export interface PreferencesState {
  graphicsMode: GraphicsMode;
  colorTheme: ColorTheme;
  activeSpritePack: string | null;
  /**
   * Phase 10 audio preferences. All five resolve to the documented defaults on a
   * device with no stored value, so an existing installation that stored only
   * `colorTheme` hydrates with sound rather than with a broken slider.
   */
  musicVolume: number;
  sfxVolume: number;
  /** The global mute, distinct from the two enabled toggles. See the manager. */
  muted: boolean;
  musicEnabled: boolean;
  sfxEnabled: boolean;
  /**
   * Apply a persisted payload. Called once by the application bootstrap, before
   * the first render. Passing `null` resets to the documented defaults.
   */
  hydratePreferences: (persisted: PersistedPreferences | PersistedPreferencesValue | null) => void;
  setGraphicsMode: (mode: GraphicsMode) => void;
  setColorTheme: (theme: ColorTheme) => void;
  setActiveSpritePack: (packName: string | null) => void;
  setMusicVolume: (volume: number) => void;
  setSfxVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setMusicEnabled: (enabled: boolean) => void;
  setSfxEnabled: (enabled: boolean) => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  // The pre-hydration state is the documented default. A device with no stored
  // preference hydrates to the same values, so nothing renders differently.
  ...initialPreferencesState(null),
  // Hydration publishes too, and not only for the audio fields: a payload with no
  // audio keys at all must still push the documented defaults into the running mix,
  // so a learner who stored nothing does not inherit whatever a previous manager
  // instance in the same page was left holding.
  hydratePreferences: (persisted) => {
    const next = initialPreferencesState(persisted);
    publishAudioPreferences(next);
    set(next);
  },
  setGraphicsMode: (graphicsMode) => {
    set((state) => {
      const next = { ...state, graphicsMode };
      persist(persistedPayloadFor(next));
      return { graphicsMode };
    });
  },
  setColorTheme: (colorTheme) => {
    set((state) => {
      const next = { ...state, colorTheme };
      persist(persistedPayloadFor(next));
      return { colorTheme };
    });
  },
  setActiveSpritePack: (activeSpritePack) => {
    set((state) => {
      const next = { ...state, activeSpritePack };
      persist(persistedPayloadFor(next));
      return { activeSpritePack };
    });
  },
  // A live slider value is *clamped*, not rejected: the learner asked for something,
  // and the nearest legal value is closer to their intent than the default. A
  // non-finite value (a `NaN` from a slider calculation, say) becomes the default,
  // because silence-by-accident is worse than the documented level.
  setMusicVolume: (musicVolume) => {
    set((state) => {
      const resolved = clampAudioVolume(musicVolume, DEFAULT_AUDIO_PREFERENCES.musicVolume);
      const next = { ...state, musicVolume: resolved };
      publishAudioPreferences(next);
      persist(persistedPayloadFor(next));
      return { musicVolume: resolved };
    });
  },
  setSfxVolume: (sfxVolume) => {
    set((state) => {
      const resolved = clampAudioVolume(sfxVolume, DEFAULT_AUDIO_PREFERENCES.sfxVolume);
      const next = { ...state, sfxVolume: resolved };
      publishAudioPreferences(next);
      persist(persistedPayloadFor(next));
      return { sfxVolume: resolved };
    });
  },
  setMuted: (muted) => {
    set((state) => {
      const next = { ...state, muted };
      publishAudioPreferences(next);
      persist(persistedPayloadFor(next));
      return { muted };
    });
  },
  setMusicEnabled: (musicEnabled) => {
    set((state) => {
      const next = { ...state, musicEnabled };
      publishAudioPreferences(next);
      persist(persistedPayloadFor(next));
      return { musicEnabled };
    });
  },
  setSfxEnabled: (sfxEnabled) => {
    set((state) => {
      const next = { ...state, sfxEnabled };
      publishAudioPreferences(next);
      persist(persistedPayloadFor(next));
      return { sfxEnabled };
    });
  },
}));

// Exported for unit tests so they can exercise the resolution rules without
// touching the live store singleton.
export const __testing = {
  PREFERENCES_STORAGE_KEY,
  readPersistedPreferences,
  resolveInitialGraphicsMode,
  resolveInitialColorTheme,
  resolveInitialCozyTheme,
  initialPreferencesState,
  initialAudioPreferencesState,
  resolveInitialMusicVolume,
  resolveInitialSfxVolume,
  resolveInitialMuted,
  resolveInitialMusicEnabled,
  resolveInitialSfxEnabled,
  selectCozyTheme,
  legacyThemeValueForCozyTheme,
  COZY_FALLBACK_THEME,
  LEGACY_COLOR_THEME_VALUES,
};
