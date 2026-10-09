#!/usr/bin/env node
/**
 * The renderer memory preflight, and an honest statement of what it cannot measure.
 *
 * ## The requirement this exists for
 *
 * Plan section 10.2 names two properties together:
 *
 *   - "No material canvas or GPU memory growth over 20 world mount and unmount cycles."
 *   - "Correct Pixi Application and asset-bundle teardown."
 *
 * ## What this script CAN prove, deterministically, with no browser
 *
 * Run against a built `dist`, with Node built-ins only:
 *
 * 1. **The artifact exists and is coherent.** A missing `dist/index.html`, or an
 *    entry document that names a file the build did not produce, is a failure. This
 *    is the house precedent from `scripts/check-welcome-budget.mjs`: a gate that
 *    reports success because it measured nothing is the exact failure mode a gate
 *    exists to prevent, and `scripts/check-bundle-size.mjs` warns and exits 0 when
 *    `dist` is absent, which is fine for a pre-build check and not fine here.
 * 2. **The renderer chunk census.** Every renderer chunk family in the artifact is
 *    listed with its raw and gzip size, and split by whether the entry document
 *    names it. The split is the memory-relevant fact: a renderer chunk the entry
 *    document names in a `<script type="module">` or a `<link rel=modulepreload>`
 *    is downloaded before any application code runs, and the Welcome route holds
 *    those bytes for as long as the tab is open.
 * 3. **No renderer chunk is named by the entry document as a Pixi chunk** (finding
 *    `eager-pixi`). This is plan section 10.2's "no eager Phaser or Pixi load on
 *    Welcome" expressed as an artifact property rather than as an observation, and
 *    it is what stops a statically imported Pixi host from shipping.
 * 4. **Every renderer chunk is within plan section 10.2's "any lazy JavaScript
 *    chunk: no more than 800 KB gzip" ceiling** (finding `oversized-renderer`).
 *    That is the one plan number about lazy renderer code that nothing else in the
 *    repository enforces: `scripts/check-bundle-size.mjs` allows 2.5 MB *raw* per
 *    chunk, which is roughly 800 KB *uncompressed*, so a renderer bundle can
 *    currently reach twice the plan's gzip budget without any gate noticing. A
 *    lazy renderer chunk is the largest thing a learner device downloads to enter a
 *    world, so its compressed size is the memory figure the plan states.
 * 5. **The run was not vacuous** (finding `no-renderer-chunk`). An artifact with no
 *    renderer chunk family at all has nothing to measure, and that is reported as a
 *    failure with its cause rather than passed over.
 *
 * ## Absence is not a measurement, and the report says so per family
 *
 * Point 3 and point 5 are different claims, and a report that merged them would
 * make the weaker one look like the stronger. On a `VITE_WORLD_RENDERER=phaser`
 * build there is no `vendor-pixi-*` chunk at all, so "no eager Pixi chunk" is
 * satisfied by the absence of the thing rather than by looking at it - the same
 * class of defect as a gate that passes because it measured nothing, one level
 * down. The union-of-families `no-renderer-chunk` guard cannot see that, because
 * the build measured Phaser and was therefore non-vacuous.
 *
 * So the non-vacuity guard is per family, and every declared family is reported
 * in the output whether or not this artifact contains it. An **absent** family is a
 * reported fact and deliberately not a finding:
 *
 * - It is not a finding because the Phase 23 rollback build is the Phaser build (every
 *   per-world flag off), so `vendor-pixi` absence there is the correct and expected
 *   state. A finding would mean that rollback build could never pass its own gate, which
 *   is a gate that has stopped gating.
 * - It is not silently "clean" either. It prints as `not present in this build`,
 *   with the reason it is nonetheless correct, and the run's closing sentence
 *   enumerates the families that were measured instead of asserting a property of
 *   a family it never looked at. Reading a rollback-build report, a reader sees
 *   that the Pixi half of "no eager Phaser or Pixi load on Welcome" was *not
 *   measured* there, and that the measurement lives on the cutover production build
 *   (which routes the worlds to PixiJS through the per-world flags) and the
 *   `VITE_WORLD_RENDERER=pixi` build, both of which CI runs.
 *
 * A family that *is* present is still held to the full rule: every chunk within
 * the ceiling, and the Pixi family specifically not named by the entry document.
 * A chunk whose family is not declared in `RENDERER_CHUNK_FAMILIES` is a finding
 * (`unknown-renderer-family`) rather than a crash: the census cannot report a
 * renderer it has no reason text for, and a gate that dies with a stack trace has
 * already lost the reader who needed the finding in sentence form.
 *
 * ## What this script CANNOT prove, and will not claim
 *
 * Canvas count, GPU texture memory, WebGL context loss, and GC behaviour across 20
 * mount/unmount cycles are runtime properties. They cannot be read out of a
 * directory of files, and this script does not pretend otherwise: it prints a
 * `NOT MEASURED HERE` block on every run, naming each unmeasured property with the
 * measurement that would establish it. Nothing in this file, and no line of its
 * output, should be quoted as evidence that mount/unmount cycles are leak-free.
 *
 * The browser-backed half belongs in a Playwright lane that mounts and unmounts the
 * world 20 times in a real engine and asserts that the canvas count in the document
 * returns to its baseline and that `performance.memory`/a renderer-side counter does
 * not trend upward. That lane needs a spec under `tests/e2e/` and a Playwright
 * config, neither of which this phase's dependency-and-build work owns; it is listed
 * here as the remaining gap rather than approximated by a string search in a bundle.
 *
 * A marker search over minified output was considered and rejected: `destroy`
 * appears fifteen times in the current `vendor-phaser` chunk and
 * `releaseGlobalResources` appears zero times, so a marker count distinguishes
 * nothing that the census and the plan ceilings do not already state more honestly.
 *
 * ## Determinism
 *
 * gzip level 9, paths sorted, no clock, no randomness, no dev server, no network.
 * Two runs over the same `dist` produce byte-identical output.
 *
 * ## Usage
 *
 *   node scripts/check-memory.mjs              # gate on ./dist
 *   node scripts/check-memory.mjs --dist=DIR   # gate on another build
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIST = path.join(REPO_ROOT, 'dist');

/**
 * Plan section 10.2: "Any lazy JavaScript chunk: no more than 800 KB gzip."
 *
 * KiB rather than kB, for the same reason `check-welcome-budget.mjs` enforces its
 * 300 KB as KiB: integer arithmetic with no rounding step between the printed
 * figure and the compared one.
 */
