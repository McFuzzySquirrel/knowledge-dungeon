/**
 * Share-card delivery: the Web Share states, and the local download, as one honest vocabulary.
 *
 * ## Why this module is separate from the dialog and from the renderer
 *
 * Three claims in plan section 9 are easy to state and easy to get quietly wrong, so each one gets
 * a named place:
 *
 * 1. **`navigator.share` runs only from an explicit action.** Every entry point in this file takes a
 *    file the caller already has, and none of them is called from a mount, an effect, a preview, or
 *    a field change. There is exactly one function that touches `navigator.share`
 *    ({@link shareCardImage}), it is `async`, and it takes the file as a required argument - so the
 *    only way to reach it is to call it, and the only way to call it is to hand it a file the
 *    learner produced by clicking something.
 * 2. **Four outcomes, not two.** `unsupported`, `denied`, `cancelled`, and `failed` are four
 *    different things a learner needs told apart, and three of them are not errors. The old
 *    behaviour - an instant download with no states at all - made every one of them invisible.
 * 3. **Cancelling is not an error.** A learner who dismisses the operating system's share sheet has
 *    not failed at anything. {@link ShareDeliveryOutcome} has a `cancelled` member, the dialog shows
 *    it as an ordinary status sentence, and no code path turns it into an error toast or a store
 *    write. That is a claim about *absence*, so it is proved structurally by
 *    `tests/phase20/shareCardDelivery.test.ts`, which fingerprints every storage-v2 generation store
 *    and every non-share `localStorage` key across a cancelled share.
 *
 * ## The names are the whole API
 *
 * {@link ShareDeliveryOutcome} is a closed union, and {@link describeShareDelivery} is a total
 * function over it. A dialog cannot invent a fifth state, cannot forget one, and cannot render the
 * cancelled case as an error, because the only sentence it can render comes from here.
 *
 * ## No clock, no locale, no network
 *
 * There is no `Date`, no timestamp, and no `toLocaleString` in this module. A card is a pure
 * function of learner state; the one thing that must never happen is this layer adding a second
 * varying input to it.
 *
 * ## Naming
 *
 * `shareCardDelivery.ts` rather than something matching `src/core/share/shareCardPolicy.ts`. The
 * core module owns *which fields* may appear; this one owns *how the bytes leave the device*. They
 * are different questions and must not share a filename, which is also why
 * `tests/phase20/infraShareBuildLane.test.ts` can name one without naming the other.
 */

/** What the learner was asked to share. Always a local file: nothing leaves the device unprompted. */
export interface ShareCardFile {
  readonly blob: Blob;
  /**
   * A name for the file, e.g. `linear-algebra-summary.png`.
   *
   * Never learner content beyond what they already chose to put on the card, and never a timestamp:
   * a file name is a place a subject name and a date both leak into a filesystem and a sharing
   * target's UI.
   */
  readonly fileName: string;
  /** MIME type for the share payload. PNG for every card this phase draws. */
  readonly mimeType?: string;
}

/**
 * The closed set of delivery outcomes.
 *
 * `cancelled` is the member most likely to be collapsed into `failed`, which is why it is a
 * separate member and why {@link describeShareDelivery} has a sentence for it.
 */
export type ShareDeliveryOutcome =
  /** The operating system's share sheet was accepted. Bytes went to a target the learner chose. */
  | 'shared'
  /** The learner dismissed the share sheet. A normal outcome, not a failure. */
  | 'cancelled'
  /** The browser or the learner refused: permission denied, or Web Share blocked by policy. */
  | 'denied'
  /** This device has no Web Share API, or `canShare` said no for these files. */
  | 'unsupported'
  /** Anything else: a share error, a decode failure, a `canShare` that threw. */
  | 'failed';

export interface ShareDeliveryResult {
  readonly outcome: ShareDeliveryOutcome;
  /**
   * A developer-facing note, never learner content.
   *
   * `error.name` at most. Deliberately not `error.message`: a browser share error message can
   * contain the payload's file name, and a file name can contain a subject name. Phase 12's rule 6
   * forbids learner data in error reports, and an error banner is an error report.
   */
  readonly detail?: string;
}

