/**
 * Phase 8: the non-colour state signals have to exist in the artifact that ships.
 *
 * ## The failure this file closes
 *
 * The phase exit criterion is "Focus and state styling is visible without relying
 * on color", and plan 10.1 asks every phase that touches a user flow to preserve
 * "no color-only state communication". An independent QA pass measured the
 * *default* production artifact - the one `npm run build:web` produces, with
 * `VITE_COZY_VISUALS=false`, which is the phase's production default - and found
 * the Welcome section tab strip communicating nothing at all: the selected tab
 * was computed-identical to its three unselected siblings in every property
 * (`border: none 0px`, `font-weight: 400`, no text decoration, same colour, same
 * background, same `box-shadow`, same `::before`/`::after` content) and the
 * rendered pixels were identical too. `.phase-card[aria-pressed='true']` differed
 * from its unpressed siblings by border colour alone. Colour-only would have been
 * a WCAG 1.4.1 problem; this was worse, because the state was not signalled at
 * all.
 *
 * `src/styles/cozy.css` already had the right signals, but every rule in it is
 * qualified with `[data-cozy-visuals='true']` and the flag is false by default,
 * so the fix had to be reachable without it. That is what
 * `src/styles/state-signals.css` is: unscoped, additive, non-colour only.
 *
 * ## What is asserted here, and why each one cannot be satisfied by prose
 *
 * 1. **The signals are declared and delivered.** `COZY_STATE_SIGNALS.selected`
 *    is split into its constituent phrases and each phrase is matched against
 *    the declarations the two stylesheets actually ship. An unknown phrase fails
 *    (so the table cannot grow a claim nobody implements) and a missing
 *    declaration fails (so the table cannot claim something the CSS stopped
 *    doing). This is the check the finding asked for: parse the CSS, do not
 *    trust the comment above it.
 * 2. **The two flag states deliver the same two signals**, from the same token
 *    numbers where they share any, and with no doubled bar - the mechanism for
 *    that is the import order plus equal specificity, both of which are read out
 *    of the real files rather than remembered.
 * 3. **The unscoped layer can introduce no new axe violation**, because it
 *    declares no colour property at all. The recorded default artifact has
 *    exactly one known serious `color-contrast` exception
 *    (`.welcome-checklist-status--done`, which Phase 21 owns) and a state-signal
 *    layer that changed colour could only ever add a second.
 * 4. **The legacy stylesheet was not edited to do this.** The four legacy theme
 *    blocks are byte-frozen by `qa-verification.test.ts`; this file additionally
 *    asserts that the two controls' rules in `src/styles.css` still declare no
 *    non-colour property, so the signals cannot have been smuggled into the
 *    frozen file to pass this test.
 * 5. **The signals cannot change layout**, which is the 320 CSS-pixel and 200%
 *    zoom gate: every declaration is either an inset `box-shadow` or a font
 *    weight, except the single `border-width` on a control that already has a
 *    1px border inside a clamped grid track.
 *
 * Privacy: this file reads repository source and nothing else. It contains no
 * learner data, makes no network request, and does not depend on `dist/`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { COZY_STATE_SIGNALS } from '@/theme/cozyTokens';
import { COZY_SCALE_PREFIX, cozyScaleVariables } from '@/theme/cozyCss';

const REPO_ROOT = process.cwd();
const LEGACY_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles.css');
const COZY_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles', 'cozy.css');
const STATE_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles', 'state-signals.css');

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

const legacyCss = read(LEGACY_CSS_PATH);
const cozyCss = read(COZY_CSS_PATH);
const stateCss = read(STATE_CSS_PATH);

interface Rule {
  readonly selector: string;
  readonly body: string;
}

/** Every top-level rule in a stylesheet, comments stripped. */
function rulesOf(css: string): Rule[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: (match[1] ?? '').trim().replace(/\s+/g, ' '), body: match[2] ?? '' });
  }
  return rules;
}

const stateRules = rulesOf(stateCss);
const cozyRules = rulesOf(cozyCss);

/** The rule whose selector list contains every one of the given fragments. */
function ruleWith(css: Rule[], ...fragments: string[]): Rule {
  const found = css.filter((rule) => fragments.every((fragment) => rule.selector.includes(fragment)));
  expect(found.map((rule) => rule.selector), `no rule matches ${fragments.join(' + ')}`).toHaveLength(1);
  return found[0] as Rule;
}

/** The single rule whose whole selector list is exactly this. */
function ruleWithExact(css: Rule[], selector: string): Rule {
  const found = css.filter((rule) => rule.selector === selector);
  expect(found.map((rule) => rule.selector), `no rule with the exact selector ${selector}`).toHaveLength(1);
  return found[0] as Rule;
}

