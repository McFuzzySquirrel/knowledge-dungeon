/**
 * Phase 8 -> Phase 9: is the shared token source actually usable by a PixiJS host?
 *
 * ## The claim under test
 *
 * Phase 8's deliverable is a token source "shared by React and Pixi", and Phase 9's
 * objective is a reusable PixiJS 8 runtime host that reads it. Those two claims meet
 * at one question, and it is not a question a test suite can answer by asserting
 * that a token file *exists*:
 *
 * > Can a PixiJS 8 host import `src/theme/`, in a realm with no DOM and no React,
 * > and get every number it needs - colours as 0xRRGGBB tints, geometry, type
 * > sizes, and a reduced-motion scale - from JavaScript, without ever reading a CSS
 * > custom property or calling `getComputedStyle`?
 *
 * `cozy-renderer-neutrality.test.ts` already answers the *neutrality* half: the
 * module inventory, the transitive first-party import graph, the source scan for DOM
 * globals, and a standalone bundle run in a DOM-free realm. This file answers the
 * half neutrality alone does not cover, which is **usability**: that the values a
 * renderer needs arrive in the shape a renderer needs, at the import surface a
 * renderer actually imports.
 *
 * ## What is asserted, and why each part is not redundant with the other gate
 *
 * 1. **The barrel is the import surface.** The neutrality gate bundles six named
 *    token modules; a host writes `from '@/theme'`. Those are different graphs - the
 *    barrel additionally re-exports `icons.ts`, `legacyThemeMap.ts` and
 *    `cozyCss.ts` - so the barrel is bundled and its closure checked separately.
 * 2. **Argument shapes, not just values.** A DOM-free bundle that returns
 *    `'#f5c563'` where a host needs `16106851` is still a broken contract. The
 *    probe performs a host's boot sequence and records the exact value handed to each
 *    Pixi call, so the shape is asserted, not assumed.
 * 3. **Reduced motion is a read, not a lookup.** The profile is what a ticker reads
 *    every frame. That it is frozen, that it is a singleton so reading it allocates
 *    nothing, and that every duration and travel is exactly `0` (not small, not
 *    clamped) are all separately observable facts, so all are asserted.
 * 4. **The scale-token gap is pinned, not hidden.** Spacing, radii, border widths and
 *    font sizes are declared as CSS length *strings* (`'16px'`), while the touch
 *    target is declared as a number. A renderer gets strings for six of the seven
 *    scale families. The values are pinned here so they cannot drift, and the
 *    derived numbers a host computes today are pinned too, but the honest finding -
 *    that there is no numeric mirror for the scale families - is in the report to the
 *    orchestrator, not hidden behind an assertion that it is fine.
 * 5. **The bundle is admissible to a PixiJS rasterizer.** `cc0-registry.test.ts`
 *    proves the licensing rules. This file independently re-derives, from the
 *    registry and the bytes on disk, that every file under the approved bundle path
 *    is (a) approved or procedural, and (b) an SVG a PixiJS 8 SVG loader can
 *    actually rasterize: intrinsic size, no script, no SMIL, no CSS, no external
 *    reference, and no text element that would reintroduce a font dependency into a
 *    texture.
 *
 * ## Why PixiJS is mocked
 *
 * `pixi.js` is not a dependency; plan Phase 9 adds it, and Phase 8's non-goal is
 * "No world renderer". So this file cannot construct a real `Application`. It pins
 * the half of the contract that is upstream of PixiJS - the values and the argument
 * shapes - in a realm where DOM globals throw. What it deliberately does *not* claim
 * is that PixiJS renders these values correctly; that is a browser check owned by
 * Phase 9. See the limitations in the handoff report.
 *
 * Privacy: no learner data, no network, no persisted preference. This file reads
 * repository source, `public/assets/`, and a scratch directory in the OS temp
 * folder, and spawns one child Node process with no arguments beyond a path.
 *
 * Phase: 8.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COZY_BORDER_WIDTH,
  COZY_COLOR_FAMILIES,
  COZY_FOCUS,
  COZY_FONT_SIZE,
  COZY_FONT_WEIGHT,
  COZY_LINE_HEIGHT,
  COZY_MOTION_DURATION_MS,
  COZY_MOTION_EASING,
  COZY_RADIUS,
  COZY_SPACE,
  COZY_THEMES,
  TYPOGRAPHY,
  cozyBridgedVariables,
  cozyColorVariables,
  cozyScaleVariables,
  resolveCozyColors,
  type CozyTheme,
} from '@/theme';
import {
  bundleThemeBarrel,
  createScratchDir,
  removeScratchDir,
  type ThemeBarrelBundle,
} from './support/pixiHostBundle';

const REPO_ROOT = process.cwd();
const PROBE_PATH = path.join(REPO_ROOT, 'tests', 'phase8', 'support', 'pixiHostProbe.mjs');
const ASSETS_ROOT = path.join(REPO_ROOT, 'public', 'assets');
const COZY_DIR = path.join(ASSETS_ROOT, 'cozy');
const REGISTRY_PATH = path.join(ASSETS_ROOT, 'asset-licenses.json');

/** The only classes plan section 10.3 admits to a default bundle. */
const BUNDLE_ADMISSIBLE_CLASSES = ['cc0-approved', 'procedural'] as const;

