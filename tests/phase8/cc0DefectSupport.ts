/**
 * Fixture helpers for the three CC0 gate defects closed after the Phase 8 QA pass.
 *
 * `support/licenseGate.ts` is the QA engineer's and is not modified by the tests
 * that use it: it builds a complete, *passing* assets fixture, and every negative
 * case in this folder starts from that green baseline and breaks exactly one thing.
 * What it does not have is a source tree, because the gate it was written against
 * did not look at one - and it does not have a helper for adding a registry entry
 * for a file that is not under the assets root, or for a file whose bytes are a
 * real PNG rather than text.
 *
 * So this module adds exactly that, and nothing else. It is deliberately not a
 * reimplementation of the gate's rules: it writes files, appends credits, and pins
 * a digest, and every assertion about whether a run passes or fails is made
 * against a real `node scripts/check-cc0-assets.mjs` process.
 *
 * Privacy: these are synthetic asset bytes and synthetic license facts. No learner
 * data is read, written, printed, or asserted on anywhere in this folder.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sha256, type Fixture, type Registry, type RegistryEntry } from './support/licenseGate';

export const CC0_IDENTIFIER = 'CC0-1.0';
export const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
/** A date the gate accepts, so a test that is not about dates cannot fail on one. */
export const FIXTURE_DATE = '2026-01-01';

/**
 * Real container headers, so a media-signature assertion is a fact about the bytes
 * rather than a pattern that could be satisfied by any bytes at all. Each is a
 * valid opening sequence for its format, followed by filler.
 */
export const MEDIA_BYTES = {
  png: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('IHDR', 'ascii'), Buffer.alloc(64, 0x2a)]),
  jpeg: Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('JFIF', 'ascii'), Buffer.alloc(64, 0x2a)]),
  gif: Buffer.concat([Buffer.from('474946383961', 'hex'), Buffer.alloc(64, 0x2a)]),
  ogg: Buffer.concat([Buffer.from('4f676753', 'hex'), Buffer.alloc(64, 0x2a)]),
  webp: Buffer.concat([
    Buffer.from('52494646', 'hex'),
    Buffer.alloc(4, 0x20),
    Buffer.from('57454250', 'hex'),
    Buffer.alloc(32, 0x2a),
  ]),
  mp4: Buffer.concat([Buffer.alloc(4, 0x18), Buffer.from('66747970', 'hex'), Buffer.from('isom', 'ascii'), Buffer.alloc(32, 0x2a)]),
  gzip: Buffer.concat([Buffer.from('1f8b0800', 'hex'), Buffer.alloc(64, 0x2a)]),
  flac: Buffer.concat([Buffer.from('664c6143', 'hex'), Buffer.alloc(64, 0x2a)]),
} as const;

export type MediaFormat = keyof typeof MEDIA_BYTES;

/** Bytes that are plain text, so a non-media file in a fixture really is non-media. */
export const TEXT_BYTES = Buffer.from('# a plain text file\n', 'utf8');

