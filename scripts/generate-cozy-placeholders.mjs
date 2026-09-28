#!/usr/bin/env node
/**
 * Generates the Phase 8 procedural Cozy placeholder set for Pixi development.
 *
 * Why this exists
 * ---------------
 * Plan section 10.3 admits only CC0-approved or procedural media to the default
 * PixiJS bundle, and the repository currently holds no asset with verifiable CC0
 * provenance. The legacy sprite set is `legacy-unverified` and therefore cannot
 * be used, so a procedurally generated set is the only honest way to give Phase
 * 9 and Phase 10 something to develop against. Phase 10 replaces these with the
 * real bundle sets; until then this is placeholder art, not final art.
 *
 * Why there is no randomness and no clock
 * ---------------------------------------
 * Every file this writes carries a SHA-256 in `public/assets/asset-licenses.json`
 * and `npm run test:licenses` recomputes it. A generator that embedded a
 * timestamp, or that used an unseeded PRNG, would make that checksum a coin flip
 * and the gate worthless. So: a seeded LCG, a fixed recipe per file, byte-stable
 * formatting, and no `Date` anywhere. Running this twice produces identical bytes,
 * which is what makes `procedural` a verifiable claim instead of a label.
 *
 * Why the palette is read from the registry
 * -----------------------------------------
 * The registry's `paletteFamilies` block is the only place this script keeps colour
 * values, so the placeholders cannot drift from the declared families. It is not the
 * source of truth, though: `src/theme/cozyTokens.ts` is, and every name and value in
 * that block is a verbatim copy of a `COZY_COLOR_FAMILIES` entry from it, for the
 * tokens this generator actually reads. So the art is painted from the shipped Cozy
 * palette rather than from a provisional guess beside it, and
 * `tests/phase8/cozy-palette-alignment.test.ts` fails if that copy ever stops being
 * exact. These remain placeholder *art* colours: they are not emitted as CSS custom
 * properties and are not a second token declaration. A test asserts every family
 * named in the registry is used by at least one file here, and `REQUIRED_PALETTE_TOKENS`
 * below asserts the reverse - every token read here is named in the registry.
 *
 * Usage:
 *   node scripts/generate-cozy-placeholders.mjs              # write the set
 *   node scripts/generate-cozy-placeholders.mjs --check      # fail on any drift
 *   node scripts/generate-cozy-placeholders.mjs --describe   # print the specs
 *   node scripts/generate-cozy-placeholders.mjs --out=DIR    # write elsewhere
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'public', 'assets', 'asset-licenses.json');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'public', 'assets', 'cozy');

/**
 * The placeholders this script is allowed to produce.
 *
 * `id` is the registry asset id, `families` are the palette families the file
 * exercises, and `seed` feeds the LCG. Everything here is a specification, not a
 * description: the registry repeats it, the marker comment inside each generated
 * file repeats it again, and the tests check that all three agree.
 */
export const PLACEHOLDERS = [
  { file: 'cozy-parchment-floor.svg', id: 'cozy-placeholder-parchment-floor', size: 64, seed: 101, families: ['parchment'], role: 'Ground tile placeholder for the village and dungeon floors.' },
  { file: 'cozy-moss-grass.svg', id: 'cozy-placeholder-moss-grass', size: 64, seed: 202, families: ['moss'], role: 'Ground tile placeholder for mossy outdoor surfaces.' },
  { file: 'cozy-berry-bush.svg', id: 'cozy-placeholder-berry-bush', width: 32, height: 32, seed: 303, families: ['moss', 'berry', 'ink'], role: 'Prop placeholder: a berry bush sprite.' },
  { file: 'cozy-firelight-torch.svg', id: 'cozy-placeholder-firelight-torch', width: 32, height: 48, seed: 404, families: ['firelight', 'ink'], role: 'Prop placeholder: a lit torch, the only firelight source in the set.' },
  { file: 'cozy-ink-panel.svg', id: 'cozy-placeholder-ink-panel', width: 96, height: 72, seed: 505, families: ['parchment', 'ink', 'moss', 'berry'], role: 'Panel placeholder: a rounded storybook panel with an ink rule and a corner sprig.' },
  { file: 'cozy-ink-signpost.svg', id: 'cozy-placeholder-ink-signpost', width: 48, height: 64, seed: 606, families: ['parchment', 'ink', 'moss'], role: 'Prop placeholder: a village signpost, for in-world wayfinding.' },
];

