/**
 * The advisory boundary, asserted from the **DOM** side rather than the core's.
 *
 * ## Why this file exists when `assistanceAdvisoryBoundary.test.ts` already does this
 *
 * `core-logic-engineer` proved that assistance is advisory-only **structurally**: the engine and
 * the store reach no writer, no renderer, and no other store. That proof is about
 * `src/core/assistance/**` and `src/store/assistanceStore.ts`.
 *
 * It says nothing about `src/ui/assistance/**`, which is new code that a future edit could give a
 * store handle, a renderer import, or a `fetch`. A component that called
 * `useProgressionStore.getState().awardRoomClear` from a suggestion click would leave the engine's
 * proof completely intact and completely worthless. So this file walks the **UI** module's own
 * runtime import closure and fails on any writer.
 *
 * The claim is a property of the source graph, so it is asserted as one: a module the closure
 * reaches is named, and the names are enumerated.
 *
 * ## The clock gate is two-sided on purpose
 *
 * "No component reads a clock" is only a real claim if the scan would have caught one. So the
 * same scan that fails on any `Date.now`/`new Date` token outside `assistanceClock.ts` also
 * asserts that `assistanceClock.ts` contains **exactly one** — if the pattern matched nothing at
 * all, the first half would pass for the wrong reason, which is the "seeded so the predicate takes
 * the empty branch" mistake in its purest form.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import '@/i18n';

import { AssistanceSlot } from '@/ui/assistance/AssistanceSlot';
import { AssistanceSettings } from '@/ui/assistance/AssistanceSettings';
import {
  __resetAssistanceStoreForTests,
  selectAssistanceRecord,
  useAssistanceStore,
} from '@/store/assistanceStore';
import {
  __resetAssistanceClockForTests,
  assistanceNowIso,
  setAssistanceClock,
} from '@/ui/assistance/assistanceClock';
import { ASSISTANCE_IDS, ASSISTANCE_ID_ATTRIBUTE } from '@/ui/assistance/assistanceTestIds';
import { UI_NOW_ISO, UNBRANCHED_SNAPSHOT } from './assistanceUiFixtures';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ASSISTANCE_UI_DIR = join(REPO_ROOT, 'src', 'ui', 'assistance');

/**
 * Erase the type-only parts of a module's imports, keeping the **statement**.
 *
 * The obvious implementation - `import { a, type B } from 'x'` matched by a regex spanning to the
 * closing quote - deletes the whole statement, and with it the edge to `'x'`. That is the
 * dangerous direction for this gate: an erased edge is an unmeasured one, so a component that
 * imported `useProgressionStore` on the same line as a type would look clean.
 *
 * Found by running the scan and noticing `react` was missing from a module whose very first
 * import is `import { useEffect, ..., type ReactNode } from 'react'`.
 *
 * So: whole-statement `import type ... from '...'` is removed, and inside braces only the
 * `type X` **specifier** is removed. The statement, its specifier list, and its specifier string
 * all survive.
 */
function stripTypeOnlyImports(source: string): string {
  return source
    .replace(/import\s+type\s[^;'"]*?from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/\{([^}]*)\}/g, (_match: string, inner: string) => {
      const kept = inner
        .split(',')
        .filter((specifier) => !/^\s*type\s/.test(specifier))
        .join(',');
      return `{${kept}}`;
    });
}

/** Modules a learner-facing component must never reach. */
const FORBIDDEN_MODULES = [
  'src/store/progressionStore',
  'src/store/subjectStore',
  'src/store/sessionStore',
  'src/core/validation/validationEngine',
  'src/core/review/spacedRepetition',
  'src/game',
  'src/renderers',
  'pixi.js',
  'phaser',
] as const;

/** A module id `import('...')` produced, normalised to a repo-relative path where possible. */
function normalize(specifier: string): string {
  if (specifier.startsWith('@/')) return `src/${specifier.slice(2)}`;
  return specifier;
}

/** The runtime import closure of `src/ui/assistance/**`, file by file. */
function runtimeClosure(): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  const queue: string[] = readdirSync(ASSISTANCE_UI_DIR)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => join(ASSISTANCE_UI_DIR, name));

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (edges.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    const specifiers: string[] = [];
    // Value imports only. A type-only edge to a store is erased by the bundler and is not a
    // reachability claim the runtime makes.
    const withoutTypeImports = stripTypeOnlyImports(source);
    for (const match of withoutTypeImports.matchAll(
      /(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    )) {
      specifiers.push(normalize(match[1]));
    }
    for (const match of withoutTypeImports.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      specifiers.push(normalize(match[1]));
    }
    // A CSS import is a real edge for the bundler and carries no specifier hazard.
    edges.set(file, specifiers);

    for (const specifier of specifiers) {
      if (!specifier.startsWith('src/')) continue;
      const base = join(REPO_ROOT, specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
      ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          if (candidate.endsWith('.ts') || candidate.endsWith('.tsx')) queue.push(candidate);
          break;
        }
      }
    }
  }
  return edges;
}

