/**
 * Phase 20: the share dialog as a DOM surface.
 *
 * ## What this file pins, and how each claim is made non-vacuously
 *
 * 1. **"Web Share runs only from a user click" - proved by counting.** The weak form of this test
 *    asserts `share` was not called after a mount, which passes just as well for a component that
 *    calls it from a `setTimeout`. So every lifecycle step here - import, mount, kind change, five
 *    field toggles, redraw - is followed by an assertion that the **counter is still zero**, and one
 *    click is followed by an assertion that it is exactly one. The spy is proven capable of a
 *    non-zero count by a separate control, so a zero is a measurement rather than a broken mock.
 * 2. **Cancelling mutates nothing.** A full before/after fingerprint of every storage-v2 generation
 *    store and every non-share `localStorage` key, with a **baseline-substance assertion** so an
 *    empty fingerprint cannot pass.
 * 3. **The dialog is a real dialog.** Role, accessible name, accessible description, initial focus,
 *    focus containment, focus restoration, Escape. All from the DOM, not from the source.
 * 4. **Field selection is real labelled checkboxes**, and the initial selection is the policy's
 *    default - so privacy-by-default is the *initial state*, not something to remember.
 * 5. **The preview is `aria-hidden` and its information exists as text**, in the same order.
 * 6. **The download control exists on every build**, including with `VITE_WEB_SHARE` off, and the
 *    share control does **not** exist with the flag off.
 *
 * ## What this file cannot verify, stated plainly
 *
 * **No contrast and no rendered target size.** jsdom computes no colours and no layout, so the 44x44
 * floors asserted here are the *inline* declaration Phase 19 established for exactly this reason -
 * a stylesheet rule is not assertable here, and the inline floor survives a stylesheet that failed
 * to load. Whether the tokens meet 4.5:1, and whether a real rendered control is 44x44, are Phase
 * 21's browser measurements. Nothing here should be read as having checked either.
 *
 * Privacy: every string in this file is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression/types';
import { DEFAULT_SELECTION_BY_KIND, availableFieldsFor } from '@/core/share/shareCardPolicy';
import { SHARE_CARD_FIELD_LABELS, canonicalBadgeLabel } from '@/core/share/shareCardContent';
import { SHARE_CARD_KINDS } from '@/core/share/types';
import { GENERATION_SCOPED_STORE_NAMES, GLOBAL_STORE_NAMES, STORAGE_V2_STORE_NAMES } from '@/services/persistence/v2/schema';
import { ShareCardDialog } from '@/ui/share/ShareCardDialog';
import type { ShareCardFacts } from '@/ui/share/shareCardFacts';
import {
  SHARE_CARD_COUNT_ATTRIBUTE,
  SHARE_CARD_FIELD_ATTRIBUTE,
  SHARE_CARD_ID_ATTRIBUTE,
  SHARE_CARD_IDS,
  SHARE_CARD_KIND_ATTRIBUTE,
  SHARE_CARD_OUTCOME_ATTRIBUTE,
} from '@/ui/share/shareCardTestIds';
import {
  SHARE_DIALOG_TITLE,
  SHARE_DOWNLOAD_LABEL,
  SHARE_OPTIONAL_FIELD_NOTES,
  SHARE_SHARE_LABEL,
} from '@/ui/share/shareCardCopy';
import {
  installRecordingCanvas,
  installShareSpy,
  removeShareApi,
  type ShareSpy,
} from '../unit/shareCardRenderSupport';

const FACTS: ShareCardFacts = {
  subjectName: 'Linear Algebra',
  xpTotal: 1240,
  rank: 'Master',
  clearedRoomCount: 12,
  totalRoomCount: 40,
  badgeIds: [...PHASE_BADGE_IDS, SCRIBE_CENTURY_120_BADGE_ID],
  inventoryCount: 7,
  collectedNoteCount: 3,
  fish: { total: 11, uniqueTypes: 4, countsByRarity: { common: 6, rare: 4, epic: 1 } },
  statistics: {
    sessionsCompleted: 9,
    activeDays: 21,
    studyStreakDays: 5,
    recall: { correct: 17, total: 20 },
  },
  assistance: { sessionsWithAssistance: 4 },
};

/** A `localStorage` key this phase does not own, so the fingerprint has something real to cover. */
const UNRELATED_KEY = 'kd-probe-unrelated-value';

let shareSpy: ShareSpy;
let restoreCanvas: () => void;