export const LAZY_CHUNK_GZIP_BYTES = 800 * 1024;

/** The same limit in the unit the report prints. */
export const LAZY_CHUNK_GZIP_KIB = LAZY_CHUNK_GZIP_BYTES / 1024;

/** Plan section 10.2's cycle count, printed so the browser lane's job is on the record. */
export const MOUNT_UNMOUNT_CYCLES = 20;

/** gzip level 9, stated rather than defaulted, so the number is reproducible by hand. */
export const GZIP_LEVEL = 9;

/**
 * Renderer chunk families, keyed by the `manualChunks` group prefix declared in
 * `vite.config.ts`.
 *
 * The prefix is the whole contract. These are matched as `name` or `name-<hash>`
 * so a family survives content hashing, and never as a content hash, which changes
 * on every build.
 */
export const RENDERER_CHUNK_FAMILIES = {
  'vendor-phaser': {
    renderer: 'Phaser',
    reason:
      'The Phaser fallback, statically imported by src/game/** and reached only when a per-world flag is off. Phase 24 deletes it, at which point this family stops matching anything.',
    absence:
      'Absent from the cutover production build and from a VITE_WORLD_RENDERER=pixi build, because both route the world screens to the per-world PixiJS worlds. It is present only in a rollback build (every per-world flag off). src/game/** stays in the module graph until Phase 24 deletes it.',
  },
  'vendor-pixi': {
    renderer: 'PixiJS',
    reason:
      'The Phase 9 renderer, and the one the cutover production build reaches through the per-world flags. Plan section 10.2 excludes lazy renderer bundles from the Welcome budget and forbids an eager Pixi load on Welcome.',
    absence:
      'Absent from a rollback build (every per-world flag off), where the world screens fall back to Phaser, so the "no eager Pixi load on Welcome" half is NOT measured on that artifact. It is measured on the cutover production build and on the VITE_WORLD_RENDERER=pixi build, which CI runs, where this family is present and lazy.',
  },
};

