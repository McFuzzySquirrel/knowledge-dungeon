/**
 * Audio manager for Knowledge Dungeon.
 *
 * ## What this module is
 *
 * The single renderer-neutral entry point for sound. Routes, Phaser scenes, the
 * Pixi worlds that arrive in Phases 11, 13, and 17, and the settings surface all
 * call these methods and none of them know whether the sound they triggered was
 * synthesised or loaded from a file.
 *
 * The public surface is deliberately the one Phase 3 defined - `subscribe`,
 * `getState`, `toggleMusic`, `toggleSfx`, `setMusicVolume`, `setSfxVolume`,
 * `playBgm`, `stopBgm`, `playSfx`, the `audioManager` singleton, `getAudioState` -
 * because `src/game/scenes/FishingScene.ts` calls `playSfx` on six fishing events
 * and a signature change there is a renderer change this phase does not own. What is
 * new is additive: `muted`, `setMuted`, `toggleMuted`, `applyPreferences`, and
 * `dispose`.
 *
 * ## The three rules this file exists to enforce
 *
 * **No context before a gesture.** The `AudioContext` is constructed inside the
 * unlock callback and nowhere else - not in the constructor, not in `playBgm`, not
 * in `playSfx`. The browser's autoplay policy blocks audible playback before a
 * gesture; it does not block the *resource*, and a context built at import time
 * allocates an audio device backend and logs a policy warning the first time
 * anything connects to it. `tests/unit/audioManager.test.ts` asserts mechanically
 * that a `playSfx` before any gesture constructs no context, creates no node, and
 * arms nothing that can make sound.
 *
 * **BGM intent is remembered; SFX is dropped.** A track requested before the gesture
 * is *intent*, and losing it means a learner who lands on a dungeon route and taps
 * anything hears nothing and has no way to know why. A sound effect requested before
 * the gesture is stale by the time it could play - it is feedback for an event that
 * has already been superseded - and queueing it would produce a click on the first
 * tap for every effect the learner triggered while navigating a cold screen. So BGM
 * is remembered as intent and started on unlock; SFX is dropped. Both are one branch
 * each, and both are tested.
 *
 * **A failure is never a throw.** Missing media, a context that cannot be
 * allocated, an environment with no Web Audio at all: each degrades to silence and
 * keeps the route working. Phase 10's exit criterion is "missing optional media does
 * not break a route", and a service whose failure mode is a rejected promise from a
 * Phaser scene's update loop cannot make that true.
 *
 * ## How the two backends are arranged
 *
 * `createFileAudioProvider` is composed *over* `createProceduralAudioProvider` by
 * `createFallbackAudioProvider`. A provider returns `null` for an id it cannot serve,
 * and the request continues down the chain. Today the file provider resolves nothing,
 * because the CC0 registry has no `cc0-approved` entry and shipping one would breach
 * both the licence rule and Phase 10's non-goals - so every id lands on the
 * procedural recipes. When genuine CC0 audio is registered, the same composition
 * starts serving it and nothing here changes. See `src/services/audio/` for the
 * reasoning behind each piece.
 *
 * ## Renderer-neutral
 *
 * This file imports no renderer. Web Audio is a browser platform API that predates
 * every engine in this repository, and the providers talk to a sink - a context, a
 * gain node, and a clock - rather than to PixiJS, Phaser, or the DOM. A Pixi world and
 * a React DOM screen call the same methods.
 *
 * ## Preferences
 *
 * State lives here as the live mix; the persisted value lives in
 * `src/store/preferencesStore.ts`. This module never reads `localStorage` and never
 * writes it - a service that both owned the mix and persisted it would give two
 * sources of truth for one slider - and `applyPreferences` is how the store pushes a
 * hydrated or changed value in. The audio fields are optional in the persisted
 * payload, so a device that stored only `colorTheme` hydrates with the documented
 * defaults, and a rollback build that predates these fields simply ignores the keys.
 */

/**
 * Replaced placeholder methods, real playback, and a gesture-gated `AudioContext`.
 *
 * Phase 10 of `docs/plans/001-cozy-pixi-rebuild.md`: "Replace the placeholder methods
 * in `src/services/audioManager.ts:133-146` with real playback", "Require a user
 * gesture before playback", and "Add music volume, SFX volume, mute, and persisted
 * audio preferences".
 */

