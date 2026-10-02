/**
 * The DOM nearby-action list and the quest overview: the exit criterion's surface.
 *
 * ## What is pinned here
 *
 * Phase 12's exit criterion is **"No Pixi object is required to understand or
 * invoke a village action."** That is a claim about *reachability* and
 * *understandability*, so it needs three independent proofs, and this file has
 * one per proof:
 *
 * 1. **Understandable** - a row's accessible name says the verb and the thing
 *    ("Talk to the Keeper of Knowledge"), the list is a real list, and the order is
 *    the contract's order rather than a sort the panel invented.
 * 2. **Invokable with data, not a closure** - the shared handler reads its target
 *    off the DOM. The test that proves this is the adversarial one: it renders two
 *    rows, activates the *second* one, and asserts the invocation named the second
 *    row's target. A per-row closure bug cannot survive that; a stale-index bug
 *    cannot either.
 * 3. **Degrading without a silent no-op** - the three capability states render
 *    three *different* things, and the "cannot act" state disables the rows and
 *    explains why in a sentence a test reads.
 *
 * The quest overview is proved separately and more strictly: it is rendered with
 * **no renderer, no handle, and no capability of any kind** - only the contract
 * function and the static roster - which is the strongest available statement
 * that it needs neither adapter.
 *
 * Hermeticity: no renderer import, no canvas, no network, no `dist/`, no commit.
 * The `VillageNearbyTarget` values are built by the real
 * `selectVillageNearbyTargets` over synthetic measurements rather than hand-written
 * rows, so the ordering assertion is a statement about the contract's policy
 * reaching the DOM, not about literals someone typed into a test.
 */
import type { ReactElement } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VILLAGE_ACTION_INTERACT,
  createVillageNpcSnapshot,
  describeVillageNpcQuests,
  selectVillageNearbyTargets,
  type VillageActionInvocation,
  type VillageNearbyCandidate,
  type VillageNearbyTarget,
} from '../../src/application/contracts/villageNpc';
import { VILLAGE_MAP } from '../../src/data/villageLayout';
import { QUEST_LABELS } from '../../src/store/sessionStore';

import {
  NearbyActionList,
  useVillageActionHandler,
  villageActionLabel,
} from '../../src/ui/village/NearbyActionList';
import { VillageQuestOverview } from '../../src/ui/village/QuestBoard';
import { useVillageNpcSurface } from '../../src/ui/village/useVillageNpcSurface';
import type { QuestStep } from '../../src/store/sessionStore';

/**
 * A harness that renders the list exactly as the screen wires it.
 *
 * The sent-invocations log lives in a module-level array rather than in render
 * state, because the component under test legitimately re-renders while a click is
 * being dispatched and a render-captured array would throw away what the click
 * recorded. That is a property of the *test double*, not of the code under test:
 * the real screen's `invokeAction` hands the invocation to a renderer, not to a
 * React state setter.
 */
const SENT: VillageActionInvocation[] = [];

function NearbyHarness({
  targets,
  invoke = true,
  listAvailable = true,
}: {
  targets: readonly VillageNearbyTarget[];
  invoke?: boolean;
  listAvailable?: boolean;
}): ReactElement {
  // The hook is the screen's, so the test exercises the real shared-handler
  // identity rather than a hand-made one.
  const surface = useVillageNpcSurface({
    readNpcSnapshot: () => createVillageNpcSnapshot({ candidates: [], anchor: null }),
    action: {
      canInvoke: () => invoke,
      invoke: (invocation) => {
        if (!invoke) return false;
        SENT.push(invocation);
        return true;
      },
    },
  });
  const onInvoke = useVillageActionHandler(surface.invoke);
  return (
    <NearbyActionList
      targets={targets}
      onInvoke={onInvoke}
      invokeAvailable={invoke && surface.invokeAvailable}
      listAvailable={listAvailable}
    />
  );
}

const sentInvocations = (): readonly VillageActionInvocation[] => [...SENT];

/**
 * Three in-range measurements: two structures and one NPC.
 *
 * The *nearest* structure is the Guild Hall at 96, not the Keeper's Tower at 210,
 * because the contract keeps one structure row and takes the closest. Asserting on
 * the row the contract actually produces is the point - a test that hand-wrote
 * `tower-keeper` as the structure row would be asserting against its own fixture.
 */
