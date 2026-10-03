import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { runtimeConfig } from '@/config/featureFlags';
import { CLOSED_WITHOUT_RATING_QUALITY } from '@/application/reviewCommands';
import type { GamePhase } from '@/store/sessionStore';
import type { RoomState } from '@/core/validation/persistence';

interface RoomNpcDialogProps {
  topic: string;
  phase: GamePhase;
  roomState: RoomState;
  isCleared: boolean;
  anchorPosition?: { x: number; y: number } | null;
}

interface GuidanceCopy {
  title: string;
  body: string;
  action: string;
}

const INFO_PANEL_HINT = 'Press I to view room details.';

/**
 * Whether this build renders the Phase 16 Archaeologist review workspace.
 *
 * Read from the build-time flag once, at module scope, for the same reason and with the same
 * shape as `CREATOR_WORKSPACE_ENABLED` in `RoomPanel.tsx` and
 * `SCRIBE_ENCOUNTER_WORKSPACE_ENABLED` wherever else it appears: the flag is inlined at build
 * time, so the bundler drops the unused lane's bytes from a given artifact, and one value
 * decides the lane for every render. A test mocks `@/config/featureFlags` to choose.
 *
 * **It is a module-scope read and not a prop.** `buildGuidance`'s callers cannot supply it
 * usefully: this dialog is rendered by the world proximity interaction in `GameScreen` and by
 * `GuideConversation`, so threading a value through to reach a build constant would widen two
 * call sites for no runtime information. `false` is the production default.
 */
const ARCHAEOLOGIST_REVIEW_WORKSPACE_ENABLED = runtimeConfig.archaeologistReviewWorkspace;

/**
 * The number the panel-close route records, and the only number written here by hand nowhere.
 *
 * `closeInfoPanel` -> `finalizePendingReview` in `src/application/studyFlow.ts` applies
 * `CLOSED_WITHOUT_RATING_QUALITY` unconditionally, with no flag check anywhere on that route -
 * so the fact is true in both lanes and the learner is told it whichever build they are running.
 * It is interpolated from the constant rather than typed as a literal in two places so that the
 * two lanes below, and `PANEL_CLOSE_SENTENCE` in
 * `src/ui/study/review/ArchaeologistWorkspace.tsx`, cannot drift from the command layer or from
 * each other. The wording follows `PANEL_CLOSE_SENTENCE` on purpose: it is the same rule and it
 * should read the same way wherever a learner meets it.
 */
const PANEL_CLOSE_COUNTS_AT = CLOSED_WITHOUT_RATING_QUALITY;

/**
 * What pressing **E** does in the Archaeologist phase. Shared by both lanes, for the same reason
 * as the number above.
 *
 * This is the sentence that corrects the old copy, which told a learner to "press E to mark this
 * room reviewed". `roomInteract` in `src/application/studyFlow.ts` opens the room panel and
 * records nothing; the record is `review/pass-complete`, and only the routes below reach it. The
 * correction is stated rather than left implicit in either lane, so a learner who remembers the
 * old sentence is contradicted by the panel they are looking at.
 */
const OPEN_FOR_REVIEW_STEP =
  'Step away and press E to open this room for review; pressing E only opens the panel and marks nothing.';