/** A 32-bit linear congruential generator. Deterministic, seeded, and self-contained. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Every `family.token` the renderers below actually read.
 *
 * This list exists because a JavaScript template literal does not fail on a missing
 * property: drop or rename a palette key and `p.ink.deep` quietly interpolates the
 * string `undefined` into the SVG. The bytes would still be deterministic, so the
 * recorded checksum would still match and every reproducibility test would still
 * pass - over art with a broken fill. Naming the contract here turns that into a
 * startup error instead of a silent, checksum-clean defect.
 *
 * The names are the `COZY_COLOR_FAMILIES` names in `src/theme/cozyTokens.ts`, which
 * is why `parchment.line` is used rather than a local `edge`, and `ink.deep` rather
 * than a local `base`: the registry mirrors the token module, so the generator can
 * be compared against it key for key.
 */
const REQUIRED_PALETTE_TOKENS = [
  'parchment.base',
  'parchment.shade',
  'parchment.deep',
  'parchment.line',
  'moss.base',
  'moss.deep',
  'moss.light',
  'berry.base',
  'berry.deep',
  'berry.light',
  'ink.deep',
  'ink.soft',
  'firelight.ember',
  'firelight.glow',
];

/** Rounds to two decimals so the emitted bytes do not depend on float formatting. */
const n2 = (value) => (Math.round(value * 100) / 100).toString();

function readArg(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function loadPalette() {
  const raw = await readFile(REGISTRY_PATH, 'utf8');
  const registry = JSON.parse(raw);
  const families = registry?.paletteFamilies;
  if (!families || typeof families !== 'object') {
    throw new Error(
      'The registry has no `paletteFamilies` block. This script reads the provisional Cozy palette from public/assets/asset-licenses.json rather than duplicating it, so there is exactly one source of truth.',
    );
  }
  for (const [family, tokens] of Object.entries(families)) {
    for (const [token, hex] of Object.entries(tokens)) {
      if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/.test(hex)) {
        throw new Error(`Palette family \`${family}.${token}\` is not a lowercase #rrggbb value.`);
      }
    }
  }
  const missing = REQUIRED_PALETTE_TOKENS.filter((key) => {
    const [family, token] = key.split('.');
    return typeof families[family]?.[token] !== 'string';
  });
  if (missing.length > 0) {
    throw new Error(
      `The registry's paletteFamilies block is missing ${missing.join(', ')}. ` +
        'The generator reads these tokens, and a missing one would be interpolated into the SVG as the literal string "undefined" - deterministic bytes, a matching checksum, and broken art. See REQUIRED_PALETTE_TOKENS.',
    );
  }
  return families;
}

function dims(spec) {
  return { width: spec.width ?? spec.size, height: spec.height ?? spec.size };
}

/**
 * The marker comment every generated file opens with.
 *
 * It is not decoration: `scripts/check-cc0-assets.mjs` requires a `procedural`
 * entry that declares `generation.embedMarker` to contain its own id and recipe in
 * the bytes on disk, so a registry entry cannot claim a recipe the file does not
 * carry.
 */
function marker(spec, families) {
  const { width, height } = dims(spec);
  return [
    '<!-- Knowledge Dungeon Cozy placeholder. Procedural: generated by a committed script, no third-party media. -->',
    `<!-- id: ${spec.id} -->`,
    `<!-- recipe: size ${width}x${height} | seed ${spec.seed} | families ${spec.families.join(', ')} -->`,
    '<!-- placeholder art for Pixi development, not final art. No SMIL and no CSS animation, so it is inert under prefers-reduced-motion. -->',
    '<!-- Regenerate: node scripts/generate-cozy-placeholders.mjs -->',
    `<!-- palette: ${Object.keys(families).join(', ')} (provisional values from public/assets/asset-licenses.json) -->`,
  ].join('\n');
}

function wrap(spec, families, body) {
  const { width, height } = dims(spec);
  return [
    marker(spec, families),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

/** A deterministic scatter of tone dots, used to keep a flat surface from reading as flat. */
function speckles(rand, count, size, colors, radiusMin, radiusMax) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const cx = n2(rand() * size);
    const cy = n2(rand() * size);
    const r = n2(radiusMin + rand() * (radiusMax - radiusMin));
    out.push(`    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${colors[index % colors.length]}"/>`);
  }
  return out;
}

function renderParchmentFloor(spec, p) {
  const { width, height } = dims(spec);
  const rand = lcg(spec.seed);
  return wrap(spec, p, [
    `  <rect width="${width}" height="${height}" fill="${p.parchment.base}"/>`,
    '  <g>',
    ...speckles(rand, 18, width, [p.parchment.shade, p.parchment.deep, p.parchment.shade], 1, 2.4),
    '  </g>',
    `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="${p.parchment.line}" stroke-width="1" opacity="0.5"/>`,
  ]);
}

