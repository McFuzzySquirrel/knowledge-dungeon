/**
 * Phase 5: what a restore actually did.
 *
 * A restore is the one operation in the application that changes which copy of
 * everything the device is using, so its report is the one piece of copy that
 * must not overstate. This surface is therefore built from a rule rather than a
 * mood: **every sentence is a field the product returned.**
 *
 * Concretely, the claims and the fields that license them:
 *
 * - "This backup is what the device is using now" - licensed by `activated`,
 *   and only rendered when `activated` is `true`. A result that did not flip the
 *   pointer says so instead.
 * - "the copy that was here is still here" - licensed by
 *   `previousGenerationRetained`, and only when it is `true`. A device that had
 *   no earlier copy says that there was nothing to keep, rather than claiming a
 *   safety net that was never needed.
 * - "N things point at something that is not there, and were kept" - licensed
 *   by `disclosedWarnings`, reported one code at a time.
 * - "N images were restored without their picture data" - licensed by
 *   `externalOnlyAttachments`, each with the same plain-language reason the
 *   preview used.
 *
 * Two things this surface deliberately does **not** say, because the product
 * does not do them:
 *
 * 1. **It never says the active subject changed.** The result carries
 *    `restoredActiveSubjectId` *reported and not applied* - the active-subject
 *    pointer is synchronously readable legacy-mirror state that a product module
 *    does not write. So when the archive names a subject, this says the backup
 *    recorded which subject was open, and that this build does not switch to it,
 *    and stops there.
 * 2. **It never says a receipt was written.** `receiptNote` is
 *    `restore-mints-no-receipt` and `migrationReceiptCount` is the archive's own
 *    count, so the sentence is about the receipts the backup *carried*, and it
 *    says plainly that restoring records no new one.
 *
 * The failure branch is the same discipline pointed the other way: it reports
 * the typed error's `code` and its code-shaped `details`, and explains the
 * mechanism that makes a failed restore safe (a restore is written into a new
 * copy and only then switched to) without claiming anything the result does not
 * carry. No `error.message` is ever rendered: a message could be a subject name.
 *
 * The port, not the product's type, for the same reason as {@link
 * ImportPreview}: the product tree is reachable only through a lazy `import()`.
 * `tests/unit/dataCenter.test.tsx` asserts at compile time that the product's
 * real result still satisfies these shapes.
 */

import { useId, type JSX, type ReactNode } from 'react';

import { describeExternalOnlyReason } from './ImportPreview';

/** One disclosed relationship the restore carried through rather than refused. */
export interface RestoreDisclosedWarning {
  /** A code from the validator's closed set. Never a value a learner authored. */
  readonly code: string;
  /** What the reference was about. */
  readonly scope: string;
  readonly count: number;
  readonly severity: string;
}

/** An image restored without its picture data. */
export interface RestoreExternalOnly {
  /** Opaque. Present in the data, deliberately never rendered. */
  readonly attachmentId: string;
  /**
   * `null` for every entry the product discloses, because an image with no bytes
   * has no digest and none is invented. Typed as the product types it; never
   * rendered, and `tests/unit/dataCenter.test.tsx` asserts the rendered DOM
   * carries no digest.
   */
  readonly contentHash: string | null;
  readonly byteLength: number | null;
  /** A code from a closed set. */
  readonly reason: string;
  readonly sourceType: string;
}

/** The part of a successful restore this surface reports. */
export interface RestoreSuccessReport {
  readonly generationId: string;
  readonly previousActiveGenerationId: string | null;
  readonly activated: boolean;
  readonly previousGenerationRetained: boolean;
  readonly keepPreviousGeneration: boolean;
  readonly retentionNote: string;
  readonly disclosedWarnings: readonly RestoreDisclosedWarning[];
  readonly externalOnlyAttachments: readonly RestoreExternalOnly[];
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly contentChecksum: string;
  /** Reported by the product and deliberately not applied by it. */
  readonly restoredActiveSubjectId: string | null;
  readonly reusedArchiveGenerationId: boolean;
  readonly migrationReceiptCount: number;
  readonly receiptNote: string;
}

