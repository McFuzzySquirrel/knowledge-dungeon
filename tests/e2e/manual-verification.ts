/**
 * The **manual verification record** for Phase 21: its schema, its validator, its default template,
 * and the keyboard and touch walkthroughs a human executes on hardware.
 *
 * ## Why this file exists, and what it is not
 *
 * Phase 21's deliverable list names a "Screen-reader verification record" and "Keyboard and touch
 * interaction scripts", and its scope requires that "actual Safari, Edge, ChromeVox, and
 * touch-screen-reader evidence" be recorded **separately** from automated Playwright evidence. None of
 * that exists, and none of it can be created here: this repository's automation runs in a Linux
 * container with no Chromebook, no tablet, no touch hardware, no ChromeVox, no TalkBack, no Safari,
 * and no Edge. So the five gates in `PHYSICAL_DEVICE_GATES` are undischarged, and no amount of green
 * output from this host changes that.
 *
 * What *can* be built on this host is the thing that makes them dischargeable by someone who does have
 * the hardware: a written procedure, a fixed result shape, a validator, and a verdict line per gate
 * that currently reads `UNVERIFIED`.
 *
 * This is **not** an accessibility conformance framework. It is the minimum a record needs to be
 * trustworthy: a schema with no place for a claim the observer cannot support, and a validator that
 * refuses a record claiming more than its own fields justify.
 *
 * ## The evidence-class rule, stated once and enforced in code
 *
 * `EVIDENCE_CLASSES` in `./support-matrix` has four values. Three of them describe things a machine
 * produced:
 *
 * | class | produced by |
 * | --- | --- |
 * | `emulated-viewport` | Playwright viewport and touch emulation |
 * | `engine-automation` | a Playwright-bundled browser engine |
 * | `branded-channel-automation` | an installed branded browser channel |
 *
 * The fourth, **`physical-device-manual`**, describes a person using real hardware with a real
 * assistive technology. `tests/e2e/support-matrix.test.ts` already asserts that **no matrix entry**
 * claims it, and `tests/phase21/infraA11ySuite.test.ts` asserts the same of the audit's cell plan,
 * because those two are places an automated run could silently promote itself.
 *
 * This file adds the third place it could happen: **a person writing the record**. The rules below are
 * what make the promotion mechanical rather than a matter of care:
 *
 * 1. **A record entry carries an `evidenceClass` that is read, not chosen.** It is
 *    {@link MANUAL_EVIDENCE_CLASS}, and it is a constant with no other members. There is no field on
 *    the record from which `emulated-viewport` could be selected.
 * 2. **A verdict may only be `discharged` when the entry carries the full hardware attestation** -
 *    device model, OS version, browser version, the assistive technology and its version, the
 *    operator, and an ISO date. Absent any one of them the verdict stays `unverified`, whatever the
 *    rest of the entry says. That is the direction that matters: a partially filled record reads as
 *    unverified, so an incomplete run cannot be mistaken for a completed one.
 * 3. **No automated cell can be named as the evidence for a manual gate.** {@link validateRecord}
 *    rejects any entry whose `evidence.cells` contains a matrix project whose own `evidenceClass` is
 *    not `physical-device-manual` - which is all eight of them. This is the rule that makes
 *    "the `tablet` Playwright project passed, so the tablet gate is discharged" an *error* rather
 *    than a plausible sentence.
 * 4. **The matrix stays the authority.** The validator imports `SUPPORT_MATRIX` and
 *    `PHYSICAL_DEVICE_GATES` rather than restating them, so a matrix change cannot leave this file
 *    disagreeing with it.
 * 5. **A record can never discharge a gate the phase did not declare.** Gate ids are checked against
 *    `PHYSICAL_DEVICE_GATES`, so an invented gate is rejected.
 *
 * ## What a passing record still does not establish
 *
 * A `discharged` gate means a named person, on named hardware, with named assistive technology,
 * observed the named checklist and wrote down what they saw. It is **not** WCAG conformance, not an
 * audit, and not a statement about any browser or device nobody tested. Each gate's own
 * `doesNotProve` in the procedure says so in words, because the sentence a reader needs is the one
 * that says what the evidence is not.
 *
 * ## Privacy
 *
 * The record describes devices, versions and observations. It has no field for a subject name, a note
 * body, an attachment, a progression record, a statistic, or a preference, and {@link validateRecord}
 * rejects unknown top-level and per-entry keys - so a learner datum cannot be filed into this schema by
 * accident any more than by intent. Free-text observation notes are length-bounded, and the validator
 * requires them to be prose rather than identifiers.
 *
 * No network, no filesystem, no browser: this module is pure, and it is what makes it safe for
 * `npm test` to import.
 */

import {
  EVIDENCE_CLASSES,
  PHYSICAL_DEVICE_GATES,
  SUPPORT_MATRIX,
  type EvidenceClass,
} from './support-matrix';

/** The record's own schema version. Bumped only when a field changes meaning, not when one is added. */
export const MANUAL_RECORD_SCHEMA_VERSION = 1;

/**
 * The **only** evidence class a manual record entry may carry.
 *
 * A single-member constant rather than a field the observer fills in, and that is the whole mechanism.
 * The other three classes in `EVIDENCE_CLASSES` describe machine-produced evidence; if a manual record
 * could carry one of them, an observer could file an emulated viewport run as a manual result and the
 * record would read as a device check. It cannot: there is no such field.
 *
 * Asserted against the matrix's own vocabulary by `tests/e2e/manualVerificationRecord.test.ts`, so
 * the constant cannot become a value the matrix does not define - which is what would turn the
 * restriction into a rename.
 */
