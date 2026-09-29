/**
 * The playback backend contract, and the composition rule behind it.
 *
 * ## Why there is an interface at all
 *
 * This repository ships **zero** audio files, and `npm run test:licenses` reports
 * `cc0-approved: 0` for its 90 registered media files: every one of them is
 * `legacy-unverified`, the class the CC0 gate refuses to bundle. So the only
 * honest way to satisfy "every loaded media file is CC0-approved" in Phase 10 is
 * to load no media files, and the only honest way to have sound at all is to
 * generate it.
 *
 * That produces a decision this interface exists to make reversible. Two
 * providers implement {@link AudioPlaybackProvider} - a procedural Web Audio
 * synthesiser and a file-backed one - and the manager does not know which it has.
 * When genuine CC0 audio is registered later, the file provider starts returning
 * handles and the manager's public surface, its state, its gesture gate, and its
 * tests do not move. Phases 11, 13, 17, and 20 wire world-specific SFX and music
 * against this surface rather than against a synthesiser.
 *
 * ## Why a missing file is a fallback and not an error
 *
 * Phase 10's exit criterion is "missing optional media does not break a route".
 * A provider therefore *never* throws into the caller: a provider that cannot
 * serve an id returns `null`, and the composed provider - or the file provider's
 * own fallback for a failure that arrives asynchronously, after a decode - hands
 * the request to the procedural provider. A learner walking into the fishing
 * world hears a splash whether or not an `.ogg` ever arrives, and a route never
 * sees a rejected promise from an asset it did not ask for.
 *
 * ## Why the provider does not pick the bus
 *
 * A provider receives an {@link AudioSink} and plays into it. The bus choice
 * belongs to the manager, which knows whether a request was music or an effect,
 * so putting it in the interface would have invited a provider to route a sound
 * effect through the music bus and gain the learner's music slider.
 *
 * ## Renderer-neutral
 *
 * A provider talks to a sink - a context, a bus gain node, and a clock - and
 * nothing else. It cannot name a renderer even by accident, and it cannot reach a
 * route, a store, or the DOM.
 */

import type { AudioPlaybackHandle, AudioSink } from './audioGraph';

/** Stable provider identifiers, exposed so tests and later phases can assert routing. */
export type AudioProviderId = 'procedural' | 'cc0-file' | 'fallback';

/**
 * Media provenance, as the Phase 8 CC0 registry classifies it.
 *
 * `procedural` means the bytes are produced by committed code, so no third-party
 * licence attaches. `cc0-media` means a registered `cc0-approved` file was loaded.
 * There is deliberately no `unverified` member: this service will not load a file
 * it cannot claim provenance for.
 */
export type AudioProvenance = 'procedural' | 'cc0-media';

/**
 * One backend.
 *
 * Every method is synchronous and total. `startMusic` returns a handle the caller
 * can stop; `startSfx` returns a handle too, even though a sound effect ends on
 * its own, so a caller that disposes has something uniform to release and a test
 * has something to assert on.
 */
export interface AudioPlaybackProvider {
  readonly id: AudioProviderId;
  readonly provenance: AudioProvenance;
  /** Begin looped playback. Returns `null` when this provider cannot serve the id. */
  startMusic(sink: AudioSink, assetId: string): AudioPlaybackHandle | null;
  /** Play a one-shot. Returns `null` when this provider cannot serve the id. */
  startSfx(sink: AudioSink, assetId: string): AudioPlaybackHandle | null;
  /** Release every node and timer this provider still owns. Must be idempotent. */
  dispose(): void;
}

/**
 * Compose a primary provider with a fallback.
 *
 * Used in two places, and both are the same policy: a provider that returns `null`
 * has declined the id, and the request continues down the chain. The chain exists
 * as a function rather than as a `for` loop inside the manager so that the
 * ordering - "prefer registered CC0 media, accept procedural" - is a decision with
 * one owner and one test rather than a branch the manager repeats.
 *
 * The composed provider reports the *primary's* provenance, because that is the
 * provider that served the request when one was served at all; the case where the
 * fallback served it is observable by asking the fallback directly, and guessing
 * here would report "cc0-media" for a synthesised tone.
 */
export function createFallbackAudioProvider(
  primary: AudioPlaybackProvider,
  fallback: AudioPlaybackProvider,
): AudioPlaybackProvider {
  let disposed = false;
  return {
    id: 'fallback',
    provenance: primary.provenance,
    startMusic(sink, assetId) {
      if (disposed) return null;
      const started = primary.startMusic(sink, assetId);
      if (started !== null) return started;
      return fallback.startMusic(sink, assetId);
    },
    startSfx(sink, assetId) {
      if (disposed) return null;
      const started = primary.startSfx(sink, assetId);
      if (started !== null) return started;
      return fallback.startSfx(sink, assetId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Primary first, so a fallback that is still audible is silenced before the
      // sink it was playing through is released underneath it.
      primary.dispose();
      fallback.dispose();
    },
  };
}
