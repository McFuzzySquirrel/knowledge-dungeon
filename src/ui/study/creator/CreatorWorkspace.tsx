/**
 * The redesigned Creator learning flow.
 *
 * ## What the workspace is organised around
 *
 * The pre-Phase-14 Creator view was a room panel with a tools menu behind a `⋯`: an
 * "Add child topics" textarea, a parent `<select>`, a delete button behind a native
 * `confirm()`, and a nudge that only appeared once the map had three rooms. Every verb
 * existed, but the order of the page was the order the code happened to be written in and
 * the learner had to know which control to look for.
 *
 * This workspace is organised around the four questions the phase names - **current topic,
 * related topics, graph structure, next action** - in an order decided per archetype, with
 * the next action stated in words and attached to the control that performs it.
 *
 * ## Four rules this component holds itself to
 *
 * 1. **No mutation leaves an event handler.** The only dispatcher is
 *    {@link useCreatorGraphActions}, and the only callers of it are `onClick` handlers.
 *    The effects in this file set *presentation* state (which region is open, where focus
 *    goes); none of them dispatches. That is what makes the StrictMode exit criterion a
 *    property of the design instead of a habit.
 * 2. **Selection is local, mutation is not.** `selectedRoomId` decides which topic the
 *    tools act on. It is not the character: editing a topic three rooms away does not move
 *    the player, and walking into a room does not undo an edit in progress.
 * 3. **Every verb has a DOM route.** Create, link, reparent, tag, move, and delete are
 *    buttons, selects, and text fields in this tree, all keyboard-reachable and all at
 *    least 44 by 44. None of them needs a canvas, a drag, or a renderer.
 * 4. **The archetype changes something observable.** {@link resolveCreatorToolPlan}
 *    decides the region order, which regions start open, and which step leads. Every tool
 *    stays reachable in every archetype.
 *
 * ## The rollback
 *
 * `RoomPanel` renders this workspace only when `runtimeConfig.creatorWorkspace` is `true`.
 * With the flag off - the production default - the pre-Phase-14 Creator view renders
 * unchanged and the pre-Phase-14 store actions still perform every mutation, so the two
 * lanes do not share an implementation.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { PlayerClassId } from '@/application/contracts/world';
import type { SubjectSnapshot } from '@/core/validation/persistence';

import { StudyActionButton } from '../StudyControls';
import { STUDY_CONTROL_IDS, focusStudyControl } from '../controlIds';
import { StudyShell, type StudyRegionSpec } from '../StudyShell';
import { GraphMap } from './GraphMap';
import { RelatedTopicList, TopicEditor } from './TopicEditor';
import { isExpandedByDefault, resolveCreatorToolPlan, type CreatorRegionId } from './creatorTools';
import {
  SCRIBE_TRANSITION_ROOM_COUNT,
  buildCreatorWorkspaceModel,
  type CreatorNextActionSuggestion,
} from './creatorViewModel';
import { useCreatorGraphActions } from './useCreatorGraphActions';
import { AssistanceSlot } from '@/ui/assistance/AssistanceSlot';

export interface CreatorWorkspaceProps {
  readonly snapshot: SubjectSnapshot;
  /** The room the character is standing in, from the room panel's own focus. */
  readonly focusedRoomId: string | null;
  /** Which archetype is playing. `null` before the tutorial's pick step. */
  readonly archetype: PlayerClassId | null;
  /** Hand the phase over to Scribe, for the transition recommendation. */
  readonly onSwitchToScribe: () => void;
}

/** Which region holds each focusable control a next action can send focus to. */
const CONTROL_REGION: Readonly<Record<string, CreatorRegionId>> = Object.freeze({
  [STUDY_CONTROL_IDS.childTopicsInput]: 'topic-tools',
  [STUDY_CONTROL_IDS.tagReplaceInput]: 'topic-tools',
  [STUDY_CONTROL_IDS.crossLinkSelect]: 'topic-tools',
  [STUDY_CONTROL_IDS.reparentSelect]: 'topic-tools',
  [STUDY_CONTROL_IDS.graphView]: 'graph-structure',
  [STUDY_CONTROL_IDS.topicList]: 'current-topic',
});

