/**
 * Phases 5 and 6: the Data Center.
 *
 * One screen, two data products, and the rules that shape both.
 *
 * ## Rule 1: it renders nothing at all unless the flag says so
 *
 * `VITE_DATA_PRODUCTS_V2` is the plan's owner flag for all three data-product
 * phases and it defaults to `false`. The Welcome screen mounts this component only
 * when the flag is on, and this component reads the flag itself as well, so a
 * build that is served this file by mistake still renders nothing: no heading, no
 * tab, no control, no live region. The default build's data tab is therefore
 * exactly what it was before this file existed, and the plan's Phase 5 rollback is
 * a build-time flag rather than a source change.
 *
 * ## Rule 2: both products are reached only through a lazy `import()`
 *
 * Every call into `src/services/persistence/products/` is a dynamic import of a
 * string literal, and every *type* from it is reached through a type-position
 * `import()` expression that TypeScript erases. Nothing here is a static import -
 * not even `import type` - because a static edge would put the products and the ZIP
 * codec they pull in into the entry chunk a build with the flag off loads. That is
 * plan section 11's "new data products are opt-in", and it is why the first thing a
 * learner does in a flagged build costs one extra request.
 *
 * The two dynamic imports sit in two files, not one: this one, for the `.kdbak`,
 * and `SubjectBackupTab` for the `.kdsubject`. The shared boundary helpers are in
 * `productAccess`, which reaches storage-v2 through the `.kdsubject` product's
 * re-exported accessors so there is one lazy import for the device and not two.
 *
 * ## Rule 3: a backup is a local download and a local file pick, and nothing else
 *
 * The export path is `product` → `Blob` → object URL → anchor → **revoke**, and it
 * exists exactly once, in `productAccess.downloadBackupFile`. There is no upload,
 * no share, no `fetch`, no navigation, and no form anywhere in this file or in any
 * surface it renders, and `tests/data/localDownloadOnly.test.ts` walks the real
 * application graph to keep it that way. The file name comes from the product
 * (`result.fileName`), which is a constant, so nothing a learner authored can
 * reach a file name.
 *
 * ## The tabs
 *
 * Two, wired as a real tablist: `role="tablist"`, roving `tabIndex`, arrow-key
 * movement with Home and End, and `aria-selected` that is genuinely `true` on
 * exactly one tab. Only the selected panel's contents are rendered, so the other
 * tab's file input does not exist in the DOM - a hidden panel full of focusable
 * controls is a thing a keyboard user can tab into and a screen reader can read, and
 * the `aria-controls` of an unselected tab still resolves because the panel
 * *element* is always there.
 *
 * ## The order the learner meets, per tab
 *
 * 1. **Privacy**, first and unconditionally: what a backup is, and the three things
 *    it cannot promise.
 * 2. **Take a backup**: choose, then one control, one status line.
 * 3. **Restore a backup**: choose a file, read what is in it, and only then the
 *    explicit confirmation - which exists from the moment a file is chosen and is
 *    the only route to a restore.
 * 4. **What happened**: the outcome, reported field by field from the product's
 *    own result. See `RecoveryStatus` for what it deliberately refuses to claim.
 *
 * The confirmation is a real dialog (plan section 10.1: focus trapped, initial
 * focus, Escape, restoration), opened by the act of choosing a file, so the import
 * is unreachable by any other route. `ConfirmDialog` is that dialog, shared by
 * both tabs; `tests/unit/dataCenter.test.tsx` drives the device tab through all
 * four steps and `tests/unit/subjectBackupTab.test.tsx` drives the subject tab
 * through its two modes.
 *
 * Privacy: every string in this file is generic. Nothing here renders a subject
 * name, a room topic, a note, an image file name, an image link, or a path, and
 * the only identifiers that reach the DOM are the opaque ones the products
 * themselves report, inside collapsed "Technical details" blocks. The one place a
 * subject *name* is rendered in the Data Center as a whole is the subject tab's
 * replace confirmation, which the plan requires to name what it destroys.
 */

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type JSX, type KeyboardEvent } from 'react';
import { useSessionStore } from '@/store/sessionStore';
import { runtimeConfig } from '@/config/featureFlags';
import { ImportPreview, type BackupPreview } from './ImportPreview';
import { RecoveryStatus, type RestoreOutcome } from './RecoveryStatus';
import { ConfirmDialog } from './ConfirmDialog';
import { SubjectBackupTab } from './SubjectBackupTab';
import {
  downloadBackupFile,
  readDeviceAttachmentIds,
  readFailure,
  readLiveDevice,
  toDeviceExportReport,
  toDeviceImportReport,
  type FailureReport,
} from './productAccess';
import './dataCenter.css';

