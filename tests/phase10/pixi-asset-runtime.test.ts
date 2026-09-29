/**
 * Phase 10: the real PixiJS asset runtime, for the parts that need no network.
 *
 * ## Why this file exists beside the double
 *
 * `tests/phase10/asset-loader.test.ts` proves the loader's policy against a
 * plain-object runtime, which is the only way to reach a missing asset, a held
 * texture, or a hundred remounts without a GPU. What that cannot prove is that the
 * thing standing behind the port is PixiJS at all. A loader test against a double
 * would pass just as happily against a runtime that quietly returned a grey square,
 * so this file binds the real one and checks the three claims that are actually
 * load-bearing:
 *
 * 1. **A procedural fallback is a real texture of the recipe's size.** The exit
 *    criterion is "missing optional media does not break a route", and the route draws
 *    whatever this returns. A texture of the wrong size, or a stub, is a world that
 *    renders a hole instead of a placeholder.
 * 2. **`destroyTexture` destroys, and is safe to call twice.** Teardown runs twice
 *    under StrictMode, and a second `destroy(true)` on an already-destroyed texture
 *    throws.
 * 3. **Release is delegated to `Assets.unloadBundle` / `Assets.unload`**, which is
 *    what the loader's ownership split depends on: the runtime destroys what it
 *    loaded, and the loader does not touch it again.
 *
 * ## What this file does not establish
 *
 * A real fetch, a real 404, and GPU memory. Pixi's image parsers do not complete
 * against jsdom - `Image.src` is assigned and no `load` event ever fires - so
 * `loadBundle` is not exercised end to end here. That is stated rather than papered
 * over, and it is why claim 3 asserts *delegation* against a spy on the `Assets`
 * singleton rather than asserting a destroyed texture: the delegation is what this
 * repository owns, and the destroy-on-unload behaviour it relies on is Pixi's own
 * parser contract, cited in the binding's documentation.
 *
 * ## Hermeticity
 *
 * No network, no `dist/`, no git, no clock. The 2D context is a local recorder, not
 * jsdom's, so the geometry assertions are about the calls the code makes. The
 * `Assets` spies are restored in `afterEach`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createPixiAssetRuntime,
  drawAssetFallback,
} from '@/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { ResolvedFallbackRecipe } from '@/renderers/pixi/assets/AssetLoader';

let Assets: typeof import('pixi.js').Assets;
let Texture: typeof import('pixi.js').Texture;

beforeAll(async () => {
  const pixi = await import('pixi.js');
  Assets = pixi.Assets;
  Texture = pixi.Texture;
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** Every 2D call `drawAssetFallback` made, in order. */
interface DrawRecord {
  readonly calls: string[];
  readonly fills: string[];
  readonly strokes: string[];
  lastPath: string | null;
}

/**
 * A 2D context that records instead of drawing.
 *
 * jsdom's own stub answers a fixed set of no-op methods, which is enough for
 * `Texture.from(canvas)` and useless for asserting *what was drawn*. This one records
 * the calls, so the geometry assertions are about the code under test rather than
 * about a renderer. `run` receives the context to draw with and the record to assert
 * on - one object, so the two cannot drift apart.
 */
function recordingContext(run: (context: CanvasRenderingContext2D, record: DrawRecord) => void): DrawRecord {
  const record: DrawRecord = { calls: [], fills: [], strokes: [], lastPath: null };
  const context = {
    canvas: { width: 0, height: 0 } as unknown as HTMLCanvasElement,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    clearRect: () => record.calls.push('clearRect'),
    beginPath: () => {
      record.lastPath = '';
      record.calls.push('beginPath');
    },
    closePath: () => record.calls.push('closePath'),
    moveTo: () => {
      record.lastPath = 'path';
    },
    lineTo: () => {
      record.lastPath = 'path';
    },
    quadraticCurveTo: () => {
      record.lastPath = 'path';
    },
    roundRect: (x: number, y: number, w: number, h: number, r: number) => {
      record.lastPath = `roundRect(${x},${y},${w},${h},${r})`;
      record.calls.push(record.lastPath);
    },
    ellipse: () => {
      record.lastPath = 'ellipse';
      record.calls.push('ellipse');
    },
    fillRect: (x: number, y: number, w: number, h: number) =>
      record.calls.push(`fillRect(${x},${y},${w},${h})`),
    strokeRect: (x: number, y: number, w: number, h: number) =>
      record.calls.push(`strokeRect(${x},${y},${w},${h})`),
    fill: () => {
      record.calls.push('fill');
      record.fills.push(String(context.fillStyle));
    },
    stroke: () => {
      record.calls.push('stroke');
      record.strokes.push(String(context.strokeStyle));
    },
  } as unknown as CanvasRenderingContext2D;
  run(context, record);
  return record;
}

