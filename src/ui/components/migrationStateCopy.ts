/**
 * Phase 4: the words the storage-move surface renders, as data.
 *
 * The state model in `services/persistence/v2/migrationState.ts` is a set of
 * codes, counts, and booleans. Turning those into something a learner can act on
 * is a rendering decision, so it lives here as a pure function rather than inside
 * JSX: a test can read the exact sentence a state produces without rendering,
 * and a copy change cannot silently alter which control appears.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **Nothing is claimed that the code does not do.** Every sentence here is
 *    derived from a field of the state it describes, not from what the migration
 *    "usually" does. In particular the `dataIsIntact` and `legacyAuthoritative`
 *    literals are *read*, not assumed, so the reassurance a learner is given is
 *    the reassurance the state actually carries.
 * 2. **No learner content, and no invented detail.** A reason code is rendered
 *    through a fixed table of sentences, so a URL, a filename, or a room topic
 *    has no path into the output even if one reached the state. Diagnostic
 *    codes pass through {@link diagnosticCode}, which admits only a code-shaped
 *    token, because `stage` is typed as a loose string.
 * 3. **A partial outcome never reads as a clean success.** Whether the disclosure
 *    renders is decided by the *count* of external-only attachments rather than
 *    by `kind`, so a state that somehow carried both `kind: 'migrated'` and
 *    external-only attachments would still be told about them.
 *
 * Privacy: the file contains only fixed sentences, fixed reason codes, and
 * format strings. It has no learner data, and it makes no "nothing leaves your
 * device" claim - where it mentions images it discloses that their data is not
 * available on the device.
 */

// The migration types come from the application seam rather than from the
// persistence tree: `application/bootstrap.ts` is the one module allowed to name
// a storage-v2 path, and the UI depending on the application's published contract
// is the right direction for the dependency anyway.
import type {
  ExternalOnlyAttachmentReport,
  MigrationState,
  MigrationSucceededState,
} from '@/application/bootstrap';

// ── View model ─────────────────────────────────────────────────────────────

/**
 * How the outcome is drawn.
 *
 * Tone is a *visual* axis only. Every tone is also stated in words by
 * {@link MigrationView.statusLabel}, so no state is ever communicated by colour
 * alone (WCAG 2.2 AA, 1.4.1).
 */
export type MigrationTone = 'informational' | 'success' | 'attention' | 'problem';

export interface MigrationView {
  readonly kind: MigrationState['kind'];
  readonly tone: MigrationTone;
  /** Decorative; {@link statusLabel} carries the same information in words. */
  readonly glyph: string;
  /** The words that replace the colour. */
  readonly statusLabel: string;
  readonly heading: string;
  /** One or two paragraphs a learner can act on. */
  readonly summary: readonly string[];
  /** Counted things, e.g. what a move would carry. */
  readonly tally: readonly string[];
  /** The external-only disclosure, in plain language. */
  readonly disclosureHeading: string | null;
  readonly disclosure: readonly string[];
  /** Codes a learner can quote back: a problem code, a step, a reason. */
  readonly diagnostics: readonly string[];
  /** The plain-language step for a running move, or `null` for every other state. */
  readonly stageSentence: string | null;
  /** True when the move itself finished. */
  readonly succeeded: boolean;
  /** True when the move finished *and* carried a disclosure. */
  readonly succeededWithDisclosure: boolean;
  /** Whether the state itself says a plain retry is the next step. */
  readonly retryable: boolean;
}

// ── Fixed vocabulary ───────────────────────────────────────────────────────

/**
 * Why an attachment has no data on the device, as plain sentences.
 *
 * Keyed by the core's fixed reason union, so a new reason code is a compile
 * error here rather than a blank line in front of a learner.
 */
const EXTERNAL_ONLY_REASONS: Readonly<Record<ExternalOnlyAttachmentReport['reason'], string>> = Object.freeze({
  'historical-external-url':
    'It was saved as a web link, and the app does not download linked images, so its bytes are not on this device.',
  'bytes-not-recoverable': 'Its bytes could not be recovered from the copy this app read.',
  'bytes-missing-locally': 'It is listed, but its bytes are not held on this device.',
});

/**
 * The steps a running move passes through.
 *
 * `stage` is typed as a loose string on the state, so an unrecognised value
 * falls back to a sentence that claims nothing about what is happening rather
 * than echoing the raw token into a learner-facing line.
 */
const STAGE_STEPS: Readonly<Record<string, string>> = Object.freeze({
  'read-legacy': 'Reading the saved data already on this device',
  transform: 'Preparing the new records',
  'stage-records': 'Writing the new records',
  validate: 'Checking the new records',
  compare: 'Comparing the two copies',
  receipt: 'Recording the result',
  activate: 'Switching the app over to the new copy',
  rollback: 'Undoing the unfinished attempt',
});

