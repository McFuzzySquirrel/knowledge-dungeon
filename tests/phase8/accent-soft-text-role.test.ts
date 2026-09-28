/**
 * Phase 8: `accentSoft` is a text token, so it owes 4.5:1 (and 7:1 in the
 * high-contrast variants), not the 3:1 it used to owe.
 *
 * ## Why this file exists
 *
 * The token classification is not documentation: it is what the contrast test
 * derives its obligations from. `cozy-tokens.test.ts` reads
 * `COZY_COLOR_TOKEN_KINDS`, walks every theme and every contrast variant, and
 * requires each pair to clear the threshold its *role* implies. A token
 * classified `nonText` is held to 3:1; classified `text`, to 4.5:1 - and to 7:1
 * under the high-contrast overlays, which is the stricter bar the plan sets.
 *
 * `accentSoft` was classified `nonText`, which was wrong about the role it is
 * used in. `src/styles.css` reads `var(--accent-soft)` as a `color:` value at
 * eleven sites, at 11 to 15 CSS pixels, and WCAG's "large text" threshold is
 * 18.66px bold / 24px regular - so all eleven are WCAG *normal* text and owe
 * 4.5:1. In `cozy-parchment` the token measured 3.33:1 against `surfaceSunken`
 * and 3.75:1 against `surfacePage`: passing as a 3:1 indicator, failing as text
 * by a wide margin. The defect was latent rather than live - the three themes the
 * picker offers measure 9.38:1 or better, and `cozy-parchment` is not currently
 * reachable from the picker - but "nothing renders it today" is exactly how a
 * classification error survives until a later phase puts the surface on screen.
 *
 * So the classification is corrected to the role the token is used in, the two
 * values that no longer meet the stricter obligation are brought up to it, and
 * this file holds all three facts down: the classification, the per-pair
 * thresholds recomputed with the project's own `cozyContrastRatio`, and a pinned
 * worst-case table so a future token edit cannot quietly move a number.
 *
 * `borderHairline` stays the only `decorative` token. The reclassification is
 * about a token that *is* used as text, not about relaxing anything: WCAG 1.4.11
 * exempts a hairline because it carries no information, and that exemption is
 * still correct for a panel divider.
 *
 * Privacy: this file reads repository source and reads nothing else. It contains
 * no learner data, makes no network request, and does not depend on `dist/`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COZY_COLOR_TOKENS,
  COZY_COLOR_TOKEN_KINDS,
  COZY_CONTRAST_MINIMUMS,
  COZY_FILL_PARTNER_TOKENS,
  COZY_LEGACY_VARIABLE_BRIDGE,
  COZY_NON_TEXT_PARTNER_TOKENS,
  COZY_SURFACE_TOKENS,
  COZY_THEMES,
  resolveCozyColors,
  type CozyColorToken,
  type CozyContrastVariant,
  type CozyTheme,
  type CozyThemeColors,
} from '@/theme/cozyTokens';
import { cozyContrastRatio } from '@/theme/cozyColor';

const REPO_ROOT = process.cwd();
const LEGACY_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles.css');

const THEMES = Object.keys(COZY_THEMES) as CozyTheme[];
const VARIANTS: readonly CozyContrastVariant[] = ['default', 'highContrast'];

/** The themes the theme picker can actually produce today. */
const REACHABLE_THEMES: readonly CozyTheme[] = ['cozy-ink', 'cozy-berry', 'cozy-firelight'];

interface Pair {
  readonly theme: CozyTheme;
  readonly variant: CozyContrastVariant;
  readonly kind: 'text' | 'nonText';
  readonly foreground: CozyColorToken;
  readonly background: CozyColorToken;
  readonly minimum: number;
}

/**
 * The surfaces a foreground is measured against, derived from the roles rather
 * than listed by hand - the same derivation `cozy-tokens.test.ts` uses, so this
 * file cannot fall behind it.
 *
 * `selectionBg` is excluded: the text drawn on a selected control is
 * `textOnSelection` by contract, and a generic text token on a selection fill is
 * a bug the role definitions already prevent. `focusHalo` and `selectionBorder`
 * are drawn *inside* a fill, so their job is to separate from that fill.
 */