export const MANUAL_EVIDENCE_CLASS = 'physical-device-manual' as const;
export type ManualEvidenceClass = typeof MANUAL_EVIDENCE_CLASS;

/**
 * The four verdicts, and what each one means in one clause.
 *
 * `unverified` is the default and the one almost every entry will hold, so it is named rather than
 * left implicit: an empty or absent entry is not a pass, it is an absence.
 */
export const MANUAL_VERDICTS = Object.freeze(['unverified', 'discharged', 'refused', 'blocked'] as const);
export type ManualVerdict = (typeof MANUAL_VERDICTS)[number];

/**
 * The gate ids this phase must discharge, read from the matrix rather than retyped.
 *
 * Held as its own export so a caller does not have to reach into the matrix for the ids, and so a
 * record validated against a hand-written list of five is a mistake the validator can catch.
 */
export const MANUAL_GATE_IDS: readonly string[] = Object.freeze(
  PHYSICAL_DEVICE_GATES.map((gate) => gate.id),
);

/**
 * Playwright projects a manual record may **not** cite as evidence.
 *
 * Every one of the eight, read from the matrix. The list is derived, not maintained, so a ninth cell
 * cannot be added to the matrix and cited by a record without the validator noticing.
 */
export const AUTOMATED_CELL_EVIDENCE_CLASSES: readonly EvidenceClass[] = Object.freeze(
  [...new Set(SUPPORT_MATRIX.map((entry) => entry.evidenceClass))].filter(
    (value): value is EvidenceClass => value !== MANUAL_EVIDENCE_CLASS,
  ),
);

/** One thing the observer did, and what they saw. Bounded, and free of anything identifying. */
export interface ManualObservation {
  /**
   * The checklist step id this observation answers, from {@link MANUAL_CHECKLIST}.
   *
   * Checked against that list, so an observation cannot be recorded against a step nobody wrote and
   * then counted as evidence for one somebody did.
   */
  readonly stepId: string;
  /** What the observer saw or heard, in their words. Bounded; never a subject name or a note body. */
  readonly note: string;
  /**
   * Whether the step's own pass criterion was met.
   *
   * Separate from `note` because the note is prose and the verdict is a judgement, and a record where
   * one field silently does both is a record whose pass is unmeasurable.
   */
  readonly outcome: 'met' | 'not-met' | 'not-run';
}

/**
 * The hardware an observation was made on. Every field is required before a gate can be discharged.
 *
 * Versions are strings because the useful value is the one the platform prints - "ChromeOS 126.0.6478.17",
 * "iOS 17.5.1" - and normalising them into numbers would lose the build a reader needs to reproduce.
 * All of them are length-bounded and none of them is a path, a hostname, or an account.
 */
export interface ManualEvidence {
  /** Device class, from a closed list. A consumer laptop is not a Chromebook. */
  readonly device: ManualDeviceKind;
  /** The model, e.g. "Pixelbook Go". Free text, bounded, never a serial number. */
  readonly deviceModel: string;
  /** Operating system and version, as the platform reports it. */
  readonly operatingSystem: string;
  /** Browser and version, as the platform reports it. */
  readonly browser: string;
  /** The assistive technology, or the literal `none` for the touch-hardware gate without one. */
  readonly assistiveTechnology: string;
  /** Its version when it has one, or `none`. */
  readonly assistiveTechnologyVersion: string;
  /** Who ran it. A name or handle, so an unattributed observation is visibly unattributed. */
  readonly operator: string;
  /** ISO-8601 date, `YYYY-MM-DD`. A date is enough; a timestamp invites clock-skew arguments. */
  readonly performedOn: string;
  /** The recorded artifact identity this was run against, so the evidence names what it describes. */
  readonly artifactRef: string;
}

/**
 * Device classes. Deliberately **not** the matrix's `FORM_FACTORS`.
 *
 * The matrix's form factors are emulated viewports and the matrix says so in their own `claim`
 * strings; reusing them here would let `tablet-portrait` - a Playwright project - be typed into a
 * manual record as though it were an iPad. These are physical hardware classes, and `chromebook` here
 * means a ChromeOS device in a learner's hands rather than a 1366x768 window.
 */
export const MANUAL_DEVICE_KINDS = Object.freeze([
  'chromebook',
  'android-tablet',
  'ios-tablet',
  'macos-laptop',
  'windows-laptop',
  'linux-laptop',
] as const);
export type ManualDeviceKind = (typeof MANUAL_DEVICE_KINDS)[number];

/** One gate's recorded outcome. */
export interface ManualRecordEntry {
  /** One of {@link MANUAL_GATE_IDS}. Nothing else is accepted. */
  readonly gateId: string;
  readonly verdict: ManualVerdict;
  /**
   * Always {@link MANUAL_EVIDENCE_CLASS}. Present on every entry so a reader never has to infer the
   * evidence class from the file it lives in.
   */
  readonly evidenceClass: ManualEvidenceClass;
  /**
   * Hardware attestation. `null` on an unverified entry, which is what keeps "no hardware named"
   * from reading as "hardware implied".
   */
  readonly evidence: ManualEvidence | null;
  /** Which automated cells this entry is **not** derived from. Empty on a genuine manual run. */
  readonly notDerivedFrom: readonly string[];
  readonly observations: readonly ManualObservation[];
  /** Why the verdict is what it is. Required on `refused` and `blocked`, forbidden to be empty. */
  readonly note: string;
}

