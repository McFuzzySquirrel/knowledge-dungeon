/**
 * The village's data-management dialog: a local export and a local import.
 *
 * ## What this is
 *
 * The pre-Phase-12 modal lifted verbatim, plus the three dialog rules from plan
 * section 10.1 via the shared `useModalFocus`: initial focus on the container,
 * Tab containment, and restoration to whatever had focus when it opened. Escape
 * closes it. The backdrop no longer closes it - the dialog says what it does in
 * its own controls, and a surface that reacts to a click on the dimmed area
 * around it is a surface that reacts to a mis-aimed touch.
 *
 * ## The data product is unchanged
 *
 * Both routes are local and both say so in the dialog body, which is the point of
 * this being a separate module from the Data Center: the village's version is a
 * *convenience* - "back up this one subject, or replace the device's set" - and the
 * Data Center's is the full product with its validation, conflict, and recovery
 * states. This dialog does not grow a second set of those states; it grows the
 * accessibility ones.
 *
 * The import route is deliberately still a `window.location.reload()` on success
 * and an `alert()` on failure, because that is the pre-Phase-12 behaviour a phase
 * of this scope should not silently change, and the Data Center owns the proper
 * import product. The honest note is in this file's header below the gate.
 */
import { useId, type ChangeEvent, type ReactNode } from 'react';

import {
  exportSubjectToJson,
  importSubjectFromJson,
  loadSubjectSnapshot,
  saveSubjectSnapshot,
} from '@/services/persistence/subjectPersistence';

import { useModalFocus } from '@/ui/hooks/useModalFocus';

import type { VillageSubjectSummary } from './villageTypes';

export interface DataManagementDialogProps {
  readonly open: boolean;
  /** The subjects the village knows about. */
  readonly subjects: readonly VillageSubjectSummary[];
  /** Closes the dialog. */
  readonly onClose: () => void;
}

/** A filename-safe stem for an export, from the subject's display name. */
function exportFileName(subjectName: string): string {
  return `${subjectName.replace(/[^a-z0-9]+/gi, '-')}.json`;
}

export function DataManagementDialog({
  open,
  subjects,
  onClose,
}: DataManagementDialogProps): ReactNode {
  const titleId = useId();
  const bodyId = useId();
  const inputId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>({ active: open, onEscape: open ? onClose : null });

  if (!open) return null;

  const handleExport = (subjectId: string, subjectName: string): void => {
    void (async () => {
      const snapshot = await loadSubjectSnapshot(subjectId);
      if (snapshot === null) return;
      const json = exportSubjectToJson(snapshot);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exportFileName(subjectName);
      anchor.click();
      URL.revokeObjectURL(url);
    })();
  };

  const handleImport = (event: ChangeEvent<HTMLInputElement>): void => {
    void (async () => {
      const file = event.target.files?.[0];
      if (file === undefined) return;
      try {
        const text = await file.text();
        const snapshot = importSubjectFromJson(text);
        await saveSubjectSnapshot(snapshot.dungeon.dungeonId, snapshot);
        window.location.reload();
      } catch (error) {
        // Pre-Phase-12 behaviour, deliberately unchanged: a failed import here is
        // rare enough that the Data Center's full conflict surface would be more
        // machinery than this shortcut needs, and the message names the cause.
        alert('Import failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    })();
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        ref={dialogRef}
        style={{
          width: 'min(480px, 92vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h2 id={titleId}>Data Management</h2>
        <p id={bodyId} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Your data is stored locally on this device. Use the tools below to back up your
          subjects or transfer them between devices. Nothing is uploaded anywhere.
        </p>
        <ul className="village-subject-list" style={{ gap: 6, listStyle: 'none', margin: 0, padding: 0 }}>
          {subjects.map((subject) => (
            <li key={subject.id} className="village-subject-item">
              <span>{subject.subjectName}</span>
              <button
                type="button"
                className="village-action-btn"
                style={{ fontSize: 10, padding: '2px 8px', minWidth: '44px', minHeight: '44px' }}
                data-village-touch-target="export-subject"
                onClick={() => handleExport(subject.id, subject.subjectName)}
              >
                Export
              </button>
            </li>
          ))}
        </ul>
        <label htmlFor={inputId} style={{ fontSize: 12 }}>
          Import a subject file
        </label>
        <input
          id={inputId}
          type="file"
          accept=".json"
          style={{ fontSize: 12 }}
          onChange={handleImport}
        />
        <div className="modal-actions">
          <button
            type="button"
            onClick={onClose}
            data-village-touch-target="dialog-close"
            style={{ minWidth: '44px', minHeight: '44px' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
