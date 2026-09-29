/**
 * Phase 10: the Pixi asset loader's policy, against a plain-object runtime.
 *
 * ## What this file establishes, and what it deliberately does not
 *
 * Established, and every assertion below is about a real decision the service makes:
 * reference counting, one in-flight promise per bundle id, the required/optional
 * split, the deferred release that keeps a leased texture alive, the ownership split
 * between runtime-loaded and loader-created textures, and a diagnostic that is both
 * sanitized and bounded.
 *
 * Not established, and said here rather than left for someone to assume: GPU memory,
 * a real network fetch, and what a browser does with a 404. The last one is the point
 * of the optional-missing case - a synthetic rejection stands in for it because a
 * real one would make this file a network test, and because a *silent* absence (a
 * bundle that resolves without a member) is a different code path from a rejected
 * load and is exercised separately below. The real PixiJS binding is covered, for the
 * parts that need no network, in `tests/phase10/pixi-asset-runtime.test.ts`.
 *
 * ## Why a double and not a reimplementation
 *
 * The loader's whole job is bookkeeping, and bookkeeping is only worth testing where
 * the state is reachable. `createAssetLoader` takes its runtime as a parameter and is
 * generic in the texture type, so the entire policy runs in this file with no GPU, no
 * DOM, and no engine import - which is also why `src/renderers/pixi/assets/` can hold
 * a renderer-neutral service at all.
 *
 * ## Hermeticity and privacy
 *
 * No network, no `dist/`, no git, no spawned process, no clock. The only state is the
 * fake runtime's own counters. The diagnostic assertions are the privacy assertions
 * too: they check that a failure record cannot carry a path, a URL, or a message,
 * because a fetch error's message *is* the request URL.
 */
import { describe, expect, it } from 'vitest';

import { createAssetLoader } from '@/renderers/pixi/assets/AssetLoader';
import { ASSET_BUNDLES, type AssetBundleDefinition } from '@/renderers/pixi/assets/assetManifest';
import type { AssetFailureRecord } from '@/renderers/pixi/assets/AssetLoader';

import { createFakeAssetRuntime, type FakeTexture, type FakeRuntimeOptions } from './support/fakeAssetRuntime';

/** Everything a test needs: the double, the loader under it, and what it reported. */
interface Harness {
  readonly fake: ReturnType<typeof createFakeAssetRuntime>;
  readonly loader: ReturnType<typeof createAssetLoader<FakeTexture>>;
  readonly failures: AssetFailureRecord[];
  readonly logs: string[];
}

function harness(options: FakeRuntimeOptions = {}): Harness {
  const fake = createFakeAssetRuntime(options);
  const failures: AssetFailureRecord[] = [];
  const logs: string[] = [];
  const loader = createAssetLoader<FakeTexture>({
    runtime: fake.runtime,
    onFailure: (record) => failures.push(record),
    logger: (message) => logs.push(message),
  });
  return { fake, failures, logs, loader };
}

/** The default bundle: the six registry-admitted procedural placeholders. */
const DEFAULT = 'pixi-default';
/** A thin bundle: three keys, no files, so nothing is ever requested for it. */
const VILLAGE = 'village';

describe('a load is lazy, and a thin bundle requests nothing', () => {
  it('the default bundle registers its required members and loads them', async () => {
    const { fake, loader } = harness();
    const report = await loader.loadBundle(DEFAULT);

    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.loaded.length, 'the six registry placeholders').toBe(6);
    expect(fake.calls.registerBundle).toEqual([DEFAULT]);
    expect(fake.calls.loadBundle).toEqual([DEFAULT]);
    expect(loader.isLoaded(DEFAULT)).toBe(true);
  });

  it('a bundle with no files registers nothing and fetches nothing', async () => {
    const { fake, loader } = harness();
    const report = await loader.loadBundle(VILLAGE);

    expect(report.ok).toBe(true);
    expect(report.loaded, 'a key with no file is never loaded').toEqual([]);
    expect(report.fellBack.length, 'every key falls back').toBe(
      ASSET_BUNDLES[VILLAGE].entries.length,
    );
    expect(fake.calls.registerBundle, 'an empty bundle must not be registered').toEqual([]);
    expect(fake.calls.loadBundle).toEqual([]);
    expect(fake.calls.loadAsset, 'no file means no request').toEqual([]);
    // And it still produces drawable textures, which is the whole point of it.
    for (const entry of ASSET_BUNDLES[VILLAGE].entries) {
      expect(loader.getTexture(entry.key)).not.toBeNull();
    }
  });

  it('getTexture draws a fallback before any load, and returns null for a key nothing owns', async () => {
    const { loader } = harness();
    // A route that asks before its bundle resolves must still have something to
    // draw; that is the "missing optional media does not break a route" criterion
    // stated for the case where there is no request at all.
    expect(loader.getTexture('village-signpost')).not.toBeNull();
    expect(loader.getTexture('no-such-key')).toBeNull();
  });
});