/** A typed refusal: a code, and details that are codes, counts, and lengths. */
export interface RestoreFailureReport {
  readonly code: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

// ── The `.kdsubject` import result ─────────────────────────────────────────

/**
 * The part of a subject import this surface reports.
 *
 * Declared here rather than imported from the product for the same reason
 * {@link RestoreSuccessReport} is: the product tree is reachable only through a
 * lazy `import()`. Every field is a count, a code, or an opaque identifier.
 *
 * The two fields that would be learner content - the imported subject's id and the
 * replaced subject's id - are deliberately absent. The surface that names the
 * subject reads the device's own records after the import, so every name it shows
 * is one the application chose rather than one a file supplied.
 */
/**
 * Counts only, never identifiers, and only rendered as words and numbers.
 *
 * The product's contract is explicit that a bystander subject's id - or a fish id,
 * or a room id - must never appear in an import report, a disclosure screen, or a
 * log. This shape is the surface's side of that contract: seven counts and one
 * code-shaped note, and `tests/unit/subjectBackupTab.test.tsx` asserts that no
 * subject id, name, topic, or file name reaches the DOM from it.
 */
export interface SubjectReplaceForeignState {
  readonly preservedProgressionKeys: number;
  readonly appliedProgressionKeys: number;
  readonly retainedProgressionKeys: number;
  readonly destroyedProgressionKeys: number;
  readonly identicalAssistanceRecords: number;
  readonly preservedAssistanceRecords: number;
  readonly appliedAssistanceRecords: number;
  readonly note: string;
}

/** One closed code and the count of values carried verbatim by its rule. */
export interface SubjectVerbatimDisclosure {
  readonly code: string;
  readonly count: number;
}

export interface SubjectImportReport {
  readonly mode: 'copy' | 'replace';
  readonly activated: boolean;
  readonly previousGenerationRetained: boolean;
  readonly previousActiveGenerationId: string | null;
  /** How many ids the copy rewrote. Always `0` in replace mode. */
  readonly identifiersRemapped: number;
  /**
   * Strings that mentioned an id without being one and were carried verbatim.
   *
   * Rendered whenever it is non-zero, because a non-zero value means the rewrite
   * was not total and a surface that said only "imported" would be saying something
   * the product knows is not quite true.
   */
  readonly unresolvedReferenceCount: number;
  readonly crossSubjectAchievementsCarried: number;
  readonly carriedForwardRecordCounts: Readonly<Record<string, number>>;
  readonly destroyedRecordCounts: Readonly<Record<string, number>>;
  /**
   * What the import did to state belonging to **other** subjects.
   *
   * All zeros in copy mode. In replace mode it is the honest answer to "what did
   * that destroy?", which `destroyedRecordCounts` cannot give - that field counts
   * *records* per store, and another subject's rooms cleared, notes, and fish are
   * not records. Rendered whenever any count is non-zero.
   */
  readonly foreignState: SubjectReplaceForeignState;
  /**
   * Values a declared rule chose not to rewrite, by code.
   *
   * A separate disclosure from `unresolvedReferenceCount` because the two mean
   * different things: that one is prose that mentions an identifier, this one is a
   * value the product deliberately left alone. Rendered when non-empty, and only
   * when non-empty - a list of zero counts is noise.
   */
  readonly verbatimDisclosures: readonly SubjectVerbatimDisclosure[];
  readonly disclosedWarnings: readonly RestoreDisclosedWarning[];
  readonly externalOnlyAttachments: readonly RestoreExternalOnly[];
  readonly receiptPolicy: string;
  readonly receiptNote: string;
  readonly previousGenerationReceiptCount: number;
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly contentChecksum: string;
  readonly generationId: string;
}

export type RestoreOutcome =
  | { readonly kind: 'success'; readonly result: RestoreSuccessReport }
  | { readonly kind: 'subject-success'; readonly result: SubjectImportReport }
  | { readonly kind: 'template-success'; readonly result: TemplateImportReport }
  | { readonly kind: 'failure'; readonly report: RestoreFailureReport };

/**
 * The outcome of a `.kdtemplate` import.
 *
 * Derived from the union for the same reason {@link SubjectImportOutcome} is, so
 * the template tab cannot hand this surface an archive's result and the failure
 * branch stays genuinely shared: a typed refusal means the same thing whichever
 * product produced it.
 */
export type TemplateImportOutcome = Extract<RestoreOutcome, { readonly kind: 'template-success' }> | Extract<
  RestoreOutcome,
  { readonly kind: 'failure' }
>;

/**
 * What a template import created, as this surface reports it.
 *
 * Every field is a count, a closed code, or a name **this device holds**. Three
 * consequences of that rule, and each is load-bearing:
 *
 * 1. **The subject name is absent from the product's result and is read from the
 *    device after the write.** `importSubjectTemplate` does return a `subjectName`,
 *    but it may be a value *the file* supplied - the template's own declared
 *    `name`, which the writer approved for sharing. So the tab looks the subject up
 *    in the generation the import wrote and fills this field from there, which is
 *    the difference between a name the application chose and a name a file chose.
 * 2. **The minted subject id is not in this shape at all.** It is what the tab
 *    needs for its "open it in Create" control, and it is kept in the tab's own
 *    state. Putting it here would put an opaque identifier into a report surface,
 *    which is exactly what {@link SubjectImportReport} declines to do.
 * 3. **No room topic, tag, or file name is in this shape**, so none can reach the
 *    DOM through the report. The counts below are the whole of what an import
 *    tells a learner about the rooms it made.
 */
export interface TemplateImportReport {
  /** The device's own name for the subject the import created. */
  readonly subjectName: string;
  /** Which of the product's three name sources supplied that name. */
  readonly subjectNameSource: 'caller' | 'template-name' | 'default';
  /** How many rooms the document declared, as the product reported them. */
  readonly declaredRoomCount: number;
  readonly structureEdgeCount: number;
  readonly crossLinkCount: number;
  /** How many approved tags the document carried. A count, never a tag. */
  readonly approvedTagCount: number;
  /** Whether the document carried a biome preference. A boolean, never the value. */
  readonly hasBiome: boolean;
  /** The generation the record was written into. */
  readonly generationId: string;
  /** The generation that was active before the import, and that is still active. */
  readonly previousActiveGenerationId: string | null;
  /** The product's own write policy, as a closed code. */
  readonly writePolicy: string;
  /** The product's own rollback, as a closed code. */
  readonly rollback: string;
  /**
   * The read-back from the device, or `null` when the subject was not found.
   *
   * `null` is a **distinct report** and not a zeroed one: the surface then says the
   * read-back found nothing and states only what the product's own result licenses,
   * rather than claiming a verification that did not happen.
   */
  readonly landing: TemplateLandingMeasurement | null;
}

/**
 * What the device holds for the subject a template import just created.
 *
 * A measurement, and every sentence it licenses says so. `blankRoomCount` equal to
 * `roomCount` is what "it landed in Creator state with blank room state" means, and
 * it is counted from the record the product wrote rather than repeated from the
 * product's documentation.
 */
export interface TemplateLandingMeasurement {
  readonly roomCount: number;
  /** Rooms whose state, note, artifact, image list, and review count are all blank. */
  readonly blankRoomCount: number;
  readonly roomsWithNotes: number;
  readonly roomsWithArtifacts: number;
  readonly roomAttachmentCount: number;
  readonly roomsWithReviewHistory: number;
  readonly phaseState: string;
}

/**
 * The outcome of a `.kdsubject` import.
 *
 * Derived rather than declared, so the subject tab cannot hand this surface a
 * whole-device result and the two products' reports cannot drift apart in the
 * union. The failure branch is genuinely shared: a typed refusal means the same
 * thing whichever product produced it.
 */
export type SubjectImportOutcome = Extract<RestoreOutcome, { readonly kind: 'subject-success' }> | Extract<
  RestoreOutcome,
  { readonly kind: 'failure' }
>;

/** Plain-language names for the validator's reference scopes. */
const SCOPE_LABELS: Readonly<Record<string, string>> = {
  subject: 'subject',
  progression: 'progress',
  session: 'study session',
  preference: 'setting',
  shortcut: 'keyboard shortcut',
  assistance: 'assistance record',
  attachment: 'image',
  'custom-sprite': 'custom picture',
  recovery: 'recovery record',
  'migration-receipt': 'data-move receipt',
};

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? 'record';
}