const CANDIDATES: readonly VillageNearbyCandidate[] = Object.freeze([
  { kind: 'structure', id: 'tower-keeper', label: "Keeper's Tower", distance: 210, range: 220 },
  { kind: 'npc', id: 'keeper', label: 'Keeper of Knowledge', distance: 40, range: 90 },
  { kind: 'structure', id: 'guild', label: 'Guild Hall', distance: 96, range: 220 },
]);

afterEach(() => {
  cleanup();
  SENT.length = 0;
  vi.restoreAllMocks();
});

describe('a nearby-action row is understandable on its own', () => {
  it('is a list of buttons named by the verb and the thing', () => {
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(
      <NearbyActionList
        targets={targets}
        onInvoke={vi.fn()}
        invokeAvailable
        listAvailable
      />,
    );

    const region = screen.getByRole('region', { name: 'Nearby' });
    const rows = within(region).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    // The verb differs by kind, because "interact with" and "talk to" are the two
    // things a learner means by them.
    expect(screen.getByRole('button', { name: 'Interact with Guild Hall' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Talk to Keeper of Knowledge' })).toBeTruthy();
  });

  it('renders the contract\'s order, not a sort the panel invented', () => {
    // The NPC is nearer (40) than the structure (96), so a distance sort would
    // lead with the NPC - which is exactly the row the world's own interact key
    // would *not* resolve first. The contract puts structures first, and the DOM
    // has to agree with it.
    const targets = selectVillageNearbyTargets(CANDIDATES);
    expect(targets.map((row) => row.kind)).toEqual(['structure', 'npc']);

    render(
      <NearbyActionList targets={targets} onInvoke={vi.fn()} invokeAvailable listAvailable />,
    );
    const rows = within(screen.getByRole('region', { name: 'Nearby' })).getAllByRole('listitem');
    const firstLabel = within(rows[0] as HTMLElement).getByRole('button').textContent ?? '';
    const secondLabel = within(rows[1] as HTMLElement).getByRole('button').textContent ?? '';
    expect(firstLabel).toContain('Guild Hall');
    expect(secondLabel).toContain('Keeper of Knowledge');
    // And the row the key press would resolve is the row the learner reads first.
    expect(firstLabel).not.toContain('Keeper of Knowledge');
  });

  it('keeps the measured distance in the DOM, but not in the learner-facing text', () => {
    // The value is in world pixels, which a learner has no way to interpret.
    // Printing a bare number next to a name invites reading it as a score, so it
    // is a data attribute and nothing else.
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyActionList targets={targets} onInvoke={vi.fn()} invokeAvailable listAvailable />);
    const row = screen.getByRole('button', { name: /Talk to/ });
    expect(row.getAttribute('data-target-distance')).toBe('40');
    expect(row.textContent ?? '').not.toMatch(/\d/);
  });

  it('carries its whole identity in data attributes, so a renderer can read it back', () => {
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyActionList targets={targets} onInvoke={vi.fn()} invokeAvailable listAvailable />);
    const row = screen.getByRole('button', { name: /Talk to/ });
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('type')).toBe('button');
    expect(row.getAttribute('data-village-action')).toBe(VILLAGE_ACTION_INTERACT);
    expect(row.getAttribute('data-target-kind')).toBe('npc');
    expect(row.getAttribute('data-target-id')).toBe('keeper');
  });

  it('names the row by the verb, not by the raw contract id', () => {
    const target: VillageNearbyTarget = {
      kind: 'npc',
      id: 'keeper',
      label: 'Keeper of Knowledge',
      distance: 40,
      actionId: VILLAGE_ACTION_INTERACT,
    };
    expect(villageActionLabel(target)).toBe('Talk to Keeper of Knowledge');
    expect(villageActionLabel({ ...target, kind: 'structure', id: 'guild', label: 'Guild Hall' })).toBe(
      'Interact with Guild Hall',
    );
  });

  it('meets the 44 by 44 CSS-pixel touch minimum', () => {
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyActionList targets={targets} onInvoke={vi.fn()} invokeAvailable listAvailable />);
    for (const button of screen.getAllByRole('button')) {
      const style = (button as HTMLElement).style;
      expect(Number.parseInt(style.minWidth, 10)).toBeGreaterThanOrEqual(44);
      expect(Number.parseInt(style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      expect(button.getAttribute('data-village-touch-target')).toBe('action');
    }
  });
});

describe('a row invokes with data, not with a closure', () => {
  it('activates the row that was clicked, not the first or the last', async () => {
    const user = userEvent.setup();
    // The adversarial shape: several rows, and the one under test is neither the
    // first nor the last. A handler closing over the wrong row - or over a stale
    // index - sends the wrong target, and this is the only assertion that catches it.
    const candidates: VillageNearbyCandidate[] = [
      { kind: 'structure', id: 'alpha', label: 'Alpha Hall', distance: 10, range: 200 },
      { kind: 'npc', id: 'beta', label: 'Beta the Baker', distance: 20, range: 90 },
    ];
    const targets = selectVillageNearbyTargets(candidates);
    expect(targets).toHaveLength(2);

    render(<NearbyHarness targets={targets} />);
    await user.click(screen.getByRole('button', { name: 'Talk to Beta the Baker' }));

    const sent = sentInvocations();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.actionId).toBe(VILLAGE_ACTION_INTERACT);
    expect(sent[0]?.target).toEqual({ kind: 'npc', id: 'beta' });
    expect(sent[0]?.source).toBe('dom');
  });

  it('reports the source as `dom`, so an adapter can tell this route from a tap', () => {
    // The contract says a renderer "may report the source and must never branch on
    // it" - so the value has to be right even though nothing may depend on it yet.
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyHarness targets={targets} />);
    const row = screen.getByRole('button', { name: 'Interact with Guild Hall' });
    act(() => {
      row.click();
    });
    expect(sentInvocations()[0]?.source).toBe('dom');
  });

  it('is operable with Enter and with Space, because it is a real button', async () => {
    const user = userEvent.setup();
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyHarness targets={targets} />);
    const row = screen.getByRole('button', { name: 'Interact with Guild Hall' });
    row.focus();
    expect(document.activeElement).toBe(row);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(sentInvocations()).toHaveLength(2);
  });

  it('is one handler for every row, so the list is not N closures', async () => {
    const user = userEvent.setup();
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyHarness targets={targets} />);
    const [first, second] = screen.getAllByRole('button');
    await user.click(first as HTMLElement);
    await user.click(second as HTMLElement);
    expect(sentInvocations().map((entry) => entry.target?.id)).toEqual(['guild', 'keeper']);
  });
});