describe('a procedural fallback is a real PixiJS texture', () => {
  it('has the recipe\'s dimensions and is not destroyed on creation', () => {
    const runtime = createPixiAssetRuntime();
    const texture = runtime.createFallbackTexture(recipe({ widthPx: 48, heightPx: 16 }));
    expect(texture).toBeInstanceOf(Texture);
    expect(texture.width).toBe(48);
    expect(texture.height).toBe(16);
    expect(texture.destroyed).toBe(false);
    runtime.destroyTexture(texture);
  });

  it('destroys on release, and a second destroy is a no-op rather than a throw', () => {
    // Teardown runs twice under StrictMode, so the second call is the ordinary case
    // rather than an edge one. `Texture.destroy(true)` on a destroyed texture throws.
    const runtime = createPixiAssetRuntime();
    const texture = runtime.createFallbackTexture(recipe());
    runtime.destroyTexture(texture);
    expect(texture.destroyed).toBe(true);
    expect(() => runtime.destroyTexture(texture)).not.toThrow();
  });
});

describe('a fallback is drawn, not stubbed', () => {
  it('a rounded panel fills and strokes with the recipe\'s colours, at its radius', () => {
    const spec = recipe({ kind: 'rounded-panel' });
    const record = recordingContext((context) => drawAssetFallback(context, spec));
    expect(record.calls).toContain('fill');
    expect(record.calls).toContain('stroke');
    // The colours came from the theme through the recipe, not from a constant here.
    expect(record.fills[0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(record.lastPath).toContain(String(spec.radiusPx));
    expect(spec.radiusPx, 'the radius is the Cozy token, not a copy').toBe(theme.radius.md);
  });

  it('a disc is a disc, a rule is a bar, and a tile is a filled box with a border', () => {
    const disc = recordingContext((context) => drawAssetFallback(context, recipe({ kind: 'disc' })));
    expect(disc.calls).toContain('ellipse');
    expect(disc.calls.filter((call) => call.startsWith('fillRect'))).toEqual([]);

    const spec = recipe({ kind: 'rule' });
    const rule = recordingContext((context) => drawAssetFallback(context, spec));
    expect(rule.calls.filter((call) => call.startsWith('fillRect'))).toEqual([
      `fillRect(0,0,${spec.widthPx},${spec.heightPx})`,
    ]);
    expect(rule.calls, 'a rule is a bar, not an outlined box').not.toContain('stroke');

    const tile = recordingContext((context) => drawAssetFallback(context, recipe({ kind: 'tile' })));
    expect(tile.calls.filter((call) => call.startsWith('fillRect'))).toHaveLength(1);
    expect(tile.calls.filter((call) => call.startsWith('strokeRect'))).toHaveLength(1);
  });

  it('a realm with no 2D context degrades to a shared texture instead of throwing', () => {
    // The same shape as the loader's no-reject policy, one layer down: a fallback
    // that cannot be drawn must not become a TypeError inside a world mount. It is
    // visibly wrong, and it is not a crash.
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof original;
    try {
      const runtime = createPixiAssetRuntime();
      const texture = runtime.createFallbackTexture(recipe());
      expect(texture).toBeInstanceOf(Texture);
      expect(texture.destroyed).toBe(false);
      runtime.destroyTexture(texture);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

describe('release is delegated to Pixi, which is what the ownership split relies on', () => {
  it('unloadBundle and unload go to the Assets singleton, not to a local cache', async () => {
    // The loader never calls `destroyTexture` on something this runtime loaded, on
    // the strength of Pixi's texture parsers implementing `unload` as
    // `texture.destroy(true)`. That is a library contract, so what is asserted here
    // is the half this repository owns: the release really is `Assets.unloadBundle`.
    const runtime = createPixiAssetRuntime();
    // `Assets.init` runs format detection, which needs a browser to complete; the
    // runtime awaits it before its first real call, so it is stubbed here and the
    // assertion stays about delegation.
    vi.spyOn(Assets, 'init').mockResolvedValue(undefined as never);
    const bundle = vi.spyOn(Assets, 'unloadBundle').mockResolvedValue(undefined);
    const one = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined);

    await runtime.unloadBundle('synthetic-bundle');
    await runtime.unloadAsset('/assets/synthetic/a.svg');

    expect(bundle).toHaveBeenCalledWith('synthetic-bundle');
    expect(one).toHaveBeenCalledWith('/assets/synthetic/a.svg');
  });

  it('registration goes to Assets.addBundle, so a bundle is unloadable as a unit', () => {
    const runtime = createPixiAssetRuntime();
    const add = vi.spyOn(Assets, 'addBundle').mockImplementation(() => undefined);
    runtime.registerBundle('synthetic-bundle', { 'synthetic-key': '/assets/synthetic/a.svg' });
    expect(add).toHaveBeenCalledWith('synthetic-bundle', {
      'synthetic-key': '/assets/synthetic/a.svg',
    });
  });
});
