/**
 * Phase 7: the template tab of the Data Center, and the cutover of the leaking
 * legacy template path.
 *
 * This component is the whole of the learner-facing `.kdtemplate` surface. It is
 * the third tab of the Data Center, it is the only route to a template, and the
 * pre-Phase-7 path in `subjectPersistence.ts` - which leaked room ids, attachment
 * metadata, filenames, the subject's own name, and an ambient clock into a
 * `.template.json` file - has no caller left in the application. The legacy
 * functions themselves are retained, untouched, as plan section 7's rollback line
 * requires; what is retired is the call site.
 *
 * ## The format, in one sentence, because the copy depends on it
 *
 * A `.kdtemplate` is **one JSON document**, not an archive. There is no ZIP, no
 * member layout, and no file-inspection step: eight declared top-level keys, a
 * `graph` sub-document, and rooms addressed by array index rather than by
 * identifier - which is *why* the format cannot contain an original id. So this
 * tab has no "how big is the archive, and which members are in it" step, and no
 * archive-shaped preview to render.
 *
 * ## The approval model, and why the copy is written the way it is
 *
 * The product is frictionless about structure and deliberate about tags, and this
 * tab is shaped to make that legible rather than to hide it:
 *
 * - **Topics always go in.** Plan section 7.3 lists room topics unconditionally, and
 *   a template without them is not a template. The room list is therefore shown
 *   *before* the download button is pressed, and the copy says plainly that a topic
 *   is text the learner wrote and that anyone holding the file can read it. The tab
 *   must not imply a template is private or anonymous: the topics are the payload.
 * - **Tags go in only if ticked.** `approvedTags` is a parameter with no default
 *   that can supply itself, absent means empty, and the exporter never reads a tag
 *   out of a snapshot. So the tag boxes are rendered **unticked**, and the export
 *   request literally omits the `approvedTags` key when nothing is ticked. After the
 *   download, the status line reports the product's returned `approvedTags` - the
 *   exact list that is in the file - rather than claiming "tags were included".
 * - **A biome goes in only if ticked.** The exporter does not read the subject's
 *   biome, so the value offered is this device's own and the decision is the
 *   learner's.
 *
 * A tag is only written on the rooms that already carry it: the exporter
 * intersects each room's tags with the approved list, so ticking a tag cannot pull
 * it onto a room that does not have it.
 *
 * ## What this tab never does
 *
 * No renderer, no network, no analytics, no upload endpoint, no share, no second
 * copy of the local download: the bytes reach the learner through
 * `productAccess.downloadBackupFile`, which is the Data Center tree's single
 * `createObjectURL` call site and the one `tests/data/localDownloadOnly.test.ts`
 * pins. The file name is the product's constant `SUBJECT_TEMPLATE_FILE_NAME`,
 * handed straight through - never a subject name, never a template name, never a
 * timestamp - which is plan section 12, rule 6, and the specific violation the
 * retired call site committed.
 *
 * The product is reached only by a lazy `import()` of a string literal, and every
 * type from it through a type-position `import()` that TypeScript erases.
 * `tests/data/templateProductBoundary.test.ts` pins the caller set.
 *
 * ## Why the import does not navigate
 *
 * An import creates a subject that is *waiting to be edited*, and the learner most
 * needs to be told what arrived before they go and change it. So the report stays
 * on screen, and the control that goes to the Create tab is rendered **inside** the
 * report through `RecoveryStatus`'s `action` slot: the learner presses it after
 * reading, and this surface never navigates on its own. The report's central
 * sentence - that every room landed blank, in the Create state - is a **measurement**
 * read back from the device record the product wrote, not a restatement of the
 * product's documentation. If the read-back cannot find the subject, the surface
 * says so and claims only what the result itself licenses.
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
} from 'react';

import { useSessionStore } from '@/store/sessionStore';
import { formatInstant } from './ImportPreview';
import { RecoveryStatus, type TemplateImportOutcome, type TemplateImportReport } from './RecoveryStatus';
import { ConfirmDialog } from './ConfirmDialog';
import {
  downloadBackupFile,
  readDeviceSubjects,
  readDeviceTemplateLanding,
  readDeviceTemplateSource,
  readFailure,
  readLiveDevice,
  type DeviceRepository,
  type DeviceSubject,
  type DeviceTemplateSource,
  type FailureReport,
} from './productAccess';

// ── The product, reached only lazily ───────────────────────────────────────

/**
 * The product's own types, through two erased `import()` expressions.
 *
 * A type-position `import()` produces no runtime import, so this costs a
 * flag-off build nothing, and it stops this file compiling the moment the product
 * renames a field rather than rendering a field that is no longer there. The
 * product is reached separately, at the point of use, by a value `import()` of a
 * string literal.
 */
type TemplateProduct = typeof import('@/services/persistence/products/subjectTemplate');
type ProductTemplatePreview = Awaited<ReturnType<TemplateProduct['readSubjectTemplate']>>['preview'];
type ProductTemplateImportResult = Awaited<ReturnType<TemplateProduct['importSubjectTemplate']>>;

/** The extension the picker accepts, which the product declares as a constant. */
const TEMPLATE_ACCEPT = '.kdtemplate,application/json';