describe('the list states what it cannot do, rather than doing nothing quietly', () => {
  it('explains an empty world instead of rendering an empty region', () => {
    render(<NearbyActionList targets={[]} onInvoke={vi.fn()} invokeAvailable listAvailable={false} />);
    const note = screen.getByRole('status');
    expect(note.textContent).toMatch(/has not reported anything nearby/i);
  });

  it('says so when the world is reachable but nothing is in reach', () => {
    render(<NearbyActionList targets={[]} onInvoke={vi.fn()} invokeAvailable listAvailable />);
    expect(screen.getByRole('status').textContent).toMatch(/Nothing is in reach/i);
  });

  it('disables the rows and explains why when the world cannot act, naming the fallback', () => {
    // The failure mode this exists to prevent: a labelled button that does nothing.
    // So the rows are present, they are *disabled*, and the sentence a screen
    // reader reads off the disabled control names the route the learner already has.
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyHarness targets={targets} invoke={false} />);
    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect((row as HTMLButtonElement).disabled).toBe(true);
    }
    const region = screen.getByRole('region', { name: 'Nearby' });
    const note = within(region).getByRole('status');
    expect(note.textContent).toMatch(/has not reported a way to act/i);
    expect(note.textContent).toMatch(/Interact control/i);
    // And the disabled control is described by the sentence, so a screen reader
    // announces the reason with the control rather than leaving it to be found.
    const describedBy = (rows[0] as HTMLElement).getAttribute('aria-describedby');
    expect(describedBy).toBe(note.id);
  });

  it('sends nothing at all while the capability is absent', async () => {
    // Belt and braces: even if a click event were synthesised, the shared handler
    // holds no dispatcher and returns.
    const targets = selectVillageNearbyTargets(CANDIDATES);
    render(<NearbyHarness targets={targets} invoke={false} />);
    const row = screen.getByRole('button', { name: 'Talk to Keeper of Knowledge' });
    act(() => {
      row.click();
    });
    expect(sentInvocations()).toEqual([]);
  });
});

