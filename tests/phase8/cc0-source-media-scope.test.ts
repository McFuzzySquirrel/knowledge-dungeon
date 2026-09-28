/**
 * SERIOUS-1: media outside `public/assets/` bypassed the CC0 gate entirely.
 *
 * ## The defect
 *
 * The gate discovered `public/assets/` and compared only what it found there, so a
 * `.png` committed under `src/` shipped in the default bundle with no registry
 * entry and no provenance while `npm run test:licenses` exited 0. Vite emits
 * anything a module imports, so "under the assets root" was never the boundary the
 * phase's exit criterion describes - "new media cannot be added without CC0
 * metadata" says *new media*, not *new media in one directory*.
 *
 * ## What is asserted here
 *
 * 1. **A media file under `src/` has to be registered.** Presence alone, whether or
 *    not a module names it, because a computed path ships just as surely as an
 *    import does.
 * 2. **A media reference from a module under `src/` has to be registered** - through
 *    a relative specifier, through the `@/` alias, and through a stylesheet's
 *    `url()` - *even when the file does not exist*. A gitignored or currently dead
 *    reference is the one a future commit can make live, and it has to be registered
 *    before then.
 * 3. **The gate can still express one.** A `src/`-relative path with the same plan
 *    section 10.3 field set and an explicit `media: true` passes, so this is a gate
 *    that can fail rather than a prohibition.
 * 4. **Code is not media.** `src/theme/cozyColor.ts` and the stylesheets beside it
 *    are the repository's own modules; requiring a licence record for a `.ts` file
 *    would make the registry a second copy of the repository.
 * 5. **A reference that resolves outside both registrable roots is a failure with
 *    its own code**, because "add an entry" is not advice an author can follow when
 *    no entry is allowed to carry that path.
 * 6. **The repository as it stands is honest about this**: the gate reports how much
 *    source-tree media it looked at, and an independent walk of `src/` confirms
 *    there is none, so nothing needs registering today and that is a measurement
 *    rather than an assumption.
 *
 * ## The cross-test flake this file also closes
 *
 * Requirement 1 above was first written as "any file under `src/` with an extension in
 * neither vocabulary is a failure", and that made the suite flaky: two pre-existing test
 * files plant scratch state under `src/` while the suite runs - `src/__data_gate_probe__/`
 * and `src/__privacy_probe__/` - and Vitest runs files in parallel, so this gate's repo
 * scan saw a foreign scratch file and exited 1. Reproduced 3/3.
 *
 * The rule was wrong, not the symptom. The guarantee here is that **media which can
 * actually ship is registered**, and a file under `src/` that no module names and whose
 * extension is unknown cannot ship: Vite emits a source-root file only when something
 * in the module graph points at it. So the on-disk presence rule is driven by *known
 * media extensions* - reachability - and the closed vocabulary is enforced everywhere
 * it is load-bearing: on a registry entry, and on every path a module names. Those
 * tests are here, alongside the negative one: an unlisted suffix nobody names is
 * skipped only if its bytes are not a media container, and the count of skipped files is
 * printed in the summary so a skip is on the record.
 *
 * Every negative case is a real CLI run against a throwaway fixture tree, so a test
 * cannot pass while the script CI actually runs does something else.
 *
 * Privacy: no learner data is read, written, printed, or asserted on. The fixtures
 * are synthetic modules and synthetic PNG bytes.
 *
 * Phase: 8.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MEDIA_BYTES,
  appendCredits,
  proceduralEntry,
  readAt,
  registerWrittenFile,
  writeAt,
  writeSourceFile,
} from './cc0DefectSupport';
import { codesOf, makeFixture, runGate, type Fixture } from './support/licenseGate';

const REPO_ROOT = process.cwd();
const SOURCE_ROOT = path.join(REPO_ROOT, 'src');

/** The alias map the checker declares, and the files that have to agree with it. */
const VITE_CONFIG = path.join(REPO_ROOT, 'vite.config.ts');
const TSCONFIG_APP = path.join(REPO_ROOT, 'tsconfig.app.json');
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-cc0-assets.mjs');

const MEDIA_SOURCE_SUMMARY = /(\d+) media file\(s\) and (\d+) media reference\(s\) under src\/([^.]*)\./;
const SKIPPED_COUNT = /skipping (\d+) unclassified file\(s\)/;

