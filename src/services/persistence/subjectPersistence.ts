/**
 * Generic key/value persistence facade.
 * - In Electron, can be backed by a node fs preload bridge (see electron/preload.ts)
 * - In the web build, falls back to localStorage with import/export helpers.
 *
 * The Subject domain payloads (DungeonMetadata + RoomMetadata) are serialized
 * as JSON under deterministic keys mirroring the mindmap-dungeon filesystem
 * layout (`dungeon-data/<subject-id>/...`).
 */

import type { SubjectSnapshot } from '@/core/validation/persistence';

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
    // storage unavailable — silently ignore
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable — silently ignore
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
    return JSON.parse(raw) as SubjectSnapshot;
  } catch {
    return null;
  }
}

export async function saveSubjectSnapshot(
  subjectId: string,
  snapshot: SubjectSnapshot,
): Promise<void> {
  if (typeof window !== 'undefined' && window.electronKnowledgeBridge?.writeSubject) {
    try {
      await window.electronKnowledgeBridge.writeSubject(subjectId, snapshot);
      // also mirror to localStorage as a cache
    } catch {
      // fall through to localStorage
    }
  }
  safeSet(STORAGE_KEYS.subject(subjectId), JSON.stringify(snapshot));
  appendSubjectIndex(subjectId);
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

export function exportSubjectToJson(snapshot: SubjectSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function importSubjectFromJson(raw: string): SubjectSnapshot {
  const parsed = JSON.parse(raw) as SubjectSnapshot;
  if (!parsed || typeof parsed !== 'object' || !('dungeon' in parsed) || !('rooms' in parsed)) {
    throw new Error('Invalid subject snapshot format');
  }
  return parsed;
}