function buildGuidance(
  phase: GamePhase,
  topic: string,
  roomState: RoomState,
  isCleared: boolean,
): GuidanceCopy {
  if (phase === 'creator') {
    return {
      title: `Creator Brief: ${topic}`,
      body:
        roomState === 'Created'
          ? 'This room is still a sketch. Expand the map by linking follow-up topics and refining the room graph.'
          : 'Your map is taking shape. Keep connections meaningful so future notes and reviews stay easy to navigate.',
      action: `Press E to open topic activities for this room, or use map tools to add rooms. ${INFO_PANEL_HINT}`,
    };
  }

  if (phase === 'scribe') {
    if (isCleared) {
      return {
        title: `Scribe Brief: ${topic}`,
        body:
          'This encounter is already cleared. You can still improve your notes or attach images for richer artifacts.',
        action: `Press E away from me to reopen the encounter editor and refine the note. ${INFO_PANEL_HINT}`,
      };
    }

    return {
      title: `Scribe Brief: ${topic}`,
      body:
        'Capture this topic in your own words. Keep Summary, Key Points, and Recall Question so the validator can pass it.',
      action: `Step away from me and press E to open the encounter editor. ${INFO_PANEL_HINT}`,
    };
  }

  /*
   * Phase 16. The two branches below are not two drafts of one sentence - they are the same
   * job told in two lanes, and **neither is allowed to describe a control the learner cannot
   * see**. `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE` has `productionDefault: false`, so the build
   * that ships today renders the pre-Phase-16 `notes` tab: the note body and a "Done reviewing"
   * button that routes to `onClose`. A sentence naming the 0-5 rating, "Save and finish later",
   * or "Pick this review back up" is false in that lane, and those three live in
   * `ArchaeologistWorkspace`'s own regions, which state them where they are rendered. So the
   * rollback lane only has to *not contradict* them.
   *
   * SHARED, because the code is shared. `roomInteract` and `closeInfoPanel` in
   * `src/application/studyFlow.ts` check no flag: pressing E opens the room panel and marks
   * nothing, and closing it finalizes the pass at `CLOSED_WITHOUT_RATING_QUALITY`. So "E opens
   * this room for review", the panel-close rule, and the uncleared branch below are one set of
   * sentences rendered by both lanes.
   *
   * FLAG-ON ONLY, because `ArchaeologistWorkspace` renders them: the rating, the save/resume
   * pair, and the next-review-date and pass-progress sentences. The old text told a learner to
   * "press E to mark this room reviewed", which stopped being true when `roomInteract` began
   * opening the panel instead of marking anything, and pointed them at a Self-check tab for a
   * count the workspace now shows itself. "streak progress" went with it: nothing in the review
   * flow tracks a streak (`deriveReviewPassProgress` reports full passes and rooms toward the
   * next pass).
   *
   * Not named in either lane, because this component cannot know it: whether the dungeon's
   * review unlock has been reached. The workspace states it on arrival in its first region,
   * `canReviewRoom` refuses a locked room, and the flow toasts the refusal. Claiming the gate
   * is reached - or unreached - from a proximity bubble would be a guess.
   */
  if (!ARCHAEOLOGIST_REVIEW_WORKSPACE_ENABLED) {
    // The rollback lane. Every sentence here is also true with the flag on.
    return {
      title: `Archaeologist Brief: ${topic}`,
      body: isCleared
        ? 'Read the artifact, work through the self-check prompts out loud, then close the room panel to count this pass.'
        : 'This room is not cleared yet, so it is not ready for review passes.',
      action: isCleared
        ? `${OPEN_FOR_REVIEW_STEP} Closing the room panel counts this pass at a rating of ${PANEL_CLOSE_COUNTS_AT}. ${INFO_PANEL_HINT}`
        : `Switch to Scribe phase first, clear the encounter, then return for review. ${INFO_PANEL_HINT}`,
    };
  }

  return {
    title: `Archaeologist Brief: ${topic}`,
    body: isCleared
      ? 'Read the artifact, answer the recall prompt out loud, then rate how well you recalled it. Your rating is what decides when this room comes back.'
      : 'This room is not cleared yet, so it is not ready for review passes.',
    action: isCleared
      ? `${OPEN_FOR_REVIEW_STEP} Completing the review counts the pass at the rating you chose, and closing the room panel counts it at a rating of ${PANEL_CLOSE_COUNTS_AT} instead. Save and finish later keeps an unfinished review here to pick up. ${INFO_PANEL_HINT}`
      : `Switch to Scribe phase first, clear the encounter, then return for review. ${INFO_PANEL_HINT}`,
  };
}

export function RoomNpcDialog({
  topic,
  phase,
  roomState,
  isCleared,
  anchorPosition,
}: RoomNpcDialogProps): JSX.Element {
  const guidance = buildGuidance(phase, topic, roomState, isCleared);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [anchoredStyle, setAnchoredStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!anchorPosition) {
      setAnchoredStyle(null);
      return;
    }

    const margin = 12;
    const updatePosition = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const dialogWidth = dialog.offsetWidth || 360;
      const dialogHeight = dialog.offsetHeight || 170;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const preferRight = anchorPosition.x + dialogWidth + 24 <= viewportWidth - margin;
      const preferredLeft = preferRight
        ? anchorPosition.x + 24
        : anchorPosition.x - dialogWidth - 24;

      const preferredTopAbove = anchorPosition.y - dialogHeight - 8;
      const preferredTop =
        preferredTopAbove >= margin ? preferredTopAbove : anchorPosition.y + 8;

      const maxLeft = Math.max(margin, viewportWidth - dialogWidth - margin);
      const maxTop = Math.max(margin, viewportHeight - dialogHeight - margin);

      const left = Math.min(Math.max(preferredLeft, margin), maxLeft);
      const top = Math.min(Math.max(preferredTop, margin), maxTop);

      setAnchoredStyle({ left: `${left}px`, top: `${top}px` });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
    };
  }, [anchorPosition]);

  const dialogClassName = anchorPosition ? 'npc-dialog npc-dialog--anchored' : 'npc-dialog';
  const dialogStyle = anchorPosition ? anchoredStyle ?? undefined : undefined;

  return (
    <aside
      ref={dialogRef}
      className={dialogClassName}
      style={dialogStyle}
      role="status"
      aria-live="polite"
      aria-label="Room guide"
    >
      <p className="npc-dialog__eyebrow">Room Guide</p>
      <h3>{guidance.title}</h3>
      <p>{guidance.body}</p>
      <p className="npc-dialog__action">{guidance.action}</p>
    </aside>
  );
}
