/**
 * Audio manager: the gesture gate, the mix, the two backends, and release.
 *
 * ## What this suite is for
 *
 * Phase 10's audio half has one rule that a code review cannot verify and a comment
 * cannot enforce: **no audio plays before a user gesture.** So the first tests here
 * are mechanical rather than descriptive. They assert on the *absence* of things -
 * no context constructed, no node created, no oscillator started, no timer armed -
 * which is the only form in which "no autoplay" is a fact rather than a claim.
 *
 * The rest of the suite covers the three failure modes a learner would experience
 * rather than read about: a track requested before the gesture (must be remembered,
 * or the route is silent forever), a sound effect requested before the gesture (must
 * be dropped, or the first tap of a session plays a backlog of stale clicks), and a
 * mute applied to already-playing music (must be immediate, or the control feels
 * broken while it is being used).
 *
 * ## Why the fake context is here and not a `vi.mock`
 *
 * The claims under test are about the audio *graph* - that a volume change is a gain
 * assignment rather than a restart, that dispose disconnects every node - so the graph
 * has to be observable. jsdom has no `AudioContext`, and mocking the manager's own
 * methods would test the mock. `tests/unit/support/fakeAudio.ts` records nodes,
 * parameter assignments, and scheduled starts instead.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createAudioManager,
  DEFAULT_AUDIO_PREFERENCES,
  type AudioManager,
  type AudioManagerOptions,
  AUDIO_TRACK_IDS,
  SFX_KIND_IDS,
} from '@/services/audioManager';
import { createAudioGraph } from '@/services/audio/audioGraph';
import { MUSIC_RECIPES, SFX_RECIPES } from '@/services/audio/audioRecipes';
import { createFallbackAudioProvider, type AudioPlaybackProvider } from '@/services/audio/audioProvider';
import { createFileAudioProvider } from '@/services/audio/fileAudioProvider';
import { createProceduralAudioProvider } from '@/services/audio/proceduralAudioProvider';
import {
  clampAudioVolume,
  coerceStoredAudioVolume,
  coerceStoredBoolean,
} from '@/services/audio/audioPreferenceValues';
import { asAudioContext, FakeAudioContext } from './support/fakeAudio';
import { createTestGestureSource, type TestGestureSource } from './support/testAudioGestures';

/**
 * Deliver a gesture the way a learner does.
 *
 * The gate arms only when a playback request arrives, so a test that is *not* about
 * the gate still has to produce one before it can fire. Requesting a sound effect is
 * exactly what a learner does first, so this is a realistic arming rather than a
 * call to the internal unlock hook - which keeps these tests measuring the production
 * path.
 */
function fireGesture(h: { manager: AudioManager; gestures: TestGestureSource }): void {
  h.manager.playSfx('ui-click');
  h.gestures.fire();
}

/** A manager wired to a fake context and a controllable gesture source. */
function harness(
  overrides: Partial<AudioManagerOptions> = {},
): {
  manager: AudioManager;
  context: FakeAudioContext;
  gestures: TestGestureSource;
  graphContexts: number;
} {
  const gestures = createTestGestureSource();
  const built: FakeAudioContext[] = [];
  const manager = createAudioManager({
    gestureSource: gestures,
    createGraph: () => {
      const context = new FakeAudioContext();
      built.push(context);
      return createAudioGraph(asAudioContext(context));
    },
    ...overrides,
  });
  return {
    manager,
    gestures,
    // A getter, not a value: the context does not exist until the gesture fires, and
    // a test that reads `harness().context` before firing is asserting on `undefined`
    // for a reason that is easy to mistake for a broken fake.
    get context(): FakeAudioContext {
      const context = built[0];
      if (context === undefined) throw new Error('no audio context has been created yet');
      return context;
    },
    get graphContexts() {
      return built.length;
    },
  };
}

/**
 * A procedural provider that records which ids it was asked to serve.
 *
 * The fallback assertion has to be made from the *fallback's* side: the file
 * provider returns a placeholder handle synchronously, so "did the fallback run?" is
 * not observable from the manager's return value. Recording the ids the procedural
 * provider received answers it directly.
 */
