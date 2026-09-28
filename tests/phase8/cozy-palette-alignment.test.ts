/**
 * The procedural placeholder art is painted from the shipped Cozy palette.
 *
 * Why this file exists
 * --------------------
 * The generator reads its colours from `paletteFamilies` in
 * `public/assets/asset-licenses.json`, and the Cozy token module
 * `src/theme/cozyTokens.ts` is the design source of truth. Those are two places, so
 * they can disagree, and the disagreement is invisible in the artifact: the generator
 * interpolates whatever the registry says, the bytes stay deterministic, and every
 * reproducibility and checksum test still passes over art in the wrong colours. A
 * recorded art colour is a provenance fact, not a taste preference, so "close enough"
 * is not an available outcome.
 *
 * So the registry block is held to be an *exact* copy of the `COZY_COLOR_FAMILIES`
 * entries the generator reads - same names, same values, no near-misses - and this
 * file fails if that stops being true. It is the assertion that turns "the values were
 * checked once" into "the values cannot drift".
 *
 * The direction of authority is one-way and deliberate: `src/theme/` decides, the
 * registry records, the generator paints. Nothing here may be satisfied by editing the
 * registry alone.
 *
 * Privacy: nothing in this file reads, writes, or asserts on learner data. The inputs
 * are the token module, the asset registry, the generated SVGs, and the credits page.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { COZY_COLOR_FAMILIES } from '../../src/theme/cozyTokens';

const REPO_ROOT = process.cwd();
const REGISTRY_PATH = path.join(REPO_ROOT, 'public', 'assets', 'asset-licenses.json');
const GENERATOR_PATH = path.join(REPO_ROOT, 'scripts', 'generate-cozy-placeholders.mjs');
const CREDITS_PATH = path.join(REPO_ROOT, 'public', 'assets', 'CREDITS.md');

interface Registry {
  paletteNote?: string;
  paletteFamilies?: Record<string, Record<string, string>>;
  assets: { path: string }[];
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
const families = registry.paletteFamilies ?? {};
const generatorSource = readFileSync(GENERATOR_PATH, 'utf8');
const credits = readFileSync(CREDITS_PATH, 'utf8');

/** The plan's five named families, which is what the generator claims to draw from. */
const PLAN_FAMILIES = ['berry', 'firelight', 'ink', 'moss', 'parchment'] as const;

/** Every `p.<family>.<token>` the renderers read, taken from the generator's own source. */
function tokensTheGeneratorReads(): string[] {
  const reads = [...generatorSource.matchAll(/\bp\.([a-z]+)\.([a-z]+)\b/g)];
  expect(reads.length, 'the generator reads no palette tokens; this file cannot check it').toBeGreaterThan(0);
  return [...new Set(reads.map((match) => `${match[1]}.${match[2]}`))].sort();
}

const readTokens = tokensTheGeneratorReads();

describe('the registry palette is an exact copy of the Cozy token module', () => {
  it('names the five families the plan names, and no others', () => {
    expect(Object.keys(families).sort()).toEqual([...PLAN_FAMILIES]);
  });

  it('records every value the token module records, byte for byte', () => {
    // The provenance-bearing assertion. String equality, not a colour-distance
    // comparison and not a case-insensitive match: a recorded art colour that differs
    // from the shipped token by a single digit is a wrong fact, not a near miss.
    for (const [family, tokens] of Object.entries(families)) {
      const tokenFamily = (COZY_COLOR_FAMILIES as Record<string, Record<string, string>>)[family];
      expect(tokenFamily, `family \`${family}\` does not exist in COZY_COLOR_FAMILIES`).toBeDefined();
      for (const [token, hex] of Object.entries(tokens)) {
        const expected = tokenFamily?.[token];
        expect(
          expected,
          `\`${family}.${token}\` has no COZY_COLOR_FAMILIES entry. src/theme/ decides the ` +
            'palette; add the token there rather than inventing an art colour here.',
        ).toBeDefined();
        expect(hex, `${family}.${token} does not match src/theme/cozyTokens.ts`).toBe(expected);
      }
    }
  });

  it('records every token the generator paints with, so none can be missing', () => {
    // The reverse direction, and the reason the generator can be trusted to have read
    // the registry at all. Without this, renaming a token in the token module would
    // leave the registry "consistent" while the art interpolated the string
    // `undefined` into a fill - deterministic bytes, a matching checksum, broken art.
    for (const key of readTokens) {
      const [family, token] = key.split('.');
      expect(families[family]?.[token], `the generator paints with \`${key}\`, which the registry does not record`).toMatch(
        /^#[0-9a-f]{6}$/,
      );
    }
  });

  it('keeps the block to the tokens the generator actually reads', () => {
    // Every recorded token is read, so the block cannot accumulate a colour that no
    // generated file depends on and that therefore never gets verified by comparison.
    const recorded = Object.entries(families).flatMap(([family, tokens]) =>
      Object.keys(tokens).map((token) => `${family}.${token}`),
    );
    expect([...recorded].sort()).toEqual(readTokens);
  });

  it('states in the registry that src/theme is the source of truth, and that these are art', () => {
    const note = String(registry.paletteNote);
    // Both halves of the framing have to survive: these are not a second token
    // declaration, and they are still placeholder art rather than a release asset.
    expect(note).toMatch(/PROVISIONAL/);
    expect(note).toMatch(/src\/theme/);
    expect(note).toMatch(/source of truth/i);
    expect(note).toMatch(/cozyTokens\.ts/);
  });
});