/** A whole record: the five gates, and the claim boundary a reader needs with them. */
export interface ManualVerificationRecord {
  readonly schemaVersion: number;
  /** The phase this record is evidence for, as written in the plan. */
  readonly phase: string;
  /**
   * The human-readable statement of what the record is. Fixed text, not a free field: the boundary is
   * the part that must not vary between records, so it is written once here.
   */
  readonly claimBoundary: string;
  readonly entries: readonly ManualRecordEntry[];
}

/* ── The checklist ────────────────────────────────────────────────────────────── */

/**
 * One observable step, with the thing that makes it pass.
 *
 * ## Why the pass criterion is part of the step and not a separate verdict
 *
 * A procedure that says "check the drawer" without saying what a correct drawer looks like produces
 * an observation that cannot be acted on, and the reader has to decide alone whether they saw a
 * defect - which is the judgement the record was supposed to preserve. Each criterion below names the
 * observable that must hold.
 *
 * The criteria are written to be checkable by a person looking at a screen and hearing a voice. None of
 * them says "feels accessible", and none requires the observer to know anything about ARIA to reach a
 * yes or no.
 */
export interface ManualChecklistStep {
  readonly id: string;
  /** What to do. Written for someone who has never seen this codebase. */
  readonly action: string;
  /** What to look at, and what must be true to pass. */
  readonly passCriterion: string;
  /** A known failure that must count as a failure, stated so it cannot be argued past. */
  readonly countsAsFailure: string;
}

/**
 * Per-gate checklists. Keyed by gate id.
 *
 * These are the manual half of Phase 21's coverage. `tests/e2e/a11y-matrix.ts` carries the
 * automated half, and its `A11Y_UNSCANNED_SURFACES` names seven surfaces with no automated scan:
 * Creator, Scribe, Archaeologist, Fishing, Statistics, Data Center, and the share dialogs. Those
 * surfaces are checked here, by hand, and only here - which is precisely why this list is long and
 * why nothing in it may be discharged by an automated cell.
 */