describe('reference counting, because two worlds can hold one bundle', () => {
  it('the bundle survives the first release and goes on the last', async () => {
    const { fake, loader } = harness();
    await loader.loadBundle(DEFAULT);
    await loader.loadBundle(DEFAULT);
    expect(loader.refCount(DEFAULT)).toBe(2);

    await loader.unloadBundle(DEFAULT);
    expect(fake.calls.unloadBundle, 'one holder left, so nothing is released').toEqual([]);
    expect(loader.isLoaded(DEFAULT)).toBe(true);
    expect(loader.getTexture('cozy-moss-grass')).not.toBeNull();

    await loader.unloadBundle(DEFAULT);
    expect(fake.calls.unloadBundle).toEqual([DEFAULT]);
    expect(loader.isLoaded(DEFAULT)).toBe(false);
    expect(loader.refCount(DEFAULT)).toBe(0);
  });

  it('releasing a bundle nobody holds is a no-op, not an unload', async () => {
    // StrictMode runs teardown twice, and a second `unloadBundle` must not release a
    // bundle a different world has just taken a reference on.
    const { fake, loader } = harness();
    await loader.unloadBundle(DEFAULT);
    expect(fake.calls.unloadBundle).toEqual([]);

    await loader.loadBundle(DEFAULT);
    await loader.unloadBundle(DEFAULT);
    await loader.unloadBundle(DEFAULT);
    expect(fake.calls.unloadBundle).toEqual([DEFAULT]);
  });

  it('a reload after a release fetches again rather than serving a destroyed texture', async () => {
    const { fake, loader } = harness();
    await loader.loadBundle(DEFAULT);
    await loader.unloadBundle(DEFAULT);
    const first = fake.calls.loadBundle.length;

    const report = await loader.loadBundle(DEFAULT);
    expect(fake.calls.loadBundle.length).toBe(first + 1);
    expect(report.ok).toBe(true);
  });
});

describe('a concurrent load is one load', () => {
  it('two callers share the in-flight promise and the runtime is called once', async () => {
    const { fake, loader } = harness();
    fake.holdLoads();

    const first = loader.loadBundle(DEFAULT);
    const second = loader.loadBundle(DEFAULT);
    // Identity, not just equivalence: the loader returns the stored promise rather
    // than an `async` function's re-wrap, so "one in-flight promise" is observable
    // from outside instead of only through the runtime's call count.
    expect(second, 'a second caller must join the first, not wrap it').toBe(first);
    expect(loader.refCount(DEFAULT), 'two callers are two holders').toBe(2);

    fake.releaseLoads();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(fake.calls.loadBundle, 'one network operation, not two').toEqual([DEFAULT]);
  });

  it('a load that resolves before a second caller arrives still counts as a reference', async () => {
    const { fake, loader } = harness();
    await loader.loadBundle(DEFAULT);
    const second = loader.loadBundle(DEFAULT);
    await second;
    expect(fake.calls.loadBundle).toEqual([DEFAULT]);
    expect(loader.refCount(DEFAULT)).toBe(2);
  });

  it('a release that arrives mid-load waits for it, rather than stranding its textures', async () => {
    const { fake, loader } = harness();
    fake.holdLoads();
    const loading = loader.loadBundle(DEFAULT);
    const releasing = loader.unloadBundle(DEFAULT);
    fake.releaseLoads();
    await loading;
    await releasing;
    // The textures the in-flight load created are released by the pending unload,
    // not orphaned by a release that ran before they existed.
    expect(fake.calls.unloadBundle).toEqual([DEFAULT]);
    expect(fake.live.size, 'nothing is left alive').toBe(0);
  });
});