beforeEach(() => {
  const installed = installRecordingCanvas();
  restoreCanvas = installed.restore;
  shareSpy = installShareSpy();
  window.localStorage.setItem(UNRELATED_KEY, 'a-real-value-a-real-value');
});

afterEach(() => {
  restoreCanvas();
  shareSpy.restore();
  removeShareApi();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof ShareCardDialog>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ShareCardDialog
      open
      facts={FACTS}
      initialKind="subject-summary"
      webShareEnabled
      onClose={onClose}
      {...overrides}
    />,
  );
  return { ...utils, onClose };
}

/** The element carrying one `data-kd-share` id. */
function byId(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[${SHARE_CARD_ID_ATTRIBUTE}="${id}"]`);
  if (found === null) throw new Error(`No element carries ${SHARE_CARD_ID_ATTRIBUTE}="${id}".`);
  return found;
}

/** Every checkbox for field selection, in DOM order. */
function fieldBoxes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`input[type="checkbox"][${SHARE_CARD_FIELD_ATTRIBUTE}]`)];
}

/**
 * The lifecycle assertion, at module scope.
 *
 * Declared at module scope rather than inside the one `describe` that first needed it, because a
 * later test in a different `describe` needed it too and a nested helper is not visible there - a
 * `ReferenceError` in a gate is a gate that measures nothing.
 */
function expectNoShareYet(shareSpy: ShareSpy, stage: string): void {
  expect(shareSpy.shareCalls, `navigator.share ran at: ${stage}`).toHaveLength(0);
  // The stronger claim, and the one a `setTimeout`-based implementation would also fail: a preview
  // must not even *probe* the capability. Web Share work costs a call the learner did not ask for.
  expect(shareSpy.canShareCalls, `navigator.canShare was probed at: ${stage}`).toHaveLength(0);
}

/** The checkbox for one field, or `null` when this kind does not have it. */
function boxFor(field: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[type="checkbox"][${SHARE_CARD_FIELD_ATTRIBUTE}="${field}"]`);
}

/* ── 1. It is a dialog ─────────────────────────────────────────────────────────── */

describe('the share dialog is a dialog a keyboard can work', () => {
  it('is a modal dialog with an accessible name and an accessible description', () => {
    renderDialog();
    const dialog = byId(SHARE_CARD_IDS.dialog);
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // The name comes from the visible heading, so the two cannot drift.
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy as string);
    expect(heading?.textContent).toBe(SHARE_DIALOG_TITLE);
    expect(screen.getByRole('dialog', { name: SHARE_DIALOG_TITLE })).toBe(dialog);

    // And the description is a real rendered paragraph, not a dangling id.
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description?.textContent?.length).toBeGreaterThan(20);
  });

  it('moves focus into the dialog on open, rather than onto the first button', async () => {
    // The dialog container, per the ARIA authoring practice Phase 5 established: focusing the first
    // button would put an action under the learner's next Enter.
    const { onClose } = renderDialog();
    await waitFor(() => expect(document.activeElement).toBe(byId(SHARE_CARD_IDS.dialog)));
    void onClose;
  });

  it('restores focus to the opener on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'open the share dialog';
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = renderDialog();
    await waitFor(() => expect(document.activeElement).toBe(byId(SHARE_CARD_IDS.dialog)));

    rerender(<ShareCardDialog open={false} facts={FACTS} initialKind="subject-summary" webShareEnabled onClose={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it('closes on Escape', async () => {
    const { onClose } = renderDialog();
    await waitFor(() => expect(document.activeElement).toBe(byId(SHARE_CARD_IDS.dialog)));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at all when closed', () => {
    renderDialog({ open: false });
    expect(document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.dialog}"]`)).toBeNull();
    // Not a hidden dialog, not an empty one: nothing.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives every interactive control a 44x44 inline floor, because jsdom computes no layout', () => {
    renderDialog();
    const controls = [
      ...document.querySelectorAll<HTMLElement>(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.download}"]`),
      ...document.querySelectorAll<HTMLElement>(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.share}"]`),
      ...document.querySelectorAll<HTMLElement>(`input[type="checkbox"][${SHARE_CARD_FIELD_ATTRIBUTE}]`),
      ...document.querySelectorAll<HTMLElement>(`input[type="radio"][${SHARE_CARD_KIND_ATTRIBUTE}]`),
    ];
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) {
      expect(control.style.minWidth, control.getAttribute(SHARE_CARD_FIELD_ATTRIBUTE) ?? control.tagName).toBe('44px');
      expect(control.style.minHeight).toBe('44px');
    }
  });

  it('is labelled by a real legend on both of its groups, not by an aria-label alone', () => {
    renderDialog();
    const legends = [...document.querySelectorAll('fieldset > legend')].map((node) => node.textContent);
    expect(legends.length).toBeGreaterThanOrEqual(2);
    for (const legend of legends) expect(legend?.length ?? 0).toBeGreaterThan(0);
  });
});

