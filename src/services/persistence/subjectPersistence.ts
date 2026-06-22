/**
 * Generic key/value persistence facade.
 * - In Electron, can be backed by a node fs preload bridge (see electron/preload.ts)
 * - In the web build, falls back to localStorage with import/export helpers.
 *
 * The Subject domain payloads (DungeonMetadata + RoomMetadata) are serialized
 * as JSON under deterministic keys mirroring the mindmap-dungeon filesystem
 * layout (`dungeon-data/<subject-id>/...`).
 */

import {
  CURRENT_SCHEMA_VERSION,
  type RoomAttachment,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import {
  backupSubjectData,
  safeLocalStorageSet,
  quarantineCorruptData,
} from '@/services/errorRecovery';

const STORAGE_PREFIX = 'knowledge-dungeon:v1';

export const STORAGE_KEYS = {
  activeSubjectId: `${STORAGE_PREFIX}:activeSubjectId`,
  subject(id: string): string {
    return `${STORAGE_PREFIX}:subject:${id}`;
  },
  subjectIndex: `${STORAGE_PREFIX}:subjects`,
  progression: `${STORAGE_PREFIX}:progression`,
  session: `${STORAGE_PREFIX}:session`,
} as const;

declare global {
  interface Window {
    electronKnowledgeBridge?: {
      readSubject?: (subjectId: string) => Promise<SubjectSnapshot | null>;
      writeSubject?: (subjectId: string, snapshot: SubjectSnapshot) => Promise<void>;
      listSubjects?: () => Promise<string[]>;
      deleteSubject?: (subjectId: string) => Promise<void>;
      openSubjectsFolder?: () => Promise<boolean>;
      exportSubjectsRoot?: () => Promise<string | null>;
      exportSubjectFolder?: (subjectId: string) => Promise<string | null>;
      importSubjectFolder?: () => Promise<SubjectSnapshot | null>;
      addRoomLocalAttachment?: (
        subjectId: string,
        roomId: string,
      ) => Promise<RoomAttachment | null>;
      addRoomExternalAttachment?: (
        subjectId: string,
        roomId: string,
        url: string,
      ) => Promise<RoomAttachment | null>;
      deleteRoomAttachment?: (
        subjectId: string,
        roomId: string,
        attachmentId: string,
      ) => Promise<boolean>;
      resolveRoomAttachmentUrl?: (
        subjectId: string,
        roomId: string,
        attachmentId: string,
      ) => Promise<string | null>;
      saveCustomSprite?: (spritePath: string, svgContent: string) => Promise<void>;
      resetCustomSprite?: (spritePath: string) => Promise<void>;
      getSpriteManifest?: () => Promise<unknown>;
      exportSpritePack?: (packJson: string) => Promise<string | null>;
      importSpritePack?: () => Promise<unknown | null>;
    };
  }
}

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // storage unavailable - silently ignore
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable - silently ignore
  }
}

async function invokeBridge<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

export async function loadSubjectSnapshot(subjectId: string): Promise<SubjectSnapshot | null> {
  if (typeof window !== 'undefined' && window.electronKnowledgeBridge?.readSubject) {
    try {
      return await window.electronKnowledgeBridge.readSubject(subjectId);
    } catch {
      // fall through to localStorage
    }
  }

  const raw = safeGet(STORAGE_KEYS.subject(subjectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SubjectSnapshot;
    return parsed;
  } catch {
    // Phase 5: Data is corrupt — quarantine it for recovery and return null
    quarantineCorruptData(subjectId);
    return null;
  }
}

export async function saveSubjectSnapshot(
  subjectId: string,
  snapshot: SubjectSnapshot,
): Promise<{ success: boolean; error?: string }> {
  const json = JSON.stringify(snapshot);

  // Phase 5: Create backup before overwriting
  const existingKey = STORAGE_KEYS.subject(subjectId);
  const existing = safeGet(existingKey);
  if (existing) {
    backupSubjectData(subjectId, existing);
  }

  if (typeof window !== 'undefined' && window.electronKnowledgeBridge?.writeSubject) {
    try {
      await window.electronKnowledgeBridge.writeSubject(subjectId, snapshot);
    } catch {
      // fall through to localStorage
    }
  }

  const result = safeLocalStorageSet(existingKey, json);
  if (result.success) {
    appendSubjectIndex(subjectId);
  }
  return result;
}

export async function listSubjectIds(): Promise<string[]> {
  if (typeof window !== 'undefined' && window.electronKnowledgeBridge?.listSubjects) {
    try {
      return await window.electronKnowledgeBridge.listSubjects();
    } catch {
      // fall through to localStorage
    }
  }
  const raw = safeGet(STORAGE_KEYS.subjectIndex);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((id) => typeof id === 'string')) : [];
  } catch {
    return [];
  }
}

