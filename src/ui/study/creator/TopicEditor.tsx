/**
 * The Creator workspace's editing surface: the tools that change the current topic.
 *
 * ## Where the mutations come from
 *
 * Every verb here dispatches a `graph/*` command through {@link useCreatorGraphActions},
 * which is the only caller of the application layer's controller. Nothing in this file
 * calls a `src/core/graph` mutation function, reaches into `useSubjectStore`'s graph
 * actions, or knows that a store exists.
 *
 * ## What is preserved from the pre-Phase-14 Creator view, and where
 *
 * | Behaviour | Where it lives now |
 * | --- | --- |
 * | Bulk child-topic creation (comma or newline separated) | {@link ChildTopicTool}, on the same `parseTopicBatch` |
 * | Cross-links | {@link CrossLinkTool} - the first DOM route to `graph/cross-link-add` |
 * | Reparenting | {@link ReparentTool} and {@link RelatedTopicList}, with the same candidate filter (`isReachableViaSubtopics`) |
 * | Deletion with cascade | {@link DeleteTool}, which states the cascade count before it is confirmed |
 * | Revalidation | Not here: every `graph/*` command runs `propagateRevalidationAfterGraphMutation` itself, and the state it writes is read back through the snapshot |
 * | Map node repositioning | Not here: `GraphMap` keeps those offsets as presentation |
 * | The Scribe transition | `CreatorWorkspace`'s next action, on the same room-count rule |
 *
 * ## Refusals
 *
 * A control that cannot act is disabled **and** says why in visible text, and the reason
 * comes from the condition the graph domain itself refuses on. A stale candidate list can
 * still produce a refusal at dispatch time; that one is the domain's own message, shown in
 * the workspace's live sentence.
 */
import { useEffect, useState, type ReactNode } from 'react';

import type { EdgeRelationType } from '@/core/validation/persistence';
import { TagEditor } from '@/ui/components/TagEditor';
import { parseTopicBatch } from '@/ui/utils/topicParsing';

import {
  StudyActionButton,
  StudyChoice,
  StudyTextarea,
  STUDY_TOUCH_TARGET_STYLE,
  STUDY_TOUCH_TARGET_ATTRIBUTE,
} from '../StudyControls';
import { STUDY_CONTROL_IDS } from '../controlIds';
import type { CreatorWorkspaceModel } from './creatorViewModel';
import type { CreatorGraphActions } from './useCreatorGraphActions';

/**
 * The relations a cross-link can carry.
 *
 * `subtopic` is deliberately absent: a subtopic edge is what reparenting creates, and
 * offering it here would give a learner two controls for one edge.
 */
const CROSS_LINK_RELATIONS: readonly EdgeRelationType[] = [
  'related',
  'analogy',
  'prerequisite',
  'depends_on',
];

const RELATION_LABEL: Readonly<Record<EdgeRelationType, string>> = Object.freeze({
  related: 'Related to',
  analogy: 'Analogy for',
  prerequisite: 'Prerequisite for',
  depends_on: 'Depends on',
  subtopic: 'Subtopic of',
});

/** The scope strings the guard and the pending flags agree on, per verb. */
export const CREATOR_COMMAND_SCOPES = Object.freeze({
  childrenAdd: 'children-add',
  crossLink: 'cross-link',
  reparent: 'room-reparent',
  remove: 'room-remove',
  tagAdd: 'tag-add',
  tagRemove: 'tag-remove',
  tagSet: 'tag-set',
});

export interface TopicEditorProps {
  readonly model: CreatorWorkspaceModel;
  readonly actions: CreatorGraphActions;
  /** Move the workspace's current topic. */
  readonly onSelectRoom: (roomId: string) => void;
  /**
   * A cross-link target picked elsewhere in the workspace, applied when it changes.
   *
   * `null` clears nothing: a target chosen in the related-topics list lands in the
   * cross-link picker without the learner re-choosing it, and the picker's own state stays
   * the single source of truth.
   */
  readonly crossLinkPreset?: string | null;
}

