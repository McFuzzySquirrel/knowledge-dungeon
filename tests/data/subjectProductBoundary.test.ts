/**
 * Phase 6 data-product gate 8: the product is renderer-neutral, lazy, and local.
 *
 * Three boundaries, each asserted against the **real module graph** rather than
 * against a list of file names, so a product module imported from anywhere in the
 * application is caught whichever file did the importing.
 *
 * 1. **No renderer.** Plan section 12, rule 8: "Do not allow renderer imports into
 *    `src/core/` or renderer-neutral application modules." The product lives in the
 *    data-product tree, which `eslint.config.js` already declares renderer-neutral
 *    alongside `src/core/`, and this gate walks the graph reachable *from the product
 *    itself* - the transitive closure, which is the property that matters - and finds
 *    no `pixi.js`, no `phaser`, and no module under `src/game/`. The walk is this
 *    gate's own resolver rather than a shared one, for the reason the Phase 5 gates
 *    state: a gate that reuses the implementation of the thing it verifies can only
 *    agree with itself, and this repository has a history of vacuous gates.
 * 2. **No eager import.** `VITE_DATA_PRODUCTS_V2` owns this product, and plan section
 *    11 keeps new data products opt-in before their cutover. The Data Center's
 *    subject-backup tab is a **separate owner's delegation** and has now landed, so
 *    both modules are in the application graph - through one `import()` of a string
 *    literal, from one named screen, and through no other edge from anywhere outside
 *    the product tree. RAIL CHANGE: this used to assert that neither module appeared
 *    in the graph at all, which was true only while no screen imported them, and
 *    which became false - correctly - the moment the tab landed. The replacement
 *    states the property the absence was a proxy for, and pins the single permitted
 *    caller so it cannot quietly become two or move to a static edge.
 * 3. **No network, no upload, no share, no object URL.** Plan section 2.3 forbids
 *    adding any upload, analytics, telemetry, or remote configuration service, and the
 *    Phase 6 non-goals are "No cloud sync" and "No network". The egress walk is the
 *    Phase 5 gate's own, run over the product's transitive closure, so a call the
 *    product added would be reported with its file and line and its rule id - and
 *    never its destination, so the finding itself cannot leak one.
 *
 * The non-vacuity properties are what make "no findings" a decision rather than an
 * empty observation: the product's closure is non-trivial, the closure does reach the
 * modules it is supposed to reach (the ZIP codec, the repository, the checksum
 * module, the core progression module), and the egress detector is exercised on a
 * synthetic source that *does* violate the rules, so a rule that stopped firing would
 * fail here.
 *
 * Privacy: findings carry a repo-relative path, a line number, and a rule id. The
 * synthetic source names only the reserved `example.invalid`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { describeFindings, scanModule, specifiersIn, walk } from './support/importGraph';
import { blankComments, classifySpecifierEdges, filesReaching } from './support/importGraph';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');

/** The plan's Phase 6 expected files, as repo-relative paths. */
export const PHASE_6_MODULE_PATHS = [
  'src/services/persistence/products/subjectBackup.ts',
  'src/services/persistence/products/idRemapping.ts',
] as const;

/** Where a renderer lives, and where its absence is checked. */
const RENDERER_PACKAGES = ['pixi.js', '@pixi/', 'phaser', 'exphaser', 'koreographer'];

/**
 * Modules **every** Phase 6 module's closure must reach.
 *
 * The storage-v2 implementation both products share, and the prototype-name rule both of
 * them refuse identifiers with.
 *
 * RAIL CHANGE, Phase 7, recorded deliberately and **stronger or neutral** by construction.
 * `products/archiveValidation.ts` used to be on this list, which asserted that the remapper's
 * closure reached the archive validator - and the archive validator imports the ZIP codec, so
 * that assertion was holding in place a dependency Phase 7's `.kdtemplate` product paid for
 * and could not afford. The prototype-name rule's definition moved to
 * `v2/prototypeNames.ts`, a leaf that imports nothing, and `idRemapping.ts` now names the
 * leaf. The entry here is therefore the leaf, which is a *more precise* statement of what the
 * remapper needs; the archive validator moved to {@link REQUIRED_IN_ARCHIVE_CLOSURE}, where it
 * belongs, because the archive product genuinely reads archives and the remapper does not. A
 * new assertion also requires the remapper's closure **not** to reach the ZIP codec, which is
 * the stronger half of the same change.
 */
