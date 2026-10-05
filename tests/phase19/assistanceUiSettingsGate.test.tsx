/**
 * The Assistance settings tab is gated on the Phase 19 flag, in **both** configurations.
 *
 * ## Why this file exists next to `tests/unit/audioSettingsTab.test.tsx`
 *
 * That file asserts the default build's tablist as a **whole-list equality** - four tabs, in order -
 * and adding a fifth broke it. The right repair was to fix the product so the default build's list
 * was right again, not to loosen the gate, so that file is unedited and still whole-list.
 *
 * What that leaves uncovered is the other direction. A gate that always removed the Assistance tab
 * would also satisfy a four-tab equality, so "absent when off" alone is half a claim. This file
 * pins **both**: absent when `runtimeConfig.adaptiveAssistance` is `false`, present when it is
 * `true`, order included, plus the panel behaviour the Audio tab's own gate requires.
 *
 * ## Why the flag is faked with a module mock here, and with a pure function there
 *
 * `SettingsModal` reads the flag directly, so a rendered test must control the module. The mock is
 * `importOriginal`-based: it overrides exactly one field and preserves the rest of `runtimeConfig`,
 * because `AudioSettingsTab` and other modules in the same graph read other flags and a factory that
 * returned only `adaptiveAssistance` would crash them - and would make a passing test depend on
 * which modules happen to be in the graph.
 *
 * The **decision** itself is tested separately, without any mock, in
 * `src/ui/assistance/settingsTabGate.ts`. That split is deliberate: the pure function's tests assert
 * the rule, and the rendered tests assert that the modal actually asks that function.
 *
 * ## The vacuity this file is written against
 *
 * Two render tests that both render with `adaptiveAssistance: false` would pass with the gate
 * deleted, because the default build genuinely has no Assistance tab. So the flagged test asserts
 * **three** things that a missing gate cannot satisfy: the flag it installed is the flag the modal
 * read, the tab is in the list, and the list is exactly five.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { JSX } from 'react';

import '@/i18n';

import { ASSISTANCE_TAB_ID, visibleSettingsTabs } from '@/ui/assistance/settingsTabGate';
import type { SettingsTabDescriptor } from '@/ui/assistance/settingsTabGate';

/** The modal's own four pre-Phase-19 tabs, in the order it has always rendered them. */
const ORIGINAL_TABS: readonly SettingsTabDescriptor[] = Object.freeze([
  { id: 'theme', label: 'Theme', labelKey: 'settings.tabs.theme' },
  { id: 'language', label: 'Language', labelKey: 'settings.tabs.language' },
  { id: 'shortcuts', label: 'Shortcuts', labelKey: 'settings.tabs.shortcuts' },
  { id: 'audio', label: 'Audio', labelKey: 'settings.tabs.audio' },
]);

const ALL_TABS: readonly SettingsTabDescriptor[] = Object.freeze([
  ...ORIGINAL_TABS,
  { id: ASSISTANCE_TAB_ID, label: 'Assistance', labelKey: 'settings.tabs.assistance' },
]);

/**
 * Render the modal with a chosen Phase 19 flag.
 *
 * `vi.resetModules()` plus `vi.doMock` rather than a file-scope `vi.mock`, because the two
 * configurations have to coexist in one file: a hoisted module mock is one value for the whole
 * file, which would make the flagged case unreachable. A fresh module graph per call also means the
 * `useState('theme')` initial value is genuinely fresh, so the flagged case starts on Theme rather
 * than inheriting a selection.
 */