function declarationsOf(rule: Rule): Readonly<Record<string, string>> {
  const declarations: Record<string, string> = {};
  for (const match of rule.body.matchAll(/(^|;)\s*([a-z-]+)\s*:\s*([^;]+)/g)) {
    declarations[match[2] as string] = (match[3] as string).trim();
  }
  return declarations;
}

/**
 * CSS specificity as `(b, c)`, which is all these selectors need: no `:is()`,
 * no `:where()`, and no `!important` anywhere in either layer.
 */
function specificity(selector: string): readonly [number, number] {
  const chunk = selector.trim();
  const ids = (chunk.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (chunk.match(/\.[\w-]+/g) ?? []).length + (chunk.match(/\[[^\]]+\]/g) ?? []).length;
  const pseudoClasses = (chunk.match(/:(?!:)[\w-]+/g) ?? []).length;
  const elements = chunk
    .replace(/#[\w-]+/g, '')
    .replace(/\.[\w-]+/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/:(?!:)[\w-]+(\([^)]*\))?/g, '')
    .replace(/[>+~*]/g, ' ')
    .split(/\s+/)
    .filter((part) => /^[a-z][\w-]*$/.test(part)).length;
  return [ids + classes + pseudoClasses, elements];
}

/* -------------------------------------------------------------------------- */
/* 1. The declared signals are the delivered signals                          */
/* -------------------------------------------------------------------------- */

const SCALE = cozyScaleVariables();

/**
 * Each phrase `COZY_STATE_SIGNALS` can name, and the declaration that delivers
 * it. A phrase with no entry here fails the test below, which is the point: the
 * table is a claim list, and a claim nobody can check is not a guarantee.
 */
const DELIVERED_BY: Readonly<Record<string, (declarations: Readonly<Record<string, string>>) => boolean>> = {
  '700 weight': (declarations) =>
    declarations['font-weight'] === '700' ||
    declarations['font-weight'] === `var(${COZY_SCALE_PREFIX}-font-weight-bold)`,
  '3px underline bar': (declarations) => {
    const shadow = declarations['box-shadow'] ?? '';
    return /inset/.test(shadow) && /(^|\s)-3px(\s|$)/.test(shadow) && /(inset[^;]*)0(\s|,|$)/.test(shadow);
  },
  '2px border': (declarations) =>
    declarations['border-width'] === '2px' ||
    declarations['border-width'] === `var(${COZY_SCALE_PREFIX}-border-state)`,
  '3px offset outline': (declarations) => {
    const outline = declarations['outline'] ?? '';
    return /3px/.test(outline) && /solid/.test(outline);
  },
};