/**
 * Elements and constructs that make an SVG unusable as a PixiJS 8 texture, or that
 * reintroduce a dependency the Cozy token work removed.
 *
 * - `<script>`, `on*` handlers, and `<foreignObject>`: PixiJS rasterizes an SVG
 *   through an `<img>`; scripting in an image context does not run, but a file that
 *   contains it is not a placeholder asset.
 * - `<animate*>`, `<set>`, `<style>`, and `@keyframes`: animation a texture cannot
 *   carry, and motion a `prefers-reduced-motion` preference cannot suppress. The
 *   registry notes claim these files are inert under reduced motion; this asserts it.
 * - `<text>`, `<textPath>`, `font-family`, and `@font-face`: a glyph baked into a
 *   texture is resolved by whatever face the machine happens to have installed,
 *   which is the exact remote-font coupling Phase 8 removed.
 * - `<image>`, `<use>`, `href`, and `url(`: an external reference that would turn a
 *   CC0 self-contained file into one that fetches at texture-load time - and, for an
 *   unverified legacy asset, into an exfiltration path.
 */
const SVG_DISQUALIFIERS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /<script[\s/>]/i, why: 'contains a script element' },
  { pattern: /\son[a-z]+\s*=/i, why: 'contains an inline event handler' },
  { pattern: /<foreignObject[\s/>]/i, why: 'contains a foreignObject' },
  { pattern: /<animate[\sA-Z/>]/i, why: 'contains SMIL animation' },
  { pattern: /<set[\s/>]/i, why: 'contains a SMIL set element' },
  { pattern: /<style[\s/>]/i, why: 'contains a style element' },
  { pattern: /@keyframes/i, why: 'contains CSS keyframes' },
  { pattern: /<text[\sA-Z/>]/i, why: 'contains a text element, which would need an installed face' },
  { pattern: /font-family/i, why: 'names a font family' },
  { pattern: /<image[\s/>]/i, why: 'embeds an external raster' },
  { pattern: /<use[\s/>]/i, why: 'references another element' },
  { pattern: /\b(xlink:href|href)\s*=/i, why: 'carries an href reference' },
  { pattern: /url\(/i, why: 'carries a url() reference' },
  { pattern: /<!DOCTYPE/i, why: 'carries a DOCTYPE' },
  { pattern: /<\?xml-stylesheet/i, why: 'carries an XML stylesheet processing instruction' },
];

interface RegistryEntry {
  readonly id: string;
  readonly path: string;
  readonly classification: string;
  readonly media: boolean;
  readonly pixiEligible: boolean;
  readonly bundles: readonly string[];
  readonly sha256?: string;
  readonly generation?: { readonly script?: string; readonly recipe?: string };
}