async function renderModalWithFlag(
  adaptiveAssistance: boolean,
): Promise<{ runtimeConfigAdaptiveAssistance: boolean }> {
  vi.resetModules();
  vi.doMock('@/config/featureFlags', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/config/featureFlags')>();
    return {
      ...actual,
      runtimeConfig: { ...actual.runtimeConfig, adaptiveAssistance },
    };
  });
  const { SettingsModal } = await import('@/ui/components/SettingsModal');
  const flags = await import('@/config/featureFlags');
  render(
    <SettingsModal
      currentTheme="dark"
      onThemeChange={() => undefined}
      onClose={() => undefined}
    />,
  );
  return { runtimeConfigAdaptiveAssistance: flags.runtimeConfig.adaptiveAssistance };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.doUnmock('@/config/featureFlags');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('the decision, with no mock and no DOM', () => {
  it('the flag off removes exactly the Assistance tab and keeps the other four, in order', () => {
    expect(visibleSettingsTabs(ALL_TABS, false).map((tab) => tab.label)).toEqual([
      'Theme',
      'Language',
      'Shortcuts',
      'Audio',
    ]);
  });

  it('the flag on keeps all five, in order', () => {
    expect(visibleSettingsTabs(ALL_TABS, true).map((tab) => tab.label)).toEqual([
      'Theme',
      'Language',
      'Shortcuts',
      'Audio',
      'Assistance',
    ]);
  });

  it('the two configurations are exact duals of each other', () => {
    // The non-vacuity pairing. A gate that returned `[]` would satisfy neither; a gate that always
    // removed the tab would satisfy the first and fail this.
    const off = visibleSettingsTabs(ALL_TABS, false).map((tab) => tab.id);
    const on = visibleSettingsTabs(ALL_TABS, true).map((tab) => tab.id);
    expect(on.filter((id) => !off.includes(id))).toEqual([ASSISTANCE_TAB_ID]);
    expect(off).toEqual(on.filter((id) => id !== ASSISTANCE_TAB_ID));
    // And the flag is the only input: the same list, twice, must give the same answer.
    expect(visibleSettingsTabs(ALL_TABS, false)).toEqual(visibleSettingsTabs(ALL_TABS, false));
  });

  it('the flag off removes no tab it does not own, even if the list grows', () => {
    // The blast-radius half. If this function were ever handed a list containing a tab whose id
    // merely *starts with* the assistance id, or a list that has no assistance tab at all, the
    // result must still be the list minus that one id and nothing more.
    const withNeighbour: readonly SettingsTabDescriptor[] = [
      { id: 'theme', label: 'Theme', labelKey: 'settings.tabs.theme' },
      { id: 'assistance-advanced', label: 'Advanced', labelKey: 'settings.tabs.advanced' },
      { id: ASSISTANCE_TAB_ID, label: 'Assistance', labelKey: 'settings.tabs.assistance' },
    ];
    expect(visibleSettingsTabs(withNeighbour, false).map((tab) => tab.id)).toEqual([
      'theme',
      'assistance-advanced',
    ]);
    expect(visibleSettingsTabs(ORIGINAL_TABS, false).map((tab) => tab.id)).toEqual(
      ORIGINAL_TABS.map((tab) => tab.id),
    );
  });

  it('the returned list is the caller`s array when nothing is removed', () => {
    // An identity assertion, not a `toEqual`: it pins that the flag-on path does not copy, which
    // is what keeps a five-tab tablist from re-rendering its buttons on every parent render.
    expect(visibleSettingsTabs(ALL_TABS, true)).toBe(ALL_TABS);
  });

  it('a hidden tab is absent from the visible list, so it cannot be selected', () => {
    // This replaced a `resolveActiveSettingsTab` clamp that two probes showed was unobservable, and
    // it is the *structural* half of the same concern: `activeTab` is only ever written by a click
    // on a rendered tab, so the modal needs no clamp - and this asserts the fact the clamp would
    // have needed, rather than the clamp.
    expect(ORIGINAL_TABS.some((tab) => tab.id === ASSISTANCE_TAB_ID)).toBe(false);
    expect(visibleSettingsTabs(ALL_TABS, true).some((tab) => tab.id === ASSISTANCE_TAB_ID)).toBe(
      true,
    );
  });
});