function spyOnRequests(seen: string[]): AudioPlaybackProvider {
  const provider = createProceduralAudioProvider();
  return {
    ...provider,
    startMusic(sink, assetId) {
      seen.push(assetId);
      return provider.startMusic(sink, assetId);
    },
    startSfx(sink, assetId) {
      seen.push(assetId);
      return provider.startSfx(sink, assetId);
    },
  };
}

describe('audioManager: the no-autoplay guarantee', () => {
  it('constructs no AudioContext before a gesture, even after many requests', () => {
    const built: FakeAudioContext[] = [];
    const gestures = createTestGestureSource();
    const manager = createAudioManager({
      gestureSource: gestures,
      createGraph: () => {
        const context = new FakeAudioContext();
        built.push(context);
        return createAudioGraph(asAudioContext(context));
      },
    });

    // Every entry point a route can reach before the learner has touched anything.
    manager.playSfx('ui-click');
    manager.playSfx('fish-cast');
    manager.playBgm('bgm-dungeon');
    manager.playSfx('ui-hover');
    manager.playBgm('bgm-boss');

    expect(built).toHaveLength(0);
    expect(manager.getState().unlocked).toBe(false);
    expect(manager.getState().bgmPlaying).toBe(false);
  });

  it('drops a sound effect before the gesture instead of queueing it', () => {
    const h = harness();

    h.manager.playSfx('fish-cast');
    expect(h.graphContexts).toBe(0);

    fireGesture(h);
    const after = h.context;

    // The unlock happens on the gesture, but the effect that was requested before
    // it must not be replayed then. This is the assertion that separates "dropped"
    // from "queued", and it is why the first tap of a session does not replay every
    // click the learner made while navigating a cold screen.
    expect(after.oscillators.filter((oscillator) => oscillator.started)).toHaveLength(0);
  });

  it('honours a BGM request made before the gesture once the gesture arrives', () => {
    const h = harness();
    h.manager.playBgm('bgm-village');

    expect(h.manager.getState().currentBgm).toBe('bgm-village');
    expect(h.manager.getState().bgmPlaying).toBe(false);
    expect(h.graphContexts).toBe(0);

    h.gestures.fire();

    const state = h.manager.getState();
    expect(state.unlocked).toBe(true);
    expect(state.bgmPlaying).toBe(true);
    expect(state.activeProvider).toBe('fallback');
    // The pad voices of the village recipe, started: the remembered intent produced
    // real playback rather than a state flag.
    expect(h.context.oscillators.filter((oscillator) => oscillator.started).length).toBeGreaterThan(0);
  });

  it('plays a sound effect requested after the gesture', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playSfx('fish-cast');

    const started = h.context.oscillators.filter((oscillator) => oscillator.started);
    expect(started.length).toBe(SFX_RECIPES['fish-cast']?.length);
  });

  it('removes its gesture listeners once fired', () => {
    const h = harness();
    h.manager.playSfx('ui-click');
    expect(h.gestures.active).toBe(true);

    h.gestures.fire();
    expect(h.gestures.active).toBe(false);
    expect(h.gestures.subscribeCount).toBe(1);
    expect(h.gestures.disposeCount).toBe(1);
  });

  it('arms the gate exactly once no matter how many requests arrive', () => {
    const h = harness();
    h.manager.playSfx('ui-click');
    h.manager.playSfx('ui-hover');
    h.manager.playBgm('bgm-boss');
    expect(h.gestures.subscribeCount).toBe(1);
  });

  it('resumes a suspended context inside the gesture', async () => {
    const h = harness();
    fireGesture(h);
    // Safari hands back a suspended context even inside a gesture; without the
    // resume the learner gets a live graph that never produces a sample.
    expect(h.context.resumeCalls).toBe(1);
    await vi.waitFor(() => expect(h.context.state).toBe('running'));
  });

  it('survives a context that cannot be allocated at all', () => {
    const h = harness({ createGraph: () => null });
    h.manager.playBgm('bgm-dungeon');
    expect(() => h.gestures.fire()).not.toThrow();
    expect(h.manager.getState().unlocked).toBe(false);
    expect(() => h.manager.playSfx('ui-click')).not.toThrow();
    expect(() => h.manager.dispose()).not.toThrow();
  });

  it('survives a context factory that throws', () => {
    const h = harness({
      createGraph: () => {
        throw new Error('no audio device');
      },
    });
    h.manager.playBgm('bgm-dungeon');
    expect(() => h.gestures.fire()).not.toThrow();
    expect(h.manager.getState().bgmPlaying).toBe(false);
  });

  it('produces no sound at all when audio is disabled by the build-time flag', () => {
    const h = harness({ enabled: false });
    h.manager.playSfx('ui-click');
    h.manager.playBgm('bgm-dungeon');
    h.gestures.fire();

    expect(h.graphContexts).toBe(0);
    expect(h.manager.getState().unlocked).toBe(false);
    expect(h.manager.getState().bgmPlaying).toBe(false);
    // Even the explicit test hook cannot bypass the flag: Phase 10's rollback is
    // "disable audio independently", and a route that could reopen it would make
    // the flag untestable as a rollback.
    h.manager.unlock();
    expect(h.graphContexts).toBe(0);
  });
});