export const MANUAL_CHECKLIST: Readonly<Record<string, readonly ManualChecklistStep[]>> = Object.freeze({
  'physical-chromebook-screen-reader': Object.freeze([
    {
      id: 'cb-01',
      action:
        'On the Chromebook, open the built-in browser and load the **recorded production artifact** over its real origin ' +
        '(see the procedure in docs: `npm run build:web && npm run record:web-artifact`, then serve `dist/`). ' +
        'Wait for the "Knowledge Dungeon" heading to appear.',
      passCriterion:
        'The Welcome screen appears and ChromeVox announces it without the page having to be clicked first.',
      countsAsFailure: 'Any state in which nothing is announced until the learner touches the mouse or trackpad.',
    },
    {
      id: 'cb-02',
      action:
        'Press `Ctrl+Alt+Right` (Next) repeatedly from the top of the document, without touching the trackpad. ' +
        'Listen to what is announced on each stop.',
      passCriterion:
        'Every stop announces a **control** with a name that makes sense out loud - a button, a link, or a form field - ' +
        'and nothing is announced as a bare unlabelled object.',
      countsAsFailure:
        'A stop that announces only a punctuation mark or a glyph ("button", "link", "star"), or nothing at all.',
    },
    {
      id: 'cb-03',
      action:
        'Continue to the **Settings** dialog: reach the village, find the launcher whose spoken name is "Settings", ' +
        'activate it, and inside the dialog press `Tab` through the appearance and language controls.',
      passCriterion:
        'The dialog announces itself by name when it opens; `Tab` cycles **within** the dialog and never returns to the ' +
        'page behind it; and the first control receives focus on open.',
      countsAsFailure:
        'Focus escaping into the page behind the dialog, the dialog announcing only "dialog" with no name, or focus ' +
        'starting on a destructive action.',
    },
    {
      id: 'cb-04',
      action:
        'Inside Settings, with the pointer nowhere near the screen, press the arrow keys to move between the appearance ' +
        'choices. Note what is announced as you move, and what happens to the tab stop.',
      passCriterion:
        'Each arrow press announces the option it lands on **and** says whether it is selected; the whole group is a ' +
        'single tab stop; and the selected state is spoken rather than painted in colour alone.',
      countsAsFailure:
        'Every option being a separate tab stop, no spoken selected or not-selected state, or selection changing only in ' +
        'colour.',
    },
    {
      id: 'cb-05',
      action:
        'Activate a nearby action from the **Nearby** list using only the keyboard: find the list, activate a row, ' +
        'then press `Escape` and confirm focus is back where it was.',
      passCriterion:
        'The action fires; focus returns to the control that opened the dialogue; and nothing was left focused behind it.',
      countsAsFailure: 'Focus landing on the document body, or on a control in the village HUD rather than the opener.',
    },
    {
      id: 'cb-06',
      action:
        'Complete the core loop by keyboard alone: Welcome -> Village -> enter a room -> return to the village.',
      passCriterion: 'Every step is reachable and operable with `Tab`, arrows, `Enter`, `Space` and `Escape`; no step requires a pointer.',
      countsAsFailure: 'Any step that can only be completed by clicking or dragging on the canvas.',
    },
  ]),
  'physical-touch-platform-screen-reader': Object.freeze([
    {
      id: 'touch-01',
      action:
        'On the tablet, enable the platform screen reader (TalkBack on Android, VoiceOver on iPadOS). ' +
        'Open the artifact and reach the village.',
      passCriterion:
        'The village is reachable with the screen reader alone; no step requires a gesture the screen reader cannot ' +
        'produce.',
      countsAsFailure: 'Requiring a multi-finger gesture, a long-press-only action, or hover.',
    },
    {
      id: 'touch-02',
      action:
        '**Open the HUD drawer.** On a coarse or hoverless pointer the village status column is not on screen: ' +
        '`VillageHud` renders only a toggle button and unmounts the entire column - the **Nearby** action list and the ' +
        '**Settings** launcher included. Find the toggle by swiping to it and double-tapping to activate.',
      passCriterion:
        'The toggle announces itself by name and states whether it is collapsed or expanded; after activation a region named ' +
        '"Village status and controls" is present, and the Nearby list and the Settings launcher are reachable inside it.',
      countsAsFailure:
        'The toggle being unnamed, or the drawer contents - Nearby and the Settings launcher - being unreachable while the ' +
        'toggle is announced as collapsed.',
    },
    {
      id: 'touch-03',
      action:
        'With the drawer open, swipe through the **Nearby** action list and activate one row.',
      passCriterion:
        'Each row announces a verb and a target ("Talk to ...", "Interact with ..."); activation produces a result that ' +
        'is announced; and the empty state is spoken rather than being a blank list.',
      countsAsFailure: 'Rows announced with no target, or an empty list announced as nothing at all.',
    },
    {
      id: 'touch-04',
      action:
        'Open the **share card dialog** and swipe through it: the card type selection, the preview, and the close control.',
      passCriterion:
        'The dialog announces its title; the card type group is announced as a group with a selectable state per option; ' +
        'the preview has a description; and the close control is reachable and named.',
      countsAsFailure: 'The dialog being unnamed, or the card type group announced as a flat list with no selected state.',
    },
    {
      id: 'touch-05',
      action:
        'Complete one **core learning action** end to end with the screen reader active - the gate\'s stated requirement.',
      passCriterion:
        'The action completes, its outcome is announced, and no step needed a gesture unavailable to the screen reader.',
      countsAsFailure: 'Any step needing hover, a right-click equivalent, or a precision drag.',
    },
    {
      id: 'touch-06',
      action:
        'With the screen reader off, tap through the same surfaces. Measure the touch targets of the drawer toggle, ' +
        'the nearby rows, and the fishing controls with a ruler or a screenshot ruler.',
      passCriterion: 'Every interactive target is at least 44 by 44 CSS pixels, and none needs a precision gesture.',
      countsAsFailure: 'Any target below 44 by 44 CSS pixels, or an action reachable only by a long press.',
    },
  ]),
  'physical-macos-safari': Object.freeze([
    {
      id: 'safari-01',
      action: 'On the macOS machine, open the artifact in the **released** Safari (not a bundled WebKit build).',
      passCriterion: 'The application loads and reaches the village.',
      countsAsFailure: 'A claim resting on a Playwright WebKit build rather than the released Safari.',
    },
    {
      id: 'safari-02',
      action: 'Complete the core flow in Safari: Welcome -> Village -> room -> back.',
      passCriterion: 'The flow completes with no console error that breaks the product.',
      countsAsFailure: 'Any step failing only in Safari.',
    },
    {
      id: 'safari-03',
      action: 'Open Settings and the share dialog in Safari, then dismiss each with `Escape` and with the close control.',
      passCriterion: 'Both dismiss; focus returns to the opener; focus never lands on the page behind.',
      countsAsFailure: 'Escape being ignored, or focus dropping to the body after close.',
    },
    {
      id: 'safari-04',
      action: 'Turn on VoiceOver and walk the Welcome screen and the village HUD.',
      passCriterion: 'Controls are announced with names; the dialog announces itself by name.',
      countsAsFailure: 'Unnamed controls, or the dialog announced as an unnamed "dialog".',
    },
  ]),
  'physical-windows-desktop-browser': Object.freeze([
    {
      id: 'win-01',
      action: 'On the Windows machine, open the artifact in the learner\'s installed desktop browser (Edge or Chrome).',
      passCriterion: 'The application loads and reaches the village.',
      countsAsFailure: 'Substituting a Playwright Chromium build for the installed browser.',
    },
    {
      id: 'win-02',
      action:
        'Complete the core flow including a **file-picker or download action** where the flow requires one - the Data Center ' +
        'export, or the share card download.',
      passCriterion: 'The picker or download completes, and the result is announced or shown in words.',
      countsAsFailure: 'A silent download, or a picker that opens with no accessible description.',
    },
    {
      id: 'win-03',
      action: 'Open Settings and the Data Center, and dismiss each with `Escape`.',
      passCriterion: 'Both dismiss and restore focus to the opener.',
      countsAsFailure: 'Escape being ignored, or focus lost to the body.',
    },
  ]),
  'physical-linux-desktop-browser': Object.freeze([
    {
      id: 'linux-01',
      action: 'On a supported Linux distribution, open the artifact in the installed browser.',
      passCriterion: 'The application loads and reaches the village.',
      countsAsFailure: 'Claiming per-distribution coverage from a GitHub-hosted runner.',
    },
    {
      id: 'linux-02',
      action: 'Complete the core flow, including a download action.',
      passCriterion: 'The flow completes and the download or picker is operable.',
      countsAsFailure: 'A step that only fails outside the CI container.',
    },
  ]),
});

