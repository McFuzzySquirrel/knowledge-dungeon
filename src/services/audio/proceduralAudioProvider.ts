/**
 * The procedural backend: real Web Audio synthesis, one recipe per id.
 *
 * ## What "procedural" means here
 *
 * `OscillatorNode` plus a `GainNode` envelope, scheduled on the context clock.
 * There is no sample data, no `fetch`, and no `decodeAudioData`, which is what
 * makes the Phase 8 registry class `procedural` truthful: the waveform is produced
 * by this committed code, so no third-party licence attaches to it. It is also why
 * this provider is the shipped default - see `audioProvider.ts` for why loading a
 * media file today would have been the dishonest option.
 *
 * ## Why the recipes are data and not code
 *
 * Every id's sound is a row in `MUSIC_RECIPES` or `SFX_RECIPES` rather than a
 * branch in a function. Two reasons: the alternative was seventeen `if` arms where
 * a missing arm is silent and a mis-ordered arm is a wrong sound nobody can
 * diagnose, and the alternative meant a test could only assert "something was
 * scheduled", not which recipe ran. With the table separated out,
 * `tests/unit/audioManager.test.ts` can pin the id space against the recipes, and a
 * phase that adds an id gets a compile error rather than a silent no-op.
 *
 * ## Why music is a pad plus a figure
 *
 * A looped oscillator with no modulation is a held test tone, which is genuinely
 * unpleasant over a study session - the exact length of time this music plays
 * for. So each track is four detuned pad voices under a slow amplitude LFO, plus a
 * cycled pitch figure scheduled one step at a time. It is a loop, it is generated
 * rather than authored, and there is no bar structure for anyone to have to
 * compose: the figure is a table of frequencies and a step time.
 *
 * ## Why the figure is scheduled by a timer rather than by a node
 *
 * A `setInterval` is the only way to cycle a list of pitches without a script
 * processor or a pre-rendered buffer, and it comes with an obligation: the timer
 * must be cleared on `stop` and on `dispose`, and a stopped track must not have a
 * pending step land afterwards. Both are handled by a generation counter, which is
 * also what makes a stop idempotent - a stale callback finds a generation that is
 * no longer current and returns without touching the graph. That is the class of
 * bug Phase 10's "Pixi textures and audio resources are released correctly" exit
 * criterion exists to catch: music that keeps scheduling into a closed context.
 */

/** Node handles this provider must be able to release. */
interface VoiceHandle {
  readonly oscillator: OscillatorNode;
  readonly gain: GainNode;
}

import { MUSIC_RECIPES, SFX_RECIPES, type MusicRecipe, type SfxVoice } from './audioRecipes';
import type { AudioPlaybackHandle, AudioSink } from './audioGraph';
import type { AudioPlaybackProvider } from './audioProvider';

/** A live voice set, plus the timer that keeps a track's figure moving. */
interface ActiveMusic {
  readonly oscillators: readonly VoiceHandle[];
  readonly lfo: OscillatorNode | null;
  readonly lfoGain: GainNode | null;
  readonly masterGain: GainNode;
  /**
   * Assigned after construction because the timer callback closes over `entry`, and
   * `entry` has to exist before the timer does. Mutable for that reason alone.
   */
  figureTimer: ReturnType<typeof setInterval> | null;
}

function isMusicId(assetId: string): assetId is keyof typeof MUSIC_RECIPES {
  return Object.prototype.hasOwnProperty.call(MUSIC_RECIPES, assetId);
}

function isSfxId(assetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SFX_RECIPES, assetId);
}

function disconnectQuietly(node: { disconnect(): void }): void {
  try {
    node.disconnect();
  } catch {
    // Already disconnected or never connected. Releasing audio must not throw
    // into a route handler, which is the caller's real contract here.
  }
}