describe('audioManager: the mix applies to live playback', () => {
  it('sets a gain value rather than restarting the track when a volume changes', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playBgm('bgm-dungeon');

    const nodesBefore = h.context.nodes.length;
    const oscillatorsBefore = h.context.oscillators.length;

    h.manager.setMusicVolume(0.9);

    // A restart would have created more nodes. A gain assignment creates none.
    expect(h.context.nodes.length).toBe(nodesBefore);
    expect(h.context.oscillators.length).toBe(oscillatorsBefore);
    expect(h.manager.getState().musicVolume).toBe(0.9);

    // And the value reached the graph rather than only the state object: the bus
    // gains are the first three nodes the graph creates.
    const [masterGain, musicGain, sfxGain] = h.context.gains;
    expect(masterGain?.gain.value).toBe(1);
    expect(musicGain?.gain.value).toBe(0.9);
    expect(sfxGain?.gain.value).toBe(DEFAULT_AUDIO_PREFERENCES.sfxVolume);
  });

  it('drives the master node to zero on mute and restores the buses on unmute', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playBgm('bgm-village');
    h.manager.setMusicVolume(0.2);
    h.manager.setSfxVolume(0.7);

    const [masterGain, musicGain, sfxGain] = h.context.gains;
    h.manager.setMuted(true);
    expect(masterGain?.gain.value).toBe(0);
    // The buses are untouched, which is what makes unmute lossless.
    expect(musicGain?.gain.value).toBe(0.2);
    expect(sfxGain?.gain.value).toBe(0.7);

    h.manager.setMuted(false);
    expect(masterGain?.gain.value).toBe(1);
    expect(musicGain?.gain.value).toBe(0.2);
    expect(sfxGain?.gain.value).toBe(0.7);
  });

  it('clamps a live volume into 0..1 and rejects a non-finite one', () => {
    const h = harness();
    h.manager.setMusicVolume(4);
    expect(h.manager.getState().musicVolume).toBe(1);
    h.manager.setSfxVolume(-2);
    expect(h.manager.getState().sfxVolume).toBe(0);
    h.manager.setMusicVolume(Number.NaN);
    expect(h.manager.getState().musicVolume).toBe(DEFAULT_AUDIO_PREFERENCES.musicVolume);
    h.manager.setMusicVolume(Number.POSITIVE_INFINITY);
    expect(h.manager.getState().musicVolume).toBe(DEFAULT_AUDIO_PREFERENCES.musicVolume);
  });

  it('silences already-playing BGM the moment mute is applied', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playBgm('bgm-boss');
    expect(h.manager.getState().bgmPlaying).toBe(true);

    h.manager.setMuted(true);

    // Still playing, at zero: the track is not stopped, so unmuting restores it from
    // where it was rather than restarting it from the top.
    expect(h.manager.getState().bgmPlaying).toBe(true);
    expect(h.manager.getState().muted).toBe(true);
    const runningOscillators = h.context.oscillators.filter((oscillator) => !oscillator.stopped);
    expect(runningOscillators.length).toBeGreaterThan(0);
  });

  it('toggles mute and reports the new value', () => {
    const h = harness();
    expect(h.manager.toggleMuted()).toBe(true);
    expect(h.manager.getState().muted).toBe(true);
    expect(h.manager.toggleMuted()).toBe(false);
  });

  it('keeps mute distinct from the per-bus enabled toggles', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playBgm('bgm-village');
    h.manager.setMusicVolume(0.25);

    h.manager.toggleMusic();

    // Muting and disabling music are different questions, and conflating them loses
    // a preference: the volume the learner chose must survive both.
    expect(h.manager.getState().musicEnabled).toBe(false);
    expect(h.manager.getState().musicVolume).toBe(0.25);
    expect(h.manager.getState().bgmPlaying).toBe(false);

    h.manager.toggleMusic();
    expect(h.manager.getState().bgmPlaying).toBe(true);
    expect(h.manager.getState().musicVolume).toBe(0.25);
  });

  it('applies a resolved preference payload to the live mix', () => {
    const h = harness();
    fireGesture(h);
    h.manager.applyPreferences({
      musicVolume: 0.1,
      sfxVolume: 0.2,
      muted: true,
      musicEnabled: true,
      sfxEnabled: false,
    });

    const state = h.manager.getState();
    expect(state.musicVolume).toBe(0.1);
    expect(state.sfxVolume).toBe(0.2);
    expect(state.muted).toBe(true);
    expect(state.sfxEnabled).toBe(false);
    // A disabled SFX bus is honoured from hydration, before any effect is requested.
    h.manager.playSfx('ui-click');
    expect(h.context.oscillators.filter((oscillator) => oscillator.started)).toHaveLength(0);
  });

  it('stops music when hydration disables it', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playBgm('bgm-dungeon');
    expect(h.manager.getState().bgmPlaying).toBe(true);

    h.manager.applyPreferences({
      musicVolume: 0.4,
      sfxVolume: 0.6,
      muted: false,
      musicEnabled: false,
      sfxEnabled: true,
    });

    expect(h.manager.getState().bgmPlaying).toBe(false);
  });

  it('publishes every change to subscribers', () => {
    const h = harness();
    const seen: boolean[] = [];
    const unsubscribe = h.manager.subscribe((state) => seen.push(state.muted));
    h.manager.setMuted(true);
    h.manager.toggleSfx();
    unsubscribe();
    h.manager.setMuted(false);
    expect(seen).toEqual([true, true]);
  });

  it('hands out a copy, so a subscriber cannot rewrite the live state', () => {
    const h = harness();
    // `getState` returns a fresh object each call, so the copy a caller holds is not
    // the object the manager mutates. Asserted through a cast because the type is
    // `Readonly`, and the defect being guarded against is exactly a caller ignoring
    // that - a cast is the honest way to reproduce the mistake.
    const snapshot = h.manager.getState() as { muted: boolean };
    snapshot.muted = true;
    expect(h.manager.getState().muted).toBe(false);
  });
});