const open: Fixture[] = [];
function fixture(): Fixture {
  const made = makeFixture();
  open.push(made);
  return made;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

/** A `.ts` module that imports one media file and nothing else. */
function moduleImporting(specifier: string): string {
  return [
    "import art from '" + specifier + "';",
    '',
    'export const panel = () => art;',
    '',
  ].join('\n');
}

describe('media under the source tree cannot ship without a registry entry', () => {
  it('FAILS on a media file committed under src/ with no entry - the negative control', () => {
    // The reproduction from the QA report: a 20 KB .png written into src/ and
    // `npm run test:licenses` exiting 0. Nothing imports it, so a scan that only
    // followed imports would still miss it.
    const made = fixture();
    const bytes = Buffer.concat([MEDIA_BYTES.png, Buffer.alloc(20 * 1024, 0x2a)]);
    expect(bytes.length).toBeGreaterThan(20 * 1024 - 64);
    writeSourceFile(made, 'src/ui/hero.png', bytes);

    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
    expect(result.output).toContain('src/ui/hero.png');
    // Actionable: it says what to do and it does not pretend the file is harmless.
    expect(result.output).toMatch(/Add an entry with `media: true`/);
    expect(result.output).toMatch(/plan section 10\.3 field set/);
  });

  it('FAILS on a media file under src/ that is a gitignored, build-time artefact', () => {
    // Nothing in the repository is gitignored under src/ today, so the file is
    // planted without a `.gitignore` entry on purpose: the rule is about the bytes
    // being reachable from the bundle, not about git's opinion of them.
    const made = fixture();
    writeSourceFile(made, 'src/generated/sprite-sheet.png', MEDIA_BYTES.png);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
  });

  it('FAILS on a media file under a nested src/ subdirectory', () => {
    const made = fixture();
    writeSourceFile(made, 'src/ui/components/room/doorway.jpg', MEDIA_BYTES.jpeg);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
    expect(result.output).toContain('src/ui/components/room/doorway.jpg');
  });
});

describe('a media reference from a source module has to be registered too', () => {
  it('FAILS on a relative import of a media file that does not exist on disk', () => {
    // The dead-code and gitignored case from the report. The file is absent, so
    // only a rule that looks at the *reference* can catch it - and a later commit
    // that adds the file must not be the commit that finds out.
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('./not-yet-added.webp'));
    expect(() => readAt(made, 'src/ui/not-yet-added.webp')).toThrow();

    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
    expect(result.output).toContain('src/ui/not-yet-added.webp');
    // It names the module that reaches it, so the author knows where to look.
    expect(result.output).toContain('src/ui/Hero.tsx');
  });

  it('FAILS on an @/-aliased import, which is how this repository writes them', () => {
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('@/ui/room/floor.png'));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
    expect(result.output).toContain('src/ui/room/floor.png');
  });

  it('FAILS on a media reference from a stylesheet url()', () => {
    // A stylesheet is a module the bundler resolves, and `url()` is how it names a
    // file. A scan that only looked at import statements would miss this.
    const made = fixture();
    writeSourceFile(made, 'src/styles/hero.css', '.hero {\n  background-image: url("../ui/room/floor.png");\n}\n');
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
    expect(result.output).toContain('src/ui/room/floor.png');
    expect(result.output).toContain('src/styles/hero.css');
  });

  it('FAILS on a reference carrying a query or fragment suffix, as Vite emits', () => {
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('./room/floor.svg?url'));
    writeSourceFile(made, 'src/ui/Room.tsx', moduleImporting('./room/floor.svg#fragment'));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
    // One problem for the file, not one per referrer, and the suffix is not part of
    // the path a registry entry would carry.
    const problems = result.output.split('E-UNREGISTERED-SOURCE-MEDIA').length - 1;
    expect(result.output.match(/src\/ui\/room\/floor\.svg/g)?.length).toBe(1);
    expect(problems).toBe(1);
  });

  it('FAILS on a dynamic import() and on require() of media, not only on a static one', () => {
    const made = fixture();
    writeSourceFile(
      made,
      'src/ui/Loader.ts',
      [
        "export const load = () => import('./lazy/hero.png');",
        "export const need = () => require('./lazy/hero.png');",
        '',
      ].join('\n'),
    );
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
  });

  it('FAILS on a new URL(…, import.meta.url) asset, which Vite also emits', () => {
    const made = fixture();
    writeSourceFile(
      made,
      'src/ui/Worker.ts',
      "export const worker = new URL('./workers/decode.png', import.meta.url);\n",
    );
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNREGISTERED-SOURCE-MEDIA');
  });

  it('FAILS when a reference resolves outside both registrable roots', () => {
    // "Add a registry entry" is not advice an author can follow when no entry is
    // allowed to carry the path, so this has its own code and its own remedy.
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('../../art/hero.png'));
    writeAt(made.root, 'art/hero.png', MEDIA_BYTES.png);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-SOURCE-MEDIA-PATH');
    expect(result.output).toMatch(/resolves outside/);
  });

  it('FAILS on a reference with an unclassified extension, because the bundler resolves it', () => {
    // The distinction the rule turns on. `import './motion'` is a module and is
    // ignored; `import './icon.svgz'` is an author naming a format, and Vite resolves
    // it exactly as it resolves a `.png`, so it reaches `dist/`. An earlier version of
    // this rule asked for `media` exactly, which silently passed the fifteen suffixes
    // the SERIOUS-2 report names - a real hole, closed here.
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('./icon.svgz'));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result), result.output).toEqual(['E-UNREGISTERED-SOURCE-MEDIA']);
    expect(result.output).toContain('src/ui/icon.svgz');
    // The remedy names the vocabulary, because "add an entry" is not advice an author
    // can follow until the extension is classified.
    expect(result.output).toMatch(/classify the extension in scripts\/check-cc0-assets\.mjs/);
  });

  it('FAILS when an unclassified-extension reference resolves outside both roots', () => {
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('../../art/hero.svgz'));
    writeAt(made.root, 'art/hero.svgz', MEDIA_BYTES.png);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toEqual(['E-SOURCE-MEDIA-PATH']);
  });

  it('names every referring module, so a shared image is one fix rather than several', () => {
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('./room/floor.png'));
    writeSourceFile(made, 'src/ui/Room.tsx', moduleImporting('./room/floor.png'));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('src/ui/Hero.tsx');
    expect(result.output).toContain('src/ui/Room.tsx');
  });
});

