/**
 * The PixiJS asset service: lazy bundles, reference-counted, with procedural
 * fallbacks and a bounded diagnostic report.
 *
 * ## The shape
 *
 * `createAssetLoader` owns four things and delegates the rest:
 *
 * 1. **Reference counting per bundle.** Two worlds can hold `common` at once, and
 *    unloading on the first release would blank the second one's textures. A count
 *    is the only thing that gets that right, and it is the same reason the *texture*
 *    ownership below is a count rather than a flag.
 * 2. **Idempotence.** One in-flight promise per bundle id. A second `loadBundle`
 *    while the first is still awaiting the network joins it rather than starting a
 *    second load, which is also the only way a rapid mount/unmount/mount cycle does
 *    not issue two fetches for the same six files.
 * 3. **Required versus optional.** An optional entry that will not load becomes a
 *    procedural texture and a recorded gap. A required entry that will not load
 *    becomes a *reported* failure, never a rejected promise - see below.
 * 4. **Explicit release.** `unloadBundle` destroys what the bundle owns and does not
 *    destroy what a live sprite is still holding. See "Ownership" for the exact
 *    decision, because the honest answer is two different owners rather than one.
 *
 * Everything that touches PixiJS is behind {@link PixiAssetRuntime}. That is not
 * architecture for its own sake: `tests/phase9/pixi-host-boundary.test.ts` pins
 * `src/renderers/pixi/**` to *exactly two* files that name the engine - the binding
 * and the scene - and a third would have turned a reviewed decision into a red gate.
 * So the engine is named in `../runtime/createPixiApplication.ts`, the module this
 * tree already designates as its single binding point, and this file is a third kind
 * of module: renderer-tree, engine-free, policy. The payoff is that the reference
 * counting, the idempotence, the required/optional split, the ownership rules and the
 * bounded diagnostic are all exercised without a GPU, a DOM, or a network, in
 * `tests/phase10/asset-loader.test.ts`.
 *
 * ## `loadBundle` does not reject
 *
 * The plan's exit criterion is "missing optional media does not break a route", and
 * the natural way to honour it - a bundle load that rejects - puts the throw in a
 * promise a world mount is awaiting, which becomes an unhandled rejection and a
 * blank canvas with a console line nobody reads. So this service never rejects on a
 * media condition. It resolves with an {@link AssetBundleReport}, whose `ok` is
 * `false` when a required entry failed, and it calls `onFailure` once per distinct
 * failure signature.
 *
 * The only things it throws for are programming errors with no media in them: an
 * unknown bundle id, and a manifest that is not shippable. Those are bugs in a route
 * or in this repository, not conditions in the world, and a silent report for either
 * would be a bug that survives to a learner.
 *
 * ## Ownership: two owners, and the rule between them
 *
 * A texture can end up here two ways, and the two have genuinely different owners.
 *
 * - **PixiJS loaded it.** `Assets.loadBundle` / `Assets.load` produced it and put it
 *   in Pixi's cache. The runtime releases it, and releases it *by destroying it*:
 *   Pixi's texture parsers implement `unload` as `texture.destroy(true)`, so
 *   `unloadBundle` and `unload` free the GPU memory rather than merely dropping a
 *   cache entry. The loader therefore does not destroy these - doing so twice is a
 *   use-after-free, not belt and braces.
 * - **The loader made it.** A procedural fallback is a canvas the loader drew and a
 *   texture the loader built from it. Nothing else knows it exists, so the loader
 *   owns it and destroys it directly.
 *
 * The rule between the two is that a *bundle* release is all-or-nothing, because
 * `unloadBundle` destroys everything in it and there is no way to keep one member. So
 * if any texture in the bundle is still retained, the release is **deferred** until
 * the last retain is dropped. The alternative - destroying the retained texture and
 * handing a live sprite a dead handle - is exactly the failure this shape exists to
 * prevent, and it is why {@link PixiAssetLoader.retainTexture} exists at all.
 *
 * A retain is explicit because the loader cannot know about sprites. A scene that
 * needs a texture to outlive its bundle takes a lease before it makes the sprite and
 * drops it when the sprite is destroyed; a scene that tears down in bundle order -
 * which is what `WorldScene.destroy` already requires - never needs one.
 *
 * ## Diagnostics are bounded, and that is a requirement rather than a nicety
 *
 * A missing asset is discovered on the load path, and the load path is exactly where
 * a repeated failure would otherwise turn a log into a leak: a route that retries,
 * a world remounted twenty times, a tab left open. So a failure is recorded against
 * a **signature** of `(bundleId, key, kind)`, and a repeat increments a counter
 * rather than appending a line. The distinct-signature set is itself capped, and past
 * that cap the counters still move while the notification stops. The report is
 * therefore bounded by a constant, not by how long the tab was open.
 *
 * It is also **sanitized**: a record carries the bundle id, the manifest key, a
 * closed `kind`, and a count. Never a path, never a URL, never a caught error's
 * message - an error message from a fetch carries the request URL, and a request URL
 * is the one place in this service where a caller could have put something. Manifest
 * keys are compile-time constants from `assetManifest.ts`; nothing a learner or a
 * sprite path can reach ever gets here.
 *
 * ## Cross-references
 *
 * - `assetManifest.ts` is the data this acts on, and explains why the world bundles
 *   carry keys and recipes but no files.
 * - `tests/phase10/asset-loader.test.ts` covers the ref counting, the idempotent
 *   concurrent load, the optional-missing fallback, the required-missing report, the
 *   deferred release, and the bounded diagnostic.
 * - `tests/phase10/asset-manifest.test.ts` covers the manifest against the media
 *   registry and re-derives the same-origin and licence-class rules from source.
 * - `../runtime/createPixiApplication.ts` is the PixiJS implementation of
 *   {@link PixiAssetRuntime}, and the reason this file names no engine.
 */