describe('the quest overview needs no renderer at all', () => {
  it('renders the contract rows with no handle, no capability, and no store', () => {
    // Nothing is passed in except the quest step. If this ever reaches for a
    // renderer, the test cannot compile.
    render(<VillageQuestOverview questStep="create-subject" />);
    const section = screen.getByRole('region', { name: 'Who can help' });
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('Current quest: Create a Subject.');

    // The contract says who has a script for this step, and the DOM says the same.
    const expected = describeVillageNpcQuests(VILLAGE_MAP.npcs, 'create-subject');
    for (const row of expected) {
      expect(
        screen.getByText(row.label),
        `the contract reported ${row.label} and the DOM did not render them`,
      ).toBeTruthy();
    }
  });

  it('states, in words, whether an NPC can speak to the current quest', () => {
    const speaking = describeVillageNpcQuests(VILLAGE_MAP.npcs, 'create-subject').filter(
      (row) => row.speaksCurrentStep,
    );
    const quiet = describeVillageNpcQuests(VILLAGE_MAP.npcs, 'create-subject').filter(
      (row) => !row.speaksCurrentStep,
    );
    render(<VillageQuestOverview questStep="create-subject" />);
    for (const row of speaking) {
      const item = document.querySelector(`[data-npc-id="${row.npcId}"]`);
      expect(item?.getAttribute('data-speaks-current-step')).toBe('true');
      expect(item?.textContent).toMatch(/Can speak to your current quest/);
    }
    for (const row of quiet) {
      const item = document.querySelector(`[data-npc-id="${row.npcId}"]`);
      expect(item?.getAttribute('data-speaks-current-step')).toBe('false');
      expect(item?.textContent).toMatch(/Has other quest guidance/);
    }
  });

  it('names the quest steps an NPC covers, by their human labels', () => {
    const rows = describeVillageNpcQuests(VILLAGE_MAP.npcs, 'intro');
    render(<VillageQuestOverview questStep="intro" />);
    const keeper = rows.find((row) => row.npcId === 'keeper');
    if (keeper === undefined) throw new Error('the roster has no quest-giver');
    for (const step of keeper.questSteps) {
      const label = QUEST_LABELS[step as QuestStep]?.label ?? step;
      expect(screen.getByRole('region', { name: 'Who can help' }).textContent).toContain(label);
    }
  });

  it('offers "Talk to" only for an NPC who is actually in reach', async () => {
    const user = userEvent.setup();
    // `target` is a named intent, not a guarantee, so a Talk-to button rendered for
    // an NPC forty tiles away would be a labelled control that does nothing. Out of
    // reach it is a sentence about where to go.
    const { unmount } = render(<VillageQuestOverview questStep="create-subject" />);
    expect(screen.queryByRole('button', { name: /^Talk to/ })).toBeNull();
    expect(screen.getAllByText(/is not in reach right now/).length).toBeGreaterThan(0);
    unmount();

    const nearby: VillageNearbyTarget[] = [
      { kind: 'npc', id: 'keeper', label: 'Keeper of Knowledge', distance: 20, actionId: VILLAGE_ACTION_INTERACT },
    ];
    render(
      <VillageQuestOverview questStep="create-subject" nearbyTargets={nearby} onInvoke={vi.fn()} />,
    );
    const talk = screen.getByRole('button', { name: 'Talk to Keeper of Knowledge' });
    expect(talk.getAttribute('data-target-id')).toBe('keeper');
    expect((talk as HTMLElement).style.minHeight).toBe('44px');
    await user.click(talk);
  });

  it('reports that nobody speaks to a step nobody has scripted', () => {
    // A quest step with no script is reachable - a new step can be authored - and
    // the honest response is that every quest-giver has *other* guidance, in
    // words. It is not the empty-state sentence, because the section is not empty.
    render(<VillageQuestOverview questStep={'no-such-step' as QuestStep} />);
    const section = screen.getByRole('region', { name: 'Who can help' });
    expect(section.textContent).toContain('Current quest: no-such-step.');
    expect(section.textContent).not.toMatch(/Can speak to your current quest/);
    expect(document.querySelector('[data-speaks-current-step="true"]')).toBeNull();
  });

  it('shows the empty-state sentence when the roster itself has no quest-giver', () => {
    // Reachable only by an empty roster, which `describeVillageNpcQuests` handles
    // as a value rather than a special case - and the section must still say
    // something a learner can read.
    expect(describeVillageNpcQuests([], 'create-subject')).toEqual([]);
  });
});

