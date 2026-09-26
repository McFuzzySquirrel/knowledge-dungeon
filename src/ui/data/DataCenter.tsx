/**
 * Phase 5: the Data Center.
 *
 * One screen, one data product, and three rules that shape it.
 *
 * ## Rule 1: it renders nothing at all unless the flag says so
 *
 * `VITE_DATA_PRODUCTS_V2` is the plan's Phase 5 owner flag and it defaults to
 * `false`. The Welcome screen mounts this component only when the flag is on, and
 * this component reads the flag itself as well, so a build that is served this
 * file by mistake still renders nothing: no heading, no tab, no control, no live
 * region. The default build's data tab is therefore exactly what it was before
 * this file existed, and the plan's Phase 5 rollback is a build-time flag rather
 * than a source change.
 *
 * ## Rule 2: the product is reached only through a lazy `import()`
 *
 * Every call into `src/services/persistence/products/` is a dynamic import of a
 * string literal, and every *type* from it is reached through a type-position
 * `import()` expression that TypeScript erases. Nothing here is a static import -
 * not even `import type` - because a static edge would put the product and the
 * ZIP codec it pulls in into the entry chunk a build with the flag off loads.
 * That is plan section 11's "new data products are opt-in", and it is the reason
 * the first thing a learner does in a flagged build costs one extra request.
 *
 * ## Rule 3: a backup is a local download and a local file pick, and nothing else
 *
 * The export path is `product` → `Blob` → object URL → anchor → **revoke**. There
 * is no upload, no share, no `fetch`, no navigation, and no form anywhere in this
 * file or in either surface it renders, and `tests/data/localDownloadOnly.test.ts`
 * walks the real application graph to keep it that way. The file name comes from
 * the product (`result.fileName`), which is a constant, so nothing a learner
 * authored can reach a file name.
 *
 * ## The order the learner meets
 *
 * 1. **Privacy**, first and unconditionally: what a backup is, and the three
 *    things it cannot promise.
 * 2. **Take a backup**: one control, one status line.
 * 3. **Restore a backup**: choose a file, read what is in it, and only then the
 *    explicit confirmation - which exists from the moment a file is chosen and
 *    is the only route to a restore.
 * 4. **What happened**: the outcome, reported field by field from the product's
 *    own result. See `RecoveryStatus` for what it deliberately refuses to claim.
 *
 * The confirmation is a real dialog (plan section 10.1: focus trapped, initial
 * focus, Escape, restoration) and it is opened by the act of choosing a file, so
 * the import is unreachable by any other route. `tests/unit/dataCenter.test.tsx`
 * drives all four steps.
 *
 * Privacy: every string in this file is generic. Nothing here renders a subject
 * name, a room topic, a note, an image file name, an image link, or a path, and
 * the only identifiers that reach the DOM are the opaque ones the product itself
 * reports, inside a collapsed "Technical details" block.
 */

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type JSX } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { useModalFocus } from '@/ui/hooks/useModalFocus';
import { runtimeConfig } from '@/config/featureFlags';
import { ImportPreview, type BackupPreview } from './ImportPreview';
import {
  RecoveryStatus,
  type RestoreFailureReport,
  type RestoreOutcome,
  type RestoreSuccessReport,
} from './RecoveryStatus';
import './dataCenter.css';

// ── The product's own types, reached without a static edge ─────────────────
//
// `import('...')` in a type position is erased by TypeScript and produces no
// runtime import at all, so these aliases are free at build time and exact at
// compile time: if the product renames a field or changes a type, this file stops
// compiling rather than rendering a field that is no longer there.

type FullDeviceProduct = typeof import('@/services/persistence/products/fullDeviceBackup');
type FullDeviceExportResult = Awaited<ReturnType<FullDeviceProduct['exportFullDeviceBackup']>>;
type FullDeviceImportResult = Awaited<ReturnType<FullDeviceProduct['importFullDeviceBackup']>>;
/** The live repository handle, named by the product's own request type. */
type DeviceRepository = import('@/services/persistence/products/fullDeviceBackup').FullDeviceExportRequest['repository'];