/**
 * The keyboard-only walkthrough of the **complete learning path**, in order.
 *
 * ## Why it is a list of strings and not a test
 *
 * A Playwright test cannot prove a *human* can do this: it drives the same automation either way. The
 * thing a keyboard-only learner can hit that a keyboard-driven test cannot is a screen reader
 * announcing the wrong thing, or a focus order that is sensible to a script and unusable to a person.
 * Those are exactly what the manual gates are for.
 *
 * ## Why it is nonetheless machine-readable
 *
 * So it cannot silently rot. Each step names a control by its **accessible name as the product writes
 * it**, so a rename in the source is a diff a maintainer sees while reading the procedure, and the
 * names here are the same names the automated suite locates by. A step whose control is gone is a step
 * nobody can run, and a procedure full of unrunnable steps is worse than none.
 *
 * ## How to run it
 *
 * Reload the artifact. Put the mouse down - ideally out of reach - and use only `Tab`, `Shift+Tab`,
 * arrows, `Enter`, `Space` and `Escape`. At each step, note the announced name and whether the step
 * worked. A step "passes" when the named control is reached by `Tab` and the outcome happens on
 * `Enter`/`Space`, with no pointer use anywhere in the path.
 */
export const KEYBOARD_LEARNING_PATH: readonly ManualChecklistStep[] = Object.freeze([
  {
    id: 'kb-01',
    action: 'Load the artifact. Reach the first control with `Tab`.',
    passCriterion: 'The first tab stop is a control with a spoken name, and it is not buried in a landmark nobody is told about.',
    countsAsFailure: 'The first tab stop being a skip link that leads nowhere, or a control with no name.',
  },
  {
    id: 'kb-02',
    action:
      'Move between the four Welcome tabs - "Create / Load", "Player Setup", "Guide", "Data" - with the arrow keys, then ' +
      'switch back with `Tab`.',
    passCriterion:
      'Arrow keys move between tabs, `Tab` leaves the tab list rather than visiting all four, and the selected tab is ' +
      'announced as selected.',
    countsAsFailure: 'All four tabs being separate tab stops, or the selected tab having no announced state.',
  },
  {
    id: 'kb-03',
    action: 'Create or load a subject through the Welcome form, entirely by keyboard, then submit it with `Enter`.',
    passCriterion: 'Every field is reachable and labelled; submission works from the keyboard; the result is announced.',
    countsAsFailure: 'An unlabelled field, or a submit control reachable only by pointer.',
  },
  {
    id: 'kb-04',
    action: 'Start the tutorial and reach the village using only the keyboard.',
    passCriterion: 'Each step of the route is a labelled control; no step needs a click on the canvas.',
    countsAsFailure: 'A tutorial step reachable only by clicking the canvas.',
  },
  {
    id: 'kb-05',
    action: 'In the village, walk the character with the arrow keys or `WASD`.',
    passCriterion: 'Movement works and the character\'s position change is reflected in an announced or visible status.',
    countsAsFailure: 'Movement that only responds to pointer input.',
  },
  {
    id: 'kb-06',
    action: 'Reach the Nearby action list with `Tab` and activate a row with `Enter`.',
    passCriterion: 'The list is reachable, its rows are named with a verb and a target, and activation produces an announced result.',
    countsAsFailure: 'The list being canvas-only, or rows named without a target.',
  },
  {
    id: 'kb-07',
    action: 'Enter a room, then move to the **Creator** workspace and use its topic tools.',
    passCriterion:
      'The workspace opens from a labelled control; its regions are announced as regions; a next-action recommendation ' +
      'moves focus to the control it names; and a topic can be added by keyboard.',
    countsAsFailure: 'The workspace being canvas-only, or focus moving nowhere when a next action is chosen.',
  },
  {
    id: 'kb-08',
    action: 'Switch to the **Scribe** and submit a note, then to the **Archaeologist** and rate a room.',
    passCriterion:
      'Each switch is a labelled control; each workspace announces its phase in words; submission and rating work by ' +
      'keyboard; and progress is not communicated by colour alone.',
    countsAsFailure: 'A phase being distinguishable only by colour, or a control reachable only by pointer.',
  },
  {
    id: 'kb-09',
    action: 'Open **Statistics** and read a total, then close it with `Escape`.',
    passCriterion: 'The dialog announces its title, its content is readable text rather than an image, and focus returns to the opener.',
    countsAsFailure: 'Statistics existing only as a canvas drawing, or Escape leaving focus on the body.',
  },
  {
    id: 'kb-10',
    action: 'Go fishing: enter the pond, charge, hook, and keep the catch using only the keyboard.',
    passCriterion:
      'Every fishing control is reachable, the charge control responds to `Space` or `Enter`, the bite window is ' +
      'announced, and the catch is announced as a result.',
    countsAsFailure: 'A fishing action reachable only by pointer, or the bite window signalled only by colour.',
  },
  {
    id: 'kb-11',
    action: 'Open the **Data Center** and walk its tabs, then dismiss it with `Escape`.',
    passCriterion: 'The tab list is a single tab stop with arrow-key movement, and each panel is associated with its tab.',
    countsAsFailure: 'Tabs without `aria-selected` state, or panels not reachable from their tab.',
  },
  {
    id: 'kb-12',
    action: 'Open **Settings**, move within its option groups with the arrows, then dismiss with `Escape`.',
    passCriterion: 'Each group is a single tab stop, arrow keys move and select within it, and focus returns to the opener.',
    countsAsFailure: 'Every option being its own tab stop, or Escape not restoring focus.',
  },
  {
    id: 'kb-13',
    action: 'Open the **share card dialog**, change the card type with the arrows, and dismiss it.',
    passCriterion:
      'The dialog is named, the card type group announces a selected state, and dismissing restores focus to the opener.',
    countsAsFailure: 'The dialog being unnamed, or the card type group having no announced selection.',
  },
  {
    id: 'kb-14',
    action: 'Repeat the whole path once at **200% browser zoom** and once at a 320 CSS-pixel-wide window.',
    passCriterion: 'Nothing is clipped, no control is unreachable, and no horizontal scrolling is needed to reach a control.',
    countsAsFailure: 'A control that cannot be reached at either setting.',
  },
]);

