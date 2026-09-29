#!/usr/bin/env node
/**
 * CC0 media registry gate.
 *
 * Plan section 10.3 requires CI to reject any newly registered media that lacks a
 * stable asset id and path, a creator or source, a source URL where applicable, the
 * exact `CC0-1.0` identifier, a license URL, a retrieval or creation date, a
 * SHA-256 checksum, or a modification record - and it requires unverified legacy
 * assets to stay out of the default PixiJS bundle. Phase 8's exit criterion is
 * "new media cannot be added without CC0 metadata", which is only a real criterion
 * if the metadata is both required and true, so this script does five things a
 * schema alone cannot do:
 *
 * 1. **It recomputes every checksum from the bytes on disk.** A registry that is
 *    only self-consistent is decoration. A digest that is recomputed on every run
 *    is a claim about a real file.
 * 2. **It discovers the media itself and fails on anything unregistered.** So
 *    dropping a file into `public/assets/` without provenance is a red build, not
 *    a silent addition to the release artifact.
 * 3. **It enforces the bundle separation.** Only `cc0-approved` and `procedural`
 *    entries may be bundle members, only entries under a bundle's own paths may
 *    declare that membership, and only approved classes may sit under a bundle
 *    path at all. An unverified file appearing in the default Pixi bundle is
 *    therefore a failure whether it was registered that way or not.
 * 4. **It covers the media the bundler can ship from source.** The assets root is not
 *    the only place a media file can reach `dist/`: anything under `src/` that a module
 *    names is emitted into the build output by Vite, and so is anything a build-time
 *    glob or a runtime-computed specifier can reach. So the gate registers, and requires
 *    registration of, every file the source root can reach - a known media extension on
 *    disk, and every statically-named reference resolved through the relative and
 *    `@/`-aliased specifiers a module can use, whether or not the import is currently
 *    reachable, and whether or not the file exists.
 * 5. **It refuses to classify media out of existence by suffix.** The extension
 *    vocabulary is closed: where the gate has to answer "is this media?", the answer is
 *    media, the small declared non-media set, or the run fails. `media: false` is
 *    therefore not a way to park a real image or sound, a non-media file whose bytes
 *    open with a known media signature is a failure even when its extension says
 *    otherwise, and a module that names a path with an extension the gate has never
 *    heard of is a failure too - because the bundler resolves that reference exactly as
 *    it resolves a `.png`. The one place the vocabulary does not decide the outcome is a
 *    file under `src/` that no module names, which the bundler cannot emit; that file is
 *    still read, still checked against the media signatures, and counted in the summary
 *    when it is skipped, so the skip is a recorded conclusion rather than a name-based
 *    exemption. See `validateSourceMedia`.
 * 6. **It holds the registry and the Pixi asset manifest to the same bundle set.** The
 *    registry is the authority on what a bundle is; `src/renderers/pixi/assets/
 *    assetManifest.ts` is the authority on which bundle ids the application can ask
 *    for. Those are two files, and nothing about either one keeps the other honest on
 *    its own: a bundle added to the manifest is not in the registry, so no entry can be
 *    a member of it and nothing would say so, and a bundle added to the registry is a
 *    declaration nothing can load. So the gate reads the manifest's `ASSET_BUNDLE_IDS`
 *    - as text, because this script imports no dependency and no TypeScript - and fails
 *    on a disagreement in either direction. See `readManifestBundleIds`.
 *
 * Honesty rules this script is built around
 * -----------------------------------------
 * - It never upgrades a classification. `--write` fills in checksums and nothing
 *   else, so it cannot be used to launder an unverified file into `cc0-approved`.
 * - It never prints a registry *value*. It prints asset ids, asset paths, field
 *   names, and closed-enum classifications. Any identifier that does not match its
 *   expected shape is withheld rather than echoed, so a future field that somehow
 *   held user data could not leak through an error message. There is no learner
 *   data in a media registry, and this script is written so that stays true even
 *   if someone adds one.
 *
 * Usage:
 *   node scripts/check-cc0-assets.mjs                 # gate: exit 1 on any problem
 *   node scripts/check-cc0-assets.mjs --write         # recompute checksums in place
 *   node scripts/check-cc0-assets.mjs --assets-root=DIR --registry=FILE --credits=FILE
 *
 * `--write` is a bootstrap and maintenance tool for checksums only. It never
 * creates, deletes, reclassifies, or re-bundles an entry: an author has to add the
 * entry, and its provenance, by hand first.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_ASSETS_ROOT = path.join(REPO_ROOT, 'public', 'assets');
const DEFAULT_REGISTRY = path.join(DEFAULT_ASSETS_ROOT, 'asset-licenses.json');
const DEFAULT_CREDITS = path.join(DEFAULT_ASSETS_ROOT, 'CREDITS.md');

/**
 * Repository-relative roots an entry's `path` may live under, and the directory
 * the gate discovers the source tree in.
 *
 * `public/assets` is the published assets tree, where *every* file is registered,
 * media and non-media alike. `src` is the bundled source tree, where only media
 * needs registering, because only media there can reach the build output; a `.ts`
 * file is code, and the gate has no business holding a digest for the repository's
 * own modules. Both are repository-relative strings rather than absolute paths so
 * that a registry entry means the same thing in CI, in a fixture tree, and in the
 * application.
 */
const ASSETS_ROOT_REPO_PATH = 'public/assets';
const SOURCE_ROOT = 'src';
const REGISTRABLE_ROOTS = [ASSETS_ROOT_REPO_PATH, SOURCE_ROOT];

/**
 * The module that declares `ASSET_BUNDLE_IDS`, as a repository-relative path.
 *
 * The second half of the bundle contract. The registry says what a bundle is and what
 * may be a member of it; this module says which bundle ids the application knows how
 * to ask for, and the gate holds the two to the same set in both directions. It is
 * resolved against the same root as `--registry` so a fixture tree, which has no
 * source module, reads nothing rather than reading the real one - and a run that read
 * nothing says so in the summary instead of quietly reporting agreement.
 */
const MANIFEST_MODULE_REPO_PATH = 'src/renderers/pixi/assets/assetManifest.ts';

/**
 * Aliases a module can use to reach the source tree, and what they resolve to.
 *
 * Declared here rather than read from `vite.config.ts` because this script imports
 * Node built-ins and nothing else: the CI job runs it with no dependency install.
 * The map mirrors `vite.config.ts`'s `resolve.alias` and the `paths` entry in
 * `tsconfig.app.json`, and both are asserted against the real files by
 * `tests/phase8/cc0-source-media-scope.test.ts`, so a new alias cannot be added
 * without this map knowing about it.
 */
const SOURCE_ALIASES = new Map([['@', SOURCE_ROOT]]);

/** The exact identifier and deed plan section 10.3 and ADR 002 Decision 5 name. */
const CC0_IDENTIFIER = 'CC0-1.0';
const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

/** The plan's three media classes, plus the non-media class this registry needs. */
const CLASSIFICATIONS = ['cc0-approved', 'procedural', 'legacy-unverified', 'repository-authored'];
/** The only classes a default PixiJS bundle may admit. */
const BUNDLE_ADMISSIBLE_CLASSES = ['cc0-approved', 'procedural'];
/** Classes that must carry the full plan section 10.3 field set. */
const PROVENANCE_CLASSES = ['cc0-approved', 'procedural', 'repository-authored'];

const DATE_KINDS = ['created', 'retrieved', 'introduced-in-repository'];
const CHECKSUM_POLICIES = ['pinned', 'regenerated', 'self-referential'];
const LEGACY_RENDERERS = ['phaser', 'react-dom', 'both', 'none', 'unknown'];

/**
 * File extensions treated as media. A file with one of these extensions must be
 * registered with `media: true`.
 *
 * This set is deliberately *not* the whole answer, because no list of suffixes is
 * total: the formats below are the ones a web build can ship today, and a new one
 * will be added here as a reviewed diff. What makes the rule mechanical is the
 * closed vocabulary it sits in - see NON_MEDIA_EXTENSIONS and extensionClass().
 */
