/**
 * The file-backed backend, and the seam a future CC0 audio bundle plugs into.
 *
 * ## Why this exists with nothing behind it
 *
 * Phase 10's non-goals forbid shipping an unlicensed or unverified media file, and
 * the CC0 registry has no `cc0-approved` entry to load. So this provider ships with
 * an **empty resolver** and plays nothing: every id falls through to the procedural
 * provider, and the app behaves exactly as if this file did not exist. It is not
 * dead code, though - it is the half of the design that makes the procedural backend
 * a *fallback* rather than a *temporary hack*.
 *
 * The reason to write it now, before there is anything to load, is that the
 * alternative is a service with one hard-coded way to make sound. Later phases
 * (11, 13, 17, 20) need world-specific SFX and real music, and they need it
 * *without* touching this service's public surface, so the resolver, the decode, and
 * the failure path all have to exist as a contract before the first real file
 * arrives - otherwise the first file is what defines them.
 *
 * ## Why this module contains no `fetch` at all
 *
 * The loader is injected and has **no default**, and that is the most important
 * decision in the file. A default would have been four lines and would have put a
 * network call inside the audio service, which is the wrong owner: the asset bundle
 * service in `src/renderers/pixi/assets/` already owns "load a same-origin asset",
 * already enforces bundle membership, and is already covered by the privacy gates
 * that enumerate every call site in the application graph. Duplicating a fetch here
 * would mean a second place for an off-origin URL to enter from, and a second place
 * to keep in step with those gates.
 *
 * It also makes the CC0 rule structural rather than procedural. This module asks the
 * resolver for a URL and refuses anything that is not same-origin-relative *before*
 * asking for bytes, and the injected loader is the asset service's, so the byte a
 * note plays came from a bundle membership check rather than from a URL a string in
 * this file happened to contain.
 *
 * ## Why loading is asynchronous but the contract is synchronous
 *
 * {@link AudioPlaybackProvider} is synchronous, because the manager must be able to
 * answer `bgmPlaying` immediately and a synchronous contract keeps every caller's
 * state machine free of promises. A real decode is not synchronous, so this provider
 * starts a placeholder handle immediately and, once the buffer exists, starts the
 * real source behind it. The caller never waits and never sees a promise; `stop()`
 * before the decode lands cancels it, and a decode that fails after cancellation is
 * discarded rather than being allowed to start a stopped track.
 *
 * ## Why every failure falls back instead of throwing
 *
 * Phase 10's exit criterion is "missing optional media does not break a route". So a
 * missing resolver entry, a refused loader, a rejected decode, and an `AudioContext`
 * with no decode support all resolve the same way: the procedural provider plays the
 * id. A learner hears a splash. The route does not learn that anything went wrong,
 * and nothing is logged, because there is no learner data in a missing file path
 * worth reporting.
 */

import type { AudioPlaybackHandle, AudioSink } from './audioGraph';
import type { AudioPlaybackProvider } from './audioProvider';

/**
 * A same-origin-relative URL for one audio id, or `null` when there is no approved
 * media.
 *
 * Injected by the asset bundle service. Returning `null` is the normal answer for
 * every id today, and it is a *successful* answer - the request continues down the
 * provider chain rather than failing. An absolute or protocol-relative URL is
 * refused rather than loaded: see {@link isSameOriginRelativeAudioUrl}.
 */
export type AudioAssetResolver = (assetId: string) => string | null;

/**
 * Loads approved bytes for a URL the resolver produced.
 *
 * There is deliberately no default implementation. The audio service must not own a
 * network call; the asset bundle service does, and it does so with the bundle
 * membership check that keeps unverified media out.
 */
export type AudioAssetLoader = (url: string) => Promise<ArrayBuffer | null>;

/** Options for {@link createFileAudioProvider}. */
export interface FileAudioProviderOptions {
  /**
   * The procedural provider to fall back to. Injected rather than imported so the
   * two providers cannot form an import cycle and so a test can observe which one
   * actually served a request.
   */
  readonly fallback: AudioPlaybackProvider;
  /** URL lookup. Defaults to "nothing is registered". */
  readonly resolveAssetUrl?: AudioAssetResolver;
  /**
   * Byte loader. Required for file playback: with no loader there is no path from a
   * URL to an `AudioBuffer`, so the provider declines every id and the procedural
   * provider serves them all.
   */
  readonly loadAssetBytes?: AudioAssetLoader;
}