/**
 * The keyboard walkthrough of the **three worlds' DOM mirrors**.
 *
 * Each world is a PixiJS canvas, and each has a DOM mirror that carries the same actions. The mirror is
 * the accessibility route for the canvas, so it has to be operable on its own: a mirror that only
 * works when the canvas is visible proves nothing about a learner who cannot see the canvas.
 *
 * The three, and the surface each one lives on:
 *
 * - **Village** - the Nearby list inside the HUD, which on a touch device is inside the drawer.
 * - **Dungeon** - the "Dungeon actions" group below the canvas.
 * - **Fishing** - the fishing controls group, including the shore-walk pair.
 */
export const WORLD_DOM_MIRROR_WALKTHROUGHS: readonly ManualChecklistStep[] = Object.freeze([
  {
    id: 'mirror-village-01',
    action:
      'In the village, move the character next to a building or a villager with the keyboard, then `Tab` to the Nearby list.',
    passCriterion:
      'The list is inside a named region, each row names a verb and a target, and the list updates as the character moves.',
    countsAsFailure: 'The list not updating, or rows with no target in their name.',
  },
  {
    id: 'mirror-village-02',
    action: 'Activate a Nearby row with `Enter`, and confirm the same effect happens as pressing `E` on the canvas.',
    passCriterion: 'Both routes produce the same visible and announced result.',
    countsAsFailure: 'The DOM route producing a different result from the canvas route.',
  },
  {
    id: 'mirror-dungeon-01',
    action: 'Enter a dungeon and `Tab` to the "Dungeon actions" group.',
    passCriterion:
      'The group announces its name; each control has a name and a description; and an action the world cannot currently ' +
      'perform is disabled rather than focusable-and-inert.',
    countsAsFailure: 'A focusable control that does nothing, or a control with no spoken description.',
  },
  {
    id: 'mirror-dungeon-02',
    action: 'Activate a dungeon action from the mirror and confirm the canvas responds.',
    passCriterion: 'The action changes the world and the per-control status line updates in words.',
    countsAsFailure: 'The mirror firing with no visible change, or the status line staying empty.',
  },
  {
    id: 'mirror-fishing-01',
    action: 'Enter the pond and `Tab` through the fishing controls, including the "Walk along the shore" group.',
    passCriterion:
      'The charge, hook, and continue controls are all reachable; the two walk controls are separate buttons rather than ' +
      'one directional pad; and each announces what it does.',
    countsAsFailure: 'A fishing action reachable only from the canvas, or the walk controls being a single four-way button.',
  },
  {
    id: 'mirror-fishing-02',
    action: 'Charge and release with `Space`, then hook with `Enter` inside the bite window.',
    passCriterion: 'The charge meter is announced as a value in words, the bite window is announced, and the catch is announced.',
    countsAsFailure: 'The bite window being signalled only by colour, or the catch not being announced.',
  },
]);

/* ── The claim boundary ────────────────────────────────────────────────────────── */

/**
 * The sentence every record carries, fixed here so it cannot vary between records.
 *
 * Fixed text rather than a field for exactly the reason the rest of this file is shaped the way it is:
 * the boundary is the part of the record a reader needs most and the part a hurried observer is most
 * likely to trim.
 */
export const MANUAL_CLAIM_BOUNDARY =
  'This is a manual observation record from named hardware with named assistive technology. It is not a WCAG ' +
  'conformance claim, not an audit, and not a statement about any browser, device or operating-system version nobody ' +
  'tested. A discharged gate records what one operator saw on one device on one date against one recorded artifact.';

/* ── Validation ────────────────────────────────────────────────────────────────── */

/** The keys an entry may carry. An unknown key is a problem, not an extension point. */
const ENTRY_KEYS: readonly string[] = Object.freeze([
  'gateId',
  'verdict',
  'evidenceClass',
  'evidence',
  'notDerivedFrom',
  'observations',
  'note',
]);

const EVIDENCE_KEYS: readonly string[] = Object.freeze([
  'device',
  'deviceModel',
  'operatingSystem',
  'browser',
  'assistiveTechnology',
  'assistiveTechnologyVersion',
  'operator',
  'performedOn',
  'artifactRef',
]);

const RECORD_KEYS: readonly string[] = Object.freeze(['schemaVersion', 'phase', 'claimBoundary', 'entries']);

/** Longest accepted value for any free-text field. Bounded so a record cannot become a data dump. */
const MAX_TEXT = 300;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKLIST_STEP_ID = /^[a-z]+-[0-9]{2}$/;

