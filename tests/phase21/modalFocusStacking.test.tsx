/**
 * Phase 21 defect repair: **only the topmost focus scope answers Escape or Tab.**
 *
 * ## The measured defect
 *
 * `npm run test:a11y` reported `42 expected / 2 unexpected` on the two touch cells (`tablet`,
 * `tablet-landscape`). Both were the same thing, and it is not a probe artifact:
 *
 * ```text
 * focus was not restored to the control that opened the Settings dialog; after Escape it is on
 * <button> "Open village status and controls", still inside a dialog
 * ```
 *
 * The mechanism, and it was measured rather than inferred. Every `useModalFocus` instance registers
 * a **capture-phase `keydown` on `document`**, and `document` is shared. On a touch viewport the
 * village HUD is a bottom sheet that is open (`aria-modal="false"`, world still live behind it), the
 * Settings dialog is open above it, and so there are two listeners for one key. Listeners on the same
 * node in the same phase run in **registration order**, and the drawer registered first - so on one
 * Escape press the drawer's handler ran, set `hudOpen` false, and unmounted the entire HUD column,
 * Settings launcher and all. The Settings dialog's handler ran afterwards in the same dispatch, but
 * its restore target had been disconnected by then, so `opener.focus()` was skipped and focus stayed
 * on the drawer's toggle. The learner pressed Escape once and lost two surfaces.
 *
 * ## The fix, and the design decision it rests on
 *
 * `useModalFocus` keeps a module-scoped stack of open scopes and **only the topmost one acts**. The
 * decision is between three candidate rules for "which surface is on top":
 *
 * | rule | why it was rejected or chosen |
 * | --- | --- |
 * | registration order | **this was the bug.** The surface that mounted first wins, which is the surface furthest from the learner. |
 * | nearest in the DOM | rejected. DOM depth is not a proxy for stacking order; it is decided by how many wrapper elements a styling decision happens to add. Today the Settings dialog is deeper than the HUD drawer *only because its backdrop is an extra `<div>`*. Section 6 below pins that by constructing the inverse case, where the surface that opened second is the shallower one. |
 * | **open order** | chosen. It is the rule every platform already uses for stacked UI - a back stack, a modal presentation, an undo stack - and the only one of the three that is a property of what the learner did rather than of how the markup is shaped. |
 *
 * ## Why it lives in the hook and not in a caller
 *
 * Because `document` is shared, the question "which of the open surfaces is on top?" cannot be
 * answered by any one of them. Answering it in `VillageHud` - "ignore Escape while Settings is open" -
 * would make a bottom-sheet drawer depend on a dialog it has no other relationship with, and every
 * future dialog would have to be added to that list, and the twenty dialogs this repository already
 * has would each need their own version of it. Section 4 asserts the negative shape directly: the
 * hook's options are still `{ active, onEscape }` and neither surface names the other.
 *
 * ## Tab containment is the same defect, and the guard covers it too
 *
 * See section 5. It was checked, not assumed, and it was broken.
 *
 * ## What jsdom can and cannot decide here
 *
 * Everything asserted below is DOM state: which nodes are mounted, where `document.activeElement`
 * points, and what a `keydown` handler did to it. jsdom runs that faithfully, so these are real
 * behavioural assertions. They are not evidence about what a screen reader announces, and this file
 * claims nothing about contrast or target size - the axe run's job.
 */
import { useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessibleDialog } from '@/ui/components/AccessibleDialog';
import { SettingsModal } from '@/ui/components/SettingsModal';
import { VillageHud } from '@/ui/village/VillageHud';
import {
  VILLAGE_NO_HOVER_QUERY,
  VILLAGE_SHEET_WIDTH_QUERY,
  VILLAGE_TOUCH_POINTER_QUERY,
} from '@/ui/village/useVillageSurfaceMode';
import type { QuestStep } from '@/store/sessionStore';