describe('a missing optional member falls back and does not throw', () => {
  /**
   * A bundle with an optional *file* in it.
   *
   * The shipped manifest cannot contain one: naming a file is a claim about the
   * media registry, and the only file any bundle may name today is a `pixi-default`
   * member, which is `required`. So the branch is exercised against a synthetic
   * manifest - which is also the reason the loader takes its bundle set as an input
   * rather than reading a module constant.
   */
  const OPTIONAL_BUNDLE: Readonly<Record<string, AssetBundleDefinition>> = Object.freeze({
    village: {
      id: 'village',
      description: 'synthetic bundle with one optional file and one required file',
      entries: [
        {
          key: 'synthetic-optional',
          path: 'assets/cozy/cozy-moss-grass.svg',
          requirement: 'optional',
          licenseClass: 'procedural',
          fallback: { kind: 'tile', fill: 'surfacePage', stroke: 'borderControl', widthPx: 8, heightPx: 8 },
        },
        {
          key: 'synthetic-required',
          path: 'assets/cozy/cozy-ink-panel.svg',
          requirement: 'required',
          licenseClass: 'procedural',
          fallback: { kind: 'rounded-panel', fill: 'surfacePanel', stroke: 'borderStrong', widthPx: 8, heightPx: 8 },
        },
      ],
    },
  } as const);

  it('an optional file that will not load is a recorded gap and a fallback, not a failure', async () => {
    const { fake, failures, logs } = harness({
      failUrls: ['/assets/cozy/cozy-moss-grass.svg'],
    });
    const withBundle = createAssetLoader<FakeTexture>({
      runtime: fake.runtime,
      bundles: OPTIONAL_BUNDLE,
      onFailure: (record) => failures.push(record),
      logger: (message) => logs.push(message),
    });

    // Resolves. Not rejects: a rejected load inside a world mount is an unhandled
    // rejection and a blank canvas, which is the defect this split exists to avoid.
    const report = await withBundle.loadBundle(VILLAGE);
    expect(report.ok, 'an optional member is not a failure').toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.fellBack).toContain('synthetic-optional');
    expect(report.loaded, 'the required member beside it still loaded').toContain(
      'synthetic-required',
    );

    expect(failures.map((f) => f.kind)).toEqual(['optional-missing']);
    expect(logs).toHaveLength(1);
    // Drawn from the recipe rather than from a hole in the world.
    expect(withBundle.getTexture('synthetic-optional')).not.toBeNull();
  });

  it('an optional file is loaded on its own, so its failure cannot reject the bundle', async () => {
    // The reason optional members do not go through `registerBundle`/`loadBundle`:
    // `loadBundle` rejects on its first failure, and that rejection would take the
    // required members down with it.
    const { fake, loader } = harness();
    const withBundle = createAssetLoader<FakeTexture>({
      runtime: fake.runtime,
      bundles: OPTIONAL_BUNDLE,
      logger: () => undefined,
    });
    await withBundle.loadBundle(VILLAGE);
    expect(fake.calls.registerBundle).toEqual([VILLAGE]);
    expect(fake.calls.loadBundle).toEqual([VILLAGE]);
    expect(fake.calls.loadAsset, 'the optional member went through its own load').toEqual([
      '/assets/cozy/cozy-moss-grass.svg',
    ]);
    expect(loader.isLoaded(VILLAGE), 'the other loader never saw this bundle').toBe(false);
  });

  it('a released optional member is unloaded individually', async () => {
    const { fake, loader } = harness();
    const withBundle = createAssetLoader<FakeTexture>({
      runtime: fake.runtime,
      bundles: OPTIONAL_BUNDLE,
      logger: () => undefined,
    });
    await withBundle.loadBundle(VILLAGE);
    await withBundle.unloadBundle(VILLAGE);
    expect(fake.calls.unloadAsset).toEqual(['/assets/cozy/cozy-moss-grass.svg']);
    expect(fake.live.size).toBe(0);
    expect(loader.diagnostics().failures).toEqual([]);
  });

  it('a manifest the loader will not load is refused at construction', async () => {
    // The validation is not decoration: a bundle set carrying an unadmissible
    // classification has to fail here, not at the first request.
    const { fake } = harness();
    expect(() =>
      createAssetLoader<FakeTexture>({
        runtime: fake.runtime,
        bundles: {
          village: {
            id: 'village',
            description: 'synthetic, and not admissible',
            entries: [
              {
                key: 'synthetic-bad',
                path: 'https://cdn.example.invalid/a.svg',
                requirement: 'optional',
                licenseClass: 'procedural',
                fallback: { kind: 'tile', fill: 'surfacePage', stroke: 'borderControl', widthPx: 8, heightPx: 8 },
              },
            ],
          },
        } as never,
        logger: () => undefined,
      }),
    ).toThrow(/remote-or-unsafe-path/);
  });

  it('a required member that fails is reported, not thrown, and the route still draws', async () => {
    const { failures, logs, loader } = harness({ failBundles: [DEFAULT] });
    // The promise resolves. That is the whole exit criterion: a rejected load inside
    // a world mount is an unhandled rejection and a blank canvas.
    const report = await loader.loadBundle(DEFAULT);
    expect(report.ok).toBe(false);
    expect(report.failed.length, 'every required member is reported').toBe(6);
    expect(report.fellBack.length, 'and every one of them falls back').toBe(6);
    expect(failures.map((f) => f.kind)).toEqual(Array.from({ length: 6 }, () => 'required-missing'));
    expect(logs.length, 'one line per distinct failure, not one per member load').toBe(6);
    expect(loader.getTexture('cozy-moss-grass')).not.toBeNull();
  });

  it('a member silently absent from a successful bundle load is treated as missing', async () => {
    // A different path from a rejection: `loadBundle` resolved, the member was not in
    // the result, and a loader that only looked at the promise would hand out
    // `undefined` to a sprite.
    const { failures, loader } = harness({ omitBundleMembers: [DEFAULT] });
    const report = await loader.loadBundle(DEFAULT);
    expect(report.ok).toBe(false);
    expect(report.failed.length).toBe(6);
    expect(failures.every((f) => f.kind === 'required-missing')).toBe(true);
    for (const entry of ASSET_BUNDLES[DEFAULT].entries) {
      expect(loader.getTexture(entry.key), entry.key).not.toBeNull();
    }
  });

  it('a fallback built before a load finishes is retired when the real texture arrives', async () => {
    // The route asked, got procedural art, and the real texture arrived a moment
    // later. The placeholder is now dead weight the loader owns, so it has to go -
    // otherwise a world that mounts before its bundle resolves leaks a canvas per key
    // on every mount.
    const { fake, loader } = harness();
    const placeholder = loader.getTexture('cozy-moss-grass');
    expect(placeholder).not.toBeNull();
    expect(fake.calls.createFallbackTexture).toHaveLength(1);

    const report = await loader.loadBundle(DEFAULT);
    expect(report.loaded).toContain('cozy-moss-grass');
    expect(fake.calls.destroyTexture, 'the superseded placeholder is destroyed').toEqual([
      (placeholder as FakeTexture).id,
    ]);
    // And the key now resolves to the loaded texture rather than the placeholder.
    expect(loader.getTexture('cozy-moss-grass')).not.toBe(placeholder);
  });

  it('a placeholder a live sprite still holds is retired, not destroyed', async () => {
    const { fake, loader } = harness();
    loader.getTexture('cozy-moss-grass');
    const release = loader.retainTexture('cozy-moss-grass');
    await loader.loadBundle(DEFAULT);

    expect(fake.calls.destroyTexture, 'a held placeholder survives the real texture').toEqual([]);
    (release as () => void)();
    expect(fake.calls.destroyTexture, 'and goes on the last release').toHaveLength(1);
  });

  it('a lease taken before the bundle was ever loaded still defers its release', async () => {
    // The awkward ordering, and a real one: a route mounts, asks for a key, and draws
    // the procedural stand-in; the bundle finishes loading a moment later; the route
    // goes away. Without a lease the placeholder is dead weight, and with one the
    // release has to wait for it - which it can only know about if the check covers a
    // texture that never reached the bundle's own map.
    const { fake, loader } = harness();
    const placeholder = loader.getTexture('village-signpost');
    const release = loader.retainTexture('village-signpost');
    expect(release, 'a stand-in is leasable before its bundle exists').not.toBeNull();

    await loader.loadBundle(VILLAGE);
    await loader.unloadBundle(VILLAGE);
    expect(fake.calls.destroyTexture, 'a held stand-in is not destroyed by the release').toEqual([]);
    (release as () => void)();
    expect(fake.calls.destroyTexture).toContain((placeholder as FakeTexture).id);
  });

  it('a key asked for after a release gets a new texture, not a destroyed one', async () => {
    // The route-does-not-break-a-world case, one release later. Handing back the
    // texture the release just destroyed would give a sprite a dead handle, which is
    // worse than never having had one.
    const { fake, loader } = harness();
    await loader.loadBundle(VILLAGE);
    const before = loader.getTexture('village-signpost');
    await loader.unloadBundle(VILLAGE);

    const after = loader.getTexture('village-signpost');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(fake.calls.destroyTexture, 'the released one really was destroyed').toContain(
      (before as FakeTexture).id,
    );
    expect(fake.calls.destroyTexture).not.toContain((after as FakeTexture).id);
  });

  it('an unknown bundle id rejects, because that is a bug in a route and not a condition', async () => {
    const { failures, logs, loader } = harness();
    await expect(
      loader.loadBundle('no-such-bundle' as typeof DEFAULT),
    ).rejects.toBeInstanceOf(TypeError);
    // And it says so once, in the sanitized shape.
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe('unknown-bundle');
    expect(logs).toHaveLength(1);
  });
});