/** The token shape the Phase 4 storage lane uses for an identifier. */
const CODE_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/** What a value that is not recognisable is called in diagnostic text. */
const UNKNOWN_CODE = 'unknown';

/**
 * The one sanitiser every raw value from a state passes through.
 *
 * Diagnostic text is the only place a raw value from the state is rendered, so it
 * is the only place a value that somehow carried free text has to be stopped. Both
 * render paths - the recovery problem code and the disclosed-problem code - call
 * this, so neither can be the one that forgets.
 *
 * @param vocabulary A closed set of values the field is allowed to hold, or `null`
 *   when only the token *shape* is known. Passing the vocabulary is strictly
 *   stronger, and it is what stops a value that is shaped like a code but is not
 *   one: `photo-of-my-cat.png` satisfies the shape and would otherwise be rendered
 *   verbatim, because a filename looks exactly like a code.
 */
function codeOrUnknown(value: string | null | undefined, vocabulary: ReadonlySet<string> | null): string {
  if (typeof value !== 'string') return UNKNOWN_CODE;
  if (!CODE_SHAPE.test(value)) return UNKNOWN_CODE;
  if (vocabulary !== null && !vocabulary.has(value)) return UNKNOWN_CODE;
  return value;
}

/**
 * A code-shaped token, or `unknown`.
 *
 * Used for the recovery `code` and `stage`, whose vocabulary is
 * `StorageV2ErrorCode` and the migration stages respectively - both closed, and
 * both rendered as a name the learner cannot quote back usefully anyway, so the
 * shape check is what does the work there.
 */
export function diagnosticCode(value: string | null | undefined): string {
  return codeOrUnknown(value, null);
}

/**
 * A disclosed-problem code, or `unknown`.
 *
 * `ValidationProblem['code']` is a *closed union* of
 * `ValidationCode | SubjectValidationCode`, so membership is the right question to
 * ask of it rather than shape: a value outside the union is not a code that has
 * been mangled, it is a value that was never a code, and a filename or a URL
 * satisfies the token shape perfectly well.
 *
 * The two sets below are transcribed from
 * `services/persistence/v2/validation.ts` and
 * `core/validation/persistence/subjectValidation.ts` rather than imported, because
 * the Phase 4 seam allowlist permits exactly one module outside the storage-v2 tree
 * to name it and the surface must not be that module. The transcription is held to
 * the source by a test that parses both union declarations, so a code added to the
 * core without a matching entry here turns that test red rather than silently
 * degrading a legitimate disclosure to `unknown`.
 */
const DISCLOSED_PROBLEM_CODES: ReadonlySet<string> = new Set([
  'attachment-without-metadata',
  'blob-without-bytes',
  'checksum-mismatch',
  'content-hash-mismatch',
  'count-mismatch',
  'dangling-edge',
  'duplicate-identifier',
  'empty-identifier',
  'malformed-attachment-entry',
  'malformed-attachments',
  'malformed-edge-endpoint',
  'malformed-edges',
  'malformed-progression',
  'malformed-room-payload',
  'malformed-room-state',
  'malformed-room-summaries',
  'malformed-room-summary-entry',
  'malformed-validation-state',
  'missing-dungeon',
  'missing-dungeon-id',
  'missing-field',
  'missing-phase-state',
  'missing-room-payload',
  'missing-rooms',
  'missing-root-room-id',
  'missing-schema-version',
  'missing-subject-name',
  'not-an-object',
  'receipt-generation-mismatch',
  'relationship-invalid',
  'room-id-mismatch',
  'stored-without-bytes',
  'unexpected-json-shape',
  'unindexed-subject-payload',
  'unknown-phase-state',
  'unknown-room-reference',
  'unknown-subject-reference',
  'unsupported-schema-version',
  'unsupported-version',
  'wrong-type',
]);

/** `ValidationScope`, transcribed from the same file. See the code set above. */
const VALIDATION_SCOPES: ReadonlySet<string> = new Set([
  'assistance',
  'attachment',
  'attachment-blob',
  'checksum',
  'custom-sprite',
  'generation',
  'migration-receipt',
  'pointer',
  'preference',
  'progression',
  'recovery',
  'relationship',
  'session',
  'shortcut',
  'subject',
]);

/**
 * The sanitised code vocabulary this module recognises.
 *
 * Exported so a test can assert the transcription against the core's own source
 * rather than against a second hand-written copy of it.
 */
export const DISCLOSED_PROBLEM_CODE_VOCABULARY: ReadonlySet<string> = DISCLOSED_PROBLEM_CODES;