/** Every declared renderer family, in declaration order. */
export const RENDERER_FAMILY_NAMES = Object.keys(RENDERER_CHUNK_FAMILIES);

/** True for a family this script has a reason text for. */
export function isDeclaredRendererFamily(family) {
  return Object.prototype.hasOwnProperty.call(RENDERER_CHUNK_FAMILIES, family);
}

/** The three ways a document pulls JavaScript or CSS before any application code runs. */
export const INITIAL_REFERENCE_KINDS = ['js-module', 'js-modulepreload', 'css-stylesheet'];

/**
 * The properties this script deliberately does not measure, each paired with the
 * measurement that would establish it. Printed on every run.
 */
export const NOT_MEASURED = [
  {
    property: 'canvas count over 20 world mount/unmount cycles',
    needs: 'A Playwright lane that mounts and unmounts the world 20 times and counts `document.querySelectorAll("canvas")` against its own baseline.',
  },
  {
    property: 'GPU texture and buffer memory growth',
    needs: 'A browser lane reading a renderer-side counter (for example PixiJS texture GC counts) across the same 20 cycles.',
  },
  {
    property: 'JavaScript heap growth',
    needs: 'A browser lane sampling `performance.memory` (Chromium) or an equivalent per-engine measurement over the same cycles.',
  },
  {
    property: 'WebGL/WebGPU context loss and restoration',
    needs: 'A browser lane forcing context loss on the world canvas and asserting teardown does not leave an unreleased context.',
  },
];

/* -------------------------------------------------------------------------- */
/* HTML parsing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every `<script>` and `<link>` start tag, with its attributes lowercased.
 *
 * The attribute run is matched as a sequence of quoted strings or non-`>` characters
 * so a `>` inside a quoted value cannot end the tag early.
 */