/**
 * Whether a resolver-supplied URL is same-origin-relative.
 *
 * The check is on the *string*, before any loader is called, and it is a string check
 * rather than a `URL` comparison against `location`: `location` is absent in a Node
 * test and in a service-worker context, and a guard that silently returns "allowed"
 * when it cannot tell would be worse than no guard. Only `/`, `./` and `../` paths
 * pass, so `https://cdn.example/…` and protocol-relative `//cdn.example/…` are both
 * refused.
 */
export function isSameOriginRelativeAudioUrl(url: string): boolean {
  return /^(?:\/|\.\/|\.\.\/)/.test(url) && !url.startsWith('//');
}

/**
 * Create the file-backed provider.
 *
 * With the default resolver - which resolves nothing - and no loader, this provider
 * answers `null` for every id and is indistinguishable from "no file backend is wired
 * yet", which is the correct behaviour for the current registry state.
 */
export function createFileAudioProvider(options: FileAudioProviderOptions): AudioPlaybackProvider {
  const { fallback, resolveAssetUrl = () => null } = options;
  const load = options.loadAssetBytes;

  let disposed = false;
  // Mirrors the procedural provider's own generation check: a decode that completes
  // after `stop()` must not start playback for a stopped track.
  let generation = 0;

  function startBufferLoop(
    sink: AudioSink,
    buffer: AudioBuffer,
    startedGeneration: number,
  ): AudioPlaybackHandle {
    const { context } = sink;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(sink.busGain);
    source.start(sink.now());
    return {
      stop(): void {
        if (generation !== startedGeneration) return;
        try {
          source.stop();
        } catch {
          // Already stopped; a double `stopBgm` is a real call pattern.
        }
        try {
          source.disconnect();
        } catch {
          // Nothing left to disconnect.
        }
      },
    };
  }

  function startBufferOnce(
    sink: AudioSink,
    buffer: AudioBuffer,
    startedGeneration: number,
  ): AudioPlaybackHandle {
    const { context } = sink;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(sink.busGain);
    source.start(sink.now());
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        source.disconnect();
      } catch {
        // Nothing left to disconnect.
      }
    };
    source.onended = release;
    return {
      stop(): void {
        try {
          source.stop();
        } catch {
          // Already ended.
        }
        release();
        if (generation === startedGeneration) generation += 1;
      },
    };
  }

  /**
   * Ask the resolver, then load and start the media, falling back on any failure.
   *
   * The procedural fallback is started from a real audio callback, so it cannot be
   * returned synchronously. That is deliberate: a caller must not be told playback
   * started when nothing has been scheduled yet. The handle returned is a
   * placeholder whose only job is to be stoppable - the manager has to be able to
   * cancel a track it believes is playing.
   */
  function startWithFallback(
    sink: AudioSink,
    assetId: string,
    loop: boolean,
  ): AudioPlaybackHandle | null {
    if (disposed || load === undefined) return null;
    const url = resolveAssetUrl(assetId);
    if (url === null || !isSameOriginRelativeAudioUrl(url)) return null;
    const startedGeneration = generation + 1;
    generation = startedGeneration;
    let cancelled = false;

    const placeholder: AudioPlaybackHandle = {
      stop(): void {
        cancelled = true;
      },
    };

    void (async () => {
      let buffer: AudioBuffer | null = null;
      try {
        const bytes = await load(url);
        if (bytes === null || bytes.byteLength === 0) throw new Error('empty audio asset');
        buffer = await sink.context.decodeAudioData(bytes);
      } catch {
        // Fall through to the procedural recipe below. Nothing is reported: there is
        // no learner data in "this optional file was absent", and a console line here
        // would fire on every world that has no audio bundle yet.
      }
      if (cancelled || disposed || generation !== startedGeneration) return;
      if (buffer === null) {
        if (loop) fallback.startMusic(sink, assetId);
        else fallback.startSfx(sink, assetId);
        return;
      }
      if (loop) startBufferLoop(sink, buffer, startedGeneration);
      else startBufferOnce(sink, buffer, startedGeneration);
    })();

    return placeholder;
  }

  return {
    id: 'cc0-file',
    provenance: 'cc0-media',
    startMusic(sink, assetId) {
      return startWithFallback(sink, assetId, true);
    },
    startSfx(sink, assetId) {
      // `null` when there is no approved file for this id, which lets the composed
      // provider hand the id to the procedural provider synchronously. When a file
      // *is* registered but cannot be loaded, the fallback fires from the loader's
      // callback above - the same outcome, one audio callback later.
      return startWithFallback(sink, assetId, false);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      fallback.dispose();
    },
  };
}