/** Every module the closure reaches, as repo-relative posix paths, plus the bare specifiers. */
function reachedModules(): readonly string[] {
  const reached = new Set<string>();
  for (const specifiers of runtimeClosure().values()) {
    for (const specifier of specifiers) reached.add(specifier);
  }
  return [...reached].sort();
}

describe('the closure scan is not vacuous', () => {
  it('it reaches the engine, the store, and React, so it is measuring a real graph', () => {
    const reached = reachedModules();
    expect(reached.some((m) => m.startsWith('src/core/assistance/'))).toBe(true);
    expect(reached.some((m) => m.startsWith('src/store/assistanceStore'))).toBe(true);
    // `react` is the canary for the type-stripping regex: every one of these modules imports it on
    // a line that also carries a `type` specifier, so an over-greedy strip loses exactly this edge
    // and exactly this assertion is what notices.
    expect(reached).toContain('react');
    expect(reached.length).toBeGreaterThan(5);
  });

  it('the directory it walks is the one this stage owns, and is not empty', () => {
    expect(existsSync(ASSISTANCE_UI_DIR)).toBe(true);
    expect(readdirSync(ASSISTANCE_UI_DIR).length).toBeGreaterThan(4);
  });
});

describe('the assistance UI reaches no writer and no renderer', () => {
  it('no module in the closure is an enumerated writer or renderer', () => {
    const reached = reachedModules();
    const offenders = reached.filter((module) =>
      FORBIDDEN_MODULES.some(
        (forbidden) => module === forbidden || module.startsWith(`${forbidden}/`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('the card module itself imports no store at all, so it cannot hold a writer', () => {
    const card = join(ASSISTANCE_UI_DIR, 'AssistanceCard.tsx');
    const specifiers = runtimeClosure().get(card) ?? [];
    expect(specifiers.filter((s) => s.startsWith('src/store/'))).toEqual([]);
  });

  it('no module in the closure fetches, and no module references a network API', () => {
    for (const [file] of runtimeClosure()) {
      // Comments are stripped first, because several of these modules name `fetch` and `Date`
      // while explaining that they contain neither; a doc comment is not a call site.
      const executable = stripTypeOnlyImports(
        readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
      );
      expect([...executable.matchAll(/\b(fetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource)/g)].map((m) => m[1]), file).toEqual([]);
    }
  });

  it('the engine is reached only through its public entry module', () => {
    const reached = reachedModules();
    const engineModules = reached.filter((m) => m.startsWith('src/core/assistance/'));
    expect(engineModules.length).toBeGreaterThan(0);
    // A deep import past the barrel would be a second, unpoliced surface - so the set is named
    // rather than counted. Compared as a sorted list, because a `toBe(true)` over three `||`
    // clauses reports *which* clause failed as an opaque boolean.
    expect(engineModules).toEqual([
      'src/core/assistance/assistanceEngine',
      'src/core/assistance/subjectInput',
      'src/core/assistance/types',
    ]);
  });
});

describe('no component reads a clock, and the one allowed clock is really there', () => {
  const TIME_TOKENS =
    /\b(Date\.now\s*\(|new\s+Date\s*\(|Date\s*\(\s*\)|performance\.now\s*\(|Math\.random\s*\()/g;

  it('the scan would find a clock if one were written, proved by planting one in a copy', () => {
    // Non-vacuity, without touching the tree: the same regex is run against a synthetic source
    // that contains a clock, and must match. A scan that passes because the pattern does not
    // compile or does not match is the failure this guards.
    const planted = 'const now = new Date().toISOString();\nexport default now;';
    expect([...planted.matchAll(TIME_TOKENS)].map((m) => m[1])).not.toEqual([]);
  });

  it('exactly one file in `src/ui/assistance/**` may read a clock, and it is the seam', () => {
    const offenders: string[] = [];
    const counts = new Map<string, number>();
    for (const name of readdirSync(ASSISTANCE_UI_DIR)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
      const file = join(ASSISTANCE_UI_DIR, name);
      const executable = stripTypeOnlyImports(
        readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
      );
      const hits = [...executable.matchAll(TIME_TOKENS)];
      counts.set(name, hits.length);
      if (hits.length > 0 && name !== 'assistanceClock.ts') offenders.push(name);
    }
    expect(offenders).toEqual([]);
    // Two-sided: the seam must actually contain one, or the gate above is passing for nothing.
    expect(counts.get('assistanceClock.ts')).toBe(1);
  });

  it('the seam is injectable, and an installed clock is the one a card renders with', () => {
    setAssistanceClock(() => '1999-12-31T23:59:59.000Z');
    expect(assistanceNowIso()).toBe('1999-12-31T23:59:59.000Z');
    setAssistanceClock(null);
    // Restoring the system clock must produce something that is not the injected value.
    expect(assistanceNowIso()).not.toBe('1999-12-31T23:59:59.000Z');
    expect(Number.isNaN(Date.parse(assistanceNowIso()))).toBe(false);
  });
});

describe('a suggestion click writes nothing but a dismissal count', () => {
  beforeEach(() => {
    __resetAssistanceStoreForTests();
    __resetAssistanceClockForTests();
    setAssistanceClock(() => UI_NOW_ISO);
    useAssistanceStore.setState({ mode: 'standard', signals: {}, dismissalCount: 0 });
  });
  afterEach(() => {
    cleanup();
    __resetAssistanceStoreForTests();
    __resetAssistanceClockForTests();
  });

  it('the dismissal count goes up by exactly one and the mode is untouched', async () => {
    const before = selectAssistanceRecord(useAssistanceStore.getState(), UI_NOW_ISO);
    const { container } = render(
      <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />,
    );
    await waitFor(() => {
      expect(container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`)).not.toBeNull();
    });
    const button = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
    ) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(button);
    });

    const after = selectAssistanceRecord(useAssistanceStore.getState(), UI_NOW_ISO);
    // Numbers, compared as numbers. Not "the count changed" - a changed *string* would satisfy
    // that, and a value published as a string and read with Number(...) makes comparisons
    // unfailable.
    expect(typeof after.dismissalCount).toBe('number');
    expect(after.dismissalCount).toBe(before.dismissalCount + 1);
    expect(after.mode).toBe(before.mode);
    expect(after.signals).toEqual(before.signals);
    // And the stored record's field set is unchanged apart from the count and the timestamp: a
    // dismissal that also wrote a suppression key would show up here as an extra field.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it('the suggestion disappears from the DOM after a dismissal, and comes back on remount', async () => {
    const first = render(<AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />);
    await waitFor(() => {
      expect(first.container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.card}"]`)).not.toBeNull();
    });
    await act(async () => {
      fireEvent.click(
        first.container.querySelector(
          `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
        ) as HTMLButtonElement,
      );
    });
    expect(first.container.querySelectorAll('[data-assistance-kind]').length).toBe(0);
    first.unmount();

    // Non-punitive: the store keeps no suppression, so a fresh mount brings it back. This is the
    // DOM half of the claim `dismissSuggestion()`'s signature makes structurally.
    const second = render(
      <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />,
    );
    await waitFor(() => {
      expect(second.container.querySelectorAll('[data-assistance-kind]').length).toBeGreaterThan(0);
    });
    second.unmount();
  });
});

describe('the settings surface writes only the mode and the count', () => {
  beforeEach(() => {
    __resetAssistanceStoreForTests();
    useAssistanceStore.setState({ mode: 'standard', signals: { repeatedDraft: 4 }, dismissalCount: 3 });
  });
  afterEach(() => {
    cleanup();
    __resetAssistanceStoreForTests();
  });

  it('choosing a mode changes the mode and nothing else', async () => {
    const before = selectAssistanceRecord(useAssistanceStore.getState(), UI_NOW_ISO);
    const { container } = render(<AssistanceSettings locale="en" />);
    const off = container.querySelector('input[type="radio"][value="off"]') as HTMLInputElement;
    expect(off).not.toBeNull();
    await act(async () => {
      fireEvent.click(off);
    });
    const after = selectAssistanceRecord(useAssistanceStore.getState(), UI_NOW_ISO);
    expect(after.mode).toBe('off');
    expect(after.signals).toEqual(before.signals);
    expect(after.dismissalCount).toBe(before.dismissalCount);
  });

  it('clearing the count changes the count and nothing else', async () => {
    const before = selectAssistanceRecord(useAssistanceStore.getState(), UI_NOW_ISO);
    const { container } = render(<AssistanceSettings locale="en" />);
    const clear = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.clearDismissals}"]`,
    ) as HTMLButtonElement;
    expect(clear, 'a count of 3 must offer the control that erases it').not.toBeNull();
    await act(async () => {
      fireEvent.click(clear);
    });
    const after = selectAssistanceRecord(useAssistanceStore.getState(), UI_NOW_ISO);
    expect(after.dismissalCount).toBe(0);
    expect(after.mode).toBe(before.mode);
    expect(after.signals).toEqual(before.signals);
    // And the control is gone with nothing left to clear.
    expect(
      container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.clearDismissals}"]`),
    ).toBeNull();
  });

  it('the settings surface imports no renderer and no writer either', () => {
    const settings = join(ASSISTANCE_UI_DIR, 'AssistanceSettings.tsx');
    const specifiers = runtimeClosure().get(settings) ?? [];
    expect(specifiers.filter((s) => s.startsWith('src/store/'))).toEqual([
      'src/store/assistanceStore',
    ]);
  });
});

/** Kept so the unused-import guard cannot quietly remove the helper the scan documents. */
void dirname;
void relative;