/* ── Device doubles ────────────────────────────────────────────────────────
 *
 * The same three media queries plus `navigator.maxTouchPoints` that
 * `useVillageSurfaceMode` asks, and no more. `maxTouchPoints: 5` is how
 * Playwright's `hasTouch: true` presents to a page, and it is the branch that
 * makes the HUD a bottom sheet - which is the branch the two failing audit
 * cells are on.
 */

const realMatchMedia = window.matchMedia;
const realMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');

function stubDevice(answers: {
  coarsePointer?: boolean;
  noHover?: boolean;
  narrow?: boolean;
  maxTouchPoints?: number;
}): void {
  const table: Record<string, boolean> = {
    [VILLAGE_TOUCH_POINTER_QUERY]: answers.coarsePointer ?? false,
    [VILLAGE_NO_HOVER_QUERY]: answers.noHover ?? false,
    [VILLAGE_SHEET_WIDTH_QUERY]: answers.narrow ?? false,
  };
  window.matchMedia = ((query: string) => ({
    matches: table[query] ?? false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  if (answers.maxTouchPoints !== undefined) {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: answers.maxTouchPoints, configurable: true });
  }
}

beforeEach(() => stubDevice({}));
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  if (realMaxTouchPoints !== undefined) {
    Object.defineProperty(navigator, 'maxTouchPoints', realMaxTouchPoints);
  } else {
    // @ts-expect-error - removing a property the environment may not declare.
    delete navigator.maxTouchPoints;
  }
  vi.restoreAllMocks();
});

/* ── The composition under test ───────────────────────────────────────────── */

const HUD_PROPS = {
  questStep: 'meet-keeper' as QuestStep,
  subjects: [{ id: 's1', subjectName: 'Algebra', roomCount: 8, clearedRoomCount: 3 }],
  selectedClass: null,
  onSelectClass: vi.fn(),
  onCreateSubject: vi.fn(),
  onOpenData: vi.fn(),
  colorTheme: 'dark',
  onColorThemeChange: vi.fn(),
  onQuestClick: vi.fn(),
  onStatsClick: vi.fn(),
  onSettingsClick: vi.fn(),
  nearbyTargets: [],
  nearbyListAvailable: false,
  nearbyInvokeAvailable: false,
  onInvokeNearby: vi.fn(),
};

/**
 * The real `VillageHud` and the real `SettingsModal`, composed the way `VillageLaunchers` composes
 * them: HUD first, launcher second, both siblings under the screen.
 *
 * This is the production shape and not a reduced one, because the defect is a property of the shape:
 * two open focus scopes in one document. A test that mocked the drawer away would pass for the wrong
 * reason, which is how this defect survived an audit that had already found six other dialogs wrong.
 */
function VillageWithSettings(): ReactNode {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <>
      <VillageHud {...HUD_PROPS} onSettingsClick={() => setSettingsOpen(true)} />
      {settingsOpen ? (
        <SettingsModal
          currentTheme="dark"
          onThemeChange={vi.fn()}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The HUD bottom sheet, by the accessible name it declares. */
function drawer(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: 'Village status and controls' });
}

/** The Settings dialog, by the name its own `<h2>` gives it. */
function settingsDialog(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: 'Settings' });
}

/** The Settings launcher inside the drawer. */
function settingsLauncher(): HTMLElement {
  const openDrawer = drawer();
  if (openDrawer === null) throw new Error('the HUD drawer is not open, so it has no Settings launcher');
  return within(openDrawer).getByRole('button', { name: 'Settings' });
}

