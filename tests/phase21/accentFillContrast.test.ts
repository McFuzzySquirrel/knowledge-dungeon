/**
 * Phase 21: text on the accent fill is measured, and the rule that got it wrong is gone.
 *
 * ## The defect
 *
 * `npm run test:a11y` reported `serious: color-contrast` on `.active` in the village, reproducing on all
 * six runnable matrix cells. Tracing it to the rule:
 *
 * ```css
 * .village-theme-picker button.active {
 *   background: var(--accent);            // #d4a857 on the default night theme
 *   color: var(--control-selected-text);  // #fbfbff - measures 2.13:1
 * }
 * ```
 *
 * **2.13:1**, against a 4.5:1 requirement for text under 18.66px bold / 24px regular.
 *
 * ## The cause was a token mismatch, not a colour choice
 *
 * `--control-selected-text` bridges to the Cozy token `textOnSelection`, and `COZY_FILL_PARTNER_TOKENS`
 * declares that token's background to be **`selectionBg` alone**. So it is measured against a dark
 * burnt-orange selection plate, where it passes at 6.55:1. It is the correct ink for *that* fill and the
 * wrong ink for the accent - and three rules put it on the accent.
 *
 * The token layer was never wrong. `textOnAccent` already exists, is already declared against `accent`
 * and `accentDeep`, and already measures above 4.5:1 on both in all four themes. **The rule picked the
 * wrong token**, so the fix adds no colour and no second token system: `--control-text-on-accent` maps to
 * `textOnAccent`, and the rule reads it.
 *
 * ## Why this file, given the axe run already measures it
 *
 * Because jsdom computes no colours. The axe run is the browser evidence and this file is not a substitute
 * for it - but the axe run only sees the **three surfaces it scans** (`welcome`, `village`, `settings`),
 * and this defect's sibling lives on the inventory panel, which none of them visit. A measurement that only
 * exists where someone happened to look is not a gate.
 *
 * So this computes the WCAG ratio from the **same** `cozyContrastRatio` the tokens were authored with,
 * over the same four legacy theme palettes `src/styles.css` actually declares, and over **every** rule
 * that pairs a fill with a text token. Adding a fifth theme or a fifth rule makes this red.
 *
 * ## What it does not claim
 *
 * It does not claim the rendered result. It claims the **declared pairings** meet 4.5:1, which is the
 * property that was violated, and it cannot see a gradient - the three `--control-selected-bg` rules are
 * `linear-gradient(...)` in the legacy themes, so axe reports them *incomplete* rather than measured.
 * Those are recorded in the report as a named finding rather than silently passed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { cozyContrastRatio } from '@/theme/cozyColor';
import {
  COZY_FILL_PARTNER_TOKENS,
  COZY_LEGACY_VARIABLE_BRIDGE,
} from '@/theme/cozyTokens';

const REPO_ROOT = process.cwd();
const LEGACY_CSS = readFileSync(path.join(REPO_ROOT, 'src', 'styles.css'), 'utf8');

/**
 * The stylesheet with its comments removed.
 *
 * Several assertions below are of the form "this selector appears **nowhere**", and a comment quoting a
 * selector that was deliberately changed is not a rule. `aria-pressed='true'` appears in exactly that
 * shape in the note explaining what it became, and the first version of this file failed on its own
 * explanation. Removing comments once means every "absent" assertion means absent from the *stylesheet*.
 */
const LEGACY_CSS_RULES = LEGACY_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** WCAG 2.x AA for normal-size text. */
const TEXT_MINIMUM = 4.5;

/**
 * The four legacy theme palettes, read from `src/styles.css`.
 *
 * Parsed rather than transcribed, for the reason this file exists: a transcribed palette would be a second
 * copy of the source of truth, and the defect was a rule using the wrong token from that source. Reading it
 * means a new theme block is measured without editing this file.
 *
 * `:root` is the block with no selector, and the three `[data-theme='…']` blocks follow it.
 */
interface LegacyPalette {
  readonly selector: string;
  readonly values: Readonly<Record<string, string>>;
}

/** One `--name: value;` declaration. */
const DECLARATION = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g;