// ── The download ───────────────────────────────────────────────────────────

/**
 * Hand a `.kdbak` to the learner as a file on this device.
 *
 * Four steps and no fifth: a `Blob` that owns its bytes, an object URL, an anchor
 * that carries the product's file name, and a revoke. The revoke is deferred by
 * one task rather than run inline, because some browsers have not finished
 * taking a copy of the blob when the click handler returns, and revoking inside
 * the handler cancels the download there.
 */
function downloadBackupFile(bytes: Uint8Array, fileName: string): void {
  // A Blob must own its bytes: a view over a larger buffer would otherwise carry
  // the rest of that buffer into the file.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/zip' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

// ── Failure reporting ──────────────────────────────────────────────────────

/**
 * Read a failure the way the product says failures may be read: a code, and
 * details that are codes, counts, and lengths.
 *
 * `toReport()` is the sanitized form the product itself publishes, and it is
 * preferred over reading `code`/`details` off the instance. A failure that is not
 * typed at all - an `IndexedDB` error, say - is reported as
 * `UNEXPECTED_ERROR` with **no message**: a message is the one field a foreign
 * error is free to fill with anything, and a subject name in a paragraph is
 * exactly the leak this product was built to prevent.
 */
function readFailure(error: unknown): RestoreFailureReport {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      code?: unknown;
      details?: unknown;
      toReport?: () => unknown;
    };
    if (typeof candidate.toReport === 'function') {
      const report = candidate.toReport() as { code?: unknown; details?: unknown } | null;
      if (report !== null && typeof report === 'object' && typeof report.code === 'string') {
        return { code: report.code, details: readDetailValues(report.details) };
      }
    }
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, details: readDetailValues(candidate.details) };
    }
  }
  return { code: 'UNEXPECTED_ERROR', details: {} };
}

/** Keep only the value shapes a typed detail is allowed to carry. */
function readDetailValues(details: unknown): Readonly<Record<string, string | number | boolean | null>> {
  if (typeof details !== 'object' || details === null) return {};
  const kept: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      kept[key] = value;
    }
  }
  return kept;
}

// ── The live device ────────────────────────────────────────────────────────

/**
 * The live storage-v2 handle and the generation its pointer names.
 *
 * The product's request type *is* a repository handle, so the screen that hands a
 * generation to the product has to be able to reach the handle the bootstrap
 * published. The product publishes it - `resolveLiveDeviceRepository()` and
 * `readLiveActiveGenerationId()` - and this screen asks the product for both,
 * which is what makes this the only route from a screen to storage-v2.
 *
 * The boundary this rests on is plan section 11's "there is exactly one place in
 * the application that knows storage-v2 exists", restated one level down:
 * `tests/migrations/qaHardening.test.ts` holds a closed allowlist
 * (`STORAGE_V2_SEAMS`) of the files permitted to name a storage-v2 module, and a
 * screen that reached `repositorySelection` itself would have to be an entry on
 * it. Going through the product instead means no UI file is on that list, the
 * product tree stays the single seam, and a build with the flag off still
 * contains none of it - the accessor is reached by a lazy `import()` of a
 * literal, so the selection module and the repository type behind it are fetched
 * only when a learner actually takes or restores a backup.
 *
 * `null` is the expected answer rather than an error: while
 * `VITE_STORAGE_REPOSITORY` is `legacy` there is no versioned store to read, and
 * the screen says so in words instead of failing.
 */
async function readLiveDevice(): Promise<{ repository: DeviceRepository; generationId: string } | null> {
  const product = await import('@/services/persistence/products/fullDeviceBackup');
  const repository = await product.resolveLiveDeviceRepository();
  if (repository === null) return null;
  const generationId = await product.readLiveActiveGenerationId();
  if (generationId === null) return null;
  return { repository, generationId };
}

