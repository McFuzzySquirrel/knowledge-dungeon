/**
 * Phase 8: the flag gate, stated precisely.
 *
 * The plan's rollback for Phase 8 is "Set `VITE_COZY_VISUALS=false` and retain
 * legacy renderer themes", and the phase's production default for the flag is
 * false. This file pins what "the flag is off" means in terms a test can hold on
 * to, so "behaviour is unchanged with the flag off" is a checked claim rather
 * than an assurance.
 *
 * What the flag gates:
 * - Every rule in `src/styles/cozy-tokens.css` and `src/styles/cozy.css`. The
 *   selectors are qualified with `[data-cozy-visuals='true']`, and that attribute
 *   is substituted into `index.html` from `VITE_COZY_VISUALS`. A build that never
 *   sets the flag carries the literal, unmatchable placeholder, so the scope can
 *   never be satisfied.
 * - The Cozy token values, and therefore the Cozy palette, the rounded storybook
 *   panels, the Cozy focus ring, the Cozy state signals, and the Cozy
 *   reduced-motion block.
 *
 * What the flag deliberately does NOT gate, because the plan requires it
 * unconditionally in this phase:
 * - The font stack. The exit criterion is "The app renders without remote font
 *   requests", which is a property of the shipped artifact, not of a flag. So
 *   `--font-game`, `--font-mono`, and the root `font-family` are system stacks
 *   in both flag states. This is the one intended visual difference between this
 *   commit and its parent, and it is recorded in the phase report.
 *
 * Nothing is rewritten in storage: the preferences store persists the same
 * `colorTheme` string it always did, so a flag-off build and a flag-on build read
 * and write the same `localStorage` entry.
 *
 * Privacy: this file reads repository source and a fresh preferences store. It
 * writes only to the test's own jsdom `localStorage`, and asserts on theme names
 * rather than on any learner content.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { parseRuntimeConfig, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { FEATURE_FLAG_MATRIX } from '@/config/featureFlags';
import { COZY_VISUALS_ATTRIBUTE, COZY_VISUALS_ENABLED_VALUE } from '@/theme/cozyCss';
import {
  __testing,
  initialPreferencesState,
  resolveInitialColorTheme,
  usePreferencesStore,
} from '@/store/preferencesStore';

const REPO_ROOT = process.cwd();
const LEGACY_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles.css');
const GENERATED_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles', 'cozy-tokens.css');
const COZY_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles', 'cozy.css');
const INDEX_HTML_PATH = path.join(REPO_ROOT, 'index.html');

/**
 * The four legacy theme blocks, verbatim.
 *
 * These are the theme system the flag-off build must keep rendering. They are
 * written out here rather than derived, because the point is that nothing in
 * Phase 8 changed them; a diff in any of these values is the regression this
 * file exists to catch.
 */
const LEGACY_THEME_BLOCKS: ReadonlyArray<{ selector: string; declarations: Readonly<Record<string, string>> }> = [
  {
    selector: ':root',
    declarations: {
      '--bg-deep': '#0b1120',
      '--bg-panel': '#1a1d2a',
      '--bg-panel-soft': '#242738',
      '--border-soft': '#3a3048',
      '--text-primary': '#e8e0d4',
      '--text-secondary': '#b0a798',
      '--text-muted': '#8a8279',
      '--accent': '#d4a857',
      '--accent-soft': '#ead7a3',
      '--accent-cool': '#7a9c6c',
      '--good': '#7a9c6c',
      '--bad': '#c44a4a',
      '--control-bg': '#242738',
      '--control-border': '#3a3048',
      '--control-hover-bg': '#2e2f42',
      '--control-selected-bg': 'linear-gradient(135deg, #4e4260, #d4a857)',
      '--control-selected-text': '#fbfbff',
      '--control-selected-border': '#ead7a3',
      '--text-title': '#ead7a3',
    },
  },
  {
    selector: ".ui-skin[data-theme='light']",
    declarations: {
      '--bg-deep': '#ebe1d2',
      '--bg-panel': '#f7efe2',
      '--bg-panel-soft': '#ece0cd',
      '--border-soft': '#cab79f',
      '--text-primary': '#2b2118',
      '--text-secondary': '#5e5043',
      '--text-muted': '#77685d',
      '--accent': '#8f5821',
      '--accent-soft': '#ad6f34',
      '--accent-cool': '#2a619e',
      '--good': '#167056',
      '--bad': '#a63f3f',
      '--control-selected-text': '#2b2118',
    },
  },
  {
    selector: ".ui-skin[data-theme='colorful']",
    declarations: {
      '--bg-deep': '#0d1324',
      '--bg-panel': '#171d34',
      '--bg-panel-soft': '#222a45',
      '--border-soft': '#41508b',
      '--text-primary': '#fbfbff',
      '--text-secondary': '#cbd3ff',
      '--text-muted': '#99a4d8',
      '--accent': '#ffcf5f',
      '--accent-soft': '#ffe08f',
      '--accent-cool': '#7be3ff',
      '--good': '#62e5a4',
      '--bad': '#ff7e88',
    },
  },
  {
    selector: ".ui-skin[data-theme='aurora']",
    declarations: {
      '--bg-deep': '#0b1020',
      '--bg-panel': '#151b2e',
      '--bg-panel-soft': '#232a44',
      '--border-soft': '#4d5a8e',
      '--text-primary': '#fbfbff',
      '--text-secondary': '#d1d7ff',
      '--text-muted': '#98a2d8',
      '--accent': '#9af7e5',
      '--accent-soft': '#d2fff7',
      '--accent-cool': '#b48cff',
      '--good': '#7ee6a8',
      '--bad': '#ff8f9d',
    },
  },
];

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The body of a top-level CSS rule, comments removed. */
function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = new RegExp(`(?:^|\\n)${escapeRegExp(selector)}\\s*\\{`);
  const match = pattern.exec(withoutComments);
  if (!match) throw new Error(`rule not found: ${selector}`);
  const start = match.index + match[0].length;
  let depth = 1;
  let index = start;
  while (depth > 0 && index < withoutComments.length) {
    if (withoutComments[index] === '{') depth += 1;
    if (withoutComments[index] === '}') depth -= 1;
    index += 1;
  }
  return withoutComments.slice(start, index - 1);
}