function renderMossGrass(spec, p) {
  const { width, height } = dims(spec);
  const rand = lcg(spec.seed);
  const blades = [];
  for (let index = 0; index < 14; index += 1) {
    const x = n2(rand() * width);
    const y = n2(height - 2 - rand() * (height / 2));
    const lean = n2((rand() - 0.5) * 6);
    const tone = index % 2 === 0 ? p.moss.light : p.moss.deep;
    blades.push(`    <path d="M ${x} ${y} q ${lean} -3 ${n2(lean * 0.6)} -6" stroke="${tone}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`);
  }
  return wrap(spec, p, [
    `  <rect width="${width}" height="${height}" fill="${p.moss.base}"/>`,
    '  <g>',
    ...speckles(rand, 12, width, [p.moss.deep, p.moss.light], 1, 2),
    '  </g>',
    `  <g stroke-linecap="round">`,
    ...blades,
    '  </g>',
  ]);
}

function renderBerryBush(spec, p) {
  const { width, height } = dims(spec);
  const rand = lcg(spec.seed);
  return wrap(spec, p, [
    `  <ellipse cx="${width / 2}" cy="${n2(height * 0.66)}" rx="${n2(width * 0.42)}" ry="${n2(height * 0.3)}" fill="${p.moss.base}"/>`,
    `  <ellipse cx="${n2(width * 0.36)}" cy="${n2(height * 0.5)}" rx="${n2(width * 0.26)}" ry="${n2(height * 0.24)}" fill="${p.moss.light}"/>`,
    `  <ellipse cx="${n2(width * 0.64)}" cy="${n2(height * 0.52)}" rx="${n2(width * 0.24)}" ry="${n2(height * 0.22)}" fill="${p.moss.deep}"/>`,
    '  <g>',
    `    <circle cx="${n2(width * 0.44)}" cy="${n2(height * 0.56)}" r="2.2" fill="${p.berry.base}"/>`,
    `    <circle cx="${n2(width * 0.62)}" cy="${n2(height * 0.66)}" r="2" fill="${p.berry.deep}"/>`,
    `    <circle cx="${n2(width * 0.54)}" cy="${n2(height * 0.42)}" r="1.8" fill="${p.berry.light}"/>`,
    '  </g>',
    `  <ellipse cx="${width / 2}" cy="${n2(height * 0.66)}" rx="${n2(width * 0.42)}" ry="${n2(height * 0.3)}" fill="none" stroke="${p.ink.deep}" stroke-width="1.2"/>`,
  ]);
}

function renderFirelightTorch(spec, p) {
  const { width, height } = dims(spec);
  const rand = lcg(spec.seed);
  const postX = n2(width * 0.5);
  const flameTop = n2(height * 0.18);
  const embers = [];
  for (let index = 0; index < 5; index += 1) {
    const cx = n2(rand() * width);
    const cy = n2(height * (0.2 + rand() * 0.3));
    const r = n2(0.8 + rand() * 0.6);
    embers.push(`    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${index % 2 === 0 ? p.firelight.glow : p.firelight.ember}"/>`);
  }
  return wrap(spec, p, [
    `  <rect x="${n2(postX - 2)}" y="${n2(height * 0.52)}" width="4" height="${n2(height * 0.44)}" fill="${p.ink.soft}" rx="1.5"/>`,
    `  <rect x="${n2(postX - 2)}" y="${n2(height * 0.52)}" width="4" height="${n2(height * 0.44)}" fill="none" stroke="${p.ink.deep}" stroke-width="1"/>`,
    `  <path d="M ${postX} ${flameTop} q ${n2(width * 0.22)} ${n2(height * 0.16)} 0 ${n2(height * 0.3)} q ${n2(-width * 0.22)} ${n2(-height * 0.14)} 0 ${n2(-height * 0.3)} z" fill="${p.firelight.ember}"/>`,
    `  <path d="M ${postX} ${n2(height * 0.28)} q ${n2(width * 0.13)} ${n2(height * 0.09)} 0 ${n2(height * 0.2)} q ${n2(-width * 0.13)} ${n2(-height * 0.1)} 0 ${n2(-height * 0.2)} z" fill="${p.firelight.glow}"/>`,
    '  <g opacity="0.55">',
    ...embers,
    '  </g>',
  ]);
}