import { resolveCozyWorldTheme } from '../runtime/cozyWorldTheme';
import type { CozyWorldTheme } from '../runtime/cozyWorldTheme';
import {
  ASSET_BUNDLES,
  findAssetManifestProblems,
  type AssetBundleDefinition,
  type AssetBundleId,
  type AssetManifestEntry,
} from './assetManifest';

/* -------------------------------------------------------------------------- */
/* The runtime port                                                            */
/* -------------------------------------------------------------------------- */

/** A fallback recipe with every Cozy token already resolved to a number. */
export interface ResolvedFallbackRecipe {
  readonly kind: AssetManifestEntry['fallback']['kind'];
  readonly fill: number;
  readonly stroke: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** The Cozy panel radius, so a recipe never pins its own copy of a token. */
  readonly radiusPx: number;
}

/**
 * The engine operations this service needs, with no engine in them.
 *
 * Generic in the texture type so a PixiJS caller gets `Texture` back from
 * {@link PixiAssetLoader.getTexture} rather than `unknown`, and a test gets a plain
 * object it can assert on. The two release methods have contracts, stated here
 * because the loader depends on them and cannot check them:
 *
 * - {@link PixiAssetRuntime.unloadBundle} and {@link PixiAssetRuntime.unloadAsset}
 *   must **destroy** the textures they release, not merely drop them from a cache.
 *   PixiJS does this; a double that only forgets a cache entry is not a valid
 *   implementation and the "unload releases textures" test would pass for the wrong
 *   reason.
 * - {@link PixiAssetRuntime.destroyTexture} is for textures *this* service created.
 *   It is never called for a texture the runtime loaded, because that one is already
 *   destroyed by the release call and destroying it twice is a use-after-free.
 */
export interface PixiAssetRuntime<TTexture> {
  /** Register a bundle's strictly-required members so they can be released as a unit. */
  registerBundle(bundleId: string, members: Readonly<Record<string, string>>): void;
  /** Load a registered bundle. Rejects if any member fails - that is why they are required. */
  loadBundle(bundleId: string): Promise<Readonly<Record<string, TTexture>>>;
  /** Load one member on its own, so its failure cannot reject the bundle. */
  loadAsset(url: string): Promise<TTexture>;
  /** Release a bundle: destroy its textures and drop them from the cache. */
  unloadBundle(bundleId: string): Promise<void>;
  /** Release one member: destroy its texture and drop it from the cache. */
  unloadAsset(url: string): Promise<void>;
  /** Build the procedural stand-in for an entry that has no texture. */
  createFallbackTexture(recipe: ResolvedFallbackRecipe): TTexture;
  /** Destroy a texture this service created. Must be safe to call once. */
  destroyTexture(texture: TTexture): void;
}

/* -------------------------------------------------------------------------- */
/* Reports and diagnostics                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What can go wrong, as a closed set.
 *
 * Closed because a `kind` is what a sanitized record is built from, and a free-text
 * reason would put a caught error's message - and therefore a request URL - into a
 * log. Each member's text is fixed in {@link FAILURE_SUMMARY}.
 */
