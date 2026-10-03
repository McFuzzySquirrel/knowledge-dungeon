/**
 * The Scribe workspace's artifact region.
 *
 * ## Generation and pickup are two actions, and this file is where that shows
 *
 * An artifact is *generated* by `encounter/note-submit` clearing the encounter: the
 * store writes `room.artifactMarkdown` inside its own clear branch and returns it. It is
 * *picked up* by the world's existing `artifact/collect`, which builds the journal entry
 * and opens the journal.
 *
 * The pickup control is therefore rendered **only** when
 * `model.artifact.canCollect` is true - an artifact exists and has not been collected.
 * Offering it any earlier would be a button whose only possible outcome is "nothing
 * happened", and offering it after collection would offer a second copy of an entry the
 * journal already holds. What is missing is said in words instead: the state sentence
 * below the heading names all three states, so a learner who finds no button is told why.
 *
 * ## The collection state comes from the journal, not from local state
 *
 * `model.artifact.collected` is derived from the progression store's collected note ids,
 * so the region agrees with the journal the moment the pickup lands and survives a
 * reload. This component keeps no "did I collect it" flag of its own.
 *
 * Nothing here is colour-only: the state is a sentence, the artifact body is text, and
 * the pickup button's label is the verb.
 */
import type { ReactNode } from 'react';

import { Markdown } from '@/ui/utils/markdown';

import { StudyActionButton } from '../StudyControls';
import { SCRIBE_CONTROL_IDS } from '../controlIds';
import { SCRIBE_COMMAND_SCOPES, type ScribeEncounterActions } from './useScribeEncounterActions';
import type { ScribeEncounterViewModel } from './scribeViewModel';

/** The one sentence that names the collection state. */
function stateSentence(model: ScribeEncounterViewModel): string {
  switch (model.artifact.state) {
    case 'none':
      return 'No artifact yet. Defeating this encounter writes one.';
    case 'awaiting-pickup':
      return 'The artifact is written and waiting in this room. Picking it up keeps it in your journal.';
    case 'collected':
      return 'This artifact is already in your journal, so there is nothing left to pick up here.';
    default:
      return 'No artifact yet.';
  }
}

export interface ArtifactPreviewProps {
  readonly model: ScribeEncounterViewModel;
  /** The generated markdown, verbatim from the room, or `null` when none exists. */
  readonly artifactMarkdown: string | null;
  /** Device-local image resolution, so an artifact's images preview too. */
  readonly resolveLocalImage: (attachmentId: string) => string | null;
  readonly actions: ScribeEncounterActions;
}

export function ArtifactPreview({
  model,
  artifactMarkdown,
  resolveLocalImage,
  actions,
}: ArtifactPreviewProps): ReactNode {
  const { artifact, roomId } = model;
  const collecting = actions.isPending(SCRIBE_COMMAND_SCOPES.artifactCollect);

  return (
    <div className="scribe-artifact">
      <p className="scribe-hint">{stateSentence(model)}</p>

      {artifactMarkdown === null ? null : (
        <div className="markdown-body scribe-artifact__body" aria-label="Room artifact">
          <Markdown source={artifactMarkdown} resolveLocalImage={resolveLocalImage} />
        </div>
      )}

      {artifact.canCollect && roomId !== null ? (
        <StudyActionButton
          id={SCRIBE_CONTROL_IDS.artifactCollect}
          label="Pick up the artifact"
          touchTarget="artifact-collect"
          tone="primary"
          pending={collecting}
          pendingLabel="Picking it up…"
          onClick={() => {
            void actions.collectArtifact(roomId);
          }}
        />
      ) : null}
    </div>
  );
}