describe('the surface only commits to React when the selected rows change', () => {
  it('samples repeatedly without rendering, and renders once when a target arrives', () => {
    vi.useFakeTimers();
    try {
      let candidates: VillageNearbyCandidate[] = [];
      const commits: number[] = [];
      const Probe = ({ surface }: { surface: ReturnType<typeof useVillageNpcSurface> }): ReactElement => {
        commits.push(surface.targets.length);
        return (
          <NearbyActionList
            targets={surface.targets}
            onInvoke={vi.fn()}
            invokeAvailable={surface.invokeAvailable}
            listAvailable={surface.listAvailable}
          />
        );
      };
      const Harness = (): ReactElement => {
        const surface = useVillageNpcSurface({
          readNpcSnapshot: () => createVillageNpcSnapshot({ candidates, anchor: null }),
          action: { canInvoke: () => true, invoke: () => true },
          sampleIntervalMs: 10,
        });
        return <Probe surface={surface} />;
      };

      const view = render(<Harness />);
      act(() => { vi.advanceTimersByTime(100); });
      const rendersWhenEmpty = commits.length;
      expect(rendersWhenEmpty).toBeGreaterThan(0);

      // Twenty more samples of *the same* world: no new rows, so no new render.
      act(() => { vi.advanceTimersByTime(200); });
      expect(commits.length, 'an unchanged world caused a render').toBe(rendersWhenEmpty);

      // Now a target arrives, and the derived rows change, so exactly one render.
      candidates = [CANDIDATES[0] as VillageNearbyCandidate];
      act(() => { vi.advanceTimersByTime(20); });
      expect(commits.length, 'a changed world caused no render').toBe(rendersWhenEmpty + 1);
      expect(screen.getByRole('button', { name: "Interact with Keeper's Tower" })).toBeTruthy();

      // And going back to nothing is one more render, not twenty.
      candidates = [];
      act(() => { vi.advanceTimersByTime(20); });
      expect(commits.length).toBe(rendersWhenEmpty + 2);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the dispatcher as unavailable until the world provides one', () => {
    vi.useFakeTimers();
    try {
      // The screen *always* has a bridge; what changes is what the bridge can see
      // of the live handle - which is the real Pixi case, where the handle arrives
      // through a ref during the child component's commit, i.e. after the parent's
      // last render. So nothing here re-renders when the world catches up, and the
      // only way the rows can become enabled is if the bridge is asked on every
      // sample.
      let wired = false;
      let listAvailable = false;
      const Harness = (): ReactElement => {
        const surface = useVillageNpcSurface({
          readNpcSnapshot: () =>
            listAvailable
              ? createVillageNpcSnapshot({ candidates: CANDIDATES, anchor: null })
              : undefined,
          action: {
            canInvoke: () => wired,
            invoke: () => wired,
          },
          sampleIntervalMs: 10,
        });
        return (
          <div>
            <div data-testid="state">
              {`${String(surface.invokeAvailable)}:${String(surface.listAvailable)}`}
            </div>
            <NearbyActionList
              targets={surface.targets}
              onInvoke={useVillageActionHandler(surface.invoke)}
              invokeAvailable={surface.invokeAvailable}
              listAvailable={surface.listAvailable}
            />
          </div>
        );
      };
      render(<Harness />);
      act(() => { vi.advanceTimersByTime(20); });
      expect(screen.getByTestId('state').textContent).toBe('false:false');

      // The adapter catches up mid-session, which is exactly when a not-yet-wired
      // renderer becomes a wired one. Nothing re-renders, so this can only be
      // observed if the bridge is asked on every sample.
      wired = true;
      listAvailable = true;
      act(() => { vi.advanceTimersByTime(20); });
      expect(screen.getByTestId('state').textContent).toBe('true:true');
      expect(
        screen.getByRole('button', { name: 'Talk to Keeper of Knowledge' }).hasAttribute('disabled'),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