/**
 * How many room topics the export list renders.
 *
 * A cap, and not a truncation that hides the fact: the count above the list is
 * always the subject's real room count, and the line under the list says exactly how
 * many are not shown. The product accepts up to 4096 rooms, and a list of 4096 rows
 * is a page nobody can use on a phone, so a bounded list plus a stated remainder is
 * the honest shape. Everything the learner approves - the tags - is presented in
 * full regardless, because a tag list nobody can see is a tag nobody can approve.
 *
 * The list is ordered root-first by `readDeviceTemplateSource`, and that is what makes
 * the bound safe rather than merely honest: a bound drops the tail, and the tail is
 * where the leaves are. Ordering by topic alone would have put the root room last and
 * dropped it first on any subject of a few hundred rooms - the one topic a learner most
 * needs to see before sharing a file.
 */
const TOPIC_LIST_LIMIT = 200;

// ── The port this surface renders ──────────────────────────────────────────

/**
 * The sanitized view of a `.kdtemplate`: everything the import side may show.
 *
 * Declared here rather than imported, for the reason `ImportPreview` declares its
 * own: the product tree is reachable only through a lazy `import()`, so the surface
 * declares the shape it renders and the tab adapts the product's value to it.
 * `tests/unit/subjectTemplateTab.test.tsx` asserts at compile time that the
 * product's real preview still satisfies this, so the two cannot drift apart
 * silently.
 *
 * There is **no** room topic, no tag, no template name, and no description here, and
 * their absence is the point: this half of the tab reads a file the application did
 * not write, and everything below reaches a status line that can be copied. The
 * product's own preview enforces the same rule by carrying counts and booleans
 * instead of values, and the two agree by construction.
 */
export interface TemplatePreview {
  readonly product: string;
  readonly formatVersion: number;
  readonly storageGenerationFormatVersion: number;
  readonly subjectSchemaVersion: string;
  readonly createdAt: string;
  readonly roomCount: number;
  readonly structureEdgeCount: number;
  readonly crossLinkCount: number;
  readonly approvedTagCount: number;
  readonly hasBiome: boolean;
  readonly hasName: boolean;
  readonly hasDescription: boolean;
  readonly fileName: string;
}

// ── The identifier source the product is handed ────────────────────────────

let mintedCounter = 0;

/**
 * A fresh identifier for the product to mint a subject and its rooms from.
 *
 * The product takes its identifier source as a **required parameter** and reads no
 * clock and no random source itself, which is what makes "two imports create
 * independent subjects" testable without a wall clock. The consequence for a
 * screen is that the caller must own an id source, and this function is that source:
 * `crypto.randomUUID` where it exists, and a monotonic counter over a clock reading
 * where it does not, so two ids are still distinct within a session. The pattern is
 * the one `src/services/persistence/v2/attachmentBytes.ts` already uses for
 * attachment ids, and it is written out here rather than imported because that
 * module is a storage-v2 seam this tree is not allowed to name.
 *
 * The value is opaque. The product re-checks every candidate anyway - it must be a
 * non-empty string, must not be a prototype member name, and must be free on this
 * device - so nothing here is trusted, and a generator that repeats forever is
 * refused by the product rather than producing two subjects that share an id.
 */
