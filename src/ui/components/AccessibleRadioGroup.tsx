/**
 * An accessible radio group: one choice out of several, as real radio semantics.
 *
 * ## Why this exists
 *
 * Phase 21 found `critical: aria-allowed-attr` on three `button[role="radio"]` nodes in the Settings
 * dialog. The rule was correct and the fix was **not** to remove the role. Those controls *are*
 * radios - a mutually exclusive choice out of a small set, inside a `role="radiogroup"` - and the
 * markup was claiming two incompatible roles at once: `role="radio"` with `aria-checked`, **and**
 * `aria-pressed`. `aria-pressed` is a `button` state and `aria-checked` is the `radio` state, so the
 * element was a radio that also claimed to be a toggle button. Screen readers disagree about what
 * to announce, and axe's `aria-allowed-attr` rule is the one place that disagreement becomes a
 * named defect.
 *
 * Picking the role and keeping only one state attribute is the whole fix. The other half of the
 * role is the keyboard contract, which is why this is a component rather than a fixup at each site:
 *
 * - **Roving tabindex.** Exactly one member is in the tab order - the checked one, or the first when
 *   nothing is checked - and the rest carry `tabIndex={-1}`. A radio group is one tab stop. Without
 *   this, Tab walks three controls to express one choice.
 * - **Arrow keys move and select.** `ArrowRight`/`ArrowDown` and `ArrowLeft`/`ArrowUp` move focus to
 *   the next or previous member **and check it**, which is what `role="radio"` promises and what a
 *   plain button does not. `Home` and `End` go to the ends.
 * - **Selection follows focus, so focus and `aria-checked` cannot disagree.** Each move calls the
 *   change handler and then focuses, so the element the learner is on is the element that is checked.
 * - **Wrap-around**, because the ARIA authoring practice calls for it and a learner who arrows past
 *   the end should meet the other end rather than nothing.
 * - **`aria-pressed` is not written at all.** Not hidden, not conditionally omitted: absent, so a
 *   later edit that reaches for it fails the axe run rather than passing it.
 *
 * ## Why the label is a prop and not inferred
 *
 * `renderOption` receives the option and the checked flag and returns the member's children, so a
 * caller can put a title and a description inside a radio (the Settings theme picker does) without
 * this component knowing anything about option shapes. It writes no text of its own.
 *
 * ## Touch targets
 *
 * Every member carries `style={{ minWidth: '44px', minHeight: '44px' }}` inline. This is the Phase 20
 * precedent and the reason is not that the value is special: jsdom computes no layout, so a
 * stylesheet rule cannot be asserted by a component test at all, and an inline declaration can. The
 * colocated stylesheet carries the same floor for the real rendering.
 *
 * ## What this does not do
 *
 * It does not own the value. The caller holds the selected id and re-renders; this component only
 * reports a click or an arrow. That keeps the store write in the application layer rather than in a
 * presentational component, which is the Phase 9 dispatch-ownership rule restated.
 */
import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * One member's identity.
 *
 * The **narrowest** shape a member needs: an id, and whatever else the caller's own option type
 * carries. `AccessibleRadioGroup<TId, TExtra>` keeps `TExtra`, so `renderOption` receives the
 * caller's full option - a theme with a title and a description, a locale with a label - while this
 * component still knows nothing about option shapes. Generifying over `TId` alone would force
 * `renderOption` to re-look-up the option, which is how a caller ends up indexing a label table by
 * `any`.
 */
export interface AccessibleRadioOption<TId extends string> {
  /** The value this option selects. */
  readonly id: TId;
}

/**
 * A member as `renderOption` receives it: the id, plus the caller's own fields, unchanged.
 *
 * `TExtra` is a type-only parameter with no runtime binding, which is the point - the component
 * carries no knowledge of option shapes, and a caller's `title`/`description`/`locale` arrive intact
 * rather than being re-derived by an index lookup that would need an `any`.
 */
export type AccessibleRadioMember<TId extends string, TExtra> = AccessibleRadioOption<TId> & TExtra;

export interface AccessibleRadioGroupProps<TId extends string, TExtra = unknown> {
  /** The accessible name of the group. Rendered as `aria-label`. */
  readonly label: string;
  /** Every option, in the order arrows traverse them. */
  readonly options: readonly AccessibleRadioMember<TId, TExtra>[];
  /** The chosen id. `null` is allowed, and then the first member takes the tab stop. */
  readonly value: TId | null;
  /** A member was chosen - by click, by `Space`, by `Enter`, or by an arrow. */
  readonly onChange: (id: TId) => void;
  /** The member's own children. */
  readonly renderOption: (option: AccessibleRadioMember<TId, TExtra>, checked: boolean) => ReactNode;
  /** Extra class names on the group. */
  readonly className?: string;
}

/** One index, bounded into `[0, count)`, so arrows wrap rather than stopping at an end. */
function wrap(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

export function AccessibleRadioGroup<TId extends string, TExtra = unknown>({
  label,
  options,
  value,
  onChange,
  renderOption,
  className,
}: AccessibleRadioGroupProps<TId, TExtra>): ReactNode {
  const memberRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const count = options.length;
  const selectedIndex = options.findIndex((option) => option.id === value);
  // The tab stop is never absent: with nothing checked the first member carries it, so the group is
  // always reachable with Tab and a group of one is still reachable.
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;

  /**
   * Check a member and put focus on it.
   *
   * `onChange` first, then `focus`, so the element being focused is the element that will be
   * rendered as checked. The reverse order focuses a control that is about to become unchecked,
   * which is a frame a screen reader can announce as "not checked" on a control the learner is
   * standing on.
   */
  const selectAt = useCallback(
    (index: number) => {
      const target = wrap(index, count);
      const option = options[target];
      if (option === undefined) return;
      if (option.id !== value) onChange(option.id);
      memberRefs.current[target]?.focus();
    },
    [count, onChange, options, value],
  );

  return (
    <div
      className={className}
      role="radiogroup"
      aria-label={label}
      data-radio-group={label}
    >
      {options.map((option, index) => {
        const checked = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStopIndex ? 0 : -1}
            ref={(node) => {
              memberRefs.current[index] = node;
            }}
            onClick={() => onChange(option.id)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              let next: number | null = null;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = count - 1;
              if (next === null) return;
              // The arrows move within the group. Left without this they scroll the panel behind the
              // dialog, which is the page moving under a modal - the exact thing `aria-modal` says
              // is not happening.
              event.preventDefault();
              selectAt(next);
            }}
            style={{ minWidth: '44px', minHeight: '44px' }}
            data-radio-member={option.id}
          >
            {renderOption(option, checked)}
          </button>
        );
      })}
    </div>
  );
}
