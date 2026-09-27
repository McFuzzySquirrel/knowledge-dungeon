/**
 * Phase 6: the subject-backup tab of the Data Center.
 *
 * One subject, its learner state, one `.kdsubject` file, and the two ways to bring
 * one back. This component is the whole of the interface, and it is built around
 * one asymmetry that decides almost everything below.
 *
 * ## The asymmetry: one mode is the default and one destroys something
 *
 * `Create a copy` is the **default**, in three independent senses, and all three
 * are load-bearing:
 *
 * 1. the radio group's value is initialised to `copy`, and the copy radio is the
 *    one rendered `checked`;
 * 2. `handleFileChosen` **resets the mode to `copy` on every file choice**, and the
 *    choice is only rendered while a file is being confirmed, so there is no
 *    destructive state for a previous file to leave behind at all;
 * 3. `handleConfirm` returns without doing anything unless the mode is `replace`
 *    *and* a replace target has been established. The check is inside the
 *    handler, not only in the confirm button's `disabled` attribute, so a stale
 *    render or a synthetic click still gets nothing.
 *
 * And the destructive mode is offered **only when it is possible**. The product's
 * contract is that a replace target must equal the archive's own subject id and
 * must exist on this device, so the `Replace` radio is `disabled` with a stated
 * reason unless the file's subject is one this device holds. A `.kdsubject` of a
 * subject from another device therefore *cannot* be replaced onto an unrelated
 * subject, which is the failure mode the product's `replace-target-disagrees`
 * refusal exists to prevent and which the interface now prevents first.
 *
 * ## Where the mode choice lives, and why it moved
 *
 * Inside the confirmation dialog, and it started outside. A real Chromium run of
 * this surface - not a unit test - showed the original arrangement to be broken:
 * the dialog is a modal layer, so it intercepts pointer events for everything
 * behind it, and a mode chosen *outside* it was a mode whose confirmation could
 * never be seen. The learner could select "replace", watch the dialog close, and
 * never be shown the sentence naming the subject it was about to destroy.
 *
 * In the dialog the choice sits next to the wording that states what it will do and
 * one focus-trapped step from the control that commits it, and it is *only* where
 * that wording is: dismiss the window and the destructive choice leaves the
 * document with it. That is a stronger property than "it resets to copy", and
 * `tests/unit/subjectBackupTab.test.tsx` asserts it.
 *
 * ## Why a replace must never be reachable by accident
 *
 * Four routes are closed structurally, not by care:
 *
 * - **No form.** There is no `<form>` in this file and every button is
 *   `type="button"`, so an Enter keypress activates exactly the control that has
 *   focus and nothing else. The only text-entry control is the hidden file input,
 *   which carries no key handler at all.
 * - **The file input is `hidden` and driven by a real button.** A double click on
 *   "Choose a subject backup file" opens the picker twice at worst; it cannot
 *   select a mode and it cannot commit anything, because the mode is reset on
 *   every `change` and only the dialog commits.
 * - **Both the mode choice and the commit control exist only inside the dialog.**
 *   Nothing outside it is named like a way to commit or a way to choose a mode, and
 *   the dialog is opened by the act of choosing a file - so a `.kdsubject` cannot
 *   be imported without passing through a confirmation, exactly as a `.kdbak`
 *   cannot be restored.
 * - **Escape stops working while the import is in flight**, because
 *   `ConfirmDialog` passes `null` to `useModalFocus` when `busy`. A replace that
 *   has started always produces an outcome report.
 *
 * The product is the fourth and last line: `importSubjectBackup` refuses a
 * `replace` without `confirmReplace: true`, without `replaceSubjectId`, without
 * that id equalling the archive's own, and without the target existing. This
 * component is not trusted to be the only thing standing between a learner and a
 * destroyed subject; it is one of four.
 *
 * ## What is read from where
 *
 * The archive's own subject id is needed to decide whether a replace is even
 * possible, and it comes from `readSubjectArchiveContents(bytes).subjectId`, which
 * states it unconditionally and which the product documents as an opaque identifier
 * rather than learner content. The id is then looked up in **this device's own
 * records** for the name the confirmation has to use - never in the file.
 *
 * ### Why not the preview, precisely
 *
 * `SubjectArchivePreview` has **no subject field**, and it is not a subject
 * summary. It is also *not* free of identifiers, and the difference matters here:
 * `externalOnlyAttachments[].subjectId` and `.roomId` do carry the archive's
 * subject id, because "this image's bytes were not recovered" is a claim about a
 * specific file in a specific room of a specific subject and means nothing without
 * them. That is Phase 5's own `ExternalOnlyAttachmentReport`, which the `.kdbak`
 * preview has always disclosed the same way.
 *
 * So the preview is **not a dependable way to learn the archive's subject**, for two
 * reasons that are properties of the data rather than of the API:
 *
 * - the id is present only *incidentally*, inside a per-image disclosure list, so
 *   reading it would mean reading a disclosure entry as a subject lookup; and
 * - an archive with no image to disclose carries **no identifier at all**, so for
 *   the ordinary case - a complete subject, nothing missing - there is nothing to
 *   read and the answer would have to be invented.
 *
 * The contents type is the only read that answers the question for every archive.
 * Nothing is rendered from it: the id goes straight into a lookup against this
 * device, and the only name a learner ever sees is this device's own.
 *
 * The cost is that the archive is parsed twice on the inspect path, because
 * `importSubjectBackup` takes bytes and parses them again. That is a product
 * observation rather than a product change: a dedicated "which subject is this
 * archive" accessor would remove the second parse, and adding one is the product
 * owner's call, not this screen's. Recorded here rather than worked around.
 *
 * ## Privacy
 *
 * A subject *name* is rendered in exactly two places: the export picker's own
 * option list, and the replace confirmation, which is required to say what it
 * destroys. It reaches no file name (the download is always the product's
 * constant `SUBJECT_BACKUP_FILE_NAME`), no status sentence, no error message, and
 * no technical detail. The disclosure of images without picture data names none
 * of them: each is identified by its position with the reason in words, which is
 * the same rule Phase 5's preview established and the rule
 * `tests/data/subjectPrivacy.test.ts` holds for the product's own surfaces.
 *
 * No renderer, no network, no analytics, and no upload endpoint: the export is a
 * `Blob` handed to an anchor by `productAccess.downloadBackupFile`, and the
 * product is reached only by a lazy `import()` of a string literal.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';

import { useSessionStore } from '@/store/sessionStore';
import { ImportPreview, type BackupPreview, type PreviewSection } from './ImportPreview';
import { RecoveryStatus, type SubjectImportOutcome } from './RecoveryStatus';
import { ConfirmDialog } from './ConfirmDialog';
import {
  downloadBackupFile,
  readDeviceSubjectAttachmentIds,
  readDeviceSubjects,
  readFailure,
  readLiveDevice,
  toSubjectExportReport,
  toSubjectImportReport,
  type DeviceSubject,
  type FailureReport,
} from './productAccess';

// ── The product, reached only lazily ───────────────────────────────────────
//
// A type-position `import()` is erased by TypeScript, so this alias costs a
// default build nothing and stops this file compiling the moment the product
// renames a field. Every *value* from the product is a dynamic `import()` of a
// string literal, which is what keeps the ZIP codec and the id remapper out of the
// chunk a build with the flag off loads.

type SubjectProduct = typeof import('@/services/persistence/products/subjectBackup');
type SubjectPreview = SubjectProduct extends { readSubjectArchive(bytes: Uint8Array): infer R } ? R : never;

// ── What the preview table shows for a `.kdsubject` ────────────────────────

/**
 * The `.kdsubject`'s own record-count keys, with plain-language labels.
 *
 * Deliberately **not** the ten storage-v2 store names `ImportPreview` defaults
 * to. A `.kdsubject` is not a whole generation - it carries one subject and
 * nothing else - so rows for settings, shortcuts, custom pictures, recovery
 * records, and data-move receipts would be five rows of zero describing a category
 * of thing this format has no room for. The six rows below are the six things the
 * archive's own manifest counts, which is the only honest count of a product that
 * is deliberately not a whole-generation replace.
 */
