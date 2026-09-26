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

export type RestoreOutcome =
  | { readonly kind: 'success'; readonly result: RestoreSuccessReport }
  | { readonly kind: 'failure'; readonly report: RestoreFailureReport };

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

/** Code-shaped detail values, rendered as text and never interpreted. */
function detailEntries(details: Readonly<Record<string, string | number | boolean | null>>) {
  return Object.entries(details).filter((entry): entry is [string, string | number | boolean | null] => {
    const value = entry[1];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null;
  });
}

export interface RecoveryStatusProps {
  /** The outcome to report, or `null` when no restore has been attempted. */
  readonly outcome: RestoreOutcome | null;
  /** `true` while a restore is in flight. */
  readonly busy?: boolean;
  /** Clears the report. Omitted when the host has nothing to clear. */
  readonly onDismiss?: (() => void) | null;
}

export function RecoveryStatus({ outcome, busy = false, onDismiss = null }: RecoveryStatusProps): JSX.Element | null {
  const headingId = useId();

  if (outcome === null) {
    if (!busy) return null;
    return (
      <section className="kd-outcome" data-kd-surface="restore-outcome" aria-labelledby={headingId}>
        <h3 className="kd-outcome-heading" id={headingId}>
          Restoring
        </h3>
        <p className="kd-outcome-pending" role="status" aria-live="polite">
          Writing the backup into a new copy on this device. This can take a moment.
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
          {result.previousGenerationRetained ? (
            <li>
              The copy that was here before is still here, so you can go back to it if this file turns out to
              be the wrong one.
            </li>
          ) : result.previousActiveGenerationId === null ? (
            <li>There was no earlier copy on this device, so there was nothing to keep.</li>
          ) : (
            <li>
              This device did not report an earlier copy as retained, so do not assume the previous data is
              still here.
            </li>
          )}
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