describe('Phase 8 flag gate: the flag contract', () => {
  it('defaults VITE_COZY_VISUALS to true after the cutover and documents the false rollback', () => {
    expect(RUNTIME_FLAG_ENV_KEYS.cozyVisuals).toBe('VITE_COZY_VISUALS');
    expect(parseRuntimeConfig({}).cozyVisuals).toBe(true);
    const definition = FEATURE_FLAG_MATRIX.cozyVisuals;
    // Phase 23 makes the Cozy visual system the production default; `false` is the
    // one-release rollback to the legacy renderer themes.
    expect(definition.productionDefault).toBe(true);
    expect(definition.ownerPhase).toBe(8);
    expect(definition.rollback).toContain('VITE_COZY_VISUALS=false');
    expect(parseRuntimeConfig({ VITE_COZY_VISUALS: 'false' }).cozyVisuals).toBe(false);
  });

  it('leaves every legacy theme block byte-for-byte as it was', () => {
    const css = read(LEGACY_CSS_PATH);
    for (const block of LEGACY_THEME_BLOCKS) {
      const body = ruleBody(css, block.selector);
      for (const [property, value] of Object.entries(block.declarations)) {
        expect(body, `${block.selector} ${property}`).toContain(`${property}: ${value};`);
      }
    }
  });

  it('scopes every Cozy rule so the off state cannot match', () => {
    for (const filePath of [GENERATED_CSS_PATH, COZY_CSS_PATH]) {
      const code = read(filePath)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@import[^;]+;/g, '');
      // Every selector chunk in the file, however it is grouped.
      const chunks: string[] = [];
      for (const match of code.matchAll(/([^{}]+)\{/g)) {
        chunks.push(...match[1].split(',').map((part) => part.trim()));
      }
      expect(chunks.length, filePath).toBeGreaterThan(0);
      for (const chunk of chunks) {
        if (chunk.startsWith('@')) continue;
        expect(chunk, `${path.basename(filePath)}: ${chunk}`).toContain(
          `${COZY_VISUALS_ATTRIBUTE}='${COZY_VISUALS_ENABLED_VALUE}'`,
        );
      }
    }
  });

  it('reaches the off state without any JavaScript at runtime', () => {
    // The gate is a build-time HTML substitution, so there is no flag check in
    // the shipped JavaScript that could disagree with the stylesheet.
    const html = read(INDEX_HTML_PATH);
    expect(html).toContain(`%${RUNTIME_FLAG_ENV_KEYS.cozyVisuals}%`);
    const appSources = [
      ...['src/main.tsx', 'src/ui/App.tsx', 'src/application/bootstrap.ts'].map((relative) =>
        path.join(REPO_ROOT, relative),
      ),
    ];
    for (const filePath of appSources) {
      const source = read(filePath);
      expect(source, `${path.basename(filePath)} reads the Cozy flag`).not.toContain(
        'COZY_VISUALS',
      );
      expect(source, `${path.basename(filePath)} sets the Cozy attribute`).not.toContain(
        COZY_VISUALS_ATTRIBUTE,
      );
    }
  });
});

/**
 * The five preference keys Phase 10 adds.
 *
 * Named here so this file's two payload-shape assertions can say "the legacy keys
 * plus exactly these" rather than "the legacy keys", which is the only thing that
 * keeps them honest after a later phase adds a sixth field.
 */
const PHASE_10_AUDIO_KEYS = [
  'musicVolume',
  'sfxVolume',
  'muted',
  'musicEnabled',
  'sfxEnabled',
] as const;