import {
  createAudioGraph,
  createDefaultAudioContext,
  type AudioGraph,
  type AudioMix,
  type AudioPlaybackHandle,
} from '@/services/audio/audioGraph';
import {
  createAudioUnlockGate,
  createWindowGestureSource,
  type AudioGestureSource,
  type AudioUnlockGate,
} from '@/services/audio/audioGesture';
import {
  createFallbackAudioProvider,
  type AudioPlaybackProvider,
  type AudioProviderId,
} from '@/services/audio/audioProvider';
import {
  createFileAudioProvider,
  type AudioAssetLoader,
  type AudioAssetResolver,
} from '@/services/audio/fileAudioProvider';
import { createProceduralAudioProvider } from '@/services/audio/proceduralAudioProvider';
import {
  clampAudioVolume,
  DEFAULT_AUDIO_PREFERENCES,
  type ResolvedAudioPreferences,
} from '@/services/audio/audioPreferenceValues';
import {
  AUDIO_TRACK_IDS,
  SFX_KIND_IDS,
  type AudioTrack,
  type AudioVolume,
  type SfxKind,
} from '@/services/audio/audioTypes';
import { FEATURE_FLAGS } from '@/config/featureFlags';

// Re-exported so every existing importer keeps working from this path. `FishingScene`
// imports `audioManager` from here, and the settings surface Phase 10 adds will
// import the id types from the same place.
export type {
  AudioAssetId,
  AudioGestureEventName,
  AudioTrack,
  AudioVolume,
  SfxKind,
} from '@/services/audio/audioTypes';
export { AUDIO_TRACK_IDS, SFX_KIND_IDS } from '@/services/audio/audioTypes';
export type { AudioGestureSource } from '@/services/audio/audioGesture';
export type { AudioPlaybackProvider, AudioProviderId } from '@/services/audio/audioProvider';
export type { AudioAssetLoader, AudioAssetResolver } from '@/services/audio/fileAudioProvider';
export { DEFAULT_AUDIO_PREFERENCES } from '@/services/audio/audioPreferenceValues';

/** The observable audio state. Extended in Phase 10 with `muted`. */
export interface AudioManagerState {
  musicEnabled: boolean;
  sfxEnabled: boolean;
  musicVolume: AudioVolume; // 0–1
  sfxVolume: AudioVolume; // 0–1
  /**
   * The global kill switch, distinct from the per-bus enabled toggles.
   *
   * Separate because the two answer different questions and conflating them loses a
   * preference: `sfxEnabled: false` means "do not play effects", which is a *choice
   * about effects*, and `muted: true` means "silence this now", which is a mode a
   * learner leaves when they want their audio back. A single field would mean that
   * muting and unmuting reset a bus the learner had deliberately turned off - which
   * is exactly the bug that appeared when the mute control was first added on top of
   * a volume-only design.
   */
  muted: boolean;
  currentBgm: AudioTrack | null;
  bgmPlaying: boolean;
  /**
   * Which provider is currently serving playback. `'none'` before the first
   * unlocked request. Exposed because the fallback is a behaviour a later phase
   * needs to be able to assert on without reaching into the provider graph.
   */
  activeProvider: AudioProviderId | 'none';
  /**
   * Whether the audio context exists yet, i.e. whether a user gesture has happened.
   *
   * Exposed so a settings surface can show "audio controls are inactive until you
   * interact" and so the no-autoplay guarantee is checkable from the outside.
   */
  unlocked: boolean;
}

export type AudioStateChangeListener = (state: Readonly<AudioManagerState>) => void;

/**
 * Construction options. Every environment dependency is injected so the service can
 * be tested in jsdom, which has no `AudioContext`, with no global patching.
 */
export interface AudioManagerOptions {
  /**
   * Where a user gesture is observed. Defaults to capture-phase `window` listeners.
   * Tests inject a function they can call, which is what makes the no-autoplay
   * guarantee assertable rather than merely stated.
   */
  gestureSource?: AudioGestureSource;
  /**
   * Builds the audio graph. Defaults to the platform `AudioContext`. Injecting this
   * is how a test counts context constructions, which is the assertion that no
   * context exists before a gesture.
   */
  createGraph?: () => AudioGraph | null;
  /** Resolver for approved audio files. Defaults to "nothing is registered yet". */
  resolveAssetUrl?: AudioAssetResolver;
  /**
   * Loader for approved audio bytes. No default, on purpose: the audio service must
   * not own a network call, and the asset bundle service already does. Without one,
   * the file provider declines every id and the procedural provider serves them all.
   */
  loadAssetBytes?: AudioAssetLoader;
  /**
   * The whole provider chain, for a caller that wants to pin routing. Defaults to
   * file-over-procedural, which is the composition the design documents.
   */
  createProvider?: (fallback: AudioPlaybackProvider) => AudioPlaybackProvider;
  /** Whether audio may be produced at all. Defaults to the build-time flag. */
  enabled?: boolean;
}