/** Writes bytes anywhere under the fixture root and returns the absolute path. */
export function writeAt(root: string, repoRelativePath: string, content: string | Buffer): string {
  const target = path.join(root, repoRelativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

/**
 * Writes a file under the fixture's source tree.
 *
 * `repoRelativePath` is the repository-relative form the registry uses, e.g.
 * `src/ui/Hero.tsx`, so a test can use the same string for the file, for the
 * import specifier that reaches it, and for a registry entry.
 */
export function writeSourceFile(fixture: Fixture, repoRelativePath: string, content: string | Buffer): string {
  if (!repoRelativePath.startsWith('src/')) {
    throw new Error(`Expected a source-tree path, got ${repoRelativePath}.`);
  }
  return writeAt(fixture.root, repoRelativePath, content);
}

/** Reads a file the fixture wrote, for a digest or an existence assertion. */
export function readAt(fixture: Fixture, repoRelativePath: string): Buffer {
  return readFileSync(path.join(fixture.root, repoRelativePath));
}

/**
 * Appends credit lines and re-pins the credits file's own digest.
 *
 * The fixture's credits entry carries a SHA-256, so editing the page without
 * re-pinning it would add a checksum failure to every test that touches the page -
 * and a test with two failures in it does not prove which one it is about.
 */
export function appendCredits(fixture: Fixture, repoRelativePaths: readonly string[]): void {
  const registry = fixture.registry();
  const creditsPath = path.join(fixture.assetsRoot, 'CREDITS.md');
  const credits = `${readFileSync(creditsPath, 'utf8')}${repoRelativePaths
    .map((assetPath) => `- \`${assetPath}\` — Fixture.\n`)
    .join('')}`;
  writeFileSync(creditsPath, credits, 'utf8');
  for (const entry of registry.assets) {
    if (entry.id === 'fixture-credits') entry.sha256 = sha256(credits);
  }
  fixture.writeRegistry(registry);
}

/** Refreshes the per-class count block, which the gate compares against the entries. */
export function refreshCounts(registry: Registry): void {
  const counts: Record<string, number> = {};
  for (const entry of registry.assets) {
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  }
  registry.counts = counts;
}

/**
 * A `procedural` media entry, for a file this repository draws itself.
 *
 * `procedural` rather than `cc0-approved` is the honest class for a fixture: it
 * carries a CC0 identifier because the class requires one, and it says in
 * `source` that the file was drawn here rather than asserting a grant that does not
 * exist. Nothing in this repository has a verified CC0 grant.
 */
export function proceduralEntry(
  id: string,
  repoRelativePath: string,
  bytes: string | Buffer,
): RegistryEntry {
  return {
    id,
    path: repoRelativePath,
    classification: 'procedural',
    media: true,
    title: `Fixture ${id}`,
    role: 'Fixture.',
    license: CC0_IDENTIFIER,
    licenseUrl: CC0_URL,
    creator: 'Fixture author',
    source: 'Drawn in the fixture.',
    sourceUrlNotApplicable: { reason: 'Drawn in this repository, so there is no upstream URL.' },
    date: FIXTURE_DATE,
    dateKind: 'created',
    generation: {
      script: 'scripts/generate-fixture.mjs',
      command: 'node scripts/generate-fixture.mjs',
      recipe: 'fixture bytes',
    },
    modifications: ['Fixture.'],
    sha256: sha256(bytes),
    bundles: [],
    pixiEligible: false,
    legacyRenderer: 'none',
  };
}

/**
 * A `repository-authored` **non-media** entry, the declaration SERIOUS-2 is about:
 * the honest way to register a document, and the dishonest way to register a
 * renamed image. Which one it is depends only on the extension and the bytes, so
 * the tests supply both explicitly.
 */
export function nonMediaEntry(
  id: string,
  repoRelativePath: string,
  bytes: string | Buffer,
): RegistryEntry {
  return {
    id,
    path: repoRelativePath,
    classification: 'repository-authored',
    media: false,
    title: `Fixture ${id}`,
    role: 'Fixture.',
    license: 'MIT',
    licenseVerified: true,
    licenseUrl: 'LICENSE',
    creator: 'Fixture author',
    source: 'Authored in the fixture.',
    sourceUrl: 'https://example.invalid/fixture',
    date: FIXTURE_DATE,
    dateKind: 'created',
    sha256: sha256(bytes),
    modifications: ['Fixture.'],
    bundles: [],
    pixiEligible: false,
    legacyRenderer: 'none',
  };
}

/** Registers a file the fixture already wrote: entry, credits line, and counts. */
export function registerWrittenFile(
  fixture: Fixture,
  entry: RegistryEntry,
  options: { credited?: boolean } = {},
): RegistryEntry {
  const registry = fixture.registry();
  registry.assets = [...registry.assets, entry];
  refreshCounts(registry);
  fixture.writeRegistry(registry);
  if (options.credited !== false) appendCredits(fixture, [entry.path]);
  return entry;
}