describe('COZY_STATE_SIGNALS.selected is what the stylesheets deliver', () => {
  it('names only phrases a delivered signal can be recognised from', () => {
    for (const phrase of COZY_STATE_SIGNALS.selected.split('+').map((part) => part.trim())) {
      expect(Object.keys(DELIVERED_BY), `no delivered-signal pattern for "${phrase}"`).toContain(phrase);
    }
  });

  it('delivers every declared signal in the default (flag-off) layer', () => {
    const rule = ruleWith(stateRules, '.welcome-tabs', "aria-selected='true'");
    const declarations = declarationsOf(rule);
    for (const phrase of COZY_STATE_SIGNALS.selected.split('+').map((part) => part.trim())) {
      const delivers = DELIVERED_BY[phrase] as (d: Readonly<Record<string, string>>) => boolean;
      expect(
        delivers(declarations),
        `${rule.selector} does not deliver "${phrase}": ${JSON.stringify(declarations)}`,
      ).toBe(true);
    }
  });

  it('delivers every declared signal in the Cozy (flag-on) layer', () => {
    const rule = ruleWith(cozyRules, 'aria-selected', 'true');
    const declarations = declarationsOf(rule);
    for (const phrase of COZY_STATE_SIGNALS.selected.split('+').map((part) => part.trim())) {
      const delivers = DELIVERED_BY[phrase] as (d: Readonly<Record<string, string>>) => boolean;
      expect(
        delivers(declarations),
        `${rule.selector} does not deliver "${phrase}": ${JSON.stringify(declarations)}`,
      ).toBe(true);
    }
  });

  it('resolves the shared token numbers the phrases are written in', () => {
    // "700" and "3px" are the numbers the constant names, so the numbers the CSS
    // reads have to be the numbers the constant says - not a coincidence of
    // naming.
    expect(SCALE[`${COZY_SCALE_PREFIX}-font-weight-bold`]).toBe('700');
    expect(SCALE[`${COZY_SCALE_PREFIX}-border-state`]).toBe('2px');
    expect(SCALE[`${COZY_SCALE_PREFIX}-focus-ring-width`]).toBe('3px');
  });

  it('delivers the pressed state, not only the selected one', () => {
    for (const rules of [stateRules, cozyRules]) {
      const pressed = rules.filter((rule) => rule.selector.includes("aria-pressed='true'"));
      expect(pressed.length, 'no pressed rule in this layer').toBeGreaterThan(0);
      for (const rule of pressed) {
        const declarations = declarationsOf(rule);
        for (const phrase of COZY_STATE_SIGNALS.selected.split('+').map((part) => part.trim())) {
          const delivers = DELIVERED_BY[phrase] as (d: Readonly<Record<string, string>>) => boolean;
          expect(delivers(declarations), `${rule.selector} / ${phrase}`).toBe(true);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The two flag states agree, and the flag-on bar is not doubled           */
/* -------------------------------------------------------------------------- */

describe('the flag-on build does not double the state signal', () => {
  const stateSelected = ruleWith(stateRules, '.welcome-tabs', "aria-selected='true'");
  const cozySelected = ruleWith(cozyRules, 'aria-selected', 'true');
  const statePressed = ruleWith(stateRules, '.phase-card', "aria-pressed='true'");
  const cozyPressed = ruleWith(cozyRules, 'aria-pressed', 'true');

  it('imports the unscoped layer ahead of the Cozy layer, so Cozy wins a tie', () => {
    const stateImport = legacyCss.indexOf("@import './styles/state-signals.css';");
    const cozyImport = legacyCss.indexOf("@import './styles/cozy.css';");
    expect(stateImport, 'the default build does not import the state-signal layer').toBeGreaterThan(-1);
    expect(cozyImport, 'the Cozy layer is no longer imported').toBeGreaterThan(-1);
    expect(stateImport).toBeLessThan(cozyImport);
  });

  it('writes both layers at the same specificity, so order decides and Cozy is later', () => {
    // Equal specificity plus a later source position is the whole anti-doubling
    // mechanism. If either half stopped being true, the flag-on build would
    // render whichever layer the cascade happened to reach first.
    for (const [unscoped, scoped, name] of [
      [stateSelected, cozySelected, 'selected tab'],
      [statePressed, cozyPressed, 'pressed phase card'],
    ] as const) {
      for (const chunk of unscoped.selector.split(',').map((part) => part.trim())) {
        const matching = scoped.selector
          .split(',')
          .map((part) => part.trim())
          .find((part) => part.includes('aria-selected') === chunk.includes('aria-selected'));
        expect(matching, `no Cozy counterpart for "${chunk}"`).toBeDefined();
        expect(specificity(chunk), `${name}: ${chunk}`).toEqual(specificity(matching as string));
      }
    }
  });

  it('declares exactly one bar per rule, and the same bar in both', () => {
    for (const rule of [stateSelected, cozySelected, statePressed, cozyPressed]) {
      const bars = (declarationsOf(rule)['box-shadow'] ?? '').match(/inset/g) ?? [];
      expect(bars.length, `${rule.selector} has ${bars.length} inset shadows`).toBe(1);
    }
    const bar = (rule: Rule): string =>
      /(-?\d+px\s+0\s+0)/.exec(declarationsOf(rule)['box-shadow'] ?? '')?.[1] ?? '';
    expect(bar(stateSelected)).toBe('-3px 0 0');
    expect(bar(cozySelected)).toBe(bar(stateSelected));
    expect(bar(statePressed)).toBe(bar(stateSelected));
    expect(bar(cozyPressed)).toBe(bar(stateSelected));
  });

  it('keeps the pressed state to the signals it declares, plus the border it can draw', () => {
    // The 2px border is a bonus for controls that already have a border, which is
    // why the constant claims the pair rather than the triple.
    expect(COZY_STATE_SIGNALS.selected).not.toContain('2px');
    const stateCard = declarationsOf(statePressed);
    expect(stateCard['border-width']).toBe('2px');
    const cozyCard = declarationsOf(cozyPressed);
    expect(cozyCard['border-width']).toBe(`var(${COZY_SCALE_PREFIX}-border-state)`);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The layer cannot move the axe result, and cannot change layout            */
/* -------------------------------------------------------------------------- */

describe('the unscoped state-signal layer is colour-free and layout-free', () => {
  it('declares no colour property at all', () => {
    const colourProperties =
      /^(color|background|background-[\w-]+|border-[\w-]*color|outline-color|text-decoration-color|caret-color|accent-color|fill|stroke|column-rule-color|text-emphasis-color)$/;
    for (const rule of stateRules) {
      for (const property of Object.keys(declarationsOf(rule))) {
        expect(property, `${rule.selector} declares the colour property ${property}`).not.toMatch(
          colourProperties,
        );
      }
    }
  });

  it('uses no !important, so the cascade stays inspectable', () => {
    expect(stateCss).not.toContain('!important');
  });

  it('declares only the three properties the signal needs', () => {
    const allowed = new Set(['font-weight', 'border-width', 'box-shadow']);
    const declared = new Set(stateRules.flatMap((rule) => Object.keys(declarationsOf(rule))));
    expect([...declared].sort()).toEqual([...allowed].filter((name) => declared.has(name)).sort());
    for (const property of declared) expect(allowed.has(property), property).toBe(true);
  });

  it('puts the border only on a control that already has one', () => {
    // A border is the one declaration here that can add to a box, so it is
    // allowed exactly where the legacy control already draws a 1px border
    // (`.phase-card`) and nowhere else - the Welcome tab strip is
    // `width: fit-content`, and widening it is what a 320 CSS-pixel overflow
    // looks like.
    const withBorder = stateRules.filter((rule) => 'border-width' in declarationsOf(rule));
    expect(withBorder).toHaveLength(1);
    expect((withBorder[0] as Rule).selector).toContain('.phase-card');
    const legacyRules = rulesOf(legacyCss);
    expect(ruleWithExact(legacyRules, '.phase-card').body).toMatch(/border:\s*1px solid/);
    expect(ruleWithExact(legacyRules, '.welcome-tabs button').body).toMatch(/border:\s*none/);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The unscoped layer reaches the default artifact, and the legacy          */
/*    stylesheet was not edited to fake it                                       */
/* -------------------------------------------------------------------------- */

describe('the signal reaches the default artifact', () => {
  it('carries no Cozy scope qualifier, so the flag-off build matches it', () => {
    // Comments are prose about the flag; the claim is about selectors.
    expect(stateCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('data-cozy-visuals');
    for (const rule of stateRules) {
      for (const chunk of rule.selector.split(',').map((part) => part.trim())) {
        // The state attribute is the point of the rule; the *scope* qualifier is
        // what would stop the default build from matching it.
        expect(chunk, `${chunk} is scoped behind the flag`).not.toContain(
          'data-cozy-visuals',
        );
        expect(chunk, `${chunk} is inside a media query scope`).not.toMatch(/^:/);
      }
    }
  });

  it('covers both Welcome tablists and the phase chooser, and nothing else', () => {
    expect(stateRules.map((rule) => rule.selector)).toEqual([
      ".ui-skin .welcome-tabs button[aria-selected='true']",
      ".ui-skin button.phase-card[aria-pressed='true']",
    ]);
  });

  it('is not a media query or a nested at-rule, so it cannot be conditional', () => {
    expect(stateCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/@(media|supports|layer|container)\b/);
  });

  it('left the two controls\' legacy rules without a non-colour signal', () => {
    // The four legacy theme blocks are byte-frozen by qa-verification.test.ts.
    // This is the narrower claim: the frozen file was not opened at all to make
    // the two signals appear, so they can only be coming from the new layer.
    const legacyRules = rulesOf(legacyCss);
    for (const selector of [
      ".welcome-tabs button[aria-selected='true']",
      ".phase-card[aria-pressed='true']",
    ]) {
      const declarations = declarationsOf(ruleWithExact(legacyRules, selector));
      for (const property of ['font-weight', 'border-width', 'text-decoration-line']) {
        expect(declarations[property], `${selector} declares ${property}`).toBeUndefined();
      }
      // `.phase-card` does have a legacy `box-shadow`, and it is the colour glow
      // QA measured. What must be absent is the *shape* signal: no inset bar.
      expect(declarations['box-shadow'] ?? '', `${selector} draws an inset bar`).not.toContain('inset');
    }
  });

  it('keeps the theme picker and section tab strips on one rule', () => {
    // Both Welcome tablists are `.welcome-tabs`, so one selector covers the theme
    // picker and the section tabs. A rule per tablist would leave the next one
    // added to the screen unsignposted.
    const welcomeScreen = read(path.join(REPO_ROOT, 'src', 'ui', 'screens', 'WelcomeScreen.tsx'));
    expect([...welcomeScreen.matchAll(/className="welcome-tabs"/g)]).toHaveLength(2);
    expect(welcomeScreen).toContain('aria-label="Theme choices"');
    expect(welcomeScreen).toContain('aria-label="Welcome screen sections"');
  });
});