// ── The product's own types, reached without a static edge ─────────────────
//
// `import('...')` in a type position is erased by TypeScript and produces no
// runtime import at all, so these aliases are free at build time and exact at
// compile time: if the product renames a field or changes a type, this file stops
// compiling rather than rendering a field that is no longer there.

type FullDeviceProduct = typeof import('@/services/persistence/products/fullDeviceBackup');
type FullDeviceImportResult = Awaited<ReturnType<FullDeviceProduct['importFullDeviceBackup']>>;

// ── Failure reporting ──────────────────────────────────────────────────────

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

function toLegacyExportReport(result: Awaited<ReturnType<FullDeviceProduct['exportFullDeviceBackup']>>): ExportReport {
  const narrowed = toDeviceExportReport(result);
  return { ...narrowed, manifestCreatedAt: result.manifest.createdAt };
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

// ── The tabs ───────────────────────────────────────────────────────────────

/**
 * The two products, in the order a learner meets them.
 *
 * `tabId`/`panelId` are filled in by the component from `useId`, and `matches` is
 * the one thing that decides what is rendered. The names are chosen so Phase 5's
 * browser lane, which locates the full-backup tab by `/full[\s-]*device|full[\s-]*backup/i`,
 * still resolves to exactly one tab: neither "Full device backup" nor "One subject
 * backup" is matched twice, and no future tab may be named so that two match.
 */
type TabKey = 'device' | 'subject';

const TABS: ReadonlyArray<{ readonly key: TabKey; readonly label: string; readonly hint: string }> = [
  { key: 'device', label: 'Full device backup', hint: 'Everything on this device in one file' },
  { key: 'subject', label: 'One subject backup', hint: 'A single subject, its progress, and its images' },
];

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
  /**
   * Called after a **subject** import has activated a new generation.
   *
   * Separate from `onRestored` because the two need different things. A
   * whole-device restore navigates the Welcome screen to the subject list; a
   * subject import must not, because the outcome report behind it carries the
   * disclosures that decide whether the import was a good idea. This one only
   * refreshes the list.
   */
  readonly onSubjectImported?: (() => void) | null;
}