function renderInkPanel(spec, p) {
  const { width, height } = dims(spec);
  const inset = 6;
  return wrap(spec, p, [
    `  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="10" fill="${p.parchment.base}" stroke="${p.ink.deep}" stroke-width="2"/>`,
    `  <rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" rx="7" fill="none" stroke="${p.parchment.line}" stroke-width="1"/>`,
    `  <circle cx="${n2(width * 0.16)}" cy="${n2(height * 0.2)}" r="3" fill="${p.berry.base}"/>`,
    `  <circle cx="${n2(width * 0.16)}" cy="${n2(height * 0.2)}" r="1.2" fill="${p.parchment.base}"/>`,
    `  <path d="M ${n2(width - 16)} ${n2(height - 12)} q 4 -5 8 -2 q 4 3 2 7" stroke="${p.moss.deep}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
    `  <circle cx="${n2(width - 15)}" cy="${n2(height - 14)}" r="2.4" fill="${p.moss.base}"/>`,
  ]);
}

function renderInkSignpost(spec, p) {
  const { width, height } = dims(spec);
  const postX = n2(width * 0.5);
  return wrap(spec, p, [
    `  <rect x="${n2(postX - 2.5)}" y="${n2(height * 0.36)}" width="5" height="${n2(height * 0.6)}" fill="${p.moss.deep}" rx="2"/>`,
    `  <rect x="${n2(postX - 2.5)}" y="${n2(height * 0.36)}" width="5" height="${n2(height * 0.6)}" fill="none" stroke="${p.ink.deep}" stroke-width="1.2"/>`,
    `  <path d="M 6 ${n2(height * 0.14)} L ${n2(width - 6)} ${n2(height * 0.14)} L ${n2(width - 6)} ${n2(height * 0.36)} L 6 ${n2(height * 0.36)} z" fill="${p.parchment.base}" stroke="${p.ink.deep}" stroke-width="2" stroke-linejoin="round"/>`,
    `  <path d="M 10 ${n2(height * 0.21)} L ${n2(width - 12)} ${n2(height * 0.21)}" stroke="${p.ink.soft}" stroke-width="1.6" stroke-linecap="round"/>`,
    `  <path d="M 10 ${n2(height * 0.28)} L ${n2(width - 20)} ${n2(height * 0.28)}" stroke="${p.ink.soft}" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>`,
    `  <circle cx="${postX}" cy="${n2(height * 0.08)}" r="3" fill="${p.moss.base}" stroke="${p.ink.deep}" stroke-width="1"/>`,
  ]);
}

const RENDERERS = {
  'cozy-parchment-floor.svg': renderParchmentFloor,
  'cozy-moss-grass.svg': renderMossGrass,
  'cozy-berry-bush.svg': renderBerryBush,
  'cozy-firelight-torch.svg': renderFirelightTorch,
  'cozy-ink-panel.svg': renderInkPanel,
  'cozy-ink-signpost.svg': renderInkSignpost,
};

/** Renders one placeholder to bytes. Pure: same spec and palette in, same bytes out. */
export function renderPlaceholder(spec, families) {
  const render = RENDERERS[spec.file];
  if (!render) throw new Error(`No renderer for \`${spec.file}\`.`);
  return render(spec, families);
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const describe = argv.includes('--describe');
  const families = await loadPalette();

  // `--describe` exists so a test can cross-check the registry against what this
  // script actually produces, over the same channel CI uses, without importing an
  // untyped `.mjs` module from TypeScript.
  if (describe) {
    process.stdout.write(
      `${JSON.stringify(
        PLACEHOLDERS.map((spec) => ({
          id: spec.id,
          file: spec.file,
          ...dims(spec),
          seed: spec.seed,
          families: spec.families,
          role: spec.role,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  const outDir = path.resolve(REPO_ROOT, readArg('out') ?? path.relative(REPO_ROOT, DEFAULT_OUT_DIR));

  if (!check) await mkdir(outDir, { recursive: true });

  const drifted = [];
  for (const spec of PLACEHOLDERS) {
    const svg = renderPlaceholder(spec, families);
    const target = path.join(outDir, spec.file);
    if (check) {
      const current = await readFile(target, 'utf8').catch(() => null);
      if (current === null) {
        drifted.push(`${spec.file} (missing)`);
      } else if (current !== svg) {
        drifted.push(`${spec.file} (content differs)`);
      }
      continue;
    }
    await writeFile(target, svg, 'utf8');
    console.log(`wrote ${path.relative(REPO_ROOT, target)}  (${spec.id})`);
  }

  if (check) {
    if (drifted.length > 0) {
      console.error('Cozy placeholders are not what the generator produces:');
      for (const line of drifted) console.error(`  ${line}`);
      console.error('Run: node scripts/generate-cozy-placeholders.mjs');
      process.exitCode = 1;
      return;
    }
    console.log(`Cozy placeholders match the generator (${PLACEHOLDERS.length} files).`);
  }
}

// Run only when invoked as a command, so a test may import PLACEHOLDERS without
// the module writing files as a side effect of the import.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) await main();