/** A one-line description of where focus is, so a failure message is readable. */
function whereFocusIs(): string {
  const active = document.activeElement;
  if (active === null) return 'nothing (activeElement is null)';
  if (!(active instanceof HTMLElement)) return active.nodeName;
  const name =
    active.getAttribute('aria-label') ??
    (active.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const owner = active.closest('[role="dialog"]')?.getAttribute('aria-label');
  return `<${active.tagName.toLowerCase()}> "${name}"${owner ? ` inside "${owner}"` : ' outside any dialog'}`;
}

/**
 * Drive the HUD drawer open and the Settings dialog open on top of it, exactly as the audit probe
 * does: tap the ≥44px toggle, then press the Settings launcher that lives inside the drawer.
 */
async function openBoth(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const toggle = screen.getByRole('button', { name: 'Open village status and controls' });
  await user.click(toggle);
  expect(drawer(), 'the drawer did not open, so nothing is stacked and every test below is vacuous').not.toBeNull();
  await user.click(settingsLauncher());
  expect(settingsDialog(), 'the Settings dialog did not open').not.toBeNull();
}

/* ── 1 & 2. One Escape closes one surface, and focus goes back where it was ── */

describe('one Escape press inside the Settings dialog dismisses only the Settings dialog', () => {
  it('property 1: the Settings dialog closes and the HUD drawer stays open', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    await openBoth(user);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(settingsDialog(), 'Escape did not close the Settings dialog').toBeNull();
    });
    expect(
      drawer(),
      'Escape closed the HUD drawer as well as the Settings dialog: one press dismissed two ' +
        'surfaces, which is the defect. `document.activeElement` was ' +
        `${whereFocusIs()}`,
    ).not.toBeNull();
  });

  it('property 2: focus returns to the Settings launcher, and that launcher is still connected', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    await openBoth(user);
    const launcher = settingsLauncher();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(document.activeElement, `focus was not restored to the Settings launcher; it is on ${whereFocusIs()}`).toBe(
        launcher,
      );
    });
    // The second half of the property, and the half that actually failed: restoration is only
    // meaningful if the target survived. A launcher that is focused while disconnected restores
    // nothing, and `document.activeElement` would quietly say otherwise.
    expect(
      launcher.isConnected,
      'focus was restored to a disconnected launcher, which is not restoration at all',
    ).toBe(true);
    expect(
      drawer(),
      'the launcher was only connected because the drawer stayed open',
    ).not.toBeNull();
  });
});

/* ── 3. The drawer is still dismissible, on its own ───────────────────────── */

describe('the HUD drawer still closes on Escape, on its own and after the dialog above it closes', () => {
  it('property 3a: Escape with no Settings dialog open closes the drawer', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    const toggle = screen.getByRole('button', { name: 'Open village status and controls' });
    toggle.focus();
    await user.click(toggle);
    expect(drawer()).not.toBeNull();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(drawer(), 'the drawer stopped being dismissable, which is not a fix - it is a trap').toBeNull();
    });
    expect(document.activeElement, 'the drawer did not restore focus to its toggle').toBe(
      screen.getByRole('button', { name: 'Open village status and controls' }),
    );
  });

  it('property 3b: the second Escape closes the drawer, so the fix is one-key-per-surface', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    await openBoth(user);

    // First press: the dialog only.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(settingsDialog()).toBeNull();
    });
    expect(drawer(), 'the first Escape took the drawer with it').not.toBeNull();

    // Second press: the drawer, which is topmost again now that nothing is above it. This is what
    // proves the drawer was *deferred* rather than *disabled*: a fix that made the drawer
    // un-dismissable while any dialog existed would pass 3a and fail here.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(drawer(), 'the drawer never became topmost again, so it could not be dismissed').toBeNull();
    });
  });
});

/* ── 4. A dialog opened from a dialog behaves the same way ────────────────── */