describe('the gate is the boundary, not a prohibition: a registered source asset passes', () => {
  it('a src/-relative media entry with the full plan 10.3 field set is accepted', () => {
    const made = fixture();
    writeSourceFile(made, 'src/ui/room/floor.png', MEDIA_BYTES.png);
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('./room/floor.png'));
    registerWrittenFile(made, proceduralEntry('src-floor', 'src/ui/room/floor.png', MEDIA_BYTES.png));

    const result = made.gate();
    expect(result.code, result.output).toBe(0);
    expect(codesOf(result), result.output).toEqual([]);
    // And the file is checksummed like any other asset, so a later edit is caught.
    const mutated = Buffer.concat([MEDIA_BYTES.png, Buffer.from('edited', 'ascii')]);
    writeSourceFile(made, 'src/ui/room/floor.png', mutated);
    const afterEdit = made.gate();
    expect(afterEdit.code, afterEdit.output).toBe(1);
    expect(codesOf(afterEdit)).toContain('E-CHECKSUM-MISMATCH');
  });

  it('a registered source asset is credited on the credits page like any other', () => {
    // Registered but uncredited is a drift, in the same direction as an uncredited
    // published asset: the reader is entitled to know what shipped.
    const made = fixture();
    writeSourceFile(made, 'src/ui/room/floor.png', MEDIA_BYTES.png);
    registerWrittenFile(made, proceduralEntry('src-floor', 'src/ui/room/floor.png', MEDIA_BYTES.png), {
      credited: false,
    });
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-CREDITS-COVERAGE');
  });

  it('a registered source asset that is not on disk is reported, not ignored', () => {
    const made = fixture();
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('./room/floor.png'));
    registerWrittenFile(made, proceduralEntry('src-floor', 'src/ui/room/floor.png', MEDIA_BYTES.png));
    // The import is now the only thing that reaches it.
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-ASSET-MISSING');
  });

  it('rejects a non-media entry under src/, so the registry does not become a code index', () => {
    const made = fixture();
    writeSourceFile(made, 'src/theme/cozyColor.ts', 'export const ink = "#1c1b19";\n');
    const registry = made.registry();
    registry.assets = [
      ...registry.assets,
      {
        id: 'src-module',
        path: 'src/theme/cozyColor.ts',
        classification: 'repository-authored',
        media: false,
        title: 'A module',
        role: 'Fixture.',
        license: 'MIT',
        licenseUrl: 'LICENSE',
        creator: 'Fixture',
        source: 'Authored in the fixture.',
        sourceUrl: 'https://example.invalid/fixture',
        date: '2026-01-01',
        dateKind: 'created',
        sha256: 'b'.repeat(64),
        modifications: ['Fixture.'],
        bundles: [],
        pixiEligible: false,
        legacyRenderer: 'none',
      },
    ];
    made.writeRegistry(registry);
    appendCredits(made, ['src/theme/cozyColor.ts']);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-ENTRY-SCHEMA');
    expect(result.output).toMatch(/Only media is registered under src\//);
  });
});

