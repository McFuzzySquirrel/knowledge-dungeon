/**
 * Session store - tracks the active subject, the chosen phase, and the
 * currently selected room (for UI panels). This is the only store the
 * welcome screen needs to mutate.
 */
import { create } from 'zustand';
import type { PlayerClassId } from '@/game/systems/playerClasses';

export type GamePhase = 'creator' | 'scribe' | 'archaeologist';
export type AppScreen = 'welcome' | 'village' | 'game';
export type QuestStep =
  | 'intro'
  | 'meet-keeper'
  | 'create-subject'
  | 'visit-training'
  | 'pick-archetype'
  | 'enter-dungeon'
  | 'clear-room'
  | 'write-note'
  | 'review-artifact'
  | 'complete';

export const QUEST_LABELS: Record<QuestStep, { label: string; hint: string }> = {
  'intro': { label: 'Arrival', hint: 'Welcome to the Dungeon Village' },
  'meet-keeper': { label: 'Meet the Keeper', hint: 'Speak with the Keeper of Knowledge' },
  'create-subject': { label: 'Create a Subject', hint: 'Visit the Guild Hall to create your first subject' },
  'visit-training': { label: 'Training Grounds', hint: 'Complete the tutorial in the Training Grounds' },
  'pick-archetype': { label: 'Choose Archetype', hint: 'Pick a study archetype from the HUD' },
  'enter-dungeon': { label: 'Enter a Dungeon', hint: 'Walk to a dungeon portal and press E to enter' },
  'clear-room': { label: 'Clear a Room', hint: 'In Scribe phase, open a room encounter and write notes' },
  'write-note': { label: 'Write a Note', hint: 'Draft a structured note with Summary, Key Points, and a Recall Question' },
  'review-artifact': { label: 'Review & Earn XP', hint: 'Switch to Archaeologist phase and review cleared rooms' },
  'complete': { label: 'Journey Begins', hint: 'You are ready to explore knowledge dungeons!' },
};

export const TELEPORT_COOLDOWN_MS = 2 * 60 * 1000;
/** Quest steps that happen in the dungeon and require manual confirmation. */
export const MANUAL_QUESTS = new Set<QuestStep>(['clear-room', 'write-note', 'review-artifact']);

export interface SessionState {
  activeSubjectId: string | null;
  activeScreen: AppScreen;
  phase: GamePhase;
  selectedClass: PlayerClassId | null;
  focusedRoomId: string | null;
  isNoteEditorOpen: boolean;
  noteEditorRoomId: string | null;
  noteEditorPendingInsert: string | null;
  isMapViewOpen: boolean;
  teleportModeArmed: boolean;
  lastTeleportAt: number | null;
  mobileHudOpen: boolean;
  questStep: QuestStep;
  sceneRestartCounter: number;
  setActiveSubjectId: (id: string | null) => void;
  setActiveScreen: (screen: AppScreen) => void;
  setPhase: (phase: GamePhase) => void;
  setSelectedClass: (id: PlayerClassId | null) => void;
  setFocusedRoomId: (id: string | null) => void;
  openNoteEditor: (roomId: string) => void;
  openNoteEditorWithInsert: (roomId: string, insertText: string) => void;
  closeNoteEditor: () => void;
  clearNoteEditorPendingInsert: () => void;
  openMapView: () => void;
  closeMapView: () => void;
  armTeleportMode: () => void;
  cancelTeleportMode: () => void;
  markTeleported: (at: number) => void;
  setMobileHudOpen: (open: boolean) => void;
  setQuestStep: (step: QuestStep) => void;
  advanceQuestStep: () => void;
  requestSceneRestart: () => void;
}

export const QUEST_ORDER: QuestStep[] = [
  'intro',
  'meet-keeper',
  'create-subject',
  'visit-training',
  'pick-archetype',
  'enter-dungeon',
  'clear-room',
  'write-note',
  'review-artifact',
  'complete',
];

const initialQuestStep: QuestStep = (() => {
  try {
    const stored = localStorage.getItem('kd-quest-step');
    if (stored && QUEST_ORDER.includes(stored as QuestStep)) return stored as QuestStep;
  } catch { /* ignore */ }
  return 'intro';
})();

export const useSessionStore = create<SessionState>((set) => ({
  activeSubjectId: null,
  activeScreen: 'welcome',
  phase: 'creator',
  selectedClass: null,
  focusedRoomId: null,
  isNoteEditorOpen: false,
  noteEditorRoomId: null,
  noteEditorPendingInsert: null,
  isMapViewOpen: false,
  teleportModeArmed: false,
  lastTeleportAt: null,
  mobileHudOpen: false,
  questStep: initialQuestStep,
  sceneRestartCounter: 0,
  setActiveSubjectId: (activeSubjectId) => set({ activeSubjectId }),
  setActiveScreen: (activeScreen) => set({ activeScreen }),
  setPhase: (phase) => set({ phase }),
  setSelectedClass: (selectedClass) => set({ selectedClass }),
  setFocusedRoomId: (focusedRoomId) => set({ focusedRoomId }),
  openNoteEditor: (noteEditorRoomId) =>
    set({ noteEditorRoomId, isNoteEditorOpen: true, noteEditorPendingInsert: null }),
  openNoteEditorWithInsert: (noteEditorRoomId, insertText) =>
    set({ noteEditorRoomId, isNoteEditorOpen: true, noteEditorPendingInsert: insertText }),
  closeNoteEditor: () =>
    set({ isNoteEditorOpen: false, noteEditorRoomId: null, noteEditorPendingInsert: null }),
  clearNoteEditorPendingInsert: () => set({ noteEditorPendingInsert: null }),
  openMapView: () => set({ isMapViewOpen: true }),
  closeMapView: () => set({ isMapViewOpen: false, teleportModeArmed: false }),
  armTeleportMode: () => set({ teleportModeArmed: true, isMapViewOpen: true }),
  cancelTeleportMode: () => set({ teleportModeArmed: false }),
  markTeleported: (lastTeleportAt) => set({ lastTeleportAt, teleportModeArmed: false }),
  setMobileHudOpen: (mobileHudOpen) => set({ mobileHudOpen }),
  setQuestStep: (questStep) => {
    try { localStorage.setItem('kd-quest-step', questStep); } catch { /* ignore */ }
    set({ questStep });
  },
  advanceQuestStep: () => {
    const current = useSessionStore.getState().questStep;
    const idx = QUEST_ORDER.indexOf(current);
    if (idx >= 0 && idx < QUEST_ORDER.length - 1) {
      const next = QUEST_ORDER[idx + 1];
      try { localStorage.setItem('kd-quest-step', next); } catch { /* ignore */ }
      set({ questStep: next });
    }
  },
  requestSceneRestart: () =>
    set((state) => ({ sceneRestartCounter: state.sceneRestartCounter + 1 })),
}));