describe('a dialog opened from a dialog: Escape closes the inner one and restores the outer one', () => {
  it('property 4: the Settings dialog survives, only Make It Yours closes, and focus returns inside Settings', async () => {
    const user = userEvent.setup();
    render(<VillageWithSettings />);
    const launcher = screen.getByRole('button', { name: 'Settings' });
    await user.click(launcher);
    expect(settingsDialog()).not.toBeNull();

    // The real nesting path: `SettingsModal` renders `MakeItYoursModal` inside itself, and both are
    // `AccessibleDialog`. Two modal scopes, one document - the same competition as the drawer case,
    // with `aria-modal="true"` on both sides of it.
    const makeItYours = within(settingsDialog() as HTMLElement).getByRole('button', { name: 'Make It Yours' });
    await user.click(makeItYours);
    const inner = await screen.findByRole('dialog', { name: 'Make It Yours' });
    expect(inner, 'the inner dialog did not open').toBeTruthy();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Make It Yours' }),
        'Escape did not close the inner dialog',
      ).toBeNull();
    });
    expect(
      settingsDialog(),
      `Escape closed the outer Settings dialog instead of the inner one; focus was on ${whereFocusIs()}`,
    ).not.toBeNull();
    expect(
      document.activeElement,
      'focus did not return to the control that opened the inner dialog',
    ).toBe(makeItYours);
  });

  it('property 4, continued: with the inner dialog gone the outer one is dismissable again', async () => {
    const user = userEvent.setup();
    render(<VillageWithSettings />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(within(settingsDialog() as HTMLElement).getByRole('button', { name: 'Make It Yours' }));
    await screen.findByRole('dialog', { name: 'Make It Yours' });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Make It Yours' })).toBeNull();
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(settingsDialog(), 'the outer dialog could not be dismissed once the inner one closed').toBeNull();
    });
  });
});

/* ── 5. The fix must not depend on focus, and the surfaces must not know each other ── */

describe('the topmost surface is decided by open order alone', () => {
  it('property 5: the outcome is the same whether focus is in the dialog or back in the drawer', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    await openBoth(user);
    const launcher = settingsLauncher();

    // Deliberately put focus somewhere that has nothing to do with the dialog, on a surface that is
    // *underneath* it. A rule keyed on `document.activeElement` would answer differently here, and a
    // rule keyed on DOM containment would too.
    launcher.focus();
    expect(document.activeElement).toBe(launcher);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(settingsDialog(), 'focus position changed which surface Escape dismissed').toBeNull();
    });
    expect(drawer(), 'the drawer was dismissed because focus happened to be inside it').not.toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(launcher);
    });
  });

  it('property 5, structurally: neither surface is told about the other', () => {
    // The fix is not permitted to be "the drawer checks whether Settings is open". That shape makes
    // every future dialog an addition to a list inside an unrelated component, and it leaves the
    // twenty other dialogs this repository has still competing. Asserted as text because it is a
    // claim about the shape of the code, which is what it is.
    const read = (relative: string): string =>
      readFileSync(path.join(process.cwd(), 'src', ...relative.split('/')), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const hook = read('ui/hooks/useModalFocus.ts');
    expect(
      hook,
      'useModalFocus gained a way to be told what is above it, so the surfaces are coupled after all',
    ).not.toMatch(/VillageHud|SettingsModal|Settings|drawer/i);
    expect(hook, 'the hook gained an option, so every caller now has a decision to get right').not.toMatch(
      /modal\??:\s*boolean|above|parent|priority|zIndex|z-index/i,
    );

    expect(
      read('ui/village/VillageHud.tsx'),
      'VillageHud learned about the Settings dialog, which is the coupling this file argues against',
    ).not.toMatch(/SettingsModal|settingsOpen/);
    expect(
      read('ui/components/SettingsModal.tsx'),
      'SettingsModal learned about the HUD drawer, which is the coupling this file argues against',
    ).not.toMatch(/VillageHud|hudOpen|drawerOpen/i);
  });
});

/* ── 6. Tab containment: the same competition, and it was broken too ───────── */