describe('audioManager: the two backends', () => {
  it('serves every id from the procedural recipes', () => {
    const h = harness();
    fireGesture(h);
    for (const kind of SFX_KIND_IDS) h.manager.playSfx(kind);
    for (const track of AUDIO_TRACK_IDS) h.manager.playBgm(track);

    // One oscillator minimum per effect, and a pad for each track that was asked for
    // in turn. The last track is the only one still running.
    const started = h.context.oscillators.filter((oscillator) => oscillator.started).length;
    const expectedEffects = SFX_KIND_IDS.reduce((sum, kind) => sum + (SFX_RECIPES[kind]?.length ?? 0), 0);
    expect(started).toBeGreaterThanOrEqual(expectedEffects);
  });

  it('falls back to procedural when the resolver has no entry for an id', async () => {
    const h = harness({
      // A resolver that knows nothing - the current CC0 registry state, exactly.
      resolveAssetUrl: () => null,
    });
    fireGesture(h);
    h.manager.playSfx('fish-catch');
    expect(h.context.oscillators.filter((oscillator) => oscillator.started)).toHaveLength(
      SFX_RECIPES['fish-catch']?.length ?? 0,
    );
    await Promise.resolve();
  });

  it('falls back to procedural when a registered file cannot be loaded', async () => {
    const seen: string[] = [];
    const spyProvider = spyOnRequests(seen);
    const context = new FakeAudioContext();
    const manager = createAudioManager({
      gestureSource: createTestGestureSource(),
      createGraph: () => createAudioGraph(asAudioContext(context)),
      resolveAssetUrl: () => '/assets/audio/fish-catch.ogg',
      createProvider: (procedural) =>
        createFallbackAudioProvider(
          createFileAudioProvider({
            fallback: spyProvider,
            resolveAssetUrl: () => '/assets/audio/fish-catch.ogg',
            // The file is registered but the bytes are not there. This is the defect
            // the fallback exists for: a route must not break because an optional
            // asset is missing.
            loadAssetBytes: async () => {
              throw new Error('404');
            },
          }),
          procedural,
        ),
    });

    manager.unlock();
    expect(() => manager.playSfx('fish-catch')).not.toThrow();

    // Synchronously: the fallback has not run yet, because the load is still in
    // flight. A learner hears the splash one decode later rather than not at all.
    expect(seen).toEqual([]);
    // After the load fails, the procedural recipe runs from the audio callback.
    await vi.waitFor(() => expect(seen).toEqual(['fish-catch']));
    expect(context.oscillators.filter((oscillator) => oscillator.started).length).toBe(
      SFX_RECIPES['fish-catch']?.length ?? 0,
    );
    manager.dispose();
  });

  it('plays a loaded buffer when the decode succeeds, with no procedural fallback', async () => {
    const context = new FakeAudioContext();
    const seen: string[] = [];
    const spyProvider = spyOnRequests(seen);
    const manager = createAudioManager({
      gestureSource: createTestGestureSource(),
      createGraph: () => createAudioGraph(asAudioContext(context)),
      resolveAssetUrl: () => '/assets/audio/fish-catch.ogg',
      createProvider: (procedural) =>
        createFallbackAudioProvider(
          createFileAudioProvider({
            fallback: spyProvider,
            resolveAssetUrl: () => '/assets/audio/fish-catch.ogg',
            loadAssetBytes: async () => new ArrayBuffer(8),
          }),
          procedural,
        ),
    });

    manager.unlock();
    manager.playSfx('fish-catch');

    await vi.waitFor(() =>
      expect(context.bufferSources.filter((source) => source.started)).toHaveLength(1),
    );
    // The registered file served the request, so the procedural provider was never
    // asked - which is what "the file backend takes over" means in practice.
    expect(seen).toEqual([]);
    expect(context.oscillators.filter((oscillator) => oscillator.started)).toHaveLength(0);
    manager.dispose();
  });

  it('never throws into the caller when a decode fails', async () => {
    const context = new FakeAudioContext();
    context.decodeResult = null;
    const manager = createAudioManager({
      gestureSource: createTestGestureSource(),
      createGraph: () => createAudioGraph(asAudioContext(context)),
      resolveAssetUrl: () => '/assets/audio/fish-catch.ogg',
      createProvider: (procedural) =>
        createFallbackAudioProvider(
          createFileAudioProvider({
            fallback: createProceduralAudioProvider(),
            resolveAssetUrl: () => '/assets/audio/fish-catch.ogg',
            loadAssetBytes: async () => new ArrayBuffer(8),
          }),
          procedural,
        ),
    });

    manager.unlock();
    manager.playSfx('fish-catch');
    // A rejected decode resolves from a promise the manager never holds, so it cannot
    // become an unhandled rejection that a test runner or an error reporter sees.
    await vi.waitFor(() =>
      expect(context.oscillators.filter((oscillator) => oscillator.started).length).toBe(
        SFX_RECIPES['fish-catch']?.length ?? 0,
      ),
    );
    manager.dispose();
  });

  it('reports no active provider before the first request', () => {
    const h = harness();
    expect(h.manager.getState().activeProvider).toBe('none');
    fireGesture(h);
    h.manager.playSfx('ui-click');
    expect(h.manager.getState().activeProvider).toBe('fallback');
  });
});

