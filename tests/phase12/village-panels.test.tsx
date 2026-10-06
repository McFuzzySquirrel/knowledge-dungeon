/**
 * The village shell's accessible surface: panels, sheets, HUD, and the dialogs.
 *
 * ## What this file covers, and why it is not a snapshot suite
 *
 * Phase 12's exit criteria include two claims that are only checkable against the
 * rendered tree, because both are about *semantics under a device*:
 *
 * - **"Dialogs and bottom sheets meet focus and touch-target requirements."** That
 *   is `role`, `aria-modal`, where focus lands, whether Tab stays inside, whether
 *   Escape works, whether the opener gets focus back, and whether the dismiss
 *   control is at least 44 by 44 CSS pixels on each side. All five are asserted
 *   here, on both shapes, because the whole point of the split is that the two
 *   shapes are *not* the same control.
 * - **"No Pixi object is required to understand or invoke a village action."**
 *   `village-nearby-actions.test.tsx` owns the invoke half; this file owns the
 *   "understand" half - that every panel body, the quest board, the signposts, and
 *   the HUD are reachable and readable with nothing mounted.
 *
 * The renderer is absent by construction: nothing here renders a `VillageScreen`,
 * so nothing can accidentally prove itself through a renderer. Where a capability
 * is needed, the test passes the *contract* - a snapshot, an action bridge - and
 * never a handle.
 *
 * ## Hermeticity
 *
 * No canvas, no renderer import, no `dist/`, no network, no commit. `matchMedia`
 * and `navigator.maxTouchPoints` are set per test and restored afterwards, so the
 * "which shape" question is answered by the test rather than by whichever
 * environment happens to be running.
 */
import type { ReactElement } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VILLAGE_MAP } from '../../src/data/villageLayout';
import { QUEST_ORDER, type QuestStep } from '../../src/store/sessionStore';
import type { StudyFlowVillageInfoPanel } from '../../src/application/studyFlow';

import { VillagePanel } from '../../src/ui/village/VillagePanel';
import { SignpostPanel, StructurePanel } from '../../src/ui/village/StructurePanel';
import { QuestBoard, VillageQuestOverview } from '../../src/ui/village/QuestBoard';
import { VillageHud } from '../../src/ui/village/VillageHud';
import { CreateSubjectDialog } from '../../src/ui/village/CreateSubjectDialog';
import { DataManagementDialog } from '../../src/ui/village/DataManagementDialog';
import { NpcDialog } from '../../src/ui/village/NpcDialog';
import { useVillageActionHandler } from '../../src/ui/village/NearbyActionList';
import {
  readVillageSurfaceMode,
  VILLAGE_NO_HOVER_QUERY,
  VILLAGE_SHEET_WIDTH_QUERY,
  VILLAGE_TOUCH_POINTER_QUERY,
} from '../../src/ui/village/useVillageSurfaceMode';
import type { VillageSubjectSummary } from '../../src/ui/village/villageTypes';

/* ── Device doubles ─────────────────────────────────────────────────────── */

const realMatchMedia = window.matchMedia;
const realMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');

/** Answers the three queries the hook asks, and nothing else. */
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
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: answers.maxTouchPoints,
      configurable: true,
    });
  }
}

beforeEach(() => {
  stubDevice({});
});

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

/* ── Which shape, and why ───────────────────────────────────────────────── */