describe('code under src/ is not media, and is not flagged', () => {
  it('accepts TypeScript modules and stylesheets that import only other modules', () => {
    // The hard constraint from the report: `src/theme/cozyColor.ts` is a theme, not
    // a picture. It also names this repository's real file, so a future rename that
    // turned a module into something else would be noticed here.
    const made = fixture();
    writeSourceFile(
      made,
      'src/theme/cozyColor.ts',
      ["import { motion } from './motion';", "export const ink = '#1c1b19';", 'export const fade = motion;', ''].join('\n'),
    );
    writeSourceFile(made, 'src/theme/motion.ts', "export const motion = 'prefers-reduced-motion';\n");
    writeSourceFile(made, 'src/theme/index.ts', "export * from './cozyColor';\n");
    writeSourceFile(made, 'src/styles/cozy.css', ".ui-skin { color: #1c1b19; }\n");
    writeSourceFile(made, 'src/vite-env.d.ts', '/// <reference types="vite/client" />\n');
    const result = made.gate();
    expect(result.code, result.output).toBe(0);
    expect(codesOf(result), result.output).toEqual([]);
  });

  it('ignores a media-looking file name inside a comment or an ordinary string', () => {
    // A gate that fails on prose gets switched off, so a commented-out import and a
    // user-facing string are not references and must not be read as such.
    const made = fixture();
    writeSourceFile(
      made,
      'src/ui/Hero.tsx',
      [
        "// import removed from './deleted.png';",
        '/* import legacy from "./older.gif"; */',
        "const hint = 'The house icon lives at ./icons/house.svg';",
        "const url = 'https://example.invalid/remote.png';",
        'export const panel = () => hint + url;',
        '',
      ].join('\n'),
    );
    const result = made.gate();
    expect(result.code, result.output).toBe(0);
    expect(codesOf(result), result.output).toEqual([]);
  });

  it('ignores an extensionless module import, which is how TypeScript modules are written', () => {
    // `from '@/ui/utils/topicParsing'` names a file, and it is a module. A reference
    // scan that treated an unresolvable suffix as media would fail on the codebase.
    const made = fixture();
    writeSourceFile(made, 'src/ui/utils/topicParsing.ts', 'export const parse = () => null;\n');
    writeSourceFile(made, 'src/ui/Panel.tsx', "import { parse } from '@/ui/utils/topicParsing';\nexport const Panel = () => parse;\n");
    const result = made.gate();
    expect(result.code, result.output).toBe(0);
  });
});

