/**
 * The static ids and attribute values the assistance surfaces expose to tests.
 *
 * ## The Phase 17 rule this file is written against
 *
 * "A test-visible attribute which lies is worse than one that is absent." So every value here
 * is either a **static literal** or a member of a closed vocabulary the component itself
 * chooses, and:
 *
 * - **No opaque identifier.** No subject id, room id, note id, or session id reaches the DOM,
 *   because an id ends up in test output, in screenshots, and in issue reports, and those are
 *   app-minted values that mean nothing to a learner and single out one person's records.
 * - **No raw engine vocabulary either**, except where it *is* the vocabulary a test needs. The
 *   suggestion kind and the reason code are closed, app-owned, non-learner strings - the same
 *   status `studyStatsTestIds.ts` gives a local calendar day. What never appears is a value
 *   derived from what the learner wrote.
 * - **Rendered unconditionally by the element that owns it.** An attribute that appears only
 *   when some other condition happens to hold is one a test can assert and the component can
 *   lie about. Where the card has a choice - zero evidence rows, a suggestion with no room -
 *   the attribute goes on a container that always renders, with the count beside it.
 *
 * ## What is deliberately absent
 *
 * There is **no id for the "nothing to suggest" case**, and no `data-assistance-empty`. A
 * learner who turned assistance off, and a build where the flag is off, and a learner with
 * nothing due, must be unable to tell that the feature exists. An attribute any of the three
 * could carry would be that tell. The absence is the assertion, and
 * `tests/phase19/assistanceUiSilence.test.ts` states it as a byte-comparison of the rendered
 * container across all three.
 */

/** The `data-assistance-*` attribute prefix every id below is written to. */
export const ASSISTANCE_ID_ATTRIBUTE = 'data-assistance-id';

/** The surface-filter attribute, so a test can tell which integration point rendered. */
export const ASSISTANCE_SURFACE_ATTRIBUTE = 'data-assistance-surface';

export const ASSISTANCE_IDS = Object.freeze({
  /** The whole card: the heading, every suggestion, and the advisory note. */
  card: 'assistance-card',
  /** The card's own heading. */
  heading: 'assistance-heading',
  /** The Dismiss control of one suggestion. */
  dismiss: 'assistance-dismiss',
  /** The sentence that replaces a dismissed suggestion. */
  dismissed: 'assistance-dismissed',
  /** The advisory note: nothing here is applied for the learner. */
  advisoryNote: 'assistance-advisory-note',
  /** The settings region. */
  settings: 'assistance-settings',
  /** The settings region's mode choice group. */
  modeGroup: 'assistance-mode-group',
  /** The dismissals block in the settings region. */
  dismissals: 'assistance-dismissals',
  /** The "forget this count" control. */
  clearDismissals: 'assistance-clear-dismissals',
  /** The live status line a screen reader announces for mode changes and dismissals. */
  status: 'assistance-status',
} as const);

export type AssistanceId = (typeof ASSISTANCE_IDS)[keyof typeof ASSISTANCE_IDS];

/**
 * The `data-assistance-suggestion` values: one per suggestion kind.
 *
 * Built from the engine's own exported vocabulary rather than written out again, so a kind
 * added to `ASSISTANCE_SUGGESTION_KINDS` is reachable in a test without this file being edited
 * - and, more importantly, without this file being able to name a kind that does not exist.
 */
export const ASSISTANCE_INTENSITY_VALUES = Object.freeze({
  /** The gentlest presentation. */
  step: 'step',
  /** A cue after hesitation or a low rating. */
  cue: 'cue',
  /** The strongest presentation the engine offers. */
  example: 'example',
} as const);

export type AssistanceIntensityValue =
  (typeof ASSISTANCE_INTENSITY_VALUES)[keyof typeof ASSISTANCE_INTENSITY_VALUES];

/**
 * The attribute names for the numbers a card publishes, each carrying a **number**.
 *
 * Three reasons these exist at all, because "the card shows the priority" is not a testable
 * claim:
 *
 * - `evidence` - the number of evidence rows one suggestion carries. The alternative is counting
 *   `<li>`s inside a list whose children are prose, which would make the assertion depend on
 *   the copy.
 * - `priority` - the engine's own integer score, `0..100`. It is the one number that makes "this
 *   one outranks that one" checkable, and it is published raw rather than as a word so a test
 *   compares numbers and not prose.
 * - `suggestions` - how many suggestions the card is showing. **Always present**, including when
 *   the number is `0`, so a test can distinguish "showing none" from "not a card".
 *
 * Each is written on the element that owns its value, in the same commit, so the number cannot
 * outlive the thing it counts. A `priority` attribute on a container that still shows the old
 * row would be an attribute that lies.
 */
export const ASSISTANCE_COUNT_ATTRIBUTES = Object.freeze({
  /** Evidence rows on one suggestion. */
  evidence: 'data-assistance-evidence-count',
  /** The engine's priority for one suggestion. */
  priority: 'data-assistance-priority',
  /** Suggestions the card is showing. */
  suggestions: 'data-assistance-suggestions',
} as const);

export type AssistanceCountAttribute =
  (typeof ASSISTANCE_COUNT_ATTRIBUTES)[keyof typeof ASSISTANCE_COUNT_ATTRIBUTES];

/**
 * The `data-assistance-kind` attribute: the engine's suggestion kind, on each row.
 *
 * App-owned, closed, non-learner vocabulary - the same status
 * {@link import('./assistanceTestIds').ASSISTANCE_IDS} gives every other value here. Written
 * unconditionally on every row so a test can enumerate the kinds on screen without a
 * conditional lookup.
 */
export const ASSISTANCE_KIND_ATTRIBUTE = 'data-assistance-kind';

/** The `data-assistance-reason` attribute: the engine's reason code, on each row. */
export const ASSISTANCE_REASON_ATTRIBUTE = 'data-assistance-reason';

/**
 * The `data-assistance-intensity` attribute: the engine's chosen intensity, on each row.
 *
 * **Not** the only carrier of urgency. The intensity word is also rendered as text beside it,
 * because an attribute is invisible to a learner and a colour would be the other invisible
 * carrier.
 */
export const ASSISTANCE_INTENSITY_ATTRIBUTE = 'data-assistance-intensity';

/**
 * The class that hides content visually while leaving it available to assistive technology.
 *
 * Not `display: none` and not `visibility: hidden`, both of which remove the text from the
 * accessibility tree as well as the screen. The announcement region's whole job is to be read.
 */
export const ASSISTANCE_SCREEN_READER_ONLY_CLASS = 'assistance-sr-only';