function problem(list: string[], message: string): void {
  list.push(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A bounded, non-empty free-text field, or `null` with the problems recorded.
 *
 * Returning the accepted value lets a caller reuse the same read for validation and for a later
 * comparison, so a field is not validated once and then trusted separately.
 */
function checkText(problems: string[], label: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problem(problems, `${label} must be a non-empty string.`);
    return null;
  }
  if (value.length > MAX_TEXT) {
    problem(problems, `${label} is ${value.length} characters; the limit is ${MAX_TEXT}.`);
    return null;
  }
  return value;
}

/**
 * Validate one record, returning human-readable problems. **Empty means valid.**
 *
 * Returned rather than thrown, for the reason every other validator in this repository does it: the
 * caller wants to print all the problems at once, and an exception that stops at the first one makes a
 * malformed record take several edits to fix instead of one.
 *
 * ## The four rules that do the real work
 *
 * 1. {@link MANUAL_EVIDENCE_CLASS} is compared, so a record carrying an automated class is rejected.
 * 2. A `discharged` verdict requires every field of {@link ManualEvidence} to be present and valid,
 *    so a partial attestation cannot discharge a gate.
 * 3. `notDerivedFrom` is checked against the matrix's own eight projects, and any name that is a
 *    matrix project is a problem - the rule that makes "the `tablet` project passed" an error.
 * 4. Every observation's `stepId` must exist in that gate's {@link MANUAL_CHECKLIST}.
 */
export function validateRecord(
  record: unknown,
  gates: readonly { id: string }[] = PHYSICAL_DEVICE_GATES,
): readonly string[] {
  const problems: string[] = [];

  if (!isPlainObject(record)) {
    return ['the record must be an object.'];
  }
  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.includes(key)) {
      problem(
        problems,
        `unknown top-level key "${key}". The record carries a fixed set so a field nobody validated cannot hold ` +
          'anything, including learner data.',
      );
    }
  }
  if (record.schemaVersion !== MANUAL_RECORD_SCHEMA_VERSION) {
    problem(
      problems,
      `schemaVersion must be ${MANUAL_RECORD_SCHEMA_VERSION}; the record says ${JSON.stringify(record.schemaVersion)}.`,
    );
  }
  if (typeof record.phase !== 'string' || record.phase.trim().length === 0) {
    problem(problems, 'phase must be a non-empty string.');
  }
  if (record.claimBoundary !== MANUAL_CLAIM_BOUNDARY) {
    problem(
      problems,
      'claimBoundary must be the MANUAL_CLAIM_BOUNDARY text, verbatim. The boundary is fixed rather than written ' +
        'per record so it cannot be trimmed.',
    );
  }
  if (!Array.isArray(record.entries)) {
    return [...problems, 'entries must be an array.'];
  }

  const seen = new Set<string>();
  for (const [index, raw] of (record.entries as unknown[]).entries()) {
    const label = `entries[${index}]`;
    if (!isPlainObject(raw)) {
      problem(problems, `${label} must be an object.`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!ENTRY_KEYS.includes(key)) {
        problem(problems, `${label} has unknown key "${key}".`);
      }
    }
    const gateId = raw.gateId;
    if (typeof gateId !== 'string' || !MANUAL_GATE_IDS.includes(gateId)) {
      problem(
        problems,
        `${label} names gate "${String(gateId)}", which is not one of the ${MANUAL_GATE_IDS.length} gates this phase ` +
          'declared. A record cannot discharge a gate that does not exist.',
      );
      continue;
    }
    if (seen.has(gateId)) {
      problem(problems, `${label} repeats gate "${gateId}"; each gate appears once.`);
      continue;
    }
    seen.add(gateId);

    // Rule 1: the evidence class is read, never chosen.
    if (raw.evidenceClass !== MANUAL_EVIDENCE_CLASS) {
      problem(
        problems,
        `${label} (${gateId}) carries evidenceClass ${JSON.stringify(raw.evidenceClass)}. A manual record may carry only ` +
          `"${MANUAL_EVIDENCE_CLASS}". The automated classes describe machine-produced evidence, and letting a record ` +
          'carry one is how an emulated viewport becomes a device check.',
      );
    }

    const verdict = raw.verdict;
    if (!MANUAL_VERDICTS.includes(verdict as ManualVerdict)) {
      problem(
        problems,
        `${label} (${gateId}) has verdict ${JSON.stringify(verdict)}; it must be one of ${MANUAL_VERDICTS.join(', ')}.`,
      );
    }

    // Rule 2: a discharge needs a full attestation.
    if (verdict === 'discharged') {
      if (!isPlainObject(raw.evidence)) {
        problem(
          problems,
          `${label} (${gateId}) is marked "discharged" with no hardware attestation. A discharge requires a device, a ` +
            'device model, an operating-system version, a browser version, the assistive technology and its version, an ' +
            'operator, a date, and the recorded artifact it was run against.',
        );
      } else {
        problems.push(...validateEvidence(`${label} (${gateId})`, raw.evidence));
      }
    } else if (raw.evidence !== null && raw.evidence !== undefined) {
      problem(
        problems,
        `${label} (${gateId}) carries hardware evidence but its verdict is "${String(verdict)}". Evidence without a ` +
          'discharge is fine; a discharge without evidence is not.',
      );
    }

    // Rule 3: no automated cell may be cited.
    if (!Array.isArray(raw.notDerivedFrom)) {
      problem(problems, `${label} (${gateId}) must carry notDerivedFrom as an array.`);
    } else {
      for (const cited of raw.notDerivedFrom as unknown[]) {
        const project = SUPPORT_MATRIX.find((entry) => entry.project === cited);
        if (project !== undefined) {
          problem(
            problems,
            `${label} (${gateId}) names automated cell "${cited}" (${project.evidenceClass}). A manual gate cannot be ` +
              'derived from an automated cell; if the Playwright run informed this observation, the observation is ' +
              `automated evidence and belongs in the runner's report, not here.`,
          );
        } else if (typeof cited !== 'string' || cited.trim().length === 0) {
          problem(problems, `${label} (${gateId}) has a non-string entry in notDerivedFrom.`);
        }
      }
    }

    // Rule 4: observations answer declared steps only.
    if (!Array.isArray(raw.observations)) {
      problem(problems, `${label} (${gateId}) must carry observations as an array.`);
    } else {
      const checklist = MANUAL_CHECKLIST[gateId] ?? [];
      for (const [obsIndex, observation] of (raw.observations as unknown[]).entries()) {
        const obsLabel = `${label} (${gateId}) observations[${obsIndex}]`;
        if (!isPlainObject(observation)) {
          problem(problems, `${obsLabel} must be an object.`);
          continue;
        }
        if (
          typeof observation.stepId !== 'string' ||
          !CHECKLIST_STEP_ID.test(observation.stepId)
        ) {
          problem(problems, `${obsLabel} stepId must look like "cb-01".`);
          continue;
        }
        if (!checklist.some((step) => step.id === observation.stepId)) {
          problem(
            problems,
            `${obsLabel} answers step "${observation.stepId}", which is not a step of the "${gateId}" checklist.`,
          );
        }
        checkText(problems, `${obsLabel} note`, observation.note);
        if (!['met', 'not-met', 'not-run'].includes(observation.outcome as string)) {
          problem(problems, `${obsLabel} outcome must be "met", "not-met" or "not-run".`);
        }
      }
    }

    if (typeof raw.note !== 'string') {
      problem(problems, `${label} (${gateId}) must carry a note string.`);
    } else if ((verdict === 'refused' || verdict === 'blocked') && raw.note.trim().length === 0) {
      problem(
        problems,
        `${label} (${gateId}) is "${verdict}" with an empty note. A refused or blocked gate records why.`,
      );
    }
  }

  for (const gate of gates) {
    if (!seen.has(gate.id)) {
      problem(problems, `no entry for declared gate "${gate.id}"; every declared gate appears in the record.`);
    }
  }

  return problems;
}

