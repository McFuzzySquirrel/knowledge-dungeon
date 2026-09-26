/**
 * Phase 5: what a chosen `.kdbak` contains, shown before anything is restored.
 *
 * This is the surface a learner reads after picking a file and before agreeing
 * to replace anything. It exists because a restore is the one operation in the
 * application that discards the copy the device is currently using, and "trust
 * me" is not an acceptable summary of a file. Every number here comes from the
 * product's own sanitized preview, read from the picked bytes with the same
 * parser the restore will use, so what is shown and what is committed are the
 * same parse of the same file.
 *
 * ## What this deliberately does not show
 *
 * The product's preview carries counts, versions, digests, member names, and
 * opaque attachment ids. It carries **no** subject name, room topic, note, image
 * file name, or image link, and this component adds none. That is a privacy
 * property, not a formatting choice, and it is why the per-image disclosure below
 * identifies an image by its position in the list rather than by anything the
 * learner or the file named:
 *
 * - no attachment id is rendered, so there is no opaque handle to correlate;
 * - no file name and no link, so a backup opened on a shared machine cannot
 *   disclose what a learner's pictures were called or where they came from.
 *
 * If a future screen genuinely needs to show a subject name here, the answer is
 * not to widen this component: the preview does not contain one, and a file name
 * or link in a backup listing is learner content that plan section 2.3 keeps off
 * the manifest. That is a decision for the phase that owns the format, not a
 * rendering choice.
 *
 * ## The port, not the product's type
 *
 * {@link BackupPreview} is declared here rather than imported. The product tree
 * is reachable only through a lazy `import()` (plan section 11: a build with the
 * flag off must not contain the archive codec), and even a type-only static
 * import would put the module in the entry chunk of a default build. So the
 * surface declares the shape it renders, `DataCenter` adapts the product's
 * result to it, and `tests/unit/dataCenter.test.tsx` asserts at compile time that
 * the product's real preview still satisfies this shape - so the two cannot drift
 * apart silently.
 *
 * Renderer-neutral, network-free, and free of learner data: this file renders
 * only fixed sentences, counts, and code-shaped reasons.
 */

import { useId, type JSX } from 'react';

// ── The port ───────────────────────────────────────────────────────────────

/** One image the archive cannot carry the picture data for. */
export interface BackupPreviewExternalOnly {
  /** Opaque. Present in the data, deliberately never rendered. */
  readonly attachmentId: string;
  /** Opaque. Present in the data, deliberately never rendered. */
  readonly subjectId: string;
  /** Opaque. Present in the data, deliberately never rendered. */
  readonly roomId: string;
  /**
   * `null` for every entry the product discloses, because an image with no bytes
   * has no digest and none is invented.
   *
   * Typed as the product types it because a type is a promise about what may
   * arrive; what this surface *renders* is a separate question, answered by the
   * component body and by `tests/unit/dataCenter.test.tsx`, which asserts that
   * the rendered DOM contains no 64-character hexadecimal string.
   */
  readonly contentHash: string | null;
  readonly byteLength: number | null;
  /** A code from a closed set. {@link describeExternalOnlyReason} turns it into words. */
  readonly reason: string;
  readonly sourceType: string;
}

/** How much of the file is image data. */
export interface BackupPreviewAttachmentBytes {
  readonly memberCount: number;
  readonly byteLength: number;
}

/** The sanitized view of a `.kdbak`: everything this surface may show. */
export interface BackupPreview {
  readonly formatVersion: number;
  readonly storageGenerationFormatVersion: number;
  readonly subjectSchemaVersion: string;
  readonly createdAt: string;
  readonly manifestCreatedAt: string;
  readonly memberCount: number;
  readonly totalMemberCount: number;
  readonly totalBytes: number;
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly attachmentBytes: BackupPreviewAttachmentBytes;
  readonly externalOnlyAttachments: readonly BackupPreviewExternalOnly[];
  readonly externalOnlyCount: number;
}

// ── Copy tables ────────────────────────────────────────────────────────────

/**
 * The ten stores a learner has a name for, in the order they are shown.
 *
 * `meta` is deliberately absent: it is the descriptor registry and the active
 * pointer, which activation writes rather than a backup carries, and a row that
 * is always zero is noise. The order is the plan's own section 7.3 order, so two
 * people reading two backups read them in the same sequence.
 */
const STORE_ROWS: ReadonlyArray<{ readonly store: string; readonly label: string }> = [
  { store: 'subjects', label: 'Subjects' },
  { store: 'progression', label: 'Progress' },
  { store: 'sessions', label: 'Study sessions' },
  { store: 'preferences', label: 'Settings' },
  { store: 'shortcuts', label: 'Keyboard shortcuts' },
  { store: 'assistance', label: 'Assistance records' },
  { store: 'attachments', label: 'Image records' },
  { store: 'customSprites', label: 'Custom pictures' },
  { store: 'recovery', label: 'Recovery records' },
  { store: 'migrationReceipts', label: 'Data-move receipts' },
];