function totalRecords(recordCounts: Readonly<Record<string, number>>): number {
  return Object.values(recordCounts).reduce((total, count) => total + (Number(count) || 0), 0);
}

/**
 * The retention sentence, licensed by the two fields that make it true.
 *
 * Shared by both products because they make the *same* promise for the same
 * reason: an import stages a complete new generation and retains the previous one,
 * so a learner can go back. What differs is the noun, which is why the noun is a
 * parameter rather than a constant.
 */
function retentionLine(retained: boolean, previousId: string | null, what: string): JSX.Element {
  if (retained) {
    return (
      <li>
        {what} is still here, so you can go back to it if this file turns out to be the wrong one.
      </li>
    );
  }
  if (previousId === null) {
    return <li>There was no earlier copy on this device, so there was nothing to keep.</li>;
  }
  return (
    <li>
      This device did not report an earlier copy as retained, so do not assume the previous data is still here.
    </li>
  );
}

/** Code-shaped detail values, rendered as text and never interpreted. */
function detailEntries(details: Readonly<Record<string, string | number | boolean | null>>) {
  return Object.entries(details).filter((entry): entry is [string, string | number | boolean | null] => {
    const value = entry[1];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null;
  });
}

/**
 * The sentence for a value a declared rule chose to carry verbatim.
 *
 * The same rule {@link describeExternalOnlyReason} follows, for the same reason: a
 * newer product can name a code this build has never heard of, and guessing which of
 * the known rules it meant would be a lie in the one place a learner is deciding
 * whether an import did what they wanted. An unknown code gets its own sentence.
 */
export function describeVerbatimDisclosure(code: string, count: number): string {
  const n = `${count} ${count === 1 ? 'value' : 'values'}`;
  switch (code) {
    case 'attachment-relative-path-names-a-remapped-id':
      return (
        `This copy left ${n} inside image file paths as they were. Those paths point at the original ` +
        `subject's pictures on the device that made the backup, so rewriting the room in them would name a ` +
        `file that does not exist. Nothing was broken, and the path is still a true statement about where that ` +
        `picture is.`
      );
    case 'stale-subject-dungeon-id':
      return (
        `This copy left ${n} as they were, and they do not match the copy's own subject. The backup file ` +
        `disagreed with itself about which subject it was, so the value was kept rather than changed to match. ` +
        `Everything the app reads comes from the correct subject.`
      );
    default:
      return (
        `This copy left ${n} as they were, because a rule in Knowledge Dungeon says not to rewrite them. ` +
        `This version does not recognise which rule, so it cannot say more.`
      );
  }
}

/**
 * The sentence for what an import did to other subjects' progress and assistance.
 *
 * Counts and words, and no id anywhere: the numbers are named, never enumerated, so
 * a bystander subject's identifier cannot reach the DOM through this report. Only
 * the non-zero numbers are mentioned, because a sentence that says "0 other subjects
 * were affected" is reassurance the learner did not ask for and that a silent bug
 * would also produce.
 */
function foreignLine(foreign: SubjectReplaceForeignState): string {
  const parts: string[] = [];
  if (foreign.preservedProgressionKeys > 0) {
    parts.push(
      `${foreign.preservedProgressionKeys} other ${
        foreign.preservedProgressionKeys === 1 ? 'subject was' : 'subjects were'
      } left exactly as ${foreign.preservedProgressionKeys === 1 ? 'it was' : 'they were'}`,
    );
  }
  if (foreign.appliedProgressionKeys > 0) {
    parts.push(
      `${foreign.appliedProgressionKeys} other ${
        foreign.appliedProgressionKeys === 1 ? 'subject gained' : 'subjects gained'
      } progress from the file`,
    );
  }
  if (foreign.retainedProgressionKeys > 0) {
    parts.push(
      `on ${foreign.retainedProgressionKeys} other ${
        foreign.retainedProgressionKeys === 1 ? 'subject' : 'subjects'
      } this device's newer progress was kept rather than the older copy in the file`,
    );
  }
  if (foreign.destroyedProgressionKeys > 0) {
    parts.push(
      `and the progress this device had for the imported subject itself was cleared, because the file held none for it`,
    );
  }
  if (foreign.appliedAssistanceRecords > 0) {
    parts.push(
      `${foreign.appliedAssistanceRecords} assistance ${
        foreign.appliedAssistanceRecords === 1 ? 'record' : 'records'
      } came in from the file`,
    );
  }
  if (foreign.preservedAssistanceRecords > 0) {
    parts.push(
      `and ${foreign.preservedAssistanceRecords} assistance ${
        foreign.preservedAssistanceRecords === 1 ? 'record' : 'records'
      } that already existed here ${
        foreign.preservedAssistanceRecords === 1 ? 'was' : 'were'
      } kept, with the file's versions set aside rather than overwriting them`,
    );
  }
  if (foreign.identicalAssistanceRecords > 0) {
    parts.push(
      `${foreign.identicalAssistanceRecords} assistance ${
        foreign.identicalAssistanceRecords === 1 ? 'record matched' : 'records matched'
      } what was already here, so nothing was added twice`,
    );
  }
  return `Nothing outside the subject being imported was changed: ${parts.join(', ')}.`;
}