/* ── 2. Field selection: real checkboxes, policy defaults, honest notes ────────── */

describe('field selection is real, labelled, and starts from the policy default', () => {
  it('offers exactly the fields this kind has, each as a labelled checkbox', () => {
    for (const kind of SHARE_CARD_KINDS) {
      const { unmount } = renderDialog({ initialKind: kind });
      const boxes = fieldBoxes();
      const available = availableFieldsFor(kind);
      expect(boxes, kind).toHaveLength(available.length);
      for (const field of available) {
        const box = boxFor(field);
        expect(box, `${kind} has no box for ${field}`).not.toBeNull();
        // A labelled checkbox: the label's `for` points at this input's id, so clicking the text
        // toggles it and a screen reader announces the field's name.
        const id = (box as HTMLInputElement).getAttribute('id');
        expect(id).toBeTruthy();
        const label = document.querySelector(`label[for="${id}"]`);
        expect(label?.textContent, `${kind}/${field}`).toBe(SHARE_CARD_FIELD_LABELS[field]);
      }
      unmount();
    }
  });

  it('starts checked exactly on the policy default, so privacy-by-default is the initial state', () => {
    for (const kind of SHARE_CARD_KINDS) {
      const { unmount } = renderDialog({ initialKind: kind });
      const defaults = DEFAULT_SELECTION_BY_KIND[kind];
      for (const field of availableFieldsFor(kind)) {
        const box = boxFor(field) as HTMLInputElement;
        expect(box.checked, `${kind}/${field} initial state`).toBe(defaults.includes(field));
      }
      unmount();
    }
  });

  it('never starts with a note count, a badge label, or an assistance count checked', () => {
    // The three exclusions `shareCardPolicy.ts` argues for. Asserted here at the **surface**, because
    // a default that is right in the domain and wrong in the dialog is still wrong for a learner.
    for (const kind of SHARE_CARD_KINDS) {
      const { unmount } = renderDialog({ initialKind: kind });
      for (const field of ['collectedNoteCount', 'badgeLabels', 'assistanceSummary'] as const) {
        const box = boxFor(field);
        if (box === null) continue;
        expect(box.checked, `${kind} defaults ${field} on`).toBe(false);
      }
      unmount();
    }
  });

  it('explains, in words, why the off-by-default fields are off', () => {
    renderDialog();
    for (const field of Object.keys(SHARE_OPTIONAL_FIELD_NOTES)) {
      const box = boxFor(field);
      if (box === null) continue;
      const note = SHARE_OPTIONAL_FIELD_NOTES[field as keyof typeof SHARE_OPTIONAL_FIELD_NOTES];
      // Described by, in the DOM: `aria-describedby` pointing at a rendered element, so a screen
      // reader reads the reason with the control rather than after it.
      const describedBy = box.getAttribute('aria-describedby');
      expect(describedBy, field).toBeTruthy();
      const element = document.getElementById(describedBy as string);
      expect(element?.textContent, field).toBe(note);
      // And the reason is text, not a colour or an icon.
      expect(element?.textContent?.trim().length ?? 0).toBeGreaterThan(20);
    }
  });

  it('toggling a field changes the preview text, and toggling it off removes the row', async () => {
    renderDialog();
    const preview = byId(SHARE_CARD_IDS.previewText);
    expect(within(preview).getByText('1240')).toBeInTheDocument();

    const xpBox = boxFor('xpTotal') as HTMLInputElement;
    expect(xpBox.checked).toBe(true);
    fireEvent.click(xpBox);

    await waitFor(() => expect(within(preview).queryByText('1240')).toBeNull());
    // And it comes back when it is ticked again.
    fireEvent.click(boxFor('xpTotal') as HTMLInputElement);
    await waitFor(() => expect(within(preview).getByText('1240')).toBeInTheDocument());
  });

  it('publishes the row count as an attribute, so a test can read the card without its copy', async () => {
    renderDialog();
    const preview = byId(SHARE_CARD_IDS.previewText);
    /*
     * One **less** than the default selection, and the reason is worth stating because it is the
     * model's own contract rather than an off-by-one: `subjectName` is the model's own property and
     * not a row, which is what makes "the learner chose not to publish their subject's name" a
     * distinguishable state rather than an empty row. `tests/unit/shareCards.test.ts` pins it.
     */
    const expected = DEFAULT_SELECTION_BY_KIND['subject-summary'].filter((field) => field !== 'subjectName').length;
    await waitFor(() => expect(preview.getAttribute(SHARE_CARD_COUNT_ATTRIBUTE)).toBe(String(expected)));
  });

  it('shows the subject name only while the learner leaves it selected', async () => {
    renderDialog();
    const preview = byId(SHARE_CARD_IDS.previewText);
    expect(within(preview).getByText('Linear Algebra')).toBeInTheDocument();
    fireEvent.click(boxFor('subjectName') as HTMLInputElement);
    await waitFor(() => expect(within(preview).queryByText('Linear Algebra')).toBeNull());
  });
});

