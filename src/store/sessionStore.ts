/**
 * Session store — tracks the active subject, the chosen phase, and the
 * currently selected room (for UI panels). This is the only store the
 * welcome screen needs to mutate.
 */
import { create } from 'zustand';
import type { PlayerClassId } from '@/game/systems/playerClasses';

export type GamePhase = 'creator' | 'scribe' | 'archaeologist';
export const TELEPORT_COOLDOWN_MS = 2 * 60 * 1000;

export interface SessionState {
  activeSubjectId: string | null;
  phase: GamePhase;
  selectedClass: PlayerClassId | null;
  focusedRoomId: string | null;
  isNoteEditorOpen: boolean;
  noteEditorRoomId: string | null;
  noteEditorPendingInsert: string | null;
  isMapViewOpen: boolean;
  teleportModeArmed: boolean;
  lastTeleportAt: number | null;
  setActiveSubjectId: (id: string | null) => void;
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
}

export const useSessionStore = create<SessionState>((set) => ({
  activeSubjectId: null,
  phase: 'creator',
  selectedClass: null,
  focusedRoomId: null,
  isNoteEditorOpen: false,
  noteEditorRoomId: null,
  noteEditorPendingInsert: null,
  isMapViewOpen: false,
  teleportModeArmed: false,
  lastTeleportAt: null,
  setActiveSubjectId: (activeSubjectId) => set({ activeSubjectId }),
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
}));