/**
 * Build the audio manager.
 *
 * Exported as a factory rather than only as a singleton so a test can construct an
 * isolated instance with its own fake gesture source; the exported `audioManager`
 * below is just this function called with defaults.
 */
export function createAudioManager(options: AudioManagerOptions = {}): AudioManager {
  const {
    gestureSource = createWindowGestureSource(),
    createGraph = () => {
      const context = createDefaultAudioContext();
      return context === null ? null : createAudioGraph(context);
    },
    resolveAssetUrl,
    loadAssetBytes,
    enabled = isAudioEnabledByFlag(),
  } = options;

  const procedural = createProceduralAudioProvider();
  const provider =
    options.createProvider?.(procedural) ??
    createFallbackAudioProvider(
      createFileAudioProvider({ fallback: procedural, resolveAssetUrl, loadAssetBytes }),
      procedural,
    );

  const listeners = new Set<AudioStateChangeListener>();
  const state: AudioManagerState = {
    musicEnabled: DEFAULT_AUDIO_PREFERENCES.musicEnabled,
    sfxEnabled: DEFAULT_AUDIO_PREFERENCES.sfxEnabled,
    musicVolume: DEFAULT_AUDIO_PREFERENCES.musicVolume,
    sfxVolume: DEFAULT_AUDIO_PREFERENCES.sfxVolume,
    muted: DEFAULT_AUDIO_PREFERENCES.muted,
    currentBgm: null,
    bgmPlaying: false,
    activeProvider: 'none',
    unlocked: false,
  };

  let graph: AudioGraph | null = null;
  /** BGM requested before the gesture. Remembered, then played on unlock. */
  let pendingBgm: AudioTrack | null = null;
  let currentMusic: AudioPlaybackHandle | null = null;
  let disposed = false;

  function getState(): Readonly<AudioManagerState> {
    return { ...state };
  }

  function notify(): void {
    const snapshot = getState();
    for (const listener of listeners) listener(snapshot);
  }

  function mix(): AudioMix {
    return {
      musicVolume: state.musicVolume,
      sfxVolume: state.sfxVolume,
      muted: state.muted,
    };
  }

  /** Apply the current mix to the live graph, if there is one. */
  function applyMix(): void {
    graph?.applyMix(mix());
  }

  /**
   * Build the graph on the first gesture, then start whatever intent was recorded.
   *
   * The order matters. Building the graph first means the mix is applied before
   * anything plays, so the first thing a learner hears is already at their volume;
   * applying it afterwards would play one un-muted bar. Starting the remembered
   * intent last means a `playBgm` that arrived while the graph did not exist is
   * honoured rather than lost.
   */
  function unlock(): void {
    if (disposed || state.unlocked) return;
    if (!enabled) {
      // Flagged off: the graph is never built, so there is nothing to unlock and
      // nothing to release. `unlocked` stays false, which is why the settings
      // surface shows the flag state rather than claiming audio is active.
      return;
    }
    let built: AudioGraph | null = null;
    try {
      built = createGraph();
    } catch {
      // A platform that refuses to allocate a graph is the same case as one that
      // has no Web Audio: silence, no throw, and the route continues.
      built = null;
    }
    if (built === null) return;
    graph = built;
    state.unlocked = true;
    applyMix();

    // A context created inside a gesture handler is usually already `running`, but
    // not always - Safari in particular hands back a suspended context. Resuming is
    // inside the gesture callback for exactly that reason: a resume outside one is
    // the autoplay policy's second line of defence, and it is a no-op here if the
    // context is already running.
    try {
      const resume = graph.context.resume?.();
      if (resume !== undefined && typeof resume.then === 'function') {
        void resume.catch(() => {
          // A refused resume leaves a suspended context. Nothing to report and
          // nothing to retry: the next gesture will not come, and the browser
          // policy is not something an application can work around.
        });
      }
    } catch {
      // Same reasoning.
    }

    const intent = pendingBgm;
    pendingBgm = null;
    if (intent !== null && state.musicEnabled) startMusic(intent);
    notify();
  }

  const gate: AudioUnlockGate = createAudioUnlockGate(gestureSource, unlock);

  /**
   * Arm the gate, if it is worth arming.
   *
   * `playSfx` is the case that makes this interesting. The brief is "SFX is dropped,
   * not queued", and it is: no voice is scheduled, nothing is retained. But the
   * *first* sound effect of a session usually arrives from a tap, and that tap is
   * the gesture. Dropping the sound and also declining to arm would leave the app
   * silent until the learner happened to interact twice.
   */
  function ensureArmed(): void {
    if (disposed || !enabled || gate.unlocked || gate.armed) return;
    gate.arm();
  }

  function startMusic(track: AudioTrack): void {
    const active = graph;
    if (active === null) return;
    const sink = active.sink('music');
    const handle = provider.startMusic(sink, track);
    if (handle === null) {
      // Both providers declined. Nothing to play and nothing to report: `state`
      // still says a track is current, so a later request retries rather than
      // leaving `currentBgm` inconsistent with what is audible.
      return;
    }
    currentMusic = handle;
    state.bgmPlaying = true;
    state.activeProvider = provider.id;
  }

  function stopMusic(): void {
    const handle = currentMusic;
    currentMusic = null;
    if (handle !== null) {
      try {
        handle.stop();
      } catch {
        // A provider that throws while stopping must not strand the caller, and
        // `currentMusic` is already cleared so the stop cannot be retried into a
        // node that was never released.
      }
    }
    state.bgmPlaying = false;
  }

  return {
    subscribe(listener: AudioStateChangeListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getState,

    /** Toggle background music on/off. */
    toggleMusic(): boolean {
      state.musicEnabled = !state.musicEnabled;
      if (!state.musicEnabled) {
        stopMusic();
      } else if (state.currentBgm !== null) {
        // Re-enabling restarts the remembered track, which is what a learner who
        // muted the music bus mid-dungeon expects when they turn it back on.
        if (gate.unlocked) startMusic(state.currentBgm);
        else pendingBgm = state.currentBgm;
      }
      notify();
      return state.musicEnabled;
    },

    /** Toggle sound effects on/off. */
    toggleSfx(): boolean {
      state.sfxEnabled = !state.sfxEnabled;
      notify();
      return state.sfxEnabled;
    },

    /** Set music volume (0–1). Applies to live playback as a gain value. */
    setMusicVolume(volume: number): void {
      state.musicVolume = clampAudioVolume(volume, DEFAULT_AUDIO_PREFERENCES.musicVolume);
      // Assigned on the live node rather than by restarting the track: a volume
      // control that restarts the music is a control that audibly restarts the
      // music, and it would drop the position in the track every time it moved.
      applyMix();
      notify();
    },

    /** Set SFX volume (0–1). Applies to live playback as a gain value. */
    setSfxVolume(volume: number): void {
      state.sfxVolume = clampAudioVolume(volume, DEFAULT_AUDIO_PREFERENCES.sfxVolume);
      applyMix();
      notify();
    },

    /** Silence everything, including already-playing BGM, without losing volumes. */
    setMuted(muted: boolean): void {
      if (state.muted === muted) return;
      state.muted = muted;
      // One assignment on the master node. Stopping the track instead would make
      // unmuting restart it from the top, which is the behaviour that made an
      // earlier mute design feel broken.
      applyMix();
      notify();
    },

    /** Toggle the global mute. Returns the new muted value. */
    toggleMuted(): boolean {
      this.setMuted(!state.muted);
      return state.muted;
    },

    /** Request background music for a track. If music is enabled, starts playing. */
    playBgm(track: AudioTrack): void {
      if (state.currentBgm === track && state.bgmPlaying) return;
      stopMusic();
      state.currentBgm = track;
      ensureArmed();
      if (!state.musicEnabled) {
        notify();
        return;
      }
      if (gate.unlocked && graph !== null) {
        startMusic(track);
      } else {
        // Intent, not a queue. Recorded so the unlock starts the right track, and
        // cleared on `stopBgm` so a cancelled request does not surface later.
        pendingBgm = track;
      }
      notify();
    },

    /** Stop background music. */
    stopBgm(): void {
      state.currentBgm = null;
      pendingBgm = null;
      stopMusic();
      notify();
    },

    /** Play a sound effect. Dropped - not queued - before the audio gesture. */
    playSfx(kind: SfxKind): void {
      if (!state.sfxEnabled) return;
      ensureArmed();
      if (!gate.unlocked || graph === null) return;
      const handle = provider.startSfx(graph.sink('sfx'), kind);
      if (handle === null) return;
      state.activeProvider = provider.id;
    },

    /**
     * Apply a resolved preference payload.
     *
     * The settings surface and the store's hydration both come through here, so the
     * live mix and the persisted value cannot disagree about who owns a slider.
     * Values arrive already clamped and coerced - the store is the boundary that
     * deals with an untrusted payload - so this clamps again only because a
     * programmatic caller is not the store, and clamping is idempotent.
     */
    applyPreferences(preferences: ResolvedAudioPreferences): void {
      state.musicVolume = clampAudioVolume(
        preferences.musicVolume,
        DEFAULT_AUDIO_PREFERENCES.musicVolume,
      );
      state.sfxVolume = clampAudioVolume(preferences.sfxVolume, DEFAULT_AUDIO_PREFERENCES.sfxVolume);
      state.muted = preferences.muted;
      state.musicEnabled = preferences.musicEnabled;
      state.sfxEnabled = preferences.sfxEnabled;
      applyMix();
      // A hydrated `musicEnabled: false` has to actually stop the music, or a route
      // that requested a track during hydration plays it for as long as nobody looks.
      if (!state.musicEnabled) {
        stopMusic();
      } else if (state.currentBgm !== null && gate.unlocked && !state.bgmPlaying) {
        // Started only when nothing is playing. Re-starting a running track would
        // restart it from the top, which is exactly the audible restart this design
        // avoids everywhere else - a hydration event must not be audible as one.
        startMusic(state.currentBgm);
      }
      notify();
    },

    /**
     * Force the gesture gate open.
     *
     * Exists for tests and for an application that receives its first activation
     * through a path that is already a gesture. It is *not* how the app unlocks
     * normally, and it deliberately does not bypass the `enabled` flag: a flagged-off
     * build must not be able to produce sound by any route.
     */
    unlock(): void {
      if (!enabled) return;
      gate.unlock();
    },

    /**
     * Release everything: voices, timers, gain nodes, the context, and the gesture
     * listeners.
     *
     * Total and idempotent, because the two callers are a route unmount and a test
     * teardown, and React runs mount effects twice under StrictMode in development -
     * so "dispose after dispose" is not an error path, it is the normal one. After
     * disposal this manager produces no sound and holds no context, and
     * `getState().unlocked` is false.
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      gate.dispose();
      stopMusic();
      try {
        provider.dispose();
      } catch {
        // A provider that throws while disposing must not strand the graph below.
      }
      const active = graph;
      graph = null;
      if (active !== null) {
        try {
          active.dispose();
        } catch {
          // Nothing after this point depends on the graph having survived.
        }
      }
      pendingBgm = null;
      state.unlocked = false;
      state.bgmPlaying = false;
      state.activeProvider = 'none';
      listeners.clear();
    },
  };
}

/**
 * The build-time audio flag.
 *
 * Phase 10's rollback is "disable audio independently and retain procedural art
 * fallbacks", and that is this flag: it is read once at construction, so a flagged-off
 * build never constructs a context, never arms the gesture gate, and never schedules
 * anything - there is no runtime path that can produce sound with it off. The flag is
 * owned by the infrastructure owner's flag matrix, which now declares `audioEnabled`
 * for Phase 10, so this module reads the typed key directly and the compiler fails the
 * build if the key is ever removed from the flag table.
 */
function isAudioEnabledByFlag(): boolean {
  return FEATURE_FLAGS.audioEnabled;
}

/** The service interface, named so callers can depend on the shape rather than the class. */
export interface AudioManager {
  subscribe(listener: AudioStateChangeListener): () => void;
  getState(): Readonly<AudioManagerState>;
  toggleMusic(): boolean;
  toggleSfx(): boolean;
  setMusicVolume(volume: number): void;
  setSfxVolume(volume: number): void;
  setMuted(muted: boolean): void;
  toggleMuted(): boolean;
  playBgm(track: AudioTrack): void;
  stopBgm(): void;
  playSfx(kind: SfxKind): void;
  applyPreferences(preferences: ResolvedAudioPreferences): void;
  unlock(): void;
  dispose(): void;
}

/**
 * Singleton audio manager instance.
 *
 * Module-level construction is safe now: constructing the manager arms nothing and
 * builds nothing. The gesture gate is created but listeners attach only when a
 * playback request arrives, and the `AudioContext` exists only after `unlock`.
 */
export const audioManager: AudioManager = createAudioManager();

/** React hook-friendly getter for the current audio state */
export function getAudioState(): Readonly<AudioManagerState> {
  return audioManager.getState();
}

/** Re-exported so a caller with a `SfxKind` can check it against the recipe table. */
export const AUDIO_SFX_KIND_IDS: readonly SfxKind[] = SFX_KIND_IDS;

/** Re-exported so a caller with an `AudioTrack` can iterate the track space. */
export const AUDIO_BGM_TRACK_IDS: readonly AudioTrack[] = AUDIO_TRACK_IDS;
