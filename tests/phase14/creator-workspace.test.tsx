/**
 * The redesigned Creator workspace, on the flag-on lane.
 *
 * ## What this file holds
 *
 * `RoomPanel` chooses between two Creator experiences on one build-time flag, so this file
 * mocks `@/config/featureFlags` with `creatorWorkspace: true` and exercises the new one; its
 * sibling `creator-rollback.test.tsx` mocks it `false` and exercises the old one. Neither
 * test changes a component to make its case, so "the flag decides" is itself under test.
 *
 * ## Why the renderer is absent by construction
 *
 * Nothing here mounts a renderer, a canvas, or a scene. The workspace is reached through
 * `RoomPanel` with a snapshot the fixture built through the graph domain, so if a
 * world-object or a Pixi import were required to use the Creator flow, this file would
 * fail to render at all.
 */
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Persistence is out of scope for these tests: a Creator command commits in memory and the
// write is stubbed, so a test can assert a mutation without touching storage.
vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return {
    ...actual,
    saveSubjectSnapshot: vi.fn(async () => ({ success: true })),
  };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, creatorWorkspace: true },
  };
});

import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { RoomPanel } from '@/ui/components/RoomPanel';
import { resolveCreatorToolPlan } from '@/ui/study/creator/creatorTools';
import { buildCreatorFixture, type CreatorFixture } from './support/creatorFixtures';

let fixture: CreatorFixture;

function panel(
  roomId: string,
  overrides: Partial<React.ComponentProps<typeof RoomPanel>> = {},
): ReactElement {
  const snapshot = useSubjectStore.getState().snapshot;
  if (snapshot === null) throw new Error('No snapshot installed');
  return (
    <RoomPanel
      snapshot={snapshot}
      focusedRoom={snapshot.rooms[roomId] ?? null}
      onInteract={() => undefined}
      onClose={() => undefined}
      onTravelToRoom={() => undefined}
      reviewPassesCompleted={0}
      reviewRoomsTowardNextPass={0}
      reviewNextPassTarget={1}
      reviewTotalRooms={1}
      {...overrides}
    />
  );
}

function regionOrder(): string[] {
  return [...document.querySelectorAll('[data-study-region]')].map(
    (element) => element.getAttribute('data-study-region') ?? '',
  );
}

