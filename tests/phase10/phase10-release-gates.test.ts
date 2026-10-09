/**
 * Phase 10 infrastructure gates: the media registry, the bundle-set cross-check, the
 * audio flag, and the privacy claim for the audio and bundle paths.
 *
 * ## What this file is for
 *
 * The Phase 10 code half declares six Pixi asset bundles, a loader, and an audio
 * service. This file gates the three things that are infrastructure's half of that
 * and that nothing else checks:
 *
 * 1. **The registry and the manifest declare the same bundle set.** Two files, one
 *    vocabulary, and no type or compiler between them: a bundle added to one is
 *    invisible to the other, and a bundle nobody can load is as much a defect as one
 *    that loads unapproved media. `scripts/check-cc0-assets.mjs` is where that is
 *    enforced, so the negative cases here are real CLI runs against a copy of the
 *    committed registry, not a reimplementation of the rule in TypeScript.
 * 2. **The audio flag is a flag.** Phase 10's rollback is "disable audio independently
 *    and retain procedural art fallbacks", and a defensive read of a key that does not
 *    exist is not a rollback. So the key exists, the matrix entry is real, the default
 *    build resolves it, and the value cannot be a learner value: a build-time flag is
 *    read from the environment, and nothing else may reach it.
 * 3. **The audio and bundle paths make no network request and cache nothing.** The
 *    Phase 4 privacy gate walks the application graph, but it asserts on the graph as a
 *    whole; this file names the Phase 10 modules specifically and uses the *same*
 *    detector, so "the audio service makes no request" is a statement about those files
 *    rather than an inference from a suite-wide green.
 *
 * ## Why the exceptions are declared rather than assumed
 *
 * `audioEnabled` is the one flag whose production default is `true`, and three
 * earlier-phase gates assert that no flag defaults on. They now compare against
 * `NON_CUTOVER_FLAG_KEYS` instead of an empty list, so the exception is a reviewed list
 * a gate reads, and a *new* flag defaulting on still fails all of them. This file
 * asserts both halves of that contract from the config module's side.
 *
 * ## Non-vacuity
 *
 * Every negative claim here has a positive control. The network scan is fed a planted
 * module and required to report it; the registry is copied and broken in two directions
 * and required to fail each; the bundle ids are read from the manifest module rather
 * than from a list written here. A gate that cannot fail is not a gate.
 *
 * ## Hermeticity and privacy
 *
 * Reads files inside the repository and spawns `node scripts/check-cc0-assets.mjs`
 * against temporary copies of the registry. No `dist/`, no network, no commit, no
 * location-dependent value. No learner data is read, written, or asserted on; the
 * values compared are asset ids, asset paths, flag names, and flag defaults.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS, parseRuntimeConfig, WORLD_RENDERERS, STORAGE_REPOSITORIES } from '@/config/runtimeConfig';
import {
  CUTOVER_BOOLEAN_FLAG_KEYS,
  FEATURE_FLAGS,
  FEATURE_FLAG_MATRIX,
  NON_CUTOVER_FLAG_KEYS,
} from '@/config/featureFlags';
import { ASSET_BUNDLE_IDS } from '@/renderers/pixi/assets/assetManifest';
import { isSameOriginRelativeAudioUrl } from '@/services/audio/fileAudioProvider';
import { scanModuleForNetworkRules, stripComments, walkAppGraph } from '../privacy/support/appGraph';

const REPO_ROOT = process.cwd();
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-cc0-assets.mjs');
const REGISTRY_PATH = path.join(REPO_ROOT, 'public', 'assets', 'asset-licenses.json');

/** The five bundle sets Phase 10 declares, and the one Phase 8 declared. */
const PHASE_10_BUNDLES = ['common', 'village', 'dungeon', 'fishing', 'share-card'] as const;