describe('the generated art is painted from that palette and nothing else', () => {
  const cozyPaths = registry.assets
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath.startsWith('public/assets/cozy/'));

  it('covers the whole set, and every colour in it is a token value', () => {
    expect(cozyPaths.length).toBeGreaterThanOrEqual(4);

    // The strict superset the art is allowed to draw from: every token in the token
    // module, not just the ones the registry mirrors. A generated file carrying a
    // colour that appears in no token is a provisional leftover that survived the
    // realignment, and it would be shipped.
    const tokenPalette = new Set<string>(
      Object.values(COZY_COLOR_FAMILIES).flatMap((familyTokens) =>
        Object.values(familyTokens).map((value) => String(value)),
      ),
    );

    for (const entryPath of cozyPaths) {
      const text = readFileSync(path.join(REPO_ROOT, entryPath), 'utf8');
      const used = new Set(text.match(/#[0-9a-fA-F]{3,8}/g) ?? []);
      for (const colour of used) {
        expect(tokenPalette.has(colour.toLowerCase()), `${entryPath} uses ${colour}, which is not a Cozy token`).toBe(true);
      }
      // The failure this file's sibling property exists to prevent, asserted directly
      // so the diagnosis is unambiguous when it happens.
      expect(text, `${entryPath} interpolates a missing palette value`).not.toContain('undefined');
    }
  });

  it('is still inert under reduced motion: no SMIL, no CSS animation', () => {
    for (const entryPath of cozyPaths) {
      const text = readFileSync(path.join(REPO_ROOT, entryPath), 'utf8');
      for (const pattern of [/<animate\b/, /<set\b/, /@keyframes/, /animation(-name)?\s*:/, /<style\b/]) {
        expect(text, `${entryPath} matches ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });
});

describe('the credits page cannot drift from the registry it claims to mirror', () => {
  it('prints every recorded token, with its value, on the page', () => {
    for (const [family, tokens] of Object.entries(families)) {
      expect(credits, `CREDITS.md does not list the \`${family}\` family`).toContain(`\`${family}\``);
      for (const [token, hex] of Object.entries(tokens)) {
        // Both parts: the name, so a renamed token shows up, and the value, so a
        // changed colour shows up.
        expect(credits, `CREDITS.md does not name \`${token}\` for \`${family}\``).toContain(token);
        expect(credits, `CREDITS.md does not print ${hex} for \`${family}.${token}\``).toContain(hex);
      }
    }
  });

  it('does not still advertise the pre-token palette', () => {
    // The colours the placeholder set used before the token module shipped. If one of
    // these is still on the page, the page is telling a reader the art is drawn from a
    // palette it no longer uses.
    for (const stale of ['#f3e2c7', '#e6cfa8', '#6f8f4e', '#8fae63', '#a63a4a', '#c4586a', '#4a423b', '#f0b75c']) {
      expect(credits, `CREDITS.md still advertises the provisional colour ${stale}`).not.toContain(stale);
    }
  });
});