export function createProceduralAudioProvider(): AudioPlaybackProvider {
  let disposed = false;
  // Monotonic. Every started voice records the value in force when it started;
  // a callback or a stop that finds a stale value knows its work is void.
  let generation = 0;
  let activeMusic: ActiveMusic | null = null;
  let figureIndex = 0;
  // Every one-shot voice that has not ended yet.
  //
  // Tracked rather than left to the garbage collector because a stopped oscillator
  // that is still connected to a bus is still reachable from that bus, and because
  // `dispose()` has to be *total*: a learner who plays a sound effect and then closes
  // a route must not leave a connected voice behind. The set is what makes the
  // release assertion in `tests/unit/audioManager.test.ts` about a live node count
  // rather than about a hope.
  const liveOneShots = new Set<VoiceHandle>();

  function stopActiveMusic(fadeSeconds = 0): void {
    const current = activeMusic;
    activeMusic = null;
    if (current === null) return;
    generation += 1;
    if (current.figureTimer !== null) {
      clearInterval(current.figureTimer);
    }
    const endAt = current.masterGain.gain.value > 0 ? fadeSeconds : 0;
    for (const voice of current.oscillators) {
      if (endAt > 0) {
        try {
          voice.gain.gain.setTargetAtTime(0, voice.gain.gain.value, endAt / 3);
        } catch {
          // A context that has already stopped will not accept automation; the
          // node is being released anyway.
        }
      }
      try {
        voice.oscillator.stop();
      } catch {
        // Stopping an oscillator twice throws; a double `stopBgm` is a real call
        // pattern, so this is expected rather than exceptional.
      }
      disconnectQuietly(voice.gain);
      disconnectQuietly(voice.oscillator);
    }
    if (current.lfo !== null && current.lfoGain !== null) {
      try {
        current.lfo.stop();
      } catch {
        // Same reasoning as above.
      }
      disconnectQuietly(current.lfoGain);
      disconnectQuietly(current.lfo);
    }
    disconnectQuietly(current.masterGain);
  }

  function startMusic(sink: AudioSink, assetId: string): AudioPlaybackHandle | null {
    if (disposed || !isMusicId(assetId)) return null;
    const recipe: MusicRecipe = MUSIC_RECIPES[assetId];
    if (recipe === undefined) return null;
    // Replacing a track stops the old one first, so two tracks can never
    // overlap on the bus even if a route calls `playBgm` twice in a row.
    stopActiveMusic();

    const { context } = sink;
    const started = generation + 1;
    generation = started;
    const now = sink.now();

    const masterGain = context.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(sink.busGain);

    const oscillators: VoiceHandle[] = [];
    for (const pad of recipe.padVoices) {
      const oscillator = context.createOscillator();
      oscillator.type = pad.waveform;
      oscillator.frequency.value = pad.frequencyHz;
      if (pad.detuneCents !== 0) oscillator.detune.value = pad.detuneCents;
      const gain = context.createGain();
      gain.gain.value = pad.peak;
      oscillator.connect(gain);
      gain.connect(masterGain);
      oscillator.start(now);
      oscillators.push({ oscillator, gain });
    }

    let lfo: OscillatorNode | null = null;
    let lfoGain: GainNode | null = null;
    if (recipe.lfoHz > 0 && recipe.lfoDepth > 0) {
      lfo = context.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = recipe.lfoHz;
      lfoGain = context.createGain();
      // Depth is relative to the pad's own peak, and the LFO modulates the master
      // gain rather than each pad, so the drift costs one node instead of four.
      lfoGain.gain.value = recipe.lfoDepth;
      lfo.connect(lfoGain);
      lfoGain.connect(masterGain.gain);
      lfo.start(now);
    }

    const entry: ActiveMusic = {
      oscillators,
      lfo,
      lfoGain,
      masterGain,
      figureTimer: null,
    };
    activeMusic = entry;

    function playFigureStep(): void {
      // The generation check is the whole safety argument for the timer: a step
      // that was already queued when the track stopped must not schedule into a
      // graph that has been released.
      if (disposed || generation !== started || activeMusic !== entry) return;
      const pitch = recipe.figureHz[figureIndex % recipe.figureHz.length];
      figureIndex += 1;
      if (pitch === undefined) return;
      const at = sink.now();
      const stepGain = context.createGain();
      stepGain.connect(masterGain);
      // A percussive envelope: rise to the peak immediately, then fall to silence
      // over the step's own length so the next step never overlaps audibly.
      stepGain.gain.setValueAtTime(0, at);
      stepGain.gain.linearRampToValueAtTime(recipe.figurePeak, at + 0.02);
      stepGain.gain.linearRampToValueAtTime(0, at + recipe.figureSeconds);
      const step = context.createOscillator();
      step.type = recipe.figureWaveform;
      step.frequency.value = pitch;
      step.connect(stepGain);
      step.start(at);
      step.stop(at + recipe.figureSeconds + 0.02);
      // Released when the step has ended, so a track playing for an hour does not
      // accumulate one pair of nodes per step.
      step.onended = () => {
        disconnectQuietly(stepGain);
        disconnectQuietly(step);
      };
    }

    entry.figureTimer = setInterval(playFigureStep, recipe.figureIntervalSeconds * 1000);

    return {
      stop(fadeSeconds = 0.05): void {
        if (generation !== started) return;
        stopActiveMusic(fadeSeconds);
      },
    };
  }

  function playSfx(sink: AudioSink, assetId: string): AudioPlaybackHandle | null {
    if (disposed || !isSfxId(assetId)) return null;
    const voices: readonly SfxVoice[] = SFX_RECIPES[assetId];
    if (voices === undefined || voices.length === 0) return null;
    const { context } = sink;
    const started = generation + 1;
    generation = started;
    const base = sink.now();
    const created: VoiceHandle[] = [];
    const release = (voice: VoiceHandle): void => {
      liveOneShots.delete(voice);
      disconnectQuietly(voice.gain);
      disconnectQuietly(voice.oscillator);
    };

    for (const recipe of voices) {
      const at = base + recipe.offsetSeconds;
      const oscillator = context.createOscillator();
      oscillator.type = recipe.waveform;
      oscillator.frequency.setValueAtTime(Math.max(1, recipe.startHz), at);
      if (recipe.endHz !== recipe.startHz) {
        // `exponentialRampToValueAtTime` cannot reach zero, so the target is
        // clamped. Every shipped recipe ends above 20 Hz, and the clamp exists so
        // a future one cannot turn a glide into an exception at schedule time.
        oscillator.frequency.exponentialRampToValueAtTime(
          Math.max(1, recipe.endHz),
          at + recipe.durationSeconds,
        );
      }
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      if (recipe.attackSeconds > 0) {
        gain.gain.linearRampToValueAtTime(recipe.peak, at + recipe.attackSeconds);
      } else {
        gain.gain.linearRampToValueAtTime(recipe.peak, at + 0.005);
      }
      // Linear rather than exponential: a linear ramp to exactly 0 is legal on
      // every engine, and an exponential ramp to 0 throws in some.
      gain.gain.linearRampToValueAtTime(0, at + recipe.durationSeconds);
      oscillator.connect(gain);
      gain.connect(sink.busGain);
      oscillator.start(at);
      oscillator.stop(at + recipe.durationSeconds + 0.02);
      const voice: VoiceHandle = { oscillator, gain };
      oscillator.onended = () => release(voice);
      created.push(voice);
      liveOneShots.add(voice);
    }

    return {
      stop(): void {
        if (generation !== started) return;
        for (const voice of created) {
          try {
            voice.oscillator.stop();
          } catch {
            // Already stopped by its own scheduled stop.
          }
          release(voice);
        }
      },
    };
  }

  return {
    id: 'procedural',
    provenance: 'procedural',
    startMusic,
    startSfx: playSfx,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopActiveMusic();
      for (const voice of [...liveOneShots]) {
        try {
          voice.oscillator.stop();
        } catch {
          // Already stopped by its own scheduled stop.
        }
        disconnectQuietly(voice.gain);
        disconnectQuietly(voice.oscillator);
      }
      liveOneShots.clear();
    },
  };
}
