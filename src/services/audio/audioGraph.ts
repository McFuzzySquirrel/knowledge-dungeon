/**
 * The audio graph: one `AudioContext`, three gain nodes, and the mix policy.
 *
 * ## Why the graph is built only after a gesture
 *
 * Constructing an `AudioContext` is not a free act. Browsers create a real audio
 * device backend for it, and a context created before any user gesture starts in
 * `suspended` state and, on some platforms, logs a console warning the moment
 * anything is connected to it. Phase 10's non-goals say "no autoplay", and the
 * mechanical form of that rule is narrower than "do not play anything": this
 * module has no way to build a graph without a context, so the whole graph -
 * context, master, and both buses - is created inside one call that only the
 * gesture gate makes. `tests/unit/audioManager.test.ts` asserts that a `playSfx`
 * before any gesture constructs no context and creates no node, which is the
 * only assertion that survives a future refactor that "helpfully" hoists graph
 * construction into the manager constructor.
 *
 * ## Why three gain nodes and not two
 *
 * `master` exists for mute, and it is the only node that may be set to zero
 * without remembering anything about buses. Muting is a different question from
 * "the music slider is at zero": one is a global kill switch that must silence
 * already-playing BGM on the next audio frame, the other is a level. Putting
 * mute on its own node means `setMuted` is a single assignment and cannot
 * disturb a learner's chosen volumes, so unmuting restores exactly what was
 * there. Folding mute into both buses would have made mute lossy - the volumes
 * would have to be cached and rewritten, and any write that lost the cache would
 * have silently reset a preference.
 *
 * `music` and `sfx` are separate buses because the legacy callers already treat
 * them as independent: `toggleMusic` can stop a track while sound effects keep
 * firing, and a volume change has to reach *live* playback as a gain value rather
 * than a restart, which is only possible because the level lives in a node the
 * running voices are already connected to.
 *
 * Renderer-neutral by construction: Web Audio is a browser platform API that
 * predates every engine in this repository, not a rendering engine. Nothing here
 * imports `pixi.js` or `phaser`, and the module is deliberately free of any
 * dependency on the game layer so a Pixi world, a DOM screen, or a test can all
 * drive it.
 */

/** The buses a request can be routed to. */
export type AudioBusName = 'music' | 'sfx';

/**
 * A live gain value applied by {@link applyAudioMix}.
 *
 * Volumes are resolved numbers by the time they arrive here; the store owns
 * clamping and coercion, so this module never has to reason about a hostile
 * stored value reaching an `AudioParam`.
 */
export interface AudioMix {
  readonly musicVolume: number;
  readonly sfxVolume: number;
  readonly muted: boolean;
}

/** The nodes a backend plays through, plus the context that scheduled it. */
export interface AudioSink {
  readonly context: AudioContext;
  /** The bus gain node. A backend connects its voices here and nowhere else. */
  readonly busGain: GainNode;
  /** Seconds elapsed on the context clock, the only clock a voice may schedule on. */
  now(): number;
}

/**
 * A running voice set a caller can silence.
 *
 * `stop` is required to be idempotent and required to release every node it
 * started, because a caller can stop the same handle twice (a route unmount
 * after an explicit `stopBgm`) and because a stopped handle that left oscillators
 * connected is exactly the leak Phase 10's exit criterion names.
 */
export interface AudioPlaybackHandle {
  stop(fadeSeconds?: number): void;
}

/**
 * The built graph.
 *
 * Every field is created once, in {@link createAudioGraph}, and every voice a
 * backend starts is connected to exactly one bus. `dispose` is total and
 * idempotent: it disconnects the buses, closes the context, and tolerates a
 * context whose `close()` already rejected.
 */
export interface AudioGraph {
  readonly context: AudioContext;
  readonly masterGain: GainNode;
  readonly musicGain: GainNode;
  readonly sfxGain: GainNode;
  sink(bus: AudioBusName): AudioSink;
  applyMix(mix: AudioMix): void;
  dispose(): void;
}

interface AudioContextConstructorLike {
  new (options?: AudioContextOptions): AudioContext;
}

type AudioContextWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextConstructorLike;
  };

/**
 * Construct an `AudioContext`, or report that this environment has none.
 *
 * `null` is a supported outcome, not a failure: a Node-side unit test, an old
 * browser, and a locked-down embedded webview all reach the audio service and
 * must get silence rather than a thrown `ReferenceError` from a route handler.
 * The webkit-prefixed fallback is read from the global rather than referenced
 * directly, so a runtime that does not define the property does not fail to
 * parse.
 */
export function createDefaultAudioContext(): AudioContext | null {
  const scope = globalThis as unknown as AudioContextWindow;
  const Constructor =
    (scope as { AudioContext?: AudioContextConstructorLike }).AudioContext ??
    scope.webkitAudioContext;
  if (typeof Constructor !== 'function') return null;
  try {
    return new Constructor();
  } catch {
    // A browser that refuses to allocate an audio device is the same case as a
    // browser that has no Web Audio: the caller degrades to a silent no-op.
    return null;
  }
}

/**
 * Build the graph on an existing context.
 *
 * The caller owns the decision to have a context at all - in this repository
 * that is the gesture gate - so this function takes one and only wires nodes.
 */
export function createAudioGraph(context: AudioContext): AudioGraph {
  const masterGain = context.createGain();
  const musicGain = context.createGain();
  const sfxGain = context.createGain();
  masterGain.gain.value = 1;
  musicGain.gain.value = 0.4;
  sfxGain.gain.value = 0.6;
  musicGain.connect(masterGain);
  sfxGain.connect(masterGain);
  masterGain.connect(context.destination);

  let disposed = false;

  return {
    context,
    masterGain,
    musicGain,
    sfxGain,
    sink(bus: AudioBusName): AudioSink {
      return {
        context,
        busGain: bus === 'music' ? musicGain : sfxGain,
        now: () => context.currentTime,
      };
    },
    applyMix(mix: AudioMix): void {
      if (disposed) return;
      // Assigned, not ramped. A volume slider the learner just moved has to be
      // audible on the next audio frame, and a ramp would leave the previous value
      // audible for its duration - which for a "silence this now" mute control
      // reads as the control not working.
      masterGain.gain.value = mix.muted ? 0 : 1;
      musicGain.gain.value = mix.musicVolume;
      sfxGain.gain.value = mix.sfxVolume;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Disconnect before close: `close()` stops the audio thread, but a node
      // left connected to a closed context is still a live reference the GC has
      // to walk, and this is the line that makes "released correctly" true rather
      // than merely likely.
      for (const node of [masterGain, musicGain, sfxGain]) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected. Idempotent disposal must not throw.
        }
      }
      try {
        // A context closed by the browser (tab discarded) rejects here, and a
        // teardown path that rejects strands the caller's `await`.
        void context.close?.();
      } catch {
        // Same reasoning as above.
      }
    },
  };
}