/**
 * The failure branch, the surface's rule, applied to the two operations that need
 * different words.
 *
 * Every sentence must be a field the product returned, and that rule bites hardest on
 * the *safety* claim: an archive restore's safety sentence is licensed by its
 * generation flip ("written into a new copy first and only then made active"), and that
 * sentence is **false** for a template import, which is a single additive record and
 * stages no copy at all. So the operation is a closed parameter rather than one sentence
 * that is true of two products and quietly untrue of the third.
 *
 * There is no third entry, and that is a decision rather than an omission: both archive
 * products stage a complete generation and flip the pointer, so one safety sentence is
 * true of both, and a subject import differs from a whole-device restore only in which
 * noun the learner reads. A caller whose mechanism is genuinely different names itself.
 */
export type RecoveryFailureOperation = 'archive-restore' | 'template-import';

interface FailureCopy {
  readonly verdict: string;
  readonly safety: string;
  readonly retry: string;
}

const FAILURE_COPY: Readonly<Record<RecoveryFailureOperation, FailureCopy>> = {
  'archive-restore': {
    verdict: 'The restore did not finish. Nothing was switched over.',
    safety:
      'A restore is written into a new copy first and only then made active, so the copy this device was using is still the copy it is using.',
    retry: 'The backup file you chose is unchanged, and you can choose it again or pick a different one.',
  },
  'template-import': {
    // The one product whose safety mechanism is *not* a generation flip, so the
    // sentence is the one its own module makes: the document is read, validated,
    // and minted before a single record is written, and a read-back disagreement
    // deletes the record it just wrote. A device with no earlier copy gains its
    // first one, and the learner is told that rather than left to assume otherwise.
    verdict: 'The template was not brought in. No subject was added, and every subject you already had is exactly as it was.',
    safety:
      'A template is read and checked in full before anything is written, so a file this version cannot use is refused before it can change anything. If the write itself disagreed with what was read back, the subject it had just created is removed again.',
    retry: 'The template file you chose is unchanged, and you can choose it again or pick a different one.',
  },
};


export interface RecoveryStatusProps {
  /** The outcome to report, or `null` when no import has been attempted. */
  readonly outcome: RestoreOutcome | null;
  /** `true` while an import is in flight. */
  readonly busy?: boolean;
  /** Clears the report. Omitted when the host has nothing to clear. */
  readonly onDismiss?: (() => void) | null;
  /**
   * What the in-flight state calls the operation.
   *
   * Both products stage a new generation, so "Restoring" is true of both, and the
   * subject tab's dialog already says which of the two is happening. These two
   * exist because the panel is *visible behind* its own dialog, and a status line
   * that named the wrong operation there would be a screen reader reading two
   * different things at once.
   */
  readonly pendingHeading?: string;
  readonly pendingLine?: string;
  /**
   * Which operation the failure sentence is about.
   *
   * Defaults to the archive restore, which is what this surface was built for and which
   * both archive products can honestly share. A product whose safety mechanism is a
   * different mechanism states its own, because one sentence cannot describe two.
   */
  readonly failureOperation?: RecoveryFailureOperation;
  /**
   * A control the learner can take from this report, rendered below it.
   *
   * Phase 7 needs one: an imported template is a subject waiting to be edited, and
   * the learner must choose to go and edit it rather than being navigated away from
   * a report they have not read. It is a `ReactNode` rather than a callback so the
   * caller owns the wording and the disabled state, and so nothing here can navigate
   * on its own.
   */
  readonly action?: ReactNode;
}