describe('release destroys what the bundle owns, and waits for what is held', () => {
  it('a full release destroys the runtime textures and the loader-created fallbacks', async () => {
    const { fake, loader } = harness();
    await loader.loadBundle(DEFAULT);
    // The fallbacks the loader created for the default bundle exist only because the
    // load failed for them; force one so both owners are represented in one release.
    await loader.loadBundle(VILLAGE);
    const beforeDestroy = fake.calls.destroyTexture.length;

    await loader.unloadBundle(VILLAGE);
    expect(fake.calls.destroyTexture.length, 'procedural textures are the loader\'s to destroy').toBe(
      beforeDestroy + ASSET_BUNDLES[VILLAGE].entries.length,
    );

    await loader.unloadBundle(DEFAULT);
    expect(fake.calls.unloadBundle).toEqual([DEFAULT]);
    expect(fake.live.size, 'nothing survives a full release').toBe(0);
  });

  it('the runtime destroys what it loaded; the loader does not destroy it again', async () => {
    // A second `destroy(true)` on an already-destroyed texture is a use-after-free,
    // so the ownership split is load-bearing and this is the assertion for it.
    const { fake, loader } = harness();
    await loader.loadBundle(DEFAULT);
    const loaded = fake.calls.loadBundle.length;
    expect(loaded).toBe(1);
    await loader.unloadBundle(DEFAULT);
    // Six members went through `unloadBundle`; none of them came back through
    // `destroyTexture`, which the fake would have recorded a second time.
    expect(fake.calls.destroyTexture).toEqual([]);
    expect(fake.live.size).toBe(0);
  });

  it('a retained texture defers the whole release until the last lease is dropped', async () => {
    const { fake, loader } = harness();
    await loader.loadBundle(VILLAGE);
    const texture = loader.getTexture('village-signpost');
    expect(texture).not.toBeNull();

    const release = loader.retainTexture('village-signpost');
    expect(release, 'a texture with a holder can be leased').not.toBeNull();
    const destroysBefore = fake.calls.destroyTexture.length;

    await loader.unloadBundle(VILLAGE);
    expect(fake.calls.unloadBundle, 'a held bundle is not released').toEqual([]);
    expect(fake.calls.destroyTexture.length, 'and nothing is destroyed while it is held').toBe(
      destroysBefore,
    );
    expect(loader.getTexture('village-signpost'), 'the sprite still has its texture').toBe(texture);

    (release as () => void)();
    // The release is asynchronous inside the loader; the destruction is what matters
    // and it is synchronous once the lease count reaches zero.
    expect(fake.calls.destroyTexture.length, 'the last lease releases it').toBeGreaterThan(
      destroysBefore,
    );
  });

  it('a lease is idempotent, and a second lease on the same key does not double-release', async () => {
    const { loader } = harness();
    await loader.loadBundle(VILLAGE);
    const first = loader.retainTexture('village-signpost');
    const second = loader.retainTexture('village-signpost');
    (first as () => void)();
    (first as () => void)();
    (second as () => void)();
    (second as () => void)();
    // A double release that decremented twice would drive the count negative and let
    // a later unload destroy a texture something still held. The route renders either
    // way, so what is asserted is that the loader survives the abuse.
    expect(loader.getTexture('village-signpost')).not.toBeNull();
  });

  it('an unknown key cannot be leased, and dispose releases everything', async () => {
    const { fake, loader } = harness();
    await loader.loadBundle(DEFAULT);
    await loader.loadBundle(VILLAGE);
    expect(loader.retainTexture('no-such-key')).toBeNull();

    await loader.dispose();
    expect(fake.calls.unloadBundle, 'every registered bundle is released').toEqual([DEFAULT]);
    expect(fake.live.size).toBe(0);
    expect(loader.refCount(DEFAULT)).toBe(0);
    expect(loader.refCount(VILLAGE)).toBe(0);
  });
});

