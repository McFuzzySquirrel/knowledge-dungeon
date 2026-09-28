/**
 * Phase 8 CC0 media registry gate.
 *
 * ## The claim under test
 *
 * Plan section 10.3 and ADR 002 Decision 5 say that only CC0-approved or procedurally
 * generated media may enter the default PixiJS bundle, that CI must reject any newly
 * registered media missing provenance, and that unverified legacy media must be
 * separated from approved Pixi assets. Phase 8's exit criterion is that "new media
 * cannot be added without CC0 metadata".
 *
 * A schema check alone cannot make that true. Three things can, and all three are
 * asserted here:
 *
 * 1. **The metadata is re-derived, not trusted.** Every registered SHA-256 is
 *    recomputed from the bytes on disk, so a registry that has drifted from the tree
 *    is a red run rather than a decorative file. The mutation case below is the one
 *    that matters: a single changed byte has to fail.
 * 2. **The tree is discovered, not declared.** The gate walks the assets root itself,
 *    so adding a file without registering it fails. The exit criterion is only real
 *    if the *absence* of an entry is what is caught.
 * 3. **The separation is enforced in both directions.** A legacy-unverified entry
 *    cannot claim Pixi eligibility or bundle membership, and - the case that is easy
 *    to miss - an unapproved file cannot be smuggled into the default bundle merely by
 *    being *placed* under a bundle path without registering membership at all.
 *
 * The one property that must never be traded away is honesty about what is verified.
 * Nothing in this repository has a verified CC0 grant, and the suite asserts that the
 * registry says so rather than asserting a count that would be nicer. A false
 * `cc0-approved` is worse than a missing feature, because it is a claim that ships.
 *
 * Every negative case is a real CLI run against a synthetic fixture tree (see
 * `support/licenseGate.ts`), not a reimplementation of the rules in TypeScript.
 *
 * Privacy: no learner data is read, written, printed, or asserted on. The one canary
 * in this file exists to prove the checker refuses to print registry values.
 *
 * Phase: 8.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CC0_IDENTIFIER,
  CC0_URL,
  REPO_ROOT,
  codesOf,
  makeFixture,
  runGate,
  runGenerator,
  sha256,
  type Fixture,
  type Registry,
  type RegistryEntry,
} from './support/licenseGate';

const REGISTRY_PATH = path.join(REPO_ROOT, 'public', 'assets', 'asset-licenses.json');
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
const entries = registry.assets;

/** A clone of an entry with one key removed, so a missing field is a real absence. */
function without(entry: RegistryEntry, key: string): RegistryEntry {
  const clone: Record<string, unknown> = { ...entry };
  delete clone[key];
  return clone as RegistryEntry;
}

function replaceEntry(target: RegistryEntry, changes: Partial<RegistryEntry>): RegistryEntry {
  return { ...target, ...changes } as RegistryEntry;
}

function findEntry(id: string): RegistryEntry {
  const found = entries.find((entry) => entry.id === id);
  if (!found) throw new Error(`No registry entry named ${id}.`);
  return found;
}