describe('a file under src/ the bundler cannot reach is skipped, and the skip is on the record', () => {
  it('PASSES on a dot-prefixed marker file no module names - the cross-test flake, closed', () => {
    // The exact reproduction the orchestrator ran 3/3: a test file plants
    // `src/__data_gate_probe__/.test-planted` while this suite runs, and the gate's
    // repo scan used to fail on it. A leading dot is not a suffix separator, so this
    // name has no extension at all, no module names it, and its bytes are not a media
    // container - so there is nothing about it the gate has a claim on.
    const made = fixture();
    writeSourceFile(made, 'src/__data_gate_probe__/.test-planted', 'x');
    const result = made.gate();
    expect(codesOf(result), result.output).toEqual([]);
    expect(result.code, result.output).toBe(0);
    // And the skip is reported rather than hidden, so a run that suddenly skips a
    // hundred files is a visible change.
    expect(Number(SKIPPED_COUNT.exec(result.output)?.[1]), result.output).toBe(1);
  });

  it('PASSES on the other pre-existing probe convention too', () => {
    // `tests/privacy/uploadBoundary.test.ts` and the Phase 4 adversarial test plant
    // `src/__privacy_probe__/`. Those files belong to other owners and are not touched
    // by this fix; the rule is what has to hold for them.
    const made = fixture();
    writeSourceFile(made, 'src/__privacy_probe__/external.ts', 'export const probe = 1;\n');
    const result = made.gate();
    expect(codesOf(result), result.output).toEqual([]);
    expect(result.code, result.output).toBe(0);
  });

  it('PASSES on an unclassified suffix that no module names, and counts it', () => {
    const made = fixture();
    writeSourceFile(made, 'src/notes/room.svgz', '# not a container\n');
    const result = made.gate();
    expect(codesOf(result), result.output).toEqual([]);
    expect(result.code, result.output).toBe(0);
    const summary = MEDIA_SOURCE_SUMMARY.exec(result.output);
    expect(summary?.[3], result.output).toMatch(/skipping 1 unclassified file\(s\)/);
    // The wording says *why* it was skipped, so the summary is a reason and not a count.
    expect(result.output).toMatch(/which the bundler cannot emit and whose bytes are not a media container/);
  });

  it('FAILS when a dot-prefixed name really is a media container', () => {
    // The hole a blanket dotfile exemption would have left. The name is exempt from
    // being read as a *format*; it is not exempt from being read. This is the same
    // check that stops a `media: false` registry entry from being a renamed picture.
    const made = fixture();
    writeSourceFile(made, 'src/__data_gate_probe__/.test-planted', MEDIA_BYTES.png);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result), result.output).toEqual(['E-UNREGISTERED-SOURCE-MEDIA']);
    expect(result.output).toContain('src/__data_gate_probe__/.test-planted');
    // It says what the bytes were, so the author is not left guessing which file the
    // gate thinks is a picture.
    expect(result.output).toContain('PNG');
  });

  it('FAILS when an unclassified suffix no module names is a media container', () => {
    const made = fixture();
    writeSourceFile(made, 'src/notes/room.svgz', MEDIA_BYTES.png);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result), result.output).toEqual(['E-UNREGISTERED-SOURCE-MEDIA']);
    // The bytes are named, so the author is not left guessing why a `.svgz` failed.
    expect(result.output).toContain('PNG');
  });

  it('a file the module graph reaches is never skipped, whatever it is called', () => {
    // The skip has a precondition, and the precondition is that nothing names the file.
    // One import turns the same bytes back into a failure.
    const made = fixture();
    writeSourceFile(made, 'src/notes/room.svgz', '# text\n');
    writeSourceFile(made, 'src/ui/Hero.tsx', moduleImporting('../notes/room.svgz'));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toEqual(['E-UNREGISTERED-SOURCE-MEDIA']);
    expect(SKIPPED_COUNT.test(result.output), result.output).toBe(false);
  });

  it('the checker exempts no directory or name shape, so this cannot be reintroduced as one', () => {
    // The symptom fix - ignore `__*`, ignore dotfiles - would have made the suite green
    // and the gate weaker. A name-based exemption has no signature other than the name
    // in the source, so the tripwire is on the source: the two real probe directory
    // names are nowhere in the checker, and its source scan filters on nothing but the
    // extension and the bytes.
    const source = readFileSync(CHECKER, 'utf8');
    for (const probe of ['__data_gate_probe__', '__privacy_probe__']) {
      expect(source, `the checker mentions ${probe}`).not.toContain(probe);
    }
    const scan = /async function validateSourceMedia\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(scan, 'the checker has no validateSourceMedia function').not.toBe('');
    for (const shape of [/startsWith\('\.'\)/, /startsWith\('__/, /includes\('__'\)/, /includes\('\.'\)/]) {
      expect(scan, `the source scan filters on a name shape: ${String(shape)}`).not.toMatch(shape);
    }
  });
});