export type AssetFailureKind =
  | 'unknown-bundle'
  | 'required-missing'
  | 'optional-missing'
  | 'load-error';

/** The one sentence each failure kind is allowed to print. */
const FAILURE_SUMMARY: Readonly<Record<AssetFailureKind, string>> = Object.freeze({
  'unknown-bundle': 'a bundle id no manifest declares was asked for',
  'required-missing': 'a required bundle member could not be loaded and is falling back to procedural art',
  'optional-missing': 'an optional bundle member is missing and is falling back to procedural art',
  'load-error': 'a bundle load failed in a way the loader did not anticipate',
});

/**
 * One sanitized failure record.
 *
 * Bundle id, manifest key, closed kind, and how many times it has happened. There is
 * no path, no URL, and no message, and the cross-reference to
 * `tests/phase10/asset-loader.test.ts` is that a test asserts the absence of all
 * three.
 */
export interface AssetFailureRecord {
  readonly bundleId: string;
  readonly key: string;
  readonly kind: AssetFailureKind;
  /** How many times this signature has been observed. Grows; the list does not. */
  readonly count: number;
}

/** The outcome of one bundle load. Resolved, never rejected, for a media condition. */
export interface AssetBundleReport {
  readonly bundleId: string;
  /** False when a required member failed. The route still renders. */
  readonly ok: boolean;
  /** Keys that resolved to a loaded texture. */
  readonly loaded: readonly string[];
  /** Keys that will be drawn from their procedural recipe. */
  readonly fellBack: readonly string[];
  /** Keys that are required and did not load. A subset of `fellBack`. */
  readonly failed: readonly string[];
}

export interface AssetDiagnostics {
  readonly failures: readonly AssetFailureRecord[];
  /** Failures suppressed by the cap. Non-zero means the cap is doing work. */
  readonly droppedFailureCount: number;
  /** Signatures seen but not notified, because the notification set is full. */
  readonly mutedSignatureCount: number;
}

/** How many distinct failure records are retained. A constant, so the report is bounded. */
const MAX_FAILURE_RECORDS = 64;
/** How many distinct failures may notify a listener. Beyond this the counters still move. */
const MAX_NOTIFIED_SIGNATURES = 128;

export interface CreateAssetLoaderOptions<TTexture> {
  readonly runtime: PixiAssetRuntime<TTexture>;
  /** The theme the procedural recipes are drawn in. Defaults to the light Cozy theme. */
  readonly theme?: CozyWorldTheme;
  /**
   * The bundles to load from. Defaults to the shipped manifest.
   *
   * An input rather than a module constant, for two reasons. The loader is policy and
   * the manifest is data, and a policy that reaches into a module constant cannot be
   * pointed at anything else - which is exactly the "optional *file* is missing" case,
   * the one branch the shipped manifest cannot contain, because naming a file that is
   * not in the media registry is the thing the Phase 8 gate exists to prevent. And a
   * loader that owns its own key index, rather than reading `ASSET_KEY_OWNERS` from the
   * manifest module, cannot be handed a manifest whose keys disagree with that one.
   *
   * Validated on the way in with the same rules the manifest module applies to
   * itself: a bundle set with an unadmissible classification or a remote path throws
   * at construction rather than at the far end of a network round trip.
   */
  readonly bundles?: Readonly<Record<string, AssetBundleDefinition>>;
  /** Called once per distinct failure signature. Receives no path, URL, or message. */
  onFailure?: (record: AssetFailureRecord) => void;
  /** Where the one sanitized line per distinct signature goes. Defaults to `console.warn`. */
  logger?: (message: string) => void;
}