/** As above, for the scope half of the same line. */
export const VALIDATION_SCOPE_VOCABULARY: ReadonlySet<string> = VALIDATION_SCOPES;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A counted noun with a verb and a pronoun that agree with it.
 *
 * `plural` cannot do this on its own, and getting it wrong is worse than being
 * terse: "2 image is listed without its data" is the kind of sentence that makes a
 * learner stop trusting the rest of the notice.
 */
function countedSentence(count: number, singular: string, plural_: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural_}`;
}

function stepSentence(stage: string): string {
  return STAGE_STEPS[stage] ?? 'Working on the next step';
}

/**
 * Whether a successful move carried anything the learner would recognise.
 *
 * A notice about a move that moved nothing is noise the learner has to read and
 * dismiss to reach the screen they came for, so a success with no content and no
 * disclosure is treated the way `no-source-data` is: nothing to say.
 *
 * The counts that count are the ones a learner created or accumulated. The three
 * that do not are `preferences`, `shortcuts`, and `assistance`, because the
 * migration materialises a default record for each of them on *every* device:
 * measured on a device whose only legacy key was `knowledge-dungeon:locale`, the
 * report carried `preferences: 1` and `assistance: 1` and every other count `0`.
 * Counting them would make a first-run device with no content look like it had
 * migrated something.
 *
 * That measurement is also the reason this rule exists. The core's emptiness test
 * treats a legacy `knowledge-dungeon:locale` key as source data, so a brand-new
 * device is classified `migrated` rather than `no-source-data`, and the flagged
 * build would otherwise greet every new learner with a storage notice about a move
 * that carried nothing. The classification is the core's to fix; this is the
 * presentation rule that keeps the surface honest until it does.
 *
 * It is deliberately narrow. It applies only to a success - a failure is reported
 * however empty it is - and it cannot hide a disclosure, because a `partial`
 * outcome always carries at least one external-only attachment.
 */
function isVacuousSuccess(state: MigrationSucceededState): boolean {
  const counts = state.counts;
  const carried =
    counts.subjects +
    counts.progression +
    counts.sessions +
    counts.attachmentMetadata +
    counts.attachmentBlobs +
    counts.customSprites +
    counts.recovery;
  return carried === 0 && state.externalOnlyAttachments === 0;
}

function reasonSentence(reason: string): string {
  const known = EXTERNAL_ONLY_REASONS[reason as ExternalOnlyAttachmentReport['reason']];
  return known ?? 'The app recorded a reason for this that this version does not recognise.';
}

/**
 * The disclosed problems, as codes and counts.
 *
 * A disclosed problem is a warning the migration deliberately allowed: a
 * reference to something legitimately absent, or a record it could not read out
 * of the source device. It is disclosed rather than dropped, so the honest
 * sentence is "it was carried over with a note", not "something was lost".
 *
 * Both raw values on the line - the code and the scope - go through the same
 * sanitiser the recovery path uses. A value outside the core's declared union
 * becomes `unknown`, which keeps the count and the disclosure itself while
 * refusing to echo a value that was never a code. Nothing is dropped: the line
 * still renders, so a hostile code degrades the *name* of a difference rather
 * than hiding that the difference exists.
 */
function disclosedLines(state: MigrationState): string[] {
  return state.disclosedProblems.map((problem) => {
    const code = codeOrUnknown(problem.code, DISCLOSED_PROBLEM_CODES);
    const scope = codeOrUnknown(problem.scope, VALIDATION_SCOPES);
    return `${plural(problem.count, code.replace(/-/g, ' '))} (${scope})`;
  });
}

/**
 * The external-only disclosure, or nothing when there is nothing to disclose.
 *
 * The two sentences are load-bearing and are deliberately separate from the
 * "the move finished" sentence: the move did finish, and that is true
 * independently of whether image data came with it.
 */
function externalOnlyDisclosure(state: MigrationSucceededState): string[] {
  const count = state.externalOnlyAttachments;
  if (count === 0) return [];
  return [
    `${countedSentence(count, 'image is listed without its data', 'images are listed without their data')}: ` +
      'the app does not have the bytes on this device and cannot fetch them, so a backup of this device cannot include them. ' +
      'The link itself is kept, so the app can still show that an image belongs there.',
    ...state.externalOnlyReasons.map((reason) => reasonSentence(reason)),
  ];
}

// ── Per-kind copy ──────────────────────────────────────────────────────────

/**
 * The whole view for a state, or `null` when there is nothing to say.
 *
 * `null` is the answer for `no-source-data`: a device with nothing to move is a
 * normal, correct state, and a notice about it would be noise. The default build
 * reaches here as `null` too, because the default repository never produces a
 * migration at all.
 */
export function describeMigration(state: MigrationState | null): MigrationView | null {
  if (state === null) return null;
  switch (state.kind) {
    case 'no-source-data':
      return null;

    case 'preview':
      return {
        kind: 'preview',
        tone: 'informational',
        glyph: 'i',
        statusLabel: 'Ready',
        heading: 'The app can update how it stores your data',
        summary: [
          'Nothing has been moved yet. The data already on this device is still the copy the app reads, and it stays exactly where it is.',
          'If you go ahead, the app copies it into a newer store on this device and checks the copy before it starts using it.',
        ],
        tally: [plural(state.counts.subjects, 'subject'), plural(state.counts.attachmentMetadata, 'image')],
        disclosureHeading: null,
        disclosure: [],
        diagnostics: [],
        stageSentence: null,
        succeeded: false,
        succeededWithDisclosure: false,
        retryable: false,
      };

    case 'running':
      return {
        kind: 'running',
        tone: 'informational',
        glyph: '~',
        statusLabel: 'In progress',
        heading: 'The app is copying your data',
        summary: [
          'The app is copying the data already on this device into a newer store on this device. Nothing has been switched over yet, so the original copy is still the one being read.',
        ],
        tally: [],
        disclosureHeading: null,
        disclosure: [],
        diagnostics: [],
        // The step is shown as a sentence, never as the raw stage token, so a
        // stage value is never echoed into learner-facing text.
        stageSentence: stepSentence(state.stage),
        succeeded: false,
        succeededWithDisclosure: false,
        retryable: false,
      };

    case 'migrated':
    case 'partial': {
      if (isVacuousSuccess(state)) return null;
      // The disclosure is decided by the count, not by `kind`. `classifyMigrationReport`
      // maps any external-only attachment to `partial`, so this is belt to that
      // braces: a `migrated` that somehow carried one would still be told, and could
      // not be rendered as a clean success that says every image came with it.
      const disclosure = externalOnlyDisclosure(state);
      const withDisclosure = state.kind === 'partial' || state.externalOnlyAttachments > 0;
      return {
        kind: state.kind,
        tone: withDisclosure ? 'attention' : 'success',
        glyph: withDisclosure ? '!' : '✓',
        statusLabel: withDisclosure ? 'Finished, with something to know' : 'Finished',
        heading: withDisclosure
          ? 'The update finished. Some image data is not on this device.'
          : 'The update finished',
        summary: [
          'Your data is now read from a newer store on this device. The copy that was already here is still kept, and nothing was removed.',
          // Only true when the count says so. On a clean success the app really does
          // hold every image it listed, and saying so is the useful reassurance.
          ...(state.externalOnlyAttachments === 0
            ? ['Every image that was listed has its data on this device, so a backup can include it.']
            : []),
        ],
        tally: [plural(state.counts.subjects, 'subject')],
        disclosureHeading: disclosure.length === 0 ? null : 'Not on this device',
        disclosure,
        diagnostics: disclosedLines(state),
        stageSentence: null,
        succeeded: true,
        succeededWithDisclosure: withDisclosure,
        retryable: false,
      };
    }

    case 'recovery-required': {
      // Read the literals rather than assuming them. The core guarantees both are
      // `true` in every recovery state, and a screen that hard-coded the sentence
      // would keep reassuring a learner about a state it had not checked.
      const intact: boolean = state.dataIsIntact;
      const legacyAuthoritative: boolean = state.legacyAuthoritative;
      const code = diagnosticCode(state.recovery.code);
      const stage = diagnosticCode(state.recovery.stage);
      return {
        kind: 'recovery-required',
        tone: 'problem',
        glyph: '×',
        statusLabel: 'Needs attention',
        heading: 'The app could not update how it stores your data',
        summary: [
          intact
            ? 'Nothing was lost. Your data is still on this device.'
            : 'This device may not be able to show all of your data right now.',
          legacyAuthoritative
            ? 'The app is still reading the original copy of your data, so you can keep using it as it is.'
            : 'The app is reading a different copy of your data than before, so check a subject before you rely on it.',
          'The app stopped before it switched over, so it did not start using a copy it had not finished checking.',
          state.retryable
            ? 'Trying again is safe: it starts from the same original copy.'
            : 'Trying again will not help right now, because the browser\u2019s on-device database is not available. Nothing about your data changes either way.',
        ],
        tally: [],
        disclosureHeading: null,
        disclosure: [],
        diagnostics: [`Problem code: ${code}`, `Stopped during: ${stepSentence(stage)}`],
        stageSentence: null,
        succeeded: false,
        succeededWithDisclosure: false,
        retryable: state.retryable,
      };
    }
  }
}