function validateEvidence(label: string, evidence: Record<string, unknown>): readonly string[] {
  const problems: string[] = [];
  for (const key of Object.keys(evidence)) {
    if (!EVIDENCE_KEYS.includes(key)) {
      problem(
        problems,
        `${label} evidence has unknown key "${key}". The evidence has a fixed shape so no field can hold a serial ` +
          'number, an account, or anything else the schema was not written to accept.',
      );
    }
  }
  if (!MANUAL_DEVICE_KINDS.includes(evidence.device as ManualDeviceKind)) {
    problem(
      problems,
      `${label} evidence.device is ${JSON.stringify(evidence.device)}; it must be one of ` +
        `${MANUAL_DEVICE_KINDS.join(', ')}.`,
    );
  }
  for (const key of EVIDENCE_KEYS) {
    if (key === 'device') continue;
    checkText(problems, `${label} evidence.${key}`, evidence[key]);
  }
  if (typeof evidence.performedOn === 'string' && !ISO_DATE.test(evidence.performedOn)) {
    problem(problems, `${label} evidence.performedOn must be an ISO date, YYYY-MM-DD.`);
  }
  return problems;
}

/* ── The default record ────────────────────────────────────────────────────────── */

/**
 * The record every gate starts on: `unverified`, no attestation, no observations.
 *
 * ## Why the default is a record and not an empty file
 *
 * An absent record and a record whose five gates all read `unverified` are the same fact, and this
 * makes that fact *visible* rather than inferred from a file's non-existence. It also means the shape
 * is executable: `validateRecord(emptyRecord())` returns `[]` today, and the first observation a human
 * adds is a change to a file that already has every field in it.
 */
export function emptyRecord(): ManualVerificationRecord {
  return {
    schemaVersion: MANUAL_RECORD_SCHEMA_VERSION,
    phase: 'Phase 21',
    claimBoundary: MANUAL_CLAIM_BOUNDARY,
    entries: PHYSICAL_DEVICE_GATES.map((gate) => ({
      gateId: gate.id,
      verdict: 'unverified' as const,
      evidenceClass: MANUAL_EVIDENCE_CLASS,
      evidence: null,
      notDerivedFrom: [] as readonly string[],
      observations: [] as readonly ManualObservation[],
      note: '',
    })),
  };
}

/**
 * One line per gate, and the headline a maintainer reads.
 *
 * ## Why a table and not a boolean
 *
 * "The manual gates pass" is a claim about five different devices, three different platforms, and two
 * different assistive technologies. Collapsed to a boolean, a maintainer reading a release note cannot
 * tell which one is missing - and the failure mode this phase exists to prevent is precisely a
 * collapsed claim. Five lines, one per gate, each naming the evidence class, cost nothing.
 */
export function verdictLines(
  record: ManualVerificationRecord,
  gates: readonly { id: string }[] = PHYSICAL_DEVICE_GATES,
): readonly string[] {
  const lines: string[] = [];
  const entries = new Map(record.entries.map((entry) => [entry.gateId, entry]));
  for (const gate of gates) {
    const entry = entries.get(gate.id);
    const verdict = entry?.verdict ?? 'unverified';
    const device = entry?.evidence?.device ?? 'no device recorded';
    lines.push(
      `  ${verdict.toUpperCase().padEnd(11)} ${gate.id.padEnd(38)} ${MANUAL_EVIDENCE_CLASS}  ${device}`,
    );
  }
  return lines;
}

/** How many gates are discharged, and how many the phase declares. */
export function dischargeSummary(
  record: ManualVerificationRecord,
  gates: readonly { id: string }[] = PHYSICAL_DEVICE_GATES,
): { discharged: number; total: number; complete: boolean } {
  const entries = new Map(record.entries.map((entry) => [entry.gateId, entry]));
  const discharged = gates.filter((gate) => entries.get(gate.id)?.verdict === 'discharged').length;
  return { discharged, total: gates.length, complete: discharged === gates.length };
}

/**
 * Evidence classes the matrix declares, minus the manual one.
 *
 * Exported so the gate test can assert the restriction is a restriction rather than a rename: if the
 * matrix ever dropped the automated classes, this list would shrink and the validator would be
 * admitting more than it intends to.
 */
export { EVIDENCE_CLASSES };