describe('the default build: no Assistance tab, and no promise of one', () => {
  it('renders the original four tabs in order, and none of them is Assistance', async () => {
    const installed = await renderModalWithFlag(false);
    // The mock really applied. Without this, a mis-applied mock would leave the flagged case below
    // rendering four tabs and failing - but this line makes the *reason* legible in a failure.
    expect(installed.runtimeConfigAdaptiveAssistance).toBe(false);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Theme',
      'Language',
      'Shortcuts',
      'Audio',
    ]);
    expect(screen.queryByRole('tab', { name: 'Assistance' })).not.toBeInTheDocument();
    // Nothing in the modal mentions assistance at all: not a tab, not a panel, not a heading.
    expect(document.body.textContent).not.toMatch(/assistance/i);
  });

  it('has no Assistance tabpanel, and no way to reach one', async () => {
    await renderModalWithFlag(false);
    expect(screen.queryByRole('tabpanel', { name: 'Assistance settings' })).not.toBeInTheDocument();
    const tablist = screen.getByRole('tablist', { name: 'Settings categories' });
    expect(within(tablist).queryByText(/Assistance/i)).not.toBeInTheDocument();
    // The tablist is one Tab stop per tab, so a tab that is not rendered cannot be reached by
    // keyboard either. Counted, not asserted by absence alone.
    expect(within(tablist).getAllByRole('tab')).toHaveLength(4);
  });
});

describe('the flagged build: the Assistance tab is there and works', () => {
  it('renders all five tabs in order, with Assistance last', async () => {
    const installed = await renderModalWithFlag(true);
    expect(installed.runtimeConfigAdaptiveAssistance).toBe(true);

    const tabs = screen.getAllByRole('tab');
    // Exact, in order, in the flagged case too - so both configurations are pinned rather than one
    // exact and one loose.
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Theme',
      'Language',
      'Shortcuts',
      'Audio',
      'Assistance',
    ]);
    expect(screen.getByRole('tab', { name: 'Assistance' })).toHaveAttribute('aria-selected', 'false');
  });

  it('selecting it mounts a named tabpanel and unmounts the theme one, as the Audio tab requires', async () => {
    await renderModalWithFlag(true);
    screen.getByRole('tab', { name: 'Assistance' }).click();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Assistance' })).toHaveAttribute('aria-selected', 'true');
    });
    // Named, so a screen reader landing on it says what it is - the same requirement the Audio
    // tab's own gate states.
    const panel = screen.getByRole('tabpanel', { name: 'Assistance settings' });
    expect(panel).toBeInTheDocument();
    // And the previous panel is gone, so its controls cannot be tabbed into from here.
    expect(screen.queryByRole('radiogroup', { name: 'UI theme choices' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tabpanel', { name: 'Theme settings' })).not.toBeInTheDocument();
  });

  it('the lazily-imported settings surface actually arrives inside that panel', async () => {
    // The tabpanel wrapper renders synchronously; this proves the lazy import behind it resolves and
    // mounts the real surface, so the tab is not a label over an empty region.
    await renderModalWithFlag(true);
    screen.getByRole('tab', { name: 'Assistance' }).click();
    const panel = await screen.findByRole('region', { name: 'Assistance' });
    expect(within(panel).getByRole('radio', { name: 'Off' })).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: 'Gentle' })).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: 'Standard' })).toBeInTheDocument();
  });

  it('the tab keeps the other four reachable and unchanged', async () => {
    await renderModalWithFlag(true);
    for (const name of ['Theme', 'Language', 'Shortcuts', 'Audio']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    // Clicking away and back works, so the gate is not a one-way door.
    screen.getByRole('tab', { name: 'Audio' }).click();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Audio' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByRole('tab', { name: 'Assistance' })).toBeInTheDocument();
  });
});

/** Kept so the JSX helper's type import is referenced, not merely present. */
export type { JSX };