interface Registry {
  readonly bundles: Readonly<Record<string, { readonly paths: readonly string[] }>>;
  readonly assets: readonly RegistryEntry[];
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;

/* -------------------------------------------------------------------------- */
/* 1 + 2 + 3: the host boot sequence, in a realm with no DOM                    */
/* -------------------------------------------------------------------------- */

interface HostReport {
  readonly themeName: string;
  readonly highContrastTheme: string;
  readonly hcSurfacePageTint: number;
  readonly hcContrast: number;
  readonly backgroundFill: { readonly color: number; readonly alpha: number };
  readonly panelFill: { readonly color: number; readonly alpha: number };
  readonly accentStroke: { readonly color: number; readonly width: number; readonly alignment: number };
  readonly panelShape: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly radius: number };
  readonly tintedSpriteTint: number;
  readonly textFill: number;
  readonly textFontFamily: string;
  readonly textFontSize: number;
  readonly textFontWeight: number;
  readonly touchTarget: number;
  readonly unit: readonly number[];
  readonly unitOpaque: readonly number[];
  readonly luminance: number;
  readonly mix: string;
  readonly rgbaCss: string;
  readonly fullFrameA: { readonly ms: number; readonly travel: number };
  readonly fullFrameB: { readonly ms: number; readonly travel: number };
  readonly motionIdentityStable: boolean;
  readonly reducedFrame: Record<string, number>;
  readonly reducedScale: number;
  readonly reducedReduceAll: boolean;
  readonly reducedFrozen: boolean;
  readonly reducedSerializedFrozen: boolean;
  readonly reducedDurations: Readonly<Record<string, number>>;
  readonly reducedTravel: Readonly<Record<string, number>>;
  readonly fullDurations: Readonly<Record<string, number>>;
  readonly fullTravel: Readonly<Record<string, number>>;
  readonly durationNames: readonly string[];
  readonly travelNames: readonly string[];
  readonly easingStandard: string;
  readonly easingNumbers: readonly number[];
  readonly scaleTokenTypes: Readonly<Record<string, string>>;
  readonly scaleTokenValues: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly tokenCount: number;
  readonly schemaVersion: string;
}

