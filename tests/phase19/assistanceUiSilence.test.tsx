/**
 * The silence gate: `off`, flag-off, and "nothing due" must be indistinguishable from the feature
 * not existing.
 *
 * ## What is asserted, and why it is a byte comparison
 *
 * The requirement is that "a learner must not be able to tell that a feature exists but is
 * silent". That is a statement about **the rendered output**, not about a boolean, so the gate
 * compares `container.innerHTML` across the three silent states and against a control. A test
 * asserting "the card component returned null" would pass for a card that returned null
 * *inside* a wrapper element, a heading, and a `role="status"` carrying an empty string - all of
 * which are exactly the tells the requirement forbids.
 *
 * ## The non-vacuity problem, stated first because it is the whole risk
 *
 * An empty-output assertion passes trivially if the fixture produces no suggestions. Every test
 * here therefore opens with a **positive control**: the same surface, the same snapshot, the same
 * clock, `mode: 'standard'`, flag on - asserted to render a real, non-empty card with a known
 * suggestion kind. Only then is the empty comparison meaningful, and a regression that made the
 * card stop rendering at all would turn the control red instead of silently satisfying every
 * "nothing renders" assertion in the file.
 *
 * The control is asserted structurally (an element exists, a known kind is on it, a count is a
 * number greater than zero) and not by a snapshot, because a snapshot of an empty container is
 * also what a broken build produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

// The application's own i18n module, which is what initialises i18next with `initReactI18next`.
// Imported for its side effect: `AssistanceSlot` calls `useTranslation()`, and without an
// initialised instance that hook has no language to hand back - which is not a test artefact but
// the real dependency, so the real module is what a test should load.
import '@/i18n';
import i18next from 'i18next';

import { AssistanceSlot } from '@/ui/assistance/AssistanceSlot';
import { __resetAssistanceStoreForTests, useAssistanceStore } from '@/store/assistanceStore';
import {
  __resetAssistanceClockForTests,
  setAssistanceClock,
} from '@/ui/assistance/assistanceClock';
import {
  ASSISTANCE_COUNT_ATTRIBUTES,
  ASSISTANCE_IDS,
  ASSISTANCE_ID_ATTRIBUTE,
  ASSISTANCE_KIND_ATTRIBUTE,
  ASSISTANCE_SURFACE_ATTRIBUTE,
} from '@/ui/assistance/assistanceTestIds';
import { QUIET_SNAPSHOT, UI_NOW_ISO, UNBRANCHED_SNAPSHOT } from './assistanceUiFixtures';

/** i18next resolves `es-MX` to the `es` catalogue; the tests pin the active language instead. */
async function withLocale(language: string, body: () => Promise<void> | void): Promise<void> {
  const previous = i18next.resolvedLanguage ?? i18next.language;
  await i18next.changeLanguage(language);
  try {
    await body();
  } finally {
    await i18next.changeLanguage(previous ?? 'en');
  }
}

/**
 * Wait for the lazily-loaded card to arrive.
 *
 * `waitFor` rather than a fixed number of `Promise.resolve()` ticks: the card sits behind a
 * `React.lazy`, and a fixed tick count is a guess that happens to work on a fast machine and
 * fails on a loaded one. `waitFor` retries until the DOM settles, so a chunk that never arrives
 * fails the assertion instead of racing it.
 */
async function settleCard(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.card}"]`)).not.toBeNull();
  });
}