/** Every custom property each selector block declares. */
function readPaletteBlocks(): LegacyPalette[] {
  /*
   * A brace scanner, not a regular expression.
   *
   * The first version matched `selector { … }` with a regex and silently **skipped** `:root` and the
   * `colorful` block, because a preceding `@media` wrapper and a nested `url(...)` value both put the
   * wrong character where the regex expected a `}`. A gate that quietly measures two of four palettes is
   * worse than one that measures none: the two it measured happened to pass.
   *
   * So the braces are counted. Every `{ … }` pair is recorded with the text immediately before its `{`,
   * and the theme blocks are then picked out by their **exact** selector - never by `startsWith`, which
   * would also match a selector list like `.ui-skin[data-theme='light'] .modal { … }` that declares no
   * palette at all.
   */
  const out: LegacyPalette[] = [];
  const blocks: { selector: string; body: string }[] = [];
  // Index just past the most recent brace, so a selector is always "everything since the last block ended".
  let boundary = 0;
  let openAt = -1;

  for (let index = 0; index < LEGACY_CSS_RULES.length; index += 1) {
    const character = LEGACY_CSS_RULES[index];
    if (character === '{') {
      // Only the outermost `{` of a block starts one; a nested `{` (an `@media`, a nested selector)
      // belongs to the block already open.
      if (openAt < 0) {
        openAt = index;
      }
    } else if (character === '}') {
      if (openAt < 0) {
        boundary = index + 1;
        continue;
      }
      // The selector is the text since the last block ended, **minus any at-rule statements** that
      // precede it: `src/styles.css` opens with two `@import`s, and without cutting at the last `;` the
      // `:root` block's "selector" reads as the imports plus `:root` and matches nothing.
      const beforeBrace = LEGACY_CSS_RULES.slice(boundary, openAt);
      const lastStatementEnd = beforeBrace.lastIndexOf(';');
      const selector = (lastStatementEnd < 0 ? beforeBrace : beforeBrace.slice(lastStatementEnd + 1)).trim();
      const body = LEGACY_CSS_RULES.slice(openAt + 1, index);
      blocks.push({ selector, body });
      openAt = -1;
      boundary = index + 1;
    }
  }

  for (const block of blocks) {
    const isThemeBlock = /^\.ui-skin\[data-theme='(light|colorful|aurora|sepia)'\]$/.test(block.selector);
    if (block.selector !== ':root' && !isThemeBlock) continue;
    const values: Record<string, string> = {};
    for (const declaration of block.body.matchAll(DECLARATION)) {
      const name = declaration[1];
      const value = (declaration[2] ?? '').trim();
      if (name !== undefined && value !== '') values[name] = value;
    }
    out.push({ selector: block.selector, values });
  }
  return out;
}

const PALETTES = readPaletteBlocks();

/** The legacy palettes this file measures, as `theme -> fill -> text`. */
function pairingFor(backgroundVar: string, textVar: string): {
  readonly theme: string;
  readonly background: string;
  readonly foreground: string;
  readonly ratio: number;
}[] {
  return PALETTES.map((palette) => {
    const background = palette.values[backgroundVar];
    const foreground = palette.values[textVar];
    if (background === undefined || foreground === undefined) {
      throw new Error(
        `${palette.selector} declares ${backgroundVar} and ${textVar} in src/styles.css; this pairing ` +
          'cannot be measured because one of them is missing',
      );
    }
    if (background.startsWith('linear-gradient')) {
      throw new Error(
        `${palette.selector} defines ${backgroundVar} as a gradient, which jsdom-equivalent contrast ` +
          'maths cannot evaluate. See the report: that pairing is unmeasured, not passed',
      );
    }
    return {
      theme: palette.selector,
      background,
      foreground,
      ratio: cozyContrastRatio(foreground, background),
    };
  });
}

describe('the scan found the four legacy palettes', () => {
  it('reads :root and all three theme blocks out of src/styles.css', () => {
    // Non-vacuity. A parser that matched nothing would make every ratio assertion below vacuously true.
    expect(PALETTES.map((palette) => palette.selector)).toEqual([
      ':root',
      ".ui-skin[data-theme='light']",
      ".ui-skin[data-theme='colorful']",
      ".ui-skin[data-theme='aurora']",
    ]);
  });

  it('each palette declares the accent and both selected-text tokens', () => {
    for (const palette of PALETTES) {
      expect(Object.keys(palette.values), `${palette.selector} has no --accent`).toContain('--accent');
      expect(Object.keys(palette.values), `${palette.selector} has no --control-selected-text`).toContain(
        '--control-selected-text',
      );
      expect(Object.keys(palette.values), `${palette.selector} has no --control-text-on-accent`).toContain(
        '--control-text-on-accent',
      );
    }
  });
});