export async function deleteSubject(subjectId: string): Promise<void> {
  if (typeof window !== 'undefined' && window.electronKnowledgeBridge?.deleteSubject) {
    try {
      await window.electronKnowledgeBridge.deleteSubject(subjectId);
    } catch {
      // fall through
    }
  }
  safeRemove(STORAGE_KEYS.subject(subjectId));
  const ids = (await listSubjectIds()).filter((id) => id !== subjectId);
  safeSet(STORAGE_KEYS.subjectIndex, JSON.stringify(ids));
}

function appendSubjectIndex(subjectId: string): void {
  const raw = safeGet(STORAGE_KEYS.subjectIndex);
  let ids: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        ids = parsed.filter((id) => typeof id === 'string');
      }
    } catch {
      ids = [];
    }
  }
  if (!ids.includes(subjectId)) {
    ids.push(subjectId);
    safeSet(STORAGE_KEYS.subjectIndex, JSON.stringify(ids));
  }
}

export function setActiveSubjectId(subjectId: string | null): void {
  if (subjectId === null) {
    safeRemove(STORAGE_KEYS.activeSubjectId);
  } else {
    safeSet(STORAGE_KEYS.activeSubjectId, subjectId);
  }
}

export function getActiveSubjectId(): string | null {
  return safeGet(STORAGE_KEYS.activeSubjectId);
}

export async function openSubjectsFolder(): Promise<boolean> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const openSubjectsFolderBridge = bridge?.openSubjectsFolder;
  if (openSubjectsFolderBridge) {
    return invokeBridge(() => openSubjectsFolderBridge(), false);
  }
  return false;
}

export async function exportSubjectsRoot(): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const exportSubjectsRootBridge = bridge?.exportSubjectsRoot;
  if (exportSubjectsRootBridge) {
    return invokeBridge(() => exportSubjectsRootBridge(), null);
  }
  return null;
}

export async function exportSubjectFolder(subjectId: string): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const exportSubjectFolderBridge = bridge?.exportSubjectFolder;
  if (exportSubjectFolderBridge) {
    return invokeBridge(() => exportSubjectFolderBridge(subjectId), null);
  }
  return null;
}

export async function importSubjectFolder(): Promise<SubjectSnapshot | null> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const importSubjectFolderBridge = bridge?.importSubjectFolder;
  if (importSubjectFolderBridge) {
    return invokeBridge(() => importSubjectFolderBridge(), null);
  }
  return null;
}

export async function addRoomLocalAttachment(
  subjectId: string,
  roomId: string,
): Promise<RoomAttachment | null> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const handler = bridge?.addRoomLocalAttachment;
  if (!handler) return null;
  return invokeBridge(() => handler(subjectId, roomId), null);
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

