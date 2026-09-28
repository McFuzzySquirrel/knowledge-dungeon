#!/usr/bin/env node
/**
 * The Welcome initial-payload budget gate.
 *
 * What this enforces
 * ------------------
 * Plan section 10.2 sets one number for the Welcome screen: initial JavaScript and CSS
 * no more than 300 KB gzip, "excluding lazy renderer bundles". Global working rule 7
 * makes the performance gates apply from the first affected phase, and Phase 8 changed
 * the Welcome CSS bundle, so the number had to start being measured here rather than
 * later. Until now it was measured by a throwaway script outside the repository, which
 * is indistinguishable from not measuring it: the next person to add a kilobyte had no
 * gate to trip.
 *
 * How "initial" is defined, and why it is defined at all
 * ------------------------------------------------------
 * The definition is deliberately mechanical so that two people on two machines get the
 * same number from the same `dist`:
 *
 * - It is computed from the **built** `dist/index.html` and from nothing else. No dev
 *   server, no Vite manifest, no source graph, no import walk. The entry document is
 *   the one artifact a browser is guaranteed to be handed, so "what does the entry
 *   document ask for" is the only question whose answer cannot drift from the build.
 * - An asset counts when `dist/index.html` names it in a `src`/`href` attribute on a
 *   `<script type="module">`, a `<link rel="modulepreload">`, or a
 *   `<link rel="stylesheet">`. Those are the only three ways a document pulls JS or CSS
 *   before the app has run any code.
 * - Each resolved file is counted **once**, however many times it is referenced. Vite
 *   emits an entry as both a module script and, for shared chunks, a modulepreload, and
 *   double counting that would inflate the total by the size of the entry itself.
 * - Every referenced file must exist inside `dist`. A reference that resolves to
 *   nothing is a hard failure, not a skipped line: a silently dropped reference is how
 *   a budget stops describing what ships.
 * - A reference to an absolute `http:`/`https:`/`//` URL is a hard failure. An initial
 *   asset that is not in the artifact we ship cannot be measured, and the redesigned
 *   web app is local-first with no remote configuration or third-party runtime.
 *
 * What is excluded, and why each exclusion is a rule rather than a name
 * ---------------------------------------------------------------------
 * Everything excluded is reported, with its own gzip size and the reason, and the
 * excluded total is printed alongside the measured total. A reader who disagrees with
 * a boundary can add the number back without re-running anything.
 *
 * - `vendor-phaser-*` - the lazy renderer bundle. This is the exclusion plan section
 *   10.2 names, and `vite.config.ts` puts it in its own `manualChunks` group. Phase 24
 *   deletes it, at which point this pattern stops matching anything.
 * - `polyfills-legacy-*` - the ES5 polyfill chunk for the `nomodule` path.
 * - Any `<script nomodule>` - the ES5 fallback build. The release path is web on
 *   Chromebook, desktop browsers, and tablets, all of which support ES modules, so the
 *   modern bundle is the measured one. This exclusion is not a rounding convenience:
 *   `index-legacy-*.js` is the *same application* re-emitted at ES5, so counting it
 *   alongside `index-*.js` would count the app twice and fail a build that has not
 *   grown by a byte. It is listed explicitly in the output for that reason.
 * - Inline `<script>` bodies with no `src` - these are bytes of `index.html` itself
 *   rather than a separate initial asset. They are counted in the output as a stated
 *   fact, so the omission is visible rather than assumed.
 *
 * Lazy route chunks, sprites, tilesets, and fonts are out of scope structurally, not by
 * pattern: they are not referenced from the entry document, so they are never
 * candidates. That is why a route-aware lazy split cannot inflate this number, and it
 * is also why a *new* eager import would show up here immediately.
 *
 * Why a missing `dist` is a failure here
 * -------------------------------------
 * `scripts/check-bundle-size.mjs` warns and exits 0 when `dist` is absent, which is
 * reasonable for a check a developer may run before building. It is not acceptable for
 * a gate: a budget that reports success because it measured nothing is the exact
 * failure mode this file exists to prevent. A missing `dist` fails with the command to
 * run. The unit tests never depend on the real `dist`, so this costs nothing on a clean
 * checkout.
 *
 * Usage:
 *   node scripts/check-welcome-budget.mjs              # gate on ./dist
 *   node scripts/check-welcome-budget.mjs --dist=DIR   # gate on another build
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIST = path.join(REPO_ROOT, 'dist');

/**
 * Plan section 10.2: 300 KB gzip for Welcome initial JavaScript and CSS.
 *
 * 300 KiB, not 300 kB. Recorded in bytes so the comparison the gate makes is integer
 * arithmetic with no rounding, and so the printed figure and the enforced figure cannot
 * disagree.
 */
