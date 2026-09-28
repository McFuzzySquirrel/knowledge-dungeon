/**
 * Test support for the Phase 8 CC0 media gate.
 *
 * The gate is a CLI, so it is tested as one. Every negative case in the suite is a
 * real `node scripts/check-cc0-assets.mjs` run against a throwaway fixture tree, and
 * every assertion is about the process exit code and the diagnostic codes it printed.
 * That is deliberate: a test that reimplemented the rules in TypeScript would keep
 * passing while the script the CI job actually runs did something else, which is
 * exactly the failure a wiring gate exists to prevent.
 *
 * A fixture is a complete, *passing* tree with a small registry, so each test starts
 * from a green baseline and breaks exactly one thing. A fixture that was invalid to
 * begin with would make every negative assertion ambiguous.
 *
 * Privacy: the fixtures are synthetic asset trees. Nothing here reads, copies, or
 * reproduces learner data, and the registry fields the tests populate are license
 * facts, not user content. The one test that plants a canary string does it to assert
 * that the checker refuses to print it.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO_ROOT = process.cwd();
export const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-cc0-assets.mjs');
export const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-cozy-placeholders.mjs');
export const CC0_IDENTIFIER = 'CC0-1.0';
export const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

export interface GenerationBlock {
  script: string;
  command: string;
  recipe: string;
  embedMarker?: boolean;
  semanticCheck?: string;
  checksum?: string;
}

export interface RegistryEntry {
  id: string;
  path: string;
  classification: 'cc0-approved' | 'procedural' | 'legacy-unverified' | 'repository-authored';
  media: boolean;
  title: string;
  role: string;
  license: string;
  licenseVerified?: boolean;
  licenseUrl?: string;
  licenseUnverifiedReason?: string;
  creator?: string;
  source?: string;
  sourceUrl?: string;
  sourceUrlNotApplicable?: { reason: string };
  date?: string;
  dateKind?: 'created' | 'retrieved' | 'introduced-in-repository';
  sha256?: string;
  checksumPolicy?: 'pinned' | 'regenerated' | 'self-referential';
  generation?: GenerationBlock;
  modifications?: string[];
  introducedBy?: { commit: string | null; date: string | null; subject: string };
  modifiedBy?: { commit: string; date: string; subject: string }[];
  bundles: string[];
  pixiEligible: boolean;
  legacyRenderer: 'phaser' | 'react-dom' | 'both' | 'none' | 'unknown';
  retention?: string;
  notes?: string;
  // Deliberately untyped above the schema on purpose: the unknown-key case needs to be
  // able to plant a key the script does not know about.
  [extraKey: string]: unknown;
}

export interface Registry {
  schemaVersion: number;
  registry: string;
  purpose: string;
  privacy: string;
  license: { identifier: string; url: string; appliesTo: string };
  policy: Record<string, unknown>;
  paletteFamilies?: Record<string, Record<string, string>>;
  bundles: Record<string, { description: string; paths: string[]; admission: string }>;
  counts: Record<string, number>;
  assets: RegistryEntry[];
  [extraKey: string]: unknown;
}

export interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Everything the process printed, in the order a reader would see it. */
  output: string;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function spawnNode(entry: string, args: readonly string[]): GateResult {
  const run = spawnSync(process.execPath, [entry, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    code: run.status ?? -1,
    stdout: run.stdout,
    stderr: run.stderr,
    output: `${run.stdout}${run.stderr}`,
  };
}

/** Runs the gate. Arguments are passed through verbatim, as CI would. */
export function runGate(args: readonly string[] = []): GateResult {
  return spawnNode(CHECKER, args);
}

export function runGenerator(args: readonly string[] = []): GateResult {
  return spawnNode(GENERATOR, args);
}

/** The diagnostic codes a run printed, in order. */
export function codesOf(result: GateResult): string[] {
  return result.output
    .split('\n')
    .map((line) => /^E-[A-Z-]+(?= — )/.exec(line)?.[0])
    .filter((code): code is string => typeof code === 'string');
}

export interface Fixture {
  root: string;
  assetsRoot: string;
  registryPath: string;
  creditsPath: string;
  /** Rewrites the registry on disk. Use it to plant a defect, then re-run the gate. */
  writeRegistry(registry: Registry): void;
  /** Writes arbitrary bytes as the registry, for the unparseable-input case. */
  writeRawRegistry(content: string): void;
  /** Replaces one file's bytes, which is how a checksum mismatch is provoked. */
  writeAsset(relativePath: string, content: string): void;
  /** Adds a file the registry knows nothing about. */
  addUnregistered(relativePath: string, content: string): void;
  remove(relativePath: string): void;
  gate(extraArgs?: readonly string[]): GateResult;
  registry(): Registry;
  cleanup(): void;
}

const COZY_SVG = [
  '<!-- id: fixture-placeholder -->',
  '<!-- recipe: size 8x8 | seed 1 | families ink -->',
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">',
  '  <rect width="8" height="8" fill="#000000"/>',
  '</svg>',
  '',
].join('\n');
const LEGACY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"></svg>\n';
const CREDITS_TEXT = '# Fixture credits\n\n- `public/assets/sprites/legacy.svg` — Fixture.\n- `public/assets/cozy/fixture-placeholder.svg` — Fixture.\n- `public/assets/CREDITS.md` — Fixture.\n- `public/assets/asset-licenses.json` — Fixture.\n';

interface FixtureSeed {
  files: Map<string, string>;
  registry: Registry;
}

function seedFixture(): FixtureSeed {
  const files = new Map<string, string>([
    ['sprites/legacy.svg', LEGACY_SVG],
    ['cozy/fixture-placeholder.svg', COZY_SVG],
    ['CREDITS.md', CREDITS_TEXT],
  ]);

  const registry: Registry = {
    schemaVersion: 1,
    registry: 'Fixture registry',
    purpose: 'Fixture.',
    privacy: 'Fixture.',
    license: { identifier: CC0_IDENTIFIER, url: CC0_URL, appliesTo: 'Fixture.' },
    policy: { fixture: 'Fixture.' },
    bundles: {
      'pixi-default': {
        description: 'Fixture default bundle.',
        paths: ['public/assets/cozy/'],
        admission: 'cc0-approved or procedural only.',
      },
    },
    counts: { 'cc0-approved': 0, procedural: 1, 'legacy-unverified': 1, 'repository-authored': 2 },
    assets: [
      {
        id: 'legacy-fixture-sprite',
        path: 'public/assets/sprites/legacy.svg',
        classification: 'legacy-unverified',
        media: true,
        title: 'Legacy fixture sprite',
        role: 'Fixture.',
        license: 'UNVERIFIED',
        licenseVerified: false,
        licenseUnverifiedReason: 'Fixture: no grant is recorded anywhere, so none is claimed.',
        source: 'Fixture.',
        bundles: [],
        pixiEligible: false,
        legacyRenderer: 'phaser',
        retention: 'keep-until-phaser-removal',
        date: '2026-01-01',
        dateKind: 'introduced-in-repository',
        introducedBy: { commit: '0000000', date: '2026-01-01', subject: 'Fixture.' },
        modifications: ['Fixture.'],
        sha256: sha256(LEGACY_SVG),
      },
      {
        id: 'fixture-placeholder',
        path: 'public/assets/cozy/fixture-placeholder.svg',
        classification: 'procedural',
        media: true,
        title: 'Fixture placeholder',
        role: 'Fixture.',
        license: CC0_IDENTIFIER,
        licenseUrl: CC0_URL,
        creator: 'Fixture generator',
        source: 'Generated by the fixture generator.',
        sourceUrlNotApplicable: { reason: 'Generated by a committed script.' },
        bundles: ['pixi-default'],
        pixiEligible: true,
        legacyRenderer: 'none',
        date: '2026-01-01',
        dateKind: 'created',
        generation: {
          script: 'scripts/generate-fixture.mjs',
          command: 'node scripts/generate-fixture.mjs',
          recipe: 'size 8x8 | seed 1 | families ink',
          embedMarker: true,
        },
        modifications: ['Fixture.'],
        sha256: sha256(COZY_SVG),
      },
      {
        id: 'fixture-credits',
        path: 'public/assets/CREDITS.md',
        classification: 'repository-authored',
        media: false,
        title: 'Fixture credits',
        role: 'Fixture.',
        license: 'MIT',
        licenseVerified: true,
        licenseUrl: 'LICENSE',
        creator: 'Fixture',
        source: 'Authored in the fixture.',
        sourceUrl: 'https://example.invalid/fixture',
        bundles: [],
        pixiEligible: false,
        legacyRenderer: 'none',
        date: '2026-01-01',
        dateKind: 'created',
        modifications: ['Fixture.'],
        sha256: sha256(CREDITS_TEXT),
      },
      {
        // The registry registers itself: the "every file is registered" rule covers it
        // too, and a digest of the file that carries the digests cannot be pinned.
        id: 'fixture-registry',
        path: 'public/assets/asset-licenses.json',
        classification: 'repository-authored',
        media: false,
        title: 'Fixture registry',
        role: 'Fixture.',
        license: 'MIT',
        licenseVerified: true,
        licenseUrl: 'LICENSE',
        creator: 'Fixture',
        source: 'Authored in the fixture.',
        sourceUrl: 'https://example.invalid/fixture',
        bundles: [],
        pixiEligible: false,
        legacyRenderer: 'none',
        date: '2026-01-01',
        dateKind: 'created',
        checksumPolicy: 'self-referential',
        generation: {
          script: 'scripts/generate-fixture.mjs',
          command: 'node scripts/generate-fixture.mjs',
          recipe: 'Fixture registry.',
          checksum: 'A digest of the file that carries the digests cannot be pinned.',
        },
        modifications: ['Fixture.'],
      },
    ],
  };

  return { files, registry };
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kd-license-gate-'));
  const assetsRoot = path.join(root, 'public', 'assets');
  const registryPath = path.join(assetsRoot, 'asset-licenses.json');
  const creditsPath = path.join(assetsRoot, 'CREDITS.md');
  // The checker requires a declared generating script to be a file inside the root, so
  // a procedural fixture needs one. The stub is never executed: the gate only checks
  // that the declared path exists, which is the property under test.
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'generate-fixture.mjs'), '// fixture stub\n', 'utf8');
  mkdirSync(assetsRoot, { recursive: true });

  const writeRegistry = (registry: Registry): void => {
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  };
  const { files, registry } = seedFixture();
  for (const [relativePath, content] of files) {
    const target = path.join(assetsRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  writeRegistry(registry);

  return {
    root,
    assetsRoot,
    registryPath,
    creditsPath,
    writeRegistry,
    writeRawRegistry(content) {
      writeFileSync(registryPath, content, 'utf8');
    },
    writeAsset(relativePath, content) {
      writeFileSync(path.join(assetsRoot, relativePath), content, 'utf8');
    },
    addUnregistered(relativePath, content) {
      const target = path.join(assetsRoot, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    },
    remove(relativePath) {
      rmSync(path.join(assetsRoot, relativePath), { force: true });
    },
    gate(extraArgs = []) {
      return runGate([
        `--assets-root=${assetsRoot}`,
        `--registry=${registryPath}`,
        `--credits=${creditsPath}`,
        ...extraArgs,
      ]);
    },
    registry() {
      return JSON.parse(readFileSync(registryPath, 'utf8')) as Registry;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