describe('the surface shape follows the input device, not only the width', () => {
  it('is a side panel on a wide pointer-and-keyboard viewport', () => {
    stubDevice({});
    expect(readVillageSurfaceMode()).toBe('side');
  });

  it('is a bottom sheet on a coarse pointer', () => {
    stubDevice({ coarsePointer: true });
    expect(readVillageSurfaceMode()).toBe('sheet');
  });

  it('is a bottom sheet with no hover-capable pointer, as a convertible answers', () => {
    stubDevice({ noHover: true });
    expect(readVillageSurfaceMode()).toBe('sheet');
  });

  it('is a bottom sheet when the layout is too narrow for a side panel', () => {
    // The 200% zoom and 320-CSS-pixel gates: both narrow the layout viewport
    // without any coarse pointer being involved.
    stubDevice({ narrow: true });
    expect(readVillageSurfaceMode()).toBe('sheet');
  });

  it('is a bottom sheet from touch points alone, which is what emulation sets', () => {
    // Playwright's `hasTouch` sets `maxTouchPoints`; a Chromium build that does not
    // also flip `pointer: coarse` would otherwise get a side panel on a tablet.
    stubDevice({ maxTouchPoints: 5 });
    expect(readVillageSurfaceMode()).toBe('sheet');
  });

  it('gives an 834-wide tablet portrait the touch treatment, which 768px alone missed', () => {
    // The pre-Phase-12 screen branched on `(max-width: 768px)`, and the support
    // matrix's own tablet-portrait record is 834x1112 - so a tablet portrait used
    // to get a *side* HUD and a bottom-centred panel. It is a sheet now.
    stubDevice({ narrow: false, maxTouchPoints: 5 });
    expect(readVillageSurfaceMode()).toBe('sheet');
  });

  it('resolves to `side` when the environment has no matchMedia at all', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(readVillageSurfaceMode()).toBe('side');
  });
});

/* ── The panel frame ────────────────────────────────────────────────────── */

describe('a side panel is a labelled region that never steals focus', () => {
  it('is a named region, not a dialog, and takes no focus when it opens', () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    render(
      <VillagePanel mode="side" title="Guild Hall" subtitle="Create subjects" icon="⚒" onClose={vi.fn()} colorTheme="dark">
        <p>body</p>
      </VillagePanel>,
    );

    const region = screen.getByRole('region', { name: 'Guild Hall' });
    expect(region).toBeTruthy();
    expect(region.hasAttribute('aria-modal')).toBe(false);
    // A panel opens because the player *walked*, not because they activated a
    // control, so taking focus would rip a keyboard user out of the world.
    expect(document.activeElement, 'the side panel stole focus').toBe(opener);
    opener.remove();
  });

  it('has a dismiss control that names the surface it closes, at 44 by 44', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <VillagePanel mode="side" title="Guild Hall" icon="⚒" onClose={onClose} colorTheme="dark">
        <p>body</p>
      </VillagePanel>,
    );
    const close = screen.getByRole('button', { name: 'Close Guild Hall' });
    expect(close.getAttribute('data-village-touch-target')).toBe('close');
    expect((close as HTMLElement).style.minWidth).toBe('44px');
    expect((close as HTMLElement).style.minHeight).toBe('44px');
    await user.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the subtitle only when there is one', () => {
    const { rerender } = render(
      <VillagePanel mode="side" title="A" icon="📍" onClose={vi.fn()} colorTheme="dark">
        <p>body</p>
      </VillagePanel>,
    );
    expect(document.querySelectorAll('.village-info-meta')).toHaveLength(0);
    rerender(
      <VillagePanel mode="side" title="A" subtitle="B" icon="📍" onClose={vi.fn()} colorTheme="dark">
        <p>body</p>
      </VillagePanel>,
    );
    expect(document.querySelectorAll('.village-info-meta')).toHaveLength(1);
  });
});