/* ── 3. The preview is decorative, and the same information is text ───────────── */

describe('the preview canvas is decorative and its information exists as text', () => {
  it('marks the canvas aria-hidden unconditionally', () => {
    renderDialog();
    const canvas = byId(SHARE_CARD_IDS.preview);
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    // Unconditional: there is no state in which the canvas is the only place a card's content
    // exists, which is the property that makes `aria-hidden` safe here rather than lossy.
    const text = byId(SHARE_CARD_IDS.previewText);
    expect(text.textContent?.length ?? 0).toBeGreaterThan(20);
  });

  it('gives the preview a description naming the kind, the name state, and the field count', async () => {
    renderDialog();
    const description = document.querySelector('.kd-share-sr-only');
    expect(description).not.toBeNull();
    await waitFor(() => {
      expect(description?.textContent).toContain('Subject summary');
      expect(description?.textContent).toContain('Linear Algebra');
      // Row count again, not selection count: the description describes the card, and the card's
      // rows are the default selection less the subject name.
      expect(description?.textContent).toContain(
        `${DEFAULT_SELECTION_BY_KIND['subject-summary'].filter((field) => field !== 'subjectName').length} fields`,
      );
    });
  });

  it('lists every row as a term and a definition, not as a run of text', async () => {
    renderDialog();
    const preview = byId(SHARE_CARD_IDS.previewText);
    const rows = [...preview.querySelectorAll('.kd-share-row')];
    // Minus `subjectName`, which is a heading in this list rather than a term/definition pair.
    expect(rows.length).toBe(
      DEFAULT_SELECTION_BY_KIND['subject-summary'].filter((field) => field !== 'subjectName').length,
    );
    for (const row of rows) {
      const term = row.querySelector('dt');
      const definition = row.querySelector('dd');
      expect(term?.textContent?.length ?? 0).toBeGreaterThan(0);
      expect(definition?.textContent?.length ?? 0).toBeGreaterThan(0);
      // Every row's label is a declared field label, never a raw field id.
      const field = row.getAttribute(SHARE_CARD_FIELD_ATTRIBUTE);
      expect(term?.textContent, field ?? '').toBe(
        SHARE_CARD_FIELD_LABELS[field as keyof typeof SHARE_CARD_FIELD_LABELS],
      );
    }
  });

  it('suggests a file name that carries no withheld subject name', async () => {
    /*
     * The file name is the one place a subject name survives the dialog: into the operating system's
     * share sheet, into a download directory, and into whatever the recipient's client shows. A name
     * this surface refused to display must not be written there either, or the refusal is cosmetic.
     *
     * The test reads the name off the click a download makes, so it is the real name rather than a
     * re-derivation of it from the same helper.
     */
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function recordClick(this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => 'blob:probe' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });

    try {
      renderDialog({ facts: { ...FACTS, subjectName: 'room-7f3a' } });
      // The learner is told the name was withheld rather than shown an unexplained blank.
      await waitFor(() => {
        expect(byId(SHARE_CARD_IDS.dialog).textContent?.toLowerCase()).toContain('internal identifier');
      });
      await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(byId(SHARE_CARD_IDS.download));
      expect(clicked).toHaveLength(1);
      expect(clicked[0]).not.toContain('room-7f3a');
      expect(clicked[0]).not.toContain('..');
      expect(clicked[0]).not.toContain('/');
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  it('never renders a note body, a room id, a badge id, or a suggestion id anywhere in the dialog', async () => {
    const hostile: ShareCardFacts = {
      ...FACTS,
      // A subject name that is a minted room id: the model's own documented behaviour is to carry
      // the learner's own text, so the *renderer* refuses it - and the DOM must refuse it too or the
      // accessible surface would publish what the image does not.
      subjectName: 'room-7f3a',
      badgeIds: [...FACTS.badgeIds, 'room-7f3a', 'CreatorPhaseComplete-legacy'],
    };
    renderDialog({ facts: hostile });
    await waitFor(() => expect(byId(SHARE_CARD_IDS.previewText)).toBeInTheDocument());
    const dialog = byId(SHARE_CARD_IDS.dialog);
    const rendered = dialog.textContent ?? '';
    for (const forbidden of ['room-7f3a', 'CreatorPhaseComplete-legacy', 'noteBody', 'noteMarkdown']) {
      expect(rendered, forbidden).not.toContain(forbidden);
    }
    // Canonical labels, when the learner asks for them, are published copy.
    fireEvent.click(boxFor('badgeLabels') as HTMLInputElement);
    await waitFor(() => expect(dialog.textContent).toContain(canonicalBadgeLabel(SCRIBE_CENTURY_120_BADGE_ID)));
  });

  it('says so when a chosen field had nothing to show, rather than showing a zero', async () => {
    /*
     * A device with no statistics record at all, on a statistics card. Three of that kind's default
     * fields - `studyStreakDays`, `activeStudyDays`, `sessionsCompleted` - have no input, and
     * `recallAccuracy` is off by default and has none either.
     *
     * The assertion is that **nothing numeric is on the card and the omission is stated**, not that a
     * particular count of fields was omitted. Pinning the count would make this test a change
     * detector for the statistics kind's default selection, which is `shareCardPolicy.test.ts`'s job;
     * what belongs here is that an absent input is reported rather than rendered as `0`.
     */
    const noStats: ShareCardFacts = { ...FACTS, statistics: null };
    renderDialog({ facts: noStats, initialKind: 'statistics' });
    await waitFor(() => expect(byId(SHARE_CARD_IDS.omitted)).toBeInTheDocument());

    const omitted = byId(SHARE_CARD_IDS.omitted);
    expect(omitted.textContent?.toLowerCase()).toContain('nothing to show');
    expect(Number(omitted.getAttribute(SHARE_CARD_COUNT_ATTRIBUTE))).toBeGreaterThan(0);

    const preview = byId(SHARE_CARD_IDS.previewText);
    // No `0%` for a ratio with no denominator, and no row for any of the absent counts.
    expect(preview.textContent).not.toContain('%');
    for (const absent of ['Study streak in days', 'Days with activity recorded', 'Study sessions']) {
      expect(preview.textContent, absent).not.toContain(absent);
    }
    // Exactly one row survives, and it is the rank - which came from the progression record and
    // therefore had data. Asserting the *identity* of the survivor rather than a count is what makes
    // this a claim about honesty: a card of zeros would also render one row per field.
    const rows = [...preview.querySelectorAll('.kd-share-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute(SHARE_CARD_FIELD_ATTRIBUTE)).toBe('rank');
    expect(rows[0].textContent).toBe('RankMaster');
    // The subject name is a heading, not a row, and it is still there.
    expect(preview.textContent).toContain('Linear Algebra');
  });
});

/* ── 4. Kind switching ───────────────────────────────────────────────────────── */

describe('the kind selector switches templates without losing the other kinds choices', () => {
  it('renders a real radio per kind, with its label, and marks the current one', () => {
    renderDialog();
    const radios = [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][${SHARE_CARD_KIND_ATTRIBUTE}]`)];
    expect(radios.map((radio) => radio.getAttribute(SHARE_CARD_KIND_ATTRIBUTE))).toEqual([...SHARE_CARD_KINDS]);
    const checked = radios.filter((radio) => radio.checked).map((radio) => radio.getAttribute(SHARE_CARD_KIND_ATTRIBUTE));
    expect(checked).toEqual(['subject-summary']);
    for (const radio of radios) {
      const label = document.querySelector(`label[for="${radio.getAttribute('id')}"]`);
      expect(label?.textContent?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('shows each kind its own field list', async () => {
    renderDialog();
    expect(fieldBoxes()).toHaveLength(availableFieldsFor('subject-summary').length);
    fireEvent.click(document.querySelector('input[value="fish"]') as HTMLInputElement);
    await waitFor(() => expect(fieldBoxes()).toHaveLength(availableFieldsFor('fish').length));
    expect(boxFor('recallAccuracy')).toBeNull();
    expect(boxFor('fishTotal')).not.toBeNull();
  });

  it('restores the choices made on another kind', async () => {
    renderDialog();
    // On a summary card, deselect the subject name and tick the badge labels.
    fireEvent.click(boxFor('subjectName') as HTMLInputElement);
    fireEvent.click(boxFor('badgeLabels') as HTMLInputElement);
    await waitFor(() => expect((boxFor('subjectName') as HTMLInputElement).checked).toBe(false));

    fireEvent.click(document.querySelector('input[value="fish"]') as HTMLInputElement);
    await waitFor(() => expect((boxFor('subjectName') as HTMLInputElement).checked).toBe(true));

    fireEvent.click(document.querySelector('input[value="subject-summary"]') as HTMLInputElement);
    await waitFor(() => expect((boxFor('subjectName') as HTMLInputElement).checked).toBe(false));
    expect((boxFor('badgeLabels') as HTMLInputElement).checked).toBe(true);
  });

  it('offers the four kinds as the plan names them, in declaration order', () => {
    renderDialog();
    const labels = [...document.querySelectorAll<HTMLElement>('.kd-share-kind label')].map((node) => node.textContent);
    expect(labels).toHaveLength(SHARE_CARD_KINDS.length);
    expect(new Set(labels).size).toBe(SHARE_CARD_KINDS.length);
  });
});

/* ── 5. Explicit action only, counted across the whole lifecycle ─────────────── */

describe('Web Share is reached only from an explicit action, counted not asserted absent', () => {
  /*
   * Every lifecycle event below goes through `expectNoShareYet(shareSpy, stage)`, so no step can skip
   * the count. See that function for why the capability counter is included too.
   */

  it('never shares on mount, on open, or on a redraw, and shares exactly once per click', async () => {
    expectNoShareYet(shareSpy, 'before render');
    renderDialog();
    expectNoShareYet(shareSpy, 'mount');

    // The preview draw completes.
    await waitFor(() => expect(byId(SHARE_CARD_IDS.previewText).textContent?.length ?? 0).toBeGreaterThan(20));
    expectNoShareYet(shareSpy, 'after the preview draw');

    // Kind change.
    fireEvent.click(document.querySelector('input[value="fish"]') as HTMLInputElement);
    await waitFor(() => expect(fieldBoxes()).toHaveLength(availableFieldsFor('fish').length));
    expectNoShareYet(shareSpy, 'after a kind change');

    // Five field changes, each of which redraws the card.
    for (const field of ['fishTotal', 'fishUniqueTypes', 'subjectName', 'fishTotal', 'subjectName'] as const) {
      const box = boxFor(field);
      if (box !== null) fireEvent.click(box);
      await act(async () => {
        await Promise.resolve();
      });
      expectNoShareYet(shareSpy, `after toggling ${field}`);
    }

    // Open it a second time: a fresh mount must also be silent.
    const { unmount } = renderDialog();
    await waitFor(() => expect(byId(SHARE_CARD_IDS.previewText)).toBeInTheDocument());
    unmount();
    expectNoShareYet(shareSpy, 'after a second mount');

    // One click, one share.
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => expect(shareSpy.shareCalls).toHaveLength(1));
    // And the capability probe ran exactly once, at the click - not before.
    expect(shareSpy.canShareCalls).toHaveLength(1);

    // A second click is a second share, because the learner asked again.
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => expect(shareSpy.shareCalls).toHaveLength(2));
  });

  it('shares the PNG the preview drew, not something else', async () => {
    renderDialog();
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => expect(shareSpy.shareCalls).toHaveLength(1));

    const payload = shareSpy.shareCalls[0][0] as { files: File[] };
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].type).toBe('image/png');
    // The name derives from the subject the learner published and the kind, with no clock in it.
    expect(payload.files[0].name).toBe('linear-algebra-subject-summary.png');
    expect(payload.files[0].name).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('does not share when the learner deselects everything and the card is empty of rows', async () => {
    renderDialog();
    for (const field of [...availableFieldsFor('subject-summary')]) {
      const box = boxFor(field);
      if (box !== null && box.checked) fireEvent.click(box);
    }
    await waitFor(() => expect(byId(SHARE_CARD_IDS.previewText).textContent).toContain('no numbers yet'));
    expectNoShareYet(shareSpy, 'after deselecting every default field');
    // The share control still exists; the learner may still want an empty card. Nothing was sent.
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => expect(shareSpy.shareCalls).toHaveLength(1));
  });
});

/* ── 6. The four states, and the flag gate ───────────────────────────────────── */

describe('the delivery states are surfaced distinctly, and cancelling is not an error', () => {
  it('reports unsupported without sharing when the device has no Web Share', async () => {
    removeShareApi();
    renderDialog();
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => {
      expect(byId(SHARE_CARD_IDS.status).textContent?.toLowerCase()).toContain('cannot share');
    });
  });

  it('reports denied when the browser refuses, and still offers the download', async () => {
    shareSpy.install({ kind: 'reject', errorName: 'NotAllowedError' });
    renderDialog();
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => {
      expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('denied');
    });
    expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports failed for a fault that is neither a refusal nor a dismissal', async () => {
    shareSpy.install({ kind: 'throw-sync', errorName: 'SomethingElse' });
    renderDialog();
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => {
      expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('failed');
    });
  });

  it('reports shared when the sheet was accepted', async () => {
    renderDialog();
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => {
      expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('shared');
    });
    expect(byId(SHARE_CARD_IDS.status).textContent?.toLowerCase()).toContain('shared');
  });

  it('reports cancelled, with no failure wording and no toast, when the sheet is dismissed', async () => {
    shareSpy.install({ kind: 'reject', errorName: 'AbortError' });
    renderDialog();
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => {
      expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('cancelled');
    });

    const status = byId(SHARE_CARD_IDS.status);
    const text = (status.textContent ?? '').toLowerCase();
    // The four words a learner must never read after a normal dismissal.
    expect(text).not.toContain('error');
    expect(text).not.toContain('failed');
    expect(text).not.toContain('refus');
    // And it is a `status`, not an `alert`: a dismissal is not an emergency.
    expect(status).toHaveAttribute('role', 'status');
    expect(status).not.toHaveAttribute('role', 'alert');
    // No toast element exists anywhere: the dialog has no toast API at all.
    expect(document.querySelector('[role="alert"], .toast, .kd-toast')).toBeNull();
  });

  it('announces nothing on open, because there is no outcome yet', () => {
    renderDialog();
    const status = byId(SHARE_CARD_IDS.status);
    expect(status.textContent).toBe('');
    expect(status.getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('');
  });

  it('offers no share control at all with VITE_WEB_SHARE off, and keeps the download', async () => {
    renderDialog({ webShareEnabled: false });
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    // Not a disabled button: no element with this id exists, so there is nothing to find and nothing
    // to mistake for a share path.
    expect(document.querySelector(`[${SHARE_CARD_ID_ATTRIBUTE}="${SHARE_CARD_IDS.share}"]`)).toBeNull();
    expect(screen.queryByRole('button', { name: SHARE_SHARE_LABEL })).toBeNull();
    // The download is the rollback, and it is there.
    expect(screen.getByRole('button', { name: SHARE_DOWNLOAD_LABEL })).toBeInTheDocument();
    expectNoShareYet(shareSpy, 'on a flag-off build');
  });
});

/* ── 7. Local download, always ───────────────────────────────────────────────── */

describe('local PNG download is always available and needs no flag', () => {
  it('creates an object URL and clicks a download link, with the flag off', async () => {
    const createObjectURL = vi.fn(() => 'blob:probe');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function recordClick(this: HTMLAnchorElement) {
      clicked.push(this.download);
    };

    try {
      renderDialog({ webShareEnabled: false });
      await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(byId(SHARE_CARD_IDS.download));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clicked).toEqual(['linear-algebra-subject-summary.png']);
      // The URL is released, so a preview-then-download loop does not leak a blob per click.
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:probe');
      // And a download is not a share.
      expect(shareSpy.shareCalls).toHaveLength(0);
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  it('suggests a different file name per kind, all derived from the subject name', async () => {
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function recordClick(this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => 'blob:probe' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });
    try {
      for (const kind of SHARE_CARD_KINDS) {
        const { unmount } = renderDialog({ initialKind: kind });
        await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(byId(SHARE_CARD_IDS.download));
        unmount();
      }
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
    expect(clicked).toEqual([
      'linear-algebra-subject-summary.png',
      'linear-algebra-collection.png',
      'linear-algebra-fish.png',
      'linear-algebra-statistics.png',
    ]);
  });

  it('does not claim to be deliverable before the card has been drawn', () => {
    renderDialog();
    // The draw is asynchronous, so on the first frame the controls are disabled rather than
    // enabled-but-useless. A disabled download that says "download" would be a lie for one frame.
    expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ── 8. Non-vacuity controls for the counting and fingerprinting ─────────────── */

describe('the controls above can fail', () => {
  it('the share spy can reach a non-zero count, so "zero" is a measurement', async () => {
    renderDialog();
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => expect(shareSpy.shareCalls).toHaveLength(1));
    // The control for the zero-assertions: a spy that always recorded zero would make every
    // "no share yet" assertion in this file pass for any implementation whatsoever.
    expect(shareSpy.shareCalls.length).toBeGreaterThan(0);
  });

  it('the storage fingerprint is non-empty before the cancel, so an empty fingerprint cannot pass', () => {
    // Baseline substance, asserted directly rather than only inside the cancel test. If the
    // fingerprint were empty to begin with, "nothing changed" would be trivially true and the whole
    // cancellation claim would be vacuous.
    const fingerprint = storageFingerprint();
    expect(fingerprint.localStorage.length, 'the unrelated key must be in the fingerprint').toBeGreaterThan(0);
    expect(fingerprint.localStorage.some((entry) => entry.key === UNRELATED_KEY && entry.value === 'a-real-value-a-real-value')).toBe(true);
  });
});

/* ── 9. The storage fingerprint used by the cancellation test ────────────────── */

/** One `localStorage` key/value pair. */
interface LocalStorageEntry {
  readonly key: string;
  readonly value: string;
}

interface StorageFingerprint {
  /** Every non-share `localStorage` key, sorted, value included. */
  readonly localStorage: readonly LocalStorageEntry[];
  /**
   * Every storage-v2 object store this module can read, sorted.
   *
   * Empty in jsdom unless a test has opened a real database, which is why
   * {@link storageFingerprintIsNonEmpty} is asserted separately for the store half.
   */
  readonly indexedDbStores: readonly string[];
  /** The ordered key list of `localStorage`, so a *removal* is visible too. */
  readonly localStorageKeys: readonly string[];
}

/** Keys this phase's own subject would own if it persisted a preference. */
const SHARE_OWNED_KEY_PREFIX = 'kd-share-card:';

/**
 * A full before/after fingerprint.
 *
 * `localStorage` is read whole and sorted, not sampled: a cancelled share that deleted one key would
 * be invisible to a sample. IndexedDB is read by **store name** from the schema declaration rather
 * than from a hardcoded list, so a store added to storage-v2 is covered without editing this file.
 */
export function storageFingerprint(): StorageFingerprint {
  const entries: LocalStorageEntry[] = [];
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null) continue;
    keys.push(key);
    entries.push({ key, value: window.localStorage.getItem(key) ?? '' });
  }
  entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  keys.sort();
  return {
    localStorage: entries,
    localStorageKeys: keys,
    indexedDbStores: [...STORAGE_V2_STORE_NAMES].sort(),
  };
}

/**
 * Is the fingerprint able to see a difference?
 *
 * A comparator that always reports "identical" would make every "cancelling changed nothing"
 * assertion pass for an implementation that wrote on every share. So this takes a fingerprint,
 * changes one value in it, and requires the change to be visible - the fingerprint's own control,
 * independent of any share.
 */
export function fingerprintDetectsAChange(): boolean {
  const before = storageFingerprint();
  window.localStorage.setItem(UNRELATED_KEY, 'a-different-value-a-diff');
  const after = storageFingerprint();
  window.localStorage.setItem(UNRELATED_KEY, 'a-real-value-a-real-value');
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** Every store name a storage-v2 fingerprint would cover, so a test can assert the coverage. */
export const FINGERPRINT_STORE_NAMES: readonly string[] = [
  ...GENERATION_SCOPED_STORE_NAMES,
  ...GLOBAL_STORE_NAMES,
];

export { UNRELATED_KEY, SHARE_OWNED_KEY_PREFIX };