/**
 * The guide-conversation DOM route.
 *
 * ## What was missing
 *
 * Phase 13 gave the Pixi dungeon a DOM mirror for its actions and for room navigation, and
 * left two world interactions without a DOM route: talking to the room guide, and picking
 * up an artifact. Artifact pickup is a Phase 15 deliverable and is deliberately not here.
 * Talking to the guide needed no new world capability, so it is built now.
 *
 * ## Why it does not duplicate the guide's words
 *
 * `RoomNpcDialog` already holds the per-phase guidance copy, and it is not this phase's
 * file to rewrite. So this surface is a *route*, not a second copy of the conversation: it
 * renders the same `RoomNpcDialog` component the world's proximity interaction renders,
 * plus the two things the world cannot offer a keyboard user - a button that starts the
 * conversation from anywhere, and a button that ends it.
 *
 * ## Accessibility
 *
 * - The trigger is a real `<button>`, at least 44 by 44, and it toggles: activating it
 *   twice ends the conversation.
 * - Opening moves focus to the conversation's own close control, so a keyboard or screen
 *   reader user lands on the one thing they need - the way out - and hears the guidance
 *   around it.
 * - Escape closes the conversation from anywhere inside it, and focus returns to the
 *   trigger.
 * - It is a labelled region, not a modal: the room panel is a side panel that must not
 *   trap focus, and the conversation does not need to be a dialog to be reachable.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { RoomState } from '@/core/validation/persistence';
import { RoomNpcDialog } from '@/ui/components/RoomNpcDialog';
import type { GamePhase } from '@/store/sessionStore';

import { STUDY_TOUCH_TARGET_STYLE, STUDY_TOUCH_TARGET_ATTRIBUTE } from '../StudyControls';

/** Static id for the conversation body, referenced by the trigger's `aria-controls`. */
export const GUIDE_BODY_ID = 'study-guide-body';

export interface GuideConversationProps {
  /** The room the conversation is about, or `null` when there is no room in focus. */
  readonly room: {
    readonly topic: string;
    readonly state: RoomState;
    readonly isCleared: boolean;
  } | null;
  readonly phase: GamePhase;
}

export function GuideConversation({ room, phase }: GuideConversationProps): ReactNode {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /*
   * The conversation is about a room. When the room in focus changes, a conversation left
   * open about the previous room would be showing guidance for somewhere else, so it
   * closes. This is local UI state; nothing is dispatched.
   */
  useEffect(() => {
    setOpen(false);
  }, [room?.topic, phase]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  const close = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  if (room === null) {
    return (
      <div className="study-guide" role="region" aria-label="Room guide">
        <p className="study-region__description">
          The room guide has nothing to say until you are standing in a room.
        </p>
      </div>
    );
  }

  const topic = room.topic;

  return (
    <div className="study-guide" role="region" aria-label="Room guide">
      <button
        ref={triggerRef}
        type="button"
        className="study-inline-btn"
        aria-expanded={open}
        aria-controls={open ? GUIDE_BODY_ID : undefined}
        {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'guide-toggle' }}
        style={STUDY_TOUCH_TARGET_STYLE}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setOpen(true);
        }}
      >
        {open ? 'End the conversation with the guide' : `Talk to the room guide about ${topic}`}
      </button>
      {open ? (
        <div
          className="study-guide__body"
          id={GUIDE_BODY_ID}
          role="group"
          tabIndex={-1}
          aria-label={`Guide conversation about ${topic}`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <RoomNpcDialog
            topic={topic}
            phase={phase}
            roomState={room.state}
            isCleared={room.isCleared}
            anchorPosition={null}
          />
          <button
            ref={closeRef}
            type="button"
            className="study-inline-btn"
            {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: 'guide-close' }}
            style={STUDY_TOUCH_TARGET_STYLE}
            onClick={close}
          >
            End the conversation
          </button>
          <p className="study-region__description">
            This is the same conversation the room guide gives in the dungeon. Close it with
            the button above or the Escape key.
          </p>
        </div>
      ) : null}
    </div>
  );
}