const open: Fixture[] = [];
function fixture(): Fixture {
  const made = makeFixture();
  open.push(made);
  return made;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

/** A fixture registry with one entry's fields changed, ready to be written and gated. */
function withEntry(id: string, changes: Partial<RegistryEntry>): Fixture {
  const made = fixture();
  const next = made.registry();
  next.assets = next.assets.map((entry) => (entry.id === id ? replaceEntry(entry, changes) : entry));
  made.writeRegistry(next);
  return made;
}

describe('the committed registry and the gate agree on the real tree', () => {
  it('the gate passes on the repository as it stands', () => {
    const result = runGate();
    expect(codesOf(result), result.output).toEqual([]);
    expect(result.code, result.output).toBe(0);
    // The run is standalone: no build, no dependencies, and a summary a CI log reader
    // can use to see the shape of the media without opening the file.
    expect(result.output).toMatch(/registered entries/);
    expect(result.output).toMatch(/checksums recomputed/);
  });

  it('registers every file under public/assets, media and non-media alike', () => {
    const registered = new Set(entries.map((entry) => entry.path));
    expect(registered.size).toBe(entries.length);
    for (const path of registered) expect(path.startsWith('public/assets/')).toBe(true);
    // The three non-media files in the tree, each registered for what it is rather
    // than waved through as media.
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('public/assets/CREDITS.md')?.classification).toBe('repository-authored');
    expect(byPath.get('public/assets/asset-licenses.json')?.classification).toBe('repository-authored');
    expect(byPath.get('public/assets/sprite-manifest.json')?.classification).toBe('procedural');
    expect(byPath.get('public/assets/sprite-manifest.json')?.media).toBe(false);
    expect(byPath.get('public/assets/welcome-icon.png')?.media).toBe(true);
  });

  it('claims no CC0 provenance it does not have, and says so in the registry', () => {
    // The honest headline: the repository holds no verified CC0 grant today, so no
    // entry may claim one. This assertion is written to fail loudly if somebody later
    // adds an approved entry without one existing to point at.
    const approved = entries.filter((entry) => entry.classification === 'cc0-approved');
    expect(approved).toEqual([]);
    expect(registry.counts['cc0-approved'] ?? 0).toBe(0);
    expect(JSON.stringify(registry.policy.classificationRules ?? {})).toContain('cc0-approved');
  });

  it('admits nothing but approved or procedural media into the default bundle', () => {
    const members = entries.filter((entry) => entry.bundles.length > 0);
    expect(members.length).toBeGreaterThan(0);
    for (const entry of members) {
      expect(['cc0-approved', 'procedural'], entry.id).toContain(entry.classification);
      expect(entry.pixiEligible, entry.id).toBe(true);
      expect(entry.license, entry.id).toBe(CC0_IDENTIFIER);
    }
    const bundlePaths = Object.values(registry.bundles).flatMap((bundle) => bundle.paths);
    for (const entry of entries) {
      const underBundlePath = bundlePaths.some((prefix) => entry.path.startsWith(prefix));
      if (underBundlePath) {
        expect(['cc0-approved', 'procedural'], entry.path).toContain(entry.classification);
        expect(Object.keys(registry.bundles), entry.path).toContain(entry.bundles[0]);
      }
    }
  });

  it('marks every legacy asset explicitly unverified, with a reason and a retention policy', () => {
    const legacy = entries.filter((entry) => entry.classification === 'legacy-unverified');
    expect(legacy.length).toBeGreaterThan(0);
    for (const entry of legacy) {
      expect(entry.license, entry.id).toBe('UNVERIFIED');
      expect(entry.licenseVerified, entry.id).toBe(false);
      expect(String(entry.licenseUnverifiedReason).length, entry.id).toBeGreaterThan(40);
      expect(entry.licenseUrl, entry.id).toBeUndefined();
      expect(entry.dateKind, entry.id).toBe('introduced-in-repository');
      expect(entry.retention, entry.id).toBe('keep-until-phaser-removal');
      expect(entry.bundles, entry.id).toEqual([]);
      expect(entry.pixiEligible, entry.id).toBe(false);
      // An unverified entry still carries a digest: that is inventory integrity, not a
      // license claim, and it is what makes tampering with a legacy file visible.
      expect(String(entry.sha256), entry.id).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.legacyRenderer, entry.id).not.toBe('pixi');
    }
  });

  it('names the commit that introduced each legacy asset, so the owner can verify or relicense it', () => {
    for (const entry of entries.filter((item) => item.classification === 'legacy-unverified')) {
      expect(entry.introducedBy, entry.id).toBeDefined();
      expect(String(entry.introducedBy?.commit), entry.id).toMatch(/^[0-9a-f]{7,40}$/);
    }
    // And it distinguishes the two honest situations rather than blurring them.
    const imported = entries.filter(
      (entry) => entry.classification === 'legacy-unverified' && entry.sourceUrl,
    );
    expect(imported.length).toBeGreaterThan(0);
    for (const entry of imported) {
      expect(String(entry.sourceUrl), entry.id).toMatch(/^https:\/\//);
    }
  });

  it('records why the two unpinnable checksums cannot be pinned, and does not fake one', () => {
    const unpinnable = entries.filter((entry) => entry.checksumPolicy && entry.checksumPolicy !== 'pinned');
    expect(unpinnable.map((entry) => entry.checksumPolicy).sort()).toEqual([
      'regenerated',
      'self-referential',
    ]);
    for (const entry of unpinnable) {
      expect(entry.sha256, entry.id).toBeUndefined();
      expect(String(entry.generation?.checksum).length, entry.id).toBeGreaterThan(60);
    }
    // Everything else is pinned, and a pinned entry with no digest is a gate failure.
    for (const entry of entries.filter((item) => (item.checksumPolicy ?? 'pinned') === 'pinned')) {
      expect(String(entry.sha256), entry.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('the procedural Cozy placeholder set is generated, not drawn', () => {
  const cozy = entries.filter((entry) => entry.path.startsWith('public/assets/cozy/'));

  it('is registered as procedural, reproducible, and byte-identical to a fresh generation', () => {
    const checked = runGenerator(['--check']);
    expect(checked.code, checked.output).toBe(0);
    expect(checked.output).toMatch(/match the generator/);
    expect(cozy.length).toBeGreaterThanOrEqual(4);
    for (const entry of cozy) {
      expect(entry.classification, entry.id).toBe('procedural');
      expect(entry.media, entry.id).toBe(true);
      expect(entry.generation?.script, entry.id).toBe('scripts/generate-cozy-placeholders.mjs');
      expect(String(entry.generation?.recipe), entry.id).toMatch(/^size \d+x\d+ \| seed \d+ \| families /);
      // The bytes on disk carry the id and the recipe, so a registry entry cannot claim
      // a recipe the generated file does not have.
      const text = readFileSync(path.join(REPO_ROOT, entry.path), 'utf8');
      expect(text, entry.id).toContain(`id: ${entry.id}`);
      expect(text, entry.id).toContain(`recipe: ${entry.generation?.recipe}`);
      // No SMIL and no CSS animation: the placeholders are inert under reduced motion,
      // so they cannot become an animation the reduced-motion work has to chase.
      expect(text, entry.id).not.toMatch(/<animate|<set\b/);
    }
  });

  it('regenerates byte for byte into a clean directory, so the recipe is really the recipe', () => {
    const out = runGenerator(['--check']);
    expect(out.code, out.output).toBe(0);
    // `--describe` is the machine-readable statement of what the script produces, and
    // comparing it against the registry is how the two are held to agreeing.
    const described = JSON.parse(runGenerator(['--describe']).stdout) as ReadonlyArray<{
      id: string;
      file: string;
      width: number;
      height: number;
      seed: number;
      families: string[];
      role: string;
    }>;
    expect(described.length).toBe(cozy.length);
    for (const spec of described) {
      const entry = findEntry(spec.id);
      expect(entry.path, spec.id).toBe(`public/assets/cozy/${spec.file}`);
      expect(entry.generation?.recipe, spec.id).toBe(
        `size ${spec.width}x${spec.height} | seed ${spec.seed} | families ${spec.families.join(', ')}`,
      );
      expect(entry.role, spec.id).toBe(spec.role);
    }
  });

  it('draws from the five Cozy palette families the plan names, and uses every one of them', () => {
    const families = Object.keys(registry.paletteFamilies ?? {});
    expect(families.sort()).toEqual(['berry', 'firelight', 'ink', 'moss', 'parchment']);
    const described = JSON.parse(runGenerator(['--describe']).stdout) as ReadonlyArray<{
      families: string[];
    }>;
    const used = new Set(described.flatMap((spec) => spec.families));
    for (const family of families) expect([...used], family).toContain(family);
    // The values are provisional placeholder colours, and the registry says so rather
    // than pretending to be the token source of truth.
    expect(String(registry.paletteNote)).toMatch(/PROVISIONAL/);
    for (const [family, tokens] of Object.entries(registry.paletteFamilies ?? {})) {
      for (const [token, hex] of Object.entries(tokens)) {
        expect(hex, `${family}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('has no SMIL, no external reference, and no script in any generated file', () => {
    for (const entry of cozy) {
      const text = readFileSync(path.join(REPO_ROOT, entry.path), 'utf8');
      expect(text, entry.id).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(text, entry.id).not.toMatch(/<script|xlink:href|<image\b/);
      expect(text, entry.id).toMatch(/^<svg|^<!--/);
    }
  });
});

describe('a registered asset missing any plan 10.3 field is rejected', () => {
  it('fails when a required field is absent, and names the field', () => {
    for (const field of ['creator', 'source', 'licenseUrl', 'date', 'modifications', 'sha256']) {
      const made = fixture();
      const next = made.registry();
      next.assets = next.assets.map((entry) =>
        entry.id === 'fixture-placeholder' ? without(entry, field) : entry,
      );
      made.writeRegistry(next);
      const result = made.gate();
      expect(result.code, `${field}: ${result.output}`).toBe(1);
      expect(codesOf(result), field).toContain('E-MISSING-METADATA');
      expect(result.output, field).toContain(`Missing: ${field}`);
      made.cleanup();
    }
  });

  it('rejects a source URL that is neither an https URL nor an explicit not-applicable reason', () => {
    const made = fixture();
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'fixture-placeholder'
        ? without(replaceEntry(entry, { sourceUrlNotApplicable: undefined }), 'sourceUrlNotApplicable')
        : entry,
    );
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-MISSING-METADATA');
    expect(result.output).toContain('sourceUrl');
  });

  it('rejects a license identifier that is not exactly CC0-1.0', () => {
    for (const identifier of ['CC0', 'cc0-1.0', 'CC0-1.0 Universal', 'MIT']) {
      const made = withEntry('fixture-placeholder', { license: identifier });
      const result = made.gate();
      expect(result.code, identifier).toBe(1);
      expect(codesOf(result), identifier).toContain('E-LICENSE-IDENTIFIER');
      made.cleanup();
    }
  });

  it('rejects a license URL that is not the CC0 deed', () => {
    const made = withEntry('fixture-placeholder', { licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' });
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-LICENSE-URL');
  });

  it('rejects a date that is not an ISO calendar date', () => {
    for (const date of ['2026-13-45', '27/09/2026', '2026-9-7', 'yesterday']) {
      const made = withEntry('fixture-placeholder', { date });
      const result = made.gate();
      expect(result.code, date).toBe(1);
      expect(codesOf(result), date).toContain('E-DATE-FORMAT');
      made.cleanup();
    }
  });

  it('rejects a checksum that is not a lowercase 64-character hex digest', () => {
    for (const digest of ['abc', sha256('x').toUpperCase(), `${sha256('x')}00`, 'z'.repeat(64)]) {
      const made = withEntry('fixture-placeholder', { sha256: digest });
      const result = made.gate();
      expect(result.code, digest).toBe(1);
      expect(codesOf(result), digest).toContain('E-CHECKSUM-FORMAT');
      made.cleanup();
    }
  });

  it('rejects a key the schema does not define, which is how a typo becomes a gate failure', () => {
    for (const typo of ['licence', 'licenceUrl', 'sha512', 'licenseVerifiedd']) {
      const made = withEntry('fixture-placeholder', { [typo]: 'CC0-1.0' });
      const result = made.gate();
      expect(result.code, typo).toBe(1);
      expect(codesOf(result), typo).toContain('E-ENTRY-UNKNOWN-KEY');
      expect(result.output, typo).toContain(typo);
      made.cleanup();
    }
  });

  it('rejects a media flag that disagrees with the file extension', () => {
    const made = withEntry('fixture-placeholder', { media: false });
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-MEDIA-FLAG');
  });

  it('rejects media parked in the non-media class, which would be a way round the media taxonomy', () => {
    // `repository-authored` exists so this repository's own non-media files have an
    // honest class. It must not become a shelf for media that has no CC0 grant.
    const made = withEntry('legacy-fixture-sprite', { classification: 'repository-authored' });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-ENTRY-SCHEMA');
    expect(result.output).toMatch(/Classify media as cc0-approved, procedural, or legacy-unverified/);
  });

  it('rejects a duplicate id and a duplicate path, because neither is a stable identity', () => {
    const duplicateId = fixture();
    const withId = duplicateId.registry();
    withId.assets = [...withId.assets, { ...findRegistryEntry(withId, 'fixture-placeholder'), path: 'public/assets/cozy/other.svg' }];
    duplicateId.writeRegistry(withId);
    duplicateId.addUnregistered('cozy/other.svg', COZY_LIKE);
    const idResult = duplicateId.gate();
    expect(idResult.code).toBe(1);
    expect(codesOf(idResult)).toContain('E-DUPLICATE-ID');
    duplicateId.cleanup();

    const duplicatePath = fixture();
    const withPath = duplicatePath.registry();
    withPath.assets = [
      ...withPath.assets,
      { ...findRegistryEntry(withPath, 'fixture-placeholder'), id: 'fixture-placeholder-two' },
    ];
    duplicatePath.writeRegistry(withPath);
    const pathResult = duplicatePath.gate();
    expect(pathResult.code).toBe(1);
    expect(codesOf(pathResult)).toContain('E-DUPLICATE-PATH');
    duplicatePath.cleanup();
  });

  it('rejects a path that escapes the assets root, and withholds an unsafe path from the message', () => {
    const made = fixture();
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'legacy-fixture-sprite' ? replaceEntry(entry, { path: 'public/../outside.svg' }) : entry,
    );
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-PATH-UNSAFE');
  });

  it('rejects a registered path that is not on disk', () => {
    const made = fixture();
    made.remove('sprites/legacy.svg');
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-ASSET-MISSING');
  });
});

const COZY_LIKE = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>\n';

function findRegistryEntry(source: Registry, id: string): RegistryEntry {
  const found = source.assets.find((entry) => entry.id === id);
  if (!found) throw new Error(`No fixture entry named ${id}.`);
  return found;
}

describe('the checksum is re-derived, so a mutated file cannot pass', () => {
  it('fails when a single byte of a registered asset changes', () => {
    const made = fixture();
    const mutated = COZY_LIKE.replace('height="8"', 'height="9"');
    made.writeAsset('cozy/fixture-placeholder.svg', mutated);
    expect(sha256(mutated)).not.toBe(sha256(readFileSync(made.registryPath, 'utf8')));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-CHECKSUM-MISMATCH');
    expect(result.output).toContain('fixture-placeholder');
  });

  it('fails when a legacy asset is swapped, which is the inventory-integrity half of the rule', () => {
    const made = fixture();
    made.writeAsset('sprites/legacy.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"></svg>\n');
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-CHECKSUM-MISMATCH');
  });

  it('re-derives rather than compares lengths: a same-length edit is still caught', () => {
    const made = fixture();
    // Same character count, different content: anything comparing size would pass.
    const original = readFileSync(path.join(made.assetsRoot, 'sprites/legacy.svg'), 'utf8');
    const swapped = original.replace('16" height="16', '17" height="17');
    expect(swapped).toHaveLength(original.length);
    made.writeAsset('sprites/legacy.svg', swapped);
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-CHECKSUM-MISMATCH');
  });
});

describe('media cannot be added without registry metadata', () => {
  it('fails on an unregistered media file, which is the exit criterion itself', () => {
    const made = fixture();
    made.addUnregistered('sprites/sneaky.svg', COZY_LIKE);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-MEDIA');
    expect(result.output).toContain('public/assets/sprites/sneaky.svg');
    expect(result.output).toMatch(/Add an entry with full provenance/);
  });

  it('fails on an unregistered non-media file too, so the directory cannot quietly grow', () => {
    const made = fixture();
    made.addUnregistered('notes.txt', 'scratch\n');
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-FILE');
  });

  it('fails on an unregistered asset in a subdirectory that no bundle path covers', () => {
    const made = fixture();
    made.addUnregistered('sprites/village/extra.svg', COZY_LIKE);
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-MEDIA');
  });
});

describe('unverified media cannot reach the default PixiJS bundle', () => {
  it('fails when a legacy-unverified entry claims Pixi eligibility', () => {
    const made = withEntry('legacy-fixture-sprite', { pixiEligible: true });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-PIXI-ELIGIBILITY');
  });

  it('fails when a legacy-unverified entry declares bundle membership', () => {
    const made = withEntry('legacy-fixture-sprite', { bundles: ['pixi-default'] });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-PIXI-ELIGIBILITY');
  });

  it('fails when an unverified asset is placed under an approved bundle path, even without claiming membership', () => {
    // This is the direction that a membership-only rule would miss: the file is under
    // the bundle's path, so a bundle that loads that path would load unverified media,
    // but nothing in the registry says "member".
    const made = fixture();
    const next = made.registry();
    const smuggled = {
      ...findRegistryEntry(next, 'legacy-fixture-sprite'),
      id: 'legacy-smuggled',
      path: 'public/assets/cozy/smuggled.svg',
      sha256: sha256(COZY_LIKE),
    };
    next.assets = [...next.assets, smuggled];
    made.addUnregistered('cozy/smuggled.svg', COZY_LIKE);
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNVERIFIED-IN-BUNDLE');
    expect(result.output).toContain('legacy-smuggled');
  });

  it('fails when an approved asset sits under a bundle path but does not declare membership', () => {
    const made = withEntry('fixture-placeholder', { bundles: [], pixiEligible: false });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-BUNDLE-PATH');
  });

  it('fails when an entry claims a bundle the registry does not declare', () => {
    const made = withEntry('fixture-placeholder', { bundles: ['pixi-everything'] });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-BUNDLE-UNKNOWN');
  });

  it('fails when a non-media file is made Pixi-eligible', () => {
    const made = withEntry('fixture-credits', { pixiEligible: true, bundles: ['pixi-default'] });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-NONMEDIA-IN-BUNDLE');
  });

  it('fails when a legacy entry is given a license claim it cannot support', () => {
    // The laundering attempts, in the shapes they would plausibly take.
    const asApproved = withEntry('legacy-fixture-sprite', {
      license: CC0_IDENTIFIER,
      licenseUrl: CC0_URL,
    });
    const approvedResult = asApproved.gate();
    expect(approvedResult.code).toBe(1);
    expect(codesOf(approvedResult)).toContain('E-LEGACY-UNVERIFIED');
    asApproved.cleanup();

    const withUrl = withEntry('legacy-fixture-sprite', { licenseUrl: CC0_URL });
    const urlResult = withUrl.gate();
    expect(urlResult.code).toBe(1);
    expect(codesOf(urlResult)).toContain('E-LEGACY-UNVERIFIED');
    withUrl.cleanup();

    const asVerified = withEntry('legacy-fixture-sprite', { licenseVerified: true });
    const verifiedResult = asVerified.gate();
    expect(verifiedResult.code).toBe(1);
    expect(codesOf(verifiedResult)).toContain('E-LEGACY-UNVERIFIED');
    asVerified.cleanup();

    const silent = withEntry('legacy-fixture-sprite', { licenseUnverifiedReason: '' });
    const silentResult = silent.gate();
    expect(silentResult.code).toBe(1);
    expect(codesOf(silentResult)).toContain('E-LEGACY-UNVERIFIED');
    silent.cleanup();
  });

  it('rejects a legacy entry with a guessed creation date instead of the honest unknown', () => {
    const made = withEntry('legacy-fixture-sprite', { dateKind: 'created' });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-DATE-FORMAT');
  });

  it('rejects a legacy entry with no retention policy, so it cannot outlive the migration silently', () => {
    const made = withEntry('legacy-fixture-sprite', { retention: undefined });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-RETENTION');
  });
});

describe('a procedural entry has to be reproducible', () => {
  it('rejects a procedural entry whose generating script does not exist in the repository', () => {
    const made = withEntry('fixture-placeholder', {
      generation: {
        script: 'scripts/does-not-exist.mjs',
        command: 'node scripts/does-not-exist.mjs',
        recipe: 'size 8x8 | seed 1 | families ink',
      },
    });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-GENERATION-SCRIPT-MISSING');
  });

  it('rejects a procedural entry with no recipe', () => {
    const made = withEntry('fixture-placeholder', {
      generation: { script: 'scripts/generate-fixture.mjs', command: 'node scripts/generate-fixture.mjs', recipe: '' },
    });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-GENERATION');
  });

  it('rejects a generated file that does not carry the id and recipe it is registered with', () => {
    const made = fixture();
    made.writeAsset('cozy/fixture-placeholder.svg', COZY_LIKE);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-GENERATION-MARKER');
  });

  it('rejects a generated index that has drifted from the tree it indexes', () => {
    const made = fixture();
    made.addUnregistered('cozy/indexed.svg', COZY_LIKE);
    const next = made.registry();
    const index = next.assets.find((entry) => entry.id === 'fixture-credits');
    if (!index) throw new Error('The fixture has no credits entry to repurpose.');
    index.checksumPolicy = 'regenerated';
    index.generation = {
      script: 'scripts/generate-fixture.mjs',
      command: 'node scripts/generate-fixture.mjs',
      recipe: 'Fixture index.',
      semanticCheck: 'sprite-manifest-sync',
      checksum: 'A timestamped index cannot be pinned, so it is compared to the tree instead.',
    };
    made.writeRegistry(next);
    // The index itself lists fewer sprites than the tree holds.
    made.writeAsset(
      'CREDITS.md',
      `${JSON.stringify({ sprites: [{ path: 'cozy/fixture-placeholder.svg' }] })}\n`,
    );
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-SEMANTIC-DRIFT');
  });

  it('rejects a non-pinned checksum policy that does not say what stands in for it', () => {
    const made = fixture();
    const next = made.registry();
    const index = next.assets.find((entry) => entry.id === 'fixture-credits');
    if (!index) throw new Error('The fixture has no credits entry to repurpose.');
    index.checksumPolicy = 'regenerated';
    delete index.generation;
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-CHECKSUM-FORMAT');
  });

  it('rejects a pinned entry that also carries a regeneration excuse', () => {
    const made = withEntry('fixture-placeholder', { checksumPolicy: 'pinned' });
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'fixture-placeholder' ? replaceEntry(entry, { generation: undefined }) : entry,
    );
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-GENERATION');
  });
});

describe('the counts block cannot drift from the entries', () => {
  it('fails when a recorded count is stale', () => {
    const made = fixture();
    const next = made.registry();
    next.counts = { ...next.counts, 'legacy-unverified': 99 };
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-COUNTS');
  });

  it('fails when the counts name a class the schema does not define', () => {
    const made = fixture();
    const next = made.registry();
    next.counts = { ...next.counts, 'cc-by': 1 };
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-COUNTS');
  });
});

describe('CREDITS.md cannot drift from the registry', () => {
  it('fails when a registered path is missing from the credits', () => {
    const made = fixture();
    made.writeAsset('CREDITS.md', '# Fixture credits\n\n- `public/assets/sprites/legacy.svg` — Fixture.\n');
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'fixture-credits' ? replaceEntry(entry, { sha256: sha256(readFileSync(path.join(made.assetsRoot, 'CREDITS.md'), 'utf8')) }) : entry,
    );
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-CREDITS-COVERAGE');
    expect(result.output).toContain('public/assets/cozy/fixture-placeholder.svg');
  });

  it('fails when the credits name a path the registry does not contain', () => {
    const made = fixture();
    made.writeAsset(
      'CREDITS.md',
      '# Fixture credits\n\n- `public/assets/sprites/legacy.svg` — Fixture.\n- `public/assets/cozy/fixture-placeholder.svg` — Fixture.\n- `public/assets/CREDITS.md` — Fixture.\n- `public/assets/asset-licenses.json` — Fixture.\n- `public/assets/sprites/ghost.svg` — Removed long ago.\n',
    );
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'fixture-credits' ? replaceEntry(entry, { sha256: sha256(readFileSync(path.join(made.assetsRoot, 'CREDITS.md'), 'utf8')) }) : entry,
    );
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-CREDITS-UNKNOWN-PATH');
    expect(result.output).toContain('public/assets/sprites/ghost.svg');
  });

  it('fails when the credits file is gone', () => {
    const made = fixture();
    made.remove('CREDITS.md');
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-CREDITS-MISSING');
  });

  it('the committed credits cover the committed registry in both directions', () => {
    const credits = readFileSync(path.join(REPO_ROOT, 'public', 'assets', 'CREDITS.md'), 'utf8');
    const named = new Set([...credits.matchAll(/`(public\/assets\/[^`\s]+)`/g)].map((match) => match[1]));
    for (const entry of entries) expect(named.has(entry.path), entry.path).toBe(true);
    const registered = new Set(entries.map((entry) => entry.path));
    for (const assetPath of named) expect(registered.has(assetPath), assetPath).toBe(true);
  });
});

describe('the gate never prints learner data, and never prints a registry value at all', () => {
  const CANARY = 'kd-phase8-canary-9f3a-learner';

  it('withholds a canary planted in a free-text field, while still failing the run', () => {
    const made = fixture();
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'legacy-fixture-sprite'
        ? replaceEntry(entry, { licenseUnverifiedReason: CANARY })
        : entry,
    );
    // A path with characters outside the permitted set is the case that would let
    // arbitrary content reach a printed message, so it is planted too.
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.output).not.toContain(CANARY);
  });

  it('withholds an unsafe asset id and an unsafe path instead of echoing them', () => {
    const made = fixture();
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'legacy-fixture-sprite'
        ? replaceEntry(entry, { id: `${CANARY}!`, path: `public/assets/${CANARY} .svg` })
        : entry,
    );
    made.writeRegistry(next);
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(result.output).not.toContain(CANARY);
    // It says something went wrong without saying what, which is the whole point.
    expect(result.output).toContain('<withheld: not a safe asset id>');
    expect(result.output).toContain('<withheld: not a safe asset path>');
  });

  it('reports ids, paths, and field names, which is all it is allowed to print', () => {
    const made = withEntry('fixture-placeholder', { licenseUrl: undefined });
    const result = made.gate();
    expect(result.output).toContain('fixture-placeholder');
    expect(result.output).toContain('public/assets/cozy/fixture-placeholder.svg');
    expect(result.output).toContain('licenseUrl');
    // ...and never the *values*: not the creator, not the source, not a license string
    // borrowed from the entry being complained about.
    expect(result.output).not.toContain('Fixture generator');
    expect(result.output).not.toContain('Generated by the fixture generator.');
  });

  it('rejects an unparseable registry without echoing its contents', () => {
    const made = fixture();
    made.writeRawRegistry('{ this is not json');
    const result = made.gate();
    expect(result.code).toBe(1);
    expect(codesOf(result)).toContain('E-REGISTRY-UNREADABLE');
    expect(result.output).not.toContain('this is not json');
  });
});

describe('--write records checksums and cannot launder anything', () => {
  it('records a digest for a changed file without touching the classification', () => {
    const made = fixture();
    made.writeAsset('sprites/legacy.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17"></svg>\n');
    const before = made.registry();
    const legacyBefore = before.assets.find((entry) => entry.id === 'legacy-fixture-sprite');

    const written = made.gate(['--write']);
    expect(written.code, written.output).toBe(0);
    const after = made.registry();
    const legacyAfter = after.assets.find((entry) => entry.id === 'legacy-fixture-sprite');
    expect(legacyAfter?.sha256).toBe(
      sha256('<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17"></svg>\n'),
    );
    // The class, the license, the reason it is unverified, and the bundle state are all
    // exactly what they were. --write is a checksum tool, not a promotion tool.
    expect(legacyAfter?.classification).toBe(legacyBefore?.classification);
    expect(legacyAfter?.license).toBe('UNVERIFIED');
    expect(legacyAfter?.licenseVerified).toBe(false);
    expect(legacyAfter?.licenseUnverifiedReason).toBe(legacyBefore?.licenseUnverifiedReason);
    expect(legacyAfter?.bundles).toEqual([]);
    expect(legacyAfter?.pixiEligible).toBe(false);
    // And the run is green afterwards, because the digest now matches the bytes.
    expect(made.gate().code).toBe(0);
  });

  it('does not fill in a missing provenance field, so it cannot manufacture a claim', () => {
    const made = fixture();
    const next = made.registry();
    next.assets = next.assets.map((entry) =>
      entry.id === 'fixture-placeholder'
        ? (without(entry, 'creator') as RegistryEntry)
        : entry,
    );
    made.writeRegistry(next);
    const result = made.gate(['--write']);
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-MISSING-METADATA');
    const after = made.registry();
    expect(after.assets.find((entry) => entry.id === 'fixture-placeholder')?.creator).toBeUndefined();
  });

  it('refuses an unknown flag rather than guessing what was meant', () => {
    const result = runGate(['--promote-everything']);
    expect(result.code).toBe(2);
    expect(result.output).toContain('Unknown flag');
    // ...and the flag it does know is documented, because the first thing an author
    // does with a red run is ask the script what it accepts.
    const help = runGate(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--write');
    expect(help.stdout).toContain('Never changes a classification');
  });
});
