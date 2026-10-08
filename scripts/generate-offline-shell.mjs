#!/usr/bin/env node
/**
 * Build-time offline-shell precache manifest generator (Phase 22).
 *
 * ## What it does
 *
 * Reads the emitted `dist/index.html`, extracts every same-origin `src`/`href`
 * asset the document references (`<script>`, `<link rel=stylesheet>`,
 * `<link rel=modulepreload>`, the injected `<link rel=manifest>`), adds the
 * document path itself, computes a build version token, and writes
 * `dist/offline-shell-manifest.js`.
 *
 * The generated file sets one frozen global:
 *
 *     self.__KD_OFFLINE_SHELL_MANIFEST__ = Object.freeze({
 *       version: '<token>',
 *       document: '<base path>',
 *       assets: ['/assets/index-<hash>.js', ...],
 *     });
 *
 * `public/sw.js` imports it with `importScripts` at install time, so the version
 * token and the asset allowlist are build facts read from the artifact rather than
 * values baked into a hand-written worker.
 *
 * ## Why `index.html` is the source, and not the whole `dist` tree
 *
 * The document is Vite's own record of what the release path loads: hashed entry
 * and chunk scripts, modulepreload links, the stylesheet, and the injected web app
 * manifest. Deriving the allowlist from it means the shell can only ever contain
 * what the build itself references, which is the property that keeps learner data
 * out of the cache by construction. Emitted-but-unreferenced files - including the
 * ES5 `-legacy-*` app chunks that `@vitejs/plugin-legacy` reaches through an inline
 * `System.import()` rather than an HTML attribute - are not cached, and that is
 * correct: no browser in the release matrix executes the `nomodule` bundle.
 *
 * ## The version token
 *
 * `VITE_OFFLINE_SHELL_VERSION` when set (used by the lane to force a deterministic
 * bump), otherwise the first 16 hex characters of the SHA-256 of `index.html`. The
 * document hash is the right default: every content-hashed asset's name appears in
 * `index.html`, so a change to any shell byte changes the document and therefore
 * the token. The token is never learner data - it is a hash of build output.
 *
 * ## Dependency and privacy rules
 *
 * Node built-ins only, no dependency, matching `scripts/generate-sprite-manifest.mjs`.
 * The output contains paths from the build artifact and a hash; it never contains a
 * subject, note, attachment, progression, statistic, preference, or assistance
 * value, and it reads nothing outside `dist/`.
 *
 * Usage: node scripts/generate-offline-shell.mjs [--dist=<dir>] [--base=<path>] [--build-version=<token>]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function argumentValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const flagIndex = process.argv.indexOf(`--${name}`);
  if (flagIndex !== -1 && process.argv[flagIndex + 1] !== undefined) {
    return process.argv[flagIndex + 1];
  }
  return undefined;
}

const DIST_DIR = resolve(PROJECT_ROOT, argumentValue('dist') ?? 'dist');
const BASE_PATH = argumentValue('base') ?? process.env.KD_OFFLINE_SHELL_BASE ?? '/';
const EXPLICIT_VERSION =
  argumentValue('build-version') ?? process.env.VITE_OFFLINE_SHELL_VERSION ?? null;
const OUTPUT_NAME = 'offline-shell-manifest.js';
const INDEX_HTML_PATH = join(DIST_DIR, 'index.html');
const OUTPUT_PATH = join(DIST_DIR, OUTPUT_NAME);

/** A shell manifest cannot name a path that is not a local, origin-absolute asset. */
function isCacheableAssetPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (/^(?:data|blob|http|https):/i.test(value)) return false;
  if (value.startsWith('#')) return false;
  return true;
}

function generate() {
  if (!existsSync(INDEX_HTML_PATH)) {
    throw new Error(`No emitted index.html at ${INDEX_HTML_PATH}. Run a build first.`);
  }

  const html = readFileSync(INDEX_HTML_PATH, 'utf8');
  const assetPaths = new Set();

  // Every same-origin asset the document references, from the emitted HTML rather
  // than from a glob of dist, so the allowlist cannot contain a file the release
  // path does not load.
  // Anchored so `data-src` (the legacy plugin's deferred entry) is not mistaken
  // for a real `src`: the character before the attribute name must not be `-` or a
  // word character.
  const attributePattern = /(?:^|[\s"'<])(?:src|href)\s*=\s*"([^"]+)"/g;
  for (const match of html.matchAll(attributePattern)) {
    const raw = match[1].trim();
    if (!isCacheableAssetPath(raw)) continue;
    const withoutQueryOrHash = raw.split(/[?#]/, 1)[0];
    assetPaths.add(withoutQueryOrHash);
  }

  // The document and the web app manifest are shell bytes even though one is the
  // navigation target and the other may be injected as a link rather than fetched.
  if (BASE_PATH.startsWith('/')) {
    assetPaths.add(BASE_PATH);
    assetPaths.add(`${BASE_PATH}manifest.webmanifest`);
  }

  // The worker and its own manifest are fetched by the browser's service-worker
  // machinery, not by the page, and must not be cached as shell assets.
  assetPaths.delete(`${BASE_PATH}${OUTPUT_NAME}`);
  assetPaths.delete(`${BASE_PATH}sw.js`);

  const version =
    EXPLICIT_VERSION !== null && EXPLICIT_VERSION.length > 0
      ? EXPLICIT_VERSION
      : createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 16);

  const manifest = {
    version,
    document: BASE_PATH.startsWith('/') ? BASE_PATH : './',
    assets: [...assetPaths].sort(),
  };

  writeFileSync(
    OUTPUT_PATH,
    `self.__KD_OFFLINE_SHELL_MANIFEST__ = Object.freeze(${JSON.stringify(manifest, null, 2)});\n`,
    'utf8',
  );
  console.log(
    `[offline-shell] wrote ${OUTPUT_NAME}: version=${version}, ${manifest.assets.length} shell asset(s).`,
  );
}

generate();
