/**
 * Phase 21: the Settings dialog's radio groups, and the `aria-allowed-attr` defect axe found.
 *
 * ## The defect
 *
 * `npm run test:a11y` reported `critical: aria-allowed-attr` on **three** `button[role="radio"]` nodes,
 * reproducing on all six runnable matrix cells. The markup was:
 *
 * ```tsx
 * <button type="button" role="radio" aria-checked={…} aria-pressed={…} onClick={…}>
 * ```
 *
 * The role was not the problem - a theme choice and a language choice **are** radios: one mutually
 * exclusive selection out of a small set, inside a `role="radiogroup"`. The problem was claiming **two**
 * states: `aria-checked` is the `radio` state and `aria-pressed` is the `button` state, so each element
 * was simultaneously a radio and a toggle button. `aria-allowed-attr` is where that disagreement becomes
 * a named, critical defect, and a screen reader has no single answer for what to announce.
 *
 * ## What was fixed, and why this file asserts the whole contract
 *
 * One role, one state attribute, plus the keyboard contract that role promises - which the old markup
 * did not have at all. Every arrow key and every roving-tabindex assertion below exists because
 * "remove `aria-pressed`" alone would have produced a radiogroup with no way to move within it.
 *
 * ## Why these tests exist even though the axe run covers the same nodes
 *
 * Because jsdom and axe answer different questions. axe says "these attributes are not allowed on this
 * role"; it cannot say "arrow keys do not move focus", "the group has one tab stop", or "the selected
 * member is distinguishable without colour". Those are the properties a learner actually uses, and they
 * are the ones that would be silently lost by a well-meaning edit.
 *
 * ## No colour is asserted
 *
 * jsdom computes no colours. The non-colour half of "which one is selected" is asserted as **markup and
 * ARIA** - the `✓` character is in the DOM, and `aria-checked` names the member - which is exactly the
 * part a colour-blind learner and a screen reader depend on. The contrast half is the axe run's job and
 * is reported there, not claimed here.
 */
import { useState, type JSX } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AccessibleRadioGroup } from '@/ui/components/AccessibleRadioGroup';
import { SettingsModal } from '@/ui/components/SettingsModal';

afterEach(cleanup);

const OPTIONS = [
  { id: 'one', title: 'First' },
  { id: 'two', title: 'Second' },
  { id: 'three', title: 'Third' },
] as const;

type OptionId = (typeof OPTIONS)[number]['id'];

interface GroupConfig {
  /** The initially checked member. `null` means nothing is checked. */
  readonly initial?: OptionId | null;
  /** Called on every selection, so a test can assert the value rather than the render. */
  readonly onChange?: (id: OptionId) => void;
  /** The group's accessible name. */
  readonly label?: string;
}

/**
 * Render a controlled group.
 *
 * Controlled, not uncontrolled, because the component's contract is that it **reports** a choice and the
 * **caller owns the value** - a test that only read the render could not tell "the arrow checked a
 * member" from "the arrow moved focus over a member that happened to be checked already".
 */
function renderGroup(config: GroupConfig = {}): { readonly members: () => HTMLElement[] } {
  function Harness(): JSX.Element {
    const [value, setValue] = useState<OptionId | null>(config.initial ?? 'one');
    return (
      <AccessibleRadioGroup
        label={config.label ?? 'Choices'}
        options={OPTIONS}
        value={value}
        onChange={(id) => {
          setValue(id);
          config.onChange?.(id);
        }}
        renderOption={(option, checked) => (
          <>
            {checked ? (
              <span className="mark" aria-hidden="true">
                ✓
              </span>
            ) : null}
            <strong>{option.title}</strong>
          </>
        )}
      />
    );
  }
  render(<Harness />);
  return { members: () => screen.getAllByRole('radio') };
}

// ── 1. The role, and the absence of the attribute axe objected to ──────────