describe('audioManager: release', () => {
  it('disconnects every node and closes the context on dispose', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playBgm('bgm-village');
    h.manager.playSfx('fish-splash');

    expect(h.context.liveConnections.length).toBeGreaterThan(0);

    h.manager.dispose();

    expect(h.context.liveConnections).toHaveLength(0);
    expect(h.context.closed).toBe(1);
    expect(h.context.oscillators.every((oscillator) => oscillator.stopped)).toBe(true);
  });

  it('is safe to call twice', () => {
    const h = harness();
    fireGesture(h);
    h.manager.playBgm('bgm-village');
    h.manager.dispose();

    expect(() => h.manager.dispose()).not.toThrow();
    // Not "safe" as in ignored: the second call must not close a second time, which
    // would be a second teardown of an already-released graph.
    expect(h.context.closed).toBe(1);
  });

  it('removes gesture listeners on dispose, before any gesture', () => {
    const gestures = createTestGestureSource();
    const manager = createAudioManager({
      gestureSource: gestures,
      createGraph: () => createAudioGraph(asAudioContext(new FakeAudioContext())),
    });
    manager.playBgm('bgm-dungeon');
    expect(gestures.active).toBe(true);

    manager.dispose();
    expect(gestures.active).toBe(false);
    expect(gestures.disposeCount).toBe(1);
    // Disposing twice must not attempt a second removal, which on the real window
    // source would be a removeEventListener for a handler already gone.
    manager.dispose();
    expect(gestures.disposeCount).toBe(1);
  });

  it('clears the music figure timer on stop, so no step lands after the stop', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      fireGesture(h);
      h.manager.playBgm('bgm-village');
      const atStart = h.context.oscillators.length;
      expect(atStart).toBeGreaterThan(0);

      // Let one figure step land first, so the timer is demonstrably live before it
      // is stopped. A test that only asserted "no new oscillators after the stop"
      // would pass against a provider that never scheduled anything at all.
      vi.advanceTimersByTime(
        (MUSIC_RECIPES['bgm-village']?.figureIntervalSeconds ?? 1) * 1000 + 1,
      );
      expect(h.context.oscillators.length).toBeGreaterThan(atStart);
      const startedBeforeStop = h.context.oscillators.length;

      h.manager.stopBgm();
      const startedAtStop = h.context.oscillators.length;
      // Advance well past several figure intervals. A timer that survived the stop
      // would keep creating oscillators into a graph that is no longer playing.
      vi.advanceTimersByTime(10_000);

      expect(h.context.oscillators.length).toBe(startedAtStop);
      expect(startedAtStop).toBeGreaterThan(startedBeforeStop - 2);
      expect(h.manager.getState().bgmPlaying).toBe(false);
      h.manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the music figure timer on dispose', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      fireGesture(h);
      h.manager.playBgm('bgm-boss');
      h.manager.dispose();
      const atDispose = h.context.oscillators.length;

      vi.advanceTimersByTime(10_000);
      expect(h.context.oscillators.length).toBe(atDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending track rather than starting it after a stop', () => {
    const h = harness();
    h.manager.playBgm('bgm-village');
    // A route that requests a track and immediately unmounts.
    h.manager.stopBgm();
    fireGesture(h);

    expect(h.manager.getState().currentBgm).toBeNull();
    expect(h.manager.getState().bgmPlaying).toBe(false);
    expect(h.context.oscillators.filter((oscillator) => oscillator.started)).toHaveLength(0);
  });

  it('produces nothing after dispose', () => {
    const h = harness();
    fireGesture(h);
    h.manager.dispose();

    expect(() => h.manager.playBgm('bgm-dungeon')).not.toThrow();
    expect(() => h.manager.playSfx('ui-click')).not.toThrow();
    expect(h.manager.getState().bgmPlaying).toBe(false);
    expect(h.manager.getState().unlocked).toBe(false);
  });
});

