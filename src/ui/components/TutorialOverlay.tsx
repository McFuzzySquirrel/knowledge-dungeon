import { type JSX } from 'react';
import { TUTORIAL_SUBJECT_ID } from '@/data/tutorialSubject';
import type { RoomState } from '@/core/validation/persistence';

interface TutorialOverlayProps {
  subjectId: string;
  focusedRoomId: string | null;
  rooms: Record<string, { topic: string; state: RoomState; validationState: { finalPass: boolean } }>;
}

interface TutorialStep {
  step: number;
  title: string;
  objective: string;
  tip: string;
  action: string;
}

const TUTORIAL_ROOMS: Record<string, TutorialStep> = {
  'tut-note': {
    step: 1,
    title: 'The Note',
    objective: 'Write your first note to clear this room.',
    tip: 'Include Summary, Key Points, and Recall Question sections. Each section needs a heading and at least a few sentences of your own words.',
    action: 'Walk up to the NPC and press E (or tap the ⚔ button) to open the note editor.',
  },
  'tut-tools': {
    step: 2,
    title: 'Tools of the Trade',
    objective: 'Add an image attachment to your note.',
    tip: 'Click Images in the editor toolbar, then attach a local file or paste a URL. Use the "Insert in note" button to add it to your text.',
    action: 'Open the note editor, go to the Images panel, and attach an image.',
  },
  'tut-map': {
    step: 3,
    title: 'The Map & Beyond',
    objective: 'Explore navigation tools and clear this room.',
    tip: 'Press M to open the full map. You can drag rooms to rearrange them, or click a room to teleport. Watch for ↑↓ stairs to other floors.',
    action: 'Press M to open the map, then press E in this room to write a note and clear it.',
  },
};

function allRoomsCleared(
  rooms: Record<string, { validationState: { finalPass: boolean } }>,
): boolean {
  return Object.values(rooms).every((r) => r.validationState.finalPass);
}

export function TutorialOverlay({ subjectId, focusedRoomId, rooms }: TutorialOverlayProps): JSX.Element | null {
  if (subjectId !== TUTORIAL_SUBJECT_ID) return null;

  const completed = allRoomsCleared(rooms);

  if (completed) {
    return (
      <div
        className="tutorial-overlay"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 95,
          background: 'rgba(17, 26, 48, 0.92)',
          border: '1px solid rgba(99, 179, 237, 0.3)',
          borderRadius: 10,
          padding: '14px 18px',
          maxWidth: 280,
          backdropFilter: 'blur(6px)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ fontSize: 13, color: '#4ade80', fontWeight: 700, marginBottom: 6 }}>
          🎉 Tutorial Complete!
        </div>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>
          You now know the basics: writing notes, adding attachments, and navigating the dungeon.
          Try creating your own subject or exploring the pre-built README dungeon.
        </p>
      </div>
    );
  }

  const currentRoom = focusedRoomId ? TUTORIAL_ROOMS[focusedRoomId] : null;
  const roomData = focusedRoomId ? rooms[focusedRoomId] : null;
  const isCleared = roomData?.validationState.finalPass ?? false;

  // Show first uncleared room's guidance if no room focused or focused room is cleared
  const step = currentRoom && !isCleared
    ? currentRoom
    : Object.values(TUTORIAL_ROOMS).find((s) => {
        const roomEntry = Object.entries(rooms).find(([, r]) => r.topic === s.title);
        return roomEntry && !roomEntry[1].validationState.finalPass;
      }) ?? Object.values(TUTORIAL_ROOMS)[0];

  return (
    <div
      className="tutorial-overlay"
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 95,
        background: 'rgba(17, 26, 48, 0.92)',
        border: '1px solid rgba(99, 179, 237, 0.3)',
        borderRadius: 10,
        padding: '14px 18px',
        maxWidth: 280,
        backdropFilter: 'blur(6px)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          background: 'rgba(99, 179, 237, 0.2)',
          borderRadius: 12,
          padding: '2px 10px',
          fontSize: 11,
          fontWeight: 600,
          color: '#7fb2ff',
        }}>
          Tutorial {step.step}/3
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{step.title}</span>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8, marginBottom: 2 }}>Objective</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}>{step.objective}</p>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8, marginBottom: 2 }}>Tip</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4, opacity: 0.85 }}>{step.tip}</p>
      </div>

      <div style={{
        background: 'rgba(99, 179, 237, 0.08)',
        borderRadius: 6,
        padding: '8px 10px',
        border: '1px solid rgba(99, 179, 237, 0.15)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 2 }}>Next action</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}>{step.action}</p>
      </div>

      {isCleared && currentRoom ? (
        <div style={{ marginTop: 8, fontSize: 12, color: '#4ade80' }}>
          ✓ Room cleared! Move to the next room.
        </div>
      ) : null}
    </div>
  );
}