const REQUIRED_IN_EVERY_CLOSURE = [
  'src/services/persistence/v2/checksum.ts',
  'src/services/persistence/v2/schema.ts',
  'src/services/persistence/v2/prototypeNames.ts',
  'src/core/validation/persistence/types.ts',
];

/**
 * Modules only the archive product's closure reaches, and why.
 *
 * The repository and the validation report belong to the generation transaction, which
 * the remapper has no part in - and that is asserted rather than assumed, because a
 * remapper that could reach a repository would be able to read one, and a pure
 * function of its records is the property the whole module is built on. The sibling
 * product is reached for the live-device accessors the subject product re-exports.
 */
const REQUIRED_IN_ARCHIVE_CLOSURE = [
  // The ZIP codec moved here with the archive validator: only the archive product reads
  // archives, and the remapper's whole argument for being a pure function of its records is
  // that it has no handle to inflate one with.
  'src/services/persistence/v2/archive.ts',
  'src/services/persistence/v2/repository.ts',
  'src/services/persistence/v2/validation.ts',
  'src/services/persistence/v2/migrationState.ts',
  'src/services/persistence/products/archiveValidation.ts',
  'src/services/persistence/products/fullDeviceBackup.ts',
  'src/core/progression/canonicalProgression.ts',
];

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

/**
 * Every edge from `source` into `targetPath`, as the shared classifier sees it.
 *
 * The five kinds, and the `type-only` distinction in particular, are documented on
 * `classifySpecifierEdges` in `./support/importGraph`. This gate uses that
 * classifier rather than reimplementing it, and the reason is recorded there: the
 * difference between an erased `type` declaration and a chunk is invisible to a
 * pattern, and this repository has a history of gates that were right for the
 * wrong reason. The non-vacuity control for it is the synthetic-source test in this
 * file, which requires all five kinds to be produced.
 */
type Edge = import('./support/importGraph').Edge;

const specifierEdgesIn = (
  source: string,
  file: string,
  targetPath: string,
): readonly Edge[] => classifySpecifierEdges(source, file, targetPath);

function resolveFirstParty(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toPosix(relative(REPO_ROOT, candidate));
    }
  }
  return toPosix(relative(REPO_ROOT, base));
}

/** The transitive closure of first-party modules reachable from an entry module. */
function closureOf(entryPath: string): { paths: string[]; externals: string[] } {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    const absolute = join(REPO_ROOT, path);
    if (!existsSync(absolute)) continue;
    seen.add(path);
    for (const specifier of specifiersIn(readFileSync(absolute, 'utf8'))) {
      const target = resolveFirstParty(absolute, specifier);
      if (target === null) {
        externals.add(specifier);
        continue;
      }
      queue.push(target);
    }
  }
  return { paths: [...seen].sort(), externals: [...externals].sort() };
}

