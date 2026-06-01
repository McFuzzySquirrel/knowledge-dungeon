import type { JSX } from 'react';
import type { GamePhase } from '@/store/sessionStore';
import type { RoomState } from '@/core/validation/persistence';

interface RoomNpcDialogProps {
  topic: string;
  phase: GamePhase;
  roomState: RoomState;
  isCleared: boolean;
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

export function RoomNpcDialog({ topic, phase, roomState, isCleared }: RoomNpcDialogProps): JSX.Element {
  const guidance = buildGuidance(phase, topic, roomState, isCleared);

  return (
    <aside className="npc-dialog" role="status" aria-live="polite" aria-label="Room guide">
      <p className="npc-dialog__eyebrow">Room Guide</p>
      <h3>{guidance.title}</h3>
      <p>{guidance.body}</p>
      <p className="npc-dialog__action">{guidance.action}</p>
    </aside>
  );
}