describe('audio recipes', () => {
  it('covers every effect id with a distinct recipe', () => {
    expect(Object.keys(SFX_RECIPES).sort()).toEqual([...SFX_KIND_IDS].sort());
    // Distinct because a shared recipe would make the ids cosmetic: a learner who
    // hears the same click for a correct catch and for a miss learns nothing from
    // the sound, which is the only channel available before the result renders.
    const shapes = SFX_KIND_IDS.map((kind) =>
      JSON.stringify(SFX_RECIPES[kind]?.map((voice) => [voice.waveform, voice.startHz, voice.endHz])),
    );
    expect(new Set(shapes).size).toBe(SFX_KIND_IDS.length);
  });

  it('covers every track id with a recipe that has a pad and a figure', () => {
    expect(Object.keys(MUSIC_RECIPES).sort()).toEqual([...AUDIO_TRACK_IDS].sort());
    for (const track of AUDIO_TRACK_IDS) {
      const recipe = MUSIC_RECIPES[track];
      expect(recipe?.padVoices.length ?? 0).toBeGreaterThan(0);
      expect(recipe?.figureHz.length ?? 0).toBeGreaterThan(0);
      expect(recipe?.figureIntervalSeconds ?? 0).toBeGreaterThan(0);
    }
  });

  it('keeps every frequency positive so a glide never targets zero', () => {
    // `exponentialRampToValueAtTime` throws on a zero target, so a recipe that ends
    // at zero would fail at schedule time - in a route, during gameplay.
    for (const [kind, voices] of Object.entries(SFX_RECIPES)) {
      for (const voice of voices) {
        expect(`${kind}:${voice.startHz}`).not.toContain('NaN');
        expect(voice.startHz).toBeGreaterThan(0);
        expect(voice.endHz).toBeGreaterThan(0);
        expect(voice.durationSeconds).toBeGreaterThan(0);
        expect(voice.peak).toBeGreaterThan(0);
        expect(voice.peak).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('audio preference value rules', () => {
  it('clamps a live volume but defaults a non-finite one', () => {
    expect(clampAudioVolume(0.5, 0.4)).toBe(0.5);
    expect(clampAudioVolume(-1, 0.4)).toBe(0);
    expect(clampAudioVolume(9, 0.4)).toBe(1);
    expect(clampAudioVolume(Number.NaN, 0.4)).toBe(0.4);
  });

  it('defaults a hostile stored volume rather than guessing', () => {
    // Each of these is a value `localStorage` can hold that no version of this build
    // writes. Guessing is worse than defaulting: a clamped `1e9` would be a bus
    // pinned at full volume with a slider that appears broken.
    expect(coerceStoredAudioVolume('0.4', 0.4)).toBe(0.4);
    expect(coerceStoredAudioVolume(null, 0.4)).toBe(0.4);
    expect(coerceStoredAudioVolume(Number.NaN, 0.4)).toBe(0.4);
    expect(coerceStoredAudioVolume(1e9, 0.4)).toBe(0.4);
    expect(coerceStoredAudioVolume(-0.5, 0.4)).toBe(0.4);
    expect(coerceStoredAudioVolume(true, 0.4)).toBe(0.4);
    expect(coerceStoredAudioVolume(0.25, 0.4)).toBe(0.25);
  });

  it('defaults a hostile stored boolean rather than negating a string', () => {
    expect(coerceStoredBoolean('false', true)).toBe(true);
    expect(coerceStoredBoolean(0, true)).toBe(true);
    expect(coerceStoredBoolean(false, true)).toBe(false);
    expect(coerceStoredBoolean(true, false)).toBe(true);
  });
});