export function DataCenter({ onRestored = null, onSubjectImported = null }: DataCenterProps): JSX.Element | null {
  const enabled = runtimeConfig.dataProductsV2;
  const activeSubjectId = useSessionStore((state) => state.activeSubjectId);
  const prefersReducedMotion = usePrefersReducedMotion();

  const headingId = useId();
  const tabsId = useId();
  const tabIds: Record<TabKey, string> = { device: `${tabsId}-tab-device`, subject: `${tabsId}-tab-subject` };
  const panelIds: Record<TabKey, string> = { device: `${tabsId}-panel-device`, subject: `${tabsId}-panel-subject` };

  const [activeTab, setActiveTab] = useState<TabKey>('device');
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});

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
  const [inspectionFailure, setInspectionFailure] = useState<FailureReport | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);

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
          'This build is not keeping its data in the versioned store a full-device backup reads from, so there is nothing here to back up. Use the subject tab instead.',
        );
        return;
      }
      const product = await import('@/services/persistence/products/fullDeviceBackup');
      const attachmentIds = await readDeviceAttachmentIds(live.repository, live.generationId);
      const result = await product.exportFullDeviceBackup({
        repository: live.repository,
        generationId: live.generationId,
        now: new Date().toISOString(),
        payloadBytes: await product.resolveDeviceLocalPayloadBytes(attachmentIds),
        activeSubjectId: activeSubjectId ?? null,
      });
      downloadBackupFile(result.bytes, result.fileName);
      const report = toLegacyExportReport(result);
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
      setOutcome({ kind: 'success', result: toDeviceImportReport(result) });
      onRestored?.();
    } catch (error) {
      setDialogOpen(false);
      setOutcome({ kind: 'failure', report: readFailure(error) });
    } finally {
      setImporting(false);
    }
  }, [chosenBytes, preview, onRestored]);

  const handleDismissOutcome = useCallback(() => setOutcome(null), []);

  // ── The tablist ──
  //
  // Arrow keys move between tabs and select as they go, which is the ARIA pattern
  // for an automatic-activation tablist: there is nothing on the other tab to
  // discover before switching, and a learner pressing Right once expects to be on
  // the next tab. Home and End go to the ends. The roving `tabIndex` means Tab
  // itself moves out of the tablist rather than through it, so the tablist is one
  // stop in the page's tab order and two stops inside.
  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, current: TabKey) => {
      const index = TABS.findIndex((tab) => tab.key === current);
      if (index < 0) return;
      let next = index;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (index + 1) % TABS.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (index - 1 + TABS.length) % TABS.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = TABS.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const key = (TABS[next] as { readonly key: TabKey }).key;
      setActiveTab(key);
      tabRefs.current[key]?.focus();
    },
    [],
  );

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

      <div className="kd-tabs" role="tablist" aria-label="Data products" aria-orientation="horizontal">
        {TABS.map((tab) => {
          const selected = tab.key === activeTab;
          return (
            <button
              type="button"
              role="tab"
              key={tab.key}
              ref={(node) => {
                tabRefs.current[tab.key] = node;
              }}
              className="kd-tab"
              id={tabIds[tab.key]}
              aria-selected={selected}
              aria-controls={panelIds[tab.key]}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(tab.key)}
              onKeyDown={(event) => handleTabKeyDown(event, tab.key)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        className="kd-panel"
        role="tabpanel"
        id={panelIds.device}
        aria-labelledby={tabIds.device}
        tabIndex={0}
        hidden={activeTab !== 'device'}
      >
        {activeTab === 'device' ? (
          <>
            {/* ── Privacy, first and always ── */}
            <section className="kd-block" aria-labelledby={`${headingId}-privacy`}>
              <h3 className="kd-subheading" id={`${headingId}-privacy`}>
                Where your data goes
              </h3>
              <ul className="kd-bullets">
                <li>
                  A backup is a file your browser writes to this device, in the place you chose. Knowledge
                  Dungeon does not upload it, and there is nowhere for it to upload it to.
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

              <RecoveryStatus
                outcome={outcome}
                busy={importing}
                onDismiss={handleDismissOutcome}
                pendingHeading="Restoring"
                pendingLine="Writing the backup into a new copy on this device. This can take a moment."
              />
            </section>
          </>
        ) : null}
      </div>

      <div
        className="kd-panel"
        role="tabpanel"
        id={panelIds.subject}
        aria-labelledby={tabIds.subject}
        tabIndex={0}
        hidden={activeTab !== 'subject'}
      >
        {activeTab === 'subject' ? <SubjectBackupTab onSubjectImported={onSubjectImported} /> : null}
      </div>

      {/* ── The explicit destructive confirmation, for the full-device tab ── */}
      <ConfirmDialog
        open={dialogOpen}
        surface="restore-confirmation"
        title="Replace the data on this device?"
        busy={importing}
        busyMessage="Restoring. The window stays open until it has finished."
        dismissLabel="Keep the data that is here"
        confirmLabel="Replace device data with this backup"
        confirmDisabled={chosenBytes === null || reading}
        onDismiss={closeDialog}
        onConfirm={() => void handleConfirmRestore()}
      >
        {reading ? (
          <p className="kd-dialog-line">Reading the file you chose. Nothing has changed yet.</p>
        ) : (
          <ul className="kd-bullets">
            <li>
              Restoring this file makes it the copy this device uses. Everything the app has on this device is
              replaced by what is in the file
              {subjectCount === 0
                ? ', and the file holds no subjects.'
                : `, which carries ${subjectCount} ${subjectCount === 1 ? 'subject' : 'subjects'}.`}
            </li>
            <li>
              The copy that is here now is kept, not deleted, so you can go back to it if this is the wrong
              file.
            </li>
            {externalOnlyCount === 0 ? null : (
              <li>
                {externalOnlyCount} {externalOnlyCount === 1 ? 'image has' : 'images have'} no picture data in
                the file and will come back without {externalOnlyCount === 1 ? 'it' : 'them'}. The full reason
                is in the list on the Data tab.
              </li>
            )}
          </ul>
        )}
      </ConfirmDialog>
    </section>
  );
}
