/**
 * Session store — tracks the active subject, the chosen phase, and the
 * currently selected room (for UI panels). This is the only store the
 * welcome screen needs to mutate.
 */
import { create } from 'zustand';
import type { PlayerClassId } from '@/game/systems/playerClasses';

export type GamePhase = 'creator' | 'scribe' | 'archaeologist';

export interface SessionState {
  activeSubjectId: string | null;
  phase: GamePhase;
  selectedClass: PlayerClassId | null;
  focusedRoomId: string | null;
  isNoteEditorOpen: boolean;
  noteEditorRoomId: string | null;
  isMapViewOpen: boolean;
  setActiveSubjectId: (id: string | null) => void;
  setPhase: (phase: GamePhase) => void;
  setSelectedClass: (id: PlayerClassId | null) => void;
  setFocusedRoomId: (id: string | null) => void;
  openNoteEditor: (roomId: string) => void;
  closeNoteEditor: () => void;
  openMapView: () => void;
  closeMapView: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  activeSubjectId: null,
  phase: 'creator',
  selectedClass: null,
  focusedRoomId: null,
  isNoteEditorOpen: false,
  noteEditorRoomId: null,
  isMapViewOpen: false,
  setActiveSubjectId: (activeSubjectId) => set({ activeSubjectId }),
  setPhase: (phase) => set({ phase }),
  setSelectedClass: (selectedClass) => set({ selectedClass }),
  setFocusedRoomId: (focusedRoomId) => set({ focusedRoomId }),
  openNoteEditor: (noteEditorRoomId) =>
    set({ noteEditorRoomId, isNoteEditorOpen: true }),
  closeNoteEditor: () => set({ isNoteEditorOpen: false, noteEditorRoomId: null }),
  openMapView: () => set({ isMapViewOpen: true }),
  closeMapView: () => set({ isMapViewOpen: false }),
}));
