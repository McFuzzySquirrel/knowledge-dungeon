/**
 * A recording canvas 2D context, for the Phase 20 renderer and export tests.
 *
 * ## Why this exists at all
 *
 * `vitest.setup.ts` installs a **no-op** `HTMLCanvasElement.prototype.getContext`, so a test that
 * draws through it observes nothing: every call succeeds and nothing is recorded. A gate written
 * against that mock would pass for any renderer, including one that drew the wrong string in the
 * wrong place. That is the same vacuity Phase 19 and Phase 20 Round 1 both hit in this repository,
 * and it is why `renderShareCard` returns the strings it drew rather than only a Blob.
 *
 * So this module installs a context that **records**:
 *
 * - every `fillText` call, in order, with the font and fill style in force at the time;
 * - every `fillRect` / `strokeRect` geometry, so a card's layout is inspectable;
 * - a `measureText` that returns a width proportional to the string, so the wrapping logic in
 *   `progressionShareExport.ts` takes a real branch instead of the `width: 0` short circuit.
 *
 * ## What it deliberately does not pretend to do
 *
 * **It computes no colours and no layout.** A recorded `fillStyle` is the token string the renderer
 * *asked for*; nothing here measures contrast, and nothing here knows whether a 44x44 target is
 * 44x44. Those belong to a real browser and to Phase 21, and `tests/phase20/shareCardNonVacuity
 * .test.ts` asserts this module is the one that says so - so a later reader cannot mistake a
 * recording canvas for verification.
 */
import { vi } from 'vitest';

export interface RecordedFill {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  /** The canvas font shorthand in force for this call. */
  readonly font: string;
  /** The fill style in force for this call. */
  readonly fillStyle: string;
}

export interface RecordedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly stroked: boolean;
}

export interface RecordingCanvas {
  /**
   * Every `fillText` call, in order.
   *
   * **Mutable on purpose.** Several tests render the same model more than once under different themes
   * or time zones and need to compare the second render against the first, which means clearing the
   * log between renders. A `readonly` array here would force every such test to allocate a second
   * recorder, and the log is the whole point of this module.
   */
  readonly texts: RecordedFill[];
  /** Every `fillRect` and `strokeRect` call, in order. */
  readonly rects: RecordedRect[];
  /** Every string passed to `fillText`, concatenated. The "what was on the card" view. */
  readonly allText: () => string;
  /** How many times `toBlob` was called, and with which MIME type. */
  readonly toBlobCalls: readonly string[];
}

/** A deterministic width model, so `measureText` has a shape without being a font engine. */
function measure(text: string): number {
  return text.length * 8;
}

/**
 * Replace `HTMLCanvasElement.prototype.getContext` and `toBlob` with recording versions.
 *
 * Returns the single {@link RecordingCanvas} every created canvas reports into, plus a restore
 * function. The restore is not optional politeness: a test that leaves a global stub installed
 * silently changes what every later test in the same worker observes, which is a cross-test leak
 * rather than a test failure.
 *
 * `toBlob` resolves a **real** `Blob` of one byte. jsdom has no PNG encoder, and the renderer only
 * needs to know the encode succeeded - the bytes themselves are asserted in
 * `tests/phase20/shareCardDelivery.test.ts`, where a hand-built blob stands in for the image.
 */