describe('a bottom sheet is a dialog that takes, contains, and restores focus', () => {
  it('is a non-modal dialog that receives focus when it opens', () => {
    render(
      <VillagePanel mode="sheet" title="Fishing Pond" icon="🎣" onClose={vi.fn()} colorTheme="dark">
        <button type="button">Cast Line</button>
      </VillagePanel>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Fishing Pond' });
    // The world stays live behind the sheet, so claiming to be modal would make a
    // screen reader hide the world from the learner who just opened this.
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <VillagePanel mode="sheet" title="Fishing Pond" icon="🎣" onClose={onClose} colorTheme="dark">
        <button type="button">Cast Line</button>
      </VillagePanel>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while it is not dismissible, rather than looking dismissible', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <VillagePanel mode="sheet" title="Fishing Pond" icon="🎣" onClose={onClose} colorTheme="dark" dismissible={false}>
        <button type="button">Cast Line</button>
      </VillagePanel>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('contains Tab on the last control, so focus cannot leave the sheet', async () => {
    const user = userEvent.setup();
    render(
      <VillagePanel mode="sheet" title="Fishing Pond" icon="🎣" onClose={vi.fn()} colorTheme="dark">
        <button type="button">first</button>
        <button type="button">last</button>
      </VillagePanel>,
    );
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });
    // The close control is before them in document order, so `last` really is last.
    last.focus();
    await user.tab();
    expect(document.activeElement, 'Tab escaped the sheet').toBe(
      screen.getByRole('button', { name: 'Close Fishing Pond' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(first);
  });

  it('restores focus to the opener when it closes', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const view = render(
      <VillagePanel mode="sheet" title="Guild Hall" icon="⚒" onClose={vi.fn()} colorTheme="dark">
        <p>body</p>
      </VillagePanel>,
    );
    expect(document.activeElement).not.toBe(opener);
    view.unmount();
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    opener.remove();
  });
});

/* ── Structure panels ───────────────────────────────────────────────────── */

const NOOP = (): void => {};

function renderStructure(infoPanel: StudyFlowVillageInfoPanel): void {
  render(
    <StructurePanel
      infoPanel={infoPanel}
      onClose={NOOP}
      mode="side"
      colorTheme="dark"
      subjects={[{ id: 's1', subjectName: 'Algebra', roomCount: 8, clearedRoomCount: 3 }] satisfies VillageSubjectSummary[]}
      totals={{ badges: 2, artifacts: 5, notes: 9, dungeons: 1 }}
      studyTotals={{
        totalSessions: 4,
        totalMinutesStudied: 95,
        totalNotesSubmitted: 12,
        totalReviewsCompleted: 3,
        recentStreak: 5,
        rank: 'Novice',
        xpTotal: 40,
      }}
      selectedClass="scholar"
      onEnterDungeon={NOOP}
      onCreateSubject={NOOP}
      onStartTutorial={NOOP}
      onOpenSpriteEditor={NOOP}
      onOpenFishCollection={NOOP}
      onCastLine={NOOP}
      showFishingHint={false}
    />,
  );
}

describe('every structure has a DOM panel that needs no renderer', () => {
  const cases: ReadonlyArray<[StudyFlowVillageInfoPanel['type'], string, string]> = [
    ['dungeon', 'Algebra', '🌀'],
    ['keeper', "Keeper's Tower", '🏛'],
    ['guild', 'Guild Hall', '⚒'],
    ['training', 'Training Grounds', '🎓'],
    ['trophy', 'Trophy Hall', '🏆'],
    ['library', 'Library of Knowledge', '📖'],
    ['workshop', 'Artisan Workshop', '🎨'],
    ['fountain', 'Central Fountain', '⛲'],
    ['fishing-pond', 'Fishing Pond', '🎣'],
    ['fish-stand', 'Fish Stand', '🐟'],
  ];

  for (const [type, title, icon] of cases) {
    it(`renders the ${type} panel with a dismissable, named surface`, () => {
      const panel: StudyFlowVillageInfoPanel =
        type === 'dungeon'
          ? { type, structureId: 'portal-s1', subject: { id: 's1', subjectName: 'Algebra', roomCount: 8, clearedRoomCount: 3 } }
          : { type, structureId: `${type}-1` };
      renderStructure(panel);
      const region = screen.getByRole('region', { name: title });
      expect(region.getAttribute('data-village-surface')).toBe('side');
      expect(region.getAttribute('data-theme')).toBe('dark');
      expect(within(region).getByText(icon)).toBeTruthy();
      expect(screen.getByRole('button', { name: `Close ${title}` })).toBeTruthy();
    });
  }

  it('takes the sheet shape on a touch viewport, for the same panel', () => {
    render(
      <StructurePanel
        infoPanel={{ type: 'guild', structureId: 'guild' }}
        onClose={NOOP}
        mode="sheet"
        colorTheme="dark"
        subjects={[]}
        totals={{ badges: 0, artifacts: 0, notes: 0, dungeons: 0 }}
        studyTotals={{
          totalSessions: 0,
          totalMinutesStudied: 0,
          totalNotesSubmitted: 0,
          totalReviewsCompleted: 0,
          recentStreak: 0,
          rank: 'Novice',
          xpTotal: 0,
        }}
        selectedClass={null}
        onEnterDungeon={NOOP}
        onCreateSubject={NOOP}
        onStartTutorial={NOOP}
        onOpenSpriteEditor={NOOP}
        onOpenFishCollection={NOOP}
        onCastLine={NOOP}
        showFishingHint={false}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Guild Hall' });
    expect(dialog.getAttribute('data-village-surface')).toBe('sheet');
  });

  it('leaves the quest board to its own module, rather than half-rendering it here', () => {
    // The quest board needs the contract's quest overview and the screen's shared
    // action handler, which the dispatcher's props do not carry. A panel that
    // rendered "nothing" for it would be a silent gap.
    renderStructure({ type: 'quest-board', structureId: 'board' });
    expect(screen.queryByRole('region', { name: /Quest Board/ })).toBeNull();
  });

  it('states the dungeon portal progress in words, not only a ratio', () => {
    renderStructure({
      type: 'dungeon',
      structureId: 'portal-s1',
      subject: { id: 's1', subjectName: 'Algebra', roomCount: 8, clearedRoomCount: 3 },
    });
    expect(screen.getByRole('region', { name: 'Algebra' }).textContent).toContain(
      '3/8 rooms cleared',
    );
  });

  it('gates Enter Dungeon on an archetype and says why, rather than a dead button', () => {
    render(
      <StructurePanel
        infoPanel={{
          type: 'dungeon',
          structureId: 'portal-s1',
          subject: { id: 's1', subjectName: 'Algebra', roomCount: 8, clearedRoomCount: 3 },
        }}
        onClose={NOOP}
        mode="side"
        colorTheme="dark"
        subjects={[]}
        totals={{ badges: 0, artifacts: 0, notes: 0, dungeons: 0 }}
        studyTotals={{
          totalSessions: 0, totalMinutesStudied: 0, totalNotesSubmitted: 0,
          totalReviewsCompleted: 0, recentStreak: 0, rank: 'Novice', xpTotal: 0,
        }}
        selectedClass={null}
        onEnterDungeon={NOOP}
        onCreateSubject={NOOP}
        onStartTutorial={NOOP}
        onOpenSpriteEditor={NOOP}
        onOpenFishCollection={NOOP}
        onCastLine={NOOP}
        showFishingHint={false}
      />,
    );
    expect((screen.getByRole('button', { name: 'Enter Dungeon' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Select an archetype first/)).toBeTruthy();
  });

  it('lists the guide in words, so the signpost works without the canvas', () => {
    render(
      <SignpostPanel structureId="sign-center" mode="side" colorTheme="dark" onClose={NOOP} />,
    );
    const region = screen.getByRole('region', { name: 'Central Crossroads' });
    expect(region.textContent).toContain("Keeper's Tower & Library");
    // The pre-Phase-12 markup was a bare `div` list; a list is a list.
    expect(within(region).getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('falls back to the welcome card for an unmarked signpost, as before', () => {
    render(
      <SignpostPanel structureId="signpost-welcome" mode="side" colorTheme="dark" onClose={NOOP} />,
    );
    expect(screen.getByRole('region', { name: 'Welcome to Dungeon Village' })).toBeTruthy();
  });

  it('falls back to the welcome card for a signpost the data does not describe', () => {
    render(
      <SignpostPanel structureId="sign-unknown" mode="side" colorTheme="dark" onClose={NOOP} />,
    );
    expect(screen.getByRole('region', { name: 'Welcome to Dungeon Village' })).toBeTruthy();
  });
});

/* ── The quest board ────────────────────────────────────────────────────── */

function renderQuestBoard(questStep: QuestStep): {
  onSelectStep: ReturnType<typeof vi.fn>;
  onComplete: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onSelectStep = vi.fn();
  const onComplete = vi.fn();
  const onClose = vi.fn();
  // The shared handler is a hook, so it is produced by the component under test
  // rather than by the test - which is also what the screen does.
  const Harness = (): ReactElement => (
    <QuestBoard
      questStep={questStep}
      mode="side"
      onClose={onClose}
      onSelectStep={onSelectStep}
      onCompleteManualStep={onComplete}
      nearbyTargets={[]}
      invoke={null}
      onInvoke={useVillageActionHandler(null)}
      colorTheme="dark"
    />
  );
  render(<Harness />);
  return { onSelectStep, onComplete, onClose };
}

describe('the quest board is operable from the keyboard', () => {
  it('renders every authored step except the arrival, as real buttons', () => {
    renderQuestBoard('create-subject');
    const rows = screen.getAllByRole('button', { name: /(Arrival|Meet|Create|Training|Choose|Enter|Clear|Write|Review|Journey)/ });
    const steps = rows
      .map((row) => row.getAttribute('data-quest-step'))
      .filter((step): step is string => step !== null);
    expect(new Set(steps)).toEqual(new Set(QUEST_ORDER.filter((step) => step !== 'intro')));
    // The pre-Phase-12 rows were `div`s with an onClick: not focusable at all.
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect((row as HTMLElement).style.minHeight).toBe('44px');
      expect(row.getAttribute('data-village-touch-target')).toBe('quest-step');
    }
  });

  it('names each row\'s state in words, never by colour alone', () => {
    renderQuestBoard('create-subject');
    const current = screen.getByRole('button', { name: /Create a Subject: Active/ });
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.getAttribute('data-quest-state')).toBe('active');

    const done = screen.getByRole('button', { name: /Meet the Keeper: Done/ });
    expect(done.getAttribute('data-quest-state')).toBe('done');
    expect(done.hasAttribute('aria-current')).toBe(false);

    const locked = screen.getByRole('button', { name: /Review & Earn XP: Locked/ });
    expect(locked.getAttribute('data-quest-state')).toBe('locked');
  });

  it('says that a manual step needs confirming, and offers the confirmation', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderQuestBoard('write-note');
    const row = screen.getByRole('button', { name: /Write a Note: Active — needs your confirmation/ });
    expect(row).toBeTruthy();
    const complete = screen.getByRole('button', { name: /Mark Complete/ });
    expect(complete.getAttribute('data-quest-complete')).toBe('write-note');
    expect((complete as HTMLElement).style.minHeight).toBe('44px');
    await user.click(complete);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('offers no confirmation for a step the learner can just walk into', () => {
    renderQuestBoard('create-subject');
    expect(screen.queryByRole('button', { name: /Mark Complete/ })).toBeNull();
  });

  it('selects a step from the keyboard, and dismisses from the keyboard', async () => {
    const user = userEvent.setup();
    const { onSelectStep, onClose } = renderQuestBoard('create-subject');
    const row = screen.getByRole('button', { name: /Training Grounds: Locked/ });
    row.focus();
    await user.keyboard('{Enter}');
    expect(onSelectStep).toHaveBeenCalledWith('visit-training');

    // A side panel is a `region`, not a dialog, so Escape is not its dismissal
    // gesture - the labelled Close control is, and it is keyboard-operable. The
    // asymmetry with the sheet is deliberate and is asserted in both directions.
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    screen.getByRole('button', { name: "Close Keeper's Quest Board" }).focus();
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('carries the quest overview, which needs nothing but the roster', () => {
    renderQuestBoard('create-subject');
    const overview = screen.getByRole('region', { name: 'Who can speak to this quest' });
    expect(overview).toBeTruthy();
    for (const npc of VILLAGE_MAP.npcs) {
      // Only quest-givers get a row, exactly as the contract decides.
      const hasScript = npc.questDialogue != null;
      const row = document.querySelector(`[data-npc-id="${npc.id}"]`);
      expect(row !== null, `${npc.id} row`).toBe(hasScript);
    }
  });
});

/* ── The HUD ────────────────────────────────────────────────────────────── */

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

describe('the HUD is a labelled region on a wide viewport', () => {
  it('is a named region with no toggle, and states the quest in words', () => {
    render(<VillageHud {...HUD_PROPS} />);
    const region = screen.getByRole('region', { name: 'Village status and controls' });
    expect(region.getAttribute('data-village-surface')).toBe('side');
    expect(screen.queryByRole('button', { name: /village status and controls/i })).toBeNull();
    // The side panel never takes focus, so this is how a screen-reader user learns
    // that the current quest changed. Scoped to the HUD, because the nearby list
    // carries its own live region.
    const status = within(region).getAllByRole('status').find((node) =>
      (node.textContent ?? '').includes('Quest:'),
    );
    expect(status?.textContent).toContain('Quest: Meet the Keeper');
    expect(status?.textContent).toContain('Archetype: not set');
  });

  it('marks the chosen archetype with aria-pressed, not only a class', async () => {
    const user = userEvent.setup();
    const onSelectClass = vi.fn();
    render(<VillageHud {...HUD_PROPS} onSelectClass={onSelectClass} />);
    const group = screen.getByRole('group', { name: 'Study Archetype' });
    const cards = within(group).getAllByRole('button');
    for (const card of cards) {
      expect(card.getAttribute('aria-pressed')).toBe('false');
    }
    await user.click(cards[0] as HTMLElement);
    expect(onSelectClass).toHaveBeenCalledTimes(1);
  });

  /*
   * Phase 21: this assertion changed, and the reason is recorded rather than the expectation retyped.
   *
   * It read `getByRole('group')` and then looked for the single `aria-pressed="true"` button. The colour
   * picker is a **radio group** now: three mutually exclusive choices, so three toggle buttons each claiming
   * to be independently pressable was the wrong shape, and axe reported `critical: aria-allowed-attr` on the
   * Settings dialog's equivalent markup because those members carried both `aria-checked` and `aria-pressed`.
   *
   * The property worth asserting is the same one - "the current theme is marked, and only the current theme
   * is" - expressed against the role that actually carries it: `role="radiogroup"`, `role="radio"`,
   * `aria-checked`. Two things are added rather than replaced, because they are the properties the role adds:
   * the group is **one tab stop**, and the chosen member carries a `✓` in the DOM so the state survives for a
   * learner who cannot separate the gold accent from the panel behind it.
   */
  it('marks the current colour theme as the one checked radio, and nothing else', () => {
    render(<VillageHud {...HUD_PROPS} colorTheme="colorful" />);
    const group = screen.getByRole('radiogroup', { name: 'Colour theme' });
    const themes = within(group).getAllByRole('radio');

    expect(themes.map((theme) => theme.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    // `textContent` includes the `✓` because it is a real character in the DOM - which is the point of
    // putting it there rather than in a `::before` pseudo. The *label* is asserted through the accessible
    // name, which excludes the `aria-hidden` mark.
    expect(within(group).getByRole('radio', { checked: true })).toHaveAccessibleName('Arcade');

    // One tab stop, and it is the checked member.
    expect(themes.filter((theme) => theme.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(themes[1]).toHaveAttribute('tabindex', '0');

    // The non-colour half of the state: a mark in the DOM, hidden from the accessibility tree so a screen
    // reader hears "checked" once rather than "checked, check mark".
    const marks = group.querySelectorAll('.village-theme-picker__mark');
    expect(marks, 'the selected theme has no non-colour mark').toHaveLength(1);
    expect(marks[0]?.closest('button')).toBe(themes[1]);
    expect(marks[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  it('makes the quest steps real, labelled buttons rather than clickable spans', async () => {
    const user = userEvent.setup();
    const onQuestClick = vi.fn();
    render(<VillageHud {...HUD_PROPS} onQuestClick={onQuestClick} />);
    const group = screen.getByRole('group', { name: /Quest steps/ });
    const dots = within(group).getAllByRole('button');
    expect(dots.length).toBe(QUEST_ORDER.length - 1);
    for (const dot of dots) {
      expect(dot.getAttribute('aria-label')).toBeTruthy();
      expect((dot as HTMLElement).style.minWidth).toBe('44px');
    }
    const current = dots.filter((dot) => dot.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    await user.click(dots[0] as HTMLElement);
    // The dot strip omits `intro`, so its first row is `meet-keeper`.
    expect(onQuestClick).toHaveBeenCalledWith('meet-keeper');
  });

  it('hides the quest overview behind a native disclosure, so it is keyboard reachable', async () => {
    const user = userEvent.setup();
    render(<VillageHud {...HUD_PROPS} />);
    const summary = screen.getByText('Who can help with this quest');
    expect(summary.tagName).toBe('SUMMARY');
    // A `<details>` needs no aria-expanded bookkeeping that can drift, and works
    // with Enter and Space for free.
    await user.click(summary);
    expect((screen.getByRole('region', { name: 'Who can help' }) as HTMLElement).closest('details'))
      .not.toBeNull();
  });
});

describe('the HUD is a bottom sheet on a touch viewport', () => {
  it('collapses to a 44-pixel toggle that says whether it is open', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageHud {...HUD_PROPS} />);
    const toggle = screen.getByRole('button', { name: 'Open village status and controls' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    expect((toggle as HTMLElement).style.minWidth).toBe('44px');

    // Closed by default on touch, because the drawer covers the world's own
    // 56-pixel Interact control at the bottom of the viewport.
    expect(screen.queryByRole('region', { name: 'Village status and controls' })).toBeNull();

    await user.click(toggle);
    const sheet = screen.getByRole('dialog', { name: 'Village status and controls' });
    expect(sheet.getAttribute('data-village-surface')).toBe('sheet');
    expect(sheet.getAttribute('aria-modal')).toBe('false');
    expect(document.activeElement, 'the sheet did not take focus').toBe(sheet);
  });

  it('closes on Escape and restores focus to the toggle', async () => {
    const user = userEvent.setup();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageHud {...HUD_PROPS} />);
    const toggle = screen.getByRole('button', { name: 'Open village status and controls' });
    toggle.focus();
    await user.click(toggle);
    expect(screen.getByRole('dialog', { name: 'Village status and controls' })).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Village status and controls' })).toBeNull();
    });
    expect(document.activeElement, 'focus was not restored to the toggle').toBe(
      screen.getByRole('button', { name: 'Open village status and controls' }),
    );
  });

  it('tells the screen when it opens, so the two bottom surfaces do not overlap', async () => {
    const user = userEvent.setup();
    const onDrawerOpenChange = vi.fn();
    stubDevice({ maxTouchPoints: 5 });
    render(<VillageHud {...HUD_PROPS} onDrawerOpenChange={onDrawerOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Open village status and controls' }));
    expect(onDrawerOpenChange).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'Close village status and controls' }));
    expect(onDrawerOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('never fires that callback on a wide viewport, because there is no drawer', () => {
    const onDrawerOpenChange = vi.fn();
    render(<VillageHud {...HUD_PROPS} onDrawerOpenChange={onDrawerOpenChange} />);
    expect(onDrawerOpenChange).not.toHaveBeenCalled();
  });
});

/* ── The two dialogs ────────────────────────────────────────────────────── */

describe('the create-subject dialog obeys the three dialog rules', () => {
  it('renders nothing when closed, and is a named, non-focus-stealing dialog when open', () => {
    const { rerender } = render(
      <CreateSubjectDialog open={false} onCreate={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<CreateSubjectDialog open onCreate={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Create New Subject' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The container, not the first field: focusing a text input would turn the
    // learner's next keystrokes into a subject name.
    expect(document.activeElement).toBe(dialog);
  });

  it('labels every field, so the inputs are reachable by their label', () => {
    render(<CreateSubjectDialog open onCreate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Subject name')).toBeTruthy();
    expect(screen.getByLabelText('Root topic')).toBeTruthy();
    expect(screen.getByLabelText('Dungeon theme')).toBeTruthy();
  });

  it('refuses to submit an empty pair, and does not say it can', () => {
    render(<CreateSubjectDialog open onCreate={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits the trimmed pair and closes', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<CreateSubjectDialog open onCreate={onCreate} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Subject name'), '  Linear Algebra  ');
    await user.type(screen.getByLabelText('Root topic'), 'Vector Spaces');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Linear Algebra', topic: 'Vector Spaces' }),
    );
  });

  it('closes on Escape and on Cancel, and not on a click on the backdrop', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <CreateSubjectDialog open onCreate={vi.fn()} onClose={onClose} />,
    );
    const backdrop = container.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onClose, 'a click on the dimmed area closed the dialog').not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops Escape while a submit is in flight, rather than looking dismissible', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let release: (() => void) | null = null;
    const onCreate = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    render(<CreateSubjectDialog open onCreate={onCreate} onClose={onClose} />);
    await user.type(screen.getByLabelText('Subject name'), 'Algebra');
    await user.type(screen.getByLabelText('Root topic'), 'Vectors');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    });
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    act(() => { release?.(); });
  });
});

describe('the data dialog says its data is local and stays local', () => {
  it('states the local-storage promise in words, and labels the import control', () => {
    render(
      <DataManagementDialog
        open
        subjects={[{ id: 's1', subjectName: 'Algebra', roomCount: 8, clearedRoomCount: 3 }]}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Data Management' });
    expect(dialog.textContent).toMatch(/stored locally on this device/i);
    expect(dialog.textContent).toMatch(/Nothing is uploaded anywhere/i);
    expect(screen.getByLabelText('Import a subject file')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
  });

  it('closes on Escape, and not on a click on the backdrop', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <DataManagementDialog open subjects={[]} onClose={onClose} />,
    );
    await user.click(container.querySelector('.modal-backdrop') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/* ── The NPC dialogue bubble ────────────────────────────────────────────── */

describe('the NPC dialogue is announced in words', () => {
  it('is a polite live region on a stable element, so a cycling line is spoken', () => {
    const { rerender, container } = render(
      <NpcDialog line="Welcome, traveller." npcId="keeper" label="Keeper of Knowledge" colorTheme="dark" />,
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.getAttribute('role')).toBe('status');
    expect(live?.getAttribute('data-npc-id')).toBe('keeper');
    const liveNode = live;
    const paragraph = live?.querySelector('.village-npc-dialog-text');

    rerender(
      <NpcDialog line="The Guild Hall is east." npcId="keeper" label="Keeper of Knowledge" colorTheme="dark" />,
    );
    // The live region node is the *same* node: the typing animation's `key` is on
    // the inner paragraph, so remounting the bubble cannot silence it.
    expect(container.querySelector('[aria-live="polite"]')).toBe(liveNode);
    expect(container.querySelector('.village-npc-dialog-text')?.textContent).toBe(
      'The Guild Hall is east.',
    );
    expect(paragraph).not.toBe(container.querySelector('.village-npc-dialog-text'));
  });

  it('renders nothing for an empty line, which the contract calls a content signal', () => {
    const { container } = render(
      <NpcDialog line="" npcId="keeper" label="Keeper of Knowledge" colorTheme="dark" />,
    );
    expect(container.querySelector('.village-npc-dialog')).toBeNull();
  });

  it('anchors itself in CSS viewport pixels, from the contract anchor', () => {
    const { container } = render(
      <NpcDialog
        line="Welcome."
        npcId="keeper"
        label="Keeper"
        anchor={{ npcId: 'keeper', clientX: 400, clientY: 300 }}
        colorTheme="dark"
      />,
    );
    const bubble = container.querySelector<HTMLElement>('.village-npc-dialog');
    expect(bubble?.className).toContain('village-npc-dialog--anchored');
    // jsdom reports 0 for every box, so the documented fallbacks are what is
    // measured: 400 + 24 (right of the NPC) and 300 - 140 - 8 (above it).
    expect(bubble?.style.left).toBe('424px');
    expect(bubble?.style.top).toBe('152px');
  });

  it('clamps an anchor that would push the bubble off the right edge', () => {
    const { container } = render(
      <NpcDialog
        line="Welcome."
        npcId="keeper"
        label="Keeper"
        anchor={{ npcId: 'keeper', clientX: 1020, clientY: 300 }}
        colorTheme="dark"
      />,
    );
    const bubble = container.querySelector<HTMLElement>('.village-npc-dialog');
    // 1020 - 360 - 24 = 636: it flips to the NPC's left, which already fits
    // inside the clamp of 1024 - 360 - 12 = 652.
    expect(bubble?.style.left).toBe('636px');
  });

  it('states where the line came from, when the surface knows', () => {
    render(
      <NpcDialog
        line="A small talk line."
        npcId="villager-1"
        label="Wandering Scholar"
        source="quote"
        lineCount={4}
        lineIndex={1}
        colorTheme="dark"
      />,
    );
    expect(screen.getByText(/Line 2 of 4\./)).toBeTruthy();
    expect(screen.getByText(/Small talk\./)).toBeTruthy();
  });
});

/* ── The overview needs nothing ─────────────────────────────────────────── */

describe('the quest overview is renderer-free by construction', () => {
  it('renders from the roster and the step alone', () => {
    expect(() => render(<VillageQuestOverview questStep="complete" />)).not.toThrow();
    expect(screen.getByRole('region', { name: 'Who can help' }).textContent).toContain(
      'Current quest: Journey Begins.',
    );
  });
});