function regionById(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-study-region="${id}"]`);
  if (element === null) throw new Error(`No region ${id}`);
  return element;
}

/** The dungeon's own summary row for the fixture's root room. */
function rootRoomSummary(snapshot: NonNullable<ReturnType<typeof useSubjectStore.getState>['snapshot']>) {
  const summary = snapshot.dungeon.rooms.find((room) => room.roomId === fixture.rootRoomId);
  if (summary === undefined) throw new Error('No root summary');
  return summary;
}

beforeEach(() => {
  fixture = buildCreatorFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useSessionStore.setState({
    phase: 'creator',
    selectedClass: null,
    focusedRoomId: fixture.rootRoomId,
    activeScreen: 'game',
  });
});

afterEach(() => {
  cleanup();
});

describe('the flag-on Creator lane', () => {
  it('renders the workspace instead of the pre-Phase-14 Creator view', () => {
    render(panel(fixture.rootRoomId));

    expect(screen.getByLabelText('Creator workspace')).toBeInTheDocument();
    // The legacy lane's own controls are the rollback's evidence: their absence here is
    // what makes "the flag decides" true rather than "both render at once".
    expect(screen.queryByRole('button', { name: /Add child rooms/i })).toBeNull();
  });

  it('organises the workspace around current topic, related topics, structure, and a next action', () => {
    render(panel(fixture.rootRoomId));

    expect(regionOrder()).toEqual([
      'current-topic',
      'related-topics',
      'graph-structure',
      'topic-tools',
    ]);
    expect(screen.getByText(/Next: Add child topics/i)).toBeInTheDocument();
  });

  it('carries the current topic, its status, its floor, and its path in the shell header', () => {
    render(panel(fixture.matrixRoomId));

    const workspace = screen.getByLabelText('Creator workspace');
    expect(within(workspace).getByRole('heading', { name: 'Matrices' })).toBeInTheDocument();
    expect(within(workspace).getByText('Status').nextElementSibling?.textContent).toBe('Created');
    // A direct child of the root is the entry room of its own floor, which is the
    // hierarchy's floor model and not something this phase changed.
    expect(within(workspace).getByText('Floor').nextElementSibling?.textContent).toBe('Matrices');
    expect(within(workspace).getByText('Path').nextElementSibling?.textContent).toBe(
      'Linear Algebra → Matrices',
    );
  });

  it('states a room that needs revalidation in words, not only in a dashed border', () => {
    const snapshot = useSubjectStore.getState().snapshot;
    if (snapshot === null) throw new Error('No snapshot installed');
    const matrixRoom = snapshot.rooms[fixture.matrixRoomId];
    if (matrixRoom === undefined) throw new Error('No matrix room');
    useSubjectStore.setState({
      snapshot: {
        ...snapshot,
        rooms: {
          ...snapshot.rooms,
          [fixture.matrixRoomId]: { ...matrixRoom, state: 'NeedsRevalidation' },
        },
      },
    });

    render(panel(fixture.matrixRoomId));

    expect(
      within(regionById('graph-structure')).getByRole('button', {
        // The name carries every state word, so a node's status is never only a colour.
        name: 'Matrices, current topic, needs revalidation',
      }),
    ).toBeInTheDocument();
    expect(
      within(regionById('current-topic')).getAllByText(/Needs revalidation/i).length,
    ).toBeGreaterThan(0);
  });

  it('recommends revalidation first when a room is waiting on it', () => {
    const snapshot = useSubjectStore.getState().snapshot;
    if (snapshot === null) throw new Error('No snapshot installed');
    useSubjectStore.setState({
      snapshot: {
        ...snapshot,
        rooms: {
          ...snapshot.rooms,
          [fixture.eigenRoomId]: {
            ...snapshot.rooms[fixture.eigenRoomId]!,
            state: 'NeedsRevalidation',
          },
        },
      },
    });

    render(panel(fixture.eigenRoomId));

    expect(screen.getByText(/Next: Revalidate this topic in Scribe/i)).toBeInTheDocument();
  });
});

describe('archetype prominence', () => {
  it('leads with the graph and opens it for the Cartographer', () => {
    useSessionStore.setState({ selectedClass: 'cartographer' });
    render(panel(fixture.rootRoomId));

    const plan = resolveCreatorToolPlan('cartographer');
    expect(regionOrder()).toEqual([...plan.order]);
    expect(regionOrder()[0]).toBe('graph-structure');
    // Opened by default, not merely present.
    expect(regionById('graph-structure').querySelector('[data-study-region] , svg')).not.toBeNull();
    expect(
      within(regionById('graph-structure')).getByRole('button', { name: 'Hide Graph structure' }),
    ).toBeInTheDocument();
    expect(
      within(regionById('current-topic')).getByRole('button', { name: 'Show Current topic' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Next: Link a related topic/i)).toBeInTheDocument();
  });

  it('leads with the topic and its tools for the Scholar', () => {
    useSessionStore.setState({ selectedClass: 'scholar' });
    render(panel(fixture.rootRoomId));

    expect(regionOrder().slice(0, 2)).toEqual(['current-topic', 'topic-tools']);
    expect(
      within(regionById('topic-tools')).getByRole('button', { name: 'Hide Topic tools' }),
    ).toBeInTheDocument();
  });

  it('leads with existing connections for the Archivist, and keeps every tool reachable', () => {
    useSessionStore.setState({ selectedClass: 'archivist' });
    render(panel(fixture.rootRoomId));

    expect(regionOrder()[0]).toBe('related-topics');
    // Prominence is ordering, never capability: every region is present and openable.
    for (const id of ['current-topic', 'related-topics', 'graph-structure', 'topic-tools']) {
      const region = regionById(id);
      const toggle = within(region).getByRole('button', { name: new RegExp(`^(Hide|Show) `) });
      expect(toggle).toBeInTheDocument();
      if (toggle.getAttribute('aria-expanded') === 'false') {
        fireEvent.click(toggle);
        expect(
          within(region).getByRole('button', { name: /^Hide / }),
        ).toBeInTheDocument();
      }
    }
  });

  it('says what the archetype changed, in the header, in the same words the layout uses', () => {
    useSessionStore.setState({ selectedClass: 'cartographer' });
    render(panel(fixture.rootRoomId));

    const workspace = screen.getByLabelText('Creator workspace');
    expect(within(workspace).getByText(/Cartographer: the graph and its links lead/)).toBeInTheDocument();
    expect(regionOrder()[0]).toBe('graph-structure');
  });

  it('makes no suggestion claim, because the suggestion engine is Phase 19', () => {
    useSessionStore.setState({ selectedClass: 'cartographer' });
    render(panel(fixture.rootRoomId));

    expect(screen.queryByText(/suggest/i)).toBeNull();
  });
});

describe('refusals are visible', () => {
  it('disables deleting the root topic and says why in the layout', () => {
    render(panel(fixture.rootRoomId));

    const remove = screen.getByRole('button', { name: 'Delete topic' });
    expect(remove).toBeDisabled();
    // Not in `aria-describedby` alone: a disabled button is not focusable, so a reason that
    // lived only there would be unreachable exactly when it matters.
    expect(screen.getByText('The root topic cannot be deleted.')).toBeVisible();
  });

  it('disables reparenting the root topic and says why', () => {
    render(panel(fixture.rootRoomId));

    expect(screen.getByLabelText('Move under')).toBeDisabled();
    expect(
      screen.getByText('The root topic cannot be moved under another topic.'),
    ).toBeVisible();
  });

  it('explains an empty bulk-creation field rather than only greying the button', () => {
    render(panel(fixture.rootRoomId));

    expect(screen.getByRole('button', { name: 'Add child topics' })).toBeDisabled();
    expect(screen.getByText('Type at least one topic to add.')).toBeVisible();
  });

  it('states the Scribe transition rule that existed before this phase', () => {
    render(panel(fixture.rootRoomId));

    // Five rooms, and the rule has always been three.
    expect(screen.getByText('Your map has enough topics to start Scribe encounters.')).toBeVisible();
  });

  it('does not offer the transition while the map is too small', () => {
    const snapshot = useSubjectStore.getState().snapshot;
    if (snapshot === null) throw new Error('No snapshot installed');
    const twoRooms = {
      ...snapshot,
      dungeon: {
        ...snapshot.dungeon,
        rooms: snapshot.dungeon.rooms.filter((room) =>
          [fixture.rootRoomId, fixture.matrixRoomId].includes(room.roomId),
        ),
        edges: snapshot.dungeon.edges.filter(
          (edge) => edge.fromRoomId === fixture.rootRoomId || edge.toRoomId === fixture.matrixRoomId,
        ),
      },
      rooms: {
        [fixture.rootRoomId]: snapshot.rooms[fixture.rootRoomId]!,
        [fixture.matrixRoomId]: snapshot.rooms[fixture.matrixRoomId]!,
      },
    };
    useSubjectStore.setState({ snapshot: twoRooms });

    render(panel(fixture.rootRoomId));

    expect(screen.getByText('Scribe opens once the map has 3 topics.')).toBeVisible();
    // Still present, disabled, and saying why: the rule is visible before it is met.
    const switchToScribe = screen.getByRole('button', { name: /^Switch to Scribe$/ });
    expect(switchToScribe).toBeDisabled();
    expect(screen.getByText(/Add 1 more topic and the Scribe phase opens\./)).toBeVisible();
  });
});

describe('the Scribe transition is available at the intended point', () => {
  it('hands the phase over when the learner acts on it', () => {
    render(panel(fixture.rootRoomId));

    fireEvent.click(screen.getByRole('button', { name: /^Switch to Scribe$/ }));

    expect(useSessionStore.getState().phase).toBe('scribe');
  });
});

describe('the DOM routes to every graph verb', () => {
  it('exposes create, link, reparent, tag, move, and delete without a pointer', () => {
    // A non-root, non-root-parent room, so every verb is legal at once.
    useSessionStore.setState({ focusedRoomId: fixture.matrixRoomId });
    render(panel(fixture.matrixRoomId));

    // create
    expect(screen.getByRole('textbox', { name: 'Add child topics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add child topics' })).toBeInTheDocument();
    // link
    expect(screen.getByLabelText('Cross-link with')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create cross-link' })).toBeInTheDocument();
    // reparent
    expect(screen.getByLabelText('Move under')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move under new parent' })).toBeInTheDocument();
    // tag
    expect(screen.getByLabelText('New tag')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace all tags' })).toBeInTheDocument();
    // move (presentation)
    expect(screen.getByRole('button', { name: 'Move box right' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset box positions' })).toBeInTheDocument();
    // delete
    expect(screen.getByRole('button', { name: 'Delete topic' })).toBeEnabled();
  });

  it('tells the learner what a delete will take with it, before asking', () => {
    render(panel(fixture.matrixRoomId));

    // Matrices owns one descendant.
    expect(
      screen.getByText('Asks before removing this topic and 1 subtopic.'),
    ).toBeVisible();
  });

  it('keeps every study control at least 44 by 44', () => {
    useSessionStore.setState({ selectedClass: 'scholar' });
    render(panel(fixture.matrixRoomId));

    const controls = [...document.querySelectorAll<HTMLElement>('[data-study-touch-target]')];
    expect(controls.length).toBeGreaterThan(15);
    for (const control of controls) {
      const style = control.style;
      expect(`${control.getAttribute('data-study-touch-target')}:${style.minWidth}`).toMatch(
        /:44px$/,
      );
      expect(`${control.getAttribute('data-study-touch-target')}:${style.minHeight}`).toMatch(
        /:44px$/,
      );
    }
  });

  it('says the empty case in words for a subject with one topic and no relations', () => {
    const snapshot = useSubjectStore.getState().snapshot;
    if (snapshot === null) throw new Error('No snapshot installed');
    const rootRoom = snapshot.rooms[fixture.rootRoomId];
    if (rootRoom === undefined) throw new Error('No root room');
    useSubjectStore.setState({
      snapshot: {
        dungeon: { ...snapshot.dungeon, rooms: [rootRoomSummary(snapshot)], edges: [] },
        rooms: { [fixture.rootRoomId]: rootRoom },
      },
    });

    render(panel(fixture.rootRoomId));

    expect(screen.getByText(/This topic is not connected to anything yet/i)).toBeVisible();
  });

  it('marks the current topic in words as well as in a border', () => {
    render(panel(fixture.matrixRoomId));

    const current = within(regionById('current-topic')).getByRole('button', {
      name: 'Working on Matrices',
    });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toBeDisabled();
    expect(within(regionById('current-topic')).getAllByText('Current topic').length).toBeGreaterThan(0);
  });
});

describe('the next action moves focus to the control that performs it', () => {
  it('opens the tool region and focuses the bulk-creation box', () => {
    useSessionStore.setState({ focusedRoomId: fixture.matrixRoomId });
    render(panel(fixture.matrixRoomId));

    // The Scholar's lead step is child-topic creation, and Topic tools starts open.
    fireEvent.click(screen.getByRole('button', { name: 'Go to the topic box' }));

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Add child topics' }));
  });

  it('opens a collapsed region before moving focus into it', () => {
    useSessionStore.setState({ selectedClass: 'cartographer', focusedRoomId: fixture.matrixRoomId });
    render(panel(fixture.matrixRoomId));

    // Topic tools is collapsed for a Cartographer, and the Scribe step focuses a control
    // inside it, so the region has to open first or focus lands on a hidden element.
    const toolsRegion = regionById('topic-tools');
    expect(within(toolsRegion).getByRole('button', { name: 'Show Topic tools' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go to the cross-link picker' }));

    expect(within(toolsRegion).queryByRole('button', { name: 'Hide Topic tools' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Cross-link with' }));
  });
});

describe('the guide-conversation DOM route', () => {
  it('is reachable in the Creator phase and opens the same dialog the world renders', () => {
    render(panel(fixture.matrixRoomId));

    const trigger = screen.getByRole('button', {
      name: 'Talk to the room guide about Matrices',
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    expect(
      screen.getByRole('group', { name: 'Guide conversation about Matrices' }),
    ).toBeInTheDocument();
    // The copy comes from `RoomNpcDialog`, not from a second implementation of it.
    expect(screen.getByRole('status', { name: 'Room guide' })).toBeInTheDocument();
  });
});