export function parseDocumentTags(html) {
  const tags = [];
  for (const match of html.matchAll(/<(script|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const attributes = new Map();
    for (const attribute of match[2].matchAll(/([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    tags.push({ tag: match[1].toLowerCase(), attributes });
  }
  return tags;
}

/** True for a reference that points outside the shipped artifact. */
export function isRemoteReference(reference) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(reference) || /^data:/i.test(reference);
}

/**
 * Resolves a document reference to a dist-relative POSIX path, or `undefined` when
 * the reference leaves the artifact. A leading `/` names a path under the deployment
 * root, which is `dist`. A resolved path that escapes `dist` is rejected.
 */
export function resolveInitialPath(reference) {
  if (isRemoteReference(reference)) return undefined;
  const withoutQuery = reference.split(/[?#]/, 1)[0];
  const relative = withoutQuery.startsWith('/') ? withoutQuery.slice(1) : withoutQuery;
  if (relative === '') return undefined;
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

/**
 * The renderer family a dist-relative path belongs to, or `undefined`.
 *
 * Matched on the basename so `assets/vendor-pixi-abc.js` and `vendor-pixi.js` both
 * resolve, and so a content hash can never be mistaken for a family.
 */
export function rendererChunkFamily(distRelativePath) {
  const base = path.posix.basename(distRelativePath);
  for (const [family] of Object.entries(RENDERER_CHUNK_FAMILIES)) {
    if (base === family || base.startsWith(`${family}-`)) return family;
  }
  return undefined;
}

/**
 * The JavaScript and CSS files the entry document names before any application code
 * runs, and the ones it names only for the ES5 `nomodule` fallback.
 *
 * The two maps are separate rather than merged because they are different claims. The
 * `initial` map is what a browser in plan section 2.5's engine matrix downloads, and a
 * renderer chunk in it is a finding. The `nomodule` map is what a browser without
 * module support downloads; plan section 10.2's Welcome budget declines to count it
 * for the same reason, and so does this gate. Merging them would report an eager
 * renderer load in a browser the plan does not support as if it were one in the
 * browsers it does.
 *
 * Note that this classification is by document reference only. A file *name* appearing
 * inside another chunk's text is not a reference and is not treated as one: in a
 * correctly lazy Pixi build the entry chunk contains `vendor-pixi-<hash>.js` in Vite's
 * `__vite__mapDeps` preload array, which is a runtime string list, not a fetch the
 * document asks for.
 */
export function collectInitialAssets(html) {
  const initial = new Map();
  const nomodule = new Map();
  const skipped = [];

  function record(reference, kind, into, problems) {
    const resolved = resolveInitialPath(reference);
    if (resolved === undefined) {
      problems.push(`\`${reference}\` does not name a file inside the built artifact`);
      return;
    }
    const existing = into.get(resolved);
    if (existing) {
      // One file is one file however many kinds reference it.
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      return;
    }
    into.set(resolved, { path: resolved, kinds: [kind] });
  }

  const problems = [];

  for (const { tag, attributes } of parseDocumentTags(html)) {
    if (tag === 'script') {
      const src = attributes.get('src');
      const type = (attributes.get('type') ?? '').toLowerCase();
      if (attributes.has('nomodule')) {
        if (src) record(src, 'js-nomodule', nomodule, problems);
        else nomodule.set(`#${attributes.get('id') ?? '(inline)'}`, {
          path: `#${attributes.get('id') ?? '(inline)'}`,
          kinds: ['js-nomodule-inline'],
        });
        continue;
      }
      if (src === undefined) {
        skipped.push('js-inline: inline <script> with no src, counted as bytes of index.html itself');
        continue;
      }
      if (type !== 'module') {
        skipped.push(`js-nonmodule: script type "${type || 'classic'}" with a src`);
        continue;
      }
      record(src, 'js-module', initial, problems);
      continue;
    }

    const rel = (attributes.get('rel') ?? '').toLowerCase();
    const href = attributes.get('href');
    if (rel === 'modulepreload' && href !== undefined) {
      record(href, 'js-modulepreload', initial, problems);
      continue;
    }
    if (rel === 'stylesheet' && href !== undefined) {
      record(href, 'css-stylesheet', initial, problems);
    }
  }

  return { initial, nomodule, skipped, problems };
}

/* -------------------------------------------------------------------------- */
/* Measuring                                                                   */
/* -------------------------------------------------------------------------- */

/** gzips a buffer at the declared level. Exported so a test can measure without a disk. */
export function gzipSize(bytes) {
  return gzipSync(bytes, { level: GZIP_LEVEL }).length;
}

/**
 * Measures the renderer chunks an artifact contains.
 *
 * `readFile` is injected so the measurement is testable against a synthetic tree,
 * and the real walk over `dist` is only one caller of it.
 */
export async function measureRendererChunks(distDir, readFile) {
  const assetsDir = path.join(distDir, 'assets');
  let names;
  try {
    names = (await readdir(assetsDir)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return { chunks: [], assetsDirPresent: false };
    throw error;
  }

  const chunks = [];
  for (const name of names) {
    const family = rendererChunkFamily(name);
    if (family === undefined) continue;
    const relative = `assets/${name}`;
    let bytes;
    try {
      bytes = await readFile(path.join(distDir, ...relative.split('/')));
    } catch (error) {
      // A file listed by the directory walk cannot be missing, so this is reported
      // rather than thrown: a gate that dies with a stack trace has already lost the
      // reader who needed the finding in sentence form.
      chunks.push({ path: relative, family, error: error?.code ?? 'unknown error' });
      continue;
    }
    chunks.push({ path: relative, family, rawBytes: bytes.length, gzipBytes: gzipSize(bytes) });
  }
  return { chunks, assetsDirPresent: true };
}

/**
 * Decides pass or fail from a measurement.
 *
 * `entryPaths` is the set of dist-relative paths the entry document names before any
 * application code runs. A renderer chunk in that set is downloaded on Welcome.
 */
export function evaluateMemoryPreflight({ chunks, assetsDirPresent, entryPaths }) {
  const findings = [];

  if (!assetsDirPresent) {
    findings.push({
      code: 'no-assets-tree',
      message:
        'The built artifact has no `assets` directory, so there is no renderer chunk to measure. ' +
        'This gate fails rather than passing an unmeasured build.',
    });
  }

  if (chunks.some((chunk) => chunk.error !== undefined)) {
    findings.push({
      code: 'unreadable-renderer-chunk',
      message: chunks
        .filter((chunk) => chunk.error !== undefined)
        .map((chunk) => `${chunk.path}: ${chunk.error}`)
        .join('; '),
    });
  }

  const measured = chunks.filter((chunk) => chunk.error === undefined);
  const families = [...new Set(measured.map((chunk) => chunk.family))].sort();

  if (assetsDirPresent && measured.length === 0) {
    findings.push({
      code: 'no-renderer-chunk',
      message:
        'The built artifact contains no `vendor-phaser-*` or `vendor-pixi-*` chunk, so this gate ' +
        'measured nothing about renderer residency. Either the renderer was tree-shaken out of the ' +
        'build or `vite.config.ts` stopped claiming it into a `manualChunks` group; both are findings.',
    });
  }

  // A chunk whose family this script does not declare cannot be reported in sentence
  // form, and must not be read out of the registry. The CLI path cannot reach this
  // because `measureRendererChunks` filters unknown families out before it returns,
  // so this is a property of the exported function: a caller whose own type
  // declaration accepts any string must get a finding rather than a TypeError, which
  // is the same rule line 320 states for an unreadable chunk.
  const unknownFamilies = [...new Set(measured.map((chunk) => chunk.family))]
    .filter((family) => !isDeclaredRendererFamily(family))
    .sort();
  for (const family of unknownFamilies) {
    findings.push({
      code: 'unknown-renderer-family',
      message:
        `${family} is a renderer chunk family this gate does not declare, so it has no reason text ` +
        'and no plan ceiling to check it against. Add it to `RENDERER_CHUNK_FAMILIES` in ' +
        '`scripts/check-memory.mjs` (with the `manualChunks` prefix it matches) so the census can ' +
        'report it, or remove the group from `vite.config.ts`.',
    });
  }

  const eager = measured.filter((chunk) => entryPaths.has(chunk.path));
  for (const chunk of eager.filter((entry) => entry.family === 'vendor-pixi')) {
    findings.push({
      code: 'eager-pixi',
      message:
        `${chunk.path} is named by the entry document before any application code runs, so the Welcome ` +
        'route downloads the Pixi runtime. Plan section 10.2 forbids an eager Pixi load on Welcome. ' +
        'Reach the Pixi host through a dynamic import so the router, not the entry, decides when it loads.',
    });
  }

  for (const chunk of measured.filter((entry) => entry.gzipBytes > LAZY_CHUNK_GZIP_BYTES)) {
    findings.push({
      code: 'oversized-renderer',
      message:
        `${chunk.path} is ${kib(chunk.gzipBytes)} gzip, over plan section 10.2's ${LAZY_CHUNK_GZIP_KIB} KiB ` +
        'ceiling for any lazy JavaScript chunk.',
    });
  }

  const byFamily = {};
  for (const family of families) {
    const declared = RENDERER_CHUNK_FAMILIES[family];
    const familyChunks = measured.filter((chunk) => chunk.family === family).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    byFamily[family] = {
      family,
      // `declared?.renderer` rather than `declared.renderer`: an undeclared family
      // reaches here (and is already a finding above), and a second crash on the
      // reporting path would replace a sentence with a stack trace.
      renderer: declared?.renderer ?? family,
      present: true,
      chunks: familyChunks,
      rawBytes: familyChunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0),
      gzipBytes: familyChunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
      eagerPaths: familyChunks.filter((chunk) => entryPaths.has(chunk.path)).map((chunk) => chunk.path),
    };
  }

  /**
   * Every declared family, with the ones this artifact does not contain marked
   * `present: false` and no measurement. A reported fact, not a finding - see the
   * header - and the reason it is still correct is carried on the family itself.
   */
  const familiesReport = RENDERER_FAMILY_NAMES.map(
    (family) =>
      byFamily[family] ?? {
        family,
        renderer: RENDERER_CHUNK_FAMILIES[family].renderer,
        present: false,
        chunks: [],
        rawBytes: 0,
        gzipBytes: 0,
        eagerPaths: [],
      },
  );
  // Undeclared families measured on this artifact are reported after the declared
  // ones, so a reader sees the known census first and the unrecognised one last.
  for (const family of unknownFamilies) {
    familiesReport.push(byFamily[family]);
  }
  const absentFamilies = familiesReport.filter((entry) => !entry.present).map((entry) => entry.renderer);
  const measuredFamilies = familiesReport.filter((entry) => entry.present).map((entry) => entry.renderer);

  return {
    findings,
    ok: findings.length === 0,
    byFamily,
    families,
    familiesReport,
    absentFamilies,
    measuredFamilies,
    measuredCount: measured.length,
  };
}

export function kib(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function readArg(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main() {
  const distDir = path.resolve(REPO_ROOT, readArg('dist') ?? path.relative(REPO_ROOT, DEFAULT_DIST));
  const indexPath = path.join(distDir, 'index.html');

  let html;
  try {
    html = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error(
        [
          `Renderer memory preflight: no built entry document at ${path.relative(REPO_ROOT, indexPath)}.`,
          'This gate fails rather than passing an unmeasured build, because a gate that reports',
          'success because it measured nothing is the failure this gate exists to prevent.',
          'Run: npm run build:web',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { initial, nomodule, problems } = collectInitialAssets(html);

  // Every referenced file must exist inside `dist`. A reference that resolves to
  // nothing means the graph this gate is about is not the graph that ships.
  const missing = [];
  const sizes = new Map();
  for (const asset of initial.values()) {
    if (rendererChunkFamily(asset.path) === undefined) continue;
    try {
      const bytes = await readFile(path.join(distDir, ...asset.path.split('/')));
      sizes.set(asset.path, bytes.length);
    } catch (error) {
      missing.push(`${asset.path}: ${error?.code ?? 'unknown error'}`);
    }
  }
  if (missing.length > 0) {
    console.error('Renderer memory preflight: the entry document names a renderer chunk the build does not contain:');
    for (const entry of missing) console.error(`  ${entry}`);
    process.exitCode = 1;
    return;
  }

  const { chunks, assetsDirPresent } = await measureRendererChunks(distDir, (absolute) =>
    readFile(absolute),
  );
  const entryPaths = new Set(initial.keys());
  const nomodulePaths = new Set(nomodule.keys());
  const result = evaluateMemoryPreflight({ chunks, assetsDirPresent, entryPaths });

  console.log(
    `Renderer memory preflight (plan section 10.2: no eager renderer load on Welcome; any lazy JavaScript chunk <= ${LAZY_CHUNK_GZIP_KIB} KiB gzip)`,
  );
  console.log(`  Measured from: ${path.relative(REPO_ROOT, indexPath)}`);
  console.log(`  gzip level: ${GZIP_LEVEL}`);
  console.log(`  Initial files named by the entry document: ${entryPaths.size}`);
  console.log('');

  if (result.measuredCount === 0) {
    console.log('Renderer chunks found: (none)');
  } else {
    console.log('Renderer chunks:');
    for (const entry of result.familiesReport) {
      const family = entry.family;
      const declared = isDeclaredRendererFamily(family) ? RENDERER_CHUNK_FAMILIES[family] : undefined;
      const unknown = declared === undefined;
      console.log(
        `  ${entry.family} (${entry.renderer}${unknown ? ', UNDECLARED FAMILY' : ''}) - ` +
          (entry.present ? 'measured' : 'NOT PRESENT in this build'),
      );
      if (!entry.present) {
        // Printed as a fact and not folded into a verdict, because the plan's
        // "no eager Phaser or Pixi load on Welcome" has two halves and this run
        // measured only the ones it printed. A reader who sees this line knows the
        // other half was not established here.
        console.log(`    No ${entry.renderer} chunk in this artifact, so nothing about it was measured.`);
        console.log(`    ${declared?.absence ?? 'This family is not declared in this script.'}`);
        console.log(`    ${declared?.reason ?? ''}`.trimEnd());
        continue;
      }
      const pathWidth = Math.max(...entry.chunks.map((chunk) => chunk.path.length));
      for (const chunk of entry.chunks) {
        const named = entryPaths.has(chunk.path)
          ? 'named by the entry document'
          : nomodulePaths.has(chunk.path)
            ? 'ES5 nomodule only'
            : 'lazy';
        console.log(
          `    ${chunk.path.padEnd(pathWidth)}  ${kib(chunk.rawBytes).padStart(11)} raw  ` +
            `${kib(chunk.gzipBytes).padStart(11)} gzip  ${named}`,
        );
      }
      console.log(
        `    ${'total'.padEnd(pathWidth)}  ${kib(entry.rawBytes).padStart(11)} raw  ` +
          `${kib(entry.gzipBytes).padStart(11)} gzip  limit ${kib(LAZY_CHUNK_GZIP_BYTES)} gzip`,
      );
      console.log(
        unknown
          ? `    This family is not declared in this script, so it has no reason text and no plan ceiling; see the finding above.`
          : `    ${declared.reason}`,
      );
      if (entry.eagerPaths.length > 0) {
        console.log(
          `    Downloaded before any application code runs: ${entry.eagerPaths.join(', ')}` +
            (family === 'vendor-phaser'
              ? ' (pre-existing: Phaser is statically imported by src/game/** today; Phase 24 removes it)'
              : ''),
        );
      }
    }
  }
  console.log('');
  if (result.absentFamilies.length > 0) {
    console.log(
      `Renderer families NOT measured on this artifact (absent from it, not clean): ${result.absentFamilies.join(', ')}`,
    );
    console.log(
      '  For each of these, "no eager load" is satisfied by the absence of the chunk rather than by',
    );
    console.log(
      '  measuring it. The measurement lives on a build that contains the family; see the line above.',
    );
    console.log('');
  }

  if (problems.length > 0) {
    console.error('Renderer memory preflight: the entry document names files outside the artifact:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log('NOT MEASURED HERE (this gate reads a build, not a browser):');
  for (const item of NOT_MEASURED) {
    console.log(`  - ${item.property}`);
    console.log(`      needs: ${item.needs}`);
  }
  console.log(
    `  Plan section 10.2's "${MOUNT_UNMOUNT_CYCLES} world mount and unmount cycles" is a runtime measurement and is not established by this run.`,
  );
  console.log('');

  if (!result.ok) {
    console.error('Renderer memory preflight FAILED:');
    for (const finding of result.findings) {
      console.error(`  [${finding.code}] ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const measuredNamed = result.measuredFamilies.length > 0 ? result.measuredFamilies.join(', ') : 'none';
  const unmeasured = result.absentFamilies.length > 0 ? result.absentFamilies.join(', ') : 'none';
  const eagerNamed = result.familiesReport
    .filter((entry) => entry.eagerPaths.length > 0)
    .map((entry) => entry.renderer);
  console.log(
    `Renderer memory preflight passed: ${result.measuredCount} renderer chunk(s) measured across ` +
      `${result.measuredFamilies.length} family/families (${measuredNamed}), all within the ` +
      `${LAZY_CHUNK_GZIP_KIB} KiB gzip ceiling; no eager Pixi chunk; eagerly loaded and reported: ` +
      `${eagerNamed.length > 0 ? eagerNamed.join(', ') : 'none'}.`,
  );
  // Named separately from the verdict, because "no eager Pixi chunk" for a build
  // with no Pixi chunk is a statement about the build, not a measurement of Pixi.
  console.log(`  Measured for eager load: ${measuredNamed}.`);
  console.log(
    `  NOT measured on this artifact (absent from it, so not clean either): ${unmeasured}.` +
      (result.absentFamilies.includes('PixiJS')
        ? ' Plan section 10.2\'s "no eager Pixi load on Welcome" is established on the ' +
          'VITE_WORLD_RENDERER=pixi build, not on this one.'
        : ''),
  );
  console.log('This is a build-level preflight. It is not a mount/unmount leak measurement.');
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) await main();