describe('Phase 8 flag gate: the on state', () => {
  it('emits the Cozy palette onto the selectors the existing screens already use', () => {
    const generated = read(GENERATED_CSS_PATH);
    // The screens put data-theme on a .ui-skin element; no new attribute and no
    // component change is needed for Cozy to apply.
    expect(generated).toContain(".ui-skin[data-theme='dark']");
    expect(generated).toContain(".ui-skin[data-theme='colorful']");
    expect(generated).toContain(".ui-skin[data-theme='aurora']");
    // The legacy variables the existing 5,900-line stylesheet reads are remapped,
    // which is how Cozy reaches the UI without a component rewrite.
    expect(generated).toContain('--bg-panel: #241d18;');
    expect(generated).toContain('--text-primary: #f4eee3;');
  });

  it('maps a persisted preference onto a Cozy palette without rewriting storage', () => {
    for (const value of ['dark', 'colorful', 'aurora', 'light', 'sepia'] as const) {
      const hydrated = initialPreferencesState({ colorTheme: value });
      // The store still hydrates the legacy value, so both flag states read the
      // same stored string.
      expect(hydrated.colorTheme).toBe(resolveInitialColorTheme({ colorTheme: value }));
      // Phase 10 widened `initialPreferencesState` with the five audio fields, each
      // at its documented default. This assertion is about the *theme* half of the
      // payload, so it is compared with `toMatchObject` rather than `toEqual`: the
      // claim Phase 8 made was "the Cozy system rewrites no stored key", and it is
      // still exactly that. Audio preferences are covered by their own suite in
      // `tests/unit/preferencesStore.test.ts`.
      expect(hydrated).toMatchObject({
        graphicsMode: 'rpg',
        colorTheme: resolveInitialColorTheme({ colorTheme: value }),
        activeSpritePack: null,
      });
      // And no *Cozy* persisted key appears. The audio keys are Phase 10's, and they
      // are the only keys beyond the original three - an assertion that would have to
      // be widened deliberately, by whoever adds the next field.
      const audioKeys: readonly string[] = PHASE_10_AUDIO_KEYS;
      const nonAudioKeys = Object.keys(hydrated)
        .filter((key) => !audioKeys.includes(key))
        .sort();
      expect(nonAudioKeys).toEqual(['activeSpritePack', 'colorTheme', 'graphicsMode']);
    }
  });
});

describe('Phase 8 preferences store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePreferencesStore.setState({ graphicsMode: 'rpg', colorTheme: 'dark', activeSpritePack: null });
  });

  it('persists the legacy preference keys, plus the Phase 10 audio keys and nothing else', () => {
    usePreferencesStore.getState().setColorTheme('aurora');
    const raw = window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    // Phase 10 owns the five audio keys; the three legacy ones are unchanged. The
    // assertion stays a closed list rather than a subset check on purpose: a payload
    // that quietly grew a ninth key should fail here.
    const audioKeys: readonly string[] = PHASE_10_AUDIO_KEYS;
    expect(Object.keys(parsed).sort()).toEqual(
      ['activeSpritePack', 'colorTheme', 'graphicsMode', ...audioKeys].sort(),
    );
    expect(parsed.colorTheme).toBe('aurora');
  });

  it('resolves a Cozy theme from the live store state', () => {
    for (const [theme, expected] of [
      ['dark', 'cozy-ink'],
      ['colorful', 'cozy-berry'],
      ['aurora', 'cozy-firelight'],
    ] as const) {
      usePreferencesStore.getState().setColorTheme(theme);
      expect(__testing.selectCozyTheme(usePreferencesStore.getState())).toBe(expected);
    }
  });

  it('round-trips every Cozy theme back to a legacy value the CSS understands', () => {
    for (const cozy of ['cozy-ink', 'cozy-parchment', 'cozy-berry', 'cozy-firelight'] as const) {
      const legacy = __testing.legacyThemeValueForCozyTheme(cozy);
      expect(legacy).toBeTruthy();
      expect(__testing.selectCozyTheme({ colorTheme: legacy as 'dark' })).toBe(cozy);
    }
  });

  it('does not throw on a corrupted stored preference', () => {
    window.localStorage.setItem(
      __testing.PREFERENCES_STORAGE_KEY,
      '{"colorTheme":"not-a-theme","graphicsMode":"rpg"}',
    );
    const persisted = __testing.readPersistedPreferences();
    expect(persisted).not.toBeNull();
    expect(resolveInitialColorTheme(persisted)).toBe('dark');
    expect(__testing.resolveInitialCozyTheme(persisted)).toBe(__testing.COZY_FALLBACK_THEME);
    expect(initialPreferencesState(persisted).colorTheme).toBe('dark');
  });

  it('covers every legacy colour-theme value in the mapping table', () => {
    expect([...__testing.LEGACY_COLOR_THEME_VALUES].sort()).toEqual([
      'aurora',
      'colorful',
      'dark',
      'light',
      'sepia',
    ]);
  });
});
