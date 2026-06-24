/**
 * Error recovery and data integrity utilities.
 *
 * Phase 5: Quality & Scale - Comprehensive error recovery.
 * Handles corrupt subject data, persistence failures, and localStorage quota
 * exceeded scenarios with graceful degradation and user-friendly recovery
 * options.
 */

const CORRUPT_DATA_PREFIX = 'knowledge-dungeon:corrupt';
const BACKUP_PREFIX = 'knowledge-dungeon:backup';

export interface RecoveryResult {
  recovered: boolean;
  message: string;
  data?: string;
}

/**
 * Parse a JSON string safely - never throws.
 * Returns the parsed value on success, null on failure.
 */
export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Validates that a stored subject JSON has the minimum required structure.
 * Returns true if the data looks like a valid subject snapshot.
 */
export function isValidSubjectData(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (!obj.dungeon || typeof obj.dungeon !== 'object') return false;
  const dungeon = obj.dungeon as Record<string, unknown>;
  if (typeof dungeon.dungeonId !== 'string') return false;
  if (typeof dungeon.subjectName !== 'string') return false;
  if (typeof dungeon.rootRoomId !== 'string') return false;
  if (!Array.isArray(dungeon.rooms)) return false;
  if (!obj.rooms || typeof obj.rooms !== 'object') return false;
  return true;
}

/**
 * Check if a saved subject key in localStorage contains valid data.
 * Returns a RecoveryResult describing the outcome.
 */
export function checkSubjectIntegrity(subjectId: string): RecoveryResult {
  try {
    if (typeof localStorage === 'undefined') {
      return { recovered: false, message: 'localStorage is not available.' };
    }

    const key = `knowledge-dungeon:v1:subject:${subjectId}`;
    const raw = localStorage.getItem(key);

    if (!raw) {
      return { recovered: false, message: 'No saved data found for this subject.' };
    }

    const parsed = safeJsonParse(raw);
    if (parsed === null) {
      // Check for a backup
      const backupKey = `${BACKUP_PREFIX}:${subjectId}`;
      const backupRaw = localStorage.getItem(backupKey);
      if (backupRaw) {
        const backupParsed = safeJsonParse(backupRaw);
        if (backupParsed && isValidSubjectData(backupParsed)) {
          // Restore from backup
          try {
            localStorage.setItem(key, backupRaw);
            return {
              recovered: true,
              message: 'Data was recovered from a backup.',
              data: backupRaw,
            };
          } catch {
            return {
              recovered: false,
              message: 'Backup found but could not be restored due to storage limits.',
            };
          }
        }
      }

      // Try to salvage partial data
      const corruptKey = `${CORRUPT_DATA_PREFIX}:${subjectId}`;
      const savedCorrupt = localStorage.getItem(corruptKey);
      return {
        recovered: false,
        message: savedCorrupt
          ? 'Previously corrupt data found. No backup available.'
          : 'Subject data is corrupt and cannot be parsed. No backup available.',
      };
    }

    if (!isValidSubjectData(parsed)) {
      return {
        recovered: false,
        message: 'Subject data has invalid structure (missing required fields).',
      };
    }

    return { recovered: true, message: 'Data integrity check passed.', data: raw };
  } catch (err) {
    return {
      recovered: false,
      message: `Integrity check failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Create a backup of subject data before overwriting.
 * Stores a copy under a separate key for recovery purposes.
 */
export function backupSubjectData(subjectId: string, raw: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const backupKey = `${BACKUP_PREFIX}:${subjectId}`;
    // Keep one backup per subject
    localStorage.setItem(backupKey, raw);
  } catch {
    // Non-fatal: backup creation failed but current data is still intact
  }
}

/**
 * Move corrupt data to a separate key for later inspection/recovery attempts,
 * then remove the original key so the app doesn't encounter it again.
 */
export function quarantineCorruptData(subjectId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const key = `knowledge-dungeon:v1:subject:${subjectId}`;
    const raw = localStorage.getItem(key);
    if (raw) {
      const corruptKey = `${CORRUPT_DATA_PREFIX}:${subjectId}`;
      localStorage.setItem(corruptKey, raw);
    }
    localStorage.removeItem(key);
    // Also remove from index
    const indexKey = 'knowledge-dungeon:v1:subjects';
    const indexRaw = localStorage.getItem(indexKey);
    if (indexRaw) {
      try {
        const ids = JSON.parse(indexRaw) as unknown[];
        if (Array.isArray(ids)) {
          const filtered = ids.filter((id) => id !== subjectId);
          localStorage.setItem(indexKey, JSON.stringify(filtered));
        }
      } catch {
        // Index is corrupt too; skip
      }
    }
  } catch {
    // Best-effort quarantine
  }
}

/**
 * Safe persistence wrapper that catches storage quota errors.
 * Returns the result of the write operation.
 */
export function safeLocalStorageSet(key: string, value: string): {
  success: boolean;
  error?: string;
} {
  try {
    if (typeof localStorage === 'undefined') {
      return { success: false, error: 'localStorage is not available.' };
    }
    localStorage.setItem(key, value);
    return { success: true };
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.code === 22)
    ) {
      return {
        success: false,
        error:
          'Storage quota exceeded. Please export your data and free up space by removing unused subjects.',
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown storage error.',
    };
  }
}

/**
 * Estimate total localStorage space used by our app, in KB.
 */
export function getStorageUsageKB(): number {
  let total = 0;
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith('knowledge-dungeon:')) {
          const value = localStorage.getItem(key);
          if (value) {
            total += key.length + value.length;
          }
        }
      }
    }
  } catch {
    // unavailable
  }
  return Math.round(total / 1024);
}

/**
 * Check if we're approaching the localStorage limit and return a warning
 * threshold level: 'ok' (under 50%), 'warn' (50-80%), 'critical' (>80%).
 */
export function getStorageThreshold(): 'ok' | 'warn' | 'critical' {
  const usedKB = getStorageUsageKB();
  // Conservative: warn at ~2.5MB, critical at ~4MB
  if (usedKB > 4000) return 'critical';
  if (usedKB > 2500) return 'warn';
  return 'ok';
}