interface RegistryEntry {
  readonly id: string;
  readonly path: string;
  readonly classification: string;
  readonly bundles: readonly string[];
  readonly pixiEligible: boolean;
  readonly sha256?: string;
}
interface Registry {
  readonly bundles: Record<string, { description: string; paths: string[]; admission: string }>;
  readonly counts: Record<string, number>;
  readonly assets: RegistryEntry[];
  readonly policy: Record<string, string>;
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;

/**
 * Runs the real gate. Arguments are passed through verbatim, as CI would.
 *
 * Both streams are captured and concatenated in the order a reader would see them: the
 * gate prints its report - pass line, problems, and summary alike - on stderr, so a
 * success that read stdout alone would look like silence.
 */
function runGate(extraArgs: readonly string[] = []): { code: number; output: string } {
  const run = spawnSync(process.execPath, [CHECKER, ...extraArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    code: run.status ?? -1,
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
  };
}

const temporaries: string[] = [];
function temporaryRegistry(mutate: (draft: Registry) => void): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'kd-phase10-gate-'));
  temporaries.push(directory);
  const draft = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
  mutate(draft);
  const file = path.join(directory, 'asset-licenses.json');
  writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  return file;
}
afterAll(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop() as string, { recursive: true, force: true });
});

describe('the registry declares the six bundle sets the manifest loads', () => {
  it('the two sets are equal, in both directions', () => {
    // Read from the manifest module, not from a list written here, so a bundle added
    // to one file and forgotten in the other cannot satisfy this test.
    expect([...ASSET_BUNDLE_IDS].sort()).toEqual(Object.keys(registry.bundles).sort());
    expect(Object.keys(registry.bundles).sort()).toEqual([
      'common',
      'dungeon',
      'fishing',
      'pixi-default',
      'share-card',
      'village',
    ]);
  });

  it('the five Phase 10 sets are empty, and say so rather than looking empty', () => {
    for (const id of PHASE_10_BUNDLES) {
      const bundle = registry.bundles[id];
      expect(bundle, id).toBeDefined();
      expect(
        registry.assets.filter((entry) => entry.bundles.includes(id)).map((entry) => entry.path),
        `${id} has members`,
      ).toEqual([]);
      // An empty set with a reserved path is a deliberate declaration. The two words
      // that make it one are the difference between a stated policy and an omission.
      expect(bundle.description, id).toMatch(/empty/i);
      expect(bundle.description, id).toMatch(/CC0|cc0/);
      expect(bundle.description, id).toMatch(/laz(?:y|ily)-loaded/i);
      expect(bundle.admission, id).toContain('cc0-approved or procedural only');
    }
  });

  it('the reserved paths do not exist on disk, so "empty" is a fact and not a claim', () => {
    for (const id of PHASE_10_BUNDLES) {
      for (const reserved of registry.bundles[id].paths) {
        const absolute = path.join(REPO_ROOT, reserved);
        let exists = true;
        try {
          statSync(absolute);
        } catch {
          exists = false;
        }
        expect(exists, `${reserved} exists, so the ${id} bundle is no longer empty by construction`).toBe(false);
      }
    }
  });

  it('no bundle reserves a path inside the unverified legacy tree', () => {
    // The reservation is a policy that arms the gate's unapproved-media tripwire. Pointing
    // one at `public/assets/sprites/` would arm it on the ninety legacy-unverified files
    // and turn the gate permanently red, so the collision is asserted rather than trusted.
    for (const [id, bundle] of Object.entries(registry.bundles)) {
      for (const reserved of bundle.paths) {
        expect(reserved, id).not.toContain('public/assets/sprites/');
        expect(reserved, id).not.toContain('..');
        expect(reserved.startsWith('/'), id).toBe(false);
      }
    }
  });

  it('the phase added no media: cc0-approved is still zero and the legacy set is untouched', () => {
    expect(registry.assets.filter((entry) => entry.classification === 'cc0-approved')).toEqual([]);
    expect(registry.counts['cc0-approved'] ?? 0).toBe(0);
    expect(registry.counts['legacy-unverified']).toBe(90);
    expect(registry.assets.length).toBe(99);
    // Every one of the ninety still declares itself unverified and unreachable, which is
    // the property Phase 8 established and Phase 10 had no reason to weaken.
    const legacy = registry.assets.filter((entry) => entry.classification === 'legacy-unverified');
    expect(legacy.length).toBe(90);
    for (const entry of legacy) {
      expect(entry.bundles, entry.id).toEqual([]);
      expect(entry.pixiEligible, entry.id).toBe(false);
      expect(String(entry.sha256), entry.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the registry carries no learner-shaped value in the declarations Phase 10 added', () => {
    // The same shapes `tests/phase8/qa-verification.test.ts` asserts for entries, applied
    // to the bundle block, because the new text is the text this phase wrote.
    const serialised = JSON.stringify(registry.bundles);
    expect(serialised).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(serialised).not.toMatch(/\bBearer\s+/);
    expect(serialised).not.toMatch(/\bsk-[A-Za-z0-9]/);
  });
});

describe('the license gate holds the two bundle sets together', () => {
  it('NON-VACUITY: the committed run cross-checks the manifest and reports agreement', () => {
    const result = runGate();
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(
      /Bundle ids cross-checked against src\/renderers\/pixi\/assets\/assetManifest\.ts: 6 agree\./,
    );
    // All six sets are validated, and the four empty ones are reported as empty rather
    // than omitted - a summary that only names the bundle with members is a summary that
    // cannot show a bundle going missing.
    expect(result.output).toMatch(
      /bundles: pixi-default=6 common=0 village=0 dungeon=0 fishing=0 share-card=0/,
    );
  });

  it('FAILS when the registry omits a bundle the manifest loads', () => {
    const registryPath = temporaryRegistry((draft) => {
      delete (draft.bundles as Record<string, unknown>).village;
    });
    const result = runGate([`--registry=${registryPath}`]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('E-BUNDLE-DRIFT');
    expect(result.output).toMatch(/village/);
  });

  it('FAILS when the registry declares a bundle the manifest cannot load', () => {
    const registryPath = temporaryRegistry((draft) => {
      draft.bundles['moon'] = {
        description: 'A bundle nothing loads.',
        paths: ['public/assets/moon/'],
        admission: 'cc0-approved or procedural only.',
      };
    });
    const result = runGate([`--registry=${registryPath}`]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('E-BUNDLE-DRIFT');
    expect(result.output).toMatch(/moon/);
  });

  it('FAILS when the manifest declares no readable bundle ids, rather than reporting agreement', () => {
    // The read fails closed on purpose. A gate that treated an unreadable declaration as
    // an empty one would switch itself off the moment the constant was renamed - the
    // exact drift the cross-check exists to catch.
    const directory = mkdtempSync(path.join(tmpdir(), 'kd-phase10-manifest-'));
    temporaries.push(directory);
    const manifest = path.join(directory, 'assetManifest.ts');
    writeFileSync(manifest, 'export const BUNDLE_IDS = [1, 2, 3];\n', 'utf8');
    const result = runGate([`--manifest=${manifest}`]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('E-BUNDLE-DRIFT');
    expect(result.output).toMatch(/ASSET_BUNDLE_IDS/);
  });
});

describe('the audio flag is a real flag with a real default', () => {
  it('is declared, typed, owned by Phase 10, and documents its rollback', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.audioEnabled).toBe('VITE_AUDIO_ENABLED');
    const definition = FEATURE_FLAG_MATRIX.audioEnabled;
    expect(definition.valueKind).toBe('boolean');
    expect(definition.ownerPhase).toBe(10);
    // The plan's rollback line, implemented rather than paraphrased away.
    expect(definition.rollback).toContain('VITE_AUDIO_ENABLED=false');
    expect(definition.rollback).toContain('independently');
    expect(definition.rollback).toContain('procedural art fallbacks');
    expect(definition.purpose.length).toBeGreaterThan(20);
  });

  it('the default build resolves it to true, and the switch actually switches', () => {
    expect(DEFAULT_RUNTIME_CONFIG.audioEnabled).toBe(true);
    expect(parseRuntimeConfig({}).audioEnabled).toBe(true);
    // `FEATURE_FLAGS` is the parsed module value, so this is the shipped default rather
    // than a second declaration of it.
    expect(FEATURE_FLAGS.audioEnabled).toBe(true);
    expect(parseRuntimeConfig({ VITE_AUDIO_ENABLED: 'false' }).audioEnabled).toBe(false);
    expect(parseRuntimeConfig({ VITE_AUDIO_ENABLED: ' FALSE ' }).audioEnabled).toBe(false);
    expect(parseRuntimeConfig({ VITE_AUDIO_ENABLED: 'true' }).audioEnabled).toBe(true);
  });

  it('a malformed value fails the build without echoing itself', () => {
    const secret = 'kd-phase10-audio-canary-4c1f';
    let message = '';
    try {
      parseRuntimeConfig({ VITE_AUDIO_ENABLED: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('VITE_AUDIO_ENABLED must be one of: true, false');
    expect(message).not.toContain(secret);
  });

  it('the kill switch declares itself, and the only other flags that default on are the reviewed cutover booleans', () => {
    // Post-Phase-23 the matrix partitions into cutover flags (which now default on and
    // roll back to their pre-cutover value) and the non-cutover kill switches. `audioEnabled`
    // is the only kill switch; the flags that default on are exactly those plus the
    // reviewed cutover booleans, so a flag that defaults on outside that set fails.
    const onByDefault = Object.entries(FEATURE_FLAG_MATRIX)
      .filter(([, definition]) => (definition.productionDefault as boolean) === true)
      .map(([key]) => key)
      .sort();
    expect(onByDefault).toEqual([...CUTOVER_BOOLEAN_FLAG_KEYS, ...NON_CUTOVER_FLAG_KEYS].sort());
    for (const key of NON_CUTOVER_FLAG_KEYS) {
      const definition = FEATURE_FLAG_MATRIX[key];
      expect(definition.valueKind, key).toBe('boolean');
      expect(definition.rollback, key).toContain(RUNTIME_FLAG_ENV_KEYS[key]);
    }
  });

  it('no flag can carry learner data, because every value is a closed vocabulary', () => {
    // A build-time flag is read from the environment, and the environment is the one
    // input a user cannot be trusted to keep out of a log line. So the parsed value is
    // a boolean or one of two closed enums, the variable name is a fixed shape, and the
    // documentation strings carry no path, address, or identifier.
    for (const [key, value] of Object.entries(DEFAULT_RUNTIME_CONFIG)) {
      if (value === true || value === false) continue;
      expect([...WORLD_RENDERERS, ...STORAGE_REPOSITORIES], key).toContain(value);
    }
    for (const [key, name] of Object.entries(RUNTIME_FLAG_ENV_KEYS)) {
      expect(name, key).toMatch(/^VITE_[A-Z0-9_]+$/);
    }
    for (const [key, definition] of Object.entries(FEATURE_FLAG_MATRIX)) {
      for (const text of [definition.purpose, definition.rollback]) {
        expect(text, key).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
        expect(text, key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(text, key).not.toMatch(/[A-Za-z]:\\|file:\/\//);
      }
    }
  });
});

describe('the audio and asset paths make no network request and cache nothing', () => {
  /** Every module Phase 10's code half added, as repository-relative paths. */
  const PHASE_10_MODULES: readonly string[] = [
    ...readdirSync(path.join(REPO_ROOT, 'src', 'services', 'audio'))
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => `src/services/audio/${name}`),
    ...readdirSync(path.join(REPO_ROOT, 'src', 'renderers', 'pixi', 'assets'))
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => `src/renderers/pixi/assets/${name}`),
    'src/services/audioManager.ts',
  ];

  it('the module list is the real one, so an empty scan is not an empty list', () => {
    // Eleven modules: eight under services/audio, two under renderers/pixi/assets, and
    // the manager. A gate that read a directory that did not exist would pass this file
    // without reading anything, so the count is asserted against the tree.
    expect(PHASE_10_MODULES.length).toBe(11);
    expect(PHASE_10_MODULES).toContain('src/services/audio/fileAudioProvider.ts');
    expect(PHASE_10_MODULES).toContain('src/services/audio/proceduralAudioProvider.ts');
    expect(PHASE_10_MODULES).toContain('src/renderers/pixi/assets/AssetLoader.ts');
    expect(PHASE_10_MODULES).toContain('src/renderers/pixi/assets/assetManifest.ts');
  });

  it('every one of them is reachable from the application entry, so the scan covers shipping code', () => {
    // The Phase 4 walk follows dynamic imports, so the lazily imported Pixi host and
    // everything it reaches is in the graph. Without this, "no request" would be a claim
    // about modules the application cannot load.
    const graph = walkAppGraph();
    const reached = new Set(graph.modules.map((module) => module.path));
    for (const modulePath of PHASE_10_MODULES) {
      expect(reached.has(modulePath), `${modulePath} is not in the application graph`).toBe(true);
    }
    expect(graph.unresolved.map((entry) => `${entry.from} -> ${entry.specifier}`)).toEqual([]);
  });

  it('none of them makes a network call, and none carries a remote URL', () => {
    for (const modulePath of PHASE_10_MODULES) {
      const source = readFileSync(path.join(REPO_ROOT, modulePath), 'utf8');
      const scan = scanModuleForNetworkRules(modulePath, source);
      // Zero call sites, not just zero findings: the file provider takes a byte loader
      // by injection and the procedural provider synthesises, so there is nothing to
      // count and a future `fetch` would show up in this number first.
      expect(scan.findings, modulePath).toEqual([]);
      expect(scan.callSites, modulePath).toBe(0);
      // Comments are stripped first, so a doc comment explaining what is refused is not
      // read as a request. `fileAudioProvider.ts` names a CDN host precisely to say it
      // will not be used.
      const code = stripComments(source);
      expect(code, modulePath).not.toMatch(/https?:\/\//i);
      expect(code, modulePath).not.toMatch(/\bdata:/i);
      expect(code, modulePath).not.toMatch(/\bblob:/i);
      expect(code, modulePath).not.toMatch(/['"`]\/\/[a-z0-9-]+\.[a-z]{2,}/i);
    }
  });

  it('NON-VACUITY: the same detector reports a planted request and a planted beacon', () => {
    // The same function, on a module that exists for no other purpose. If this ever
    // reports nothing, the scan above is broken rather than clean.
    const planted = [
      "export async function load(url: string) {",
      "  const body = new FormData();",
      "  await fetch('https://cdn.example.invalid/a.wav', { method: 'POST', body });",
      "  navigator.sendBeacon('https://cdn.example.invalid/b.wav');",
      "  return body;",
      "}",
      "",
    ].join('\n');
    const scan = scanModuleForNetworkRules('src/services/audio/planted.ts', planted);
    expect(scan.findings.map((finding) => finding.rule).sort()).toEqual([
      'absolute-network-destination',
      'absolute-network-destination',
      'beacon-post',
      'formdata-construction',
      'non-idempotent-request',
    ]);
    expect(scan.callSites).toBe(2);
  });

  it('the file provider refuses an off-origin audio URL before anything is requested', () => {
    // The mechanism the scan above relies on, asserted directly: a resolver-supplied URL
    // is judged as a string, so a CDN URL or a protocol-relative one never reaches a
    // loader. Same-origin relative forms are the only ones allowed.
    expect(isSameOriginRelativeAudioUrl('/assets/audio/theme.ogg')).toBe(true);
    expect(isSameOriginRelativeAudioUrl('./assets/audio/theme.ogg')).toBe(true);
    expect(isSameOriginRelativeAudioUrl('https://cdn.example.invalid/a.wav')).toBe(false);
    expect(isSameOriginRelativeAudioUrl('//cdn.example.invalid/a.wav')).toBe(false);
    expect(isSameOriginRelativeAudioUrl('assets/audio/theme.ogg')).toBe(false);
  });
});

/**
 * Phase 22's offline static shell is the one new place in the application that can write a
 * cache.
 *
 * This file used to hold a single test asserting that nothing in `src/` or `public/`
 * mentioned `serviceWorker`, `workbox`, or `caches.` - the strictest true statement before
 * Phase 22, and false by design now. Deleting it would leave the worker ungated; allowing
 * the two new files by name would assert nothing about what the worker caches. The
 * replacement states the property the absence was a proxy for, structurally and against
 * the implementation: the shell precaches only the build-time manifest derived from
 * `dist/index.html`, and neither the worker nor its registration wrapper reaches IndexedDB
 * or a learner-data path.
 *
 * Non-vacuity: each test asserts the file it reads is a real implementation before it
 * asserts anything about it, so an empty or renamed file fails rather than passing silently.
 * A planted IndexedDB reference or a new hard-coded cache path is proven to fail this gate
 * in the Phase 22 gate-sensitivity record.
 */
describe('the Phase 22 offline shell caches only shell bytes and has no learner-data path', () => {
  const WORKER_PATH = 'public/sw.js';
  const REGISTRATION_PATH = 'src/services/offlineShell.ts';
  const GENERATOR_PATH = 'scripts/generate-offline-shell.mjs';

  it('the worker precaches only the manifest-named shell assets, and never touches IndexedDB', () => {
    for (const file of [WORKER_PATH, REGISTRATION_PATH, GENERATOR_PATH]) {
      expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
    }

    const workerSource = readFileSync(path.join(REPO_ROOT, WORKER_PATH), 'utf8');
    // Comments are blanked first: the worker's header *describes* IndexedDB and the
    // learner-data rule at length, and a scan that fired on its own documentation would be
    // the wrong gate. The raw text is separately required to name IndexedDB, so the rule is
    // documented *and* the code is checked.
    const workerCode = stripComments(workerSource);
    expect(workerSource).toContain('indexedDB');
    for (const forbidden of [
      'indexedDB',
      'localStorage',
      'sessionStorage',
      'openDatabase',
      'IDBKeyRange',
    ]) {
      expect(workerCode, `${WORKER_PATH} must not use ${forbidden}`).not.toContain(forbidden);
    }

    // Non-vacuity: a real worker, and its cache allowlist is the generated manifest rather
    // than a literal list written into the worker.
    expect(workerCode.length, `${WORKER_PATH} is empty`).toBeGreaterThan(1000);
    expect(workerCode).toContain("importScripts('offline-shell-manifest.js')");
    expect(workerCode).toContain('MANIFEST.assets');
    expect(workerCode).toContain('SHELL_ASSET_PATHS.has(');

    // Every absolute-path string literal in the worker is one of the two reviewed deny-list
    // entries. A learner-data cache path - `cache.put('/subjects/...')`,
    // `cache.addAll(['/notes/...'])`, or a new server route - appears here as a new literal
    // and fails by name. The document and the asset allowlist come from the manifest, not
    // from a literal, so this list is expected to stay at exactly these two.
    const absolutePathLiterals = [...workerCode.matchAll(/['"`](\/[^'"`\n]*)['"`]/g)]
      .map((match) => match[1] as string)
      .sort();
    expect(absolutePathLiterals, 'a hard-coded cache path was added to the worker').toEqual([
      '/api/',
      '/uploads/',
    ]);
  });

  it('the registration wrapper is flag-gated and reaches no learner storage', () => {
    const registrationSource = readFileSync(path.join(REPO_ROOT, REGISTRATION_PATH), 'utf8');
    const registrationCode = stripComments(registrationSource);
    // Non-vacuity: the module really registers a worker.
    expect(registrationCode).toContain('navigator.serviceWorker.register');
    // ...and it is inert unless the build set the flag: it self-registers only on the
    // flagged build, and the guard is the flag value, not an ambient condition.
    expect(registrationCode).toContain("import.meta.env.VITE_OFFLINE_SHELL === 'true'");
    for (const forbidden of [
      'indexedDB',
      'localStorage',
      'sessionStorage',
      'caches.',
      'openDatabase',
      'IDBKeyRange',
    ]) {
      expect(registrationCode, `${REGISTRATION_PATH} must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the shell manifest is generated from dist/index.html, never from a glob of dist', () => {
    // The property that keeps learner data out of the cache *by construction*: the
    // allowlist is the set of assets the emitted document references, so an
    // emitted-but-unreferenced file can never be named. A generator that globbed `dist/`
    // would replace that derivation with "whatever is on disk", which is exactly how a
    // learner-data path could enter the cache, so the glob surfaces are asserted absent.
    const generatorSource = readFileSync(path.join(REPO_ROOT, GENERATOR_PATH), 'utf8');
    const generatorCode = stripComments(generatorSource);
    // Non-vacuity: a real generator that reads a real document and writes a real manifest.
    expect(generatorCode).toContain('readFileSync');
    expect(generatorCode).toContain('writeFileSync');
    expect(generatorCode).toMatch(/index\.html/);
    for (const globPrimitive of [
      'readdirSync',
      'readdir(',
      'globSync',
      'glob(',
      'fast-glob',
      'createReadStream',
    ]) {
      expect(generatorCode, `the generator must not glob the dist tree: ${globPrimitive}`).not.toContain(
        globPrimitive,
      );
    }
  });

  it('the web app manifest carries app metadata only, not a learner-data key', () => {
    const manifestPath = path.join(REPO_ROOT, 'public', 'manifest.webmanifest');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const allowedKeys = [
      'name',
      'short_name',
      'description',
      'start_url',
      'scope',
      'display',
      'background_color',
      'theme_color',
      'icons',
    ] as const;
    for (const key of Object.keys(manifest)) {
      expect(allowedKeys, `unexpected web app manifest key: ${key}`).toContain(key);
    }
    // The values are app metadata; none may be a learner-shaped value or a server data route.
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(serialised).not.toMatch(/\/(?:api|uploads)\//);
  });
});