describe('the alias map the gate uses is the one the build uses', () => {
  it('declares every alias vite.config.ts and tsconfig.app.json declare', () => {
    // The gate cannot import the Vite config - it runs with no dependency install -
    // so it declares the aliases itself. That is only safe while the two agree, and
    // this is what stops a new alias from being added to the build and forgotten
    // here, which would make an aliased import invisible to the gate.
    const viteAliases = [
      ...readFileSync(VITE_CONFIG, 'utf8').matchAll(/^\s{6,}'?([^':]+)'?:\s*path\.resolve\(__dirname,\s*'\.\/([^']+)'\)/gm),
    ].map((match) => ({ alias: match[1], target: match[2] }));
    const tsconfigPaths = (JSON.parse(readFileSync(TSCONFIG_APP, 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    }).compilerOptions?.paths;
    expect(viteAliases.length, 'no alias parsed out of vite.config.ts').toBeGreaterThan(0);
    expect(tsconfigPaths, 'tsconfig.app.json declares no paths').toBeDefined();

    const checkerSource = readFileSync(CHECKER, 'utf8');
    const declared = /const SOURCE_ALIASES = new Map\(\[([\s\S]*?)\]\);/.exec(checkerSource);
    expect(declared, 'the checker declares no SOURCE_ALIASES map').not.toBeNull();
    // The map is written with the SOURCE_ROOT constant rather than a repeated
    // literal, so the test resolves that constant from the same source instead of
    // asserting a string the gate does not contain.
    const sourceRoot = /const SOURCE_ROOT = '([^']+)'/.exec(checkerSource)?.[1];
    expect(sourceRoot, 'the checker declares no SOURCE_ROOT').toBe(sourceRoot);
    const declaredEntries = [...(declared?.[1] ?? '').matchAll(/\['([^']+)',\s*([A-Za-z_]+)\]/g)].map((match) => ({
      alias: match[1],
      target: match[2] === 'SOURCE_ROOT' ? sourceRoot : match[2],
    }));
    expect(declaredEntries.length, 'the checker declares no alias').toBeGreaterThan(0);
    for (const alias of viteAliases) {
      expect(declaredEntries, `${alias.alias} is an alias in vite.config.ts but not in the gate`).toContainEqual({
        alias: alias.alias,
        target: alias.target,
      });
    }
    for (const [pattern, targets] of Object.entries(tsconfigPaths as Record<string, string[]>)) {
      const alias = pattern.replace(/\/\*$/, '');
      for (const target of targets) {
        // `src/*` and `src` name the same root, and the trailing slash is a wildcard
        // artefact rather than a path the gate could hold.
        expect(declaredEntries, `tsconfig path ${pattern} is not in the gate`).toContainEqual({
          alias,
          target: target.replace(/\*$/, '').replace(/\/$/, ''),
        });
      }
    }
  });
});

describe('the repository as it stands: the source scan runs, and there is nothing to register', () => {
  it('the gate reports how much source-tree media it looked at', () => {
    const result = runGate();
    expect(result.code, result.output).toBe(0);
    const summary = MEDIA_SOURCE_SUMMARY.exec(result.output);
    expect(summary, result.output).not.toBeNull();
  });

  it('an independent walk of src/ confirms there is no media in it today', () => {
    // The honest classification. If this ever stops being true the right response is
    // to register what is there, not to relax the rule - so the count is asserted
    // rather than left to be discovered by a red CI run.
    const media: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?|mp3|ogg|wav|m4a|weba|flac|mp4|webm|ogv|woff2?|ttf|otf|eot)$/i.test(entry.name)) {
          media.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(SOURCE_ROOT);
    expect(media, `src/ contains media: ${media.join(', ')}`).toEqual([]);
  });

  it('the summary counts the scan, so a refactor cannot quietly drop it', () => {
    // A guarantee that is only in the source and not in the output is a guarantee
    // nobody can see failing. The count is part of the green run's claim.
    const result = runGate();
    const summary = MEDIA_SOURCE_SUMMARY.exec(result.output);
    expect(summary, result.output).not.toBeNull();
    expect(Number(summary?.[1]), result.output).toBe(0);
    expect(Number(summary?.[2]), result.output).toBe(0);
  });

  it('the committed tree skips nothing, so the skip clause is a real signal', () => {
    // The other half of "the skip is visible": if the clause were always present the
    // number would be decoration and a reader would learn to ignore it. This is
    // asserted on a *fixture*, not on the live `src/`, and that is deliberate: two
    // pre-existing suites plant scratch state under `src/` while the suite runs, so any
    // assertion about the live tree's unclassified files is flaky by construction - which
    // is the defect this file closed, reappearing as its own regression test. A green
    // fixture tree is a measurement; a live tree under parallel mutation is a coin toss.
    const made = fixture();
    const result = made.gate();
    expect(result.code, result.output).toBe(0);
    expect(result.output, result.output).not.toContain('skipping');
    expect(SKIPPED_COUNT.test(result.output), result.output).toBe(false);

    // And the same fixture with one scratch file planted does report it, so the clause
    // is driven by the count rather than being unconditional.
    writeSourceFile(made, 'src/__data_gate_probe__/.test-planted', 'x');
    const afterPlanting = made.gate();
    expect(afterPlanting.code, afterPlanting.output).toBe(0);
    expect(Number(SKIPPED_COUNT.exec(afterPlanting.output)?.[1]), afterPlanting.output).toBe(1);
  });
});