export function installRecordingCanvas(): {
  readonly canvas: RecordingCanvas;
  readonly restore: () => void;
} {
  const texts: RecordedFill[] = [];
  const rects: RecordedRect[] = [];
  const toBlobCalls: string[] = [];

  const record: RecordingCanvas = {
    texts,
    rects,
    allText: () => texts.map((entry) => entry.text).join('\n'),
    toBlobCalls,
  };

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function recordingGetContext(this: HTMLCanvasElement) {
    // One context object per canvas, so a second canvas does not replay the first canvas's history.
    const state = { font: '', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1 };
    return {
      get font(): string {
        return state.font;
      },
      set font(value: string) {
        state.font = value;
      },
      get fillStyle(): string {
        return state.fillStyle;
      },
      set fillStyle(value: string) {
        state.fillStyle = String(value);
      },
      get strokeStyle(): string {
        return state.strokeStyle;
      },
      set strokeStyle(value: string) {
        state.strokeStyle = String(value);
      },
      get lineWidth(): number {
        return state.lineWidth;
      },
      set lineWidth(value: number) {
        state.lineWidth = value;
      },
      fillText: (text: string, x: number, y: number) => {
        texts.push({ text: String(text), x, y, font: state.font, fillStyle: state.fillStyle });
      },
      strokeText: (text: string, x: number, y: number) => {
        texts.push({ text: String(text), x, y, font: state.font, fillStyle: state.strokeStyle });
      },
      fillRect: (x: number, y: number, width: number, height: number) => {
        rects.push({
          x,
          y,
          width,
          height,
          fillStyle: state.fillStyle,
          strokeStyle: state.strokeStyle,
          stroked: false,
        });
      },
      strokeRect: (x: number, y: number, width: number, height: number) => {
        rects.push({
          x,
          y,
          width,
          height,
          fillStyle: state.fillStyle,
          strokeStyle: state.strokeStyle,
          stroked: true,
        });
      },
      measureText: (text: string) => ({ width: measure(String(text)) }),
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      arc: () => {},
      rect: () => {},
      clip: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
      drawImage: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
    };
  };

  HTMLCanvasElement.prototype.toBlob = function recordingToBlob(
    callback: BlobCallback,
    type = 'image/png',
  ) {
    toBlobCalls.push(String(type));
    // jsdom's `Blob` accepts a `Uint8Array`; one non-zero byte is enough for a caller to treat the
    // encode as having succeeded.
    callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: String(type) }));
  };

  return {
    canvas: record,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    },
  };
}

/**
 * A `navigator.share` / `navigator.canShare` pair that records its own invocations.
 *
 * ## Why the invocation count matters more than the arguments
 *
 * The phase's headline claim is "Web Share runs only from a user click", and the weak way to test it
 * is to assert that `share` was not called after a mount - which passes just as well for a component
 * that calls it from a `setTimeout`. So every test in this file **counts** invocations across the
 * whole lifecycle and asserts the count is `0` until a click and exactly `1` after one. A count
 * cannot be satisfied by a filter, a prop check, or an assertion about absence.
 *
 * `canShareCalls` is recorded separately because plan section 9 requires `canShare` before `share`,
 * and a test that only counted `share` would pass for a component that skipped the capability check.
 */
export interface ShareSpy {
  readonly shareCalls: readonly unknown[][];
  readonly canShareCalls: readonly unknown[][];
  /**
   * Change how the fake `navigator.share` behaves from here on, without reinstalling.
   *
   * Required rather than optional because the install-time behaviour is already a parameter of
   * {@link installShareSpy}; an optional second one would make `spy.install()` mean "resolve" and
   * silently succeed for a reader who meant "reject".
   */
  readonly install: (behaviour: ShareBehaviour) => void;
  /** Remove both, restoring whatever was there before. */
  readonly restore: () => void;
}

/** How the fake `navigator.share` should behave. `reject` is how a cancel is produced. */
export type ShareBehaviour =
  | { readonly kind: 'resolve' }
  | { readonly kind: 'reject'; readonly errorName: string }
  | { readonly kind: 'throw-sync'; readonly errorName: string };

export function installShareSpy(behaviour: ShareBehaviour = { kind: 'resolve' }): ShareSpy {
  const shareCalls: unknown[][] = [];
  const canShareCalls: unknown[][] = [];
  const navigatorRef = globalThis.navigator as unknown as Record<string, unknown>;
  const previousShare = navigatorRef.share;
  const previousCanShare = navigatorRef.canShare;
  let current: ShareBehaviour = behaviour;

  navigatorRef.share = vi.fn(async (...args: unknown[]) => {
    shareCalls.push(args);
    if (current.kind === 'reject') {
      const error = new Error(`fake share rejected with ${current.errorName}`);
      error.name = current.errorName;
      throw error;
    }
    if (current.kind === 'throw-sync') {
      const error = new Error(`fake share threw with ${current.errorName}`);
      error.name = current.errorName;
      throw error;
    }
  });
  navigatorRef.canShare = vi.fn((...args: unknown[]) => {
    canShareCalls.push(args);
    return true;
  });

  return {
    shareCalls,
    canShareCalls,
    install: (next) => {
      current = next;
    },
    restore: () => {
      if (previousShare === undefined) delete navigatorRef.share;
      else navigatorRef.share = previousShare;
      if (previousCanShare === undefined) delete navigatorRef.canShare;
      else navigatorRef.canShare = previousCanShare;
    },
  };
}

/** Remove every `navigator.share` / `navigator.canShare` this repository's tests installed. */
export function removeShareApi(): void {
  const navigatorRef = globalThis.navigator as unknown as Record<string, unknown>;
  delete navigatorRef.share;
  delete navigatorRef.canShare;
}