const MEDIA_EXTENSIONS = new Set([
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff',
  'mp3', 'ogg', 'wav', 'm4a', 'weba', 'flac',
  'mp4', 'webm', 'ogv',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

/**
 * File extensions that are *not* media and may be registered with `media: false`.
 *
 * Two kinds of file need this set. The registry's own published documents, which
 * are checksummed and are not media and must not claim otherwise: `CREDITS.md` and
 * `asset-licenses.json`. And the repository's own code and stylesheets, because a
 * file under the source root that is not media is a module rather than an asset, and
 * the gate has no business holding a digest for it - a theme token module is a
 * module, not a picture.
 *
 * It is short on purpose, and it is the other half of a closed vocabulary: an
 * extension in neither this set nor MEDIA_EXTENSIONS cannot be registered at all
 * (E-UNKNOWN-EXTENSION), and a module under the source root that names a path with such
 * an extension is a failure too, because the bundler resolves that reference exactly as
 * it resolves a `.png`. So `media: false` is no longer a way to declare a file that is
 * really media out of the media taxonomy by choosing an unlisted suffix. Adding an
 * extension here is as much a reviewed act as adding one above.
 *
 * The one place an unclassified suffix does not fail on its own is a file under the
 * source root that no module names: Vite emits nothing it cannot reach, so such a file
 * cannot ship, and the rule that can see its bytes is the byte check rather than the
 * name. See `validateSourceMedia`.
 */
const NON_MEDIA_EXTENSIONS = new Set([
  // Published registry documents.
  'md', 'json', 'txt',
  // Modules.
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  // Stylesheets, which the bundler resolves and emits but which carry no licence.
  'css', 'scss', 'sass', 'less', 'styl',
  // Markup and build by-products.
  'html', 'map',
]);

/**
 * Leading byte sequences that only a media container produces.
 *
 * The extension is a claim by the author; the first bytes are a fact about the
 * file. When they disagree - a PNG wearing a `.md` extension, say - the bytes win
 * and the run fails, so smuggling real media past the vocabulary by renaming it is
 * a loud failure rather than a green build.
 *
 * This is a floor rather than a ceiling, and it is deliberately conservative: only
 * unambiguous binary signatures are here. Text media (SVG, Lottie JSON) is not
 * sniffed, because a credits page that happens to contain a fragment of SVG must
 * not fail the gate. `MEDIA_SIGNATURE_FLOOR` in the report says so out loud rather
 * than leaving it implied.
 */
const MEDIA_SIGNATURES = [
  { format: 'PNG', offset: 0, bytes: '89504e470d0a1a0a' },
  { format: 'JPEG', offset: 0, bytes: 'ffd8ff' },
  { format: 'GIF', offset: 0, bytes: '474946383761' },
  { format: 'GIF', offset: 0, bytes: '474946383961' },
  { format: 'BMP', offset: 0, bytes: '424d' },
  { format: 'ICO', offset: 0, bytes: '00000100' },
  { format: 'TIFF', offset: 0, bytes: '49492a00' },
  { format: 'TIFF', offset: 0, bytes: '4d4d002a' },
  { format: 'WebP, WAV, or AVI (RIFF container)', offset: 0, bytes: '52494646' },
  { format: 'Ogg (OGA, Opus, or Ogg Vorbis)', offset: 0, bytes: '4f676753' },
  { format: 'FLAC', offset: 0, bytes: '664c6143' },
  { format: 'MPEG audio', offset: 0, bytes: 'fffb' },
  { format: 'MPEG audio', offset: 0, bytes: 'fff3' },
  { format: 'MP3 with an ID3 tag', offset: 0, bytes: '494433' },
  { format: 'MP4, MOV, AVIF, or HEIC (ISO base media)', offset: 4, bytes: '66747970' },
  { format: 'Matroska or WebM', offset: 0, bytes: '1a45dfa3' },
  { format: 'gzipped container, such as .svgz', offset: 0, bytes: '1f8b' },
  { format: 'DDS texture', offset: 0, bytes: '44445320' },
  { format: 'KTX2 texture', offset: 0, bytes: 'ab4b545820bb0d0a1a0a' },
  { format: 'OpenEXR image', offset: 0, bytes: '762f3101' },
  { format: 'Radiance HDR image', offset: 0, bytes: '2352414449414e4345' },
  { format: 'glTF binary model', offset: 0, bytes: '674c5446' },
];

/** How many leading bytes a signature comparison needs. */
const SIGNATURE_WINDOW = 16;

/**
 * Allowed keys on a registry entry.
 *
 * A closed key set is the point: a typo like `licence`, `licenceUrl`, or
 * `sha512` would otherwise read as "field absent" on the classes that require it,
 * which is the failure this gate exists to prevent. A key that is not listed here
 * is a hard failure naming the key, so extending the schema is a deliberate act.
 */
const ENTRY_KEYS = new Set([
  'id', 'path', 'classification', 'media', 'title', 'role', 'notes',
  'license', 'licenseVerified', 'licenseUrl', 'licenseUnverifiedReason',
  'creator', 'source', 'sourceUrl', 'sourceUrlNotApplicable',
  'date', 'dateKind', 'sha256', 'checksumPolicy', 'generation',
  'modifications', 'introducedBy', 'modifiedBy', 'bundles', 'pixiEligible',
  'legacyRenderer', 'retention',
]);

/** The fields plan section 10.3 requires of a registered asset, by name. */
const REQUIRED_PROVENANCE_FIELDS = [
  'creator', 'source', 'sourceUrl (or sourceUrlNotApplicable.reason)',
  'license', 'licenseUrl', 'date', 'sha256', 'modifications',
];

/** Print-safe shapes. Anything else is withheld rather than echoed. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]{1,240}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Every diagnostic this script can emit, with the reason it exists. */
const CODES = {
  'E-REGISTRY-UNREADABLE': 'The registry could not be read or parsed as JSON.',
  'E-REGISTRY-SCHEMA': 'The registry is missing a top-level field, or a field has the wrong shape.',
  'E-ENTRY-SCHEMA': 'An entry is missing a structural field, or a field has the wrong shape.',
  'E-ENTRY-UNKNOWN-KEY': 'An entry carries a key that is not in the schema. Typo, or an undocumented extension.',
  'E-DUPLICATE-ID': 'Two entries share an asset id. An id is the stable identity of an asset and must be unique.',
  'E-DUPLICATE-PATH': 'Two entries claim the same path.',
  'E-PATH-UNSAFE': 'A path is absolute, escapes the assets root, or contains unexpected characters.',
  'E-MISSING-METADATA': 'A provenance-bearing class is missing a field plan section 10.3 requires.',
  'E-LICENSE-IDENTIFIER': 'A license identifier is not the exact expected value.',
  'E-LICENSE-URL': 'A license URL is not the exact expected value.',
  'E-DATE-FORMAT': 'A date is not a real ISO calendar date, or a dateKind is not recognised.',
  'E-CHECKSUM-FORMAT': 'A checksum is not a lowercase 64-character hex SHA-256, or a checksum is present where the policy forbids one.',
  'E-CHECKSUM-MISMATCH': 'The recorded checksum does not match the bytes on disk.',
  'E-MEDIA-FLAG': 'The media flag disagrees with the file extension.',
  'E-UNKNOWN-EXTENSION': 'A file extension is in neither the media set nor the declared non-media set, so the registry cannot classify it.',
  'E-MEDIA-SIGNATURE': 'A file declared non-media begins with a known media file signature.',
  'E-ASSET-MISSING': 'A registered path does not exist on disk.',
  'E-UNREGISTERED-MEDIA': 'A media file exists under the assets root with no registry entry.',
  'E-UNREGISTERED-FILE': 'A file exists under the assets root with no registry entry.',
  'E-UNREGISTERED-SOURCE-MEDIA': 'A file the bundler can reach from the source tree - a known media extension on disk, or a path a module names - has no registry entry.',
  'E-SOURCE-MEDIA-PATH': 'A reference from the source tree resolves outside the registrable roots, so no entry can cover it.',
  'E-PIXI-ELIGIBILITY': 'An entry is marked Pixi-eligible, or is a bundle member, without approved provenance.',
  'E-BUNDLE-UNKNOWN': 'An entry references a bundle the registry does not declare.',
  'E-BUNDLE-DRIFT': 'The registry and the Pixi asset manifest disagree about which bundle ids exist.',
  'E-BUNDLE-PATH': 'Bundle membership and the bundle\'s declared paths disagree.',
  'E-UNVERIFIED-IN-BUNDLE': 'An unapproved asset sits under an approved bundle path.',
  'E-NONMEDIA-IN-BUNDLE': 'A non-media file is a member of a media bundle.',
  'E-GENERATION': 'A procedural entry does not describe a reproducible generation recipe.',
  'E-GENERATION-SCRIPT-MISSING': 'A declared generating script does not exist in the repository.',
  'E-GENERATION-MARKER': 'A procedural entry with embedMarker does not have its id and recipe in the generated file.',
  'E-LEGACY-UNVERIFIED': 'A legacy-unverified entry is not explicitly marked unverified, or carries a license claim it cannot support.',
  'E-RETENTION': 'A legacy-unverified entry does not record a retention policy.',
  'E-CREDITS-COVERAGE': 'CREDITS.md does not cover a registered path.',
  'E-CREDITS-UNKNOWN-PATH': 'CREDITS.md names a path the registry does not contain.',
  'E-CREDITS-MISSING': 'CREDITS.md is missing or unreadable.',
  'E-COUNTS': 'The recorded per-class counts do not match the entries.',
  'E-SEMANTIC-DRIFT': 'A generated index has drifted from the tree it indexes.',
};

/**
 * Builds a diagnostic.
 *
 * `kind` marks the handful of problems that exist only because a checksum is absent or
 * malformed. Those are the ones `--write` is allowed to consider fixed, so the tag has
 * to be explicit rather than inferred from the message text: an earlier version matched
 * on the word "sha256", which also appears in the required-field list of an unrelated
 * problem, and quietly suppressed a missing creator.
 */
function problem(code, where, detail, kind) {
  return { code, where, detail, kind };
}

/** Asset ids and paths are the only things this script echoes, and only if shaped right. */
function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : '<withheld: not a safe asset id>';
}

function safePath(value) {
  return typeof value === 'string' && SAFE_PATH.test(value) && !value.includes('..')
    ? value
    : '<withheld: not a safe asset path>';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The file's suffix, lowercased, or `''` when it has none.
 *
 * A leading dot is not a suffix separator, so a dotfile has no extension: `.test-planted`
 * is a name that begins with a dot, not a `test-planted` file. Getting this wrong would
 * report a dotfile as an author-chosen, unclassified format - and would then make the
 * closed vocabulary look total when it is not.
 */
function extensionOf(assetPath) {
  const base = assetPath.slice(assetPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * The one definition of "is this media", shared by every rule in this script.
 *
 * `media` and `non-media` are the two answers a registry entry may give, and
 * `unclassified` is the refusal: the extension appears in neither declared set, so
 * the registry cannot honestly say which it is.
 *
 * `unclassified` is a refusal, not a verdict, and what a caller does with a refusal is
 * where the rules below diverge - deliberately, because the three call sites have
 * different evidence about whether a file can reach the build:
 *
 * - **The assets root** treats a refusal as media until proven otherwise, because Vite
 *   copies `public/` into `dist/` verbatim: an unclassified file there ships whether or
 *   not anything references it, and a false negative ships unprovenanced bytes.
 * - **A registry entry** treats it as fatal (`E-UNKNOWN-EXTENSION`), because `media:
 *   false` is a claim about the file and there is nothing to check the claim against.
 * - **The source tree** asks the question that actually decides the outcome: can the
 *   bundler reach this file, and are these bytes media. See `hasUnlistedSuffix` and
 *   `validateSourceMedia`.
 */
function extensionClass(assetPath) {
  const extension = extensionOf(assetPath);
  if (MEDIA_EXTENSIONS.has(extension)) return 'media';
  if (NON_MEDIA_EXTENSIONS.has(extension)) return 'non-media';
  return 'unclassified';
}

/**
 * True for a name that carries a suffix the vocabulary has not classified.
 *
 * The distinction is the difference between `./motion` and `./icon.svgz`, and it is the
 * whole of the source-tree reference rule. A specifier with no suffix at all is a module,
 * and a TypeScript codebase is full of them, so calling those media fails the gate on
 * its own code. A specifier with a suffix the gate has not heard of is an author
 * choosing a format, and the bundler resolves that exactly as it resolves a `.png`: both
 * reach `dist/`. The closed vocabulary is therefore enforced on the second, and a
 * failure is the correct answer for it.
 */
function hasUnlistedSuffix(assetPath) {
  return extensionOf(assetPath) !== '' && extensionClass(assetPath) === 'unclassified';
}

/** True for a file the registry is allowed to describe at all. */
function isRegistrablePath(assetPath) {
  return REGISTRABLE_ROOTS.some((root) => assetPath.startsWith(`${root}/`));
}

/** True for a file in the bundled source tree, where only media is registered. */
function isSourcePath(assetPath) {
  return assetPath.startsWith(`${SOURCE_ROOT}/`);
}

/**
 * A date is a real calendar day, not merely a well-shaped string.
 *
 * `Date.parse` rolls `2026-02-30` over into March and returns a timestamp, so a
 * format check alone accepts a day that does not exist. Round-tripping the parsed
 * value back through ISO is what makes the promise in the message true.
 */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

function entryLabel(entry) {
  const id = safeId(entry?.id);
  const path = safePath(entry?.path);
  return `${id} (${path})`;
}

function checksumOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Every file under a root, as repository-relative paths.
 *
 * `prefix` is the root's repository-relative path, so a discovered name can be
 * compared with a registry entry's `path` directly. The assets root is discovered
 * with an empty prefix and mapped through the root name by the caller, which is how
 * a fixture tree and the real tree are gated by the same code.
 */
async function discoverFiles(root, prefix = '') {
  const found = [];
  const walk = async (dir, parent) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  await walk(root, prefix);
  return found;
}

/** Top-level registry shape. */
function validateRegistryShape(registry) {
  const problems = [];
  if (!isRecord(registry)) {
    return [problem('E-REGISTRY-SCHEMA', '<registry>', 'The registry must be a JSON object.')];
  }
  if (registry.schemaVersion !== 1) {
    problems.push(
      problem('E-REGISTRY-SCHEMA', '<registry>', 'schemaVersion must be the number 1.'),
    );
  }
  for (const key of ['registry', 'purpose', 'privacy', 'license', 'policy', 'bundles', 'counts', 'assets']) {
    if (registry[key] === undefined) {
      problems.push(problem('E-REGISTRY-SCHEMA', '<registry>', `Top-level field \`${key}\` is required.`));
    }
  }
  if (!isRecord(registry.license)) {
    problems.push(problem('E-REGISTRY-SCHEMA', '<registry>', '`license` must be an object.'));
  } else {
    if (registry.license.identifier !== CC0_IDENTIFIER) {
      problems.push(
        problem('E-LICENSE-IDENTIFIER', '<registry>', 'The `license` block must state the exact CC0-1.0 identifier.'),
      );
    }
    if (registry.license.url !== CC0_URL) {
      problems.push(
        problem('E-LICENSE-URL', '<registry>', `The \`license\` block must state the CC0 deed URL ${CC0_URL}.`),
      );
    }
  }
  if (!isRecord(registry.policy)) {
    problems.push(problem('E-REGISTRY-SCHEMA', '<registry>', '`policy` must be an object.'));
  }
  if (!isRecord(registry.bundles) || Object.keys(registry.bundles).length === 0) {
    problems.push(
      problem('E-REGISTRY-SCHEMA', '<registry>', '`bundles` must declare at least one bundle.'),
    );
  } else {
    for (const [name, bundle] of Object.entries(registry.bundles)) {
      if (!isRecord(bundle)) {
        problems.push(problem('E-BUNDLE-UNKNOWN', name, 'A bundle declaration must be an object.'));
        continue;
      }
      if (!isNonEmptyString(bundle.description)) {
        problems.push(problem('E-BUNDLE-UNKNOWN', name, 'A bundle must describe what it is.'));
      }
      if (!isNonEmptyString(bundle.admission)) {
        problems.push(problem('E-BUNDLE-UNKNOWN', name, 'A bundle must state its admission policy.'));
      }
      if (!isNonEmptyStringArray(bundle.paths)) {
        problems.push(problem('E-BUNDLE-PATH', name, 'A bundle must declare at least one assets path.'));
        continue;
      }
      for (const bundlePath of bundle.paths) {
        if (bundlePath.startsWith('/') || bundlePath.includes('..')) {
          problems.push(problem('E-PATH-UNSAFE', name, 'A bundle path must be a repository-relative path with no `..`.'));
        }
      }
    }
  }
  if (!Array.isArray(registry.assets)) {
    problems.push(problem('E-REGISTRY-SCHEMA', '<registry>', '`assets` must be an array.'));
  }
  if (isRecord(registry.paletteFamilies)) {
    for (const [family, tokens] of Object.entries(registry.paletteFamilies)) {
      if (!isRecord(tokens) || Object.keys(tokens).length === 0) {
        problems.push(problem('E-REGISTRY-SCHEMA', `paletteFamilies.${family}`, 'A palette family must hold at least one token.'));
        continue;
      }
      for (const [token, hex] of Object.entries(tokens)) {
        if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/.test(hex)) {
          problems.push(
            problem('E-REGISTRY-SCHEMA', `paletteFamilies.${family}.${token}`, 'A palette token must be a lowercase #rrggbb value.'),
          );
        }
      }
    }
  }
  return problems;
}

/** Structural shape of one entry: identity, classification, media flag, and key set. */
function validateEntryShape(entry, index) {
  const problems = [];
  const where = isRecord(entry) ? entryLabel(entry) : `<assets[${index}]>`;
  if (!isRecord(entry)) {
    return [problem('E-ENTRY-SCHEMA', where, 'An asset entry must be an object.')];
  }
  if (!isNonEmptyString(entry.id)) {
    problems.push(problem('E-ENTRY-SCHEMA', where, '`id` is required and must be a non-empty string.'));
  } else if (!SAFE_ID.test(entry.id)) {
    problems.push(
      problem('E-ENTRY-SCHEMA', where, '`id` must be lowercase alphanumeric with dots, dashes, or underscores.'),
    );
  }
  if (!isNonEmptyString(entry.path)) {
    problems.push(problem('E-ENTRY-SCHEMA', where, '`path` is required and must be a non-empty string.'));
  } else {
    if (!SAFE_PATH.test(entry.path)) {
      problems.push(
        problem('E-PATH-UNSAFE', where, '`path` contains characters outside the permitted set, so it is withheld and not resolved.'),
      );
    } else if (entry.path.startsWith('/') || entry.path.includes('..')) {
      problems.push(problem('E-PATH-UNSAFE', where, '`path` must be repository-relative and must not escape the assets root.'));
    } else if (!isRegistrablePath(entry.path)) {
      problems.push(
        problem('E-PATH-UNSAFE', where, `\`path\` must live under ${REGISTRABLE_ROOTS.map((root) => `${root}/`).join(' or ')}.`),
      );
    }
  }
  if (!CLASSIFICATIONS.includes(entry.classification)) {
    problems.push(
      problem('E-ENTRY-SCHEMA', where, `\`classification\` must be one of: ${CLASSIFICATIONS.join(', ')}.`),
    );
  }
  if (typeof entry.media !== 'boolean') {
    problems.push(problem('E-ENTRY-SCHEMA', where, '`media` must be an explicit boolean.'));
  } else if (entry.classification === 'repository-authored' && entry.media) {
    // The class that exists for this repository's own non-media files must not become
    // a way to park media outside the media taxonomy: a media file is approved,
    // procedural, or unverified, and those three are the only honest answers.
    problems.push(
      problem('E-ENTRY-SCHEMA', where, 'A `repository-authored` entry is for non-media files. Classify media as cc0-approved, procedural, or legacy-unverified.'),
    );
  } else if (isNonEmptyString(entry.path) && SAFE_PATH.test(entry.path)) {
    // The closed extension vocabulary. `media: false` is a declaration, so the
    // declaration has to be about a suffix the gate has actually classified;
    // otherwise the suffix itself is the hole.
    const classification = extensionClass(entry.path);
    if (classification === 'unclassified') {
      problems.push(
        problem(
          'E-UNKNOWN-EXTENSION',
          where,
          `A .${extensionOf(entry.path)} file is in neither the media set nor the declared non-media set, so \`media: ${entry.media}\` cannot be checked against anything. Add the extension to MEDIA_EXTENSIONS or NON_MEDIA_EXTENSIONS in scripts/check-cc0-assets.mjs, deliberately.`,
        ),
      );
    } else if ((classification === 'media') !== entry.media) {
      problems.push(
        problem(
          'E-MEDIA-FLAG',
          where,
          `The \`media\` flag disagrees with the file extension: a .${extensionOf(entry.path)} file must declare media ${classification === 'media'}.`,
        ),
      );
    }
  }
  if (
    isNonEmptyString(entry.path) &&
    SAFE_PATH.test(entry.path) &&
    isSourcePath(entry.path) &&
    entry.media === false
  ) {
    // Media under the source tree needs a registry entry; code does not. Recording a
    // digest of every module would make the registry a second copy of the repository
    // and would still say nothing about licensing.
    problems.push(
      problem('E-ENTRY-SCHEMA', where, `Only media is registered under ${SOURCE_ROOT}/: a non-media file there is code, not an asset.`),
    );
  }
  if (!Array.isArray(entry.bundles)) {
    problems.push(problem('E-ENTRY-SCHEMA', where, '`bundles` must be an array, empty for a non-member.'));
  }
  if (typeof entry.pixiEligible !== 'boolean') {
    problems.push(problem('E-ENTRY-SCHEMA', where, '`pixiEligible` must be an explicit boolean.'));
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) {
      problems.push(
        problem('E-ENTRY-UNKNOWN-KEY', where, `Unrecognised key \`${key}\`. Add it to ENTRY_KEYS deliberately, or remove it.`),
      );
    }
  }
  return problems;
}

/** The plan section 10.3 field set, for every class that claims provenance. */
function validateProvenance(entry, repoRoot) {
  const problems = [];
  const where = entryLabel(entry);
  const className = CLASSIFICATIONS.includes(entry.classification) ? entry.classification : 'unknown';

  if (PROVENANCE_CLASSES.includes(className)) {
    const missing = [];
    if (!isNonEmptyString(entry.creator)) missing.push('creator');
    if (!isNonEmptyString(entry.source)) missing.push('source');
    const hasSourceUrl = isNonEmptyString(entry.sourceUrl);
    const hasSourceUrlReason =
      isRecord(entry.sourceUrlNotApplicable) && isNonEmptyString(entry.sourceUrlNotApplicable.reason);
    if (!hasSourceUrl && !hasSourceUrlReason) missing.push('sourceUrl');
    if (!isNonEmptyString(entry.license)) missing.push('license');
    if (!isNonEmptyString(entry.licenseUrl)) missing.push('licenseUrl');
    if (!isNonEmptyString(entry.date)) missing.push('date');
    if (!isNonEmptyString(entry.dateKind)) missing.push('dateKind');
    // A non-pinned checksum policy is reported precisely by E-CHECKSUM-FORMAT below,
    // so it is not also counted here as a missing field.
    if ((entry.checksumPolicy ?? 'pinned') === 'pinned' && !isNonEmptyString(entry.sha256)) {
      missing.push('sha256');
    }
    if (!isNonEmptyStringArray(entry.modifications)) missing.push('modifications');
    if (missing.length > 0) {
      problems.push(
        problem(
          'E-MISSING-METADATA',
          where,
          `A \`${className}\` entry must record: ${REQUIRED_PROVENANCE_FIELDS.join(', ')}. Missing: ${missing.join(', ')}.`,
          missing.length === 1 && missing[0] === 'sha256' ? 'checksum-shape' : undefined,
        ),
      );
    }
    if (hasSourceUrl && !/^https:\/\//.test(entry.sourceUrl)) {
      problems.push(problem('E-MISSING-METADATA', where, '`sourceUrl` must be an https URL.'));
    }
    if (className === 'repository-authored') {
      if (entry.license !== 'MIT') {
        problems.push(
          problem('E-LICENSE-IDENTIFIER', where, 'A `repository-authored` entry must record the repository license, MIT.'),
        );
      }
      if (!isNonEmptyString(entry.licenseUrl) || !entry.licenseUrl.startsWith('LICENSE')) {
        problems.push(
          problem('E-LICENSE-URL', where, 'A `repository-authored` entry must point `licenseUrl` at the repository LICENSE file.'),
        );
      }
    } else {
      if (entry.license !== CC0_IDENTIFIER) {
        problems.push(
          problem('E-LICENSE-IDENTIFIER', where, `A \`${className}\` entry must record the exact identifier ${CC0_IDENTIFIER}.`),
        );
      }
      if (entry.licenseUrl !== CC0_URL) {
        problems.push(problem('E-LICENSE-URL', where, `A \`${className}\` entry must record the license URL ${CC0_URL}.`));
      }
    }
  }

  if (className === 'legacy-unverified') {
    if (entry.license !== 'UNVERIFIED') {
      problems.push(
        problem('E-LEGACY-UNVERIFIED', where, 'A `legacy-unverified` entry must record the literal license value UNVERIFIED.'),
      );
    }
    if (entry.licenseVerified !== false) {
      problems.push(
        problem('E-LEGACY-UNVERIFIED', where, 'A `legacy-unverified` entry must state `licenseVerified: false`.'),
      );
    }
    if (!isNonEmptyString(entry.licenseUnverifiedReason)) {
      problems.push(
        problem('E-LEGACY-UNVERIFIED', where, 'A `legacy-unverified` entry must record why the license is unverified.'),
      );
    }
    if (entry.licenseUrl !== undefined) {
      problems.push(
        problem('E-LEGACY-UNVERIFIED', where, 'A `legacy-unverified` entry must not carry a license URL: it has no license to point at.'),
      );
    }
    if (entry.dateKind !== 'introduced-in-repository') {
      problems.push(
        problem('E-DATE-FORMAT', where, 'A `legacy-unverified` entry must use dateKind `introduced-in-repository`: the upstream creation date is unknown.'),
      );
    }
  }

  if (isNonEmptyString(entry.date) && !isCalendarDate(entry.date)) {
    problems.push(
      problem('E-DATE-FORMAT', where, '`date` must be a real ISO calendar date, YYYY-MM-DD: 2026-02-30 is not a day that exists.'),
    );
  }
  if (entry.dateKind !== undefined && !DATE_KINDS.includes(entry.dateKind)) {
    problems.push(problem('E-DATE-FORMAT', where, `\`dateKind\` must be one of: ${DATE_KINDS.join(', ')}.`));
  }
  if (PROVENANCE_CLASSES.includes(className) && !['created', 'retrieved'].includes(entry.dateKind)) {
    problems.push(
      problem('E-DATE-FORMAT', where, `A \`${className}\` entry must use dateKind \`created\` or \`retrieved\`, the plan's creation or retrieval date.`),
    );
  }

  if (entry.licenseVerified !== undefined && typeof entry.licenseVerified !== 'boolean') {
    problems.push(problem('E-ENTRY-SCHEMA', where, '`licenseVerified` must be a boolean when present.'));
  }
  if (entry.legacyRenderer !== undefined && !LEGACY_RENDERERS.includes(entry.legacyRenderer)) {
    problems.push(
      problem('E-ENTRY-SCHEMA', where, `\`legacyRenderer\` must be one of: ${LEGACY_RENDERERS.join(', ')}.`),
    );
  }
  if (entry.legacyRenderer === 'pixi') {
    problems.push(problem('E-PIXI-ELIGIBILITY', where, 'A legacy asset may not name Pixi as a renderer it is allowed to reach.'));
  }

  if (className === 'legacy-unverified') {
    if (entry.retention !== 'keep-until-phaser-removal') {
      problems.push(
        problem('E-RETENTION', where, 'A `legacy-unverified` entry must record `retention: keep-until-phaser-removal`.'),
      );
    }
  } else if (entry.retention !== undefined) {
    problems.push(problem('E-RETENTION', where, '`retention` is a legacy-migration field and belongs only on a `legacy-unverified` entry.'));
  }

  // Checksum policy. `pinned` is the default and the only policy that carries a digest.
  const policy = entry.checksumPolicy ?? 'pinned';
  if (!CHECKSUM_POLICIES.includes(policy)) {
    problems.push(problem('E-CHECKSUM-FORMAT', where, `\`checksumPolicy\` must be one of: ${CHECKSUM_POLICIES.join(', ')}.`));
  }
  if (policy === 'pinned') {
    if (!isNonEmptyString(entry.sha256)) {
      problems.push(problem('E-CHECKSUM-FORMAT', where, 'A pinned entry must record a sha256.', 'checksum-shape'));
    } else if (!SHA256.test(entry.sha256)) {
      problems.push(problem('E-CHECKSUM-FORMAT', where, '`sha256` must be 64 lowercase hexadecimal characters.', 'checksum-shape'));
    }
  } else if (entry.sha256 !== undefined) {
    problems.push(
      problem('E-CHECKSUM-FORMAT', where, `A \`${policy}\` entry must not record a sha256; the reason lives in \`generation.checksum\`.`, 'checksum-shape'),
    );
  }

  // The generation block: how the file is produced, and, when a digest is impossible,
  // what stands in for it. Required on a procedural entry. Allowed on any other entry
  // only when that entry has to explain an unpinnable checksum - which is the case for
  // this registry itself.
  if (className === 'procedural' && !isRecord(entry.generation)) {
    problems.push(
      problem('E-GENERATION', where, 'A `procedural` entry must record a `generation` block: script, command, and recipe.'),
    );
  }
  if (isRecord(entry.generation)) {
    const required = ['script', 'command', 'recipe'];
    for (const key of required) {
      if (!isNonEmptyString(entry.generation[key])) {
        problems.push(problem('E-GENERATION', where, `\`generation.${key}\` is required so the file is reproducible.`));
      }
    }
    if (isNonEmptyString(entry.generation.script) && !isDeclaredScript(entry.generation.script, repoRoot)) {
      problems.push(
        problem('E-GENERATION-SCRIPT-MISSING', entryLabel(entry), 'The declared generating script is not a file inside this repository.'),
      );
    }
    if (policy !== 'pinned' && !isNonEmptyString(entry.generation.checksum)) {
      problems.push(
        problem('E-GENERATION', where, `A \`${policy}\` entry must record \`generation.checksum\`: why no digest can be pinned, and what check stands in for it.`, 'checksum-shape'),
      );
    }
    if (entry.generation.embedMarker !== undefined && typeof entry.generation.embedMarker !== 'boolean') {
      problems.push(problem('E-GENERATION', where, '`generation.embedMarker` must be a boolean when present.'));
    }
    if (entry.generation.semanticCheck !== undefined && !isNonEmptyString(entry.generation.semanticCheck)) {
      problems.push(problem('E-GENERATION', where, '`generation.semanticCheck` must be a non-empty string when present.'));
    }
  } else if (policy !== 'pinned') {
    problems.push(
      problem('E-GENERATION', where, `A \`${policy}\` entry must carry a \`generation\` block explaining what stands in for the missing checksum.`, 'checksum-shape'),
    );
  }

  return problems;
}

/**
 * True only when a declared generating script is a real file inside the repository.
 *
 * The existence half matters as much as the containment half: a `procedural` entry
 * whose recipe points at a script that was renamed or deleted is a claim nobody can
 * reproduce, which is the same failure as a checksum that no longer matches.
 */
function isDeclaredScript(scriptPath, repoRoot) {
  if (!isNonEmptyString(scriptPath) || path.isAbsolute(scriptPath) || scriptPath.includes('..')) {
    return false;
  }
  const resolved = path.resolve(repoRoot, scriptPath);
  return resolved.startsWith(`${repoRoot}${path.sep}`) && existsSync(resolved);
}

/** Cross-entry rules: identity, bundle membership, and the Pixi separation. */
function validateRelationships(registry, assets) {
  const problems = [];
  const byId = new Map();
  const byPath = new Map();
  const bundles = isRecord(registry.bundles) ? registry.bundles : {};

  for (const entry of assets) {
    if (!isRecord(entry)) continue;
    if (isNonEmptyString(entry.id)) {
      if (byId.has(entry.id)) {
        problems.push(problem('E-DUPLICATE-ID', entryLabel(entry), 'Another entry already uses this asset id.'));
      }
      byId.set(entry.id, entry);
    }
    if (isNonEmptyString(entry.path)) {
      if (byPath.has(entry.path)) {
        problems.push(problem('E-DUPLICATE-PATH', entryLabel(entry), 'Another entry already claims this path.'));
      }
      byPath.set(entry.path, entry);
    }
  }

  for (const entry of assets) {
    if (!isRecord(entry)) continue;
    const where = entryLabel(entry);
    const className = entry.classification;
    const declared = Array.isArray(entry.bundles) ? entry.bundles : [];
    const admissible = BUNDLE_ADMISSIBLE_CLASSES.includes(className);

    if (!admissible) {
      if (declared.length > 0) {
        problems.push(
          problem('E-PIXI-ELIGIBILITY', where, `A \`${className}\` asset may not be a member of any bundle. Only ${BUNDLE_ADMISSIBLE_CLASSES.join(' and ')} assets may.`),
        );
      }
      if (entry.pixiEligible !== false) {
        problems.push(problem('E-PIXI-ELIGIBILITY', where, 'A non-approved asset must state `pixiEligible: false`.'));
      }
    } else if (entry.pixiEligible !== (declared.length > 0)) {
      problems.push(
        problem('E-PIXI-ELIGIBILITY', where, '`pixiEligible` must be true exactly when the asset is a member of at least one bundle.'),
      );
    }
    if (entry.pixiEligible === true && entry.media === false) {
      problems.push(problem('E-NONMEDIA-IN-BUNDLE', where, 'A non-media file may not be Pixi-eligible.'));
    }

    for (const bundleName of declared) {
      const bundle = bundles[bundleName];
      if (!isRecord(bundle)) {
        problems.push(problem('E-BUNDLE-UNKNOWN', where, `The entry names a bundle the registry does not declare.`));
        continue;
      }
      const bundlePaths = isNonEmptyStringArray(bundle.paths) ? bundle.paths : [];
      const inside = isNonEmptyString(entry.path) && bundlePaths.some((prefix) => entry.path.startsWith(prefix));
      if (!inside) {
        problems.push(
          problem('E-BUNDLE-PATH', where, `Bundle membership requires the path to sit under one of the bundle's declared paths.`),
        );
      }
    }
  }

  // The direction that matters most: an unapproved asset that appears under an
  // approved bundle path fails whether or not it claimed membership. Registering an
  // unverified file inside the default Pixi bundle must not be possible by omission.
  for (const [bundleName, bundle] of Object.entries(bundles)) {
    if (!isRecord(bundle) || !isNonEmptyStringArray(bundle.paths)) continue;
    for (const entry of assets) {
      if (!isRecord(entry) || !isNonEmptyString(entry.path)) continue;
      if (!bundle.paths.some((prefix) => entry.path.startsWith(prefix))) continue;
      const where = entryLabel(entry);
      if (!BUNDLE_ADMISSIBLE_CLASSES.includes(entry.classification)) {
        problems.push(
          problem('E-UNVERIFIED-IN-BUNDLE', where, `This asset sits under a path approved for the \`${bundleName}\` bundle, but its class is not admissible there. Unverified media must not reach a default bundle.`),
        );
      }
      if (Array.isArray(entry.bundles) && !entry.bundles.includes(bundleName)) {
        problems.push(
          problem('E-BUNDLE-PATH', where, `This asset sits under the \`${bundleName}\` bundle path but does not declare membership, so the bundle and the tree disagree.`),
        );
      }
    }
  }

  return problems;
}

/**
 * The bundle ids `ASSET_BUNDLE_IDS` declares, or `null` when it declares none.
 *
 * Read as text rather than imported, because this script runs on Node built-ins alone
 * and a TypeScript module cannot be loaded from it. Comments come off first, for the
 * reason `validateSourceMedia` strips them: the manifest's own header explains the
 * bundle set in prose, and a prose mention of an id is not a declaration of one.
 *
 * The read **fails closed**. `null` means "the declaration could not be found", which
 * the caller reports as a problem, and never "there are no bundle ids" - a gate that
 * treated an unreadable declaration as an empty one would switch itself off the moment
 * the constant was renamed, which is the exact drift this cross-check exists to catch.
 */
function readManifestBundleIds(source) {
  const text = stripComments(source);
  const anchor = /export const ASSET_BUNDLE_IDS\b/.exec(text);
  if (anchor === null) return null;
  // The type annotation carries its own brackets (`readonly AssetBundleId[]`), so the
  // search for the list starts at the assignment, not at the identifier.
  const assigned = text.indexOf('=', anchor.index);
  if (assigned === -1) return null;
  const open = text.indexOf('[', assigned);
  const close = open === -1 ? -1 : text.indexOf(']', open);
  if (close === -1) return null;
  const ids = [...text.slice(open, close).matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return ids.length > 0 ? ids : null;
}

/**
 * The two bundle id sets, and every way they can disagree.
 *
 * Returns the number of ids actually compared so the summary can state that the
 * cross-check ran: a run that compared nothing has proved nothing, and a green log
 * that does not say so reads as coverage it does not have.
 */
async function validateBundleSet(registry, manifestPath, manifestRepoPath) {
  const declared = isRecord(registry.bundles) ? Object.keys(registry.bundles) : [];
  let source;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // A fixture tree has no source module. That is not a finding - the gate was not
      // asked to gate a manifest - but it is reported, because a silent skip is a hole
      // nobody can see.
      return { problems: [], compared: 0, manifestRepoPath };
    }
    throw error;
  }
  const manifestIds = readManifestBundleIds(source);
  if (manifestIds === null) {
    return {
      problems: [
        problem(
          'E-BUNDLE-DRIFT',
          safePath(manifestRepoPath),
          'The Pixi asset manifest does not declare `ASSET_BUNDLE_IDS` in a form this gate can read, so the registry and the manifest cannot be held to the same bundle set. The read fails closed on purpose.',
        ),
      ],
      compared: 0,
      manifestRepoPath,
    };
  }
  const problems = [];
  for (const id of manifestIds) {
    if (!declared.includes(id)) {
      problems.push(
        problem(
          'E-BUNDLE-DRIFT',
          safeId(id),
          'The Pixi asset manifest asks for this bundle, but the registry does not declare it, so no media could ever be a member of it. Declare the bundle before the manifest names it.',
        ),
      );
    }
  }
  for (const id of declared) {
    if (!manifestIds.includes(id)) {
      problems.push(
        problem(
          'E-BUNDLE-DRIFT',
          safeId(id),
          'The registry declares this bundle, but the Pixi asset manifest does not, so nothing in the application can load it. Either add the bundle to the manifest or drop the declaration.',
        ),
      );
    }
  }
  return { problems, compared: Math.max(manifestIds.length, declared.length), manifestRepoPath };
}

/** Counts drift detector: a stale count block is a stale registry. */
function validateCounts(registry, assets) {  const problems = [];
  if (!isRecord(registry.counts)) return problems;
  const actual = {};
  for (const entry of assets) {
    if (!isRecord(entry) || !CLASSIFICATIONS.includes(entry.classification)) continue;
    actual[entry.classification] = (actual[entry.classification] ?? 0) + 1;
  }
  for (const className of CLASSIFICATIONS) {
    const recorded = registry.counts[className];
    if (recorded !== undefined && recorded !== (actual[className] ?? 0)) {
      problems.push(
        problem('E-COUNTS', '<registry>', `The recorded count for \`${className}\` does not match the entries.`),
      );
    }
  }
  for (const [className, recorded] of Object.entries(registry.counts)) {
    if (!CLASSIFICATIONS.includes(className)) {
      problems.push(problem('E-COUNTS', '<registry>', `\`counts\` names a class the schema does not define.`));
    } else if (typeof recorded !== 'number') {
      problems.push(problem('E-COUNTS', '<registry>', 'Each count must be a number.'));
    }
  }
  return problems;
}

/**
 * Every file under the assets root must be registered, media and non-media alike.
 *
 * `discovered` holds assets-root-relative names; `sourceDiscovered` holds
 * repository-relative names under the source root, which is used here only to tell
 * whether a registered path is really on disk. The registry records
 * repository-relative paths (`public/assets/...`, `src/...`), which is the schema's
 * convention for how an asset is addressed in the application rather than a fact
 * about where a root happens to sit on disk, so the assets root is mapped through
 * its own name before the comparison and resolved against the root the same way.
 * What the source tree must have registered is decided by validateSourceMedia.
 */
function validateDiscovery(assets, discovered, sourceDiscovered, repoRoot) {
  const problems = [];
  const registered = new Set(
    assets.filter((entry) => isRecord(entry) && isNonEmptyString(entry.path)).map((entry) => entry.path),
  );
  const relativeToRepo = (rel) => path.posix.join(ASSETS_ROOT_REPO_PATH, rel);

  for (const rel of discovered) {
    if (registered.has(relativeToRepo(rel))) continue;
    const classification = extensionClass(rel);
    const isMedia = classification !== 'non-media';
    // An unclassified extension is named as such rather than called media, because
    // the honest statement is that the gate does not yet know what it is and is
    // refusing to guess in the direction that ships unprovenanced bytes.
    const described =
      classification !== 'unclassified'
        ? 'This media file'
        : extensionOf(rel)
          ? `A .${extensionOf(rel)} file whose extension is in neither the media set nor the declared non-media set, treated as media until it is classified`
          : 'A file with no extension, treated as media until one is declared';
    problems.push(
      problem(
        isMedia ? 'E-UNREGISTERED-MEDIA' : 'E-UNREGISTERED-FILE',
        safePath(relativeToRepo(rel)),
        isMedia
          ? `${described} is not in the registry. Add an entry with full provenance before it can ship. Run \`npm run test:licenses -- --write\` only after the entry exists, to fill its checksum.`
          : 'This file is not in the registry. Add an entry declaring whether it is media.',
      ),
    );
  }

  for (const entry of assets) {
    if (!isRecord(entry) || !isNonEmptyString(entry.path)) continue;
    if (!SAFE_PATH.test(entry.path) || entry.path.startsWith('/') || entry.path.includes('..')) continue;
    if (!isRegistrablePath(entry.path)) continue;
    const underAssetsRoot = entry.path.startsWith(`${ASSETS_ROOT_REPO_PATH}/`);
    const onDisk = underAssetsRoot
      ? discovered.includes(entry.path.slice(`${ASSETS_ROOT_REPO_PATH}/`.length))
      : sourceDiscovered.includes(entry.path);
    if (onDisk) continue;
    // A generated build output is legitimately absent on a fresh checkout: it is
    // gitignored and rebuilt by the build, and its entry says so.
    if (entry.checksumPolicy === 'regenerated') continue;
    if (!existsSync(path.join(repoRoot, entry.path))) {
      problems.push(problem('E-ASSET-MISSING', entryLabel(entry), 'The registered path does not exist on disk.'));
    }
  }
  return problems;
}

/**
 * The source-file kinds that can name a file, split by how they spell it.
 *
 * A stylesheet pulls media in through `url(...)` and a module pulls it in through a
 * specifier; leaving either out would leave a way to ship an unregistered image.
 */
const SOURCE_MODULE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte']);
const SOURCE_STYLESHEET_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'styl']);