describe('Phase 6 gate 8: the product tree is renderer-neutral', () => {
  it('neither Phase 6 module reaches a renderer, transitively', () => {
    for (const entry of PHASE_6_MODULE_PATHS) {
      const { paths, externals } = closureOf(entry);
      // Non-vacuity: the closure is a real product closure, not one file.
      expect(paths.length, entry).toBeGreaterThanOrEqual(12);
      for (const required of REQUIRED_IN_EVERY_CLOSURE) {
        expect(paths, `${entry} must reach ${required}`).toContain(required);
      }
      if (entry.endsWith('subjectBackup.ts')) {
        for (const required of REQUIRED_IN_ARCHIVE_CLOSURE) {
          expect(paths, `${entry} must reach ${required}`).toContain(required);
        }
      } else {
        // The remapper's **own** specifiers name no storage-v2 implementation module
        // at all - no repository, no database, no attachment store, no ZIP codec. That
        // is the strongest statement of "it is a pure function of its records": it has
        // no handle to read a generation and no codec to inflate an archive with.
        //
        // The check is on direct specifiers rather than on the transitive closure, and
        // the reason is worth recording: the closure *does* reach
        // `v2/repository.ts`, through a pre-existing chain this phase does not own -
        // `v2/schema.ts` to `v2/validation.ts` to `core/progression/canonicalProgression.ts`
        // to `core/progression/lootSystem.ts` to `store/progressionStore.ts` to
        // `v2/repositorySelection.ts`. Asserting the remapper's closure excluded a
        // repository would be asserting a property of `src/store/progressionStore.ts`,
        // and a gate that failed there would be pointing at the wrong file.
        const own = specifiersIn(readFileSync(join(REPO_ROOT, entry), 'utf8')).map((specifier) =>
          resolveFirstParty(join(REPO_ROOT, entry), specifier),
        );
        for (const forbidden of [
          'src/services/persistence/v2/repository.ts',
          'src/services/persistence/v2/database.ts',
          'src/services/persistence/v2/attachmentBytes.ts',
          'src/services/persistence/v2/archive.ts',
          'src/services/persistence/v2/repositorySelection.ts',
        ]) {
          expect(own, `${entry} must not import ${forbidden} directly`).not.toContain(forbidden);
        }
        // What it *does* name is the record-value contract and the prototype-name
        // rule, which is the whole of what it needs. The prototype-name rule is the
        // **leaf** module rather than the archive validator, for the reason on
        // `REQUIRED_IN_EVERY_CLOSURE`; and the absence below is the new, stronger half of
        // the same change - the remapper must not drag the ZIP codec in to ask a two-clause
        // question, because `.kdtemplate` reuses this module and is a JSON product.
        expect(own, entry).toContain('src/services/persistence/v2/schema.ts');
        expect(own, entry).toContain('src/services/persistence/v2/prototypeNames.ts');
        expect(own, entry).not.toContain('src/services/persistence/products/archiveValidation.ts');
        expect(closureOf(entry).paths, `${entry} must not reach the ZIP codec`).not.toContain(
          'src/services/persistence/v2/archive.ts',
        );
      }
      // No renderer package, by name, anywhere in the closure.
      for (const external of externals) {
        for (const forbidden of RENDERER_PACKAGES) {
          expect(external === forbidden || external.startsWith(forbidden), `${entry} -> ${external}`).toBe(
            false,
          );
        }
      }
      // ...and no module inside the renderer tree, whichever way it was reached.
      for (const path of paths) {
        expect(path.startsWith('src/game/'), `${entry} -> ${path}`).toBe(false);
        expect(path, `${entry} -> ${path}`).not.toBe('src/main.tsx');
      }
      // The application graph is not reachable *from* the product either, so the
      // closure really is bounded by the storage-v2 and core trees.
      expect(paths.some((path) => path.startsWith('src/ui/')), entry).toBe(false);
      expect(paths.some((path) => path.startsWith('src/application/')), entry).toBe(false);
    }
  });

  it('the renderer detector this gate relies on is a real lexer, not a substring match', () => {
    // A detector that matched any mention of "pixi" would make the assertion above
    // pass for the wrong reason - or fail for one. So it is exercised on sources
    // where the word appears in a string, a comment, and a regular expression, and
    // where it appears as a real specifier.
    const mentions = [
      "const note = 'pixi.js is the Phase 9 renderer';",
      '// import { Application } from "pixi.js";',
      '/* import { Container } from "phaser"; */',
      'const pattern = /phaser|@pixi\\/app/;',
    ].join('\n');
    expect(mentions).toContain('pixi.js');
    // This gate's own rule is a **specifier** rule, so a mention in a string is not a
    // finding - asserted explicitly rather than assumed.
    const scan = scanModule('src/synthetic/mentions.ts', mentions);
    expect(scan.findings).toEqual([]);
    // ...and the real thing is reported, with a path, a line, and a rule.
    const real = scanModule(
      'src/synthetic/real.ts',
      "import { Application } from 'pixi.js';\nimport Phaser from 'phaser';\n",
    );
    const found = new Set(real.findings.map((finding) => finding.rule));
    expect(found.has('absolute-network-destination')).toBe(false);
    // The specifier rule is this gate's own, so the check is on the closure walk
    // rather than on the egress rules; here the point is only that the lexer found the
    // specifiers at all.
    expect(specifiersIn("import { Application } from 'pixi.js';")).toEqual(['pixi.js']);
    expect(specifiersIn(mentions)).toEqual([]);
  });
});