export interface PixiAssetLoader<TTexture> {
  /**
   * Load a bundle, or join the load already in flight, and take a reference on it.
   *
   * Never rejects for a media condition. An unknown id rejects, because it is a bug
   * in a route rather than a condition in the world.
   */
  loadBundle(bundleId: AssetBundleId): Promise<AssetBundleReport>;
  /**
   * Drop a reference. The bundle is released when the last one goes.
   *
   * Idempotent past zero: releasing a bundle that is not held is a no-op, so a
   * teardown that runs twice does not unload a bundle another world just loaded.
   */
  unloadBundle(bundleId: AssetBundleId): Promise<void>;
  /** The loaded texture for a key, or the procedural stand-in. `null` for an unknown key. */
  getTexture(key: string): TTexture | null;
  /**
   * Take a lease on the texture a key currently resolves to.
   *
   * A bundle will not release while any of its textures is retained, which is how a
   * sprite that outlives its bundle stays valid. Call `getTexture` first: a key with
   * nothing behind it has nothing to lease. Returns an idempotent release.
   */
  retainTexture(key: string): (() => void) | null;
  /** True while the bundle is loaded and holding at least one reference. */
  isLoaded(bundleId: AssetBundleId): boolean;
  /** The live reference count. Zero for a bundle that was never loaded. */
  refCount(bundleId: AssetBundleId): number;
  /** The last report for a bundle, or `null` if it has not been loaded since release. */
  report(bundleId: AssetBundleId): AssetBundleReport | null;
  /** A frozen snapshot of the sanitized, bounded failure log. */
  diagnostics(): AssetDiagnostics;
  /** Release everything, whatever the reference counts say. For a world host teardown. */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* The loader                                                                  */
/* -------------------------------------------------------------------------- */

/** One texture the loader is currently responsible for, and who is using it. */
interface OwnedTexture<TTexture> {
  texture: TTexture;
  /** True when this service created it and must destroy it directly. */
  readonly createdHere: boolean;
  /** Outstanding leases. A release is deferred while this is above zero. */
  retains: number;
  /**
   * The owning bundle has been released, or a real texture superseded this one.
   * Destroy as soon as `retains` reaches zero.
   */
  retired: boolean;
  /**
   * `destroyTexture` has been called.
   *
   * Separate from `retired` because the two are separate moments and a single flag
   * cannot express them: a texture is retired while something is still holding it, and
   * destroyed later. Keying the idempotence check on `retired` instead is the bug this
   * field exists to prevent - a retired-but-held texture would be destroyed by every
   * later caller.
   */
  destroyed: boolean;
}

interface BundleState<TTexture> {
  readonly definition: AssetBundleDefinition;
  refs: number;
  inFlight: Promise<AssetBundleReport> | null;
  report: AssetBundleReport | null;
  /** Textures this bundle handed out, by manifest key. */
  readonly textures: Map<string, OwnedTexture<TTexture>>;
  /** Members registered with the runtime, so release knows what to unload. */
  registered: boolean;
  /** Optional members that resolved, so release can unload each one. */
  loadedOptional: string[];
  /** A release was requested and is waiting on a retain. */
  releasePending: boolean;
}

/** Absolutised at construction, so a path in the manifest is never trusted twice. */
const BASE_URL = import.meta.env.BASE_URL;

/**
 * Build the same-origin URL for a manifest path.
 *
 * The manifest stores `assets/...` and this prefixes the deployment base, which is
 * `/` for the web build and `./` for Electron. It is a join rather than a template
 * so a base of `./` does not produce `.//assets`, and it is a function so there is
 * exactly one place the two halves meet.
 */
function assetUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

export function createAssetLoader<TTexture>(
  options: CreateAssetLoaderOptions<TTexture>,
): PixiAssetLoader<TTexture> {
  const { runtime, onFailure, logger } = options;
  const theme = options.theme ?? resolveCozyWorldTheme();
  const log = logger ?? ((message: string): void => console.warn(message));

  const bundles = options.bundles ?? ASSET_BUNDLES;
  const problems = findAssetManifestProblems(bundles);
  if (problems.length > 0) {
    // The same refusal the manifest module makes about itself, applied to whatever
    // was handed in. A loader that accepted an unadmissible entry would put the
    // failure at the far end of a network round trip instead of here.
    const first = problems[0];
    throw new TypeError(
      `The Pixi asset loader was given a manifest it will not load: ${problems.length} problem(s). First: ` +
        `bundle \`${first.bundleId}\` entry \`${first.key}\` violates ${first.rule} - ${first.detail}`,
    );
  }

  /** The key index, built from the bundle set this loader was given. */
  const keyOwners = new Map<string, AssetBundleId>();
  for (const bundle of Object.values(bundles)) {
    for (const item of bundle.entries) keyOwners.set(item.key, bundle.id);
  }

  const entryFor = (key: string): AssetManifestEntry | null => {
    const owner = keyOwners.get(key);
    if (owner === undefined) return null;
    return bundles[owner].entries.find((item) => item.key === key) ?? null;
  };

  const states = new Map<AssetBundleId, BundleState<TTexture>>();
  /** Procedural stand-ins, kept per key so two routes asking at once share one. */
  const fallbacks = new Map<string, OwnedTexture<TTexture>>();

  const failures = new Map<string, AssetFailureRecord>();
  const notified = new Set<string>();
  let droppedFailureCount = 0;
  let mutedSignatureCount = 0;

  /* ---------------------------------------------------------------------- */
  /* Diagnostics                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Record one failure, once per signature.
   *
   * The signature is what makes the log bounded: a route that remounts a hundred
   * times produces one record with a count of a hundred, not a hundred records. The
   * notification set is a second, separate bound, because a listener that is called
   * on every remount is exactly as bad as a log that grows.
   */
  function recordFailure(bundleId: string, key: string, kind: AssetFailureKind): void {
    const signature = `${bundleId}|${key}|${kind}`;
    const existing = failures.get(signature);
    if (existing !== undefined) {
      failures.set(signature, { ...existing, count: existing.count + 1 });
      return;
    }
    if (failures.size >= MAX_FAILURE_RECORDS) {
      droppedFailureCount += 1;
      return;
    }
    const record: AssetFailureRecord = { bundleId, key, kind, count: 1 };
    failures.set(signature, record);
    if (notified.has(signature)) return;
    if (notified.size >= MAX_NOTIFIED_SIGNATURES) {
      mutedSignatureCount += 1;
      return;
    }
    notified.add(signature);
    onFailure?.(record);
    // One line, one signature, no path. A learner's console is a shipped surface.
    log(`[pixi-assets] bundle \`${bundleId}\` key \`${key}\`: ${FAILURE_SUMMARY[kind]}.`);
  }

  /* ---------------------------------------------------------------------- */
  /* Fallbacks                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Draw a recipe, resolving its Cozy tokens and its radius here and nowhere else.
   *
   * The radius comes from the theme because the manifest deliberately does not carry
   * one: a second copy of `COZY_RADIUS_PX` in a data file would drift from the token
   * module without anything noticing.
   */
  function resolveRecipe(item: AssetManifestEntry): ResolvedFallbackRecipe {
    const { fallback } = item;
    return Object.freeze({
      kind: fallback.kind,
      fill: theme.color[fallback.fill],
      stroke: theme.color[fallback.stroke],
      widthPx: fallback.widthPx,
      heightPx: fallback.heightPx,
      radiusPx: theme.radius.md,
    });
  }

  /**
   * The record for a key's procedural stand-in, creating it if there is not one.
   *
   * The *record*, not the texture, because a record carries the lease count and the
   * retired flag and there has to be exactly one of those per texture. The first
   * version of this returned a `TTexture` and let the caller wrap it in a fresh
   * record, which produced two records for one texture: the bundle's release retired
   * the one it held, the cache's copy stayed live, and a route asking after the
   * release was handed a texture that had already been destroyed. `tests/phase10/asset-loader.test.ts`
   * is the test that found it.
   */
  function fallbackRecordFor(key: string): OwnedTexture<TTexture> {
    const existing = fallbacks.get(key);
    // A cached record that has already been retired is not handed back: the route
    // that asks after a release is asking for something to draw, and a destroyed
    // texture is the one thing it cannot use.
    if (existing !== undefined && !existing.retired) return existing;
    const item = entryFor(key);
    // Reachable only for a key `assetManifest.ts` validates at import. The guard is
    // here because the alternative is a TypeError three property reads later.
    if (item === null) throw new TypeError(`\`${key}\` is not an asset key any bundle declares.`);
    const owned: OwnedTexture<TTexture> = {
      texture: runtime.createFallbackTexture(resolveRecipe(item)),
      createdHere: true,
      retains: 0,
      retired: false,
      destroyed: false,
    };
    fallbacks.set(key, owned);
    return owned;
  }

  function fallbackFor(key: string): TTexture {
    return fallbackRecordFor(key).texture;
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  function stateFor(bundleId: AssetBundleId): BundleState<TTexture> | null {
    return states.get(bundleId) ?? null;
  }

  /**
   * The state for a bundle, created empty if it does not exist yet.
   *
   * Created by {@link retainTexture} as well as by {@link loadBundle}, and that is the
   * point: a route that asks for a texture before its bundle is loaded gets one - the
   * procedural stand-in - and that texture is a real object a sprite can be holding.
   * Without a state to defer against, a lease taken on it could not be honoured, and a
   * load followed by a release would destroy a texture a live sprite was drawing. An
   * empty state costs one map entry and no reference, so `unloadBundle` on it is still
   * a no-op and `isLoaded` is still false.
   */
  function ensureState(bundleId: AssetBundleId): BundleState<TTexture> | null {
    const existing = stateFor(bundleId);
    if (existing !== null) return existing;
    const definition = Object.hasOwn(bundles, bundleId) ? bundles[bundleId] : null;
    if (definition === null) return null;
    const state: BundleState<TTexture> = {
      definition,
      refs: 0,
      inFlight: null,
      report: null,
      textures: new Map(),
      registered: false,
      loadedOptional: [],
      releasePending: false,
    };
    states.set(bundleId, state);
    return state;
  }

  /**
   * The record backing a key: the bundle's own, or the cached procedural stand-in.
   *
   * Both maps hold the *same* record for a key that fell back - see
   * {@link fallbackRecordFor} - so this never returns two different lifecycles for one
   * texture.
   */
  function ownedTexture(state: BundleState<TTexture>, key: string): OwnedTexture<TTexture> | null {
    return state.textures.get(key) ?? fallbacks.get(key) ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Load                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * One load, whether it was started here or joined.
   *
   * Required members go through a Pixi bundle, because they are shipped media and a
   * failure among them is a packaging defect worth an all-or-nothing result.
   * Optional members are loaded one at a time instead, because
   * `loadBundle` rejects on its first failure and that rejection would take the
   * required members down with it - which is precisely the "missing optional media
   * breaks the route" defect the plan's exit criterion names.
   */
  async function performLoad(state: BundleState<TTexture>): Promise<AssetBundleReport> {
    const bundle = state.definition;
    const loaded: string[] = [];
    const fellBack: string[] = [];
    const failed: string[] = [];
    const textures = new Map<string, TTexture>();

    const required = bundle.entries.filter(
      (item): item is AssetManifestEntry & { path: string } =>
        item.path !== null && item.requirement === 'required',
    );
    const optional = bundle.entries.filter(
      (item): item is AssetManifestEntry & { path: string } =>
        item.path !== null && item.requirement === 'optional',
    );

    if (required.length > 0 && !state.registered) {
      const members: Record<string, string> = {};
      for (const item of required) members[item.key] = assetUrl(item.path);
      runtime.registerBundle(bundle.id, members);
      state.registered = true;
    }

    if (state.registered) {
      try {
        const resolved = await runtime.loadBundle(bundle.id);
        for (const item of required) {
          const texture = resolved[item.key];
          if (texture === undefined) {
            failed.push(item.key);
            fellBack.push(item.key);
            recordFailure(bundle.id, item.key, 'required-missing');
            continue;
          }
          textures.set(item.key, texture);
          loaded.push(item.key);
        }
      } catch {
        // A rejected bundle load is a rejected `loadBundle`, and every required
        // member is equally unavailable, so all of them take the same path. The
        // message is deliberately dropped: see the module header on sanitisation.
        for (const item of required) {
          failed.push(item.key);
          fellBack.push(item.key);
          recordFailure(bundle.id, item.key, 'required-missing');
        }
      }
    }

    for (const item of optional) {
      try {
        textures.set(item.key, await runtime.loadAsset(assetUrl(item.path)));
        loaded.push(item.key);
      } catch {
        fellBack.push(item.key);
        recordFailure(bundle.id, item.key, 'optional-missing');
      }
    }

    for (const item of bundle.entries) {
      if (textures.has(item.key)) {
        const owned: OwnedTexture<TTexture> = {
          texture: textures.get(item.key) as TTexture,
          createdHere: false,
          retains: 0,
          retired: false,
          destroyed: false,
        };
        state.textures.set(item.key, owned);
        // A fallback built before the real texture arrived is now dead weight, and
        // a route that asked for one during the load is very likely still holding
        // it, so it is retired rather than destroyed outright.
        retireOwned(fallbacks.get(item.key));
        continue;
      }
      // Either the entry has no file, or its file did not load. Either way the
      // recipe is the representation, and building it here means `getTexture` on a
      // bundle that never loaded still returns something to draw. The *cached record*
      // goes in, not a fresh wrapper, so there is one lease count and one retired
      // flag per texture.
      state.textures.set(item.key, fallbackRecordFor(item.key));
      if (!fellBack.includes(item.key)) fellBack.push(item.key);
    }

    state.loadedOptional = optional
      .filter((item) => textures.has(item.key))
      .map((item) => assetUrl(item.path));

    const report: AssetBundleReport = Object.freeze({
      bundleId: bundle.id,
      ok: failed.length === 0,
      loaded: Object.freeze(loaded),
      fellBack: Object.freeze(fellBack),
      failed: Object.freeze(failed),
    });
    state.report = report;
    return report;
  }

  /**
   * Not `async`, on purpose.
   *
   * An `async` function wraps whatever it returns in a promise of its own, so two
   * callers joining one in-flight load would get two *different* promise objects and
   * the only observable proof of idempotence would be "the runtime was called once" -
   * which is one level down from the property being asked for. Returning the stored
   * promise directly makes `loader.loadBundle(id) === loader.loadBundle(id)` true for
   * the second caller, so the guarantee is checkable from the outside.
   */
  function loadBundle(bundleId: AssetBundleId): Promise<AssetBundleReport> {
    const definition = Object.hasOwn(bundles, bundleId) ? bundles[bundleId] : null;
    if (definition === null) {
      recordFailure(String(bundleId), '<bundle>', 'unknown-bundle');
      return Promise.reject(
        new TypeError(
          `\`${String(bundleId)}\` is not a Pixi asset bundle. The declared ids are the five Phase 10 bundle sets ` +
            "plus the registry's `pixi-default`.",
        ),
      );
    }

    const state = ensureState(bundleId) as BundleState<TTexture>;
    state.refs += 1;
    // Two callers, one network request. This is the whole of the idempotence
    // requirement, and it is why the reference count is taken *before* the
    // in-flight check: a second caller is a second holder, not a second load.
    if (state.inFlight !== null) return state.inFlight;
    if (state.report !== null && state.refs > 0) return Promise.resolve(state.report);

    const current = state;
    const attempt = performLoad(current)
      .catch(() => {
        // `performLoad` already handles every media condition. Reaching here means
        // the runtime itself is broken - a `Texture.from` that threw, a resolver
        // that rejected for a non-asset reason - and the route still has to render.
        recordFailure(current.definition.id, '<bundle>', 'load-error');
        for (const item of current.definition.entries) {
          current.textures.set(item.key, {
            texture: fallbackFor(item.key),
            createdHere: true,
            retains: 0,
            retired: false,
            destroyed: false,
          });
        }
        const keys = current.definition.entries.map((item) => item.key);
        const report: AssetBundleReport = Object.freeze({
          bundleId: current.definition.id,
          ok: false,
          loaded: Object.freeze([]),
          fellBack: Object.freeze(keys),
          failed: Object.freeze(keys),
        });
        current.report = report;
        return report;
      })
      .finally(() => {
        current.inFlight = null;
      });
    current.inFlight = attempt;
    return attempt;
  }

  /* ---------------------------------------------------------------------- */
  /* Release                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Destroy a texture this service created. Idempotent, and never the runtime's. */
  function destroyOwned(owned: OwnedTexture<TTexture>): void {
    if (owned.destroyed) return;
    owned.destroyed = true;
    if (owned.createdHere) runtime.destroyTexture(owned.texture);
  }

  /**
   * Mark a texture as no longer wanted and destroy it if nothing is holding it.
   *
   * The two steps are separate on purpose. `retired` is the decision and
   * `destroyed` is the act, and a texture that is retired while a lease is
   * outstanding is destroyed by the *last* release - so a bundle release that arrives
   * mid-frame cannot hand a live sprite a dead handle.
   */
  function retireOwned(owned: OwnedTexture<TTexture> | undefined): void {
    if (owned === undefined || owned.retired) return;
    owned.retired = true;
    if (owned.retains > 0) return;
    destroyOwned(owned);
  }

  /**
   * The actual release. Only reached when nothing in the bundle is retained.
   *
   * Split in two on purpose. The runtime destroys everything Pixi loaded - via
   * `unloadBundle` for the required members and `unloadAsset` for each optional one
   * that resolved - and this service destroys the fallbacks it created. The two sets
   * are disjoint, and calling `destroyTexture` on a runtime-owned texture would be a
   * second `destroy(true)` on an object that has already been destroyed.
   */
  async function performRelease(state: BundleState<TTexture>): Promise<void> {
    if (state.registered) {
      try {
        await runtime.unloadBundle(state.definition.id);
      } catch {
        // A release that throws must not strand the rest of the teardown. The
        // evidence is that the route came back with a blank world next time, which
        // is the symptom the browser lane looks for.
      }
      state.registered = false;
    }
    for (const url of state.loadedOptional) {
      try {
        await runtime.unloadAsset(url);
      } catch {
        // Same reasoning, per member.
      }
    }
    state.loadedOptional = [];

    // Only what this service created. Everything the runtime loaded is already
    // destroyed by the release above, and destroying it again is a use-after-free.
    for (const owned of state.textures.values()) retireOwned(owned);
    state.textures.clear();
    state.report = null;
  }

  async function unloadBundle(bundleId: AssetBundleId): Promise<void> {
    const state = stateFor(bundleId);
    // Releasing what is not held is a no-op rather than an error: teardown runs
    // twice under StrictMode, and a second `unloadBundle` must not unload a bundle
    // a different world has just taken a reference on.
    if (state === null || state.refs === 0) return;
    state.refs -= 1;
    if (state.refs > 0) return;

    // A load still in flight owns textures this unload has never seen. Waiting is
    // the only ordering that does not strand them, and the caller is already in an
    // async teardown.
    if (state.inFlight !== null) {
      try {
        await state.inFlight;
      } catch {
        // The load records its own failures; there is nothing to add here.
      }
    }

    if (hasRetained(state)) {
      state.releasePending = true;
      return;
    }
    await performRelease(state);
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  function getTexture(key: string): TTexture | null {
    if (!keyOwners.has(key)) return null;
    const bundleId = keyOwners.get(key) as AssetBundleId;
    const state = stateFor(bundleId);
    const owned = state === null ? null : ownedTexture(state, key);
    if (owned !== null && !owned.retired) return owned.texture;
    // Either the bundle was never loaded, or it was released and the texture the
    // caller remembers is gone. A fresh procedural texture is the answer that keeps
    // the route drawing rather than a `null` it would have to handle.
    return fallbackFor(key);
  }

  function retainTexture(key: string): (() => void) | null {
    const bundleId = keyOwners.get(key);
    if (bundleId === undefined) return null;
    // Created if absent: the texture a route is holding may be a stand-in it asked for
    // before the bundle was ever loaded, and that still needs something to defer
    // against. See {@link ensureState}.
    const state = ensureState(bundleId);
    if (state === null) return null;
    const owned = ownedTexture(state, key);
    if (owned === null || owned.retired) return null;
    owned.retains += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      owned.retains -= 1;
      if (owned.retains > 0) return;
      // The last lease on a texture that was already marked unwanted.
      if (owned.retired) {
        destroyOwned(owned);
        if (fallbacks.get(key) === owned) fallbacks.delete(key);
      }
      if (state.releasePending && !hasRetained(state)) {
        state.releasePending = false;
        void performRelease(state);
      }
    };
  }

  /**
   * Whether anything in this bundle is still leased.
   *
   * Both maps, and the second one is not redundant: a route can ask for a key before
   * its bundle is ever loaded, get the procedural stand-in, and hold it - and that
   * texture lives in `fallbacks` with no entry in `state.textures` at all. Scoped by
   * key owner so one world's lease cannot defer another world's release.
   */
  function hasRetained(state: BundleState<TTexture>): boolean {
    for (const owned of state.textures.values()) {
      if (owned.retains > 0) return true;
    }
    for (const [key, owned] of fallbacks) {
      if (owned.retains > 0 && keyOwners.get(key) === state.definition.id) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                                */
  /* ---------------------------------------------------------------------- */

  async function dispose(): Promise<void> {
    for (const state of states.values()) {
      if (state.inFlight !== null) {
        try {
          await state.inFlight;
        } catch {
          // Already reported by the load path.
        }
      }
      state.refs = 0;
      state.releasePending = false;
      await performRelease(state);
    }
    states.clear();
    // Fallbacks outlive individual bundles on purpose: a key's recipe is the
    // representation of that key wherever it is used. They are released here, which
    // is the only place the loader is entitled to say it is finished.
    for (const [key, owned] of [...fallbacks.entries()]) {
      if (owned.retains > 0) {
        owned.retired = true;
        continue;
      }
      fallbacks.delete(key);
      destroyOwned(owned);
    }
  }

  return {
    loadBundle,
    unloadBundle,
    getTexture,
    retainTexture,
    isLoaded: (bundleId) => (stateFor(bundleId)?.refs ?? 0) > 0,
    refCount: (bundleId) => stateFor(bundleId)?.refs ?? 0,
    report: (bundleId) => stateFor(bundleId)?.report ?? null,
    diagnostics: () =>
      Object.freeze({
        failures: Object.freeze([...failures.values()].map((record) => Object.freeze({ ...record }))),
        droppedFailureCount,
        mutedSignatureCount,
      }),
    dispose,
  };
}
