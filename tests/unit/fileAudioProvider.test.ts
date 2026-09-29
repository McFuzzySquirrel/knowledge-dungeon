/**
 * The file-backed audio provider's four documented failure shapes.
 *
 * ## Why this file exists beside `tests/unit/audioManager.test.ts`
 *
 * `fileAudioProvider.ts` names its own failure contract in its module header:
 *
 *     a missing resolver entry, a refused loader, a rejected decode, and an
 *     `AudioContext` with no decode support all resolve the same way
 *
 * Three of those four had a test. The fourth — a context that has **no**
 * `decodeAudioData` at all — did not, and it is the one a locked-down embedded
 * webview actually produces. `tests/unit/audioManager.test.ts` covers the
 * neighbouring case with `decodeResult = null`, which makes `decodeAudioData`
 * *throw*; the absent-method case reaches a different line entirely
 * (`await sink.context.decodeAudioData(bytes)` on `undefined`), so a test that only
 * sets `decodeResult` proves nothing about it.
 *
 * The gap is described here rather than left as a comment in someone else's suite,
 * so that a reader of the header's claim can find the gate for it.
 *
 * ## The composition is the manager's own
 *
 * These tests pass `resolveAssetUrl` and `loadAssetBytes` as ordinary manager
 * options rather than supplying a `createProvider`, so the chain under test is the
 * one production builds: the file provider composed *over* the procedural one. A
 * test that installed its own chain could make all four shapes pass by composing
 * them differently, which would say nothing about the shipped wiring.
 *
 * ## What the shapes have in common
 *
 * All four resolve to the same observable outcome: the procedural recipe plays the
 * id, nothing throws into the caller, and `getState().activeProvider` does not claim
 * a media file is playing. That last part matters — the manager records the serving
 * provider's own id, and a fallback reporting the *primary's* provenance would
 * record `cc0-media` for a synthesised tone.
 *
 * ## Hermeticity
 *
 * No network, no `dist/`, no git, no clock. The `AudioContext` is the repository's
 * own fake, which is the only way to reach a context with a missing method at all;
 * the property is shadowed and then removed again, so the shared fake is not left
 * mutated for another suite.
 */
import { describe, expect, it, vi } from 'vitest';

import { createAudioManager, type AudioManager } from '@/services/audioManager';
import { createAudioGraph } from '@/services/audio/audioGraph';
import { asAudioContext, FakeAudioContext } from './support/fakeAudio';
import { createTestGestureSource } from './support/testAudioGestures';

/** A same-origin URL, which is the only shape the provider will act on. */
const REGISTERED_URL = '/assets/audio/fish-catch.ogg';

interface Harness {
  /** Ask for a sound effect the way a route would. */
  playSfx(kind: string): void;
  /** Oscillators the platform was really told to start — the audible outcome. */
  startedOscillators(): number;
  /** Buffer sources the platform was really told to start. */
  startedBufferSources(): number;
  /** The provider the manager says served the last request. */
  activeProvider(): string;
  dispose(): void;
}

function harness(options: {
  readonly resolveAssetUrl?: (assetId: string) => string | null;
  readonly loadAssetBytes?: (url: string) => Promise<ArrayBuffer | null>;
  /** Applied to the context before the graph is built — the only place to break it. */
  readonly prepareContext?: (context: FakeAudioContext) => void;
}): Harness {
  const context = new FakeAudioContext();
  options.prepareContext?.(context);
  const manager: AudioManager = createAudioManager({
    gestureSource: createTestGestureSource(),
    createGraph: () => createAudioGraph(asAudioContext(context)),
    resolveAssetUrl: options.resolveAssetUrl ?? (() => null),
    loadAssetBytes: options.loadAssetBytes ?? (async () => new ArrayBuffer(8)),
  });
  // The gate, opened explicitly, because these tests are about the provider chain
  // and not about the gesture rule; the gesture rule has its own suite and its own
  // browser lane.
  manager.unlock();
  return {
    playSfx: (kind) => manager.playSfx(kind as Parameters<AudioManager['playSfx']>[0]),
    startedOscillators: () => context.oscillators.filter((oscillator) => oscillator.started).length,
    startedBufferSources: () => context.bufferSources.filter((source) => source.started).length,
    activeProvider: () => manager.getState().activeProvider,
    dispose: () => manager.dispose(),
  };
}