export const WELCOME_BUDGET_BYTES = 300 * 1024;

/** The same limit in the unit the report prints, so the two cannot be read as different numbers. */
export const WELCOME_BUDGET_KIB = WELCOME_BUDGET_BYTES / 1024;

/**
 * Basename patterns for the content-hashed chunks that are the plan's "lazy renderer bundles".
 *
 * Keyed by a stable reason string, because the reason is what a reader of a red run
 * needs and a bare filename is not. Each pattern is matched against the basename.
 */
export const LAZY_RENDERER_CHUNKS = {
  'vendor-phaser': {
    pattern: /^vendor-phaser-/,
    reason:
      'Plan section 10.2 excludes lazy renderer bundles. vite.config.ts puts Phaser in its own manualChunks group, and Phase 24 deletes it.',
  },
  'polyfills-legacy': {
    pattern: /^polyfills-legacy-/,
    reason: 'The ES5 polyfill chunk for the nomodule path, not part of the module initial payload.',
  },
};

/** gzip level 9, stated rather than defaulted, so the number is reproducible by hand. */
export const GZIP_LEVEL = 9;

/** The three ways a document pulls JS or CSS before any application code has run. */
export const INITIAL_REFERENCE_KINDS = ['js-module', 'js-modulepreload', 'css-stylesheet'];

/* -------------------------------------------------------------------------- */
/* HTML parsing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every `<script>` and `<link>` start tag in the document, with its attributes.
 *
 * The attribute run is matched as a sequence of quoted strings or non-`>` characters so
 * that a `>` inside a quoted value cannot end the tag early. The result is order-stable
 * and depends only on the document text, which is what makes the report byte-identical
 * for a given `dist`.
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

/** The exclusion reason for a dist-relative asset path, or `undefined` to count it. */
export function lazyChunkReason(distRelativePath) {
  const base = path.posix.basename(distRelativePath);
  for (const [key, entry] of Object.entries(LAZY_RENDERER_CHUNKS)) {
    if (entry.pattern.test(base)) return { key, reason: entry.reason };
  }
  return undefined;
}

/** True for a reference that points outside the shipped artifact. */
export function isRemoteReference(reference) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(reference) || /^data:/i.test(reference);
}

/**
 * Resolves a document reference to a dist-relative POSIX path, or `undefined` when the
 * reference leaves the artifact.
 *
 * A leading `/` is stripped rather than treated as filesystem-absolute: for a built
 * site, a root-absolute URL names a path under the deployment root, which is `dist`.
 * A resolved path that escapes `dist` is rejected, so a crafted `../..` cannot pull an
 * arbitrary file into the total.
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
 * Classifies the entry document into what it loads initially, what it excludes and why,
 * and what it leaves out entirely.
 *
 * The three lists are exhaustive by construction: every `<script>` and `<link>` tag lands
 * in exactly one of them, so a tag cannot be dropped without being reported.
 */
