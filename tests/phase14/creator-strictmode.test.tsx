/**
 * Exit criterion 4: no duplicate graph mutations under React StrictMode.
 *
 * ## Why counting renders is not evidence
 *
 * StrictMode double-*invokes* effects in development, and every `graph/*` command in this
 * application is asynchronous: the controller reads a snapshot, runs the domain, and then
 * commits a new one. A mutation fired from an effect therefore applies twice, both
 * applications are individually valid - each commits its own snapshot - and nothing
 * throws, nothing warns, and the learner silently ends up with two copies of the topic
 * they asked for once. A test that renders in StrictMode and asserts the DOM has one more
 * child would catch it; a test that counts renders would not, because renders are not the
 * thing at risk.
 *
 * So every test here measures the mutation itself, by two independent counters:
 *
 * 1. **Dispatches.** `creatorGraphController.dispatch` is wrapped in a spy that forwards to
 *    the real controller. One user action must produce exactly one dispatch, so a second
 *    invocation anywhere - an effect, a double-fired event, a re-entrant handler - is red.
 * 2. **Commits.** `saveSubjectSnapshot` is mocked, so the store's write is counted. A
 *    mutation that dispatched once but committed twice (or the reverse) is also red, and
 *    this is the counter that catches a duplicate *effect* which happens to be idempotent.
 *
 * The graph's own shape is asserted too, because a counter can be fooled and a topic count
 * cannot: one `graph/children-add` with two topics must leave three rooms, not five.
 *
 * ## Every mutating verb, on its own
 *
 * `graph/children-add`, `graph/cross-link-add`, `graph/room-reparent`, `graph/room-remove`,
 * `graph/tags-set`, `graph/tag-add`, `graph/tag-remove` - all seven, each with:
 *
 * - the workspace rendered inside `<StrictMode>`;
 * - mounting, expanding regions, switching rooms, and re-rendering proven not to mutate;
 * - one activation producing one dispatch and one commit;
 * - the resulting graph asserted directly.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no clock. The store write is
 * stubbed, so a test proves a state transition and nothing about persistence.
 */
import { StrictMode, type ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store's write, counted. Everything else in the persistence module is the real thing.
vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

// The command boundary, counted and forwarded. The wrapper changes no behaviour: it records
// the call and hands the identical command to the identical controller.
vi.mock('@/store/creatorGraphCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/creatorGraphCommands')>();
  return {
    ...actual,
    creatorGraphController: {
      ...actual.creatorGraphController,
      dispatch: vi.fn(actual.creatorGraphController.dispatch),
    },
  };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, creatorWorkspace: true },
  };
});

import { saveSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { creatorGraphController } from '@/store/creatorGraphCommands';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { RoomPanel } from '@/ui/components/RoomPanel';
import {
  buildCreatorFixture,
  childrenOf,
  crossLinkCountOf,
  parentOf,
  withTags,
  type CreatorFixture,
} from './support/creatorFixtures';

const dispatchMock = vi.mocked(creatorGraphController.dispatch);
const saveMock = vi.mocked(saveSubjectSnapshot);

let fixture: CreatorFixture;

/**
 * Render the workspace for one room, inside StrictMode, with every region open.
 *
 * The Scholar's plan is used because it opens `current-topic` and `topic-tools` on arrival
 * and leaves the rest one toggle away - so a test can either use the tools directly or open
 * a region first, and both paths are exercised across this file.
 */
/**
 * RoomPanel wired the way `GameScreen` wires it: the snapshot arrives by store subscription
 * rather than as a value captured before the first render.
 *
 * Capturing it once - which this helper used to do - freezes the workspace's view at the
 * graph it started with, so a mutation a command commits is present in the store and absent
 * from the screen. That is a property of the harness and not of the product: `GameScreen`
 * reads `useSubjectStore((s) => s.snapshot)`, so the real panel re-renders on every commit.
 * A frozen prop also hid the parent fallback after a cascade delete, because the fallback
 * cannot be observed on a view that never updates.
 */
function LiveRoomPanel({ roomId }: { roomId: string }): ReactElement {
  const snapshot = useSubjectStore((s) => s.snapshot);
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
    />
  );
}

function renderWorkspace(roomId: string, archetype: 'scholar' | 'cartographer' = 'scholar'): ReactElement {
  useSessionStore.setState({ focusedRoomId: roomId, selectedClass: archetype });
  return (
    <StrictMode>
      <LiveRoomPanel roomId={roomId} />
    </StrictMode>
  );
}