/**
 * Specifier syntaxes, and nothing else.
 *
 * Every alternative here has the module-system keyword immediately before the
 * opening quote, so an ordinary string that happens to contain a file name - a log
 * line, a user-facing hint, a comment - is not mistaken for a reference. Comments
 * are removed first for the same reason. A computed specifier (`import(\`./${id}.png\`)`)
 * is deliberately out of scope: it cannot be resolved to one file, and the build
 * would fail loudly on a miss anyway, which is where that pattern belongs.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*(['"])([^'"]+)\1/g, // import x from '…' and export … from '…'
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // await import('…')
  /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // a CommonJS require call
  /\bimport\s*(['"])([^'"]+)\1/g, // import '…' side-effect form
  // A URL built against the module's own location, which Vite resolves at build time.
  /\bnew\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*\)/g,
];
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Strips comments, so a commented-out import is not read as a live reference. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Anchored so a `//` inside a string, as in an https URL, is not a comment.
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1 ');
}

function specifiersIn(source, isStylesheet) {
  const text = stripComments(source);
  const found = [];
  for (const pattern of isStylesheet ? [CSS_URL_PATTERN] : SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.push(match[2]);
  }
  return found;
}

/**
 * A specifier as a repository-relative path, or null when it is not one.
 *
 * Relative specifiers resolve against the referring file and `@/…` resolves through
 * the alias map; both land on a path an entry could carry. A bare specifier is a
 * package, and a root-absolute one is a published asset, so neither is source media
 * and neither is resolved here - the assets root is gated on its own.
 */