describe('Phase 8 token source is consumable by a Phase 9 PixiJS host', () => {
  let bundle: ThemeBarrelBundle;
  let report: HostReport;
  let scratch: string;

  beforeAll(async () => {
    scratch = await createScratchDir('kd-cozy-pixi-host-');
    bundle = await bundleThemeBarrel(REPO_ROOT, scratch);
    report = JSON.parse(
      execFileSync(process.execPath, [PROBE_PATH, bundle.outFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      }),
    ) as HostReport;
  }, 60_000);

  afterAll(async () => {
    if (scratch) await removeScratchDir(scratch);
  });

  it("bundles '@/theme' standalone, dragging in no renderer, no React, and no store", () => {
    expect(bundle.bytes).toBeGreaterThan(0);
    // The barrel is what a host imports, so its closure is what has to stay small.
    // `src/config/runtimeConfig.ts` is admitted on purpose: `cozyScope.ts` reads the
    // Cozy flag name from it, and that module is pure string data.
    const leaked = bundle.modules.filter(
      (name) =>
        // The synthetic entry is reported as an absolute temp path, so match on the
        // file name rather than trying to relativise it.
        !name.endsWith('theme-barrel-entry.mjs') &&
        !/^src\/theme\/[\w-]+\.ts$/.test(name) &&
        name !== 'src/config/runtimeConfig.ts',
    );
    expect(leaked, `${leaked.join(', ')} leaked into the theme-barrel bundle`).toEqual([]);
    // zustand is the store the preferences use; a renderer bundle must not carry it.
    expect(bundle.modules.some((name) => name.includes('zustand'))).toBe(false);
  });

  it('resolves a theme without a DOM element to read it from', () => {
    // A host has no `.ui-skin[data-theme]` and no stylesheet to parse, so the theme
    // name has to come from a JavaScript function over a plain string.
    expect(report.themeName).toBe('cozy-ink');
    expect(report.highContrastTheme).toBe('#000000');
    expect(report.tokenCount).toBe(24);
    expect(report.schemaVersion).toBe('1.0.0');
  });

  it('hands every colour a 0xRRGGBB tint integer, for every theme and variant', () => {
    // `background.color`, `Graphics.fill({ color })`, and `sprite.tint` all take one
    // of these. A string here would be the one defect a renderer cannot work around.
    for (const fill of [report.backgroundFill, report.panelFill]) {
      expect(Number.isInteger(fill.color)).toBe(true);
      expect(fill.color).toBeGreaterThanOrEqual(0);
      expect(fill.color).toBeLessThanOrEqual(0xffffff);
      expect(fill.alpha).toBe(1);
    }
    expect(Number.isInteger(report.accentStroke.color)).toBe(true);
    expect(Number.isInteger(report.tintedSpriteTint)).toBe(true);
    expect(Number.isInteger(report.textFill)).toBe(true);
    // 0xRRGGBB, so a renderer can recover the channels with shifts if it ever must.
    expect(report.tintedSpriteTint & 0xff0000).toBe(0x870000);
  });

  it('hands alpha and per-channel maths to a renderer as 0..1 numbers', () => {
    for (const tuple of [report.unit, report.unitOpaque]) {
      expect(tuple).toHaveLength(4);
      for (const channel of tuple) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
    // Alpha threads through rather than being dropped or clamped.
    expect(report.unit[3]).toBe(0.5);
    expect(report.unitOpaque[3]).toBe(1);
    expect(report.luminance).toBeGreaterThanOrEqual(0);
    expect(report.luminance).toBeLessThanOrEqual(1);
    expect(report.mix).toMatch(/^#[0-9a-f]{6}$/i);
    expect(report.rgbaCss).toMatch(/^rgb\(/);
    // The high-contrast overlay is a complete token set, so a host reads one map.
    expect(report.hcSurfacePageTint).toBe(0);
    expect(report.hcContrast).toBeGreaterThanOrEqual(7);
  });

  it('hands a text style a font stack string and numeric size and weight', () => {
    // PixiJS `TextStyle.fontSize` is a number and `fontWeight` is a number, while
    // `fontFamily` is a CSS stack string. Three different shapes, three correct ones.
    expect(typeof report.textFontFamily).toBe('string');
    expect(report.textFontFamily).toContain('ui-rounded');
    expect(report.textFontFamily).toContain('sans-serif');
    expect(report.textFontSize).toBe(16);
    expect(report.textFontWeight).toBe(700);
  });

  it('hands a shape numeric geometry derived from the spacing and radius tokens', () => {
    // The values below are what the host recovered from the CSS length strings; see
    // the scale-token group for why the recovery is the host's job today.
    expect(report.panelShape).toEqual({ x: 0, y: 0, w: 48, h: 40, radius: 18 });
    expect(report.accentStroke.width).toBe(3);
  });

  it('exposes the 44px touch target as a number, not a CSS length', () => {
    expect(report.touchTarget).toBe(44);
    expect(Number.isInteger(report.touchTarget)).toBe(true);
  });

  describe('the reduced-motion contract a ticker reads every frame', () => {
    it('takes a plain boolean and never observes the environment itself', () => {
      // The probe runs with `matchMedia`, `window`, `document`, and `navigator` all
      // replaced by throwing getters, and `resolveMotionProfile` was called twice in
      // there. Reaching the environment at all would have thrown, so the host owns
      // detection and this module owns the policy. That split is the contract.
      expect(report.reducedFrame).toEqual({
        quick: 0,
        slow: 0,
        deliberate: 0,
        travelMicro: 0,
        travelLarge: 0,
      });
      expect(report.reducedScale).toBe(0);
      expect(report.reducedReduceAll).toBe(true);
    });

    it('zeroes every named duration and every named travel, not just the ones sampled', () => {
      // Exactly `0`, for all of them. A small non-zero floor would still animate,
      // and "the sampled ones happened to be zero" is not a contract.
      expect(Object.keys(report.reducedDurations).sort()).toEqual([...report.durationNames].sort());
      expect(Object.values(report.reducedDurations)).toEqual(
        report.durationNames.map(() => 0),
      );
      expect(Object.keys(report.reducedTravel).sort()).toEqual([...report.travelNames].sort());
      expect(Object.values(report.reducedTravel)).toEqual(report.travelNames.map(() => 0));
    });

    it('keeps the full-motion values a host multiplies by', () => {
      expect(report.fullDurations).toEqual({
        instant: 0,
        quick: 120,
        base: 200,
        slow: 320,
        deliberate: 480,
      });
      expect(report.fullTravel).toEqual({ micro: 2, small: 6, medium: 12, large: 24 });
      expect(report.fullFrameA).toEqual({ ms: 200, travel: 12 });
    });

    it('is frozen plain data a ticker can read without allocating', () => {
      expect(report.reducedFrozen).toBe(true);
      expect(report.reducedSerializedFrozen).toBe(true);
      // Two reads in two "frames" returned the same object: the module holds two
      // prebuilt profiles, so a per-frame read costs no allocation and no identity
      // check can be fooled by a fresh-but-equal object.
      expect(report.motionIdentityStable).toBe(true);
      expect(report.fullFrameA).toEqual(report.fullFrameB);
    });

    it('exposes easing as CSS cubic-bezier arguments a host must re-derive', () => {
      // Recorded rather than asserted as usable: a WebGL or canvas host cannot hand
      // `cubic-bezier(...)` to a tween library, so it needs the four numbers. They
      // are recoverable and correct, but there is no `COZY_MOTION_EASING_CURVE`
      // accessor - the same gap the scale tokens have. See the report.
      expect(report.easingStandard).toBe('cubic-bezier(0.2, 0, 0, 1)');
      expect(report.easingNumbers).toEqual([0.2, 0, 0, 1]);
    });
  });

  describe('the scale tokens a renderer reads', () => {
    /**
     * Recorded because it is the finding, not because it is desirable.
     *
     * Six of the seven scale families are CSS length strings and only the touch
     * target is a number. A Pixi host can recover a number from `'16px'` with
     * `parseFloat`, which is what the probe did, but that means the renderer parses
     * CSS syntax: it hard-codes a CSS unit assumption into a renderer module, and a
     * future `rem` or `em` token silently becomes a wrong number instead of a
     * compile error. `COZY_TOUCH_TARGET_MIN` is the proof the pattern was intended -
     * the numeric mirror exists for exactly one token and not the rest.
     */
    it('exposes six of seven scale families as CSS strings, not numbers', () => {
      expect(report.scaleTokenTypes).toEqual({
        radius: 'string',
        space: 'string',
        borderWidth: 'string',
        fontSize: 'string',
        lineHeight: 'string',
        fontWeight: 'string',
        focusRingWidth: 'string',
        touchTarget: 'number',
      });
    });

    it('declares every scale value as a machine-parseable CSS length or number', () => {
      // The mitigation for the above, and the invariant a numeric mirror would have
      // to preserve: every value is either a plain number, a `<number>px` length, or
      // a unitless CSS number, so a renderer can convert deterministically today.
      for (const [family, values] of Object.entries(report.scaleTokenValues)) {
        for (const [name, value] of Object.entries(values)) {
          expect(
            /^-?\d+(\.\d+)?(px)?$/.test(value),
            `${family}.${name} is "${value}", which is not a bare number or a px length`,
          ).toBe(true);
        }
      }
      expect(report.scaleTokenValues.radius).toEqual({
        none: '0px',
        sm: '6px',
        md: '10px',
        lg: '16px',
        xl: '22px',
        panel: '18px',
        pill: '999px',
      });
      expect(report.scaleTokenValues.space).toEqual({
        '0': '0px',
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '5': '20px',
        '6': '24px',
        '7': '28px',
        '8': '32px',
        '10': '40px',
        '12': '48px',
      });
      expect(report.scaleTokenValues.borderWidth).toEqual({
        hairline: '1px',
        state: '2px',
        focus: '3px',
      });
      expect(report.scaleTokenValues.fontSize).toEqual({
        xs: '12px',
        sm: '13px',
        md: '14px',
        lg: '16px',
        xl: '20px',
        xxl: '26px',
        display: '32px',
      });
      expect(report.scaleTokenValues.focus).toEqual({
        ringWidth: '3px',
        ringOffset: '2px',
        haloWidth: '2px',
      });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 4: the plan 6.1 renderer boundary, in the direction that matters            */
/* -------------------------------------------------------------------------- */

/**
 * Nothing a renderer needs is reachable only through CSS.
 *
 * The failure this rules out is specific and easy to ship by accident: a token
 * declared in `src/styles/cozy-tokens.css` with no JavaScript counterpart, which
 * React can read and a canvas cannot. The Cozy system does not have that failure
 * - every custom property it emits is generated from a JavaScript constant, and
 * this asserts the generation direction so the property cannot rot into
 * hand-written CSS later.
 *
 * Two shapes of backing value are accepted, because both are things a JavaScript
 * constant can be asked for: a value that appears verbatim in a token table, and
 * a value that is a number with a unit suffix the emitter composed (`16px`,
 * `200ms`, `1`). A hand-written CSS-only value matches neither.
 */
describe('no Cozy token is reachable only through a CSS custom property', () => {
  const themes = Object.keys(COZY_THEMES) as CozyTheme[];
  const variants = ['default', 'highContrast'] as const;

  it('backs every colour custom property with a token literal', () => {
    const literals = new Set<string>();
    for (const theme of themes) {
      for (const variant of variants) {
        for (const value of Object.values(resolveCozyColors(theme, variant))) literals.add(value);
      }
    }
    for (const family of Object.values(COZY_COLOR_FAMILIES)) {
      for (const value of Object.values(family)) literals.add(value);
    }

    const orphans: string[] = [];
    for (const theme of themes) {
      for (const variant of variants) {
        const colors = resolveCozyColors(theme, variant);
        for (const [name, value] of Object.entries(cozyColorVariables(colors))) {
          if (!literals.has(value)) orphans.push(`${name}: ${value}`);
        }
        for (const [name, value] of Object.entries(cozyBridgedVariables(colors))) {
          if (!literals.has(value)) orphans.push(`${name}: ${value}`);
        }
      }
    }
    expect(orphans, `colour custom properties with no JavaScript source: ${orphans.join(', ')}`)
      .toEqual([]);
  });

  it('backs every scale custom property with a token table or a composed number', () => {
    const tables: readonly Readonly<Record<string, unknown>>[] = [
      COZY_RADIUS,
      COZY_SPACE,
      COZY_BORDER_WIDTH,
      COZY_FONT_SIZE,
      COZY_FOCUS,
      COZY_LINE_HEIGHT,
      COZY_FONT_WEIGHT,
      COZY_MOTION_EASING,
    ];
    const verbatim = new Set<string>();
    for (const table of tables) {
      for (const value of Object.values(table)) verbatim.add(String(value));
    }
    for (const value of Object.values(TYPOGRAPHY)) verbatim.add(String(value));
    // Composed values: `<number>px`, `<number>ms`, and a bare number.
    const composed = /^\d+(\.\d+)?(px|ms)?$/;

    const orphans = Object.entries(cozyScaleVariables())
      .filter(([, value]) => !verbatim.has(value) && !composed.test(value))
      .map(([name, value]) => `${name}: ${value}`);
    expect(orphans, `scale custom properties with no JavaScript source: ${orphans.join(', ')}`)
      .toEqual([]);

    // And the count is what a renderer would have to mirror, so a silently dropped
    // scale family shows up here rather than as a missing radius in a sprite.
    // `COZY_SPACE` is keyed by numeric strings ('0', '4', '12'), so every table is
    // counted with `Object.keys` rather than `.length`.
    const count = (table: Readonly<Record<string, unknown>>) => Object.keys(table).length;
    expect(Object.keys(cozyScaleVariables()).length).toBe(
      count(COZY_RADIUS) +
        count(COZY_SPACE) +
        count(COZY_BORDER_WIDTH) +
        count(COZY_FONT_SIZE) +
        count(COZY_LINE_HEIGHT) +
        count(COZY_FONT_WEIGHT) +
        count(COZY_MOTION_EASING) +
        count(COZY_MOTION_DURATION_MS) +
        3 /* font stacks */ +
        3 /* focus geometry */ +
        1 /* touch target */ +
        1 /* motion scale */,
    );
  });
});

describe('plan 6.1: the theme modules hold the renderer boundary', () => {
  /** Import specifiers, ignoring anything inside a block or line comment. */
  function liveCode(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  /**
   * Specifier matching, used by both checks below.
   *
   * A host may import the barrel (`@/theme`), a module below it
   * (`@/theme/cozyTokens`), or reach it relatively (`../../theme/motion`), so each
   * form has to match with a trailing subpath allowed. An earlier spelling of this
   * only matched a bare `@/theme` with nothing after it, which meant
   * `from '@/theme/cozyTokens'` - the most likely import of all - passed unnoticed.
   *
   * The clause pattern is bounded by quotes and semicolons so a multi-line
   * `import {\n  a,\n} from 'x'` still matches while a string literal that merely
   * contains the text `from '@/theme'` does not. Dynamic `import()` and bare
   * side-effect imports are matched too, because a lazy `await import('pixi.js')`
   * is exactly the kind of renderer coupling a source scan has to catch.
   */
  function matchesSpecifier(source: string, pattern: RegExp): boolean {
    const code = liveCode(source);
    const forms: readonly RegExp[] = [
      /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\s*['"]([^'"]+)['"]/g,
    ];
    for (const form of forms) {
      for (const match of code.matchAll(form)) {
        if (pattern.test(match[1])) return true;
      }
    }
    return false;
  }

  it('imports no renderer from src/theme, so no renderer gains a theme dependency', () => {
    // Plan section 6.1: "Neither `src/core/` nor renderer-neutral application
    // modules may import Phaser or PixiJS." The direction that bites is theme ->
    // renderer, because a theme module that imported `pixi.js` would make the token
    // source unusable by anything that is not a Pixi host, including React DOM and
    // the CI gate. Both directions are forbidden and neither occurs.
    const themeDir = path.join(REPO_ROOT, 'src', 'theme');
    const forbidden: readonly [string, RegExp, string][] = [
      ['pixi.js', /^pixi\.js(\/|$)/, 'PixiJS'],
      ['@pixi/*', /^@pixi\//, 'a PixiJS sub-package'],
      ['phaser', /^phaser(\/|$)/, 'Phaser'],
      ['react', /^react(\/|$)/, 'React'],
      ['react-dom', /^react-dom(\/|$)/, 'ReactDOM'],
    ];
    const offenders: string[] = [];
    for (const name of readdirSync(themeDir)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(path.join(themeDir, name), 'utf8');
      for (const [specifier, pattern, why] of forbidden) {
        if (matchesSpecifier(source, pattern)) {
          offenders.push(`${name} imports '${specifier}' (${why})`);
        }
      }
      if (/\bPIXI\b|\bPhaser\b/.test(liveCode(source))) {
        offenders.push(`${name} names a renderer global`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('leaves the legacy Phaser path uncoupled from the Cozy token graph', () => {
    // `src/game/**` is not Phase 8's to edit, and it is the other side of this
    // boundary: if a Phaser scene imported `@/theme` it would pull the whole token
    // graph - and `cozyCss.ts`'s stylesheet emitter - into the legacy renderer
    // bundle, which the plan's rollback path needs to stay independent.
    const gameDir = path.join(REPO_ROOT, 'src', 'game');
    // The barrel, a module below it, or the same through a relative path.
    const themeImport = /^(?:@\/theme|\.{1,2}\/(?:[^/]+\/)*theme)(?:\/|$)/;
    const offenders: string[] = [];
    for (const name of readdirSync(gameDir, { recursive: true })) {
      if (typeof name !== 'string' || !name.endsWith('.ts')) continue;
      const file = path.join(gameDir, name);
      if (matchesSpecifier(readFileSync(file, 'utf8'), themeImport)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders, `src/game imports the Cozy token graph: ${offenders.join(', ')}`).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5: asset-bundle admissibility, re-derived rather than delegated              */
/* -------------------------------------------------------------------------- */

describe('the approved PixiJS bundle is admissible, re-derived from bytes on disk', () => {
  const bundlePaths = Object.values(registry.bundles).flatMap((bundle) => [...bundle.paths]);

  it('admits only approved or procedural media under every bundle path', () => {
    const underBundle = registry.assets.filter((entry) =>
      bundlePaths.some((prefix) => entry.path.startsWith(prefix)),
    );
    expect(underBundle.length).toBeGreaterThan(0);
    const offenders = underBundle
      .filter((entry) => !BUNDLE_ADMISSIBLE_CLASSES.includes(entry.classification as 'procedural'))
      .map((entry) => `${entry.path} (${entry.classification})`);
    expect(offenders, `unapproved media sits under an approved bundle path: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('keeps every legacy-unverified asset out of every bundle, by both directions', () => {
    // Direction one: an unverified entry cannot declare membership. Direction two,
    // the one a declaration cannot enforce: it cannot sit under a bundle path at
    // all. A legacy asset that was merely *placed* in the bundle directory without
    // claiming membership is the case that has to fail.
    const unverified = registry.assets.filter((entry) => entry.classification === 'legacy-unverified');
    expect(unverified.length).toBeGreaterThan(0);
    const claiming = unverified.filter((entry) => entry.bundles.length > 0).map((entry) => entry.path);
    const sitting = unverified
      .filter((entry) => bundlePaths.some((prefix) => entry.path.startsWith(prefix)))
      .map((entry) => entry.path);
    const eligible = unverified.filter((entry) => entry.pixiEligible).map((entry) => entry.path);
    expect({ claiming, sitting, eligible }).toEqual({ claiming: [], sitting: [], eligible: [] });
  });

  it('registers every file in the Cozy bundle directory, so the tree cannot drift', () => {
    const registered = new Set(registry.assets.map((entry) => entry.path));
    const onDisk = readdirSync(COZY_DIR)
      .sort()
      .map((name) => `public/assets/cozy/${name}`);
    expect(onDisk.length).toBeGreaterThanOrEqual(6);
    const unregistered = onDisk.filter((assetPath) => !registered.has(assetPath));
    expect(unregistered, `unregistered files in the approved bundle: ${unregistered.join(', ')}`)
      .toEqual([]);
  });

  it('ships Cozy bundle media that a PixiJS 8 SVG loader can rasterize', () => {
    for (const name of readdirSync(COZY_DIR).sort()) {
      const raw = readFileSync(path.join(COZY_DIR, name), 'utf8');
      const label = `public/assets/cozy/${name}`;

      // Intrinsic size. PixiJS resolves an SVG to a texture through an image
      // element, which needs a size it can read without layout.
      expect(raw, `${label} must declare the SVG namespace`).toContain(
        'xmlns="http://www.w3.org/2000/svg"',
      );
      const root = /<svg\b[^>]*>/i.exec(raw);
      expect(root, `${label} has no <svg> root`).not.toBeNull();
      const attributes = root?.[0] ?? '';
      expect(attributes, `${label} must declare width`).toMatch(/\bwidth="\d+"/);
      expect(attributes, `${label} must declare height`).toMatch(/\bheight="\d+"/);
      expect(attributes, `${label} must declare a viewBox`).toMatch(/\bviewBox="[\d.\- ]+"/);

      for (const { pattern, why } of SVG_DISQUALIFIERS) {
        expect(pattern.test(raw), `${label} ${why}`).toBe(false);
      }
    }
  });

  it('records a reproducible recipe and an on-disk checksum for every bundled file', () => {
    for (const entry of registry.assets) {
      if (!entry.bundles.includes('pixi-default')) continue;
      expect(entry.classification, entry.path).toBe('procedural');
      expect(entry.pixiEligible, entry.path).toBe(true);
      expect(entry.media, entry.path).toBe(true);
      expect(entry.generation?.script, entry.path).toBeTruthy();
      expect(entry.generation?.recipe, entry.path).toBeTruthy();
      expect(entry.sha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