describe('a radio group claims one role and one state', () => {
  it('every member is a radio with exactly one state attribute', () => {
    renderGroup({});
    const members = screen.getAllByRole('radio');
    expect(members).toHaveLength(OPTIONS.length);

    for (const member of members) {
      // The defect itself. `aria-pressed` is a `button` state; on `role="radio"` it is not allowed,
      // and it was present on all three nodes the axe run reported.
      expect(
        member.hasAttribute('aria-pressed'),
        'a radio still carries aria-pressed, which is the button state and the axe violation',
      ).toBe(false);
      // And the state a radio *does* have is present and boolean, not a truthy string.
      expect(['true', 'false']).toContain(member.getAttribute('aria-checked'));
    }
  });

  it('the group is a radiogroup with an accessible name', () => {
    renderGroup({ label: 'UI theme choices' });
    const group = screen.getByRole('radiogroup', { name: 'UI theme choices' });
    expect(within(group).getAllByRole('radio')).toHaveLength(OPTIONS.length);
  });
});

// ── 2. Roving tabindex: a radio group is one tab stop ─────────────────────

describe('a radio group is one tab stop', () => {
  it('the checked member is the tab stop and the rest are not', () => {
    renderGroup({ initial: 'two' });
    const members = screen.getAllByRole('radio');
    const tabIndexes = members.map((member) => member.getAttribute('tabindex'));
    expect(tabIndexes, 'the checked member is not the single tab stop').toEqual(['-1', '0', '-1']);
    expect(members[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('with nothing checked the first member takes the tab stop, so the group is still reachable', () => {
    renderGroup({ initial: null });
    const members = screen.getAllByRole('radio');
    expect(members[0]).toHaveAttribute('tabindex', '0');
    expect(members.map((m) => m.getAttribute('tabindex')).slice(1)).toEqual(['-1', '-1']);
    expect(members[0], 'the first member claims the tab stop but is not focusable').toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('selecting by click moves the tab stop to the selected member', () => {
    renderGroup({ initial: 'one' });
    const members = screen.getAllByRole('radio');
    fireEvent.click(members[2]!);
    const after = screen.getAllByRole('radio');
    expect(after.map((m) => m.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  it('every member meets the 44 CSS-pixel floor inline', () => {
    // Phase 20's precedent, and the reason is jsdom: it computes no layout, so a stylesheet rule cannot
    // be asserted at all and an inline declaration can.
    renderGroup({});
    for (const member of screen.getAllByRole('radio')) {
      expect(member.style.minWidth).toBe('44px');
      expect(member.style.minHeight).toBe('44px');
    }
  });
});

// ── 3. Arrows move and select ──────────────────────────────────────────────

describe('the arrow keys move focus and check, as role=radio promises', () => {
  it.each([
    ['ArrowRight', 1],
    ['ArrowDown', 1],
  ] as const)('%s moves to the next member and checks it', (key, expectedIndex) => {
    renderGroup({ initial: 'one' });
    const members = screen.getAllByRole('radio');
    members[0]!.focus();

    fireEvent.keyDown(members[0]!, { key });

    const after = screen.getAllByRole('radio');
    expect(after[expectedIndex], `${key} did not check the next member`).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(after[0], `${key} left the previous member checked as well`).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(document.activeElement, `${key} did not move focus`).toBe(after[expectedIndex]);
  });

  it.each([
    ['ArrowLeft', 1],
    ['ArrowUp', 1],
  ] as const)('%s moves to the previous member and checks it', (key, fromIndex) => {
    renderGroup({ initial: 'two' });
    const members = screen.getAllByRole('radio');
    members[fromIndex]!.focus();

    fireEvent.keyDown(members[fromIndex]!, { key });

    const after = screen.getAllByRole('radio');
    expect(after[0]).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(after[0]);
  });

  it('wraps around at both ends, so arrowing past the end meets the other end', () => {
    renderGroup({ initial: 'one' });
    fireEvent.keyDown(screen.getAllByRole('radio')[0]!, { key: 'ArrowLeft' });
    const wrapped = screen.getAllByRole('radio');
    expect(wrapped[OPTIONS.length - 1], 'ArrowLeft at the first member did not wrap to the last').toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.keyDown(wrapped[OPTIONS.length - 1]!, { key: 'ArrowRight' });
    expect(
      screen.getAllByRole('radio')[0],
      'ArrowRight at the last member did not wrap to the first',
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('Home and End go to the ends', () => {
    renderGroup({ initial: 'two' });
    const members = screen.getAllByRole('radio');
    members[1]!.focus();

    fireEvent.keyDown(members[1]!, { key: 'End' });
    const atEnd = screen.getAllByRole('radio');
    expect(atEnd[OPTIONS.length - 1]).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(atEnd[OPTIONS.length - 1]);

    fireEvent.keyDown(atEnd[OPTIONS.length - 1]!, { key: 'Home' });
    const atHome = screen.getAllByRole('radio');
    expect(atHome[0]).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(atHome[0]);
  });

  it('suppresses the arrows default, so the page behind does not scroll', () => {
    renderGroup({ initial: 'one' });
    const member = screen.getAllByRole('radio')[0]!;
    member.focus();

    const handled = fireEvent.keyDown(member, { key: 'ArrowDown' });
    // `fireEvent` returns `false` when the event's default was prevented - which is the assertion.
    expect(handled, 'ArrowDown was not prevented, so it would scroll the page behind the dialog').toBe(
      false,
    );
  });

  it('an unrelated key does nothing', () => {
    // The negative half: a handler that checked on any key would pass every test above.
    renderGroup({ initial: 'one' });
    const members = screen.getAllByRole('radio');
    fireEvent.keyDown(members[0]!, { key: 'x' });
    const after = screen.getAllByRole('radio');
    expect(after[0]).toHaveAttribute('aria-checked', 'true');
    expect(after[1]).toHaveAttribute('aria-checked', 'false');
  });
});

// ── 4. Selection is not communicated by colour alone ───────────────────────

describe('the selected member is identifiable without colour', () => {
  it('carries exactly one mark, on the checked member, and the mark is aria-hidden', () => {
    // `aria-checked` is the machine channel and the mark is the human one. A screen reader that read
    // both would say "checked First check mark", so the mark is hidden from the accessibility tree.
    renderGroup({ initial: 'two' });
    const marks = document.querySelectorAll('.mark');
    expect(marks, 'the selected member has no non-colour mark').toHaveLength(1);
    expect(marks[0]?.closest('button')).toBe(screen.getByRole('radio', { name: /^Second/ }));
    expect(marks[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the mark moves with the selection', () => {
    renderGroup({ initial: 'one' });
    expect(document.querySelectorAll('.mark')).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('radio')[2]!);
    const marks = document.querySelectorAll('.mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.closest('button')).toBe(screen.getByRole('radio', { name: /^Third/ }));
  });
});

// ── 5. The two real call sites ─────────────────────────────────────────────

describe('the Settings dialog uses it for both of its single-choice sets', () => {
  function openTab(name: string): void {
    render(<SettingsModal currentTheme="dark" onThemeChange={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name }));
  }

  it('the theme tab is a radiogroup of three radios with no aria-pressed', () => {
    openTab('Theme');
    const group = screen.getByRole('radiogroup', { name: 'UI theme choices' });
    const themes = within(group).getAllByRole('radio');
    expect(themes).toHaveLength(3);
    for (const theme of themes) {
      expect(theme.hasAttribute('aria-pressed'), 'a Settings radio still carries aria-pressed').toBe(false);
    }
  });

  it('the language tab is a radiogroup too, with one tab stop', () => {
    openTab('Language');
    const group = screen.getByRole('radiogroup', { name: 'Language choices' });
    const languages = within(group).getAllByRole('radio');
    expect(languages.length).toBeGreaterThan(1);
    expect(
      languages.filter((language) => language.getAttribute('tabindex') === '0'),
      'the language group has more than one tab stop, so it is not a radio group',
    ).toHaveLength(1);
  });

  it('the checked theme is the tab stop, because the modal was opened on night', () => {
    openTab('Theme');
    const themes = within(screen.getByRole('radiogroup', { name: 'UI theme choices' })).getAllByRole('radio');
    expect(themes[0]).toHaveAttribute('tabindex', '0');
    expect(themes[1]).toHaveAttribute('tabindex', '-1');
  });
});
