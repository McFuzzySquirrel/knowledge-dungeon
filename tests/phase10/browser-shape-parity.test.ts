/**
 * Browser-shape parity for the procedural asset fallback.
 *
 * ## The defect this file was written for
 *
 * `createPixiAssetRuntime().createFallbackTexture` assigned to
 * `CanvasRenderingContext2D.prototype.canvas`. In every browser in the support
 * matrix that property is an **accessor with only a getter**, so the assignment
 * throws a `TypeError` — and because every module here is an ES module, it is
 * strict mode, so the throw is not swallowed. In a real browser the whole
 * fallback path raises:
 *
 *     TypeError: Cannot set property canvas of #<CanvasRenderingContext2D>
 *                which has only a getter
 *
 * The Phase 10 browser lane found this by calling the shipped runtime in real
 * Chromium. It breaks the plan's exit criterion "missing optional media does not
 * break a route" in the strongest way available: the *fallback* is the thing that
 * is supposed to keep a route alive, and it throws instead.
 *
 * ## Why the unit suite did not catch it
 *
 * `vitest.setup.ts` replaces `HTMLCanvasElement.prototype.getContext` with a
 * plain object literal. A plain object has an ordinary writable `canvas` data
 * property, so the assignment that throws in a browser succeeds in jsdom. The
 * stub was written for Phaser's benefit and silently removed the only property
 * whose descriptor shape matters here.
 *
 * So the assertion below does not stub `getContext` again — it installs a context
 * whose `canvas` is defined exactly as the platform defines it, with
 * `Object.defineProperty` and no setter. That is the shape, not a double of the
 * code under test: the code under test is `createPixiAssetRuntime`, and this
 * file only makes the platform honest.
 *
 * ## Why it is a unit test and not only a browser test
 *
 * The browser lane is the evidence and this is the regression gate. A defect
 * that turns a whole subsystem into a thrown `TypeError` on every call should
 * not be able to come back the next time somebody edits a recipe, and the gate
 * has to run in `npm test` because that is the command CI runs on every change
 * with no browser installed.
 *
 * Hermeticity: no network, no `dist/`, no git, no clock, no PixiJS renderer. The
 * only global this file installs is `getContext`, and it restores it in a
 * `finally`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createPixiAssetRuntime } from '@/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { ResolvedFallbackRecipe } from '@/renderers/pixi/assets/AssetLoader';

const theme = resolveCozyWorldTheme();

function recipe(overrides: Partial<ResolvedFallbackRecipe> = {}): ResolvedFallbackRecipe {
  return {
    kind: 'rounded-panel',
    fill: theme.color.surfacePanel,
    stroke: theme.color.borderStrong,
    widthPx: 40,
    heightPx: 24,
    radiusPx: theme.radius.md,
    ...overrides,
  };
}

/**
 * A 2D context shaped like the platform's.
 *
 * `canvas` is defined on the prototype with a getter and **no setter**, which is
 * what every browser in the support matrix does and what jsdom's own canvas does
 * not. Everything else records, so the assertions stay about what the code drew.
 */
function platformShapedContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const noop = (): void => {};
  const context: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    roundRect: noop,
    ellipse: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
  };
  Object.defineProperty(context, 'canvas', {
    get: () => canvas,
    // No `set`. This is the whole point of the fixture.
    enumerable: true,
    configurable: true,
  });
  return context as unknown as CanvasRenderingContext2D;
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe('the procedural fallback survives a platform-shaped 2D context', () => {
  it('does not assign to the read-only `canvas` property, which throws in a browser', () => {
    HTMLCanvasElement.prototype.getContext = function patched(
      this: HTMLCanvasElement,
      kind: string,
    ) {
      if (kind !== '2d') return null;
      return platformShapedContext(this);
    } as typeof originalGetContext;

    const runtime = createPixiAssetRuntime();

    // The one line that used to throw. Asserted directly so the failure names the
    // property rather than surfacing as a texture that never appears.
    const probe = platformShapedContext(document.createElement('canvas'));
    expect(() => {
      (probe as CanvasRenderingContext2D & { canvas: HTMLCanvasElement }).canvas =
        document.createElement('canvas');
    }).toThrow(TypeError);

    let texture: unknown;
    expect(() => {
      texture = runtime.createFallbackTexture(recipe({ widthPx: 48, heightPx: 16 }));
    }, 'createFallbackTexture must not throw against a real-shaped context').not.toThrow();
    expect(texture).toBeTruthy();
  });

  it('produces a texture of the recipe size, drawn from the canvas it was given', () => {
    let drawn = 0;
    HTMLCanvasElement.prototype.getContext = function patched(
      this: HTMLCanvasElement,
      kind: string,
    ) {
      if (kind !== '2d') return null;
      const context = platformShapedContext(this) as unknown as Record<string, unknown>;
      const fill = context['fill'];
      context['fill'] = (...args: unknown[]): void => {
        drawn += 1;
        (fill as (...a: unknown[]) => void)(...args);
      };
      return context as unknown as CanvasRenderingContext2D;
    } as typeof originalGetContext;

    const runtime = createPixiAssetRuntime();
    const texture = runtime.createFallbackTexture(recipe({ widthPx: 48, heightPx: 16 }));

    expect(drawn, 'the recipe was drawn, not stubbed').toBeGreaterThan(0);
    expect(texture.width).toBe(48);
    expect(texture.height).toBe(16);
    expect(texture.destroyed).toBe(false);
    runtime.destroyTexture(texture);
    expect(texture.destroyed).toBe(true);
  });

  it('degrades rather than throwing when the 2D context has no canvas property at all', () => {
    // A realm where `getContext` returns an object with no `canvas` — older
    // embedders, and a future stub. Reading `context.canvas` must not be the thing
    // that breaks the route either.
    HTMLCanvasElement.prototype.getContext = (() =>
      ({ fillRect: () => {}, fill: () => {}, stroke: () => {}, beginPath: () => {} }) as unknown as CanvasRenderingContext2D) as unknown as typeof originalGetContext;

    const runtime = createPixiAssetRuntime();
    let texture: unknown;
    expect(() => {
      texture = runtime.createFallbackTexture(recipe());
    }).not.toThrow();
    expect(texture).toBeTruthy();
  });
});