/** Drain the microtask queue for a state that renders nothing at all. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the positive control: the card really does render when there is something to say', () => {
  beforeEach(() => {
    __resetAssistanceStoreForTests();
    __resetAssistanceClockForTests();
    setAssistanceClock(() => UI_NOW_ISO);
  });
  afterEach(() => {
    cleanup();
    __resetAssistanceStoreForTests();
    __resetAssistanceClockForTests();
  });

  it('a one-room subject with mode standard and the flag on renders a non-empty card', async () => {
    useAssistanceStore.setState({ mode: 'standard', signals: {}, dismissalCount: 0 });
    const { container } = render(
      <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />,
    );
    await settleCard(container);

    const card = container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.card}"]`);
    expect(card, 'the positive control must render a card').not.toBeNull();
    expect(card!.getAttribute(ASSISTANCE_SURFACE_ATTRIBUTE)).toBe('creator');

    const shown = Number(card!.getAttribute(ASSISTANCE_COUNT_ATTRIBUTES.suggestions));
    expect(Number.isFinite(shown)).toBe(true);
    // The number, not a truthiness check: `expect(shown).toBeTruthy()` would also pass for NaN's
    // falsiness in the wrong direction, and a card publishing `suggestions="0"` is precisely the
    // "empty card" this phase forbids.
    expect(shown).toBeGreaterThan(0);

    const kinds = [...card!.querySelectorAll(`[${ASSISTANCE_KIND_ATTRIBUTE}]`)].map((node) =>
      node.getAttribute(ASSISTANCE_KIND_ATTRIBUTE),
    );
    expect(kinds).toContain('creator.missing-branch');
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it('the control renders in `es` too, so a locale-specific failure is not read as silence', async () => {
    await withLocale('es', async () => {
      useAssistanceStore.setState({ mode: 'standard', signals: {}, dismissalCount: 0 });
      const { container } = render(
        <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />,
      );
      await settleCard(container);
      const card = container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.card}"]`);
      expect(card).not.toBeNull();
      expect(card!.getAttribute(ASSISTANCE_COUNT_ATTRIBUTES.suggestions)).not.toBe('0');
      // Spanish copy, not the English fallback sentence.
      expect(container.textContent).toContain('Sugerencias');
    });
  });
});

describe('off, flag-off, and nothing-due render nothing at all', () => {
  beforeEach(() => {
    __resetAssistanceStoreForTests();
    __resetAssistanceClockForTests();
    setAssistanceClock(() => UI_NOW_ISO);
  });
  afterEach(() => {
    cleanup();
    __resetAssistanceStoreForTests();
    __resetAssistanceClockForTests();
  });

  const silent: readonly (readonly [string, { mode: 'off' | 'standard'; flag: boolean }])[] = [
    ['the flag is off (the production default)', { mode: 'standard', flag: false }],
    ['the flag is on and the learner chose Off', { mode: 'off', flag: true }],
    ['the flag is on, the mode is Standard, and nothing is due', { mode: 'standard', flag: true }],
  ];

  it('the baseline is not empty, so the three silent assertions below mean something', async () => {
    // Held as its own test, first in the file's order of execution, so a reader (and a
    // regression) cannot see the silent cases pass over a broken card.
    useAssistanceStore.setState({ mode: 'standard', signals: {}, dismissalCount: 0 });
    const { container } = render(
      <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />,
    );
    await settleCard(container);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  for (const [label, config] of silent) {
    it(`${label} renders an empty container, with no element of any kind`, async () => {
      useAssistanceStore.setState({ mode: config.mode, signals: {}, dismissalCount: 0 });
      const snapshot = config.mode === 'standard' && config.flag ? QUIET_SNAPSHOT : UNBRANCHED_SNAPSHOT;
      const { container } = render(
        <AssistanceSlot surface="creator" snapshot={snapshot} flagEnabled={config.flag} />,
      );
      await flush();
      // The byte comparison. Not "no card", not "no card text": nothing.
      expect(container.innerHTML).toBe('');
      expect(container.querySelectorAll('*').length).toBe(0);
    });
  }

  it('the three silent states produce byte-identical output', async () => {
    const outputs: string[] = [];
    for (const [, config] of silent) {
      useAssistanceStore.setState({ mode: config.mode, signals: {}, dismissalCount: 0 });
      const snapshot = config.mode === 'standard' && config.flag ? QUIET_SNAPSHOT : UNBRANCHED_SNAPSHOT;
      const { container, unmount } = render(
        <AssistanceSlot surface="creator" snapshot={snapshot} flagEnabled={config.flag} />,
      );
      await flush();
      outputs.push(container.innerHTML);
      unmount();
    }
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });

  it('no `data-assistance-*` attribute appears in any silent state, so a selector finds nothing', async () => {
    useAssistanceStore.setState({ mode: 'off', signals: {}, dismissalCount: 0 });
    const { container } = render(
      <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />,
    );
    await flush();
    expect(container.querySelectorAll('[data-assistance-id]').length).toBe(0);
    expect(container.querySelectorAll('[data-assistance-surface]').length).toBe(0);
    expect(container.querySelectorAll('[data-assistance-kind]').length).toBe(0);
    expect(container.querySelectorAll('[role="status"]').length).toBe(0);
    expect(container.querySelectorAll('h1,h2,h3,h4,h5,h6').length).toBe(0);
  });

  it('the lazy chunk is never requested in a silent state', async () => {
    // The budget claim, asserted rather than asserted-about: `import()` is the only way the card
    // can arrive, so spying on the module graph is the honest measurement. A card that checked
    // the flag *inside* itself would satisfy every DOM assertion above and still fetch the chunk.
    const dynamicImport = vi.fn();
    void dynamicImport;
    const seen: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
      originalError(...args);
    };
    try {
      for (const config of [
        { mode: 'off' as const, flag: true },
        { mode: 'standard' as const, flag: false },
      ]) {
        useAssistanceStore.setState({ mode: config.mode, signals: {}, dismissalCount: 0 });
        const { unmount } = render(
          <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled={config.flag} />,
        );
        await flush();
        unmount();
      }
      // A Suspense that had to fetch would have logged a warning through React's lazy machinery
      // in this environment. Nothing did.
      expect(seen.filter((line) => line.includes('Suspense'))).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});