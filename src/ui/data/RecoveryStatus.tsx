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

import { useId, type JSX } from 'react';

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
  | { readonly kind: 'failure'; readonly report: RestoreFailureReport };

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
}

export function RecoveryStatus({
  outcome,
  busy = false,
  onDismiss = null,
  pendingHeading = 'Restoring',
  pendingLine = 'Writing the backup into a new copy on this device. This can take a moment.',
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
            The restore did not finish. Nothing was switched over.
          </p>
          <ul className="kd-outcome-list">
            <li>
              A restore is written into a new copy first and only then made active, so the copy this device
              was using is still the copy it is using.
            </li>
            <li>The backup file you chose is unchanged, and you can choose it again or pick a different one.</li>
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
        {onDismiss === null ? null : (
          <button type="button" className="kd-button kd-button--quiet" onClick={onDismiss}>
            Clear this report
          </button>
        )}
      </section>
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
