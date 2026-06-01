import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
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
      action: 'Open map tools to add rooms, then switch to Scribe when ready to clear encounters.',
    };
  }

  if (phase === 'scribe') {
    if (isCleared) {
      return {
        title: `Scribe Brief: ${topic}`,
        body:
          'This encounter is already cleared. You can still improve your notes or attach images for richer artifacts.',
        action: 'Press E away from me to reopen the encounter editor and refine the note.',
      };
    }

    return {
      title: `Scribe Brief: ${topic}`,
      body:
        'Capture this topic in your own words. Keep Summary, Key Points, and Recall Question so the validator can pass it.',
      action: 'Step away from me and press E to open the encounter editor for this room.',
    };
  }

  return {
    title: `Archaeologist Brief: ${topic}`,
    body: isCleared
      ? 'Artifacts are ready for review passes. Revisit this room to strengthen recall and streak progress.'
      : 'This room is not cleared yet, so it is not ready for review passes.',
    action: isCleared
      ? 'Step away and press E to record a review pass for this room.'
      : 'Switch to Scribe phase first, clear the encounter, then return for review.',
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

      const preferredTopAbove = anchorPosition.y - dialogHeight - 18;
      const preferredTop =
        preferredTopAbove >= margin ? preferredTopAbove : anchorPosition.y + 18;

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