function resolveSourceSpecifier(moduleRepoPath, specifier) {
  const bare = specifier.split(/[?#]/, 1)[0];
  if (bare === '' || bare.startsWith('/')) return null;
  if (bare.startsWith('./') || bare.startsWith('../')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(moduleRepoPath), bare));
  }
  for (const [alias, target] of SOURCE_ALIASES) {
    if (bare === alias || bare.startsWith(`${alias}/`)) {
      return path.posix.join(target, bare.slice(alias.length));
    }
  }
  return null;
}

/**
 * A non-media file whose bytes open with a media signature.
 *
 * Read bounded, because the point is the first few bytes and a file that claims to
 * be a markdown page has no business being large.
 */
async function readHead(filePath, length) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function mediaSignatureIn(head) {
  for (const signature of MEDIA_SIGNATURES) {
    const expected = Buffer.from(signature.bytes, 'hex');
    if (head.length < signature.offset + expected.length) continue;
    if (head.subarray(signature.offset, signature.offset + expected.length).equals(expected)) {
      return signature.format;
    }
  }
  return null;
}

/**
 * The media format a file's leading bytes claim to be, or `null` for anything else.
 *
 * A file that cannot be read is `null` rather than a failure: unreadable is a build
 * problem, and "the gate could not look" is not the same verdict as "the gate looked and
 * found no media".
 */