function openRegion(id: string): void {
  const region = document.querySelector<HTMLElement>(`[data-study-region="${id}"]`);
  if (region === null) throw new Error(`No region ${id}`);
  const toggle = region.querySelector<HTMLButtonElement>('.study-region__toggle');
  if (toggle === null) throw new Error(`Region ${id} has no toggle`);
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
}

function snapshotNow() {
  const snapshot = useSubjectStore.getState().snapshot;
  if (snapshot === null) throw new Error('No snapshot installed');
  return snapshot;
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
  dispatchMock.mockClear();
  saveMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('mounting and re-rendering never mutates', () => {
  it('dispatches nothing and commits nothing on mount, under StrictMode', () => {
    render(renderWorkspace(fixture.matrixRoomId));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when regions are opened, collapsed, and re-opened', () => {
    render(renderWorkspace(fixture.matrixRoomId, 'cartographer'));

    openRegion('topic-tools');
    openRegion('topic-tools');
    openRegion('related-topics');
    openRegion('related-topics');

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when the learner switches the current topic', () => {
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.click(screen.getByRole('button', { name: 'Work on Eigenvalues' }));

    expect(screen.getByRole('heading', { name: 'Eigenvalues' })).toBeInTheDocument();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when a re-render is forced from outside the workspace', () => {
    const { rerender } = render(renderWorkspace(fixture.matrixRoomId));
    rerender(renderWorkspace(fixture.matrixRoomId));

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('graph/children-add fires exactly once', () => {
  it('adds two topics from one list, once', async () => {
    render(renderWorkspace(fixture.matrixRoomId));
    const before = snapshotNow();

    fireEvent.change(screen.getByRole('textbox', { name: 'Add child topics' }), {
      target: { value: 'Tensors, Eigenvectors' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add child topics' }));

    await waitFor(() => {
      expect(snapshotNow().dungeon.rooms).toHaveLength(before.dungeon.rooms.length + 2);
    });

    // The shape is the real evidence: three rooms added would mean the command ran twice.
    expect(childrenOf(snapshotNow(), fixture.matrixRoomId).sort()).toHaveLength(3);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[0]).toEqual({
      type: 'graph/children-add',
      payload: { parentRoomId: fixture.matrixRoomId, topics: ['Tensors', 'Eigenvectors'] },
    });
  });

  it('does not re-dispatch when the snapshot changes underneath it', async () => {
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.change(screen.getByRole('textbox', { name: 'Add child topics' }), {
      target: { value: 'Tensors' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add child topics' }));
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));

    // The commit landed, the store notified, the workspace re-rendered with a new model.
    fireEvent.click(screen.getByRole('button', { name: 'Work on Eigenvalues' }));
    fireEvent.click(screen.getByRole('button', { name: 'Work on Matrices' }));
    await Promise.resolve();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a second dispatch of the same scope inside one tick, which is what a double tap is', async () => {
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.change(screen.getByRole('textbox', { name: 'Add child topics' }), {
      target: { value: 'Tensors' },
    });
    const add = screen.getByRole('button', { name: 'Add child topics' });
    // Two activations before the first command settles: the guard must absorb the second.
    fireEvent.click(add);
    fireEvent.click(add);

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(snapshotNow().dungeon.rooms).toHaveLength(6));
    expect(childrenOf(snapshotNow(), fixture.matrixRoomId)).toHaveLength(2);
  });
});

describe('graph/cross-link-add fires exactly once', () => {
  it('creates one edge from one activation', async () => {
    render(renderWorkspace(fixture.matrixRoomId));
    const before = snapshotNow();
    expect(crossLinkCountOf(before, fixture.matrixRoomId)).toBe(0);

    fireEvent.change(screen.getByRole('combobox', { name: 'Cross-link with' }), {
      target: { value: fixture.vectorRoomId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cross-link' }));

    await waitFor(() => {
      expect(crossLinkCountOf(snapshotNow(), fixture.matrixRoomId)).toBe(1);
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[0]).toEqual({
      type: 'graph/cross-link-add',
      payload: {
        fromRoomId: fixture.matrixRoomId,
        toRoomId: fixture.vectorRoomId,
        relationType: 'related',
      },
    });
  });

  it('offers no cross-link row for an already-connected topic, and says why', async () => {
    render(renderWorkspace(fixture.rootRoomId));

    // The row lives in the `related-topics` region, which the Scholar plan leaves collapsed
    // on arrival. Opening it is a learner action, so it is done the way a learner does it -
    // through the region's own toggle - rather than by reaching into component state.
    openRegion('related-topics');

    /*
     * Matrices is a subtopic of the root, so an edge between them already exists. A
     * cross-link row here could only ever be refused by the domain with
     * `EDGE_ALREADY_EXISTS`, so the row must not offer the action at all.
     *
     * This is the row route's real contract, and it is why `graph/cross-link-add` is counted
     * exactly once through the `topic-tools` select instead: legal cross-link targets are
     * `linkCandidates`, which excludes everything already connected, and no row in this list
     * is ever such a target.
     */
    expect(
      screen.queryByRole('button', { name: /Cross-link to Matrices/i }),
    ).not.toBeInTheDocument();

    // Omitting an impossible control without a reason reads as an oversight, so the reason
    // is visible text on the row rather than an `aria-describedby` on an absent button.
    expect(
      screen.getAllByText(/Cannot cross-link here: Already connected as a subtopic/i).length,
    ).toBeGreaterThan(0);

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(crossLinkCountOf(snapshotNow(), fixture.rootRoomId)).toBe(0);
  });
});

describe('graph/room-reparent fires exactly once', () => {
  it('moves one room under one new parent', async () => {
    render(renderWorkspace(fixture.matrixRoomId));
    expect(parentOf(snapshotNow(), fixture.matrixRoomId)).toBe(fixture.rootRoomId);

    fireEvent.change(screen.getByRole('combobox', { name: 'Move under' }), {
      target: { value: fixture.vectorRoomId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move under new parent' }));

    await waitFor(() => {
      expect(parentOf(snapshotNow(), fixture.matrixRoomId)).toBe(fixture.vectorRoomId);
    });
    // The subtree moved with it, which is the behaviour being preserved: Eigenvalues still
    // hangs off Matrices, so reparenting touched one parent edge and not the subtree.
    expect(parentOf(snapshotNow(), fixture.eigenRoomId)).toBe(fixture.matrixRoomId);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('moves one room from a related-topics row, once', async () => {
    render(renderWorkspace(fixture.matrixRoomId));

    /*
     * Matrices' related list is its parent and its child, and neither is a legal place to
     * move it - one is the current parent, the other is a descendant. A legal row target has
     * to be a cross-link neighbour, because those are neither. So the cross-link is made
     * first, through the `topic-tools` select, which is the route that offers legal targets.
     */
    fireEvent.change(screen.getByRole('combobox', { name: 'Cross-link with' }), {
      target: { value: fixture.vectorRoomId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create cross-link' }));
    await waitFor(() => {
      expect(crossLinkCountOf(snapshotNow(), fixture.matrixRoomId)).toBe(1);
    });

    // Same disclosure as the cross-link refusal above: `related-topics` is collapsed under
    // the Scholar plan, and the row is reached the way a learner reaches it.
    openRegion('related-topics');

    /*
     * Vectors is a cross-link neighbour here, which is the case the related row used to get
     * wrong: it offered a "Cross-link to Vectors" button for a pair that is already linked,
     * so pressing it could only ever be refused by the domain with `EDGE_ALREADY_EXISTS`.
     * The row must offer no such control and must say why.
     *
     * Asserted before the reparent below, because that click turns Vectors from a cross-link
     * neighbour into the parent topic - after which the honest reason is the subtopic one.
     */
    expect(
      screen.queryByRole('button', { name: /Cross-link to Vectors/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Cannot cross-link here: Already cross-linked/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: `Move Matrices under ${'Vectors'}` }),
    );

    await waitFor(() => {
      expect(parentOf(snapshotNow(), fixture.matrixRoomId)).toBe(fixture.vectorRoomId);
    });
    // Two commands ran - the cross-link, then the reparent - and each exactly once.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(saveMock).toHaveBeenCalledTimes(2);
  });
});

describe('graph/room-remove fires exactly once', () => {
  it('removes the room and its orphaned descendants in one command', async () => {
    render(renderWorkspace(fixture.matrixRoomId));
    const before = snapshotNow().dungeon.rooms.length;

    fireEvent.click(screen.getByRole('button', { name: 'Delete topic' }));
    fireEvent.click(screen.getByRole('button', { name: `Yes, delete “Matrices”` }));

    await waitFor(() => {
      expect(snapshotNow().rooms[fixture.matrixRoomId]).toBeUndefined();
    });

    const after = snapshotNow();
    // Matrices plus Eigenvalues, so three fewer rooms: one command, not one per room.
    expect(after.dungeon.rooms).toHaveLength(before - 2);
    expect(after.rooms[fixture.eigenRoomId]).toBeUndefined();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[0]).toEqual({
      type: 'graph/room-remove',
      payload: { roomId: fixture.matrixRoomId },
    });
  });

  it('leaves the workspace on a topic that still exists after a cascade delete', async () => {
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.click(screen.getByRole('button', { name: 'Delete topic' }));
    fireEvent.click(screen.getByRole('button', { name: `Yes, delete “Matrices”` }));

    /*
     * Deleting Matrices takes Eigenvalues with it, and Matrices' parent is the root - so the
     * surviving selection is the root topic, not a sibling. `Vectors` would have been the
     * wrong assertion: it is a sibling of Matrices, never its parent.
     *
     * The root is the right fallback rather than merely a convenient one: it is the one room
     * a cascade can never remove, so the fallback cannot itself point at a deleted room.
     *
     * The legacy lane cleared the focus and closed the panel. This one keeps the workspace on
     * a live topic, so the DOM route back into the rest of the graph survives the delete.
     */
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Linear Algebra', level: 2 })).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Topic tools' })).toBeInTheDocument();
    expect(snapshotNow().rooms[fixture.matrixRoomId]).toBeUndefined();
    expect(snapshotNow().rooms[fixture.eigenRoomId]).toBeUndefined();
  });

  it('mutates nothing when the delete is not confirmed', async () => {
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.click(screen.getByRole('button', { name: 'Delete topic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep this topic' }));

    expect(snapshotNow().rooms[fixture.matrixRoomId]).toBeDefined();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe('graph/tag-add fires exactly once', () => {
  it('adds one tag from one activation', async () => {
    useSubjectStore.setState({ snapshot: withTags(fixture.snapshot, fixture.matrixRoomId, []) });
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.change(screen.getByRole('textbox', { name: 'New tag' }), {
      target: { value: 'algebra' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(snapshotNow().rooms[fixture.matrixRoomId]?.tags).toEqual(['algebra']);
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[0]).toEqual({
      type: 'graph/tag-add',
      payload: { roomId: fixture.matrixRoomId, tag: 'algebra' },
    });
  });
});

describe('graph/tag-remove fires exactly once', () => {
  it('removes one tag from one activation', async () => {
    useSubjectStore.setState({
      snapshot: withTags(fixture.snapshot, fixture.matrixRoomId, ['algebra', 'geometry']),
    });
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag geometry' }));

    await waitFor(() => {
      expect(snapshotNow().rooms[fixture.matrixRoomId]?.tags).toEqual(['algebra']);
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });
});

describe('graph/tags-set fires exactly once', () => {
  it('replaces the whole list from one activation', async () => {
    useSubjectStore.setState({
      snapshot: withTags(fixture.snapshot, fixture.matrixRoomId, ['algebra']),
    });
    render(renderWorkspace(fixture.matrixRoomId));

    fireEvent.change(screen.getByRole('textbox', { name: 'Replace all tags' }), {
      target: { value: 'geometry, symmetry' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all tags' }));

    await waitFor(() => {
      expect(snapshotNow().rooms[fixture.matrixRoomId]?.tags).toEqual(['geometry', 'symmetry']);
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[0]).toEqual({
      type: 'graph/tags-set',
      payload: { roomId: fixture.matrixRoomId, tags: ['geometry', 'symmetry'] },
    });
  });
});

/*
 * Controls refuse before they dispatch.
 *
 * This was previously framed as "a refused command still fires exactly once", which
 * described a case that cannot be reached: every control derives its options from
 * `linkCandidates` / `reparentCandidates`, so the domain's own refusals are pre-empted and
 * no UI path can produce one. The exactly-once guarantee for a *dispatched* command is
 * covered by the per-verb blocks above; what is left here is the guarantee that a control
 * with nothing valid to do says so and never reaches the domain at all.
 */
describe('a locally refused control never reaches the domain', () => {
  it('refuses locally when no cross-link target is chosen, and never reaches the domain', () => {
    render(renderWorkspace(fixture.rootRoomId));

    /*
     * Matrices is a subtopic of the root, so it is not a legal cross-link candidate and has
     * no option in the select. Asking the select for it therefore selects nothing, which is
     * the same state a learner is in before choosing a target at all.
     *
     * This is a pre-condition refusal rather than a command outcome. The control is disabled
     * and the reason is visible text on the control - not a live-region announcement, because
     * a polite announcement on arrival is noise. The shell's status region is for the refusal
     * that follows a command actually resolving, which is a different moment and is covered
     * by the other cases in this file.
     */
    fireEvent.change(screen.getByRole('combobox', { name: 'Cross-link with' }), {
      target: { value: fixture.matrixRoomId },
    });

    expect(screen.getByRole('button', { name: 'Create cross-link' })).toBeDisabled();
    expect(screen.getByText('Choose a topic to cross-link with.')).toBeInTheDocument();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(crossLinkCountOf(snapshotNow(), fixture.rootRoomId)).toBe(0);
  });
});