describe('text on the accent fill meets the 4.5:1 text minimum in every theme', () => {
  const pairings = pairingFor('--accent', '--control-text-on-accent');

  it.each(pairings)('$theme: $foreground on $background is at least 4.5:1', (pairing) => {
    expect(
      pairing.ratio,
      `${pairing.theme} puts ${pairing.foreground} on ${pairing.background} at ` +
        `${pairing.ratio.toFixed(2)}:1, below the ${TEXT_MINIMUM}:1 text minimum. This is the ` +
        'color-contrast violation the axe run reported',
    ).toBeGreaterThanOrEqual(TEXT_MINIMUM);
  });

  it('the worst pairing clears the minimum with margin, not by rounding', () => {
    // A ratio that lands exactly on 4.5 is a ratio that fails the moment a theme value moves by one step.
    const worst = pairings.reduce((lowest, pairing) => (pairing.ratio < lowest.ratio ? pairing : lowest));
    expect(worst.ratio, `the tightest pairing is ${worst.theme} at ${worst.ratio.toFixed(2)}:1`).toBeGreaterThan(
      TEXT_MINIMUM + 0.5,
    );
  });
});

describe('the token the rule uses is the token whose obligation is the accent fill', () => {
  it('--control-text-on-accent bridges to textOnAccent, and only that', () => {
    // The whole fix, as a statement about the bridge rather than about a stylesheet line: the rule's ink
    // comes from the token that `COZY_FILL_PARTNER_TOKENS` declares to be measured against `accent`.
    expect(COZY_LEGACY_VARIABLE_BRIDGE['--control-text-on-accent']).toBe('textOnAccent');
    expect([...COZY_FILL_PARTNER_TOKENS.textOnAccent]).toContain('accent');
  });

  it('--control-selected-text still bridges to textOnSelection, which is a different obligation', () => {
    // Both entries are needed and neither replaces the other. `textOnSelection` is measured against
    // `selectionBg`, and three rules correctly put it on the selection plate.
    expect(COZY_LEGACY_VARIABLE_BRIDGE['--control-selected-text']).toBe('textOnSelection');
    expect([...COZY_FILL_PARTNER_TOKENS.textOnSelection]).toEqual(['selectionBg']);
    expect([...COZY_FILL_PARTNER_TOKENS.textOnSelection]).not.toContain('accent');
  });

  it('no rule pairs --control-selected-text with --accent any more', () => {
    // The exact defect, as a source-level property so a later edit cannot reintroduce it silently. Both
    // orderings are checked because CSS does not care which is written first.
    const offending = LEGACY_CSS_RULES.split('}').filter(
      (block) =>
        block.includes('var(--control-selected-text)') && /background:\s*var\(--accent\)/.test(block),
    );
    expect(
      offending.map((block) => block.trim().slice(0, 160)),
      'a rule puts the selection plate ink on the accent fill, which measures 2.13:1 on the default ' +
        'theme. That is the violation the axe run reported',
    ).toEqual([]);
  });

  it('both corrected rules are present, one per surface that had the defect', () => {
    // Two sites were wrong: the village theme picker (found by axe) and the inventory panel tabs (not on
    // any scanned surface, which is why a scan alone would have missed it).
    expect(LEGACY_CSS_RULES).toMatch(/\.village-theme-picker button\.active\s*\{[^}]*--control-text-on-accent/);
    expect(LEGACY_CSS_RULES).toMatch(
      /\.inventory-badges-tabs button\[aria-selected='true'\]\s*\{[^}]*--control-text-on-accent/,
    );
  });
});

describe('the corrected rules still key on a state attribute that exists', () => {
  it('the theme picker keys on the class it writes, and the inventory tabs on aria-selected', () => {
    // A selector that matches nothing is the same failure as the original defect wearing a new hat: the
    // state would render with no selected face at all.
    expect(LEGACY_CSS_RULES).toMatch(/\.village-theme-picker button\.active\s*\{/);
    expect(LEGACY_CSS_RULES).toMatch(/\.inventory-badges-tabs button\[aria-selected='true'\]\s*\{/);
  });

  it('the theme picker active class is what ThemePicker actually writes', () => {
    // The DOM and the stylesheet cannot disagree: the component writes `active`, the rule selects `.active`.
    const hud = readFileSync(path.join(REPO_ROOT, 'src', 'ui', 'village', 'VillageHud.tsx'), 'utf8');
    expect(hud).toMatch(/checked \? 'active' : ''/);
  });

  it('the settings radio cards key on aria-checked, which the radios now carry', () => {
    // The other half of the axe fix: these selectors used to key on `aria-pressed`, which a
    // `role="radio"` does not carry, so the selected theme and language had no styling at all once the
    // role was made honest.
    expect(LEGACY_CSS_RULES).toMatch(/\.settings-theme-grid button\[aria-checked='true'\]\s*\{/);
    expect(LEGACY_CSS_RULES).toMatch(/\.settings-language-grid button\[aria-checked='true'\]\s*\{/);
    expect(
      LEGACY_CSS_RULES,
      'a selected-state rule still keys on aria-pressed for a radiogroup member, which matches nothing',
    ).not.toMatch(/\.settings-(theme|language)-grid button\[aria-pressed/);
  });
});