/** The next action's control and region, per recommendation. */
const NEXT_ACTION_TARGET: Readonly<
  Record<string, { controlId: string; label: string; openRegion: CreatorRegionId }>
> = Object.freeze({
  'add-child-topics': {
    controlId: STUDY_CONTROL_IDS.childTopicsInput,
    label: 'Go to the topic box',
    openRegion: 'topic-tools',
  },
  'cross-link': {
    controlId: STUDY_CONTROL_IDS.crossLinkSelect,
    label: 'Go to the cross-link picker',
    openRegion: 'topic-tools',
  },
  'review-structure': {
    controlId: STUDY_CONTROL_IDS.graphView,
    label: 'Go to the graph',
    openRegion: 'graph-structure',
  },
});

export function CreatorWorkspace({
  snapshot,
  focusedRoomId,
  archetype,
  onSwitchToScribe,
}: CreatorWorkspaceProps): ReactNode {
  const rootRoomId = snapshot.dungeon.rootRoomId;
  const actions = useCreatorGraphActions();

  /*
   * Selection starts from the room the learner is standing in and follows it: walking into
   * a room is a statement about which topic they are now working on, and that is the
   * behaviour the pre-Phase-14 panel had. The initialiser is lazy, so this is the focused
   * room at mount and never a re-seed on a later change.
   */
  const [selectedRoomId, setSelectedRoomId] = useState<string>(
    () => focusedRoomId ?? rootRoomId,
  );
  useEffect(() => {
    if (focusedRoomId !== null) setSelectedRoomId(focusedRoomId);
  }, [focusedRoomId]);

  /*
   * A selection can outlive its room: a cascade delete removes a room the learner was
   * editing a moment ago. Falling back during render - rather than in an effect - means the
   * workspace never renders a frame whose tools point at a room that is not there.
   */
  const effectiveRoomId =
    snapshot.rooms[selectedRoomId] !== undefined ? selectedRoomId : rootRoomId;
  const model = useMemo(
    () => buildCreatorWorkspaceModel(snapshot, effectiveRoomId),
    [effectiveRoomId, snapshot],
  );

  const plan = useMemo(() => resolveCreatorToolPlan(archetype), [archetype]);
  const [regionOverrides, setRegionOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [focusProblem, setFocusProblem] = useState<string | null>(null);

  const isExpanded = useCallback(
    (regionId: CreatorRegionId): boolean =>
      regionOverrides[regionId] ?? isExpandedByDefault(plan, regionId),
    [plan, regionOverrides],
  );

  const toggleRegion = useCallback((regionId: CreatorRegionId): void => {
    setRegionOverrides((current) => ({ ...current, [regionId]: !isExpanded(regionId) }));
  }, [isExpanded]);

  /**
   * Send focus to a control, opening its region first.
   *
   * The region has to be open *before* the focus lands, or `focus()` lands on a hidden
   * element and the browser drops it - which reads to a keyboard user as the button doing
   * nothing. The nonce makes this a request rather than a flag, so asking twice moves
   * focus twice.
   */
  const requestFocus = useCallback(
    (controlId: string): void => {
      const regionId = CONTROL_REGION[controlId];
      if (regionId !== undefined) {
        setRegionOverrides((current) => ({ ...current, [regionId]: true }));
      }
      setFocusProblem(null);
      setFocusRequest((current) => ({ id: controlId, nonce: (current?.nonce ?? 0) + 1 }));
    },
    [],
  );

  useEffect(() => {
    if (focusRequest === null) return;
    const moved = focusStudyControl(focusRequest.id);
    if (!moved) {
      setFocusProblem(
        'That step needs a control that is not on screen. Open the tool that holds it and try again.',
      );
    }
  }, [focusRequest]);

  /*
   * The recommendation order: the archetype's step leads, the rest follow the view model's
   * own ranking. Both lists are complete, so this is a rotation rather than a filter - no
   * step is ever dropped for being "not this archetype's".
   *
   * One exception, and it is about honesty rather than taste: a topic that a graph change
   * has marked `NeedsRevalidation` leads for every archetype. Telling a Cartographer to go
   * and link something while their note is known to be stale is the kind of advice a plan
   * line like "actual tool prominence" is meant to prevent.
   */
  const rankedNextActions = useMemo(() => {
    const revalidation = model.nextActions.find(
      (entry) => entry.key === 'handle-revalidation' && entry.available,
    );
    const primary = model.nextActions.find((entry) => entry.key === plan.primaryNextAction);
    const lead = revalidation ?? primary;
    return lead === undefined
      ? [...model.nextActions]
      : [lead, ...model.nextActions.filter((entry) => entry.key !== lead.key)];
  }, [model.nextActions, plan.primaryNextAction]);
  const leadAction = rankedNextActions[0] ?? null;
  const secondaryActions = rankedNextActions.slice(1, 4);
  const scribeAvailable = rankedNextActions.some(
    (entry) => entry.key === 'start-scribe' && entry.available,
  );

  /*
   * A cross-link target chosen from the related-topics list, handed to the cross-link tool.
   *
   * State rather than a DOM poke: the select is React-controlled, so writing to
   * `element.value` would be overwritten by the next render and the pick would silently
   * disappear.
   */
  const [crossLinkPreset, setCrossLinkPreset] = useState<string | null>(null);

  const selectRoom = useCallback((roomId: string): void => {
    setSelectedRoomId(roomId);
  }, []);

  const renderNextActionControl = (entry: CreatorNextActionSuggestion): ReactNode => {
    if (entry.key === 'start-scribe' || entry.key === 'handle-revalidation') {
      return (
        <StudyActionButton
          label={entry.key === 'start-scribe' ? 'Switch to Scribe' : 'Switch to Scribe to revalidate'}
          touchTarget={`next-action-${entry.key}`}
          tone="primary"
          refusal={entry.available ? null : entry.refusal}
          onClick={onSwitchToScribe}
        />
      );
    }
    const target = NEXT_ACTION_TARGET[entry.key];
    if (target === undefined) return null;
    return (
      <StudyActionButton
        label={target.label}
        touchTarget={`next-action-${entry.key}`}
        tone="primary"
        refusal={entry.available ? null : entry.refusal}
        onClick={() => requestFocus(target.controlId)}
      />
    );
  };

  const regionContent: Readonly<Record<CreatorRegionId, ReactNode>> = {
    'current-topic': (
      <div id={STUDY_CONTROL_IDS.topicList} tabIndex={-1}>
        <p className="study-tool__preview">
          {`${model.current.childCount} direct subtopic${model.current.childCount === 1 ? '' : 's'}, ${model.current.descendantCount} below in total, ${model.current.tags.length} tag${model.current.tags.length === 1 ? '' : 's'}.`}
        </p>
        <ul className="study-list" aria-label="Topics in this subject">
          {model.rooms.map((room) => {
            const isCurrent = room.roomId === model.current.roomId;
            return (
              <li
                key={room.roomId}
                className={`study-list__row${isCurrent ? ' study-list__row--current' : ''}`}
              >
                <span className="study-list__name">
                  {room.topic}
                  {isCurrent ? <span className="study-list__relation"> Current topic</span> : null}
                  {room.needsRevalidation ? (
                    <span className="study-list__relation"> Needs revalidation</span>
                  ) : null}
                </span>
                <span className="study-list__actions">
                  <button
                    type="button"
                    className="study-inline-btn"
                    data-study-touch-target="topic-pick"
                    style={{ minWidth: '44px', minHeight: '44px' }}
                    aria-current={isCurrent ? 'true' : undefined}
                    disabled={isCurrent}
                    onClick={() => selectRoom(room.roomId)}
                  >
                    {isCurrent ? `Working on ${room.topic}` : `Work on ${room.topic}`}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    ),
    'related-topics': (
      <RelatedTopicList
        model={model}
        actions={actions}
        onSelectRoom={selectRoom}
        onRequestCrossLink={(roomId) => {
          // Preset the target and open the tool. Selecting the target first would move the
          // workspace off the topic being linked, which is the topic the link starts from.
          setCrossLinkPreset(roomId);
          requestFocus(STUDY_CONTROL_IDS.crossLinkSelect);
        }}
      />
    ),
    'graph-structure': (
      <div id={STUDY_CONTROL_IDS.graphView} tabIndex={-1}>
        <GraphMap
          snapshot={snapshot}
          selectedRoomId={model.current.roomId}
          onSelectRoom={selectRoom}
          summary={{
            roomCount: model.structure.roomCount,
            childEdgeCount: model.structure.childEdgeCount,
            crossLinkCount: model.structure.crossLinkCount,
            floorCount: model.structure.floorCount,
          }}
        />
        <p className="study-graph__summary">
          {model.structure.floors
            .map((floor) => `${floor.label}: ${floor.roomCount} topic${floor.roomCount === 1 ? '' : 's'}`)
            .join(' · ')}
        </p>
      </div>
    ),
    'topic-tools': (
      <TopicEditor
        model={model}
        actions={actions}
        onSelectRoom={selectRoom}
        crossLinkPreset={crossLinkPreset}
      />
    ),
  };

  const regionTitles: Readonly<Record<CreatorRegionId, { title: string; description: string }>> = {
    'current-topic': {
      title: 'Current topic',
      description: 'The topic the tools below act on, and every topic in the subject.',
    },
    'related-topics': {
      title: 'Related topics',
      description: 'The parent, subtopics, and cross-links of the current topic.',
    },
    'graph-structure': {
      title: 'Graph structure',
      description: 'Every topic in the subject, as a map. Box positions are screen-only.',
    },
    'topic-tools': {
      title: 'Topic tools',
      description: 'Add subtopics, link, re-parent, tag, and delete the current topic.',
    },
  };

  const regions: StudyRegionSpec[] = plan.order.map((regionId) => {
    const meta = regionTitles[regionId];
    return {
      id: regionId,
      title: meta.title,
      description: meta.description,
      expanded: isExpanded(regionId),
      onToggle: () => toggleRegion(regionId),
      children: regionContent[regionId],
    };
  });

  return (
    <StudyShell
      phase="creator"
      subjectName={snapshot.dungeon.subjectName}
      archetypeNote={plan.note}
      context={{
        topic: model.current.topic,
        status: model.current.state,
        floor: model.current.floorLabel,
        breadcrumb: model.current.breadcrumb,
      }}
      regions={regions}
      nextAction={
        leadAction === null
          ? null
          : {
              id: leadAction.key,
              label: leadAction.label,
              detail: leadAction.detail,
              action: renderNextActionControl(leadAction),
            }
      }
      feedback={actions.feedback}
      label="Creator workspace"
    >
      {/*
        Phase 19: the Creator suggestion card.

        First child of the shell, so it sits directly after the workspace's own next action -
        never above it. Advice that outranks the primary recommendation would make assistance look
        like the main path, and "advisory" is the whole claim this feature makes.

        Rendered with no `flagEnabled` prop, so it takes `runtimeConfig.adaptiveAssistance` and
        the rollback lane is the flag's own: with `VITE_ADAPTIVE_ASSISTANCE=false` this component
        renders `null` and the pre-Phase-14 Creator view is byte-identical.
      */}
      <AssistanceSlot surface="creator" snapshot={snapshot} />
      {focusProblem === null ? null : (
        <p className="study-action__note study-action__note--refusal" role="status">
          {focusProblem}
        </p>
      )}
      {secondaryActions.length === 0 ? null : (
        <section className="study-secondary-actions" aria-label="Other steps for this topic">
          <h3 className="study-region__title">Also available</h3>
          {secondaryActions.map((entry) => (
            <p key={entry.key} className="study-secondary-actions__row">
              <span>{`${entry.label}: ${entry.detail}`}</span>
              {renderNextActionControl(entry)}
            </p>
          ))}
        </section>
      )}
      {/*
        The Scribe transition, preserved from the pre-Phase-14 Creator view: offered once the
        map has `SCRIBE_TRANSITION_ROOM_COUNT` topics, and reachable as a button from the
        next-action region as well as stated here.
      */}
      <p className="study-phase-nudge">
        {scribeAvailable
          ? 'Your map has enough topics to start Scribe encounters.'
          : `Scribe opens once the map has ${SCRIBE_TRANSITION_ROOM_COUNT} topics.`}
      </p>
    </StudyShell>
  );
}
