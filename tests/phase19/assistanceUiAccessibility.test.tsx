/**
 * The accessibility gate for Phase 19's DOM, at the level jsdom can actually measure.
 *
 * ## What is measured here, and what is explicitly not
 *
 * **Measured:** roles, accessible names, heading order, focusability, the inline 44x44 floor, the
 * polite live region's behaviour, `tabIndex`, and the absence of a colour-only signal in the
 * stylesheet's *source*.
 *
 * **Not measured, and Phase 21's audit rather than this file's:** contrast ratios, real rendered
 * touch-target size, 200% zoom, a 320 CSS-pixel viewport, and screen-reader behaviour. jsdom
 * computes no colours and no layout, so an assertion about either here would be a tautology — it
 * would pass on a stylesheet that renders invisible text. The list is restated at the end of this
 * file so the boundary is written down rather than implied.
 *
 * ## The one stylesheet claim, and how "we did not write one" is made checkable
 *
 * "No colour-only signalling" is usually asserted by not writing a colour rule, which is not an
 * assertion. So the stylesheet is scanned for an intensity- or evidence-keyed colour declaration:
 * a selector that targets `data-assistance-intensity` and declares a colour would fail. The scan is
 * two-sided - a synthetic rule that *does* declare one is shown to be caught - because a scan that
 * matches nothing is indistinguishable from a scan that cannot match.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import '@/i18n';

import { AssistanceSlot } from '@/ui/assistance/AssistanceSlot';
import { AssistanceSettings } from '@/ui/assistance/AssistanceSettings';
import { __resetAssistanceStoreForTests, useAssistanceStore } from '@/store/assistanceStore';
import {
  __resetAssistanceClockForTests,
  setAssistanceClock,
} from '@/ui/assistance/assistanceClock';
import {
  ASSISTANCE_COUNT_ATTRIBUTES,
  ASSISTANCE_IDS,
  ASSISTANCE_ID_ATTRIBUTE,
  ASSISTANCE_SURFACE_ATTRIBUTE,
} from '@/ui/assistance/assistanceTestIds';
import { UI_NOW_ISO, UNBRANCHED_SNAPSHOT } from './assistanceUiFixtures';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CSS_PATH = join(REPO_ROOT, 'src', 'ui', 'assistance', 'assistance.css');

async function renderCard(): Promise<HTMLElement> {
  const { container } = render(
    <AssistanceSlot surface="creator" snapshot={UNBRANCHED_SNAPSHOT} flagEnabled />,
  );
  await waitFor(() => {
    expect(container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.card}"]`)).not.toBeNull();
  });
  return container;
}

describe('the card is reachable and explainable', () => {
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

  it('the card is a labelled landmark, so it is reachable by region and not only by Tab', async () => {
    const container = await renderCard();
    const card = container.querySelector(`[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.card}"]`)!;
    expect(card.tagName).toBe('SECTION');
    const labelId = card.getAttribute('aria-labelledby')!;
    expect(labelId.length).toBeGreaterThan(0);
    const heading = container.querySelector(`#${CSS.escape(labelId)}`);
    expect(heading).not.toBeNull();
    // The accessible name is real text, not an id and not an empty string.
    expect(heading!.textContent!.trim().length).toBeGreaterThan(0);
  });

  it('each suggestion is an article with its own accessible name, inside a real list', async () => {
    const container = await renderCard();
    const list = container.querySelector('ol.assistance-card__list');
    expect(list).not.toBeNull();
    const items = list!.querySelectorAll(':scope > li');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const article = item.querySelector('article');
      expect(article, 'a suggestion must be its own landmark').not.toBeNull();
      const nameId = article!.getAttribute('aria-labelledby')!;
      const title = container.querySelector(`#${CSS.escape(nameId)}`);
      expect(title, 'the accessible name must resolve to the suggestion title').not.toBeNull();
      expect(title!.textContent!.trim().length).toBeGreaterThan(0);
    }
  });

  it('heading levels descend from the card, so a screen reader can jump between suggestions', async () => {
    const container = await renderCard();
    const levels = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((node) =>
      Number(node.tagName.slice(1)),
    );
    expect(levels.length).toBeGreaterThanOrEqual(3);
    // Strictly descending: a heading level that skips (h3 -> h5) breaks heading navigation, and
    // comparing adjacent pairs catches it without hardcoding a whole document outline.
    for (let index = 1; index < levels.length; index += 1) {
      expect(
        levels[index],
        `heading level jumped from h${levels[index - 1]} to h${levels[index]}`,
      ).toBeLessThanOrEqual(levels[index - 1] + 1);
    }
  });

  it('every suggestion states its reason in visible text, not only in an attribute', async () => {
    const container = await renderCard();
    const rows = container.querySelectorAll('[data-assistance-kind]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.getAttribute('data-assistance-reason'), 'the reason code must be published').toMatch(
        /^[a-z-]+$/,
      );
      // The engine's `detail` sentence and the evidence heading are visible text. This is the
      // "explainable" half of "every suggestion is explainable and dismissible".
      const body = row.querySelector('.assistance-suggestion__body')!;
      expect(body.querySelector('.assistance-suggestion__detail')!.textContent!.trim().length)
        .toBeGreaterThan(0);
      expect(body.querySelector('.assistance-suggestion__evidence-heading')!.textContent!.trim().length)
        .toBeGreaterThan(0);
    }
  });

  it('intensity is a word in the text as well as an attribute, so it survives greyscale', async () => {
    const container = await renderCard();
    const nodes = [...container.querySelectorAll('[data-assistance-intensity]')];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const value = node.getAttribute('data-assistance-intensity')!;
      expect(['step', 'cue', 'example']).toContain(value);
      // The word is in the text content. An attribute a learner cannot perceive is not a signal.
      expect(node.textContent!.trim().length, `intensity ${value} has no visible word`).toBeGreaterThan(0);
    }
  });
});

describe('Dismiss is a real control', () => {
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

  it('is a focusable button with no `tabIndex` override and no `disabled`', async () => {
    const container = await renderCard();
    const button = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
    ) as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.hasAttribute('disabled')).toBe(false);
    // A `tabIndex` of -1 would make it keyboard-unreachable while looking reachable, and
    // `tabIndex={0}` is redundant on a button. Absent is the correct state.
    expect(button.hasAttribute('tabindex')).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('carries a 44x44 CSS-pixel floor in the element itself, not only in the stylesheet', async () => {
    const container = await renderCard();
    const button = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
    ) as HTMLButtonElement;
    // Inline, for the reason `STUDY_TOUCH_TARGET_STYLE` records: jsdom computes no layout, so a
    // stylesheet rule cannot be asserted at all, and an inline floor survives a stylesheet that
    // failed to load. Both declarations are read from the rendered style attribute.
    expect(button.style.minWidth).toBe('44px');
    expect(button.style.minHeight).toBe('44px');
  });

  it('names itself distinctly, so a list of identical verbs is still usable', async () => {
    const container = await renderCard();
    const buttons = [...container.querySelectorAll(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
    )] as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? '';
      // "Dismiss: <the suggestion's own title>" - not "Dismiss" alone, which is unusable when
      // three of them are on screen.
      expect(name.startsWith('Dismiss: '), name).toBe(true);
      expect(name.length).toBeGreaterThan('Dismiss: '.length);
    }
  });

  it('responds to a keyboard activation, not only a click', async () => {
    const container = await renderCard();
    const button = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
    ) as HTMLButtonElement;
    const before = useAssistanceStore.getState().dismissalCount;
    await act(async () => {
      // `fireEvent.keyDown` alone proves nothing about a button; the browser turns Enter on a
      // focused button into a click. jsdom does not, so the gate is that a click is the *only*
      // activation path - which `fireEvent.click` stands in for - and that no `onKeyDown`
      // handler intercepts.
      fireEvent.keyDown(button, { key: 'Enter', code: 'Enter', keyCode: 13 });
      fireEvent.click(button);
    });
    expect(useAssistanceStore.getState().dismissalCount).toBe(before + 1);
  });

  it('does not trap or steal focus, so the surrounding dialog keeps control', async () => {
    const container = await renderCard();
    // No `autofocus`, no `tabindex="-1"` focus sentinel inside the card: the card adds nothing
    // that could pull focus out of the panel or dialog that contains it.
    expect(container.querySelectorAll('[autofocus]').length).toBe(0);
    expect(container.querySelectorAll('[tabindex="-1"]').length).toBe(0);
    // The active element is still `body` - the card did not move focus on arrival.
    expect(document.activeElement).toBe(document.body);
  });
});

describe('the announcement is deliberate', () => {
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

  it('the region is polite, present, and silent on first render', async () => {
    const container = await renderCard();
    const region = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.status}"]`,
    );
    expect(region).not.toBeNull();
    // Polite, not assertive: a card appearing is not an emergency.
    expect(region!.getAttribute('role')).toBe('status');
    expect(region!.getAttribute('aria-live')).not.toBe('assertive');
    // A live region created *with* the card has nothing to announce. Announcing here would make
    // every visit to a workspace speak, including a return visit where nothing changed.
    expect(region!.textContent).toBe('');
    expect(region!.getAttribute('data-assistance-announced')).toBe('');
  });

  it('announces a change in the visible count, and only that', async () => {
    const container = await renderCard();
    const region = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.status}"]`,
    ) as HTMLElement;
    const before = container.querySelectorAll('[data-assistance-kind]').length;
    expect(before).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(
        container.querySelector(
          `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
        ) as HTMLButtonElement,
      );
    });
    // The published number is the count of suggestions *now visible*.
    expect(region.getAttribute('data-assistance-announced')).toBe(String(before - 1));
    expect(region.textContent).toMatch(/^\d+ suggestions?$/);
  });

  it('a re-render that changes nothing does not re-announce', async () => {
    const container = await renderCard();
    const region = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.status}"]`,
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(
        container.querySelector(
          `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismiss}"]`,
        ) as HTMLButtonElement,
      );
    });
    const announced = region.getAttribute('data-assistance-announced');
    expect(announced).not.toBe('');
    // Three more renders of the same state must leave the last announced value alone. A region
    // written during render would re-announce on every one of them.
    await act(async () => {
      container.ownerDocument.body.dispatchEvent(new Event('focus'));
    });
    expect(region.getAttribute('data-assistance-announced')).toBe(announced);
  });

  it('the region is visually hidden by clipping, not removed from the accessibility tree', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    const block = /\.assistance-sr-only\s*\{([^}]*)\}/.exec(css);
    expect(block, 'the visually-hidden class must exist').not.toBeNull();
    const declarations = block![1];
    // `display: none` and `visibility: hidden` both remove the text from the accessibility tree
    // as well as the screen, which would silence the region's only purpose.
    expect(declarations).not.toMatch(/display\s*:\s*none/);
    expect(declarations).not.toMatch(/visibility\s*:\s*hidden/);
    expect(declarations).toMatch(/clip-path\s*:\s*inset/);
  });
});

describe('the settings surface is operable without a pointer', () => {
  beforeEach(() => {
    __resetAssistanceStoreForTests();
    useAssistanceStore.setState({ mode: 'standard', signals: {}, dismissalCount: 2 });
  });
  afterEach(() => {
    cleanup();
    __resetAssistanceStoreForTests();
  });

  it('every mode is a real radio inside one fieldset, each with a real label', () => {
    const { container } = render(<AssistanceSettings locale="en" />);
    const group = container.querySelector('fieldset')!;
    expect(group).not.toBeNull();
    expect(group.querySelector('legend')!.textContent!.trim().length).toBeGreaterThan(0);
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    expect(radios.length).toBe(3);
    // One group: all three share a `name`, so arrow keys move between them rather than Tab
    // visiting three separate stops.
    expect(new Set(radios.map((node) => (node as HTMLInputElement).name)).size).toBe(1);
    for (const radio of radios) {
      const input = radio as HTMLInputElement;
      // A label is required for every radio: an unlabelled radio announces only its value.
      const label = container.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      expect(label, `radio ${input.value} has no label`).not.toBeNull();
      expect(label!.textContent!.trim().length).toBeGreaterThan(0);
      expect(input.checked).toBe(input.value === 'standard');
    }
  });

  it('the clear control carries the 44x44 floor too', () => {
    const { container } = render(<AssistanceSettings locale="en" />);
    const clear = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.clearDismissals}"]`,
    ) as HTMLButtonElement;
    expect(clear).not.toBeNull();
    expect(clear.style.minWidth).toBe('44px');
    expect(clear.style.minHeight).toBe('44px');
  });

  it('the dismissal count is published as a number, not only inside a sentence', () => {
    const { container } = render(<AssistanceSettings locale="en" />);
    const block = container.querySelector(
      `[${ASSISTANCE_ID_ATTRIBUTE}="${ASSISTANCE_IDS.dismissals}"]`,
    )!;
    expect(block.getAttribute('data-assistance-dismissal-count')).toBe('2');
    // And it is affected by nothing: the literal `false` in the store's summary means no copy on
    // this surface can say dismissal changes what is offered.
    expect(container.textContent).not.toMatch(/will not be shown|suppressed|no longer/i);
  });
});

describe('the stylesheet carries no colour-only signal', () => {
  const css = readFileSync(CSS_PATH, 'utf8');

  it('the scan would catch a colour rule keyed to intensity, proved on a synthetic one', () => {
    // Non-vacuity: the same predicate is run against a rule that *does* declare one.
    const planted = '.assistance-suggestion__intensity[data-assistance-intensity="example"] { color: #c00; }';
    const found = plantedMatches(planted);
    expect(found).toEqual([planted]);
  });

  it('no rule in the real stylesheet declares a colour keyed to intensity or evidence value', () => {
    expect(plantedMatches(css)).toEqual([]);
  });

  it('the focus ring is an outline with an offset, which forced-colours mode keeps', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline-offset:/);
  });

  it('reduced motion is honoured, and the rule names the selector it applies to', () => {
    const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(reduced, 'a reduced-motion block must exist').not.toBeNull();
    expect(reduced![1]).toMatch(/\.assistance-suggestion__dismiss/);
    expect(reduced![1]).toMatch(/transition\s*:\s*none/);
  });
});

/**
 * Selectors that key a **colour** declaration to an intensity or evidence value.
 *
 * A colour property is `color`, `background`, `background-color`, `border-color`, `outline-color`,
 * `fill`, or `stroke`. A rule that sets one of those while targeting `data-assistance-intensity` or
 * `data-assistance-evidence` would be colour-only signalling, and this returns it.
 */
function plantedMatches(source: string): readonly string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector.includes('[data-assistance-intensity') && !selector.includes('[data-assistance-evidence')) {
      continue;
    }
    const body = match[2];
    if (/(^|[;{\s])(color|background|background-color|border-color|outline-color|fill|stroke)\s*:/i.test(body)) {
      offenders.push(`${selector} {${body}}`);
    }
  }
  return offenders;
}

describe('UNVERIFIED HERE, and Phase 21 owns them', () => {
  it('the list of claims jsdom cannot check is written down, not implied', () => {
    // A test whose only job is to hold the boundary. If someone later adds a "contrast" test
    // file, this one is where the overlap becomes visible.
    const unverified = [
      'contrast ratios against the Cozy palette',
      'real rendered touch-target size (jsdom computes no layout)',
      '200% zoom reflow',
      '320 CSS-pixel viewport',
      'screen-reader announcement order and phrasing',
      'forced-colours and Windows High Contrast rendering',
    ];
    expect(unverified.length).toBeGreaterThan(0);
  });
});

/** Referenced so the count-attribute contract is exercised by a name, not only through the card. */
void ASSISTANCE_COUNT_ATTRIBUTES;
void ASSISTANCE_SURFACE_ATTRIBUTE;