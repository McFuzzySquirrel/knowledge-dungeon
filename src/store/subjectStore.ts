/**
 * Subject store - owns the current SubjectSnapshot (DungeonMetadata + room
 * metadata indexed by roomId), exposing graph operations and note
 * submission. Persists every mutation through subjectPersistence so the
 * Electron fs bridge (when available) and localStorage stay in sync.
 */
import { create } from 'zustand';
import type {
  DungeonMetadata,
  RoomAttachment,
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
  setRoomTags,
  addRoomTag,
  removeRoomTag,
  getAllTags,
} from '@/core/graph';
import { generateRoomArtifact } from '@/core/artifacts';
import { evaluateNoteValidation, type NoteValidationOutput } from '@/core/validation/notes';
import {
  addRoomExternalAttachment,
  addRoomLocalAttachment,
  deleteRoomAttachment,
  loadSubjectSnapshot,
  resolveRoomAttachmentUrl,
  saveSubjectSnapshot,
  setActiveSubjectId,
} from '@/services/persistence/subjectPersistence';
import {
  updateSm2State,
  clampQualityRating,
  type QualityRating,
} from '@/core/review';

export interface SubjectState {
  snapshot: SubjectSnapshot | null;
  lastError: string | null;
  setSnapshot: (snapshot: SubjectSnapshot | null) => void;
  initSubject: (input: { subjectName: string; rootTopic: string; biome?: string }) => Promise<SubjectSnapshot>;
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
  recordReviewPass: (roomId: string, qualityRating?: number) => Promise<void>;
  addLocalAttachment: (roomId: string) => Promise<RoomAttachment | null>;
  addExternalAttachment: (roomId: string, url: string) => Promise<RoomAttachment | null>;
  removeAttachment: (roomId: string, attachmentId: string) => Promise<void>;
  resolveAttachmentUrl: (roomId: string, attachmentId: string) => Promise<string | null>;
  exportSnapshot: () => SubjectSnapshot | null;
  importSnapshot: (snapshot: SubjectSnapshot) => Promise<void>;
  /** Phase 4f: Tag operations */
  setRoomTags: (roomId: string, tags: string[]) => Promise<void>;
  addRoomTag: (roomId: string, tag: string) => Promise<void>;
  removeRoomTag: (roomId: string, tag: string) => Promise<void>;
  getAllTags: () => string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}-${time}-${random}`;
}

async function persist(snapshot: SubjectSnapshot): Promise<void> {
  setActiveSubjectId(snapshot.dungeon.dungeonId);
  const result = await saveSubjectSnapshot(snapshot.dungeon.dungeonId, snapshot);
  if (!result.success) {
    throw new Error(result.error ?? 'Failed to save subject data.');
  }
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
  const attachments = Array.isArray(room.attachments)
    ? room.attachments
        .filter((attachment): attachment is RoomAttachment => Boolean(attachment))
        .map((attachment) => {
          const sourceType = attachment.sourceType ?? 'local';
          const normalized: RoomAttachment = {
            attachmentId: attachment.attachmentId,
            sourceType,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            ...(attachment.relativePath ? { relativePath: attachment.relativePath } : {}),
            ...(attachment.externalUrl ? { externalUrl: attachment.externalUrl } : {}),
            ...(attachment.altText ? { altText: attachment.altText } : {}),
            addedAt: attachment.addedAt,
          };
          return normalized;
        })
    : [];

  return {
    ...room,
    noteText: room.noteText ?? '',
    artifactMarkdown: room.artifactMarkdown ?? null,
    attachments,
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

  async initSubject({ subjectName, rootTopic, biome }) {
    const dungeonId = generateId('subject');
    const rootRoomId = generateId('room');
    const result = createRootDungeon({
      dungeonId,
      subjectName,
      rootRoomId,
      rootTopic,
      nowIso: nowIso(),
      biome,
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

  async recordReviewPass(roomId, qualityRating?) {
    const current = get().snapshot;
    if (!current) return;
    const room = current.rooms[roomId];
    if (!room || !room.validationState.finalPass) return;

    // Phase 4a: compute SM-2 state from quality rating
    const quality: QualityRating = clampQualityRating(qualityRating ?? 3);
    const previousSm2 = room.sm2QualityResponse != null
      ? {
          qualityResponse: clampQualityRating(room.sm2QualityResponse) as QualityRating,
          easeFactor: room.sm2EaseFactor ?? 2.5,
          intervalDays: Math.max(1, room.sm2IntervalDays ?? 1),
          nextReviewDate: room.sm2NextReviewDate ?? nowIso(),
          consecutiveCorrect: Math.max(0, room.sm2ConsecutiveCorrect ?? 0),
        }
      : null;
    const reviewedAtIso = nowIso();
    const sm2State = updateSm2State({
      quality,
      previousState: previousSm2,
      reviewedAtIso,
    });

    const updatedRoom: RoomMetadata = {
      ...room,
      reviewPassCount: room.reviewPassCount + 1,
      updatedAt: reviewedAtIso,
      sm2QualityResponse: sm2State.qualityResponse,
      sm2EaseFactor: sm2State.easeFactor,
      sm2IntervalDays: sm2State.intervalDays,
      sm2NextReviewDate: sm2State.nextReviewDate,
      sm2ConsecutiveCorrect: sm2State.consecutiveCorrect,
    };
    const next = withRooms(current, current.dungeon, [updatedRoom]);
    set({ snapshot: next });
    await persist(next);
  },

  async addLocalAttachment(roomId) {
    const current = get().snapshot;
    if (!current) return null;
    const room = current.rooms[roomId];
    if (!room) return null;

    const attachment = await addRoomLocalAttachment(current.dungeon.dungeonId, roomId);
    if (!attachment) return null;

    const updatedRoom: RoomMetadata = {
      ...room,
      updatedAt: nowIso(),
      attachments: [...room.attachments, attachment],
    };
    const next = withRooms(current, current.dungeon, [updatedRoom]);
    set({ snapshot: next, lastError: null });
    await persist(next);
    return attachment;
  },

  async addExternalAttachment(roomId, url) {
    const current = get().snapshot;
    if (!current) return null;
    const room = current.rooms[roomId];
    if (!room) return null;

    const attachment = await addRoomExternalAttachment(current.dungeon.dungeonId, roomId, url);
    if (!attachment) return null;

    const updatedRoom: RoomMetadata = {
      ...room,
      updatedAt: nowIso(),
      attachments: [...room.attachments, attachment],
    };
    const next = withRooms(current, current.dungeon, [updatedRoom]);
    set({ snapshot: next, lastError: null });
    await persist(next);
    return attachment;
  },

  async removeAttachment(roomId, attachmentId) {
    const current = get().snapshot;
    if (!current) return;
    const room = current.rooms[roomId];
    if (!room) return;

    const target = room.attachments.find((attachment) => attachment.attachmentId === attachmentId);
    if (!target) return;

    if (target.sourceType === 'local') {
      await deleteRoomAttachment(current.dungeon.dungeonId, roomId, attachmentId);
    }

    const updatedRoom: RoomMetadata = {
      ...room,
      updatedAt: nowIso(),
      attachments: room.attachments.filter((attachment) => attachment.attachmentId !== attachmentId),
    };
    const next = withRooms(current, current.dungeon, [updatedRoom]);
    set({ snapshot: next, lastError: null });
    await persist(next);
  },

  async resolveAttachmentUrl(roomId, attachmentId) {
    const current = get().snapshot;
    if (!current) return null;
    const room = current.rooms[roomId];
    if (!room) return null;

    const attachment = room.attachments.find((item) => item.attachmentId === attachmentId);
    if (!attachment) return null;
    if (attachment.sourceType === 'external') {
      return attachment.externalUrl ?? null;
    }
    return resolveRoomAttachmentUrl(current.dungeon.dungeonId, roomId, attachmentId);
  },

  exportSnapshot() {
    return get().snapshot;
  },

  async importSnapshot(snapshot) {
    const normalized = normalizeSnapshot(snapshot);
    set({ snapshot: normalized });
    await persist(normalized);
  },

  // Phase 4f: Tag operations

  async setRoomTags(roomId, tags) {
    const current = get().snapshot;
    if (!current) return;
    try {
      const result = setRoomTags(current, roomId, tags);
      const next = withRooms(current, result.dungeon, [result.room]);
      set({ snapshot: next, lastError: null });
      await persist(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set tags.';
      set({ lastError: message });
    }
  },

  async addRoomTag(roomId, tag) {
    const current = get().snapshot;
    if (!current) return;
    try {
      const result = addRoomTag(current, roomId, tag);
      const next = withRooms(current, result.dungeon, [result.room]);
      set({ snapshot: next, lastError: null });
      await persist(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add tag.';
      set({ lastError: message });
    }
  },

  async removeRoomTag(roomId, tag) {
    const current = get().snapshot;
    if (!current) return;
    try {
      const result = removeRoomTag(current, roomId, tag);
      const next = withRooms(current, result.dungeon, [result.room]);
      set({ snapshot: next, lastError: null });
      await persist(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove tag.';
      set({ lastError: message });
    }
  },

  getAllTags() {
    const current = get().snapshot;
    if (!current) return [];
    return getAllTags(current);
  },
}));
