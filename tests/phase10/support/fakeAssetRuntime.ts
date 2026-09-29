/**
 * A `PixiAssetRuntime` double for the Phase 10 loader tests.
 *
 * ## Why a double rather than the real PixiJS runtime
 *
 * The loader's policy - reference counts, in-flight idempotence, the required and
 * optional split, deferred release, the bounded diagnostic - is the thing Phase 10
 * has to be right about, and none of it needs a GPU, a DOM, or a network. A double
 * is therefore the right instrument for most of it, and it is the only instrument
 * that can produce the two conditions the interesting assertions need: a member that
 * is *silently absent* from a successful bundle load, and a load that stays pending
 * so a second caller can be observed joining it.
 *
 * The real engine is not absent from the suite, though - it would be a vacuous
 * claim that a double's `unloadBundle` "destroys" anything.
 * `tests/phase10/pixi-asset-runtime.test.ts` exercises the real binding for the
 * parts that do not need a network: the procedural fallback really is a PixiJS
 * `Texture` of the recipe's size, and release really is delegated to
 * `Assets.unloadBundle` / `Assets.unload`, whose texture parsers implement `unload`
 * as `texture.destroy(true)`.
 *
 * ## The contract this double honours
 *
 * `unloadBundle` and `unloadAsset` **destroy** what they release, exactly as PixiJS
 * does. That is not decoration: the loader relies on it to avoid calling
 * `destroyTexture` on a texture the runtime already destroyed, and a double that
 * only forgot a cache entry would let that double-destroy bug pass.
 *
 * Hermeticity: no network, no filesystem, no clock, no `dist/`, no git. Every value
 * it returns is a counter or an id it allocated itself.
 */
import type { PixiAssetRuntime, ResolvedFallbackRecipe } from '@/renderers/pixi/assets/AssetLoader';

export interface FakeTexture {
  readonly id: number;
  /** The recipe, for a procedurally created texture; `null` for a loaded one. */
  readonly recipe: ResolvedFallbackRecipe | null;
  destroyed: boolean;
}

export interface FakeRuntimeOptions {
  /** Bundle ids whose required members fail as a whole, as `loadBundle` does. */
  readonly failBundles?: readonly string[];
  /** Bundle ids that resolve *without* a member - a silent 404 inside a success. */
  readonly omitBundleMembers?: readonly string[];
  /** Exact URLs whose individual load rejects. */
  readonly failUrls?: readonly string[];
}

export interface FakeRuntimeCalls {
  readonly registerBundle: string[];
  readonly loadBundle: string[];
  readonly loadAsset: string[];
  readonly unloadBundle: string[];
  readonly unloadAsset: string[];
  readonly createFallbackTexture: ResolvedFallbackRecipe[];
  /**
   * Textures destroyed through `destroyTexture` - that is, through the *loader*.
   *
   * Kept apart from {@link destroyedByRelease} on purpose. Both owners destroy, and
   * the loader's whole ownership rule is that it does not destroy a texture the
   * runtime already destroyed. A single counter for the two would make a
   * double-destroy invisible, which is the exact bug the split exists to catch.
   */
  readonly destroyTexture: number[];
  /** Textures destroyed by `unloadBundle` / `unloadAsset`, i.e. by the runtime. */
  readonly destroyedByRelease: number[];
}

export interface FakeAssetRuntime {
  readonly runtime: PixiAssetRuntime<FakeTexture>;
  readonly calls: FakeRuntimeCalls;
  /** Every texture handed out and not yet destroyed, by id. */
  readonly live: Map<number, FakeTexture>;
  /** Make every pending and future `loadBundle` hang, for the join assertion. */
  holdLoads(): void;
  /** Release a hold created by {@link holdLoads}. */
  releaseLoads(): void;
}

export function createFakeAssetRuntime(options: FakeRuntimeOptions = {}): FakeAssetRuntime {
  const failBundles = new Set(options.failBundles ?? []);
  const omitMembers = new Set(options.omitBundleMembers ?? []);
  const failUrls = new Set(options.failUrls ?? []);

  const calls: FakeRuntimeCalls = {
    registerBundle: [],
    loadBundle: [],
    loadAsset: [],
    unloadBundle: [],
    unloadAsset: [],
    createFallbackTexture: [],
    destroyTexture: [],
    destroyedByRelease: [],
  };

  /** Textures Pixi "loaded", by the cache key the release methods look up. */
  const loaded = new Map<string, FakeTexture>();
  const live = new Map<number, FakeTexture>();
  const members = new Map<string, Record<string, string>>();
  let nextId = 1;
  let held: { promise: Promise<void>; open: () => void } | null = null;

  function make(recipe: ResolvedFallbackRecipe | null): FakeTexture {
    const texture: FakeTexture = { id: nextId, recipe, destroyed: false };
    nextId += 1;
    live.set(texture.id, texture);
    return texture;
  }

  function destroy(texture: FakeTexture, by: 'loader' | 'release'): void {
    if (texture.destroyed) return;
    texture.destroyed = true;
    live.delete(texture.id);
    (by === 'loader' ? calls.destroyTexture : calls.destroyedByRelease).push(texture.id);
  }

  async function gate(): Promise<void> {
    if (held === null) return;
    await held.promise;
  }

  const runtime: PixiAssetRuntime<FakeTexture> = {
    registerBundle(bundleId, bundleMembers) {
      calls.registerBundle.push(bundleId);
      members.set(bundleId, { ...bundleMembers });
    },
    async loadBundle(bundleId) {
      calls.loadBundle.push(bundleId);
      await gate();
      if (failBundles.has(bundleId)) throw new Error(`synthetic failure for bundle ${bundleId}`);
      const bundleMembers = members.get(bundleId) ?? {};
      const resolved: Record<string, FakeTexture> = {};
      for (const [key, url] of Object.entries(bundleMembers)) {
        if (omitMembers.has(bundleId)) continue;
        const texture = make(null);
        loaded.set(url, texture);
        resolved[key] = texture;
      }
      return resolved;
    },
    async loadAsset(url) {
      calls.loadAsset.push(url);
      await gate();
      if (failUrls.has(url)) throw new Error(`synthetic failure for ${url}`);
      const texture = make(null);
      loaded.set(url, texture);
      return texture;
    },
    async unloadBundle(bundleId) {
      calls.unloadBundle.push(bundleId);
      for (const url of Object.values(members.get(bundleId) ?? {})) {
        const texture = loaded.get(url);
        if (texture === undefined) continue;
        loaded.delete(url);
        destroy(texture, 'release');
      }
    },
    async unloadAsset(url) {
      calls.unloadAsset.push(url);
      const texture = loaded.get(url);
      if (texture === undefined) return;
      loaded.delete(url);
      destroy(texture, 'release');
    },
    createFallbackTexture(recipe) {
      calls.createFallbackTexture.push(recipe);
      return make(recipe);
    },
    destroyTexture: (texture) => destroy(texture, 'loader'),
  };

  return {
    runtime,
    calls,
    live,
    holdLoads() {
      if (held !== null) return;
      let open: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      held = { promise, open };
    },
    releaseLoads() {
      const current = held;
      held = null;
      current?.open();
    },
  };
}