describe('Tab containment belongs to the topmost surface as well', () => {
  /**
   * Record every focus move in the document while `key` is pressed, tagged by which surface owns it.
   *
   * A `focusin` listener rather than a spy on `focus()`, because `HTMLElement.focus` has only a
   * getter and cannot be replaced - and because `focusin` is the platform's own record of where focus
   * actually went, including any move a handler made and then another handler undid.
   */
  function watchFocusMoves(): { moves: string[]; stop: () => void } {
    const moves: string[] = [];
    const openDrawer = drawer();
    const dialog = settingsDialog();
    const label = (el: Element | null): string => {
      if (el === null) return 'nothing';
      if (dialog !== null && dialog.contains(el)) return 'settings';
      if (openDrawer !== null && openDrawer.contains(el)) return 'drawer';
      return 'outside';
    };
    const listener = (event: Event): void => {
      moves.push(label(event.target as Element));
    };
    document.addEventListener('focusin', listener);
    return { moves, stop: () => document.removeEventListener('focusin', listener) };
  }

  it('a Tab inside the Settings dialog never moves focus into the drawer beneath it', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    await openBoth(user);

    const dialog = settingsDialog() as HTMLElement;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input')];
    expect(focusable.length, 'the Settings dialog has no focusable control, so containment is vacuous').toBeGreaterThan(
      0,
    );

    // A **middle** control, deliberately. From the last control a Tab is supposed to wrap to the
    // first, and a trap underneath that momentarily grabs focus lands somewhere the dialog then
    // corrects - so the defect is invisible from that position. From a middle control there is no
    // correction to hide behind, which is what makes this the assertion that separates the two
    // behaviours. Measured pre-fix: `['drawer', 'settings']`, focus in the drawer and then yanked
    // back. Post-fix: `[]`, because neither scope moves focus for an interior Tab.
    const middle = focusable[Math.floor(focusable.length / 2)]!;
    middle.focus();
    expect(document.activeElement, 'the middle control did not take focus to begin with').toBe(middle);

    const watcher = watchFocusMoves();
    // A bare event, so the only thing that can move focus is a containment handler - the same
    // spelling `tests/phase21/dialogAudit.test.tsx` uses for its own containment assertions.
    fireEvent.keyDown(document, { key: 'Tab' });
    watcher.stop();

    expect(
      watcher.moves,
      'Tab inside the Settings dialog moved focus into the drawer beneath it. It is then pulled back ' +
        'by the dialog\'s own handler, which is why a learner sees nothing happen, but a screen ' +
        "reader announces the drawer's controls and focus lands on the wrong control if anything " +
        'interleaves. One key must have one owner.',
    ).not.toContain('drawer');
    expect(
      document.activeElement,
      `focus left the dialog on Tab; it is on ${whereFocusIs()}`,
    ).toBe(middle);
  });

  it('Tab from the last control of the Settings dialog wraps inside the dialog, not into the drawer', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    await openBoth(user);

    const dialog = settingsDialog() as HTMLElement;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input')];
    focusable[focusable.length - 1]!.focus();

    const watcher = watchFocusMoves();
    fireEvent.keyDown(document, { key: 'Tab' });
    watcher.stop();

    expect(watcher.moves, 'the wrap-around passed through the drawer').not.toContain('drawer');
    expect(document.activeElement, 'Tab from the last control did not wrap to the first').toBe(focusable[0]);
  });

  it('the drawer still contains Tab while it is the topmost surface', () => {
    // The other half, and the one a careless fix would break: containment in the drawer is Phase 12's
    // requirement for the bottom sheet, and it must survive.
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageWithSettings />);
    const user = userEvent.setup();
    return (async () => {
      await user.click(screen.getByRole('button', { name: 'Open village status and controls' }));
      const sheet = drawer() as HTMLElement;
      const focusable = [...sheet.querySelectorAll<HTMLElement>('button:not([disabled])')];
      expect(focusable.length, 'the drawer has no focusable control, so containment is vacuous').toBeGreaterThan(0);

      focusable[focusable.length - 1]!.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement, 'the drawer let Tab leave it for the page behind').toBe(focusable[0]);
    })();
  });
});

/* ── 7. Why open order and not DOM depth ──────────────────────────────────── */

