/**
 * Phase 10: the Pixi asset manifest, held to the media registry and to the rules
 * the loader's safety depends on.
 *
 * ## What this file is for
 *
 * `src/renderers/pixi/assets/assetManifest.ts` is a hand-authored data file, and a
 * hand-authored data file has no compiler protecting it. Three things can be true of
 * it and wrong at the same time - it can name an unregistered file, it can name a
 * remote one, and it can name a classification the registry does not admit - and the
 * TypeScript types catch none of them, because a string that *looks* like a path is a
 * valid string. So each rule is stated twice: once as a function the loader and the
 * importer rely on, and once here, re-derived over the raw file text.
 *
 * That doubling is the point, and it is the reason this file reads the source rather
 * than only calling the validator. `findAssetManifestProblems` is the same logic the
 * module runs at import; if it were the *only* check, a rule that was only enforced
 * in TypeScript would also be the only thing standing between a typo and a release,
 * and a test of a function testing itself proves the function returns what it
 * returns.
 *
 * ## The registry is the other half
 *
 * `public/assets/asset-licenses.json` is the authority on what may be a bundle
 * member. This file compares the two in the direction that is checkable today
 * (registry to manifest, in both bundle ids and the `pixi-default` membership, with
 * classifications compared). The bundle-id comparison used to record a **reported
 * gap** - the five Phase 10 sets were declared in this file and not in the registry -
 * and that gap is closed: the registry declares all six, in both directions. The
 * gap was asserted while it was open so that it could not quietly widen, and it was
 * replaced by the equality assertion in the same change that closed it.
 *
 * ## Hermeticity and privacy
 *
 * Reads two files inside the repository: the manifest and the registry. No `dist/`,
 * no network, no commit, no spawned process, no location-dependent value. Nothing here
 * reads learner data, and the only strings compared are asset keys, registry ids, and
 * asset paths.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSET_BUNDLE_IDS,
  ASSET_BUNDLES,
  ASSET_KEY_OWNERS,
  ASSET_LICENSE_CLASSES,
  DEFAULT_ASSET_BUNDLE_ID,
  findAssetEntry,
  findAssetManifestProblems,
  resolveAssetBundle,
  type AssetBundleDefinition,
  type AssetManifestEntry,
} from '@/renderers/pixi/assets/assetManifest';

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = 'src/renderers/pixi/assets/assetManifest.ts';
const REGISTRY_PATH = 'public/assets/asset-licenses.json';

const manifestSource = readFileSync(path.join(REPO_ROOT, MANIFEST_PATH), 'utf8');

interface RegistryEntry {
  readonly id: string;
  readonly path: string;
  readonly classification: string;
  readonly media: boolean;
  readonly pixiEligible: boolean;
  readonly bundles: readonly string[];
}

interface Registry {
  readonly bundles: Readonly<Record<string, { readonly paths: readonly string[] }>>;
  readonly assets: readonly RegistryEntry[];
}

const registry = JSON.parse(readFileSync(path.join(REPO_ROOT, REGISTRY_PATH), 'utf8')) as Registry;

/** Every entry in the manifest, flattened, with the bundle that declares it. */
function allEntries(): ReadonlyArray<{ readonly bundleId: string; readonly entry: AssetManifestEntry }> {
  return Object.values(ASSET_BUNDLES).flatMap((bundle) =>
    bundle.entries.map((entry) => ({ bundleId: bundle.id, entry })),
  );
}