export function RecoveryStatus({
  outcome,
  busy = false,
  onDismiss = null,
  pendingHeading = 'Restoring',
  pendingLine = 'Writing the backup into a new copy on this device. This can take a moment.',
  failureOperation = 'archive-restore',
  action = null,
}: RecoveryStatusProps): JSX.Element | null {
  const headingId = useId();

  if (outcome === null) {
    if (!busy) return null;
    return (
      <section className="kd-outcome" data-kd-surface="restore-outcome" aria-labelledby={headingId}>
        <h3 className="kd-outcome-heading" id={headingId}>
          {pendingHeading}
        </h3>
        <p className="kd-outcome-pending" role="status" aria-live="polite">
          {pendingLine}
        </p>
      </section>
    );
  }

  if (outcome.kind === 'failure') {
    const { code, details } = outcome.report;
    const entries = detailEntries(details);
    const copy = FAILURE_COPY[failureOperation];
    return (
      <section className="kd-outcome kd-outcome--problem" data-kd-surface="restore-outcome" aria-labelledby={headingId}>
        <h3 className="kd-outcome-heading" id={headingId}>
          What happened
        </h3>
        {/* Assertive: a restore that did not happen is the outcome a learner must
            hear without asking for it. The surface is inserted into the DOM when
            the failure arrives, which is what triggers the announcement. */}
        <div role="alert">
          <p className="kd-outcome-verdict">
            <span className="kd-outcome-marker" aria-hidden="true">
              !
            </span>
            {copy.verdict}
          </p>
          <ul className="kd-outcome-list">
            <li>{copy.safety}</li>
            <li>{copy.retry}</li>
            <li>
              The problem was reported as <span className="kd-mono">{code}</span>.
            </li>
          </ul>
        </div>
        {entries.length === 0 ? null : (
          <details className="kd-technical">
            <summary>Technical details</summary>
            <dl className="kd-counts">
              {entries.map(([key, value]) => (
                <div className="kd-counts-row" key={key}>
                  <dt className="kd-counts-label">{key}</dt>
                  <dd className="kd-counts-value">
                    {value === null ? 'none' : <span className="kd-mono">{String(value)}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {action}
        {onDismiss === null ? null : (
          <button type="button" className="kd-button kd-button--quiet" onClick={onDismiss}>
            Clear this report
          </button>
        )}
      </section>
    );
  }

  if (outcome.kind === 'template-success') {
    return (
      <TemplateImportReportSurface
        outcome={outcome.result}
        headingId={headingId}
        onDismiss={onDismiss}
        action={action}
      />
    );
  }

  if (outcome.kind === 'subject-success') {
    return <SubjectImportReportSurface outcome={outcome.result} headingId={headingId} onDismiss={onDismiss} />;
  }

  const result = outcome.result;
  const disclosures = result.disclosedWarnings;
  const externalOnly = result.externalOnlyAttachments;
  const hasDisclosure = disclosures.length > 0 || externalOnly.length > 0;
  const records = totalRecords(result.recordCounts);

  return (
    <section className="kd-outcome" data-kd-surface="restore-outcome" aria-labelledby={headingId}>
      <h3 className="kd-outcome-heading" id={headingId}>
        What happened
      </h3>
      <div role="status" aria-live="polite">
        <p className="kd-outcome-verdict">
          <span className="kd-outcome-marker" aria-hidden="true">
            {hasDisclosure ? '•' : '✓'}
          </span>
          {hasDisclosure
            ? 'Restored, with a few things worth knowing.'
            : 'Restored. This backup is what the device is using now.'}
        </p>
        <ul className="kd-outcome-list">
          {result.activated ? (
            <li>
              {records} {records === 1 ? 'record is' : 'records are'} now in use on this device.
            </li>
          ) : (
            <li>
              The backup was written into a new copy, but this device did not switch to it. The copy it was
              using before is still the one it is using.
            </li>
          )}
          {retentionLine(result.previousGenerationRetained, result.previousActiveGenerationId, 'The copy that was here before')}
          {disclosures.map((warning) => (
            <li key={`${warning.code}:${warning.scope}`}>
              {warning.count} {scopeLabel(warning.scope)}
              {warning.count === 1 ? ' record' : ' records'} in the backup point at something that is not in
              it. {warning.count === 1 ? 'It was' : 'They were'} kept as {warning.count === 1 ? 'it is' : 'they are'} rather
              than dropped, so nothing is silently lost.
            </li>
          ))}
          {externalOnly.length > 0 ? (
            <li>
              {externalOnly.length} {externalOnly.length === 1 ? 'image was' : 'images were'} restored
              without {externalOnly.length === 1 ? 'its' : 'their'} picture data. The records are back; the
              pictures are not.
            </li>
          ) : null}
          {externalOnly.length > 0 ? (
            <li>
              {Array.from(new Set(externalOnly.map((entry) => entry.reason)))
                .map((reason) => describeExternalOnlyReason(reason))
                .join(' ')}
            </li>
          ) : null}
          {result.restoredActiveSubjectId === null ? null : (
            <li>
              The backup recorded which subject was open when it was made. This version does not switch to it
              for you, so open the subject you want from the Create / Load tab.
            </li>
          )}
          <li>
            The backup carried {result.migrationReceiptCount} data-move{' '}
            {result.migrationReceiptCount === 1 ? 'receipt' : 'receipts'}. Restoring does not write a new
            one, so nothing records this restore as a data move.
          </li>
        </ul>
      </div>
      <details className="kd-technical">
        <summary>Technical details</summary>
        <dl className="kd-counts">
          <div className="kd-counts-row">
            <dt className="kd-counts-label">generation</dt>
            <dd className="kd-counts-value kd-mono">{result.generationId}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">content checksum</dt>
            <dd className="kd-counts-value kd-mono">{result.contentChecksum}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">reused the backup&rsquo;s own generation name</dt>
            <dd className="kd-counts-value">{result.reusedArchiveGenerationId ? 'yes' : 'no'}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">image records without picture data</dt>
            <dd className="kd-counts-value">
              {externalOnly.length} of {result.recordCounts.attachments ?? 0}
            </dd>
          </div>
        </dl>
      </details>
      {onDismiss === null ? null : (
        <button type="button" className="kd-button kd-button--quiet" onClick={onDismiss}>
          Clear this report
        </button>
      )}
    </section>
  );
}

/**
 * What a `.kdsubject` import actually did.
 *
 * Built from the same rule as the whole-device report above: **every sentence is a
 * field the product returned.** The claims, and the fields that license them:
 *
 * - "a new subject is on this device" / "this subject now matches the file" -
 *   licensed by `mode`, and worded differently for each so the learner knows
 *   which happened.
 * - "N internal ids were rewritten" - licensed by `identifiersRemapped`, and only
 *   shown in copy mode, where it is the whole point of the mode.
 * - **"N references inside the file could not be rewritten"** - licensed by
 *   `unresolvedReferenceCount`, and shown **whenever it is non-zero**. This is the
 *   one disclosure the product insists a screen must not hide, because a non-zero
 *   value means the rewrite was not total.
 * - "N records of the old subject were destroyed" - licensed by
 *   `destroyedRecordCounts`, and only in replace mode, where it is the thing the
 *   learner agreed to.
 * - "N receipts stayed with the copy that was here" - licensed by
 *   `receiptPolicy` and `previousGenerationReceiptCount`, and it says plainly that
 *   importing writes no new one, exactly as the `.kdbak` report does.
 *
 * Two things it deliberately does **not** say: that a subject was opened or
 * selected (a product module does not write the active-subject pointer), and that
 * any reference was *repaired* (a non-zero unresolved count is a disclosure, not a
 * fix).
 */
function SubjectImportReportSurface({
  outcome,
  headingId,
  onDismiss,
}: {
  readonly outcome: SubjectImportReport;
  readonly headingId: string;
  readonly onDismiss: (() => void) | null;
}): JSX.Element {
  const disclosures = outcome.disclosedWarnings;
  const externalOnly = outcome.externalOnlyAttachments;
  const foreign = outcome.foreignState;
  const foreignNonZero = Object.values(foreign).some(
    (value) => typeof value === 'number' && value > 0,
  );
  const verbatim = outcome.verbatimDisclosures.filter((entry) => entry.count > 0);
  const hasDisclosure =
    disclosures.length > 0 ||
    externalOnly.length > 0 ||
    outcome.unresolvedReferenceCount > 0 ||
    verbatim.length > 0 ||
    foreignNonZero ||
    Object.keys(outcome.destroyedRecordCounts).length > 0;
  const records = totalRecords(outcome.recordCounts);
  const carried = totalRecords(outcome.carriedForwardRecordCounts);
  const destroyed = totalRecords(outcome.destroyedRecordCounts);
  const replaced = outcome.mode === 'replace';

  return (
    <section className="kd-outcome" data-kd-surface="restore-outcome" aria-labelledby={headingId}>
      <h3 className="kd-outcome-heading" id={headingId}>
        What happened
      </h3>
      <div role="status" aria-live="polite">
        <p className="kd-outcome-verdict">
          <span className="kd-outcome-marker" aria-hidden="true">
            {hasDisclosure ? '•' : '✓'}
          </span>
          {replaced
            ? hasDisclosure
              ? 'The subject was replaced, with a few things worth knowing.'
              : 'The subject on this device now matches the file.'
            : hasDisclosure
              ? 'A copy of the subject was added, with a few things worth knowing.'
              : 'A copy of the subject was added to this device.'}
        </p>
        <ul className="kd-outcome-list">
          <li>
            {outcome.activated
              ? `${records} ${records === 1 ? 'record is' : 'records are'} now in use on this device.`
              : 'The subject was written into a new copy, but this device did not switch to it. The copy it was using before is still the one it is using.'}
          </li>
          {replaced ? (
            <li>
              {destroyed} {destroyed === 1 ? 'record of the subject that was there' : 'records of the subject that was there'}{' '}
              {destroyed === 1 ? 'was' : 'were'} destroyed and replaced by what the file held.
            </li>
          ) : (
            <li>
              {outcome.identifiersRemapped} {outcome.identifiersRemapped === 1 ? 'internal id was' : 'internal ids were'}{' '}
              rewritten, so this copy shares nothing with the subject the backup came from and the two can be
              worked on independently.
            </li>
          )}
          {/* The disclosure the product insists on. Not folded into the line
              above, and not omitted when it is zero either: zero is stated as
              "everything inside the file was rewritten". */}
          {replaced ? null : (
            <li>
              {outcome.unresolvedReferenceCount === 0
                ? 'Every reference inside the file was rewritten.'
                : `${outcome.unresolvedReferenceCount} ${
                    outcome.unresolvedReferenceCount === 1
                      ? 'reference inside the file mentions an old id in a way this version of Knowledge Dungeon does not rewrite, and was'
                      : 'references inside the file mention old ids in ways this version of Knowledge Dungeon does not rewrite, and were'
                  } carried across as they were. Nothing was lost, and nothing was changed to make it look tidier.`}
            </li>
          )}
          {outcome.crossSubjectAchievementsCarried === 0 ? null : (
            <li>
              {outcome.crossSubjectAchievementsCarried}{' '}
              {outcome.crossSubjectAchievementsCarried === 1 ? 'achievement that counts' : 'achievements that count'}{' '}
              across every subject came across too, because the file cannot tell whether they were earned by this
              subject alone.
            </li>
          )}
          {/*
            What the import did to *other* subjects' state. Counts and words only:
            this is the surface's half of the product's "counts only, never
            identifiers" contract, and a bystander subject's id must not be able to
            reach a report - so the seven numbers are named, never enumerated. It is
            the one sentence a replace needs that `destroyedRecordCounts` cannot
            give, because another subject's rooms cleared and fish are not records.
          */}
          {foreignNonZero ? (
            <li>
              {foreignLine(foreign)}
            </li>
          ) : null}
          {/*
            Values a declared rule chose not to rewrite. Each code gets its own
            sentence, and a code this build has never heard of gets its own honest
            one rather than being folded into a guess - the same rule the
            per-image reasons follow in `ImportPreview`.
          */}
          {verbatim.map((entry) => (
            <li key={entry.code}>
              {describeVerbatimDisclosure(entry.code, entry.count)}
            </li>
          ))}
          {carried === 0 ? null : (
            <li>
              {carried} {carried === 1 ? 'record' : 'records'} of settings, shortcuts, custom pictures, and
              recovery records were carried across exactly as they were.
            </li>
          )}
          {retentionLine(outcome.previousGenerationRetained, outcome.previousActiveGenerationId, 'Everything this device had before')}
          {disclosures.map((warning) => (
            <li key={`${warning.code}:${warning.scope}`}>
              {warning.count} {scopeLabel(warning.scope)}
              {warning.count === 1 ? ' record' : ' records'} in the file point at something that is not in it.{' '}
              {warning.count === 1 ? 'It was' : 'They were'} kept as {warning.count === 1 ? 'it is' : 'they are'}{' '}
              rather than dropped, so nothing is silently lost.
            </li>
          ))}
          {externalOnly.length > 0 ? (
            <li>
              {externalOnly.length} {externalOnly.length === 1 ? 'image was' : 'images were'} added without{' '}
              {externalOnly.length === 1 ? 'its' : 'their'} picture data. The records are there; the pictures are
              not.
            </li>
          ) : null}
          {externalOnly.length > 0 ? (
            <li>
              {Array.from(new Set(externalOnly.map((entry) => entry.reason)))
                .map((reason) => describeExternalOnlyReason(reason))
                .join(' ')}
            </li>
          ) : null}
          <li>
            The copy this device had before still holds its {outcome.previousGenerationReceiptCount}{' '}
            {outcome.previousGenerationReceiptCount === 1 ? 'data-move receipt' : 'data-move receipts'}. Bringing
            a subject in does not write a new one, so nothing records this as a data move.
          </li>
        </ul>
      </div>
      <details className="kd-technical">
        <summary>Technical details</summary>
        <dl className="kd-counts">
          <div className="kd-counts-row">
            <dt className="kd-counts-label">mode</dt>
            <dd className="kd-counts-value">{replaced ? 'replace' : 'copy'}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">generation</dt>
            <dd className="kd-counts-value kd-mono">{outcome.generationId}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">content checksum</dt>
            <dd className="kd-counts-value kd-mono">{outcome.contentChecksum}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">receipt policy</dt>
            <dd className="kd-counts-value kd-mono">{outcome.receiptPolicy}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">receipt note</dt>
            <dd className="kd-counts-value kd-mono">{outcome.receiptNote}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">unresolved references</dt>
            <dd className="kd-counts-value">{outcome.unresolvedReferenceCount}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">image records without picture data</dt>
            <dd className="kd-counts-value">
              {externalOnly.length} of {outcome.recordCounts.attachments ?? 0}
            </dd>
          </div>
        </dl>
      </details>
      {onDismiss === null ? null : (
        <button type="button" className="kd-button kd-button--quiet" onClick={onDismiss}>
          Clear this report
        </button>
      )}
    </section>
  );
}

/**
 * What a `.kdtemplate` import actually did.
 *
 * The same rule as the two reports above - **every sentence is a field the product
 * returned, or a count this screen read back from the device** - applied to the one
 * product whose central claim is an *absence*. So the sentences run in the order a
 * learner asks for them, and each names its own evidence:
 *
 * - "A new subject was added, called \<name\>" - the name is **this device's**,
 *   read back from the record the import wrote rather than taken from the file, and
 *   which of the product's three name sources supplied it is stated so a learner
 *   who typed nothing understands where the name came from.
 * - "It has N rooms, and every one of them is empty" - licensed by
 *   `landing.blankRoomCount === landing.roomCount`, a count of rooms whose state,
 *   note, artifact, image list, and review count are all blank, read from the
 *   device. This is plan phase 7's fourth exit criterion, stated back as a
 *   measurement rather than as a promise.
 * - "It is in the Create state, so you can edit its graph" - licensed by
 *   `landing.phaseState`, mapped to words, with the raw code shown for a state this
 *   build does not recognise.
 * - "The tags in the file were M, and a biome was/was not in it" - counts and a
 *   boolean, never a tag and never a biome value.
 * - "Nothing else on this device was changed" - licensed by `writePolicy` being
 *   the product's own `additive-single-record`, which is the reason the sentence is
 *   true: one record added, nothing deleted, nothing updated, no pointer flipped.
 * - "If it is the wrong file, deleting this one subject undoes it" - licensed by
 *   `rollback`, the product's own `delete-the-created-subject-record`.
 *
 * Two things it deliberately does **not** say. That a room was opened, selected, or
 * navigated to: the control that does that is the caller's, rendered through
 * {@link RecoveryStatusProps.action}, so the learner presses it after reading this.
 * And that the learner data in the *file* was checked against anything: a template
 * carries no notes by construction, and the counts above are about the new subject,
 * not about a comparison.
 */
function TemplateImportReportSurface({
  outcome,
  headingId,
  onDismiss,
  action,
}: {
  readonly outcome: TemplateImportReport;
  readonly headingId: string;
  readonly onDismiss: (() => void) | null;
  readonly action: ReactNode;
}): JSX.Element {
  const landing = outcome.landing;
  const allBlank = landing !== null && landing.blankRoomCount === landing.roomCount && landing.roomCount > 0;
  const declared = outcome.declaredRoomCount;
  const sameCount = landing !== null && landing.roomCount === declared;

  return (
    <section className="kd-outcome" data-kd-surface="restore-outcome" aria-labelledby={headingId}>
      <h3 className="kd-outcome-heading" id={headingId}>
        What happened
      </h3>
      <div role="status" aria-live="polite">
        <p className="kd-outcome-verdict">
          <span className="kd-outcome-marker" aria-hidden="true">
            ✓
          </span>
          A new subject was added, called <span className="kd-dialog-subject">{outcome.subjectName}</span>.
        </p>
        <ul className="kd-outcome-list">
          <li>
            {NAME_SOURCE_LINE[outcome.subjectNameSource]}
          </li>
          <li>
            It has {declared} {declared === 1 ? 'room' : 'rooms'} and {outcome.structureEdgeCount}{' '}
            {outcome.structureEdgeCount === 1 ? 'link' : 'links'} between them
            {outcome.crossLinkCount === 0
              ? ', and no sideways links.'
              : `, plus ${outcome.crossLinkCount} sideways ${
                  outcome.crossLinkCount === 1 ? 'link' : 'links'
                }.`}
          </li>
          {/*
            The property the phase exists for, and the one a learner most needs
            stated back. A missing read-back is a *different report* rather than a
            zeroed one: the surface then says the check did not find the subject and
            claims only what the product's own result licenses.
          */}
          {landing === null ? (
            <li>
              The check of what actually landed on this device did not find the new subject, so this report
              cannot tell you how blank its rooms are. What is above comes from what the import itself returned.
            </li>
          ) : allBlank ? (
            <li>
              All {landing.roomCount} of {landing.roomCount === 1 ? 'it is' : 'them are'} empty: no note, no
              written artifact, no image, and no review history
              {sameCount ? ', which is the number the file declared.' : '. The count is not the one the file declared, so check it before you rely on it.'}
            </li>
          ) : (
            <li>
              {landing.blankRoomCount} of {landing.roomCount} rooms are empty.{' '}
              {[
                landing.roomsWithNotes > 0
                  ? `${landing.roomsWithNotes} ${
                      landing.roomsWithNotes === 1 ? 'carries' : 'carry'
                    } a note`
                  : null,
                landing.roomsWithArtifacts > 0
                  ? `${landing.roomsWithArtifacts} ${
                      landing.roomsWithArtifacts === 1 ? 'carries' : 'carry'
                    } a written artifact`
                  : null,
                landing.roomAttachmentCount > 0
                  ? `${landing.roomAttachmentCount} ${
                      landing.roomAttachmentCount === 1 ? 'image is' : 'images are'
                    } attached`
                  : null,
                landing.roomsWithReviewHistory > 0
                  ? `${landing.roomsWithReviewHistory} ${
                      landing.roomsWithReviewHistory === 1 ? 'has' : 'have'
                    } review history`
                  : null,
              ]
                .filter((line): line is string => line !== null)
                .join(', ')}
              . A template is not supposed to bring any of that in, so this is worth looking at before you use
              this subject.
            </li>
          )}
          <li>
            {PHASE_STATE_LINE[landing?.phaseState ?? ''] ??
              `The new subject reports its state as ${landing?.phaseState ?? 'nothing'}, which this version of Knowledge Dungeon does not recognise. Check what it is before you use it.`}
          </li>
          <li>
            The file carried {outcome.approvedTagCount} approved{' '}
            {outcome.approvedTagCount === 1 ? 'tag' : 'tags'}
            {outcome.hasBiome ? ' and a biome preference' : ' and no biome'}, and the tags and topics in it are the
            ones whoever made it approved. They are not shown here, because this report can be copied.
          </li>
          <li>
            {outcome.writePolicy === 'additive-single-record'
              ? 'Nothing else on this device was changed: one subject record was added, nothing was replaced or removed, and this device kept using the copy it was already using.'
              : `This import reported its write policy as ${outcome.writePolicy}, which is not the additive single record this screen expects. Read the details below before you rely on anything else here.`}
          </li>
          <li>
            {outcome.previousActiveGenerationId === null
              ? 'This device had no earlier copy, so the subject above is the first thing in it. There was no earlier copy to keep.'
              : 'The copy this device was using before is still the one it is using. Nothing was switched over, so you can go back to what you had by deleting this one new subject.'}
          </li>
          <li>
            {outcome.rollback === 'delete-the-created-subject-record'
              ? 'If this is the wrong file, deleting the new subject is the whole of the undo. Nothing else here refers to it.'
              : `This import reported its undo as ${outcome.rollback}, which this version of Knowledge Dungeon does not recognise.`}
          </li>
        </ul>
      </div>
      <details className="kd-technical">
        <summary>Technical details</summary>
        <dl className="kd-counts">
          <div className="kd-counts-row">
            <dt className="kd-counts-label">write policy</dt>
            <dd className="kd-counts-value kd-mono">{outcome.writePolicy}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">rollback</dt>
            <dd className="kd-counts-value kd-mono">{outcome.rollback}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">subject name source</dt>
            <dd className="kd-counts-value kd-mono">{outcome.subjectNameSource}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">generation</dt>
            <dd className="kd-counts-value kd-mono">{outcome.generationId}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">rooms in the file</dt>
            <dd className="kd-counts-value">{declared}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">rooms on this device</dt>
            <dd className="kd-counts-value">{landing === null ? 'not found' : landing.roomCount}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">blank rooms on this device</dt>
            <dd className="kd-counts-value">{landing === null ? 'not found' : landing.blankRoomCount}</dd>
          </div>
          <div className="kd-counts-row">
            <dt className="kd-counts-label">phase state</dt>
            <dd className="kd-counts-value kd-mono">{landing === null ? 'not found' : landing.phaseState}</dd>
          </div>
        </dl>
      </details>
      {action}
      {onDismiss === null ? null : (
        <button type="button" className="kd-button kd-button--quiet" onClick={onDismiss}>
          Clear this report
        </button>
      )}
    </section>
  );
}

/**
 * Where the new subject's name came from, in words.
 *
 * Three sources, and they are genuinely different to a learner: something they
 * typed, something the file carried and its writer approved, or a fixed default
 * because neither was supplied. A surface that reported the name without this would
 * leave a learner wondering where it came from, which is exactly the question the
 * file's own privacy rules make worth answering.
 */
const NAME_SOURCE_LINE: Readonly<Record<'caller' | 'template-name' | 'default', string>> = {
  caller: 'You chose that name just now, so it is the name on this device.',
  'template-name':
    'You left the name blank, so it uses the name written inside the template file. Whoever made that file approved that name for sharing.',
  default: 'You left the name blank and the file carried no name, so it got the default name this app always uses.',
};

/**
 * The phase state a template import lands in, in words.
 *
 * Only the one state, because it is the one this product is contracted to produce.
 * Every other value - a state from a newer build, or a device that disagrees -
 * gets its own honest sentence rather than being folded into this one, which is the
 * rule {@link describeExternalOnlyReason} and {@link describeVerbatimDisclosure}
 * already follow.
 */
const PHASE_STATE_LINE: Readonly<Record<string, string>> = {
  CreatorActive:
    'It is in the Create state, so the rooms are there to be edited: the graph is the template&rsquo;s, and every note is still yours to write.',
};
