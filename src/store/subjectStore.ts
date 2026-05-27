/**
 * Subject store — owns the current SubjectSnapshot (DungeonMetadata + room
 * metadata indexed by roomId), exposing graph operations and note
 * submission. Persists every mutation through subjectPersistence so the
 * Electron fs bridge (when available) and localStorage stay in sync.
 */
import { create } from 'zustand';
import type {
  DungeonMetadata,
  RoomMetadata,
  SubjectSnapshot,
} from '@/core/validation/persistence';
import { makeEmptyRoomMetadata } from '@/core/validation/persistence';
import {
  addCrossLink,
  addLinkedRooms,
  createRootDungeon,
  removeRoom,
  reparentRoom,
  setRoomStatus,
  propagateRevalidationAfterGraphMutation,
} from '@/core/graph';
import { generateRoomArtifact } from '@/core/artifacts';
import { evaluateNoteValidation, type NoteValidationOutput } from '@/core/validation/notes';
import {
  loadSubjectSnapshot,
  saveSubjectSnapshot,
  setActiveSubjectId,
} from '@/services/persistence/subjectPersistence';

export interface SubjectState {
  snapshot: SubjectSnapshot | null;
  lastError: string | null;
  setSnapshot: (snapshot: SubjectSnapshot | null) => void;
  initSubject: (input: { subjectName: string; rootTopic: string }) => Promise<SubjectSnapshot>;
  loadSubject: (subjectId: string) => Promise<SubjectSnapshot | null>;
  addChildRoom: (parentRoomId: string, topic: string) => Promise<void>;
  addChildRooms: (parentRoomId: string, topics: readonly string[]) => Promise<void>;
  reparentRoom: (roomId: string, newParentRoomId: string) => Promise<void>;
  removeRoom: (roomId: string) => Promise<void>;
  addCrossLinkBetween: (fromRoomId: string, toRoomId: string) => Promise<void>;
  submitNote: (
    roomId: string,
    noteText: string,
    manualConfirmed: boolean,
  ) => Promise<NoteValidationOutput & { artifactMarkdown: string | null }>;
  recordReviewPass: (roomId: string) => Promise<void>;
  exportSnapshot: () => SubjectSnapshot | null;
  importSnapshot: (snapshot: SubjectSnapshot) => Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}-${time}-${random}`;
}

function persist(snapshot: SubjectSnapshot): Promise<void> {
  setActiveSubjectId(snapshot.dungeon.dungeonId);
  return saveSubjectSnapshot(snapshot.dungeon.dungeonId, snapshot);
}

function withRooms(
  snapshot: SubjectSnapshot,
  dungeon: DungeonMetadata,
  newRooms: RoomMetadata[] = [],
): SubjectSnapshot {
  const rooms = { ...snapshot.rooms };
  for (const room of newRooms) {
    rooms[room.roomId] = room;
  }
  // Drop room metadata for rooms no longer in the dungeon.
  for (const id of Object.keys(rooms)) {
    if (!dungeon.rooms.some((r) => r.roomId === id)) {
      delete rooms[id];
    }
  }
  return { dungeon, rooms };
}

function normalizeRoomMetadata(room: RoomMetadata): RoomMetadata {
  return {
    ...room,
    noteText: room.noteText ?? '',
    artifactMarkdown: room.artifactMarkdown ?? null,
  };
}

function normalizeSnapshot(snapshot: SubjectSnapshot): SubjectSnapshot {
  const rooms = Object.fromEntries(
    Object.entries(snapshot.rooms).map(([roomId, room]) => [roomId, normalizeRoomMetadata(room)]),
  );
  return { ...snapshot, rooms };
}

export const useSubjectStore = create<SubjectState>((set, get) => ({
  snapshot: null,
  lastError: null,
  setSnapshot: (snapshot) => set({ snapshot }),

  async initSubject({ subjectName, rootTopic }) {
    const dungeonId = generateId('subject');
    const rootRoomId = generateId('room');
    const result = createRootDungeon({
      dungeonId,
      subjectName,
      rootRoomId,
      rootTopic,
      nowIso: nowIso(),
    });
    if (!result.ok) {
      set({ lastError: result.error.message });
      throw new Error(result.error.message);
    }
    const dungeon = result.value;
    const snapshot: SubjectSnapshot = {
      dungeon,
      rooms: {
        [rootRoomId]: makeEmptyRoomMetadata({
          roomId: rootRoomId,
          topic: rootTopic,
          nowIso: nowIso(),
        }),
      },
    };
    set({ snapshot, lastError: null });
    await persist(snapshot);
    return snapshot;
  },

  async loadSubject(subjectId) {
    const loaded = await loadSubjectSnapshot(subjectId);
    if (loaded) {
      const snapshot = normalizeSnapshot(loaded);
      set({ snapshot, lastError: null });
      setActiveSubjectId(subjectId);
      await persist(snapshot);
      return snapshot;
    }
    return loaded;
  },

  async addChildRoom(parentRoomId, topic) {
    await get().addChildRooms(parentRoomId, [topic]);
  },

  async addChildRooms(parentRoomId, topics) {
    const current = get().snapshot;
    if (!current) return;
    const normalizedTopics = topics.map((topic) => topic.trim()).filter(Boolean);
    if (normalizedTopics.length === 0) return;
    const result = addLinkedRooms(current.dungeon, {
      fromRoomId: parentRoomId,
      drafts: normalizedTopics.map((topic) => ({ roomId: generateId('room'), topic })),
      nowIso: nowIso(),
    });
    if (!result.ok) {
      set({ lastError: result.error.message });
      return;
    }
    const createdTopicByRoomId = new Map(
      result.value.dungeon.rooms.map((room) => [room.roomId, room.topic] as const),
    );
    const newRooms = result.value.createdRoomIds.map((roomId) =>
      makeEmptyRoomMetadata({
        roomId,
        topic: createdTopicByRoomId.get(roomId) ?? roomId,
        nowIso: nowIso(),
      }),
    );
    // Phase-aware revalidation propagation.
    const propagated = propagateRevalidationAfterGraphMutation({
      dungeon: result.value.dungeon,
      touchedRoomIds: result.value.touchedRoomIds,
      nowIso: nowIso(),
    });
    const finalDungeon = propagated.ok ? propagated.value.dungeon : result.value.dungeon;
    const next = withRooms(current, finalDungeon, newRooms);
    set({ snapshot: next, lastError: null });
    await persist(next);
  },

  async reparentRoom(roomId, newParentRoomId) {
    const current = get().snapshot;
    if (!current) return;
    const result = reparentRoom(current.dungeon, {
      roomId,
      newParentRoomId,
      nowIso: nowIso(),
    });
    if (!result.ok) {
      set({ lastError: result.error.message });
      return;
    }
    const propagated = propagateRevalidationAfterGraphMutation({
      dungeon: result.value.dungeon,
      touchedRoomIds: result.value.touchedRoomIds,
      nowIso: nowIso(),
    });
    const finalDungeon = propagated.ok ? propagated.value.dungeon : result.value.dungeon;
    const next = withRooms(current, finalDungeon);
    set({ snapshot: next, lastError: null });
    await persist(next);
  },

  async removeRoom(roomId) {
    const current = get().snapshot;
    if (!current) return;
    const result = removeRoom(current.dungeon, { roomId, nowIso: nowIso() });
    if (!result.ok) {
      set({ lastError: result.error.message });
      return;
    }
    const propagated = propagateRevalidationAfterGraphMutation({
      dungeon: result.value.dungeon,
      touchedRoomIds: result.value.touchedRoomIds,
      nowIso: nowIso(),
    });
    const finalDungeon = propagated.ok ? propagated.value.dungeon : result.value.dungeon;
    // withRooms drops metadata for any rooms that are no longer in the
    // dungeon (including cascade-removed descendants), so we only need to
    // pass in the updated dungeon.
    const next = withRooms(current, finalDungeon);
    set({ snapshot: next, lastError: null });
    await persist(next);
  },

  async addCrossLinkBetween(fromRoomId, toRoomId) {
    const current = get().snapshot;
    if (!current) return;
    const result = addCrossLink(current.dungeon, {
      fromRoomId,
      toRoomId,
      nowIso: nowIso(),
    });
    if (!result.ok) {
      set({ lastError: result.error.message });
      return;
    }
    const propagated = propagateRevalidationAfterGraphMutation({
      dungeon: result.value.dungeon,
      touchedRoomIds: result.value.touchedRoomIds,
      nowIso: nowIso(),
    });
    const finalDungeon = propagated.ok ? propagated.value.dungeon : result.value.dungeon;
    const next = withRooms(current, finalDungeon);
    set({ snapshot: next, lastError: null });
    await persist(next);
  },

  async submitNote(roomId, noteText, manualConfirmed) {
    const current = get().snapshot;
    if (!current) {
      throw new Error('No active subject');
    }
    const room = current.rooms[roomId];
    if (!room) {
      throw new Error('Room not found');
    }
    const validation = evaluateNoteValidation({
      noteText,
      manualConfirmed,
      roomTopic: room.topic,
    });

    if (!validation.finalPass) {
      const updatedRoom: RoomMetadata = {
        ...room,
        state: 'NotesDrafted',
        updatedAt: nowIso(),
        noteText,
        artifactMarkdown: null,
        validationState: {
          wordCount: validation.wordCount,
          requiredSectionsPresent: validation.requiredSectionsPresent,
          manualConfirmed: validation.manualConfirmed,
          criterionScores: validation.criterionScores,
          failedChecks: [...validation.failedChecks],
          qualityBonus: validation.qualityBonus,
          finalPass: false,
        },
      };
      const dungeonResult = setRoomStatus(current.dungeon, roomId, 'NotesDrafted');
      if (dungeonResult.ok) {
        const next = withRooms(current, dungeonResult.value, [updatedRoom]);
        set({ snapshot: next });
        await persist(next);
      }
      return { ...validation, artifactMarkdown: null };
    }

    const generatedAt = nowIso();
    const artifact = generateRoomArtifact({
      subjectName: current.dungeon.subjectName,
      roomId,
      roomTopic: room.topic,
      noteText,
      criterionScores: validation.criterionScores,
      qualityBonus: validation.qualityBonus,
      generatedAtIso: generatedAt,
    });

    const updatedRoom: RoomMetadata = {
      ...room,
      state: 'ArtifactCollected',
      updatedAt: generatedAt,
      noteText,
      artifactMarkdown: artifact.markdown,
      validationState: {
        wordCount: validation.wordCount,
        requiredSectionsPresent: validation.requiredSectionsPresent,
        manualConfirmed: validation.manualConfirmed,
        criterionScores: validation.criterionScores,
        failedChecks: [],
        qualityBonus: validation.qualityBonus,
        finalPass: true,
      },
    };
    const dungeonResult = setRoomStatus(current.dungeon, roomId, 'ArtifactCollected');
    const updatedDungeon = dungeonResult.ok ? dungeonResult.value : current.dungeon;
    // Move the dungeon into ScribeActive once the first artifact is collected.
    const phasedDungeon: DungeonMetadata = {
      ...updatedDungeon,
      phaseState:
        updatedDungeon.phaseState === 'CreatorActive' || updatedDungeon.phaseState === 'SubjectCreated'
          ? 'ScribeActive'
          : updatedDungeon.phaseState,
      updatedAt: generatedAt,
    };
    const next = withRooms(current, phasedDungeon, [updatedRoom]);
    set({ snapshot: next });
    await persist(next);
    return { ...validation, artifactMarkdown: artifact.markdown };
  },

  async recordReviewPass(roomId) {
    const current = get().snapshot;
    if (!current) return;
    const room = current.rooms[roomId];
    if (!room || !room.validationState.finalPass) return;
    const updatedRoom: RoomMetadata = {
      ...room,
      reviewPassCount: room.reviewPassCount + 1,
      updatedAt: nowIso(),
    };
    const next = withRooms(current, current.dungeon, [updatedRoom]);
    set({ snapshot: next });
    await persist(next);
  },

  exportSnapshot() {
    return get().snapshot;
  },

  async importSnapshot(snapshot) {
    const normalized = normalizeSnapshot(snapshot);
    set({ snapshot: normalized });
    await persist(normalized);
  },
}));