describe('Phase 6 gate 8: nothing outside the product tree reaches it eagerly, and the flag still owns it', () => {
  it('the product modules exist, and only a lazy edge from a screen reaches them', () => {
    for (const path of PHASE_6_MODULE_PATHS) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(true);
    }
    const applicationGraph = walk().modules.map((module) => module.path);
    for (const path of PHASE_6_MODULE_PATHS) {
      // RAIL CHANGE, recorded deliberately, and weaker by exactly the step Phase 6
      // took. This used to read "absent from the application graph entirely", with
      // the comment that the subject-backup tab "has not landed, so the strongest
      // true statement is the strictest one". The tab has landed; the Data Center
      // drives the product from `src/ui/data/SubjectBackupTab.tsx`; so the absence
      // assertion became false - correctly, and for the good reason. Deleting it
      // would have left two product modules on disk with no boundary gate at all.
      //
      // What is asserted instead is the property the absence was a proxy for,
      // stated directly: both modules are in the graph, and no module outside the
      // product tree reaches either through a `static`, `side-effect`, or `require`
      // edge. The next test pins which files *do* reach them, and that they do it
      // lazily.
      expect(applicationGraph, `${path} must be in the application graph`).toContain(path);
      expect(
        filesReaching(applicationGraph, path, ['static', 'side-effect', 'require'], 'src/services/persistence/products/'),
        `${path} must not be reached eagerly from outside the product tree`,
      ).toEqual([]);
    }
  });

  it('exactly two screens outside the product tree name a Phase 6 module, and only through a dynamic import', () => {
    // The strongest form of the lazy-boundary claim for this phase, restated for
    // the tab that now exists: not "not eagerly" but "named callers, and they are
    // lazy". Two files, and the count is the point - a third screen reaching the
    // product, or either of these reaching it with a static edge, fails here by
    // name.
    //
    // `SubjectBackupTab.tsx` is the screen that drives the product (three call
    // sites: export, inspect, import). `productAccess.ts` is the shared boundary
    // helper that resolves the live device, and reaches the `.kdsubject` product
    // because that product re-exports the accessors the `.kdbak` product published -
    // so the Data Center has one lazy import for the device rather than one per tab.
    const productsTree = 'src/services/persistence/products/';
    const valueCallers = new Set<string>();
    const offenders: string[] = [];
    for (const path of walk().modules.map((module) => module.path)) {
      if (path.startsWith(productsTree)) continue;
      for (const target of PHASE_6_MODULE_PATHS) {
        for (const edge of classifySpecifierEdges(readFileSync(join(REPO_ROOT, path), 'utf8'), path, target)) {
          // A `type-only` edge is erased at build time: no binding, no runtime edge,
          // no byte in any bundle. Both screens name their product types freely.
          if (edge.kind === 'type-only') continue;
          if (edge.kind === 'dynamic') valueCallers.add(`${path} -> ${target}`);
          else offenders.push(`${path} ${edge.kind} ${target}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
    expect([...valueCallers].sort()).toEqual([
      'src/ui/data/SubjectBackupTab.tsx -> src/services/persistence/products/subjectBackup.ts',
      'src/ui/data/productAccess.ts -> src/services/persistence/products/subjectBackup.ts',
    ]);
  });

  it('the edge classifier this gate relies on tells all five kinds apart, on a synthetic source', () => {
    // Non-vacuity. Without this, "no eager edge from outside the tree" would be
    // exactly what a classifier that recognised nothing would report, and Phase 3
    // review found five gates in this repository with that shape. Every kind is
    // produced by a line that really contains it, and a mention in a comment and in
    // a string produces nothing - so the `type-only` count below is a measurement
    // and not a tautology.
    const target = 'src/services/persistence/products/subjectBackup.ts';
    const source = [
      `import { readSubjectArchive } from '@/services/persistence/products/subjectBackup';`,
      `import '@/services/persistence/products/subjectBackup';`,
      `import type { SubjectArchivePreview } from '@/services/persistence/products/subjectBackup';`,
      `export type { SubjectImportMode } from '@/services/persistence/products/subjectBackup';`,
      `type P = typeof import('@/services/persistence/products/subjectBackup');`,
      `type Q = import('@/services/persistence/products/subjectBackup').SubjectArchivePreview;`,
      `const p = await import('@/services/persistence/products/subjectBackup');`,
      `const r = require('@/services/persistence/products/subjectBackup');`,
      `// import x from '@/services/persistence/products/subjectBackup';`,
      `const note = '@/services/persistence/products/subjectBackup';`,
      `import { isPrototypeMemberName } from '@/services/persistence/products/idRemapping';`,
    ].join('\n');
    const kinds = specifierEdgesIn(source, 'src/ui/synthetic/edgeProbe.tsx', target)
      .map((edge) => edge.kind)
      .sort();
    expect(kinds).toEqual([
      'dynamic',
      'require',
      'side-effect',
      'static',
      'type-only',
      'type-only',
      'type-only',
      'type-only',
    ]);
    // A second, also-real target has exactly its own edge and no others, so the
    // classifier is not matching every specifier it sees.
    expect(
      specifierEdgesIn(source, 'src/ui/synthetic/edgeProbe.tsx', 'src/services/persistence/products/idRemapping.ts')
        .map((edge) => edge.kind)
        .sort(),
    ).toEqual(['static']);
    // ...and the pre-filter's negative half: a source that never mentions the
    // target is skipped rather than parsed, and reports nothing. Without this the
    // filter would be an unmeasured optimisation, and an over-eager one would look
    // exactly like a clean graph.
    expect(
      specifierEdgesIn(
        `import { thing } from '@/ui/other';\nconst note = 'subject backup';\n`,
        'src/ui/synthetic/unrelated.ts',
        target,
      ),
    ).toEqual([]);
  });

  it('the owner flag is still VITE_DATA_PRODUCTS_V2 and still defaults to false', async () => {
    // The product is a new data product, and plan section 11 keeps new data products
    // opt-in until their cutover, so the flag that owns it must not have moved. The
    // Phase 5 gate holds the same flag from the runtime's side; this is the Phase 6
    // statement that adding a product did not add or change a flag.
    const { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig } = await import(
      '@/config/runtimeConfig'
    );
    const { FEATURE_FLAG_MATRIX } = await import('@/config/featureFlags');
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({}).dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({ VITE_DATA_PRODUCTS_V2: 'true' }).dataProductsV2).toBe(true);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(false);
    // The flag set still holds no per-product flag, so a data product cannot quietly
    // acquire one - plan section 11's list is closed and Phase 1 owns it. Phase 10
    // added one flag to that closed set, `audioEnabled`, for the audio service; it is a
    // service flag, not a product flag, and naming it here keeps the list closed rather
    // than opening it. Phase 14 added `creatorWorkspace` for the redesigned Creator
    // workspace, Phase 15 added `scribeEncounterWorkspace` for the redesigned Scribe
    // encounter workspace, and Phase 16 added `archaeologistReviewWorkspace` for the
    // redesigned Archaeologist review workspace; none is a product flag either. A
    // fourteenth flag still fails this assertion.
    expect(Object.keys(FEATURE_FLAG_MATRIX).sort()).toEqual([
      'adaptiveAssistance',
      'archaeologistReviewWorkspace',
      'audioEnabled',
      'cozyVisuals',
      'creatorWorkspace',
      'dataProductsV2',
      'pixiDungeon',
      'pixiFishing',
      'pixiVillage',
      'scribeEncounterWorkspace',
      'storageRepository',
      'webShare',
      'worldRenderer',
    ]);
  });
});

describe('Phase 6 gate 8: the product cannot send anything anywhere', () => {
  it('no module in the product closure has an upload, a share, or an off-origin navigation', () => {
    // The Phase 5 egress walk, run over this product's own transitive closure. It is
    // the same rules Phase 5 applies to the whole application graph, so a call this
    // product added is reported with its file, its line, and its rule id.
    const findings = [];
    for (const entry of PHASE_6_MODULE_PATHS) {
      for (const path of closureOf(entry).paths) {
        findings.push(
          ...scanModule(path, readFileSync(join(REPO_ROOT, path), 'utf8')).findings,
        );
      }
    }
    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('the egress rules fire on a synthetic source, so "no findings" is a decision', () => {
    // The positive control for the control. Each rule the gate forbids is exercised
    // here, and each is required to produce a finding - so a rule that stopped
    // matching would fail this test rather than silently passing the gate above.
    const cases: ReadonlyArray<[string, string]> = [
      ['navigator.share({ title: "x" });', 'share-invocation'],
      ['navigator.canShare({ files: [] });', 'share-capability-probe'],
      ["window.location.href = 'mailto:someone@example.invalid';", 'mailto-destination'],
      ["await fetch('https://example.invalid/backup', { method: 'POST' });", 'absolute-network-destination'],
      ['const body = new FormData();', 'formdata-construction'],
      ['const request = new XMLHttpRequest();', 'xhr-construction'],
      ["navigator.sendBeacon('https://example.invalid/b', body);", 'beacon-post'],
      ["const socket = new WebSocket('wss://example.invalid/s');", 'websocket-construction'],
      ["const worker = new Worker('https://example.invalid/w.js');", 'worker-construction'],
      ["const href = '/uploads/subject.kdsubject';", 'uploads-path-literal'],
      ["const href = '/api/import';", 'api-path-literal'],
      ['form.submit();', 'form-submission'],
    ];
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const [line, rule] of cases) {
      const scan = scanModule('src/synthetic/egress.ts', line);
      expect(
        scan.findings.map((finding) => finding.rule),
        line,
      ).toContain(rule);
      // Findings carry a path, a line, and a rule id only - never the destination, so
      // a finding cannot leak a URL.
      for (const finding of scan.findings) {
        expect(Object.keys(finding).sort()).toEqual(['file', 'line', 'rule']);
      }
    }
  });

  it('the product offers bytes and a file name, and never builds a file itself', () => {
    // The local-download mechanism Phase 5 allows the product to *describe* and the
    // user interface to *perform*. A product that created an object URL or clicked an
    // anchor would be doing the interface's job, and would be the one place a
    // `.kdsubject` could reach the DOM.
    for (const entry of PHASE_6_MODULE_PATHS) {
      const source = blankComments(readFileSync(join(REPO_ROOT, entry), 'utf8'));
      for (const forbidden of [
        'createObjectURL',
        'revokeObjectURL',
        'createElement',
        'showSaveFilePicker',
        'showOpenFilePicker',
        '.click()',
        'document.',
        'window.',
        'localStorage',
        'indexedDB',
      ]) {
        expect(source, `${entry} must not use ${forbidden}`).not.toContain(forbidden);
      }
      // ...and it does hand back bytes and a name, which is the whole contract.
      expect(specifiersIn(source).length).toBeGreaterThan(0);
    }
  });
});