describe('open order decides which surface is topmost, not DOM depth', () => {
  /**
   * The rejected rule, constructed.
   *
   * `deep` opens **first** and sits **deeper** in the tree; `shallow` opens **second** and sits
   * shallower. In this repository's actual composition the Settings dialog happens to be the deeper
   * node - purely because `SettingsModal` wraps itself in a `.modal-backdrop` `<div>`. That is a
   * styling decision, and a nearest-in-DOM rule would have got this product's behaviour right for a
   * reason that has nothing to do with behaviour: remove the backdrop, portal the dialog to `<body>`
   * at depth one, or wrap the drawer one level deeper, and the same product with the same visual
   * stack answers the opposite way.
   */
  function StackedScopes(): ReactNode {
    const [deep, setDeep] = useState(true);
    const [shallow, setShallow] = useState(true);
    return (
      <div>
        <div>
          <div>
            {deep ? (
              <AccessibleDialog active label="Deep" onEscape={() => setDeep(false)}>
                <button type="button">Deep control</button>
              </AccessibleDialog>
            ) : null}
          </div>
        </div>
        {shallow ? (
          <AccessibleDialog active label="Shallow" onEscape={() => setShallow(false)}>
            <button type="button">Shallow control</button>
          </AccessibleDialog>
        ) : null}
      </div>
    );
  }

  /** How many elements wrap this one, which is the quantity a nearest-in-DOM rule would rank on. */
  function depthOf(node: HTMLElement): number {
    let depth = 0;
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) depth += 1;
    return depth;
  }

  it('the surface that opened second is the topmost one even when it is shallower in the DOM', async () => {
    const user = userEvent.setup();
    render(<StackedScopes />);
    const deep = screen.getByRole('dialog', { name: 'Deep' });
    const shallow = screen.getByRole('dialog', { name: 'Shallow' });

    // Both halves of the premise, asserted rather than assumed. Without them this test would pass
    // under *either* rule and would therefore prove nothing about which rule is in force.
    expect(
      depthOf(deep),
      'the two scopes are at the same DOM depth, so this file cannot distinguish the two rules',
    ).toBeGreaterThan(depthOf(shallow));
    // The deep scope mounted first, and the shallow one second: that is the open order under test.
    expect(
      screen.getByRole('button', { name: 'Shallow control' }),
      'the fixture did not render both scopes',
    ).toBeTruthy();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Shallow' }), 'the shallower, later surface was not dismissed').toBeNull();
    });
    expect(
      screen.queryByRole('dialog', { name: 'Deep' }),
      'the deeper, earlier surface was dismissed instead, so the rule in force is DOM depth rather than open order',
    ).not.toBeNull();
  });

  it('a topmost surface that refuses Escape swallows the key instead of falling through', () => {
    // `onEscape: null` is a real state: `ConfirmDialog` and `CreateSubjectDialog` both pass it while
    // an action is in flight, because the dialog has already promised the learner a result. Falling
    // through to the surface beneath would tear down a layer the learner never pressed Escape on -
    // the defect, in miniature, re-introduced as a fix for the defect.
    function BusyOverDrawer(): ReactNode {
      const [drawerOpen, setDrawerOpen] = useState(true);
      const [busyOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setDrawerOpen(true)}>
            Open the drawer
          </button>
          {drawerOpen ? (
            <AccessibleDialog active label="Drawer" onEscape={() => setDrawerOpen(false)}>
              <button type="button">Drawer control</button>
            </AccessibleDialog>
          ) : null}
          {busyOpen ? (
            <AccessibleDialog active label="Busy" onEscape={null}>
              <button type="button">Busy control</button>
            </AccessibleDialog>
          ) : null}
        </>
      );
    }
    render(<BusyOverDrawer />);
    expect(screen.getByRole('dialog', { name: 'Busy' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'Busy' }), 'a non-dismissable dialog was dismissed').toBeTruthy();
    expect(
      screen.getByRole('dialog', { name: 'Drawer' }),
      'Escape fell through a dialog that refused it and dismissed the surface beneath it',
    ).toBeTruthy();
  });
});