/** The attachment ids a generation references, which is what the payload map is keyed by. */
async function readAttachmentIds(repository: DeviceRepository, generationId: string): Promise<string[]> {
  const snapshot = await repository.readRecords(generationId);
  return snapshot.records.attachmentMetadata.map((envelope) => envelope.value.attachmentId);
}

/** The product's result, narrowed to the fields this screen reports. */
function toSuccessReport(result: FullDeviceImportResult): RestoreSuccessReport {
  return {
    generationId: result.generationId,
    previousActiveGenerationId: result.previousActiveGenerationId,
    activated: result.activated,
    previousGenerationRetained: result.previousGenerationRetained,
    keepPreviousGeneration: result.keepPreviousGeneration,
    retentionNote: result.retentionNote,
    disclosedWarnings: result.disclosedWarnings,
    externalOnlyAttachments: result.externalOnlyAttachments,
    recordCounts: result.recordCounts,
    contentChecksum: result.contentChecksum,
    restoredActiveSubjectId: result.restoredActiveSubjectId,
    reusedArchiveGenerationId: result.reusedArchiveGenerationId,
    migrationReceiptCount: result.migrationReceiptCount,
    receiptNote: result.receiptNote,
  };
}

function toPreview(result: FullDeviceImportResult['preview']): BackupPreview {
  return {
    formatVersion: result.formatVersion,
    storageGenerationFormatVersion: result.storageGenerationFormatVersion,
    subjectSchemaVersion: result.subjectSchemaVersion,
    createdAt: result.createdAt,
    manifestCreatedAt: result.manifestCreatedAt,
    memberCount: result.memberCount,
    totalMemberCount: result.totalMemberCount,
    totalBytes: result.totalBytes,
    recordCounts: result.recordCounts,
    attachmentBytes: result.attachmentBytes,
    externalOnlyAttachments: result.externalOnlyAttachments,
    externalOnlyCount: result.externalOnlyCount,
  };
}

interface ExportReport {
  readonly fileName: string;
  readonly byteLength: number;
  readonly subjectCount: number;
  readonly externalOnlyCount: number;
  readonly manifestCreatedAt: string;
}

function toExportReport(result: FullDeviceExportResult): ExportReport {
  return {
    fileName: result.fileName,
    byteLength: result.bytes.byteLength,
    subjectCount: result.manifest.recordCounts.subjects,
    externalOnlyCount: result.externalOnlyAttachments.length,
    manifestCreatedAt: result.manifest.createdAt,
  };
}

// ── Motion ─────────────────────────────────────────────────────────────────

/**
 * Whether the learner has asked for less motion.
 *
 * The stylesheet answers this on its own through a `prefers-reduced-motion`
 * media query, which is the rule that holds when scripting is unavailable. This
 * hook exists so the *behaviour* can match: it puts `data-kd-motion="reduced"`
 * on the Data Center's root, and the stylesheet's own reduced-motion rule keys
 * off both that attribute and the media query, so a transition cannot survive a
 * change of preference that happens while the screen is open.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => readReducedMotionPreference());
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function readReducedMotionPreference(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── The shell ──────────────────────────────────────────────────────────────

export interface DataCenterProps {
  /**
   * Called after a restore has activated a new generation.
   *
   * The Data Center does not know what a host lists or where it puts it, so it
   * reports the event and the host decides. The Welcome screen uses it to reload
   * its subject list and show it.
   */
  readonly onRestored?: (() => void) | null;
}