const SUBJECT_PREVIEW_SECTIONS: readonly PreviewSection[] = [
  { key: 'subjects', label: 'Subject' },
  { key: 'progression', label: 'Progress' },
  { key: 'sessions', label: 'Study sessions' },
  { key: 'assistance', label: 'Assistance records' },
  { key: 'attachments', label: 'Image records' },
  { key: 'attachmentBlobs', label: 'Image data' },
];

// ── The two import modes ───────────────────────────────────────────────────

type ImportMode = 'copy' | 'replace';

const COPY_MODE_NAME = 'Create a copy';
const REPLACE_MODE_NAME = 'Replace the subject it came from';

/** The one sentence that says what the currently selected mode will do. */
const MODE_EFFECT: Readonly<Record<ImportMode, string>> = {
  copy:
    'A new subject is added to this device with a new internal id. Nothing that is already here is replaced, removed, or changed.',
  replace:
    'The subject this backup came from is destroyed on this device and replaced by what the file holds, with its internal id kept. Everything this device had is still kept as a whole copy, so you can go back to it.',
};

function countOf(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ── The component ──────────────────────────────────────────────────────────

export interface SubjectBackupTabProps {
  /**
   * Called after a subject import has activated a new generation.
   *
   * Distinct from the device tab's `onRestored` on purpose. A whole-device restore
   * navigates the Welcome screen to the subject list, because the learner has just
   * replaced everything and wants to see it. A subject import must **not**: the
   * outcome report carries the disclosures that decide whether the import was a
   * good idea, and navigating away unmounts the surface carrying them. So this
   * only refreshes the list, and the learner stays where they are.
   */
  readonly onSubjectImported?: (() => void) | null;
}

export function SubjectBackupTab({ onSubjectImported = null }: SubjectBackupTabProps): JSX.Element {
  const activeSubjectId = useSessionStore((state) => state.activeSubjectId);

  const introId = useId();
  const exportHeadingId = useId();
  const pickerId = useId();
  const pickerHelpId = useId();
  const importHeadingId = useId();
  const modeGroupId = useId();
  const modeEffectId = useId();
  const replaceReasonId = useId();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inspectButtonRef = useRef<HTMLButtonElement | null>(null);
  const copyRadioRef = useRef<HTMLInputElement | null>(null);
  const replaceRadioRef = useRef<HTMLInputElement | null>(null);

  // ── The device's own subjects ──
  //
  // `null` from `readLiveDevice` is the honest answer for a build on legacy
  // storage, so it is stored as "not available" rather than as an empty list: a
  // learner on such a build must be told the app cannot read its own subjects
  // here, not shown a picker with nothing in it.
  const [deviceSubjects, setDeviceSubjects] = useState<readonly DeviceSubject[]>([]);
  const [deviceReadable, setDeviceReadable] = useState<boolean | null>(null);

  // ── Export ──
  const [pickedSubjectId, setPickedSubjectId] = useState<string>('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportFailure, setExportFailure] = useState<string | null>(null);

  // ── Inspection ──
  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [chosenBytes, setChosenBytes] = useState<Uint8Array | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [archiveSubjectId, setArchiveSubjectId] = useState<string | null>(null);
  const [inspectionMessage, setInspectionMessage] = useState<string | null>(null);
  const [inspectionFailure, setInspectionFailure] = useState<FailureReport | null>(null);

  // ── Mode ──
  const [mode, setMode] = useState<ImportMode>('copy');

  // ── Import ──
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [subjectOutcome, setSubjectOutcome] = useState<SubjectImportOutcome | null>(null);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const dismissOutcome = useCallback(() => setSubjectOutcome(null), []);

  /**
   * Read this device's subjects, and say whether the read was possible at all.
   *
   * Called on mount, after an export (so a picker built before the app finished
   * booting catches up), and after an inspection (because whether a replace is
   * possible depends on the answer).
   */
  const loadDeviceSubjects = useCallback(async (): Promise<readonly DeviceSubject[] | null> => {
    try {
      const live = await readLiveDevice();
      if (live === null) {
        setDeviceReadable(false);
        return null;
      }
      const found = await readDeviceSubjects(live.repository, live.generationId);
      setDeviceSubjects(found);
      setDeviceReadable(true);
      return found;
    } catch {
      setDeviceReadable(false);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await loadDeviceSubjects();
      if (cancelled || found === null || found.length === 0) return;
      // Preselect the subject the learner is currently working in, because that is
      // overwhelmingly the one they want to back up. Falling back to the device's
      // own first entry keeps the button enabled rather than leaving a learner to
      // discover the picker.
      setPickedSubjectId((current) => {
        if (current !== '' && found.some((subject) => subject.subjectId === current)) return current;
        if (activeSubjectId !== null && found.some((subject) => subject.subjectId === activeSubjectId)) {
          return activeSubjectId;
        }
        return (found[0] as DeviceSubject).subjectId;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSubjectId, loadDeviceSubjects]);

  // ── Which subject a replace would destroy ──
  //
  // The product's contract: a replace target must equal the archive's own subject
  // id and must exist on this device. So the only subject a replace can destroy is
  // the one the backup was made from, and only while this device still has it.
  const replaceTarget: DeviceSubject | null = useMemo(() => {
    if (archiveSubjectId === null) return null;
    return deviceSubjects.find((subject) => subject.subjectId === archiveSubjectId) ?? null;
  }, [archiveSubjectId, deviceSubjects]);

  const replaceAvailable = replaceTarget !== null;
  const replaceRefusal: string | null = useMemo(() => {
    if (archiveSubjectId === null) {
      return 'Choose a subject backup file first. Whether a file can replace anything is decided by the file itself.';
    }
    if (replaceTarget !== null) return null;
    return 'This backup is for a subject that is not on this device, so there is nothing here for it to replace. Making a copy is the only thing it can do.';
  }, [archiveSubjectId, replaceTarget]);

  /**
   * The one predicate that gates every destructive path.
   *
   * Read in the confirm handler as well as in the confirm button's `disabled`, so a
   * replace cannot be reached by a stale render, a synthetic click on a disabled
   * control, or anything else that gets to the handler without going through the
   * button.
   */
  const replaceReady = mode === 'replace' && replaceTarget !== null && chosenBytes !== null;

  // ── Export: take one subject's backup ──
  const handleDownloadSubject = useCallback(async () => {
    if (pickedSubjectId === '') return;
    setExporting(true);
    setExportFailure(null);
    setExportMessage('Reading that one subject from this device.');
    try {
      const live = await readLiveDevice();
      if (live === null) {
        setExportMessage(null);
        setExportFailure(
          'This build is not keeping its data in the versioned store a subject backup reads from, so there is nothing here to back up.',
        );
        return;
      }
      const product = await import('@/services/persistence/products/subjectBackup');
      // Only this subject's own attachment ids are resolved, so the device-local
      // resolver is asked for those bytes and not for the whole device's.
      const attachmentIds = await readDeviceSubjectAttachmentIds(
        live.repository,
        live.generationId,
        pickedSubjectId,
      );
      const result = await product.exportSubjectBackup({
        repository: live.repository,
        generationId: live.generationId,
        subjectId: pickedSubjectId,
        now: new Date().toISOString(),
        payloadBytes: await product.resolveDeviceLocalPayloadBytes(attachmentIds),
      });
      // The product's constant file name. A subject name never reaches it.
      downloadBackupFile(result.bytes, result.fileName);
      const report = toSubjectExportReport(result);
      setExportMessage(
        `Saved ${report.fileName} to this device: ${report.byteLength} bytes, ` +
          `${countOf(report.roomCount, 'room', 'rooms')}.` +
          (report.externalOnlyCount === 0
            ? ' Every image in it is included.'
            : ` ${countOf(
                report.externalOnlyCount,
                'image is',
                'images are',
              )} not in it, because this device does not have those picture bytes.`),
      );
    } catch (error) {
      setExportMessage(null);
      setExportFailure(`The backup could not be made. The problem was reported as ${readFailure(error).code}.`);
    } finally {
      setExporting(false);
    }
  }, [pickedSubjectId]);

  // ── Inspection ──
  const handleFileChosen = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Cleared so choosing the same file twice in a row still raises `change`.
      event.target.value = '';
      if (file === undefined) return;

      // Focus moves to the control that will be restored to when the dialog closes,
      // before the dialog exists: `useModalFocus` restores to whatever had focus
      // when it opened, and a hidden file input the learner never focused is not
      // it.
      inspectButtonRef.current?.focus();

      setFileName(file.name);
      setChosenBytes(null);
      setPreview(null);
      setArchiveSubjectId(null);
      setInspectionFailure(null);
      setInspectionMessage('Reading the file you chose.');
      setSubjectOutcome(null);
      setReading(true);
      // The default mode is re-asserted on every file choice, so a destructive
      // selection can never survive from one file to the next, whatever left it
      // that way.
      setMode('copy');
      // Opened from the act of choosing a file, and it carries a confirm control
      // that is disabled until the read finishes. That is what makes the import
      // unreachable by any other route.
      setDialogOpen(true);

      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const product = await import('@/services/persistence/products/subjectBackup');
          const inspection = product.inspectSubjectArchive(bytes);
          if (!inspection.ok) {
            setChosenBytes(null);
            setPreview(null);
            setDialogOpen(false);
            setInspectionMessage(null);
            setInspectionFailure({ code: inspection.error.code, details: inspection.error.details });
            return;
          }
          setChosenBytes(bytes);
          setPreview(toBackupPreview(inspection.preview));

          // Which subject this archive holds. The preview has no subject field, and
          // the one place an id does appear in it - a per-image disclosure - is not
          // a subject lookup and is empty for a complete archive. So the read that
          // decides whether a replace is possible asks the contents type, which
          // answers for every archive. See the header for the full reasoning and for
          // the cost. Nothing from the contents object is rendered.
          let subjectId: string | null = null;
          try {
            subjectId = product.readSubjectArchiveContents(bytes).subjectId;
          } catch {
            // The archive passed inspection, so this is not a refusal; a failure
            // here is treated as "not replaceable", which is the safe direction,
            // and the reason is still shown to the learner.
            subjectId = null;
          }
          setArchiveSubjectId(subjectId);

          const found = await loadDeviceSubjects();
          const deviceHasIt =
            subjectId !== null &&
            found !== null &&
            found.some((subject) => subject.subjectId === subjectId);
          const missingImages = inspection.preview.externalOnlyCount;
          setInspectionMessage(
            missingImages === 0
              ? deviceHasIt
                ? 'Read the file. Everything in it can be brought in, and this device already has the subject it came from.'
                : 'Read the file. Everything in it can be brought in as a new subject.'
              : `Read the file. ${countOf(missingImages, 'image cannot', 'images cannot')} be brought back, and the window says why.`,
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
    },
    [loadDeviceSubjects],
  );

  // ── Import ──
  const handleConfirm = useCallback(async () => {
    if (chosenBytes === null) return;
    const chosenMode = mode;
    // The destructive branch is gated here, inside the handler, and not only in
    // the confirm button's `disabled` attribute.
    if (chosenMode === 'replace' && !replaceReady) return;
    setImporting(true);
    try {
      const live = await readLiveDevice();
      if (live === null) {
        setDialogOpen(false);
        setSubjectOutcome({
          kind: 'failure',
          report: { code: 'NO_ACTIVE_GENERATION', details: { reason: 'no-versioned-store-on-this-device' } },
        });
        return;
      }
      const product = await import('@/services/persistence/products/subjectBackup');
      // The request the product's own type declares, plus the two fields only a
      // replace needs. In copy mode neither is sent, so the product takes its own
      // default and there is no `replace` anywhere in the call for it to honour.
      const result = await product.importSubjectBackup({
        repository: live.repository,
        bytes: chosenBytes,
        now: new Date().toISOString(),
        ...(chosenMode === 'replace' && replaceTarget !== null
          ? {
              mode: 'replace' as const,
              replaceSubjectId: replaceTarget.subjectId,
              confirmReplace: true,
            }
          : {}),
      });
      setDialogOpen(false);
      setSubjectOutcome({ kind: 'subject-success', result: toSubjectImportReport(result) });
      await loadDeviceSubjects();
      onSubjectImported?.();
    } catch (error) {
      setDialogOpen(false);
      setSubjectOutcome({ kind: 'failure', report: readFailure(error) });
    } finally {
      setImporting(false);
    }
  }, [chosenBytes, mode, replaceReady, replaceTarget, loadDeviceSubjects, onSubjectImported]);

  /**
   * Arrow keys move between the two modes, as a radio group must.
   *
   * A native radio group already does this in every browser, and this handler
   * exists because `replace` is conditionally `disabled`: a group whose only other
   * member is unavailable needs the movement to be unambiguous, and a group
   * rendered inside a dialog-less, script-driven screen is exactly the case where
   * relying on the native behaviour to skip a disabled member is a thing to state
   * rather than assume. The result matches the native one, so the handler and the
   * browser agree rather than fight.
   */
  const handleModeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (mode === 'copy' && replaceAvailable) {
        setMode('replace');
        replaceRadioRef.current?.focus();
        return;
      }
      setMode('copy');
      copyRadioRef.current?.focus();
    },
    [mode, replaceAvailable],
  );

  const externalOnlyCount = preview?.externalOnlyCount ?? 0;
  const hasSubjects = deviceSubjects.length > 0;

  const pickerHelp = ((): string => {
    if (deviceReadable === null) return 'Reading the subjects on this device.';
    if (deviceReadable === false) {
      return 'This build is not keeping its data in the versioned store this tab reads from, so the subjects on this device cannot be listed here. Use the full device backup tab instead.';
    }
    if (!hasSubjects) return 'There is no subject on this device to back up yet. Create one first, then come back.';
    return 'The subject names come from this device. The saved file is always called the same thing, so a subject name never reaches a file name.';
  })();

  return (
    <>
      <section className="kd-block" aria-labelledby={introId}>
        <h3 className="kd-subheading" id={introId}>
          One subject at a time
        </h3>
        <p className="kd-lede">
          A subject backup is one file with one subject in it: its rooms and how far you have got through them,
          your study sessions, your fish, the images whose data is on this device, and your notes. It is
          written straight to this device, and it leaves out your settings, your keyboard shortcuts, and every
          other subject. Use the full device backup tab for all of that.
        </p>
        <ul className="kd-bullets">
          <li>
            Making a copy is the normal way to bring one in. It adds a new subject and changes nothing that is
            already here, so a backup from another device is safe to try.
          </li>
          <li>
            Replacing is for putting a subject back the way it was. It destroys what this device has for that
            subject first, and it is only offered when the backup is for a subject this device already has.
          </li>
        </ul>
      </section>

      {/* ── Take one subject's backup ── */}
      <section className="kd-block" aria-labelledby={exportHeadingId}>
        <h3 className="kd-subheading" id={exportHeadingId}>
          Take one subject&apos;s backup
        </h3>
        <p className="kd-lede">Choose the subject, then save one file for it.</p>
        <div className="kd-field">
          <label className="kd-field-label" htmlFor={pickerId}>
            Subject to back up
          </label>
          <select
            id={pickerId}
            className="kd-select"
            value={pickedSubjectId}
            aria-describedby={pickerHelpId}
            onChange={(event) => setPickedSubjectId(event.target.value)}
            disabled={exporting || !hasSubjects}
          >
            {hasSubjects ? (
              deviceSubjects.map((subject) => (
                <option key={subject.subjectId} value={subject.subjectId}>
                  {subject.name} — {countOf(subject.roomCount, 'room', 'rooms')}
                </option>
              ))
            ) : (
              <option value="">{deviceReadable === false ? 'This device cannot be read here' : 'No subjects yet'}</option>
            )}
          </select>
          <p className="kd-field-help" id={pickerHelpId}>
            {pickerHelp}
          </p>
        </div>
        <div className="kd-actions">
          <button
            type="button"
            className="kd-button kd-button--primary"
            onClick={() => void handleDownloadSubject()}
            disabled={exporting || pickedSubjectId === ''}
            aria-busy={exporting || undefined}
          >
            {exporting ? 'Making the backup…' : 'Download this subject'}
          </button>
        </div>
        <p className="kd-status" data-kd-surface="subject-export-status" role="status" aria-live="polite">
          {exportMessage}
        </p>
        {exportFailure === null ? null : (
          <p className="kd-problem" data-kd-surface="subject-export-problem" role="alert">
            <span className="kd-marker" aria-hidden="true">
              !
            </span>
            {exportFailure}
          </p>
        )}
      </section>

      {/* ── Bring one in ── */}
      <section className="kd-block" aria-labelledby={importHeadingId}>
        <h3 className="kd-subheading" id={importHeadingId}>
          Bring a subject backup in
        </h3>
        <p className="kd-lede">
          Choose a file and read what is in it before anything changes. Nothing is written to this device until
          you confirm in the window that opens.
        </p>
        <div className="kd-actions">
          <button
            type="button"
            ref={inspectButtonRef}
            className="kd-button kd-button--primary"
            onClick={openFilePicker}
            disabled={importing}
          >
            Choose a subject backup file
          </button>
          {preview === null ? null : (
            <button type="button" className="kd-button" onClick={openFilePicker} disabled={importing}>
              Choose a different file
            </button>
          )}
          {/*
            The real file input. It is `hidden` rather than `display: none`-ed by a
            class for the same reason the device tab's is: the control the learner
            presses is a real button, so the input needs no accessible presence of
            its own, and a test can still set files on it. It carries no key
            handler, so an Enter keypress focused on it reaches nothing at all.
          */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".kdsubject,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => handleFileChosen(event)}
          />
        </div>
        <p
          className="kd-status"
          data-kd-surface="subject-inspection-status"
          role="status"
          aria-live="polite"
        >
          {inspectionMessage}
        </p>
        {inspectionFailure === null ? null : (
          <div className="kd-problem-block" data-kd-surface="subject-inspection-problem" role="alert">
            <p className="kd-problem">
              <span className="kd-marker" aria-hidden="true">
                !
              </span>
              This file cannot be used. Nothing on this device was changed.
            </p>
            <p className="kd-lede">
              It was reported as <span className="kd-mono">{inspectionFailure.code}</span>. A subject backup
              has to be a file this version of Knowledge Dungeon wrote, and this one is not one.
            </p>
          </div>
        )}

        <ImportPreview
          preview={preview}
          fileName={fileName}
          sections={SUBJECT_PREVIEW_SECTIONS}
          heading="What is in this file"
        />

        <RecoveryStatus
          outcome={subjectOutcome}
          busy={importing}
          onDismiss={dismissOutcome}
          pendingHeading={mode === 'replace' ? 'Replacing the subject' : 'Adding the copy'}
          pendingLine={
            mode === 'replace'
              ? 'Writing the file over the subject this device has. Nothing has been switched over yet.'
              : 'Writing a new subject from the file. Nothing on this device has been changed yet.'
          }
        />
      </section>

      {/* ── The explicit confirmation, for whichever mode is chosen ── */}
      <ConfirmDialog
        open={dialogOpen}
        surface="subject-import-confirmation"
        title={mode === 'replace' ? 'Replace this subject with the file?' : 'Add a copy of this subject?'}
        busy={importing}
        busyMessage={
          mode === 'replace'
            ? 'Replacing. The window stays open until it has finished.'
            : 'Adding the copy. The window stays open until it has finished.'
        }
        dismissLabel={mode === 'replace' ? 'Keep what is here' : 'Do not add anything'}
        confirmLabel={mode === 'replace' ? 'Replace the subject' : 'Add a copy of this subject'}
        confirmDisabled={chosenBytes === null || reading || (mode === 'replace' && !replaceReady)}
        onDismiss={closeDialog}
        onConfirm={() => void handleConfirm()}
      >
        {reading ? (
          <p className="kd-dialog-line">Reading the file you chose. Nothing has changed yet.</p>
        ) : (
          <>
            {/*
              ── The mode choice, inside the confirmation ──

              Deliberately here and not in the panel behind. A real browser run of
              this surface showed the alternative to be broken: the dialog is a
              modal layer, so it intercepts pointer events for everything behind
              it, and a mode chosen *outside* it was therefore a mode whose
              confirmation could never be seen. The choice belongs in the window
              that states what the chosen mode will do, and it puts the destructive
              option one focus-trapped step from the control that commits it.

              It also makes the default structural rather than incidental: the
              dialog opens on every file, `handleFileChosen` sets the mode to
              `copy`, and the copy radio is the one rendered `checked`. A learner
              has to press something to get to the other one.
            */}
            <fieldset
              className="kd-choices"
              data-kd-surface="subject-import-mode"
              aria-describedby={`${modeEffectId}${replaceRefusal === null ? '' : ` ${replaceReasonId}`}`}
            >
              <legend className="kd-choices-legend">What should this file do?</legend>
              <label className="kd-choice" htmlFor={`${modeGroupId}-copy`}>
                <input
                  id={`${modeGroupId}-copy`}
                  ref={copyRadioRef}
                  className="kd-choice-input"
                  type="radio"
                  name={`${modeGroupId}-mode`}
                  value="copy"
                  checked={mode === 'copy'}
                  onChange={() => setMode('copy')}
                  onKeyDown={handleModeKeyDown}
                />
                <span className="kd-choice-text">
                  <span className="kd-choice-name">{COPY_MODE_NAME}</span>
                  <span className="kd-choice-note">
                    {mode === 'copy' ? 'Chosen. Nothing is replaced.' : 'Adds a new subject and changes nothing else.'}
                  </span>
                </span>
              </label>
              <label className="kd-choice" htmlFor={`${modeGroupId}-replace`}>
                <input
                  id={`${modeGroupId}-replace`}
                  ref={replaceRadioRef}
                  className="kd-choice-input"
                  type="radio"
                  name={`${modeGroupId}-mode`}
                  value="replace"
                  checked={mode === 'replace'}
                  disabled={!replaceAvailable}
                  onChange={() => setMode('replace')}
                  onKeyDown={handleModeKeyDown}
                />
                <span className="kd-choice-text">
                  <span className="kd-choice-name">{REPLACE_MODE_NAME}</span>
                  <span className="kd-choice-note">
                    {mode === 'replace'
                      ? 'Chosen. This one destroys a subject.'
                      : replaceAvailable
                        ? `Destroys the subject this file came from. It is named in the window below.`
                        : 'Not available for this file.'}
                  </span>
                </span>
              </label>
              {/*
                The selected mode's effect, in words, in a polite live region. The
                radio's own dot is a shape rather than a colour, and this is the
                channel that states the state as a sentence - so nothing here
                depends on telling two colours apart.
              */}
              <p className="kd-choices-effect" id={modeEffectId} role="status" aria-live="polite">
                <span className="kd-marker" aria-hidden="true">
                  ▸
                </span>
                {mode === 'replace' ? REPLACE_MODE_NAME : COPY_MODE_NAME}. {MODE_EFFECT[mode]}
              </p>
              {replaceRefusal === null ? null : (
                <p className="kd-choices-refusal" id={replaceReasonId}>
                  {replaceRefusal}
                </p>
              )}
            </fieldset>

            {mode === 'replace' ? (
              <ul className="kd-bullets">
                <li>
                  {/* The one place a subject name is rendered outside the picker, and
                      the reason the plan requires it: the learner has to be told
                      which subject is about to be destroyed, by the name they know
                      it by. Read from this device's own record, never from the
                      file. */}
                  <strong className="kd-dialog-subject">
                    {replaceTarget === null ? 'The subject' : replaceTarget.name}
                  </strong>{' '}
                  on this device is destroyed and replaced by what this file holds. Its rooms, its progress, its
                  study sessions, and its images all go.
                </li>
                <li>
                  Everything that was here is kept as a whole, so you can go back to it if this is the wrong
                  file. Replacing one subject does not take the rest of the device with it.
                </li>
                <li>
                  The subject keeps its internal id, so anything that referred to it before still refers to it
                  after.
                </li>
                {externalOnlyCount === 0 ? null : (
                  <li>
                    {countOf(externalOnlyCount, 'image in this file has', 'images in this file have')} no picture
                    data and will come back without {externalOnlyCount === 1 ? 'it' : 'them'}. The full reason
                    is in the list above.
                  </li>
                )}
              </ul>
            ) : (
              <ul className="kd-bullets">
                <li>
                  A new subject is added to this device with a new internal id. Nothing that is already here is
                  replaced, removed, or changed, and a subject you already had with the same rooms stays exactly
                  as it was.
                </li>
                <li>
                  Every id inside the file is rewritten, so the copy shares nothing with the subject the backup
                  came from and the two can be worked on independently.
                </li>
                <li>Nothing on this device is destroyed by this.</li>
                {externalOnlyCount === 0 ? null : (
                  <li>
                    {countOf(externalOnlyCount, 'image in this file has', 'images in this file have')} no
                    picture data and will be listed without {externalOnlyCount === 1 ? 'it' : 'them'}. The full
                    reason is in the list above.
                  </li>
                )}
              </ul>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

/**
 * The product's sanitized preview, shaped as this tab renders it.
 *
 * The declared shape is `ImportPreview`'s, not the product's, for the reason that
 * component's header gives: the product tree is reachable only through a lazy
 * `import()`, so the surface declares what it renders and the tab adapts. The
 * field-for-field copy below is deliberate - a `SubjectArchivePreview` really does
 * carry all of it - and `tests/unit/subjectBackupTab.test.tsx` asserts at compile
 * time that the product's real preview still satisfies {@link BackupPreview}, so
 * the two cannot drift apart silently.
 */
function toBackupPreview(preview: SubjectPreview): BackupPreview {
  return {
    formatVersion: preview.formatVersion,
    storageGenerationFormatVersion: preview.storageGenerationFormatVersion,
    subjectSchemaVersion: preview.subjectSchemaVersion,
    createdAt: preview.createdAt,
    manifestCreatedAt: preview.manifestCreatedAt,
    memberCount: preview.memberCount,
    totalMemberCount: preview.totalMemberCount,
    totalBytes: preview.totalBytes,
    recordCounts: preview.recordCounts,
    attachmentBytes: preview.attachmentBytes,
    externalOnlyAttachments: preview.externalOnlyAttachments,
    externalOnlyCount: preview.externalOnlyCount,
  };
}