async function mediaSignatureAt(filePath) {
  let head;
  try {
    head = await readHead(filePath, SIGNATURE_WINDOW);
  } catch {
    return null;
  }
  return mediaSignatureIn(head);
}

/**
 * The extension is a claim; the bytes are a fact. Where they disagree, this fails.
 *
 * Only `media: false` entries are read, because that is the direction the smuggling
 * runs: a real PNG committed as `notes.md` would otherwise sit in the registry as
 * honestly-declared non-media with a correct checksum and no license. Text media
 * (SVG, Lottie JSON) is not detectable this way and is not claimed to be.
 */
async function verifyMediaSignatures(assets, repoRoot) {
  const problems = [];
  for (const entry of assets) {
    if (!isRecord(entry) || entry.media !== false) continue;
    if (!isNonEmptyString(entry.path) || !SAFE_PATH.test(entry.path) || entry.path.includes('..')) continue;
    if (!isRegistrablePath(entry.path)) continue;
    let head;
    try {
      head = await readHead(path.join(repoRoot, entry.path), SIGNATURE_WINDOW);
    } catch {
      continue; // E-ASSET-MISSING reports a file that is not there.
    }
    const format = mediaSignatureIn(head);
    if (format) {
      problems.push(
        problem(
          'E-MEDIA-SIGNATURE',
          entryLabel(entry),
          `This entry declares \`media: false\`, but the file begins with a ${format} signature. An extension is not a licence: classify the file as media with its plan section 10.3 provenance, or replace it with a non-media file.`,
        ),
      );
    }
  }
  return problems;
}