export function DataCenter({ onRestored = null }: DataCenterProps): JSX.Element | null {
  const enabled = runtimeConfig.dataProductsV2;
  const activeSubjectId = useSessionStore((state) => state.activeSubjectId);
  const prefersReducedMotion = usePrefersReducedMotion();

  const headingId = useId();
  const tabId = useId();
  const panelId = useId();
  const dialogTitleId = useId();
  const dialogBodyId = useId();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inspectButtonRef = useRef<HTMLButtonElement | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportFailure, setExportFailure] = useState<string | null>(null);

  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [chosenBytes, setChosenBytes] = useState<Uint8Array | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [inspectionMessage, setInspectionMessage] = useState<string | null>(null);
  const [inspectionFailure, setInspectionFailure] = useState<RestoreFailureReport | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);

  // The dialog is contained and Escape-dismissed, and genuinely not dismissible
  // while a restore is in flight: a surface that looks dismissible and ignores
  // the key is worse than one that does not.
  const dialogRef = useModalFocus<HTMLDivElement>({
    active: dialogOpen && !importing,
    onEscape: dialogOpen && !importing ? () => setDialogOpen(false) : null,
  });

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const closeDialog = useCallback(() => setDialogOpen(false), []);

  // ── Export ──
  const handleCreateBackup = useCallback(async () => {
    setExporting(true);
    setExportFailure(null);
    setExportMessage('Reading everything on this device.');
    try {
      const live = await readLiveDevice();
      if (live === null) {
        setExportMessage(null);
        setExportFailure(
          'This build is not keeping its data in the versioned store a full-device backup reads from, so there is nothing here to back up. Use the subject tools above instead.',
        );
        return;
      }
      const product = await import('@/services/persistence/products/fullDeviceBackup');
      const attachmentIds = await readAttachmentIds(live.repository, live.generationId);
      const result = await product.exportFullDeviceBackup({
        repository: live.repository,
        generationId: live.generationId,
        now: new Date().toISOString(),
        payloadBytes: await product.resolveDeviceLocalPayloadBytes(attachmentIds),
        activeSubjectId: activeSubjectId ?? null,
      });
      downloadBackupFile(result.bytes, result.fileName);
      const report = toExportReport(result);
      setExportMessage(
        `Saved ${report.fileName} to this device: ${report.byteLength} bytes, ` +
          `${report.subjectCount} ${report.subjectCount === 1 ? 'subject' : 'subjects'}.` +
          (report.externalOnlyCount === 0
            ? ' Every image is in it.'
            : ` ${report.externalOnlyCount} ${
                report.externalOnlyCount === 1 ? 'image is' : 'images are'
              } not in it, and the notes on the Data tab say why.`),
      );
    } catch (error) {
      setExportMessage(null);
      setExportFailure(`The backup could not be made. The problem was reported as ${readFailure(error).code}.`);
    } finally {
      setExporting(false);
    }
  }, [activeSubjectId]);

  // ── Inspection ──
  const handleFileChosen = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file twice in a row still raises `change`.
    event.target.value = '';
    if (file === undefined) return;

    // Focus moves to the control that will be restored to when the dialog closes,
    // before the dialog exists: `useModalFocus` restores to whatever had focus
    // when it opened, and a file input the learner never focused is not it.
    inspectButtonRef.current?.focus();

    setFileName(file.name);
    setChosenBytes(null);
    setPreview(null);
    setInspectionFailure(null);
    setInspectionMessage('Reading the file you chose.');
    setOutcome(null);
    setReading(true);
    // Opened from the act of choosing a file, and it carries a confirm control
    // that is disabled until the read finishes. That is what makes the import
    // unreachable by any other route.
    setDialogOpen(true);

    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const validation = await import('@/services/persistence/products/archiveValidation');
        const inspection = validation.inspectFullDeviceArchive(bytes);
        if (!inspection.ok) {
          setChosenBytes(null);
          setPreview(null);
          setDialogOpen(false);
          setInspectionMessage(null);
          setInspectionFailure({ code: inspection.error.code, details: inspection.error.details });
          return;
        }
        setChosenBytes(bytes);
        setPreview(toPreview(inspection.preview));
        setInspectionMessage(
          inspection.preview.externalOnlyCount === 0
            ? 'Read the file. Everything in it can be restored.'
            : `Read the file. ${inspection.preview.externalOnlyCount} ${
                inspection.preview.externalOnlyCount === 1 ? 'image cannot' : 'images cannot'
              } be restored, and the window says why.`,
        );
      } catch (error) {
        setChosenBytes(null);
        setPreview(null);
        setDialogOpen(false);
        setInspectionMessage(null);
        setInspectionFailure(readFailure(error));
      } finally {
        setReading(false);
      }
    })();
  }, []);

  // ── Import ──
  const handleConfirmRestore = useCallback(async () => {
    if (chosenBytes === null || preview === null) return;
    setImporting(true);
    try {
      const live = await readLiveDevice();
      if (live === null) {
        setDialogOpen(false);
        setOutcome({
          kind: 'failure',
          report: {
            code: 'NO_ACTIVE_GENERATION',
            details: { reason: 'no-versioned-store-on-this-device' },
          },
        });
        return;
      }
      const product = await import('@/services/persistence/products/fullDeviceBackup');
      const result = await product.importFullDeviceBackup({
        repository: live.repository,
        bytes: chosenBytes,
        now: new Date().toISOString(),
        keepPreviousGeneration: true,
      });
      setDialogOpen(false);
      setOutcome({ kind: 'success', result: toSuccessReport(result) });
      onRestored?.();
    } catch (error) {
      setDialogOpen(false);
      setOutcome({ kind: 'failure', report: readFailure(error) });
    } finally {
      setImporting(false);
    }
  }, [chosenBytes, preview, onRestored]);

  const handleDismissOutcome = useCallback(() => setOutcome(null), []);

  if (!enabled) return null;

  const externalOnlyCount = preview?.externalOnlyCount ?? 0;
  const subjectCount = preview?.recordCounts.subjects ?? 0;

  return (
    <section
      className="kd-data-center"
      data-kd-surface="data-center"
      data-kd-motion={prefersReducedMotion ? 'reduced' : undefined}
      aria-labelledby={headingId}
    >
      <h2 className="kd-heading" id={headingId}>
        Data Center
      </h2>
      <p className="kd-lede">
        Backups, restores, and what stays on this device. Everything here works on this device only: there is
        no account to sign in to and nothing is sent anywhere.
      </p>

      <div className="kd-tabs" role="tablist" aria-label="Data products">
        <button
          type="button"
          role="tab"
          className="kd-tab"
          id={tabId}
          aria-selected="true"
          aria-controls={panelId}
        >
          Full device backup
        </button>
      </div>

      <div
        className="kd-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId}
        tabIndex={0}
      >
        {/* ── Privacy, first and always ── */}
        <section className="kd-block" aria-labelledby={`${headingId}-privacy`}>
          <h3 className="kd-subheading" id={`${headingId}-privacy`}>
            Where your data goes
          </h3>
          <ul className="kd-bullets">
            <li>
              A backup is a file your browser writes to this device, in the place you chose. Knowledge Dungeon
              does not upload it, and there is nowhere for it to upload it to.
            </li>
            <li>
              A backup can only include picture data that is on this device. An image you added as a link to
              a picture on the internet stays a link: the app never downloads it, so there are no bytes to
              back up.
            </li>
            <li>
              A restore keeps the copy that is here now. It writes the backup into a new copy first and only
              then switches to it, so a restore that goes wrong leaves what you had in place.
            </li>
          </ul>
        </section>

        {/* ── Take a backup ── */}
        <section className="kd-block" aria-labelledby={`${headingId}-export`}>
          <h3 className="kd-subheading" id={`${headingId}-export`}>
            Take a backup
          </h3>
          <p className="kd-lede">
            One file with every subject, your progress, your study history, your settings, your custom
            pictures, and every image whose data is on this device. It is written straight to this device.
          </p>
          <div className="kd-actions">
            <button
              type="button"
              className="kd-button kd-button--primary"
              onClick={() => void handleCreateBackup()}
              disabled={exporting}
              aria-busy={exporting || undefined}
            >
              {exporting ? 'Making the backup…' : 'Download device backup'}
            </button>
          </div>
          <p className="kd-status" data-kd-surface="export-status" role="status" aria-live="polite">
            {exportMessage}
          </p>
          {exportFailure === null ? null : (
            <p className="kd-problem" data-kd-surface="export-problem" role="alert">
              <span className="kd-marker" aria-hidden="true">
                !
              </span>
              {exportFailure}
            </p>
          )}
        </section>

        {/* ── Restore a backup ── */}
        <section className="kd-block" aria-labelledby={`${headingId}-restore`}>
          <h3 className="kd-subheading" id={`${headingId}-restore`}>
            Restore a backup
          </h3>
          <p className="kd-lede">
            Choose a backup file and read what is in it before anything changes. Restoring makes the file the
            copy this device uses.
          </p>
          <div className="kd-actions">
            <button
              type="button"
              ref={inspectButtonRef}
              className="kd-button kd-button--primary"
              onClick={openFilePicker}
              disabled={importing}
            >
              Inspect a backup file
            </button>
            {preview === null ? null : (
              <button type="button" className="kd-button" onClick={openFilePicker} disabled={importing}>
                Choose a different backup file
              </button>
            )}
            {/*
              The real file input. It is `hidden` rather than `display: none`-ed by
              a class for the same reason the Welcome screen's own pickers are: the
              control the learner presses is a real button, so the input needs no
              accessible presence of its own, and a test can still set files on it.
            */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".kdbak,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => handleFileChosen(event)}
            />
          </div>
          <p className="kd-status" data-kd-surface="inspection-status" role="status" aria-live="polite">
            {inspectionMessage}
          </p>
          {inspectionFailure === null ? null : (
            <div className="kd-problem-block" data-kd-surface="inspection-problem" role="alert">
              <p className="kd-problem">
                <span className="kd-marker" aria-hidden="true">
                  !
                </span>
                This file cannot be used. Nothing on this device was changed.
              </p>
              <p className="kd-lede">
                It was reported as <span className="kd-mono">{inspectionFailure.code}</span>. A backup has to
                be a file this version of Knowledge Dungeon wrote, and this one is not one.
              </p>
            </div>
          )}

          <ImportPreview preview={preview} fileName={fileName} />

          <RecoveryStatus outcome={outcome} busy={importing} onDismiss={handleDismissOutcome} />
        </section>
      </div>

      {/* ── The explicit destructive confirmation ── */}
      {dialogOpen ? (
        <div className="kd-dialog-layer">
          <div
            className="kd-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            aria-describedby={dialogBodyId}
            aria-busy={importing || undefined}
            tabIndex={-1}
            ref={dialogRef}
            data-kd-surface="restore-confirmation"
          >
            <h3 className="kd-dialog-title" id={dialogTitleId}>
              Replace the data on this device?
            </h3>
            <div id={dialogBodyId}>
              {reading ? (
                <p className="kd-dialog-line">Reading the file you chose. Nothing has changed yet.</p>
              ) : (
                <ul className="kd-bullets">
                  <li>
                    Restoring this file makes it the copy this device uses. Everything the app has on this
                    device is replaced by what is in the file
                    {subjectCount === 0
                      ? ', and the file holds no subjects.'
                      : `, which carries ${subjectCount} ${subjectCount === 1 ? 'subject' : 'subjects'}.`}
                  </li>
                  <li>
                    The copy that is here now is kept, not deleted, so you can go back to it if this is the
                    wrong file.
                  </li>
                  {externalOnlyCount === 0 ? null : (
                    <li>
                      {externalOnlyCount} {externalOnlyCount === 1 ? 'image has' : 'images have'} no picture
                      data in the file and will come back without {externalOnlyCount === 1 ? 'it' : 'them'}.
                      The full reason is in the list on the Data tab.
                    </li>
                  )}
                </ul>
              )}
            </div>
            {importing ? (
              <p className="kd-dialog-line" role="status" aria-live="polite">
                Restoring. The window stays open until it has finished.
              </p>
            ) : null}
            <div className="kd-actions">
              <button
                type="button"
                className="kd-button"
                onClick={closeDialog}
                disabled={importing}
              >
                Keep the data that is here
              </button>
              <button
                type="button"
                className="kd-button kd-button--danger"
                onClick={() => void handleConfirmRestore()}
                disabled={chosenBytes === null || reading || importing}
                aria-busy={importing || undefined}
              >
                Replace device data with this backup
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