export function collectInitialAssets(html) {
  const counted = new Map();
  const excluded = [];
  const skipped = [];

  for (const { tag, attributes } of parseDocumentTags(html)) {
    if (tag === 'script') {
      const type = (attributes.get('type') ?? '').toLowerCase();
      const src = attributes.get('src');
      const isLegacy = attributes.has('nomodule');

      if (isLegacy) {
        // Reported whether or not it has a src, so the ES5 fallback is never invisible.
        const id = attributes.get('id');
        excluded.push({
          path: src ? resolveInitialPath(src) ?? src : id ? `#${id}` : '(inline)',
          kind: 'js-legacy-nomodule',
          reason:
            'ES5 fallback for browsers without module support. The same application as the module entry, so counting both would count the app twice; the module path is the release path.',
        });
        continue;
      }
      if (src === undefined) {
        skipped.push({
          kind: 'js-inline',
          note: 'inline <script> with no src: bytes of index.html itself, not a separate initial asset',
        });
        continue;
      }
      if (type !== 'module') {
        skipped.push({ kind: 'js-nonmodule', note: `script type "${type || 'classic'}" with a src` });
        continue;
      }
      addReference(counted, src, 'js-module');
      continue;
    }

    const rel = (attributes.get('rel') ?? '').toLowerCase();
    const href = attributes.get('href');
    if (rel === 'modulepreload' && href !== undefined) {
      addReference(counted, href, 'js-modulepreload');
      continue;
    }
    if (rel === 'stylesheet' && href !== undefined) {
      addReference(counted, href, 'css-stylesheet');
      continue;
    }
    if (href !== undefined && rel !== '') {
      skipped.push({ kind: `link-${rel}`, note: 'not JavaScript or CSS' });
    }
  }

  return { counted: [...counted.values()].sort(byPath), excluded, skipped };
}

/** Records one reference, or records why it could not be counted. */
function addReference(counted, reference, kind) {
  if (!INITIAL_REFERENCE_KINDS.includes(kind)) {
    throw new Error(`\`${kind}\` is not one of the initial reference kinds.`);
  }
  const resolved = resolveInitialPath(reference);
  if (resolved === undefined) {
    counted.set(`\u0000remote:${reference}`, {
      path: null,
      reference,
      kinds: [kind],
      problem: `\`${reference}\` does not name a file inside the built artifact`,
    });
    return;
  }
  const existing = counted.get(resolved);
  if (existing) {
    // A file referenced by more than one kind is still one file. Vite emits the entry
    // as a module script and its shared chunks as modulepreloads, and an entry that is
    // also preloaded must not be paid for twice.
    if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
    return;
  }
  const lazy = lazyChunkReason(resolved);
  if (lazy) {
    counted.set(resolved, { path: resolved, kinds: [kind], excludedBy: lazy });
    return;
  }
  counted.set(resolved, { path: resolved, kinds: [kind] });
}

function byPath(a, b) {
  return String(a.path).localeCompare(String(b.path));
}

/* -------------------------------------------------------------------------- */
/* Measuring                                                                   */
/* -------------------------------------------------------------------------- */

/** gzips a buffer at the declared level. Exported so a test can measure without a disk. */
export function gzipSize(bytes) {
  return gzipSync(bytes, { level: GZIP_LEVEL }).length;
}

/**
 * Turns a collected asset list into measured rows.
 *
 * `readFile` is injected so the measurement logic is testable against a synthetic tree
 * and against in-memory buffers, with no dependency on a real `dist` ever existing.
 */
export async function measureAssets(assets, readFile) {
  const rows = [];
  const failures = [];

  for (const asset of assets) {
    if (asset.problem) {
      failures.push(`${asset.reference}: ${asset.problem}`);
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(asset.path);
    } catch (error) {
      failures.push(
        `${asset.path}: referenced by dist/index.html but not present in the build (${error?.code ?? 'unknown error'})`,
      );
      continue;
    }
    rows.push({
      path: asset.path,
      kinds: asset.kinds,
      rawBytes: bytes.length,
      gzipBytes: gzipSize(bytes),
      excludedBy: asset.excludedBy,
    });
  }

  return { rows, failures };
}

/**
 * Sums the gzip sizes that count toward the budget and decides pass or fail.
 *
 * Excluded rows are totalled separately rather than dropped, so the report can state
 * what the boundary cost.
 */