function pairsFor(theme: CozyTheme, variant: CozyContrastVariant, colors: CozyThemeColors): Pair[] {
  const minimums = COZY_CONTRAST_MINIMUMS[variant];
  const pairs: Pair[] = [];
  for (const token of COZY_COLOR_TOKENS) {
    const kind = COZY_COLOR_TOKEN_KINDS[token];
    if (kind !== 'text' && kind !== 'nonText' && kind !== 'onFill') continue;
    const partner = COZY_NON_TEXT_PARTNER_TOKENS[token as keyof typeof COZY_NON_TEXT_PARTNER_TOKENS];
    const backgrounds: readonly CozyColorToken[] =
      kind === 'onFill'
        ? COZY_FILL_PARTNER_TOKENS[token as keyof typeof COZY_FILL_PARTNER_TOKENS]
        : partner
          ? [partner]
          : COZY_SURFACE_TOKENS.filter((surface) => surface !== 'selectionBg');
    for (const background of backgrounds) {
      pairs.push({
        theme,
        variant,
        kind: kind === 'nonText' ? 'nonText' : 'text',
        foreground: token,
        background,
        minimum: kind === 'nonText' ? minimums.nonText : minimums.text,
      });
    }
  }
  void colors;
  return pairs;
}

const PAIRS: readonly Pair[] = THEMES.flatMap((theme) =>
  VARIANTS.flatMap((variant) => pairsFor(theme, variant, resolveCozyColors(theme, variant))),
);

function ratioOf(pair: Pair): number {
  const colors = resolveCozyColors(pair.theme, pair.variant);
  return cozyContrastRatio(colors[pair.foreground], colors[pair.background]);
}

interface Worst {
  readonly foreground: CozyColorToken;
  readonly background: CozyColorToken;
  readonly ratio: number;
}

function worst(pairs: readonly Pair[], kind: 'text' | 'nonText'): Worst {
  const ofKind = pairs.filter((pair) => pair.kind === kind);
  expect(ofKind.length, `no ${kind} pairs`).toBeGreaterThan(0);
  const worstPair = ofKind.reduce((a, b) => (ratioOf(b) < ratioOf(a) ? b : a));
  return {
    foreground: worstPair.foreground,
    background: worstPair.background,
    // Rounded, not truncated: the recorded per-token comments in cozyTokens.ts
    // are written to two decimals, and this table is compared against them.
    ratio: Math.round(ratioOf(worstPair) * 100) / 100,
  };
}

/**
 * The whole 4 themes x 2 variants sweep, pinned.
 *
 * These are the numbers recomputed by `cozyContrastRatio` after the
 * `accentSoft` reclassification. They are pinned rather than merely asserted so
 * that a token value edit cannot move a measured number without someone reading
 * the diff and restating it here - the same reasoning the CC0 checksums use.
 * Worst case overall after the reclassification: text 4.66:1, non-text 3.21:1
 * (`cozy-parchment`, `default`, both against `surfaceSunken`).
 */