export function createTemplateIdGenerator(): { next(): string } {
  return {
    next(): string {
      const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
      if (typeof globalCrypto?.randomUUID === 'function') return globalCrypto.randomUUID();
      mintedCounter += 1;
      return `${Date.now().toString(36)}-${mintedCounter.toString(36).padStart(4, '0')}`;
    },
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

function countOf(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toTemplatePreview(preview: ProductTemplatePreview): TemplatePreview {
  return {
    product: preview.product,
    formatVersion: preview.formatVersion,
    storageGenerationFormatVersion: preview.storageGenerationFormatVersion,
    subjectSchemaVersion: preview.subjectSchemaVersion,
    createdAt: preview.createdAt,
    roomCount: preview.roomCount,
    structureEdgeCount: preview.structureEdgeCount,
    crossLinkCount: preview.crossLinkCount,
    approvedTagCount: preview.approvedTagCount,
    hasBiome: preview.hasBiome,
    hasName: preview.hasName,
    hasDescription: preview.hasDescription,
    fileName: preview.fileName,
  };
}

/**
 * The sentence that states the tags actually in the file.
 *
 * A **measurement** of the product's returned `approvedTags`, which is the exact
 * normalised list in the document - not a claim that a learner approved anything,
 * and not a count. The empty case is stated as its own sentence, because "the file
 * carries no tags, because you ticked none" is the sentence that tells a learner the
 * approval step is real.
 */
function approvedTagsLine(tags: readonly string[]): string {
  if (tags.length === 0) {
    return 'It carries no tags at all, because none were approved.';
  }
  return `It carries these ${countOf(tags.length, 'approved tag', 'approved tags')}: ${tags.join(', ')}.`;
}

export interface SubjectTemplateTabProps {
  /**
   * Called after a template import has added a subject, so a host can refresh its
   * list.
   *
   * Refresh only. The report that follows an import is the surface carrying the
   * disclosures, and unmounting it is the one thing that would take those away, so
   * this never navigates.
   */
  readonly onTemplateImported?: (() => void) | null;
  /**
   * Called when the learner asks to go and edit the subject an import created.
   *
   * Explicit, and never automatic: the button lives in the outcome report, so the
   * press is a decision made after the report has been read. The id is this
   * device's own opaque handle, handed straight back to the host.
   */
  readonly onOpenSubject?: ((subjectId: string) => void) | null;
}

export function SubjectTemplateTab({
  onTemplateImported = null,
  onOpenSubject = null,
}: SubjectTemplateTabProps): JSX.Element {
  const activeSubjectId = useSessionStore((state) => state.activeSubjectId);

  const introId = useId();
  const privacyId = useId();
  const exportHeadingId = useId();
  const pickerId = useId();
  const pickerHelpId = useId();
  const roomsId = useId();
  const tagGroupId = useId();
  const tagHelpId = useId();
  const nameFieldId = useId();
  const descriptionFieldId = useId();
  const importHeadingId = useId();
  const destinationId = useId();
  const destinationHelpId = useId();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inspectButtonRef = useRef<HTMLButtonElement | null>(null);

  // ── This device's subjects ──
  const [deviceSubjects, setDeviceSubjects] = useState<readonly DeviceSubject[]>([]);
  const [deviceReadable, setDeviceReadable] = useState<boolean | null>(null);

  // ── Export ──
  const [pickedSubjectId, setPickedSubjectId] = useState('');
  const [source, setSource] = useState<DeviceTemplateSource | null>(null);
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set<string>());
  const [includeBiome, setIncludeBiome] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [description, setDescription] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportFailure, setExportFailure] = useState<string | null>(null);

  // ── Import ──
  const [reading, setReading] = useState(false);
  const [chosenName, setChosenName] = useState<string | null>(null);
  const [chosenTemplate, setChosenTemplate] = useState<string | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [inspectionMessage, setInspectionMessage] = useState<string | null>(null);
  const [inspectionFailure, setInspectionFailure] = useState<FailureReport | null>(null);
  const [destinationName, setDestinationName] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [templateOutcome, setTemplateOutcome] = useState<TemplateImportOutcome | null>(null);
  const [importedSubjectId, setImportedSubjectId] = useState<string | null>(null);

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const dismissOutcome = useCallback(() => {
    setTemplateOutcome(null);
    setImportedSubjectId(null);
  }, []);

  // ── Reading this device ──
  //
  // `readLiveDevice` is asked for the live handle on every path that needs one,
  // rather than cached in state: the Data Center must not hold a repository handle
  // across renders, and a cached one would go stale the moment a restore changed
  // which generation is active.
  const noteDeviceUnreadable = useCallback((): void => {
    setDeviceReadable(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const live = await readLiveDevice();
        if (cancelled) return;
        if (live === null) {
          noteDeviceUnreadable();
          return;
        }
        const found = await readDeviceSubjects(live.repository, live.generationId);
        if (cancelled) return;
        setDeviceReadable(true);
        setDeviceSubjects(found);
        // Preselect only when there is something to preselect. A device with no subject
        // is the ordinary first-run state, and `found[0]` on an empty list is a crash
        // rather than an empty picker - found by a browser measurement of this tab on a
        // fresh profile, which is the only place that state occurs.
        if (found.length === 0) {
          setPickedSubjectId('');
          return;
        }
        setPickedSubjectId((current) => {
          if (current !== '' && found.some((subject) => subject.subjectId === current)) return current;
          if (activeSubjectId !== null && found.some((subject) => subject.subjectId === activeSubjectId)) {
            return activeSubjectId;
          }
          return (found[0] as DeviceSubject).subjectId;
        });
      } catch {
        if (!cancelled) noteDeviceUnreadable();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSubjectId, noteDeviceUnreadable]);

  // ── The chosen subject's own rooms, tags, and biome ──
  //
  // Re-read whenever the choice changes. The tag approval is **reset** on every
  // change of subject, for the same reason the subject tab resets its import mode:
  // an approval is a decision about one subject, and a decision that silently
  // survived onto a different subject would be a decision nobody made.
  useEffect(() => {
    let cancelled = false;
    setApproved(new Set<string>());
    setIncludeBiome(false);
    if (pickedSubjectId === '') {
      setSource(null);
      return undefined;
    }
    void (async () => {
      try {
        const live = await readLiveDevice();
        if (live === null || cancelled) {
          setSource(null);
          return;
        }
        const found = await readDeviceTemplateSource(live.repository, live.generationId, pickedSubjectId);
        if (cancelled) return;
        setSource(found);
      } catch {
        if (!cancelled) setSource(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickedSubjectId]);

  /**
   * The distinct tags the chosen subject already carries, sorted.
   *
   * Deduplicated across every room, which is not tidiness: the product **refuses** a
   * duplicate approved tag, and a tag on twelve rooms would otherwise be sent twelve
   * times. A `Set` is therefore the minimum correct container, and the set is built
   * from the device's own stored strings, which the application already normalised
   * when it stored them.
   */
  const subjectTags: readonly string[] = useMemo(() => {
    const tags = new Set<string>();
    for (const room of source?.rooms ?? []) {
      for (const tag of room.tags) tags.add(tag);
    }
    return [...tags].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }, [source]);

  const approvedTags: readonly string[] = useMemo(
    () => subjectTags.filter((tag) => approved.has(tag)),
    [subjectTags, approved],
  );

  const toggleTag = useCallback((tag: string, ticked: boolean) => {
    setApproved((current) => {
      const next = new Set(current);
      if (ticked) next.add(tag);
      else next.delete(tag);
      return next;
    });
  }, []);

  // ── Export: make a template ──
  const handleDownloadTemplate = useCallback(async () => {
    if (source === null) return;
    setExporting(true);
    setExportFailure(null);
    setExportMessage('Building the template from the rooms on this device.');
    try {
      const product = await import('@/services/persistence/products/subjectTemplate');
      const trimmedName = templateName.trim();
      const trimmedDescription = description.trim();
      // The request is assembled by **omission**, not by sending empty values. An
      // absent `approvedTags` means none, and an absent `approvedBiome` means none,
      // so a learner who ticked nothing gets a request that literally cannot carry
      // a tag or a biome - which is the property the privacy gate measures, and the
      // reason this is four conditional spreads rather than four `?? null`s.
      const result = product.exportSubjectTemplate(source.snapshot, {
        now: new Date().toISOString(),
        ...(approvedTags.length > 0 ? { approvedTags: [...approvedTags] } : {}),
        ...(includeBiome && source.biome !== null ? { approvedBiome: source.biome } : {}),
        ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
        ...(trimmedDescription.length > 0 ? { description: trimmedDescription } : {}),
      });
      const bytes = new TextEncoder().encode(result.template);
      // The product's constant file name, handed straight through. No subject name,
      // no template name, no date.
      downloadBackupFile(bytes, result.fileName, 'application/json');
      setExportMessage(
        `Saved ${result.fileName} to this device: ${countOf(bytes.byteLength, 'byte', 'bytes')}, ` +
          `${countOf(result.roomCount, 'room', 'rooms')}, ${countOf(
            result.structureEdgeCount,
            'link',
            'links',
          )} between them` +
          (result.crossLinkCount === 0
            ? '.'
            : `, and ${countOf(result.crossLinkCount, 'sideways link', 'sideways links')}.`) +
          ` ${approvedTagsLine(result.approvedTags)}` +
          (result.approvedBiome === null ? '' : ' It carries the biome you approved.') +
          (result.roomCount > 0 ? ' Every room topic in it is in the list above.' : ''),
      );
    } catch (error) {
      setExportMessage(null);
      setExportFailure(`The template could not be made. The problem was reported as ${readFailure(error).code}.`);
    } finally {
      setExporting(false);
    }
  }, [source, approvedTags, includeBiome, source?.biome, templateName, description]);

  // ── Import: read a chosen file ──
  const handleFileChosen = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file twice in a row still raises `change`.
    event.target.value = '';
    if (file === undefined) return;

    // Focus moves to the control that will be restored to when the dialog closes,
    // before the dialog exists: `useModalFocus` restores to whatever had focus when
    // it opened, and a hidden file input the learner never focused is not it.
    inspectButtonRef.current?.focus();

    setChosenName(file.name);
    setChosenTemplate(null);
    setPreview(null);
    setInspectionFailure(null);
    setInspectionMessage('Reading the file you chose.');
    setTemplateOutcome(null);
    setImportedSubjectId(null);
    setDestinationName('');
    setReading(true);
    // Opened from the act of choosing a file, and it carries a confirm control that
    // is disabled until the read finishes. That is what makes an import unreachable
    // by any other route.
    setDialogOpen(true);

    void (async () => {
      try {
        // A `.kdtemplate` is a JSON document, so the file is read as text and there
        // is no archive to open, no member table, and no codec involved anywhere on
        // this path.
        const text = await file.text();
        const product = await import('@/services/persistence/products/subjectTemplate');
        const inspection = product.inspectSubjectTemplate(text);
        if (!inspection.ok) {
          setChosenTemplate(null);
          setPreview(null);
          setDialogOpen(false);
          setInspectionMessage(null);
          setInspectionFailure({ code: inspection.error.code, details: inspection.error.details });
          return;
        }
        setChosenTemplate(text);
        setPreview(toTemplatePreview(inspection.preview));
        setInspectionMessage(
          `Read the file. It is a blank skeleton of ${countOf(inspection.preview.roomCount, 'room', 'rooms')}` +
            `, and every room in it arrives empty.`,
        );
      } catch (error) {
        setChosenTemplate(null);
        setPreview(null);
        setDialogOpen(false);
        setInspectionMessage(null);
        setInspectionFailure(readFailure(error));
      } finally {
        setReading(false);
      }
    })();
  }, []);

  // ── Import: add it ──
  const handleConfirm = useCallback(async () => {
    const template = chosenTemplate;
    if (template === null) return;
    const trimmedDestination = destinationName.trim();
    setImporting(true);
    try {
      // The live handle is read here rather than held, so a restore between the
      // learner choosing the file and confirming cannot make this write into a
      // generation that is no longer the one the device is using.
      const live = await readLiveDevice();
      if (live === null) {
        setDialogOpen(false);
        setTemplateOutcome({
          kind: 'failure',
          report: { code: 'NO_ACTIVE_GENERATION', details: { reason: 'no-versioned-store-on-this-device' } },
        });
        return;
      }
      const product = await import('@/services/persistence/products/subjectTemplate');
      const result = await product.importSubjectTemplate({
        repository: live.repository,
        template,
        now: new Date().toISOString(),
        // The product takes its identifier source as a required parameter; see
        // `createTemplateIdGenerator` for why the screen owns it.
        generator: createTemplateIdGenerator(),
        ...(trimmedDestination.length > 0 ? { destinationSubjectName: trimmedDestination } : {}),
      });
      const report = await toTemplateReport(result, live.repository);
      setDialogOpen(false);
      setImportedSubjectId(result.subjectId);
      setTemplateOutcome({ kind: 'template-success', result: report });
      // Refresh the list so the export picker above sees the new subject, and so a
      // second import of the same file is offered against a device that holds the
      // first. The pick is moved onto the new subject when the current one is gone or
      // was never set, because a learner who has just brought a template in is very
      // likely to be about to share it, and a picker left on nothing is a picker with
      // a disabled button and no explanation. The report itself is not dismissed.
      const refreshed = await readDeviceSubjects(live.repository, result.generationId);
      setDeviceSubjects(refreshed);
      setPickedSubjectId((current) =>
        current !== '' && refreshed.some((subject) => subject.subjectId === current)
          ? current
          : result.subjectId,
      );
      onTemplateImported?.();
    } catch (error) {
      setDialogOpen(false);
      setTemplateOutcome({ kind: 'failure', report: readFailure(error) });
    } finally {
      setImporting(false);
    }
  }, [chosenTemplate, destinationName, onTemplateImported]);

  const hasSubjects = deviceSubjects.length > 0;
  const rooms = source?.rooms ?? [];
  const shownRooms = rooms.slice(0, TOPIC_LIST_LIMIT);
  const hiddenRoomCount = rooms.length - shownRooms.length;

  const pickerHelp = ((): string => {
    if (deviceReadable === null) return 'Reading the subjects on this device.';
    if (deviceReadable === false) {
      return 'This build is not keeping its data in the versioned store this tab reads from, so the subjects on this device cannot be listed here.';
    }
    if (!hasSubjects) return 'There is no subject on this device to make a template from yet. Create one first, then come back.';
    return 'The subject name comes from this device. The file is always called the same thing, so neither the subject name nor the template name can reach a file name.';
  })();

  return (
    <>
      {/* ── What a template is, and what it is not ── */}
      <section className="kd-block" aria-labelledby={introId}>
        <h3 className="kd-subheading" id={introId}>
          A blank template
        </h3>
        <p className="kd-lede">
          A template is the shape of a subject with the writing taken out: the room topics and how they link,
          and nothing else from your work. It is one small text file your browser writes to this device, and
          there is nowhere for it to be sent.
        </p>
        <section className="kd-privacy" aria-labelledby={privacyId}>
          <h4 className="kd-preview-subheading" id={privacyId}>
            Exactly what leaves the device
          </h4>
          <ul className="kd-bullets">
            <li>
              <strong>Every room topic always goes in.</strong> A topic is text you wrote, so anyone you give
              the file to can read it. This is the point of a template, and it is the one thing in the file
              that is yours whether you tick anything or not.
            </li>
            <li>
              <strong>Tags go in only if you tick them</strong> below. Unticking every box writes a template
              with no tags in it at all. A ticked tag is only written on the rooms that already have it.
            </li>
            <li>
              <strong>A biome goes in only if you tick it</strong>, and then it is the biome this subject
              already uses.
            </li>
            <li>
              A template never carries your notes, your drafts, your written artifacts, your images or their
              file names, your review history, your progress, your fish, your study sessions, your assistance
              history, or your settings.
            </li>
            <li>
              It never carries the internal ids your subject and its rooms have on this device, so the file
              cannot be traced back to it, and it cannot be added to a subject you already have.
            </li>
            <li>
              So it is not anonymous and it is not empty: it is your room topics, and any tag and biome you
              approve. Choose what you share by choosing a subject, and by ticking nothing.
            </li>
          </ul>
        </section>
      </section>

      {/* ── Make one ── */}
      <section className="kd-block" aria-labelledby={exportHeadingId}>
        <h3 className="kd-subheading" id={exportHeadingId}>
          Make a template from a subject
        </h3>
        <p className="kd-lede">
          Choose the subject, read what is in it, tick the tags you want to share, then save one file.
        </p>
        <div className="kd-field">
          <label className="kd-field-label" htmlFor={pickerId}>
            Subject to make a template from
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
              <option value="">
                {deviceReadable === false ? 'This device cannot be read here' : 'No subjects yet'}
              </option>
            )}
          </select>
          <p className="kd-field-help" id={pickerHelpId}>
            {pickerHelp}
          </p>
        </div>

        {/*
          The room list. Rendered before the button, and rendered at all, because a
          topic is the one thing the file always carries: a learner who cannot read
          the topics cannot make the share decision this product is built to support.
        */}
        <section className="kd-topics-block" aria-labelledby={roomsId} aria-busy={source === null && hasSubjects}>
          <h4 className="kd-preview-subheading" id={roomsId}>
            {source === null
              ? 'The rooms in this template'
              : `The ${countOf(rooms.length, 'room topic', 'room topics')} that always go in`}
          </h4>
          {source === null ? (
            <p className="kd-preview-note">
              {hasSubjects ? 'Reading the rooms on this device.' : 'Nothing to show yet.'}
            </p>
          ) : (
            <>
              <ul className="kd-topics">
                {shownRooms.map((room) => (
                  <li className="kd-topic" key={room.roomId}>
                    {room.topic}
                  </li>
                ))}
              </ul>
              {hiddenRoomCount > 0 ? (
                <p className="kd-preview-note">
                  {countOf(hiddenRoomCount, 'room topic is', 'room topics are')} not shown here to keep this
                  page usable. {countOf(rooms.length, 'room topic is', 'room topics are')} in the file.
                </p>
              ) : null}
            </>
          )}
        </section>

        <fieldset className="kd-choices" aria-describedby={tagHelpId}>
          <legend className="kd-choices-legend">Tags to include (optional)</legend>
          {subjectTags.length === 0 ? (
            <p className="kd-choices-refusal">
              This subject has no tags on any room, so there is nothing to tick. The template will be made
              with no tags in it.
            </p>
          ) : (
            subjectTags.map((tag) => (
              <label className="kd-choice" key={tag} htmlFor={`${tagGroupId}-${tag}`}>
                <input
                  id={`${tagGroupId}-${tag}`}
                  className="kd-choice-input"
                  type="checkbox"
                  checked={approved.has(tag)}
                  onChange={(event) => toggleTag(tag, event.target.checked)}
                />
                <span className="kd-choice-text">
                  <span className="kd-choice-name">{tag}</span>
                  <span className="kd-choice-note">
                    {approved.has(tag)
                      ? 'Ticked. This tag goes in the file, on the rooms that already have it.'
                      : 'Unticked. This tag stays on this device.'}
                  </span>
                </span>
              </label>
            ))
          )}
          <p className="kd-choices-effect" id={tagHelpId} role="status" aria-live="polite">
            <span className="kd-marker" aria-hidden="true">
              ▸
            </span>
            {subjectTags.length === 0
              ? 'No tags. The file carries none.'
              : approvedTags.length === 0
                ? 'Nothing ticked. The file will carry no tags at all.'
                : `${countOf(approvedTags.length, 'tag is', 'tags are')} approved for the file: ${approvedTags.join(', ')}.`}
          </p>
        </fieldset>

        {source === null || source.biome === null ? (
          <p className="kd-choices-refusal">
            {source === null
              ? 'The rooms are still being read, so there is nothing to offer yet.'
              : 'This subject has no biome preference set, so there is nothing to offer. The template will be made with no biome in it.'}
          </p>
        ) : (
          <label className="kd-choice kd-choice--single" htmlFor={`${tagGroupId}-biome`}>
            <input
              id={`${tagGroupId}-biome`}
              className="kd-choice-input"
              type="checkbox"
              checked={includeBiome}
              onChange={(event) => setIncludeBiome(event.target.checked)}
            />
            <span className="kd-choice-text">
              <span className="kd-choice-name">Include the biome this subject uses</span>
              <span className="kd-choice-note">
                {includeBiome
                  ? `Ticked. The file will carry "${source.biome}".`
                  : 'Unticked. The file will carry no biome.'}
              </span>
            </span>
          </label>
        )}

        <div className="kd-field">
          <label className="kd-field-label" htmlFor={nameFieldId}>
            Template name (optional)
          </label>
          <input
            id={nameFieldId}
            className="kd-input"
            type="text"
            value={templateName}
            maxLength={400}
            onChange={(event) => setTemplateName(event.target.value)}
            aria-describedby={`${nameFieldId}-help`}
          />
          <p className="kd-field-help" id={`${nameFieldId}-help`}>
            A name for the template itself, stored in the file. Leave it empty and the file carries no name.
            It never reaches the file name: the download is always called the same
            thing.
          </p>
        </div>

        <div className="kd-field">
          <label className="kd-field-label" htmlFor={descriptionFieldId}>
            What the template is for (optional)
          </label>
          <input
            id={descriptionFieldId}
            className="kd-input"
            type="text"
            value={description}
            maxLength={400}
            onChange={(event) => setDescription(event.target.value)}
            aria-describedby={`${descriptionFieldId}-help`}
          />
          <p className="kd-field-help" id={`${descriptionFieldId}-help`}>
            One line for whoever you give this to. Leave it empty and the file carries no description.
          </p>
        </div>

        <div className="kd-actions">
          <button
            type="button"
            className="kd-button kd-button--primary"
            onClick={() => void handleDownloadTemplate()}
            disabled={exporting || source === null}
            aria-busy={exporting || undefined}
          >
            {exporting ? 'Making the template…' : 'Download this template'}
          </button>
        </div>
        <p className="kd-status" data-kd-surface="template-export-status" role="status" aria-live="polite">
          {exportMessage}
        </p>
        {exportFailure === null ? null : (
          <p className="kd-problem" data-kd-surface="template-export-problem" role="alert">
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
          Bring a template in
        </h3>
        <p className="kd-lede">
          Choose a template file and read what is in it before anything is added. It becomes a new subject with
          every room empty, so you get the shape and you write the notes. Nothing is written to this device
          until you confirm in the window that opens.
        </p>
        <div className="kd-actions">
          <button
            type="button"
            ref={inspectButtonRef}
            className="kd-button kd-button--primary"
            onClick={openFilePicker}
            disabled={importing}
          >
            Choose a template file
          </button>
          {preview === null ? null : (
            <button type="button" className="kd-button" onClick={openFilePicker} disabled={importing}>
              Choose a different file
            </button>
          )}
          {/*
            The real file input. `hidden` rather than `display: none`-ed by a class, for
            the same reason the other two tabs' are: the control the learner presses is
            a real button, so the input needs no accessible presence of its own, and a
            test can still set files on it. It carries no key handler, so an Enter
            keypress focused on it reaches nothing at all.
          */}
          <input
            ref={fileInputRef}
            type="file"
            accept={TEMPLATE_ACCEPT}
            hidden
            onChange={(event) => handleFileChosen(event)}
          />
        </div>
        <p className="kd-status" data-kd-surface="template-inspection-status" role="status" aria-live="polite">
          {inspectionMessage}
        </p>
        {inspectionFailure === null ? null : (
          <div className="kd-problem-block" data-kd-surface="template-inspection-problem" role="alert">
            <p className="kd-problem">
              <span className="kd-marker" aria-hidden="true">
                !
              </span>
              This file cannot be used. Nothing on this device was changed.
            </p>
            <p className="kd-lede">
              It was reported as <span className="kd-mono">{inspectionFailure.code}</span>. A template has to
              be a file this version of Knowledge Dungeon wrote, and this one is not one. A template made by
              an older version of this app is not one of those either, and is refused rather than partly
              read.
            </p>
          </div>
        )}

        {/*
          The template's own preview, and why it is not `ImportPreview`.

          That component is shaped for an archive: record counts across ten storage
          stores, member counts, and image bytes with a per-image disclosure list. A
          `.kdtemplate` is one JSON document with none of those, and reusing the shape
          would print rows of zero for categories the format has no room for and -
          worse - print "every image in this backup has its picture data with it",
          which is true of a file that cannot contain an image and therefore says
          nothing at all. So the preview below states what the format actually
          carries, in the same `kd-preview` vocabulary.
        */}
        {preview === null ? null : (
          <section className="kd-preview" data-kd-surface="template-preview" aria-labelledby={`${roomsId}-import`}>
            <h3 className="kd-preview-heading" id={`${roomsId}-import`}>
              What is in this template
            </h3>
            {chosenName === null ? null : (
              <p className="kd-preview-file">
                Read from <span className="kd-mono">{chosenName}</span>. Nothing has been added yet.
              </p>
            )}
            <p className="kd-preview-lede">
              A blank skeleton of {countOf(preview.roomCount, 'room', 'rooms')}, with{' '}
              {countOf(preview.structureEdgeCount, 'link', 'links')} between them
              {preview.crossLinkCount === 0
                ? ' and no sideways links'
                : ` and ${countOf(preview.crossLinkCount, 'sideways link', 'sideways links')}`}
              , made {formatInstant(preview.createdAt)}.
            </p>
            <dl className="kd-counts">
              <div className="kd-counts-row">
                <dt className="kd-counts-label">Room topics</dt>
                <dd className="kd-counts-value">{preview.roomCount}</dd>
              </div>
              <div className="kd-counts-row">
                <dt className="kd-counts-label">Links between rooms</dt>
                <dd className="kd-counts-value">{preview.structureEdgeCount}</dd>
              </div>
              <div className="kd-counts-row">
                <dt className="kd-counts-label">Sideways links</dt>
                <dd className="kd-counts-value">{preview.crossLinkCount}</dd>
              </div>
              <div className="kd-counts-row">
                <dt className="kd-counts-label">Approved tags in the file</dt>
                <dd className="kd-counts-value">{preview.approvedTagCount}</dd>
              </div>
              <div className="kd-counts-row">
                <dt className="kd-counts-label">Biome in the file</dt>
                <dd className="kd-counts-value">{preview.hasBiome ? 'yes' : 'no'}</dd>
              </div>
              <div className="kd-counts-row">
                <dt className="kd-counts-label">Template name in the file</dt>
                <dd className="kd-counts-value">{preview.hasName ? 'yes' : 'no'}</dd>
              </div>
              <div className="kd-counts-row">
                <dt className="kd-counts-label">Description in the file</dt>
                <dd className="kd-counts-value">{preview.hasDescription ? 'yes' : 'no'}</dd>
              </div>
            </dl>
            <p className="kd-preview-note">
              The topics and tags inside are not shown here, because this is a file this app did not write and
              anything on this screen can be copied out of it. What arrives is the shape only: every room comes
              in empty, with no note, no image, and no progress, and it is added as a subject you can edit.
            </p>
            <div className="kd-preview-block" aria-labelledby={`${roomsId}-versions`}>
              <h4 className="kd-preview-subheading" id={`${roomsId}-versions`}>
                Which versions this template was written for
              </h4>
              <p className="kd-preview-note">
                Three separate agreements. A template is only accepted when all three are ones this build
                understands.
              </p>
              <dl className="kd-counts">
                <div className="kd-counts-row">
                  <dt className="kd-counts-label">Template format</dt>
                  <dd className="kd-counts-value">{preview.formatVersion}</dd>
                </div>
                <div className="kd-counts-row">
                  <dt className="kd-counts-label">Storage format</dt>
                  <dd className="kd-counts-value">{preview.storageGenerationFormatVersion}</dd>
                </div>
                <div className="kd-counts-row">
                  <dt className="kd-counts-label">Subject format</dt>
                  <dd className="kd-counts-value">{preview.subjectSchemaVersion}</dd>
                </div>
              </dl>
            </div>
          </section>
        )}

        <RecoveryStatus
          outcome={templateOutcome}
          busy={importing}
          onDismiss={dismissOutcome}
          failureOperation="template-import"
          pendingHeading="Adding the template"
          pendingLine="Adding one new subject from the file. Nothing on this device has been changed yet."
          action={
            importedSubjectId === null || onOpenSubject === null ? null : (
              <button
                type="button"
                className="kd-button kd-button--primary"
                onClick={() => onOpenSubject(importedSubjectId)}
              >
                Open it in Create to edit the graph
              </button>
            )
          }
        />
      </section>

      {/* ── The explicit confirmation ── */}
      <ConfirmDialog
        open={dialogOpen}
        surface="template-import-confirmation"
        title="Add this template as a new subject?"
        busy={importing}
        busyMessage="Adding the subject. The window stays open until it has finished."
        dismissLabel="Do not add anything"
        confirmLabel="Add the blank subject"
        confirmDisabled={chosenTemplate === null || reading}
        onDismiss={closeDialog}
        onConfirm={() => void handleConfirm()}
      >
        {reading ? (
          <p className="kd-dialog-line">Reading the file you chose. Nothing has been changed yet.</p>
        ) : (
          <>
            <ul className="kd-bullets">
              <li>
                A new subject is added to this device. Nothing that is already here is replaced, removed, or
                changed, and no internal id from the file is kept.
              </li>
              <li>
                Every room arrives <strong>empty</strong>: no note, no written artifact, no image, no review
                history, and no progress. You get the shape, and you write everything else.
              </li>
              <li>
                The subject is added in the Create state, so the graph is there to be edited as soon as you
                go to it.
              </li>
            </ul>
            {/*
              The destination name, inside the dialog.

              Inside for the same reason the subject tab's mode choice is: the dialog is
              a modal layer, so a field chosen outside it is a field whose effect the
              learner cannot see stated next to the control that commits it. It is safe
              to have a text field here where it was not safe in the other dialog: there
              is no `<form>` anywhere in the Data Center and every button is
              `type="button"`, so an Enter keypress in this field submits nothing - the
              half of "no destructive action one stray Enter away" that
              `ConfirmDialog`'s own header asks its callers to provide.
            */}
            <div className="kd-field">
              <label className="kd-field-label" htmlFor={destinationId}>
                Name for the new subject (optional)
              </label>
              <input
                id={destinationId}
                className="kd-input"
                type="text"
                value={destinationName}
                maxLength={400}
                onChange={(event) => setDestinationName(event.target.value)}
                aria-describedby={destinationHelpId}
              />
              <p className="kd-field-help" id={destinationHelpId}>
                Leave it empty and the name comes from the file, or from the default if the file has none
                either. The report afterwards says which of the three it was.
              </p>
            </div>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

/**
 * Adapt the product's import result to the report this surface renders.
 *
 * Three deliberate moves, each one a privacy or honesty decision rather than a
 * shape change:
 *
 * 1. **The name is not taken from the result.** `importSubjectTemplate` returns a
 *    `subjectName` that may be a value the *file* supplied, and this is a reported
 *    surface. So the subject is read back from the generation the import wrote and
 *    the name comes from there - the difference between a name the application chose
 *    and a name a file chose. `subjectNameSource` is carried through so the report
 *    can say which of the product's three sources it was.
 * 2. **The minted subject id is dropped.** It is what the "open it in Create"
 *    control needs, so the tab keeps it, but it is not in the report shape - an
 *    opaque identifier has no business in a surface that gets copied, and the
 *    sibling subject report declines it for the same reason.
 * 3. **The blank-room claim is a measurement.** `landing` is read back from the
 *    device, and `null` there is a distinct report rather than a zeroed one.
 */
async function toTemplateReport(
  result: ProductTemplateImportResult,
  repository: DeviceRepository,
): Promise<TemplateImportReport> {
  const landing = await readDeviceTemplateLanding(repository, result.generationId, result.subjectId);
  return {
    subjectName: landing?.name ?? result.subjectName,
    subjectNameSource: result.subjectNameSource,
    declaredRoomCount: result.preview.roomCount,
    structureEdgeCount: result.preview.structureEdgeCount,
    crossLinkCount: result.preview.crossLinkCount,
    approvedTagCount: result.preview.approvedTagCount,
    hasBiome: result.preview.hasBiome,
    generationId: result.generationId,
    previousActiveGenerationId: result.previousActiveGenerationId,
    writePolicy: result.writePolicy,
    rollback: result.rollback,
    landing:
      landing === null
        ? null
        : {
            roomCount: landing.roomCount,
            blankRoomCount: landing.blankRoomCount,
            roomsWithNotes: landing.roomsWithNotes,
            roomsWithArtifacts: landing.roomsWithArtifacts,
            roomAttachmentCount: landing.roomAttachmentCount,
            roomsWithReviewHistory: landing.roomsWithReviewHistory,
            phaseState: landing.phaseState,
          },
  };
}