/**
 * The source tree's media footprint: what the bundler can reach, and what it cannot.
 *
 * The assets root is not the only way media reaches `dist/`. Vite emits anything a
 * module imports, so a `.png` beside a component is copied into the bundle and
 * referenced from a JS chunk with no registry entry and no provenance - and the
 * check that walks `public/assets/` alone would never see it. So the gate requires
 * registration of everything the bundler can reach from the source root, by two
 * independent facts:
 *
 * 1. **a reference.** Every path a module under the source root names, through the
 *    relative and `@/`-aliased specifiers a module can use, has to be registered
 *    whether or not the file exists: a reference to a gitignored or currently dead
 *    path is exactly the one a future commit can make live. A *known media* extension
 *    and an *unlisted* extension both qualify, because the bundler resolves an
 *    `import './icon.svgz'` exactly as it resolves an `import './icon.png'`. Only a
 *    specifier with no suffix at all is a module, and only that is ignored.
 * 2. **a known media extension on disk**, whether or not a module names it, because a
 *    runtime-computed specifier - and a Vite glob over a directory - is still a shipped
 *    file, and the reference scan is a static read that cannot see either.
 *
 * ## What is deliberately *not* required, and why that is not a hole
 *
 * A file under the source root that **no module names** and whose **extension the
 * vocabulary does not know** cannot be bundled: Vite emits a source-root file only when
 * something in the module graph points at it, and this file has no known media
 * extension, so the on-disk presence rule cannot claim it. A blanket name-based
 * exemption - "ignore anything under `__probe__/` or any dot-prefixed name" - was the
 * shape of the alternative, and it is refused: it would exempt a real image that had
 * only been renamed, and it would make the guarantee a property of how a file is spelled
 * rather than of what it is.
 *
 * So the skip is a conclusion, not a concession, and it is reached from evidence:
 *
 * - The suffix is unclassified, so the gate makes no claim about it.
 * - No module names it, so the bundler cannot emit it.
 * - Its **bytes are read** and do not open with any known media container signature -
 *   the same check that stops a `media: false` entry from being a renamed picture. A
 *   real image behind an unlisted suffix is therefore not exempted; it fails.
 *
 * The count is returned so the summary can print it. A rule that skips things silently
 * is a rule nobody can audit, and a run that suddenly starts skipping a hundred files
 * should be a visible change rather than an invisible one.
 */