export function TopicEditor({
  model,
  actions,
  onSelectRoom,
  crossLinkPreset = null,
}: TopicEditorProps): ReactNode {
  return (
    <div className="study-tools">
      <ChildTopicTool model={model} actions={actions} />
      <CrossLinkTool model={model} actions={actions} preset={crossLinkPreset} />
      <ReparentTool model={model} actions={actions} />
      <TagTool model={model} actions={actions} />
      <DeleteTool model={model} actions={actions} onSelectRoom={onSelectRoom} />
    </div>
  );
}

/* ── Bulk child-topic creation ─────────────────────────────────────────────── */

function ChildTopicTool({
  model,
  actions,
}: {
  model: CreatorWorkspaceModel;
  actions: CreatorGraphActions;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const scope = CREATOR_COMMAND_SCOPES.childrenAdd;
  const topics = parseTopicBatch(draft);

  const apply = (): void => {
    if (topics.length === 0) return;
    void actions
      .run(scope, {
        type: 'graph/children-add',
        payload: { parentRoomId: model.current.roomId, topics },
      })
      .then((result) => {
        // Cleared only when the command applied: on a refusal the draft is the part the
        // learner would otherwise have to retype.
        if (result.status === 'applied') setDraft('');
      });
  };

  return (
    <section className="study-tool" aria-label="Add child topics">
      <StudyTextarea
        id={STUDY_CONTROL_IDS.childTopicsInput}
        label="Add child topics"
        hint="One topic per line, or separated by commas. Blank and repeated topics are dropped."
        value={draft}
        onChange={setDraft}
        rows={4}
        touchTarget="child-topics-input"
        describedBy={STUDY_CONTROL_IDS.childTopicsAddDescription}
      />
      <p className="study-tool__preview" data-study-preview="child-topics">
        {topics.length === 0
          ? 'Nothing typed yet.'
          : `${topics.length} topic${topics.length === 1 ? '' : 's'} ready: ${topics.join(', ')}`}
      </p>
      <StudyActionButton
        label="Add child topics"
        touchTarget="child-topics-add"
        tone="primary"
        pendingLabel="Adding child topics…"
        pending={actions.isPending(scope)}
        refusal={topics.length === 0 ? 'Type at least one topic to add.' : null}
        description="Creates every topic listed above as a subtopic of the current topic."
        onClick={apply}
      />
      <span id={STUDY_CONTROL_IDS.childTopicsAddDescription} className="study-visually-hidden">
        The topics listed above are added as subtopics of the current topic, in the order they
        are written. Nothing is created when the list is empty.
      </span>
    </section>
  );
}

/* ── Cross-links ───────────────────────────────────────────────────────────── */

function CrossLinkTool({
  model,
  actions,
  preset,
}: {
  model: CreatorWorkspaceModel;
  actions: CreatorGraphActions;
  preset: string | null;
}): ReactNode {
  const [targetRoomId, setTargetRoomId] = useState('');
  const [relationType, setRelationType] = useState<EdgeRelationType>('related');
  const scope = CREATOR_COMMAND_SCOPES.crossLink;
  const pending = actions.isPending(scope);

  // Presentation state only: a pick from the related-topics list arriving as a prop.
  useEffect(() => {
    if (preset !== null) setTargetRoomId(preset);
  }, [preset]);

  const apply = (): void => {
    if (targetRoomId === '') return;
    void actions
      .run(scope, {
        type: 'graph/cross-link-add',
        payload: { fromRoomId: model.current.roomId, toRoomId: targetRoomId, relationType },
      })
      .then((result) => {
        if (result.status === 'applied') setTargetRoomId('');
      });
  };

  return (
    <section className="study-tool" aria-label="Cross-link topics">
      <StudyChoice
        id={STUDY_CONTROL_IDS.crossLinkSelect}
        label="Cross-link with"
        hint="A cross-link joins two topics without making either one a subtopic of the other."
        value={targetRoomId}
        onChange={setTargetRoomId}
        options={model.linkCandidates.map((room) => ({ value: room.roomId, label: room.topic }))}
        placeholder={
          model.linkCandidates.length === 0 ? 'Nothing to link with yet' : 'Choose a topic'
        }
        disabled={pending}
        touchTarget="cross-link-select"
      />
      <StudyChoice
        label="Link meaning"
        value={relationType}
        onChange={(value) => setRelationType(value as EdgeRelationType)}
        options={CROSS_LINK_RELATIONS.map((relation) => ({
          value: relation,
          label: RELATION_LABEL[relation],
        }))}
        disabled={pending}
        touchTarget="cross-link-relation"
      />
      <StudyActionButton
        label="Create cross-link"
        touchTarget="cross-link-apply"
        pendingLabel="Linking…"
        pending={pending}
        refusal={
          model.linkCandidates.length === 0
            ? 'A cross-link needs a second topic. Add a subtopic first.'
            : targetRoomId === ''
              ? 'Choose a topic to cross-link with.'
              : null
        }
        onClick={apply}
      />
    </section>
  );
}

/* ── Reparenting ───────────────────────────────────────────────────────────── */

function ReparentTool({
  model,
  actions,
}: {
  model: CreatorWorkspaceModel;
  actions: CreatorGraphActions;
}): ReactNode {
  const [parentRoomId, setParentRoomId] = useState('');
  const scope = CREATOR_COMMAND_SCOPES.reparent;
  const pending = actions.isPending(scope);

  const apply = (): void => {
    if (parentRoomId === '') return;
    void actions
      .run(scope, {
        type: 'graph/room-reparent',
        payload: { roomId: model.current.roomId, newParentRoomId: parentRoomId },
      })
      .then((result) => {
        if (result.status === 'applied') setParentRoomId('');
      });
  };

  return (
    <section className="study-tool" aria-label="Change the parent topic">
      <StudyChoice
        id={STUDY_CONTROL_IDS.reparentSelect}
        label="Move under"
        hint="Subtopics move with their topic, so this takes every subtopic below it along."
        value={parentRoomId}
        onChange={setParentRoomId}
        options={model.reparentCandidates.map((room) => ({
          value: room.roomId,
          label: room.topic,
        }))}
        placeholder={
          model.current.isRoot
            ? 'The root topic cannot be moved'
            : model.reparentCandidates.length === 0
              ? 'No other topic can be this parent'
              : 'Choose a new parent'
        }
        disabled={pending || model.current.isRoot}
        touchTarget="reparent-select"
      />
      <StudyActionButton
        label="Move under new parent"
        touchTarget="reparent-apply"
        pendingLabel="Moving…"
        pending={pending}
        refusal={
          model.current.isRoot
            ? 'The root topic cannot be moved under another topic.'
            : model.reparentCandidates.length === 0
              ? 'Every other topic in this subject is below this one.'
              : parentRoomId === ''
                ? 'Choose a new parent topic.'
                : null
        }
        onClick={apply}
      />
    </section>
  );
}

/* ── Tags ──────────────────────────────────────────────────────────────────── */

function TagTool({
  model,
  actions,
}: {
  model: CreatorWorkspaceModel;
  actions: CreatorGraphActions;
}): ReactNode {
  const [replacement, setReplacement] = useState('');
  const scope = CREATOR_COMMAND_SCOPES.tagSet;
  const pending = actions.isPending(scope);
  const parsedReplacement = parseTopicBatch(replacement);

  const applyReplacement = (): void => {
    void actions.run(scope, {
      type: 'graph/tags-set',
      payload: { roomId: model.current.roomId, tags: parsedReplacement },
    });
  };

  return (
    <section className="study-tool" aria-label="Tags for this topic">
      <TagEditor
        roomId={model.current.roomId}
        tags={model.current.tags}
        disabled={pending}
        disabledReason="Waiting for the previous change to be applied."
        onAddTag={(tag) => {
          void actions.run(CREATOR_COMMAND_SCOPES.tagAdd, {
            type: 'graph/tag-add',
            payload: { roomId: model.current.roomId, tag },
          });
        }}
        onRemoveTag={(tag) => {
          void actions.run(CREATOR_COMMAND_SCOPES.tagRemove, {
            type: 'graph/tag-remove',
            payload: { roomId: model.current.roomId, tag },
          });
        }}
      />
      <StudyTextarea
        id={STUDY_CONTROL_IDS.tagReplaceInput}
        label="Replace all tags"
        hint="Comma or newline separated. Applying an empty list removes every tag."
        rows={2}
        value={replacement}
        onChange={setReplacement}
        touchTarget="tag-replace-input"
      />
      <StudyActionButton
        label="Replace all tags"
        touchTarget="tag-replace-apply"
        pendingLabel="Replacing tags…"
        pending={pending}
        onClick={applyReplacement}
        description={
          parsedReplacement.length === 0
            ? 'This removes every tag from the topic.'
            : `Sets ${parsedReplacement.length} tag${parsedReplacement.length === 1 ? '' : 's'}.`
        }
      />
    </section>
  );
}

/* ── Deletion ──────────────────────────────────────────────────────────────── */

function DeleteTool({
  model,
  actions,
  onSelectRoom,
}: {
  model: CreatorWorkspaceModel;
  actions: CreatorGraphActions;
  onSelectRoom: (roomId: string) => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const scope = CREATOR_COMMAND_SCOPES.remove;
  const pending = actions.isPending(scope);
  const cascade = model.deleteCascadeCount;

  const apply = (): void => {
    void actions
      .run(scope, { type: 'graph/room-remove', payload: { roomId: model.current.roomId } })
      .then((result) => {
        if (result.status !== 'applied') return;
        setConfirming(false);
        /*
         * Leave the workspace on a topic that still exists: the parent, or the root. The
         * pre-Phase-14 view cleared the focused room instead, which closed the whole
         * panel and threw away the room the learner was standing in - and the panel is
         * the only DOM route to the rest of the graph.
         */
        onSelectRoom(model.current.parentRoomId ?? model.rootRoomId);
      });
  };

  return (
    <section className="study-tool" aria-label="Delete this topic">
      {confirming ? (
        <div className="study-confirm" role="group" aria-label="Confirm deleting this topic">
          <p>
            {cascade === 0
              ? `Delete “${model.current.topic}”?`
              : `Delete “${model.current.topic}” and the ${cascade} subtopic${cascade === 1 ? '' : 's'} that would be left unattached?`}
          </p>
          <p>
            Notes, artifacts, and images stored with those topics are removed with them.
            This cannot be undone.
          </p>
          <div className="study-confirm__actions">
            <StudyActionButton
              label={`Yes, delete “${model.current.topic}”`}
              touchTarget="delete-confirm"
              tone="danger"
              pendingLabel="Deleting…"
              pending={pending}
              onClick={apply}
            />
            <StudyActionButton
              label="Keep this topic"
              touchTarget="delete-cancel"
              onClick={() => setConfirming(false)}
              description="Leaves the topic and everything below it in place."
            />
          </div>
        </div>
      ) : (
        <StudyActionButton
          label="Delete topic"
          touchTarget="delete-topic"
          tone="danger"
          pendingLabel="Deleting…"
          pending={pending}
          refusal={model.deleteRefusal}
          description={
            cascade === 0
              ? 'Asks before removing this topic.'
              : `Asks before removing this topic and ${cascade} subtopic${cascade === 1 ? '' : 's'}.`
          }
          onClick={() => setConfirming(true)}
        />
      )}
    </section>
  );
}

/* ── Related topics ────────────────────────────────────────────────────────── */

export interface RelatedTopicListProps {
  readonly model: CreatorWorkspaceModel;
  readonly actions: CreatorGraphActions;
  readonly onSelectRoom: (roomId: string) => void;
  /** Called when a cross-link to a listed room is requested, so the workspace can open the tool. */
  readonly onRequestCrossLink?: (roomId: string) => void;
}

/**
 * The rooms connected to the current topic, with the verbs that apply to each.
 *
 * A per-row route rather than a single form, because the useful verb depends on the
 * relation: a child is something to open, a cross-link partner is something to link, and
 * any of them may be a new parent. Rows that cannot act say so where they are, because a
 * disabled row is not focusable.
 */
export function RelatedTopicList({
  model,
  actions,
  onSelectRoom,
  onRequestCrossLink,
}: RelatedTopicListProps): ReactNode {
  const reparentScope = CREATOR_COMMAND_SCOPES.reparent;
  const crossLinkScope = CREATOR_COMMAND_SCOPES.crossLink;
  const busy = actions.isPending(reparentScope) || actions.isPending(crossLinkScope);

  return (
    <ul className="study-list" id="study-related-topics" aria-label="Topics related to the current topic">
      {model.related.length === 0 ? (
        <li className="study-list__empty">
          This topic is not connected to anything yet. Add a child topic or a cross-link to
          connect it.
        </li>
      ) : (
        model.related.map((related) => (
          <li
            key={related.roomId}
            className="study-list__row"
            data-study-relation={related.relation}
          >
            <span className="study-list__name">
              {related.topic}
              <span className="study-list__relation">
                {RELATION_LABEL[related.relation === 'cross-link' ? 'related' : 'subtopic']}
                {related.needsRevalidation ? ', needs revalidation' : ''}
              </span>
            </span>
            <span className="study-list__actions">
              <button
                type="button"
                className="study-inline-btn"
                {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'related-select' }}
                style={STUDY_TOUCH_TARGET_STYLE}
                onClick={() => onSelectRoom(related.roomId)}
              >
                {`Work on ${related.topic}`}
              </button>
              {related.linkRefusal === null ? (
                <button
                  type="button"
                  className="study-inline-btn"
                  {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'related-cross-link' }}
                  style={STUDY_TOUCH_TARGET_STYLE}
                  disabled={busy}
                  onClick={() => {
                    if (onRequestCrossLink === undefined) {
                      void actions.run(crossLinkScope, {
                        type: 'graph/cross-link-add',
                        payload: {
                          fromRoomId: model.current.roomId,
                          toRoomId: related.roomId,
                        },
                      });
                      return;
                    }
                    onRequestCrossLink(related.roomId);
                  }}
                >
                  {`Cross-link to ${related.topic}`}
                </button>
              ) : null}
              <button
                type="button"
                className="study-inline-btn"
                {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'related-reparent' }}
                style={STUDY_TOUCH_TARGET_STYLE}
                disabled={related.reparentRefusal !== null || busy}
                onClick={() =>
                  void actions.run(reparentScope, {
                    type: 'graph/room-reparent',
                    payload: { roomId: model.current.roomId, newParentRoomId: related.roomId },
                  })
                }
              >
                {`Move ${model.current.topic} under ${related.topic}`}
              </button>
            </span>
            {related.reparentRefusal === null ? null : (
              <span className="study-action__note study-action__note--refusal">
                {`Cannot reparent here: ${related.reparentRefusal}`}
              </span>
            )}
            {/*
             * The cross-link refusal needs a visible sentence for the same reason the
             * reparent one does. Omitting an impossible button without saying why leaves a
             * learner looking at a connected topic with no cross-link control and no
             * explanation, which reads as an oversight rather than a decision. The note is
             * plain text rather than `aria-describedby` because the button it would describe
             * is not rendered at all, and a reason attached to an absent control reaches
             * nobody.
             */}
            {related.linkRefusal === null ? null : (
              <span className="study-action__note study-action__note--refusal">
                {`Cannot cross-link here: ${related.linkRefusal}`}
              </span>
            )}
          </li>
        ))
      )}
    </ul>
  );
}