const SWEEP: Readonly<Record<string, { worstText: Worst; worstNonText: Worst }>> = {
  'cozy-ink default': {
    worstText: { foreground: 'textOnAccent', background: 'accentDeep', ratio: 4.81 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceRaised', ratio: 3.6 },
  },
  'cozy-ink highContrast': {
    worstText: { foreground: 'warning', background: 'surfaceRaised', ratio: 9.15 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceRaised', ratio: 6.81 },
  },
  'cozy-parchment default': {
    worstText: { foreground: 'textMuted', background: 'surfaceSunken', ratio: 4.66 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceSunken', ratio: 3.21 },
  },
  'cozy-parchment highContrast': {
    worstText: { foreground: 'accent', background: 'surfaceSunken', ratio: 7.33 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceSunken', ratio: 6.87 },
  },
  'cozy-berry default': {
    worstText: { foreground: 'textOnAccent', background: 'accentDeep', ratio: 4.99 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceRaised', ratio: 4.01 },
  },
  'cozy-berry highContrast': {
    worstText: { foreground: 'warning', background: 'surfaceRaised', ratio: 9.15 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceRaised', ratio: 6.81 },
  },
  'cozy-firelight default': {
    worstText: { foreground: 'textOnAccent', background: 'accentDeep', ratio: 4.94 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceRaised', ratio: 4.14 },
  },
  'cozy-firelight highContrast': {
    worstText: { foreground: 'warning', background: 'surfaceRaised', ratio: 9.15 },
    worstNonText: { foreground: 'borderControl', background: 'surfaceRaised', ratio: 6.81 },
  },
};

describe('accentSoft is classified for the role it is used in', () => {
  it('is a text token, not a non-text indicator', () => {
    expect(COZY_COLOR_TOKEN_KINDS.accentSoft).toBe('text');
  });

  it('is read as text colour by the stylesheet the Cozy layer bridges into', () => {
    // The usage that decides the role. If this ever stops being true the
    // classification should be revisited - in the other direction.
    const legacyCss = readFileSync(LEGACY_CSS_PATH, 'utf8');
    const colourSites = [...legacyCss.matchAll(/color:\s*var\(--accent-soft\)/g)];
    expect(colourSites.length, 'the stylesheet no longer uses --accent-soft as text').toBeGreaterThanOrEqual(5);
    // WCAG large text is 18.66px bold or 24px regular, so a rule that sizes the
    // text it tints above 15px would be large text and owe only 3:1.
    const oversized = [...legacyCss.matchAll(/(^|[;{])[^{}]*color:\s*var\(--accent-soft\)[^{}]*\{/g)]
      .map((match) => /font-size:\s*(\d+)px/.exec(match[0])?.[1])
      .filter((size): size is string => size !== undefined)
      .map(Number)
      .filter((size) => size > 15);
    expect(oversized, '--accent-soft is used as large text somewhere').toEqual([]);
    expect(COZY_LEGACY_VARIABLE_BRIDGE['--accent-soft']).toBe('accentSoft');
  });

  it('leaves borderHairline as the only decorative token', () => {
    const decorative = COZY_COLOR_TOKENS.filter(
      (token) => COZY_COLOR_TOKEN_KINDS[token] === 'decorative',
    );
    expect(decorative).toEqual(['borderHairline']);
  });

  it('derives an obligation for accentSoft in every theme and variant', () => {
    for (const theme of THEMES) {
      for (const variant of VARIANTS) {
        const pairs = PAIRS.filter(
          (pair) =>
            pair.theme === theme && pair.variant === variant && pair.foreground === 'accentSoft',
        );
        expect(
          pairs.length,
          `${theme} ${variant} derives no obligation for accentSoft`,
        ).toBeGreaterThan(0);
        for (const pair of pairs) {
          expect(pair.kind, `${theme} ${variant} accentSoft`).toBe('text');
          expect(pair.minimum, `${theme} ${variant} accentSoft`).toBe(COZY_CONTRAST_MINIMUMS[variant].text);
        }
      }
    }
  });
});

describe('every derived contrast pair meets its role threshold', () => {
  it.each(
    PAIRS.map(
      (pair) =>
        `${pair.theme} ${pair.variant} ${pair.kind} ${pair.foreground} on ${pair.background}` as const,
    ),
  )('%s', (label) => {
    const pair = PAIRS.find(
      (candidate) =>
        `${candidate.theme} ${candidate.variant} ${candidate.kind} ${candidate.foreground} on ${candidate.background}` ===
        label,
    ) as Pair;
    const colors = resolveCozyColors(pair.theme, pair.variant);
    const ratio = ratioOf(pair);
    expect(
      ratio,
      `${pair.foreground} ${colors[pair.foreground]} on ${pair.background} ${colors[pair.background]} = ${ratio.toFixed(2)}:1, needs ${pair.minimum}:1`,
    ).toBeGreaterThanOrEqual(pair.minimum);
  });

  it('brings the two values the reclassification tightened above the bar', () => {
    // The ones that failed as text. `cozy-parchment` #a54a12 measured 3.33:1 on
    // surfaceSunken; the high-contrast light variant #8a3603 measured 6.14:1
    // against a 7:1 bar.
    const parchment = COZY_THEMES['cozy-parchment'];
    expect(parchment.accentSoft).toBe('#7a360d');
    for (const surface of COZY_SURFACE_TOKENS) {
      if (surface === 'selectionBg') continue;
      const ratio = cozyContrastRatio(parchment.accentSoft, parchment[surface]);
      expect(ratio, `parchment accentSoft on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    const highContrastLight = resolveCozyColors('cozy-parchment', 'highContrast');
    expect(highContrastLight.accentSoft).toBe('#6e2b02');
    for (const surface of COZY_SURFACE_TOKENS) {
      if (surface === 'selectionBg') continue;
      const ratio = cozyContrastRatio(highContrastLight.accentSoft, highContrastLight[surface]);
      expect(ratio, `high-contrast accentSoft on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
    }
  });

  it('leaves the three reachable themes passing as text with room to spare', () => {
    // The reclassification must not cost the shipped palettes anything: the
    // picker offers Night, Arcade and Aurora, and all three were already well
    // above 4.5:1, which is why the defect was latent.
    for (const theme of REACHABLE_THEMES) {
      for (const variant of VARIANTS) {
        const colors = resolveCozyColors(theme, variant);
        for (const surface of COZY_SURFACE_TOKENS) {
          if (surface === 'selectionBg') continue;
          const ratio = cozyContrastRatio(colors.accentSoft, colors[surface]);
          expect(
            ratio,
            `${theme} ${variant} accentSoft on ${surface} = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(COZY_CONTRAST_MINIMUMS[variant].text);
        }
      }
    }
  });
});

describe('the recomputed sweep, pinned', () => {
  it('covers exactly the four themes and two variants the plan names', () => {
    expect([...Object.keys(SWEEP)]).toEqual(
      THEMES.flatMap((theme) => VARIANTS.map((variant) => `${theme} ${variant}`)),
    );
  });

  it.each(Object.entries(SWEEP))('%s has the recorded worst case', (label, expected) => {
    const [theme, variant] = label.split(' ') as [CozyTheme, CozyContrastVariant];
    const pairs = PAIRS.filter((pair) => pair.theme === theme && pair.variant === variant);
    expect(worst(pairs, 'text'), `${label} worst text`).toEqual(expected.worstText);
    expect(worst(pairs, 'nonText'), `${label} worst non-text`).toEqual(expected.worstNonText);
  });

  it('clears the plan thresholds everywhere, worst case included', () => {
    const textWorst = Math.min(...THEMES.flatMap((theme) => VARIANTS.map((variant) => worst(PAIRS.filter((p) => p.theme === theme && p.variant === variant), 'text').ratio)));
    const nonTextWorst = Math.min(...THEMES.flatMap((theme) => VARIANTS.map((variant) => worst(PAIRS.filter((p) => p.theme === theme && p.variant === variant), 'nonText').ratio)));
    expect(textWorst, 'worst text ratio anywhere').toBeGreaterThanOrEqual(4.5);
    expect(nonTextWorst, 'worst non-text ratio anywhere').toBeGreaterThanOrEqual(3);
    // And the high-contrast overlays, which owe twice as much.
    for (const theme of THEMES) {
      const pairs = PAIRS.filter((pair) => pair.theme === theme && pair.variant === 'highContrast');
      expect(worst(pairs, 'text').ratio, `${theme} high-contrast worst text`).toBeGreaterThanOrEqual(7);
      expect(worst(pairs, 'nonText').ratio, `${theme} high-contrast worst non-text`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