async function validateSourceMedia(assets, repoRoot) {
  const problems = [];
  const registered = new Set(
    assets.filter((entry) => isRecord(entry) && isNonEmptyString(entry.path)).map((entry) => entry.path),
  );
  const sourceDiscovered = await discoverFiles(path.join(repoRoot, SOURCE_ROOT), SOURCE_ROOT);

  // Referenced files, and which modules name them, so one problem per file names the
  // referrers rather than the same file once per import site.
  const referrers = new Map();

  for (const rel of sourceDiscovered) {
    const isStylesheet = SOURCE_STYLESHEET_EXTENSIONS.has(extensionOf(rel));
    if (!isStylesheet && !SOURCE_MODULE_EXTENSIONS.has(extensionOf(rel))) continue;
    let text;
    try {
      text = await readFile(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue; // Unreadable is not this gate's verdict; the build will say so.
    }
    for (const specifier of specifiersIn(text, isStylesheet)) {
      const target = resolveSourceSpecifier(rel, specifier);
      if (target === null) continue;
      const classification = extensionClass(target);
      if (classification === 'non-media') continue;
      // An extensionless specifier is a module - `@/ui/utils/topicParsing` - and this
      // scan has to tell that apart from an unlisted suffix without opening the target.
      if (classification === 'unclassified' && !hasUnlistedSuffix(target)) continue;
      if (!referrers.has(target)) referrers.set(target, new Set());
      referrers.get(target).add(rel);
    }
  }

  // `required` is everything the bundler can reach, whether by name or by extension,
  // with the modules that name it and the media format its bytes claimed, if any.
  const required = new Map();
  const demand = (target) => {
    if (!required.has(target)) required.set(target, { modules: new Set(), signature: null });
    return required.get(target);
  };
  const mediaOnDisk = [];
  const skipped = [];

  for (const rel of sourceDiscovered) {
    const classification = extensionClass(rel);
    if (classification === 'media') {
      mediaOnDisk.push(rel);
      demand(rel);
      continue;
    }
    if (classification === 'non-media') continue;
    if (referrers.has(rel)) continue; // A module names it: the reference rule owns it.
    // Unclassified, and nothing names it. The suffix is a claim nobody has checked, so
    // the bytes are the only evidence left; the extension is not allowed to be the
    // thing that decides it.
    const signature = await mediaSignatureAt(path.join(repoRoot, rel));
    if (signature === null) {
      skipped.push(rel);
      continue;
    }
    demand(rel).signature = signature;
  }

  for (const [target, modules] of referrers) {
    for (const modulePath of modules) demand(target).modules.add(modulePath);
  }

  for (const [target, { modules, signature }] of [...required.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!isRegistrablePath(target) || target.startsWith('..') || path.posix.isAbsolute(target)) {
      problems.push(
        problem(
          'E-SOURCE-MEDIA-PATH',
          safePath(target),
          `A module under ${SOURCE_ROOT}/ names this file, but it resolves outside ${REGISTRABLE_ROOTS.map((root) => `${root}/`).join(' and ')}, so no registry entry can cover it and it is not published. Move it under one of those roots, or load it from ${ASSETS_ROOT_REPO_PATH}/ by path.`,
        ),
      );
      continue;
    }
    if (registered.has(target)) continue;
    const named = [...modules].sort();
    const namedBy =
      named.length === 0
        ? 'No module names it, so it is reachable only by a computed path or a build-time glob.'
        : `Named by ${named.map((modulePath) => safePath(modulePath)).join(', ')}.`;
    const evidence = signature
      ? `Its bytes open with a ${signature} signature, so it is media whatever the suffix says. `
      : '';
    // An unclassified extension cannot be registered yet, so "add an entry" would be
    // advice the author cannot follow. The first step is the vocabulary. A name with no
    // extension at all gets its own wording, because "its . extension" is not a sentence
    // an author can act on - and this state is reachable here, because a file that is
    // media by its bytes gets required whatever its name looks like.
    const remedy =
      extensionClass(target) !== 'unclassified'
        ? `Media under ${SOURCE_ROOT}/ is bundled into the build output, so it ships with no provenance unless it is registered. Add an entry with \`media: true\` and the full plan section 10.3 field set, or move the file under ${ASSETS_ROOT_REPO_PATH}/.`
        : extensionOf(target) === ''
          ? 'It has no file extension at all, so no registry entry can describe it. If the format is one the gate already knows, rename the file to carry its real extension; if it is new, add it to MEDIA_EXTENSIONS or NON_MEDIA_EXTENSIONS in scripts/check-cc0-assets.mjs, deliberately, and then register it.'
          : `Its .${extensionOf(target)} extension is in neither the media set nor the declared non-media set, so no entry can describe it yet: classify the extension in scripts/check-cc0-assets.mjs, then register the file.`;
    problems.push(problem('E-UNREGISTERED-SOURCE-MEDIA', safePath(target), `${namedBy} ${evidence}${remedy}`));
  }

  return {
    problems,
    mediaCount: mediaOnDisk.length,
    referenceCount: referrers.size,
    skippedCount: skipped.length,
  };
}

/**
 * Checksums, recomputed from disk.
 *
 * Returns the problems and, in `--write` mode, the digests it would record. The
 * recomputation is the whole point: a registry whose checksums are never re-derived
 * is a list of claims.
 */
async function verifyChecksums(assets, repoRoot) {
  const problems = [];
  const computed = new Map();
  for (const entry of assets) {
    if (!isRecord(entry) || !isNonEmptyString(entry.path)) continue;
    if (entry.checksumPolicy === 'self-referential') continue;
    if (!SAFE_PATH.test(entry.path) || entry.path.includes('..')) continue;
    const policy = entry.checksumPolicy ?? 'pinned';
    if (policy === 'regenerated') continue;
    let buffer;
    try {
      buffer = await readFile(path.join(repoRoot, entry.path));
    } catch {
      continue; // E-ASSET-MISSING already reports it.
    }
    const digest = checksumOf(buffer);
    computed.set(entry.id, digest);
    if (!isNonEmptyString(entry.sha256)) continue; // E-CHECKSUM-FORMAT reports it.
    if (entry.sha256 !== digest) {
      problems.push(
        problem(
          'E-CHECKSUM-MISMATCH',
          entryLabel(entry),
          'The recorded sha256 does not match the bytes on disk. If the file was edited on purpose, run `npm run test:licenses -- --write` and record the edit in `modifications`.',
        ),
      );
    }
  }
  return { problems, computed };
}

/** A generated index that has drifted from the tree it indexes is a stale build input. */
async function verifySemanticChecks(assets, discovered, repoRoot) {
  const problems = [];
  for (const entry of assets) {
    if (!isRecord(entry) || !isRecord(entry.generation)) continue;
    if (entry.generation.semanticCheck !== 'sprite-manifest-sync') continue;
    if (!isNonEmptyString(entry.path)) continue;
    if (!SAFE_PATH.test(entry.path) || entry.path.includes('..')) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(repoRoot, entry.path), 'utf8'));
    } catch {
      continue; // Absent on a fresh checkout, or unparseable: reported elsewhere, or nothing to compare.
    }
    const listed = Array.isArray(manifest?.sprites)
      ? manifest.sprites.map((sprite) => sprite?.path).filter((value) => isNonEmptyString(value))
      : null;
    if (listed === null) {
      problems.push(problem('E-SEMANTIC-DRIFT', entryLabel(entry), 'The generated index has no `sprites` array to compare against the tree.'));
      continue;
    }
    const onDisk = discovered.filter((rel) => rel.endsWith('.svg')).sort();
    const inManifest = [...listed].sort();
    if (JSON.stringify(onDisk) !== JSON.stringify(inManifest)) {
      problems.push(
        problem('E-SEMANTIC-DRIFT', entryLabel(entry), 'The generated index does not list exactly the SVGs discovered under the assets root. Regenerate it.'),
      );
    }
  }
  return problems;
}

/** A procedural entry that embeds a marker must have it in the generated bytes. */
async function verifyGenerationMarkers(assets, repoRoot) {
  const problems = [];
  for (const entry of assets) {
    if (!isRecord(entry) || !isRecord(entry.generation)) continue;
    if (entry.generation.embedMarker !== true) continue;
    if (!isNonEmptyString(entry.path) || !SAFE_PATH.test(entry.path) || entry.path.includes('..')) continue;
    if (!isNonEmptyString(entry.generation.recipe)) continue;
    let text;
    try {
      text = await readFile(path.join(repoRoot, entry.path), 'utf8');
    } catch {
      continue;
    }
    const head = text.slice(0, 2000);
    if (!head.includes(`id: ${entry.id}`)) {
      problems.push(
        problem('E-GENERATION-MARKER', entryLabel(entry), 'The generated file does not carry its own asset id in its leading comment.'),
      );
    }
    if (!head.includes(`recipe: ${entry.generation.recipe}`)) {
      problems.push(
        problem('E-GENERATION-MARKER', entryLabel(entry), 'The generated file does not carry the recorded recipe in its leading comment.'),
      );
    }
  }
  return problems;
}

/**
 * CREDITS.md must cover every registered path, and must not name a media path the
 * registry does not contain, so the human-readable credits cannot drift from the
 * machine-readable record in either direction.
 *
 * Both roots are scanned, because a media file bundled from the source tree is
 * still media a reader is entitled to be credited for. The reverse direction is
 * restricted to media-shaped mentions on purpose: CREDITS.md is a media credits
 * page that also points at the repository's own source files in prose, and a
 * backticked source path in it is documentation, not an asset claim.
 */
function validateCredits(assets, creditsText) {
  const problems = [];
  const rootPattern = REGISTRABLE_ROOTS.map((root) => root.replace('/', '\\/')).join('|');
  const claims = [
    ...creditsText.matchAll(new RegExp(`\`((?:${rootPattern})\\/[^\`\\s]+)\``, 'g')),
  ].map((match) => match[1]);
  const mentioned = new Set(claims);
  const registered = new Set(
    assets.filter((entry) => isRecord(entry) && isNonEmptyString(entry.path)).map((entry) => entry.path),
  );
  for (const assetPath of registered) {
    if (!mentioned.has(assetPath)) {
      problems.push(
        problem('E-CREDITS-COVERAGE', safePath(assetPath), 'This registered path is not named in CREDITS.md.'),
      );
    }
  }
  for (const assetPath of claims) {
    if (registered.has(assetPath)) continue;
    if (extensionClass(assetPath) === 'non-media') continue;
    problems.push(
      problem('E-CREDITS-UNKNOWN-PATH', safePath(assetPath), 'CREDITS.md names a media path the registry does not contain.'),
    );
  }
  return problems;
}