describe('the diagnostic is sanitized and bounded', () => {
  it('a repeated failure is one record with a count, and one line, however many times it happens', async () => {
    // The hot path: a route that remounts, a world that retries. A log that appended
    // per attempt would grow for as long as the tab was open.
    const { failures, logs, loader } = harness({ failBundles: [DEFAULT] });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await loader.loadBundle(DEFAULT);
      await loader.unloadBundle(DEFAULT);
    }
    const after = loader.diagnostics();
    expect(after.failures.length, 'six members, not six times fifty').toBe(6);
    for (const record of after.failures) expect(record.count).toBe(50);
    expect(failures).toHaveLength(6);
    expect(logs, 'one line per distinct signature, not per attempt').toHaveLength(6);
  });

  it('a failure record carries no path, no URL, and no caught message', async () => {
    // The privacy assertion. A rejected fetch's `message` is its request URL, so the
    // record is built from a closed kind instead - and the synthetic failure message
    // here deliberately contains a path to make the point checkable.
    const { loader } = harness({ failBundles: [DEFAULT] });
    await loader.loadBundle(DEFAULT);
    const { failures } = loader.diagnostics();
    expect(failures.length).toBeGreaterThan(0);
    for (const record of failures) {
      const serialised = JSON.stringify(record);
      expect(serialised, 'a path in a diagnostic').not.toContain('/');
      expect(serialised).not.toContain('://');
      expect(serialised).not.toContain('assets/');
      expect(serialised, 'a caught error message in a diagnostic').not.toContain('synthetic');
      expect(Object.keys(record).sort()).toEqual(['bundleId', 'count', 'key', 'kind']);
      // The key is a manifest identifier, and it resolves to a real entry.
      expect(ASSET_BUNDLES[record.bundleId as 'village'].entries.map((e) => e.key)).toContain(
        record.key,
      );
    }
  });

  it('the snapshot is frozen, so a consumer cannot edit the record it was given', () => {
    const { loader } = harness();
    const snapshot = loader.diagnostics();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.failures)).toBe(true);
  });

  it('a report is frozen and reports the keys, not the paths', async () => {
    const { loader } = harness({ failBundles: [DEFAULT] });
    const report = await loader.loadBundle(DEFAULT);
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('assets/');
    expect(loader.report(DEFAULT)).toBe(report);
  });
});