export function evaluateWelcomeBudget(rows, limitBytes = WELCOME_BUDGET_BYTES) {
  const counted = rows.filter((row) => row.excludedBy === undefined);
  const excluded = rows.filter((row) => row.excludedBy !== undefined);
  const totalBytes = counted.reduce((sum, row) => sum + row.gzipBytes, 0);
  const excludedBytes = excluded.reduce((sum, row) => sum + row.gzipBytes, 0);
  return {
    counted,
    excluded,
    totalBytes,
    excludedBytes,
    limitBytes,
    headroomBytes: limitBytes - totalBytes,
    ok: totalBytes <= limitBytes,
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
          `Welcome budget gate: no built entry document at ${path.relative(REPO_ROOT, indexPath)}.`,
          'This gate fails rather than passing an unmeasured build, because a budget that',
          'reports success because it measured nothing is the failure this gate exists to',
          'prevent. Run: npm run build:web',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { counted, excluded, skipped } = collectInitialAssets(html);
  const { rows, failures } = await measureAssets(counted, (relative) =>
    readFile(path.join(distDir, ...relative.split('/'))),
  );

  // The excluded-by-nomodule scripts were never candidates, so they are reported from
  // the tag scan rather than measured. That is the honest split: they are named and
  // justified, and their size is not part of any total.
  if (failures.length > 0) {
    console.error('Welcome budget gate: dist/index.html references assets the build does not contain:');
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('The measurement is not reported, because a silently dropped reference is not a measurement.');
    process.exitCode = 1;
    return;
  }

  const result = evaluateWelcomeBudget(rows);

  console.log('Welcome initial payload (plan section 10.2: 300 KiB gzip, excluding lazy renderer bundles)');
  console.log(`  Measured from: ${path.relative(REPO_ROOT, indexPath)}`);
  console.log(`  gzip level: ${GZIP_LEVEL}`);
  console.log('');
  console.log('Counted - module scripts, modulepreloads, and linked stylesheets named by the entry document:');
  const width = Math.max(20, ...result.counted.map((row) => row.path.length));
  for (const row of result.counted) {
    const kinds = row.kinds.join('+');
    console.log(`  ${row.path.padEnd(width)}  ${kib(row.gzipBytes).padStart(11)}  [${kinds}]`);
  }
  if (result.counted.length === 0) {
    console.log('  (none)');
  }
  console.log('');

  if (result.excluded.length > 0) {
    console.log('Excluded from the total:');
    for (const row of result.excluded) {
      console.log(`  ${row.path.padEnd(width)}  ${kib(row.gzipBytes).padStart(11)}  (${row.excludedBy.key})`);
      console.log(`  ${' '.repeat(width)}  ${' '.repeat(11)}  ${row.excludedBy.reason}`);
    }
  }
  for (const entry of excluded) {
    console.log(`  ${entry.path.padEnd(width)}  ${'not measured'.padStart(11)}  (${entry.kind})`);
    console.log(`  ${' '.repeat(width)}  ${' '.repeat(11)}  ${entry.reason}`);
  }
  if (result.excluded.length === 0 && excluded.length === 0) {
    console.log('Excluded from the total: (none)');
  }
  if (skipped.length > 0) {
    console.log('');
    console.log('Not an initial asset (reported, not counted):');
    for (const entry of skipped) console.log(`  ${entry.kind}: ${entry.note}`);
  }
  console.log('');

  const verb = result.ok ? 'within budget' : 'OVER BUDGET';
  console.log(
    `  total counted   ${kib(result.totalBytes)} (${result.totalBytes} bytes) over ${result.counted.length} file(s)`,
  );
  console.log(`  limit           ${kib(result.limitBytes)} (${result.limitBytes} bytes)`);
  console.log(
    `  headroom        ${kib(Math.abs(result.headroomBytes))} ${result.ok ? 'under' : 'over'} the limit`,
  );
  console.log(`  ${result.excluded.length > 0 ? `excluded (not in the total) ${kib(result.excludedBytes)}` : 'excluded 0.00 KiB'}`);
  console.log('');

  if (!result.ok) {
    console.error(
      `Welcome budget EXCEEDED: ${kib(result.totalBytes)} counted against a ${kib(result.limitBytes)} limit, ` +
        `over by ${kib(-result.headroomBytes)}. Move code behind a route-aware lazy import, or raise the plan.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Welcome budget ${verb}: ${kib(result.totalBytes)} of ${kib(result.limitBytes)}.`);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) await main();