export async function addRoomExternalAttachment(
  subjectId: string,
  roomId: string,
  url: string,
): Promise<RoomAttachment | null> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const handler = bridge?.addRoomExternalAttachment;
  if (handler) {
    return invokeBridge(() => handler(subjectId, roomId, url), null);
  }
  // Web build fallback: create the attachment locally without server-side mime validation.
  const normalized = url.trim();
  try {
    let pathname: string;
    if (normalized.startsWith('/')) {
      pathname = normalized;
    } else {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      pathname = parsed.pathname;
    }
    const fileName = pathname.split('/').pop() ?? 'image';
    const altText = fileName.replace(/[_-]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim();
    const ext = fileName.includes('.') ? `.${fileName.split('.').pop()!.toLowerCase()}` : '';
    const mimeType = MIME_BY_EXT[ext] ?? 'image/jpeg';
    const attachmentId = `att-${typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
    return {
      attachmentId,
      sourceType: 'external',
      fileName,
      mimeType,
      externalUrl: normalized,
      ...(altText.length > 0 ? { altText } : {}),
      addedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function deleteRoomAttachment(
  subjectId: string,
  roomId: string,
  attachmentId: string,
): Promise<boolean> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const handler = bridge?.deleteRoomAttachment;
  if (!handler) return false;
  return invokeBridge(() => handler(subjectId, roomId, attachmentId), false);
}

export async function resolveRoomAttachmentUrl(
  subjectId: string,
  roomId: string,
  attachmentId: string,
): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.electronKnowledgeBridge : undefined;
  const handler = bridge?.resolveRoomAttachmentUrl;
  if (!handler) return null;
  return invokeBridge(() => handler(subjectId, roomId, attachmentId), null);
}

/**
 * Phase 4a: Migrate a v1.0.0 snapshot to v1.1.0.
 * Adds SM-2 defaults and tag index, bumps schema version.
 */
function migrateToV11(snapshot: SubjectSnapshot): SubjectSnapshot {
  const migratedRooms: Record<string, typeof snapshot.rooms[string]> = {};
  for (const [roomId, room] of Object.entries(snapshot.rooms)) {
    migratedRooms[roomId] = {
      ...room,
      sm2QualityResponse: room.sm2QualityResponse ?? 3,
      sm2EaseFactor: room.sm2EaseFactor ?? 2.5,
      sm2IntervalDays: room.sm2IntervalDays ?? 1,
      sm2NextReviewDate: room.sm2NextReviewDate ?? new Date().toISOString(),
      sm2ConsecutiveCorrect: room.sm2ConsecutiveCorrect ?? 0,
      tags: room.tags ?? [],
    };
  }
  return {
    dungeon: {
      ...snapshot.dungeon,
      schemaVersion: '1.1.0',
      biome: snapshot.dungeon.biome,
      tagIndex: snapshot.dungeon.tagIndex ?? {},
    },
    rooms: migratedRooms,
  };
}

export function exportSubjectToJson(snapshot: SubjectSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Phase 4d: Export a subject as a template by stripping notes/artifacts while
 * preserving the graph structure (rooms, edges, topics, tags).
 * Templates are shareable skeletons that another user can use to start a new subject.
 */
export function exportSubjectAsTemplate(snapshot: SubjectSnapshot): string {
  const templateRooms: Record<string, unknown> = {};
  for (const [roomId, room] of Object.entries(snapshot.rooms)) {
    templateRooms[roomId] = {
      roomId: room.roomId,
      topic: room.topic,
      tags: room.tags ?? [],
      attachments: room.attachments.map((a) => ({
        sourceType: a.sourceType,
        fileName: a.fileName,
        mimeType: a.mimeType,
        altText: a.altText,
      })),
    };
  }

  const template = {
    format: 'knowledge-dungeon-template',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    subjectName: snapshot.dungeon.subjectName,
    biome: snapshot.dungeon.biome,
    rootRoomId: snapshot.dungeon.rootRoomId,
    rooms: snapshot.dungeon.rooms.map((room) => ({
      roomId: room.roomId,
      topic: room.topic,
    })),
    edges: snapshot.dungeon.edges,
    tagIndex: snapshot.dungeon.tagIndex ?? {},
    roomTemplates: templateRooms,
  };

  return JSON.stringify(template, null, 2);
}

/**
 * Phase 4d: Create a new subject snapshot from a template JSON string.
 * Generates new IDs and empty room states while preserving the graph structure.
 */
export function createSubjectFromTemplate(
  raw: string,
  subjectName?: string,
): SubjectSnapshot {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.format !== 'string' || parsed.format !== 'knowledge-dungeon-template') {
    throw new Error('Invalid template format: expected "knowledge-dungeon-template".');
  }

  const templateSubjectName = typeof parsed.subjectName === 'string' ? parsed.subjectName : 'Templated Subject';
  const rootRoomId = typeof parsed.rootRoomId === 'string' ? parsed.rootRoomId : '';
  const biome = typeof parsed.biome === 'string' ? parsed.biome : undefined;
  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
  const tagIndex = parsed.tagIndex && typeof parsed.tagIndex === 'object' ? parsed.tagIndex as Record<string, string[]> : {};
  const roomTemplates = parsed.roomTemplates && typeof parsed.roomTemplates === 'object' ? parsed.roomTemplates as Record<string, Record<string, unknown>> : {};

  // Generate new IDs
  const nowIso = new Date().toISOString();
  const idMap = new Map<string, string>();
  const generateId = (prefix: string): string =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const dungeonId = generateId('subject');
  const newRootRoomId = generateId('room');

  // Map old room IDs to new room IDs
  for (const room of rooms) {
    if (room && typeof room === 'object' && typeof (room as Record<string, unknown>).roomId === 'string') {
      const oldId = (room as Record<string, unknown>).roomId as string;
      idMap.set(oldId, oldId === rootRoomId ? newRootRoomId : generateId('room'));
    }
  }

  // Build new room metadata
  const newRooms: Record<string, unknown> = {};
  const dungeonRooms: Array<{ roomId: string; topic: string; status: string }> = [];

  for (const room of rooms) {
    if (room && typeof room === 'object') {
      const oldId = (room as Record<string, unknown>).roomId as string;
      const newId = idMap.get(oldId) ?? generateId('room');
      const topic = typeof (room as Record<string, unknown>).topic === 'string'
        ? (room as Record<string, unknown>).topic as string
        : 'Untitled';

      const templateMeta = roomTemplates[oldId] ?? {};

      newRooms[newId] = {
        roomId: newId,
        topic,
        createdAt: nowIso,
        updatedAt: nowIso,
        state: 'Created',
        notePath: `rooms/${newId}/notes.txt`,
        artifactPath: `rooms/${newId}/artifact.md`,
        noteText: '',
        artifactMarkdown: null,
        validationState: {
          wordCount: 0,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {
            sectionCompleteness: 0,
            conceptTermCoverage: 0,
            linkReferences: 0,
            recallQuestionQuality: 0,
            clarityReadability: 0,
          },
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: [],
        tags: Array.isArray(templateMeta.tags) ? templateMeta.tags : [],
        sm2QualityResponse: 3,
        sm2EaseFactor: 2.5,
        sm2IntervalDays: 1,
        sm2NextReviewDate: nowIso,
        sm2ConsecutiveCorrect: 0,
      };

      dungeonRooms.push({ roomId: newId, topic, status: 'Created' });
    }
  }

  // Remap edges
  const newEdges = (edges as Array<Record<string, unknown>>).map((edge) => ({
    fromRoomId: idMap.get(edge.fromRoomId as string) ?? edge.fromRoomId,
    toRoomId: idMap.get(edge.toRoomId as string) ?? edge.toRoomId,
    relationType: edge.relationType ?? 'subtopic',
    createdAt: nowIso,
    createdByPhase: edge.createdByPhase ?? 'Creator',
  }));

  // Remap tag index
  const newTagIndex: Record<string, string[]> = {};
  for (const [tag, roomIds] of Object.entries(tagIndex)) {
    newTagIndex[tag] = (roomIds as string[]).map((oldId) => idMap.get(oldId) ?? oldId);
  }

  const dungeon: Record<string, unknown> = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dungeonId,
    subjectName: subjectName ?? templateSubjectName,
    createdAt: nowIso,
    updatedAt: nowIso,
    phaseState: 'CreatorActive',
    rootRoomId: newRootRoomId,
    rooms: dungeonRooms,
    edges: newEdges,
    progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    biome,
    tagIndex: newTagIndex,
  };

  return { dungeon, rooms: newRooms } as unknown as SubjectSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function importSubjectFromJson(raw: string): SubjectSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !('dungeon' in parsed) || !('rooms' in parsed)) {
    throw new Error('Invalid subject snapshot format');
  }
  const dungeon = parsed.dungeon;
  const rooms = parsed.rooms;
  if (!isRecord(dungeon) || !isRecord(rooms)) {
    throw new Error('Invalid subject snapshot format');
  }
  if (typeof dungeon.schemaVersion !== 'string') {
    throw new Error('Invalid subject snapshot format: missing schema version.');
  }

  const supportedVersions = ['1.0.0', '1.1.0'];
  if (!supportedVersions.includes(dungeon.schemaVersion)) {
    throw new Error(
      `Unsupported subject schema version: ${dungeon.schemaVersion}. Expected ${CURRENT_SCHEMA_VERSION} or earlier.`,
    );
  }
  if (
    typeof dungeon.dungeonId !== 'string' ||
    typeof dungeon.subjectName !== 'string' ||
    !Array.isArray(dungeon.rooms)
  ) {
    throw new Error('Invalid subject snapshot format');
  }

  for (const roomSummary of dungeon.rooms) {
    if (!isRecord(roomSummary) || typeof roomSummary.roomId !== 'string') {
      throw new Error('Invalid subject snapshot format: room summary is malformed.');
    }
    const room = rooms[roomSummary.roomId];
    if (!isRecord(room) || room.roomId !== roomSummary.roomId || !isRecord(room.validationState)) {
      throw new Error(`Invalid subject snapshot format: missing room payload for "${roomSummary.roomId}".`);
    }
  }

  // Phase 4a: migrate from 1.0.0 to 1.1.0 — ensure SM-2 defaults exist on rooms
  const migrated = dungeon.schemaVersion === '1.0.0' ? migrateToV11(parsed as unknown as SubjectSnapshot) : parsed;

  return migrated as unknown as SubjectSnapshot;
}