function readArg(name, argv) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function printReport(problems, summary, writeMode) {
  const byCode = new Map();
  for (const item of problems) {
    if (!byCode.has(item.code)) byCode.set(item.code, []);
    byCode.get(item.code).push(item);
  }
  for (const [code, items] of byCode) {
    console.error(`\n${code} — ${CODES[code] ?? ''}`);
    for (const item of items) {
      console.error(`  ${item.where}`);
      console.error(`      ${item.detail}`);
    }
  }
  const total = problems.length;
  console.error('');
  if (total === 0) {
    console.error(`Asset license gate PASSED. ${summary}`);
    return;
  }
  console.error(`Asset license gate FAILED with ${total} problem(s)${writeMode ? ' after --write' : ''}.`);
  console.error('New media cannot ship without registry metadata, and unverified media cannot reach a default bundle.');
}

function summarize(registry, assets, checksumCount, source, bundleSet) {
  const counts = {};
  for (const entry of assets) {
    if (!isRecord(entry)) continue;
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  }
  const bundleNames = isRecord(registry.bundles) ? Object.keys(registry.bundles) : [];
  const bundleSizes = bundleNames
    .map((name) => `${name}=${assets.filter((entry) => Array.isArray(entry.bundles) && entry.bundles.includes(name)).length}`)
    .join(' ');
  const classes = CLASSIFICATIONS.filter((name) => counts[name]).map((name) => `${name}=${counts[name]}`).join(' ');
  // The source-tree figures are in the summary on purpose: a green log that says how
  // much of the media the bundler can reach from source it actually looked at is the
  // difference between "the gate passed" and "the gate had nothing to look at". The
  // skipped count is here for the same reason and with more force: it is the number of
  // files the rule chose *not* to require, so a skip is on the record rather than a hole
  // nobody can see. It reads as absent when it is zero, because "0 skipped" every run
  // trains a reader to stop reading the number.
  const sourceMedia = `${source.mediaCount} media file(s) and ${source.referenceCount} media reference(s) under ${SOURCE_ROOT}/`;
  const skippedNote =
    source.skippedCount > 0
      ? `, skipping ${source.skippedCount} unclassified file(s) there that no module names, which the bundler cannot emit and whose bytes are not a media container`
      : '';
  // The cross-check is reported whether it ran or not, for the reason the skip count is
  // reported: a green run that silently compared nothing reads as a guarantee.
  const bundleNote =
    bundleSet.compared > 0
      ? `Bundle ids cross-checked against ${bundleSet.manifestRepoPath}: ${bundleSet.compared} agree.`
      : `Bundle ids were not cross-checked: ${bundleSet.manifestRepoPath} is not present in this tree.`;
  return `${assets.length} registered entries (${classes}); ${checksumCount} checksums recomputed; bundles: ${bundleSizes || 'none'}; ${sourceMedia}${skippedNote}. ${bundleNote}`;
}

const USAGE = [
  'Usage: node scripts/check-cc0-assets.mjs [options]',
  '',
  '  (no options)          Gate the registry against the assets tree and the source tree.',
  '                        Exits 1 on any problem.',
  '  --write               Recompute every pinned SHA-256 into the registry, refresh the count',
  '                        block, and re-gate. Never changes a classification, a license, or a',
  '                        bundle membership.',
  '  --assets-root=DIR     Assets tree to gate. Default: public/assets.',
  '  --registry=FILE       Registry to read and write. Default: <assets-root>/asset-licenses.json.',
  '  --credits=FILE        Credits page to cross-check. Default: <assets-root>/CREDITS.md.',
  '  --manifest=FILE       Pixi asset manifest whose ASSET_BUNDLE_IDS must match the registry',
  '                        bundle set exactly. Default: src/renderers/pixi/assets/assetManifest.ts',
  '                        relative to the repository root. A tree with no such file is reported',
  '                        in the summary as not cross-checked; a file that declares no readable',
  '                        ASSET_BUNDLE_IDS is a failure.',
  '  -h, --help            Print this help.',
  '',
  'Media under src/ is covered too: a media file there, or one a module under src/ names',
  'through a relative or @/-aliased import, must be in the registry with `media: true`.',
  'A reference to a path whose extension the gate has not classified is covered by the same',
  'rule, because the bundler emits it; a file under src/ that no module names and whose',
  'extension is unknown is skipped only if its bytes are not a media container, and the',
  'count of those is printed in the summary so a skip is never invisible.',
].join('\n');

async function main() {
  const argv = process.argv.slice(2);
  const writeMode = argv.includes('--write');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknownFlag = argv.find(
    (arg) =>
      arg.startsWith('--') && !['--write'].includes(arg) && !/^--(assets-root|registry|credits|manifest)=/.test(arg),
  );
  if (unknownFlag) {
    console.error(`Unknown flag: ${unknownFlag}`);
    console.error(USAGE);
    process.exit(2);
  }

  // Registered paths and generating scripts are recorded repository-relative
  // (`public/assets/...`, `scripts/...`), so they are resolved against the
  // repository root, which is the grandparent of the assets root. Deriving it from
  // `--assets-root` rather than from this file's own location is what lets the test
  // suite run the real checker against a fixture tree, which is how the negative
  // cases below are real CLI runs rather than a reimplementation of the rules.
  const assetsRoot = path.resolve(REPO_ROOT, readArg('assets-root', argv) ?? path.relative(REPO_ROOT, DEFAULT_ASSETS_ROOT));
  const pathRoot = path.resolve(assetsRoot, '..', '..');
  const repoRoot = pathRoot;
  const registryPath = path.resolve(REPO_ROOT, readArg('registry', argv) ?? path.relative(REPO_ROOT, DEFAULT_REGISTRY));
  const creditsPath = path.resolve(REPO_ROOT, readArg('credits', argv) ?? path.relative(REPO_ROOT, DEFAULT_CREDITS));
  // Resolved against the same root as the registry rather than this script's own
  // location, so a fixture tree reads its own (absent) module instead of the real one.
  const manifestPath = path.resolve(repoRoot, readArg('manifest', argv) ?? MANIFEST_MODULE_REPO_PATH);
  const manifestRepoPath = readArg('manifest', argv) ?? MANIFEST_MODULE_REPO_PATH;

  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch (error) {
    console.error('E-REGISTRY-UNREADABLE — ' + CODES['E-REGISTRY-UNREADABLE']);
    console.error(`  ${safePath(path.relative(repoRoot, registryPath))}`);
    console.error(`      ${error && error.code === 'ENOENT' ? 'The registry does not exist.' : 'The registry is not valid JSON.'}`);
    process.exit(1);
  }

  const assets = Array.isArray(registry.assets) ? registry.assets : [];
  const discovered = await discoverFiles(assetsRoot);
  const sourceDiscovered = await discoverFiles(path.join(repoRoot, SOURCE_ROOT), SOURCE_ROOT);
  const problems = [];

  problems.push(...validateRegistryShape(registry));
  for (const [index, entry] of assets.entries()) {
    problems.push(...validateEntryShape(entry, index));
    if (isRecord(entry)) problems.push(...validateProvenance(entry, repoRoot));
  }
  problems.push(...validateRelationships(registry, assets));
  const bundleSet = await validateBundleSet(registry, manifestPath, manifestRepoPath);
  problems.push(...bundleSet.problems);
  problems.push(...validateCounts(registry, assets));
  problems.push(...validateDiscovery(assets, discovered, sourceDiscovered, repoRoot));
  const sourceMedia = await validateSourceMedia(assets, repoRoot);
  problems.push(...sourceMedia.problems);
  problems.push(...(await verifyMediaSignatures(assets, repoRoot)));
  problems.push(...(await verifyGenerationMarkers(assets, repoRoot)));

  const { problems: checksumProblems, computed } = await verifyChecksums(assets, repoRoot);
  if (writeMode) {
    // Bootstrap and maintenance: record what is on disk. This cannot change a
    // classification, a bundle, or a license, so it cannot launder anything.
    for (const entry of assets) {
      if (!isRecord(entry)) continue;
      if ((entry.checksumPolicy ?? 'pinned') !== 'pinned') continue;
      const digest = computed.get(entry.id);
      if (digest && entry.sha256 !== digest) entry.sha256 = digest;
    }
    const counts = {};
    for (const entry of assets) {
      if (!isRecord(entry) || !CLASSIFICATIONS.includes(entry.classification)) continue;
      counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
    }
    registry.counts = counts;
    registry.assets = [...assets].sort((a, b) =>
      isNonEmptyString(a?.path) && isNonEmptyString(b?.path) ? (a.path < b.path ? -1 : 1) : 0,
    );
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    const written = [...computed.keys()].length;
    console.log(`--write recorded ${written} checksum(s) and refreshed the count block in ${safePath(path.relative(repoRoot, registryPath))}.`);
  } else {
    problems.push(...checksumProblems);
  }

  problems.push(...(await verifySemanticChecks(assets, discovered, repoRoot)));

  let creditsText = null;
  try {
    creditsText = await readFile(creditsPath, 'utf8');
  } catch {
    problems.push(
      problem('E-CREDITS-MISSING', safePath(path.relative(repoRoot, creditsPath)), 'The credits file is missing or unreadable.'),
    );
  }
  if (creditsText !== null) problems.push(...validateCredits(assets, creditsText));

  const summary = summarize(registry, assets, computed.size, sourceMedia, bundleSet);
  // In --write mode the two checksum-shape problems are the ones the tool just fixed,
  // so reporting them would make a successful bootstrap look like a failure. Nothing
  // else is suppressed: a missing field, an unapproved bundle, or an unregistered file
  // still fails the run that records the checksums.
  const reported = writeMode ? problems.filter((item) => item.kind !== 'checksum-shape') : problems;
  printReport(reported, summary, writeMode);
  process.exit(reported.length === 0 ? 0 : 1);
}

await main();