describe('the file-backed provider, on each failure shape its header names', () => {
  it('shape 1: a missing resolver entry is declined synchronously and the chain continues', () => {
    // The current registry state, exactly: `cc0-approved` is 0, so every id misses.
    const h = harness({ resolveAssetUrl: () => null });

    // Synchronously. A miss is a *successful* answer, so the request continues down
    // the chain in the same tick rather than being queued for a later callback —
    // and that is what makes this shape distinguishable from shapes 2 to 4 below.
    h.playSfx('fish-catch');
    expect(h.startedOscillators(), 'the procedural recipe served the id in the same tick').toBeGreaterThan(
      0,
    );
    expect(h.activeProvider()).toBe('fallback');
    h.dispose();
  });

  it('shape 2: a refused loader falls back from the audio callback, and nothing throws', async () => {
    const requested: string[] = [];
    const h = harness({
      resolveAssetUrl: () => REGISTERED_URL,
      loadAssetBytes: async (url) => {
        requested.push(url);
        throw new Error('404');
      },
    });

    // The request is accepted synchronously, because a loader that has not answered
    // yet is not a refusal.
    h.playSfx('fish-catch');
    await vi.waitFor(() => expect(h.startedOscillators()).toBeGreaterThan(0));

    // NON-VACUITY: the URL really was asked for, or "the fallback ran" would say
    // nothing about a request that was never made.
    expect(requested, 'the registered URL really was requested').toEqual([REGISTERED_URL]);
    expect(h.activeProvider(), 'and nothing reports a media file as the source').toBe('fallback');
    h.dispose();
  });

  it('shape 3: a rejected decode falls back, and the rejection never becomes unhandled', async () => {
    // `decodeResult = null` makes `decodeAudioData` throw, which is the shape a
    // malformed file produces.
    const h = harness({
      resolveAssetUrl: () => REGISTERED_URL,
      loadAssetBytes: async () => new ArrayBuffer(8),
      prepareContext: (context) => {
        context.decodeResult = null;
      },
    });

    expect(() => h.playSfx('fish-catch'), 'the caller never sees the failure').not.toThrow();
    await vi.waitFor(() => expect(h.startedOscillators()).toBeGreaterThan(0));
    expect(h.activeProvider()).toBe('fallback');
    h.dispose();
  });

  it('shape 4: a context with no decodeAudioData at all falls back rather than throwing a TypeError', async () => {
    // The shape a locked-down embedded webview produces, and the one
    // `decodeResult = null` does *not* produce: the method is absent, so the call
    // throws a `TypeError` on `undefined` from a different line.
    const context = new FakeAudioContext();
    // `delete` would not work: the fake's method lives on its prototype, so removing
    // the own property exposes the prototype method again. Shadowing is what a
    // webview that refuses the API actually looks like, and it is undone below.
    Object.defineProperty(context, 'decodeAudioData', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(
      typeof (context as unknown as { decodeAudioData?: unknown }).decodeAudioData,
      'the fixture really has no decode support',
    ).toBe('undefined');

    const manager = createAudioManager({
      gestureSource: createTestGestureSource(),
      createGraph: () => createAudioGraph(asAudioContext(context)),
      resolveAssetUrl: () => REGISTERED_URL,
      loadAssetBytes: async () => new ArrayBuffer(8),
    });
    try {
      manager.unlock();
      expect(
        () => manager.playSfx('fish-catch'),
        'a context without decode support must not throw into the caller',
      ).not.toThrow();
      await vi.waitFor(() =>
        expect(context.oscillators.filter((oscillator) => oscillator.started).length).toBeGreaterThan(
          0,
        ),
      );
      // And nothing reports a CC0 media file as the source of a synthesised tone.
      expect(manager.getState().activeProvider).toBe('fallback');
    } finally {
      manager.dispose();
      delete (context as unknown as Record<string, unknown>)['decodeAudioData'];
    }
  });

  it('an off-origin URL is refused before any loader is asked for bytes', () => {
    // The privacy half of the same contract, and the reason the resolver's output
    // is checked on the *string* rather than by comparing against `location`.
    const requested: string[] = [];
    const h = harness({
      resolveAssetUrl: () => 'https://cdn.example/fish-catch.ogg',
      loadAssetBytes: async (url) => {
        requested.push(url);
        return new ArrayBuffer(8);
      },
    });

    // Synchronously again: the refusal is a string check made before the loader is
    // consulted at all.
    h.playSfx('fish-catch');
    expect(h.startedOscillators(), 'the procedural recipe served the id in the same tick').toBeGreaterThan(
      0,
    );
    expect(requested, 'the loader was never asked for an off-origin byte').toEqual([]);
    h.dispose();
  });

  it('a successful load is the one shape that does not fall back', async () => {
    // The control for the four above. Without it, "the fallback ran" would be the
    // only outcome the harness can produce, and every shape would pass whether or
    // not the file branch works at all.
    const h = harness({
      resolveAssetUrl: () => REGISTERED_URL,
      loadAssetBytes: async () => new ArrayBuffer(8),
    });

    h.playSfx('fish-catch');
    await vi.waitFor(() => expect(h.startedBufferSources()).toBe(1));
    expect(h.startedOscillators(), 'the procedural recipe did not also run').toBe(0);
    h.dispose();
  });
});