/** Whether this device exposes the Web Share API at all. A **capability** read, never a share. */
export function hasWebShareSupport(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * Whether this device will accept *these* files.
 *
 * `canShare` is a query, not a share: it takes the payload and answers yes or no without showing a
 * sheet. Plan section 9 requires it before `share`, and this is the only call site.
 *
 * `canShare` is optional in the spec even where `share` exists - Safari has historically shipped
 * `share` without a usable `canShare` for files - so an absent `canShare` is reported as
 * * `'unsupported'` rather than assumed to be permissive. The local download path is unaffected, so
 * the conservative reading costs a learner nothing.
 */
export function canShareCardFile(file: ShareCardFile): boolean {
  if (!hasWebShareSupport()) return false;
  if (typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [toShareFile(file)] });
  } catch {
    // A `canShare` that throws is not a permission; it is a payload this engine will not take.
    return false;
  }
}

/** The `File` a Web Share payload carries. The only place this module constructs one. */
function toShareFile(file: ShareCardFile): File {
  return new File([file.blob], file.fileName, {
    type: file.mimeType ?? 'image/png',
  });
}

/** Is this thrown value the browser's "the learner dismissed the sheet"? */
function isAbort(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** Is this thrown value a refusal rather than a dismissal or a fault? */
function isDenied(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'TypeError';
}

/**
 * Classify a Web Share rejection into one of the four non-success outcomes.
 *
 * `AbortError` is checked **first** and is the only branch that can return `'cancelled'`. That
 * ordering is the whole reason cancellation is not an error: it is decided by its own name before
 * any generic failure handling sees it.
 */
export function classifyShareRejection(error: unknown): ShareDeliveryResult {
  if (isAbort(error)) return { outcome: 'cancelled' };
  if (isDenied(error)) return { outcome: 'denied' };
  return { outcome: 'failed', detail: errorName(error) };
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Share one card image, from one explicit user action.
 *
 * The single function in the repository that calls `navigator.share`. Its signature is the
 * structural guarantee behind "Web Share runs only from a user click": a required `file` argument
 * means there is no call path that could fire on mount, and a test can prove it by counting
 * invocations across the whole dialog lifecycle rather than by asserting an absence.
 *
 * `canShare` is consulted first and a refusal short-circuits, so a device that cannot take these
 * files never sees a share sheet and the learner is told `'unsupported'` rather than being shown a
 * sheet that will fail.
 */
export async function shareCardImage(file: ShareCardFile): Promise<ShareDeliveryResult> {
  if (!hasWebShareSupport()) return { outcome: 'unsupported' };
  if (!canShareCardFile(file)) return { outcome: 'unsupported' };
  try {
    await navigator.share({
      files: [toShareFile(file)],
      title: file.fileName,
    });
    return { outcome: 'shared' };
  } catch (error) {
    return classifyShareRejection(error);
  }
}

/**
 * The sentence a learner reads for an outcome.
 *
 * Total over the union, so a dialog cannot render nothing for a state, and worded so no state is
 * implied to be a failure except `'failed'`. `'cancelled'` in particular says what did *not*
 * happen - nothing was sent - because that is the question a learner has after dismissing a sheet.
 */
export function describeShareDelivery(outcome: ShareDeliveryOutcome): string {
  switch (outcome) {
    case 'shared':
      return 'Shared. The image went to the destination you chose.';
    case 'cancelled':
      return 'Share cancelled. Nothing was sent and nothing on this device was changed.';
    case 'denied':
      return 'Sharing was refused. You can still download the image and send it yourself.';
    case 'unsupported':
      return 'This device cannot share images directly. Download the image and send it yourself.';
    case 'failed':
      return 'Sharing did not finish. Download the image and send it yourself.';
    default:
      return 'Sharing is unavailable. Download the image and send it yourself.';
  }
}

/**
 * Does this outcome mean the learner should be offered the download instead?
 *
 * A dialog uses it to keep the local download control enabled and, when nothing has been sent, to
 * say so. `'cancelled'` is in the set: a cancelled share is precisely the case where the local path
 * is what the learner still wants.
 */
export function isDeliverableOnly(outcome: ShareDeliveryOutcome): boolean {
  return outcome === 'cancelled' || outcome === 'denied' || outcome === 'unsupported' || outcome === 'failed';
}

/**
 * A file name a download should suggest, from a card kind and a subject name.
 *
 * Derived only from what the learner already chose to publish, never from a clock: a timestamp in a
 * file name is both a locale-dependent string and a small leak of when the card was made. Falls
 * back to `'knowledge-dungeon-card.png'` when there is no subject name, so the result is always a
 * usable name.
 */
export function suggestShareFileName(subjectName: string | null, suffix: string): string {
  const part = (subjectName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${part || 'knowledge-dungeon-card'}-${suffix}.png`;
}