/**
 * Remove comments the way the rest of the repository's source gates do.
 *
 * Needed because this file is allowed to *explain* the rules it checks - a comment
 * that says "no `https://` here" must not be a finding. The `//` form is anchored so a
 * `//` inside a string or a URL is not treated as a comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

describe('the manifest is not vacuous', () => {
  it('declares the six bundle ids, and the registry is a real file with a bundle block', () => {
    expect(ASSET_BUNDLE_IDS.length).toBe(6);
    expect([...ASSET_BUNDLE_IDS].sort()).toEqual([
      'common',
      'dungeon',
      'fishing',
      'pixi-default',
      'share-card',
      'village',
    ]);
    expect(Object.keys(ASSET_BUNDLES).sort()).toEqual([...ASSET_BUNDLE_IDS].sort());
    expect(allEntries().length).toBeGreaterThanOrEqual(6);
    // Non-vacuity on the other side: the comparison below is against real registry
    // data, not against an empty object.
    expect(Object.keys(registry.bundles).length).toBeGreaterThanOrEqual(1);
    expect(registry.assets.length).toBeGreaterThanOrEqual(90);
  });

  it('names the five Phase 10 bundle sets exactly, and keeps the registry default as the default', () => {
    // Spelled out rather than derived from ASSET_BUNDLE_IDS, so renaming an id is a
    // failure here and not a silent redefinition of the constant it is compared to.
    for (const id of ['common', 'village', 'dungeon', 'fishing', 'share-card']) {
      expect(ASSET_BUNDLE_IDS, `Phase 10 names \`${id}\``).toContain(id);
    }
    expect(registry.bundles['pixi-default'], 'the registry names the default bundle').toBeDefined();
    expect(DEFAULT_ASSET_BUNDLE_ID).toBe('pixi-default');
    expect(resolveAssetBundle(DEFAULT_ASSET_BUNDLE_ID)?.id).toBe('pixi-default');
  });
});

describe('every entry is admissible media', () => {
  it('every licenseClass is cc0-approved or procedural, in the data and in the source', () => {
    for (const { bundleId, entry } of allEntries()) {
      expect(ASSET_LICENSE_CLASSES, `${bundleId}/${entry.key}`).toContain(entry.licenseClass);
    }
    // Re-derived from the file text, so a class that reached the object some other
    // way is still a finding.
    const declared = [...manifestSource.matchAll(/licenseClass:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const value of declared) {
      expect(ASSET_LICENSE_CLASSES, `licenseClass: '${value}'`).toContain(value);
    }
    // And the one literal that is not an entry: a cast that could smuggle a fourth
    // class past the type would have to name it, and there is no such name here.
    expect(stripComments(manifestSource)).not.toMatch(/legacy-unverified|repository-authored/);
  });

  it('the validator has teeth: a bad class, a bad key, and a bad path are each reported', () => {
    // Synthetic manifests, because the shipped one satisfies every rule and a test
    // of a passing input proves nothing about the check.
    const good: AssetManifestEntry = {
      key: 'synthetic-key',
      path: 'assets/synthetic/file.svg',
      requirement: 'optional',
      licenseClass: 'procedural',
      fallback: { kind: 'tile', fill: 'surfacePage', stroke: 'borderControl', widthPx: 8, heightPx: 8 },
    };
    const bundle = (entries: readonly AssetManifestEntry[]): Record<string, AssetBundleDefinition> => ({
      common: { id: 'common', description: 'synthetic', entries },
    });

    expect(findAssetManifestProblems(bundle([good]))).toEqual([]);

    const rules = (entries: readonly AssetManifestEntry[]): string[] =>
      findAssetManifestProblems(bundle(entries)).map((problem) => problem.rule);

    expect(
      rules([{ ...good, licenseClass: 'legacy-unverified' as AssetManifestEntry['licenseClass'] }]),
      'an unverified class must be refused, not merely typed',
    ).toContain('bad-license-class');
    expect(rules([{ ...good, key: 'Synthetic Key' }])).toContain('invalid-key');
    expect(rules([{ ...good, path: 'https://cdn.example.invalid/a.svg' }])).toContain(
      'remote-or-unsafe-path',
    );
    expect(rules([{ ...good, path: 'assets/../../etc/passwd' }])).toContain('remote-or-unsafe-path');
    expect(rules([{ ...good, path: '/assets/a.svg' }])).toContain('remote-or-unsafe-path');
    expect(rules([{ ...good, path: null, requirement: 'required' }])).toContain(
      'required-without-path',
    );
    expect(rules([good, { ...good }])).toContain('duplicate-key');
    expect(rules([{ ...good, fallback: { ...good.fallback, widthPx: 0 } }])).toContain(
      'bad-fallback-size',
    );
    expect(
      findAssetManifestProblems({ nonsense: { id: 'nonsense', description: '', entries: [] } } as never)
        .map((problem) => problem.rule),
      'a seventh bundle id has to be a deliberate act',
    ).toContain('unknown-bundle-id');
  });
});

describe('no manifest path is absolute or cross-origin', () => {
  it('every path is public-root-relative, and no entry points outside assets/', () => {
    for (const { bundleId, entry } of allEntries()) {
      if (entry.path === null) continue;
      const where = `${bundleId}/${entry.key}`;
      expect(entry.path, where).toMatch(/^assets\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/);
      // The three the character class above cannot express on its own. `[A-Za-z0-9._-]`
      // admits `.` and `..`, so a path-only pattern that checks "legal characters"
      // quietly permits a traversal - which is the defect this file found in the
      // first version of the rule.
      expect(entry.path.startsWith('/'), where).toBe(false);
      expect(entry.path.includes('//'), where).toBe(false);
      expect(entry.path.split('/'), where).not.toContain('..');
    }
  });

  it('the manifest source contains no scheme, no host, and no protocol-relative URL', () => {
    // Read with comments intact, so a URL hiding in a doc comment is a finding too.
    // The manifest's header explains the rule using the words "no scheme" and "no
    // `//`" rather than by writing a URL, which is why this passes.
    expect(manifestSource).not.toMatch(/https?:\/\//i);
    expect(manifestSource).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
    expect(manifestSource).not.toMatch(/data:/i);
    expect(manifestSource).not.toMatch(/blob:/i);
    expect(stripComments(manifestSource)).not.toMatch(/^\s*['"`]\/\//m);
  });
});

describe('the manifest and the media registry agree', () => {
  it('every bundle the registry declares has a manifest bundle', () => {
    // The direction that holds today and must keep holding. The registry is
    // infrastructure-engineer's to extend; the manifest is not allowed to be the
    // side that is missing a bundle the registry already names.
    for (const id of Object.keys(registry.bundles)) {
      expect(ASSET_BUNDLE_IDS, `the registry declares \`${id}\``).toContain(id);
      expect(resolveAssetBundle(id), `the registry declares \`${id}\``).not.toBeNull();
    }
  });

  it('pixi-default membership is exactly the registry pixi-default membership', () => {
    // The two files spell a path differently on purpose: the registry records
    // repository-relative paths because that is what its checksums and its
    // `assets-root` gate resolve against, while the manifest records
    // public-root-relative paths because that is what a URL is built from. The
    // `public/` prefix below is that documented translation and is the only place
    // the two vocabularies meet.
    const registryPaths = registry.assets
      .filter((entry) => entry.bundles.includes('pixi-default'))
      .map((entry) => entry.path)
      .sort();
    const manifestPaths = ASSET_BUNDLES['pixi-default'].entries
      .map((entry) => (entry.path === null ? null : `public/${entry.path}`))
      .sort();

    expect(registryPaths.length, 'the registry default bundle is not empty').toBeGreaterThan(0);
    // Both directions. A manifest entry the registry has never heard of would be a
    // file the CC0 gate cannot check, which is the whole reason the registry exists.
    expect(manifestPaths).toEqual(registryPaths);
  });

  it('every manifested file is a registered, Pixi-eligible, registry member of that bundle', () => {
    const byPath = new Map(registry.assets.map((entry) => [entry.path, entry]));
    for (const { bundleId, entry } of allEntries()) {
      if (entry.path === null) continue;
      const registered = byPath.get(`public/${entry.path}`);
      expect(registered, `${bundleId}/${entry.key} is not in the media registry`).toBeDefined();
      const found = registered as RegistryEntry;
      expect(found.classification, `${entry.path} class`).toBe(entry.licenseClass);
      expect(found.pixiEligible, `${entry.path} pixi eligibility`).toBe(true);
      expect(found.bundles, `${entry.path} bundle membership`).toContain(bundleId);
      // And it is on disk, so "registered" is a fact rather than a claim.
      expect(() =>
        readFileSync(path.join(REPO_ROOT, 'public', entry.path as string)),
      ).not.toThrow();
    }
  });

  it('no manifested file is a legacy-unverified asset', () => {
    const unverified = new Set(
      registry.assets.filter((e) => e.classification === 'legacy-unverified').map((e) => e.path),
    );
    for (const { entry } of allEntries()) {
      if (entry.path === null) continue;
      expect(unverified.has(`public/${entry.path}`), `${entry.path} is unverified`).toBe(false);
    }
  });

  it('the registry declares all six bundle ids, and declares no bundle the manifest lacks', () => {
    // This was a **reported gap** until infrastructure-engineer's registry work landed:
    // the registry named only `pixi-default`, and this assertion recorded the other
    // five as missing so the gap could not quietly widen. The gap is closed, so the
    // recorded gap is replaced by the assertion that replaces it - the two sets are
    // equal, in both directions.
    const pending = ASSET_BUNDLE_IDS.filter((id) => !Object.hasOwn(registry.bundles, id)).sort();
    expect(pending).toEqual([]);
    const surplus = Object.keys(registry.bundles)
      .filter((id) => !ASSET_BUNDLE_IDS.includes(id as (typeof ASSET_BUNDLE_IDS)[number]))
      .sort();
    expect(surplus, 'the registry declares a bundle the manifest cannot load').toEqual([]);
  });
});

describe('the world bundles are thin, and that is the deliverable', () => {
  it('four of the five declare keys and recipes and no files', () => {
    for (const id of ['common', 'village', 'dungeon', 'fishing', 'share-card'] as const) {
      const bundle = ASSET_BUNDLES[id];
      expect(bundle.entries.length, `${id} declares no keys`).toBeGreaterThan(0);
      for (const entry of bundle.entries) {
        expect(entry.path, `${id}/${entry.key} claims a file`).toBeNull();
        // An entry with no file cannot be `required`: there is nothing to be missing.
        expect(entry.requirement, `${id}/${entry.key}`).toBe('optional');
      }
    }
  });

  it('every key in the manifest is owned by exactly one bundle', () => {
    const keys = allEntries().map(({ entry }) => entry.key);
    expect(new Set(keys).size, 'a key appears in two bundles').toBe(keys.length);
    for (const [key, owner] of ASSET_KEY_OWNERS) {
      expect(findAssetEntry(key)?.key, `${key} is in ${owner}`).toBe(key);
    }
    expect(findAssetEntry('no-such-key')).toBeNull();
    expect(resolveAssetBundle('no-such-bundle')).toBeNull();
    expect(resolveAssetBundle(null)).toBeNull();
  });
});

describe('the fallback recipes carry no second palette', () => {
  it('no recipe carries a colour number or a hex value', () => {
    for (const { entry } of allEntries()) {
      for (const value of [entry.fallback.fill, entry.fallback.stroke]) {
        expect(typeof value, `${entry.key} colour`).toBe('string');
        expect(value, `${entry.key} colour`).not.toMatch(/^#|0x/);
      }
      // Geometry is a positive number in CSS pixels, and the radius is deliberately
      // absent: it is a Cozy token the loader reads, not a copy in a data file.
      expect(entry.fallback.widthPx).toBeGreaterThan(0);
      expect(entry.fallback.heightPx).toBeGreaterThan(0);
      expect(Object.keys(entry.fallback).sort()).toEqual([
        'fill',
        'heightPx',
        'kind',
        'stroke',
        'widthPx',
      ]);
    }
    expect(manifestSource, 'a hex literal in the manifest would be a second palette').not.toMatch(
      /#[0-9a-fA-F]{6}/,
    );
  });

  it('the recipe shapes are the four the loader draws', () => {
    const kinds = new Set(allEntries().map(({ entry }) => entry.fallback.kind));
    for (const kind of kinds) {
      expect(['rounded-panel', 'tile', 'disc', 'rule']).toContain(kind);
    }
    expect(kinds.size, 'only one shape is used, so the other three are untested').toBeGreaterThan(1);
  });
});