/**
 * Why an image's picture data is not in the backup, in words.
 *
 * The two reasons are the product's own closed set, and they mean genuinely
 * different things to a learner:
 *
 * - `historical-external-url` - the image is a link to a picture somewhere else
 *   on the internet. The application has never downloaded it, so there are no
 *   bytes here to back up and none will ever be.
 * - `bytes-not-recoverable` - the image was added on another device or by an
 *   older version of the application, and its bytes are not on this device now.
 * - `bytes-missing-locally` - the record says the image should be here and it is
 *   not, so what the record claims and what the device holds disagree.
 *
 * An unknown code gets its own sentence rather than being folded into one of
 * these: a newer backup can name a reason this build has never heard of, and
 * guessing which of them it meant would be a lie in the one place a learner is
 * deciding whether their pictures are safe.
 */
export function describeExternalOnlyReason(reason: string): string {
  switch (reason) {
    case 'historical-external-url':
      return 'This image is a link to a picture on the internet. Knowledge Dungeon never downloads it, so there are no picture bytes here to back up.';
    case 'bytes-not-recoverable':
      return 'This image was added somewhere else, or by an older version, and its picture data is not on this device, so this backup cannot include it.';
    case 'bytes-missing-locally':
      return 'This image is listed here, but its picture data is not on this device, so this backup cannot include it.';
    default:
      return 'This image cannot be restored, and the reason is one this version of Knowledge Dungeon does not recognise.';
  }
}

/** A byte count in words, with no locale and no rounding surprise. */
export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown amount';
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kilobytes`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} megabytes`;
}

/** An ISO instant in a form a learner can read and a screen reader can pronounce. */
export function formatInstant(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso)) return iso;
  return `${iso.slice(0, 10)} at ${iso.slice(11, 19)} UTC`;
}

function countOf(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ── The surface ────────────────────────────────────────────────────────────

export interface ImportPreviewProps {
  /** The sanitized preview, or `null` when no readable file has been chosen. */
  readonly preview: BackupPreview | null;
  /**
   * The file the learner chose, by name.
   *
   * Rendered as text and never as a link, and it is the only filename this
   * surface shows: the one the learner themselves just picked.
   */
  readonly fileName: string | null;
}

export function ImportPreview({ preview, fileName }: ImportPreviewProps): JSX.Element | null {
  const headingId = useId();
  const countsId = useId();
  const disclosureId = useId();
  const versionsId = useId();

  if (preview === null) return null;

  const attachments = preview.attachmentBytes;
  const externalOnly = preview.externalOnlyAttachments;

  return (
    <section
      className="kd-preview"
      data-kd-surface="backup-preview"
      aria-labelledby={headingId}
      aria-busy={false}
    >
      <h3 className="kd-preview-heading" id={headingId}>
        What is in this backup
      </h3>
      {fileName === null ? null : (
        <p className="kd-preview-file">
          Read from <span className="kd-mono">{fileName}</span>. Nothing has been changed yet.
        </p>
      )}

      {/* ── The records ── */}
      <div className="kd-preview-block" aria-labelledby={countsId}>
        <h4 className="kd-preview-subheading" id={countsId}>
          What it carries
        </h4>
        <p className="kd-preview-lede">
          {countOf(preview.totalMemberCount, 'part', 'parts')} and{' '}
          {formatByteCount(preview.totalBytes)}, made {formatInstant(preview.createdAt)}.
        </p>
        <dl className="kd-counts">
          {STORE_ROWS.map((row) => (
            <div className="kd-counts-row" key={row.store}>
              <dt className="kd-counts-label">{row.label}</dt>
              <dd className="kd-counts-value">{preview.recordCounts[row.store] ?? 0}</dd>
            </div>
          ))}
        </dl>
        <p className="kd-preview-note">
          Images: {countOf(attachments.memberCount, 'picture is', 'pictures are')} included, totalling{' '}
          {formatByteCount(attachments.byteLength)}.
        </p>
      </div>

      {/* ── The disclosure: the part that matters most ── */}
      <div className="kd-preview-block" aria-labelledby={disclosureId}>
        <h4 className="kd-preview-subheading" id={disclosureId}>
          Images this backup cannot bring back
        </h4>
        {externalOnly.length === 0 ? (
          <p className="kd-preview-note">
            None. Every image in this backup has its picture data with it.
          </p>
        ) : (
          <>
            <p className="kd-preview-lede">
              {preview.externalOnlyCount === externalOnly.length
                ? countOf(
                    externalOnly.length,
                    'image cannot be restored,',
                    'images cannot be restored,',
                  )
                : `This backup reports ${preview.externalOnlyCount} images that cannot be restored.`}{' '}
              They will still be listed after a restore, without their picture data. Nothing is invented to
              stand in for them.
            </p>
            <ol className="kd-disclosure">
              {externalOnly.map((entry, index) => (
                <li className="kd-disclosure-item" key={entry.attachmentId}>
                  <span className="kd-disclosure-name">
                    Image {index + 1} of {externalOnly.length}
                  </span>
                  <span className="kd-disclosure-reason">{describeExternalOnlyReason(entry.reason)}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      {/* ── The three version contracts ── */}
      <div className="kd-preview-block" aria-labelledby={versionsId}>
        <h4 className="kd-preview-subheading" id={versionsId}>
          Which versions this backup was written for
        </h4>
        <p className="kd-preview-note">
          These are three separate agreements, and a backup is only accepted when all three are ones this
          build understands.
        </p>
        <dl className="kd-counts">
          <div className="kd-counts-row">
            <dt className="kd-counts-label">Backup format</dt>
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
  );
}
