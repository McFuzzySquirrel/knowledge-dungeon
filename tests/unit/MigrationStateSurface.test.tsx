/**
 * Phase 4: the storage-move state surface.
 *
 * The migration state model has four distinguishable outcomes and two of them are
 * easy to render wrongly: a `partial` outcome is a success that carries a
 * disclosure rather than a failure or a clean success, and a
 * `recovery-required` outcome is a failure that lost nothing. This file pins the
 * words, the ARIA semantics, the controls, and the focus behaviour for every
 * state, because the states are codes - a surface that renders them plausibly
 * but wrongly would be indistinguishable from a correct one by reading the code.
 *
 * What is asserted, per state: the exact sentences, the live-region role and
 * politeness, which controls appear, and which do not. Then, across states:
 *
 * - `partial` never reads as a clean success, and a `migrated` state carrying
 *   external-only attachments cannot be produced by the core;
 * - the retry control appears only when the host supplied a callable, disables
 *   while its promise is in flight, and re-renders from the state it returns;
 * - focus moves into the recovery dialog on open, is contained there, and returns
 *   to the opener on close, and Escape closes it only when it is dismissible;
 * - the default build renders nothing at all from this surface.
 *
 * Privacy: every string in this file is fixed and generic. Counts, reason codes,
 * and stage names are the same synthetic values the copy module handles; the one
 * URL-shaped value is a deliberately malformed *reason code* used to prove the
 * surface cannot echo one, and it is never a resolvable address.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MigrationStateSurface } from '@/ui/components/MigrationStateSurface';
import {
  describeMigration,
  diagnosticCode,
  DISCLOSED_PROBLEM_CODE_VOCABULARY,
  VALIDATION_SCOPE_VOCABULARY,
} from '@/ui/components/migrationStateCopy';
import { classifyMigrationReport } from '@/services/persistence/v2/migrationState';
import type {
  MigrationPreviewState,
  MigrationRecoveryRequiredState,
  MigrationRunningState,
  MigrationState,
  MigrationSucceededState,
} from '@/services/persistence/v2/migrationState';
import type { MigrationReport } from '@/services/persistence/v2/schema';
import type { ValidationProblem } from '@/services/persistence/v2/validation';
import { App } from '@/ui/App';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import { resetBootstrap } from '@/application/bootstrap';

const STYLESHEET = join(process.cwd(), 'src', 'styles.css');

const EMPTY_COUNTS = {
  subjects: 0,
  progression: 0,
  sessions: 0,
  preferences: 0,
  shortcuts: 0,
  assistance: 0,
  attachmentMetadata: 0,
  attachmentBlobs: 0,
  customSprites: 0,
  recovery: 0,
} as const;

const NO_LEGACY_KEYS = {
  allowlistedKeys: 0,
  present: 0,
  absent: 0,
  parseErrors: 0,
  unsupportedShapes: 0,
} as const;

/** A fresh mutable array: `MigrationReport.problems` is a mutable field. */
const noDisclosures = (): ValidationProblem[] => [];

// ── State factories ────────────────────────────────────────────────────────

function previewState(overrides: Partial<MigrationPreviewState> = {}): MigrationPreviewState {
  return {
    kind: 'preview',
    repository: 'v2',
    blockingPolicy: 'error-blocks-warning-discloses',
    nextActions: ['start-migration'],
    stagedGenerationId: null,
    previousActiveGenerationId: null,
    activeGenerationFlipped: false,
    counts: { ...EMPTY_COUNTS, subjects: 2, attachmentMetadata: 3 },
    blockingProblems: [],
    disclosedProblems: [],
    disclosedProblemCount: 0,
    unreadableSourceRecords: 0,
    externalOnlyAttachments: 0,
    legacyKeys: NO_LEGACY_KEYS,
    ...overrides,
  };
}

function runningState(overrides: Partial<MigrationRunningState> = {}): MigrationRunningState {
  return {
    kind: 'running',
    repository: 'v2',
    blockingPolicy: 'error-blocks-warning-discloses',
    // The core offers nothing while a move is in flight.
    nextActions: [],
    stagedGenerationId: null,
    previousActiveGenerationId: null,
    activeGenerationFlipped: false,
    counts: { ...EMPTY_COUNTS },
    blockingProblems: [],
    disclosedProblems: [],
    disclosedProblemCount: 0,
    stage: 'stage-records',
    ...overrides,
  };
}

function migratedState(overrides: Partial<MigrationSucceededState> = {}): MigrationSucceededState {
  return {
    kind: 'migrated',
    repository: 'v2',
    blockingPolicy: 'error-blocks-warning-discloses',
    nextActions: [],
    stagedGenerationId: 'gen-storage-move-test',
    previousActiveGenerationId: null,
    activeGenerationFlipped: true,
    counts: { ...EMPTY_COUNTS, subjects: 2 },
    blockingProblems: [],
    disclosedProblems: [],
    disclosedProblemCount: 0,
    hasDisclosure: false,
    externalOnlyAttachments: 0,
    externalOnlyReasons: [],
    contentChecksum: 'sha256-0123456789abcdef',
    receiptId: 'rcpt-0123456789ab',
    ...overrides,
  };
}

function partialState(overrides: Partial<MigrationSucceededState> = {}): MigrationSucceededState {
  return migratedState({
    kind: 'partial',
    nextActions: ['review-disclosures'],
    hasDisclosure: true,
    externalOnlyAttachments: 1,
    externalOnlyReasons: ['historical-external-url'],
    ...overrides,
  });
}

function recoveryState(overrides: Partial<MigrationRecoveryRequiredState> = {}): MigrationRecoveryRequiredState {
  const retryable = overrides.retryable ?? true;
  return {
    kind: 'recovery-required',
    repository: 'v2',
    blockingPolicy: 'error-blocks-warning-discloses',
    nextActions: retryable ? ['retry-migration'] : [],
    stagedGenerationId: 'gen-storage-move-test',
    previousActiveGenerationId: null,
    activeGenerationFlipped: false,
    counts: { ...EMPTY_COUNTS, subjects: 2 },
    blockingProblems: [],
    disclosedProblems: [],
    disclosedProblemCount: 0,
    recovery: { code: 'TRANSACTION_ABORTED', stage: 'stage-records' },
    legacyAuthoritative: true,
    dataIsIntact: true,
    retryable,
    ...overrides,
  };
}

function noSourceDataState(): MigrationState {
  return {
    kind: 'no-source-data',
    repository: 'v2',
    blockingPolicy: 'error-blocks-warning-discloses',
    nextActions: [],
    stagedGenerationId: null,
    previousActiveGenerationId: null,
    activeGenerationFlipped: false,
    counts: { ...EMPTY_COUNTS },
    blockingProblems: [],
    disclosedProblems: [],
    disclosedProblemCount: 0,
    legacyKeys: NO_LEGACY_KEYS,
  };
}

// ── Shared queries ─────────────────────────────────────────────────────────

const START_LABEL = /Update how this device stores my data/;
const RETRY_LABEL = /Try the update again/;
const KEEP_USING_LABEL = /Keep using the app as it is/;

function surface(): HTMLElement {
  return document.querySelector<HTMLElement>('.migration-panel, .migration-dialog') as HTMLElement;
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

/** Every control in the surface, in document order. */
function controls(): HTMLElement[] {
  const root = surface();
  return [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')];
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  resetBootstrap();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetRepositorySelection();
  resetBootstrap();
  vi.restoreAllMocks();
});

// ── 1. Nothing renders for the states that have nothing to say ─────────────

describe('Phase 4 migration surface: states with nothing to say render nothing', () => {
  it('renders no DOM at all when the bootstrap produced no migration', () => {
    const { container } = render(<MigrationStateSurface migration={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders no DOM at all for no-source-data, even with a retry callable available', () => {
    const { container } = render(
      <MigrationStateSurface migration={noSourceDataState()} retryMigration={async () => null} />,
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('describes nothing for either state', () => {
    expect(describeMigration(null)).toBeNull();
    expect(describeMigration(noSourceDataState())).toBeNull();
  });

  it('says nothing about a successful move that carried nothing', () => {
    const vacuous = migratedState({ counts: { ...EMPTY_COUNTS } });
    expect(vacuous.kind).toBe('migrated');
    expect(describeMigration(vacuous)).toBeNull();
    const { container } = render(<MigrationStateSurface migration={vacuous} />);
    expect(container.innerHTML).toBe('');
  });

  it('says nothing about a first-run device, whose only records are app defaults', () => {
    // The measured shape of a brand-new device on the flagged build: the core's
    // emptiness test is defeated by a legacy `knowledge-dungeon:locale` key, so the
    // run reports `migrated` carrying a default preferences record and a default
    // assistance record and nothing else. A learner must not be told their storage
    // was updated when nothing of theirs was carried.
    const firstRun = migratedState({
      counts: { ...EMPTY_COUNTS, preferences: 1, assistance: 1 },
    });
    expect(firstRun.kind).toBe('migrated');
    expect(describeMigration(firstRun)).toBeNull();
    const { container } = render(<MigrationStateSurface migration={firstRun} />);
    expect(container.innerHTML).toBe('');
  });

  it('still reports a first-run device that had a subject, even with no other record', () => {
    const oneSubject = migratedState({ counts: { ...EMPTY_COUNTS, subjects: 1 } });
    expect(describeMigration(oneSubject)).not.toBeNull();
  });

  it('still reports a success that carried a disclosure, however few records', () => {
    const view = describeMigration(
      partialState({ counts: { ...EMPTY_COUNTS }, externalOnlyAttachments: 1, externalOnlyReasons: ['bytes-missing-locally'] }),
    );
    expect(view).not.toBeNull();
    expect(view?.succeededWithDisclosure).toBe(true);
  });

  it('never suppresses a failure, however empty it is', () => {
    const view = describeMigration(recoveryState({ counts: { ...EMPTY_COUNTS } }));
    expect(view).not.toBeNull();
    expect(view?.tone).toBe('problem');
  });
});

// ── 2. preview ─────────────────────────────────────────────────────────────

describe('Phase 4 migration surface: preview is informational', () => {
  it('states that nothing has moved and that the original copy stays', () => {
    render(<MigrationStateSurface migration={previewState()} startMigration={async () => null} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAccessibleName();
    expect(within(status).getByRole('heading', { level: 2 })).toHaveTextContent(
      'The app can update how it stores your data',
    );
    expect(status).toHaveTextContent('Nothing has been moved yet');
    expect(status).toHaveTextContent('still the copy the app reads');
    // The count is a number, not a subject name.
    expect(status).toHaveTextContent('2 subjects');
    expect(status).toHaveTextContent('3 images');
  });

  it('offers a start control only when nextActions includes start-migration', () => {
    const { unmount } = render(
      <MigrationStateSurface migration={previewState()} startMigration={async () => null} />,
    );
    expect(screen.getByRole('button', { name: START_LABEL })).toBeInTheDocument();
    unmount();

    render(
      <MigrationStateSurface
        migration={previewState({ nextActions: [] })}
        startMigration={async () => null}
      />,
    );
    expect(screen.queryByRole('button', { name: START_LABEL })).not.toBeInTheDocument();
  });

  it('offers no start control when the host supplied no callable to honour it with', () => {
    render(<MigrationStateSurface migration={previewState()} />);
    expect(screen.queryByRole('button', { name: START_LABEL })).not.toBeInTheDocument();
    // The notice still renders: the absence of a control is not the absence of news.
    expect(screen.getByRole('status')).toHaveTextContent('Nothing has been moved yet');
  });

  it('does not claim a backup already has image data, and discloses the limit', () => {
    render(<MigrationStateSurface migration={previewState()} startMigration={async () => null} />);
    const text = surface().textContent ?? '';
    expect(text).not.toMatch(/every image/i);
    expect(text).not.toMatch(/nothing leaves your device/i);
    expect(text).not.toMatch(/localstorage/i);
  });
});

// ── 3. running ─────────────────────────────────────────────────────────────

describe('Phase 4 migration surface: running is informational and not a takeover', () => {
  it('names the current step, is a polite live region, and offers no action', () => {
    render(<MigrationStateSurface migration={runningState({ stage: 'validate' })} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('The app is copying your data');
    expect(status).toHaveTextContent('Now: Checking the new records.');
    // Nothing is switched over yet, and the copy says so.
    expect(status).toHaveTextContent('the original copy is still the one being read');
    // The stage is never echoed raw into a learner-facing sentence.
    expect(status).not.toHaveTextContent('validate');

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: START_LABEL })).not.toBeInTheDocument();
  });

  it('exposes an indeterminate progressbar whose name carries the same step in words', () => {
    render(<MigrationStateSurface migration={runningState({ stage: 'validate' })} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAccessibleName('Moving your data. Checking the new records');
    // No invented percentage: a move has no measurable fraction.
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });

  it('falls back to a step-free sentence for a stage it does not recognise', () => {
    render(<MigrationStateSurface migration={runningState({ stage: 'not-a-real-stage' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Now: Working on the next step.');
    expect(screen.getByRole('status')).not.toHaveTextContent('not-a-real-stage');
  });
});

// ── 4. migrated is a clean success ─────────────────────────────────────────

describe('Phase 4 migration surface: migrated', () => {
  it('says the move finished and that nothing was removed', () => {
    render(<MigrationStateSurface migration={migratedState()} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Finished');
    expect(within(status).getByRole('heading', { level: 2 })).toHaveTextContent('The update finished');
    expect(status).toHaveTextContent('now read from a newer store on this device');
    expect(status).toHaveTextContent('still kept, and nothing was removed');
    expect(status).toHaveTextContent('Every image that was listed has its data on this device, so a backup can include it');
    // No disclosure section at all when there is nothing to disclose.
    expect(screen.queryByText('Not on this device')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).not.toBeInTheDocument();
  });

  it('says the state in words as well as in colour, so nothing is colour-only', () => {
    render(<MigrationStateSurface migration={migratedState()} />);
    const status = screen.getByRole('status');
    // The label is what carries the meaning; the glyph is decorative.
    expect(within(status).getByText('Finished')).toBeInTheDocument();
    const glyph = status.querySelector('.migration-glyph');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph?.textContent).toBe('✓');
  });
});

// ── 5. partial is a success with a disclosure ──────────────────────────────

describe('Phase 4 migration surface: partial is a success with a disclosure', () => {
  it('says the move finished and, separately, that image data is not on the device', () => {
    render(<MigrationStateSurface migration={partialState()} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    // The success sentence is present: the move really did finish.
    expect(status).toHaveTextContent('now read from a newer store on this device');
    // And the disclosure is separate, specific, and about availability.
    expect(status).toHaveTextContent('Not on this device');
    expect(status).toHaveTextContent('1 image is listed without its data');
    expect(status).toHaveTextContent('cannot fetch them');
    // The plural form agrees with itself, which a learner notices immediately.
    expect(screen.queryByText(/images iss listed/)).not.toBeInTheDocument();
    expect(status).toHaveTextContent('a backup of this device cannot include them');
    expect(status).toHaveTextContent('The link itself is kept');
  });

  it('explains each reason code in a sentence and never renders the code alone', () => {
    render(
      <MigrationStateSurface
        migration={partialState({
          externalOnlyAttachments: 3,
          externalOnlyReasons: ['historical-external-url', 'bytes-not-recoverable', 'bytes-missing-locally'],
        })}
      />,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('It was saved as a web link, and the app does not download linked images');
    expect(status).toHaveTextContent('Its bytes could not be recovered from the copy this app read.');
    expect(status).toHaveTextContent('It is listed, but its bytes are not held on this device.');
    // The three fixed reason codes are never printed.
    expect(status).not.toHaveTextContent('historical-external-url');
    expect(status).not.toHaveTextContent('bytes-not-recoverable');
    expect(status).not.toHaveTextContent('bytes-missing-locally');
  });

  it('introduces the disclosed problems only when there are any', () => {
    // `review-disclosures` is satisfied by rendering the disclosure, not by a
    // control that would hide it. The note introduces the problem list, so it
    // appears only when that list is non-empty.
    const { unmount } = render(<MigrationStateSurface migration={partialState()} />);
    expect(screen.queryByText(/other differences recorded/)).not.toBeInTheDocument();
    unmount();

    render(
      <MigrationStateSurface
        migration={partialState({
          disclosedProblems: [
            { code: 'unindexed-subject-payload', scope: 'subject', count: 1, severity: 'warning' },
          ],
          disclosedProblemCount: 1,
        })}
      />,
    );
    expect(screen.getByText(/other differences recorded during the update/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Technical details' })).toHaveTextContent(
      '1 unindexed subject payload (subject)',
    );
  });

  it('never renders as a plain success, whatever it is told about the move', () => {
    // A clean run and a disclosed run must be told apart by the headline, the
    // status label, and the presence of the disclosure - not by one of them.
    const { unmount } = render(<MigrationStateSurface migration={migratedState()} />);
    const cleanHeading = screen.getByRole('heading', { level: 2 }).textContent;
    const cleanLabel = screen.getByText('Finished');
    unmount();

    render(<MigrationStateSurface migration={partialState()} />);
    const disclosedHeading = screen.getByRole('heading', { level: 2 }).textContent;
    const disclosedLabel = screen.getByText('Finished, with something to know');

    expect(disclosedHeading).not.toBe(cleanHeading);
    expect(disclosedLabel.textContent).not.toBe(cleanLabel.textContent);
    expect(disclosedHeading).toMatch(/image data is not on this device/i);
    // The clean-run reassurance about image data must be absent.
    expect(screen.getByRole('status')).not.toHaveTextContent('Every image that was listed has its data on this device');
  });

  it('still discloses when handed a migrated state that carries external-only attachments', () => {
    // A state the core cannot produce. The disclosure is decided by the count
    // rather than by `kind`, so a screen cannot be talked out of it.
    render(
      <MigrationStateSurface
        migration={migratedState({ externalOnlyAttachments: 1, externalOnlyReasons: ['bytes-missing-locally'] })}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('1 image is listed without its data');
    expect(status).not.toHaveTextContent('Every image that was listed has its data on this device');
  });

  it('cannot be produced: the core maps any external-only attachment to partial', () => {
    const report: MigrationReport = {
      migrationId: 'mig-storage-move-test',
      status: 'migrated',
      stagedGenerationId: 'gen-storage-move-test',
      activated: true,
      previousActiveGenerationId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      legacyKeys: NO_LEGACY_KEYS,
      subjectSchemaVersions: {},
      progressionSourceVersions: {},
      recordCounts: {
        subjects: 1,
        progression: 0,
        sessions: 0,
        preferences: 0,
        shortcuts: 0,
        assistance: 0,
        attachments: 1,
        attachmentBlobs: 0,
        customSprites: 0,
        recovery: 0,
      },
      attachments: { total: 1, storedBytes: 0, externalOnly: 1 },
      externalOnlyAttachments: [
        {
          attachmentId: 'att-storage-move-test',
          subjectId: 'subj-storage-move-test',
          roomId: 'room-storage-move-test',
          contentHash: null,
          byteLength: null,
          reason: 'historical-external-url',
          sourceType: 'external',
        },
      ],
      problems: noDisclosures(),
      contentChecksum: 'sha256-0123456789abcdef',
      receiptId: 'rcpt-0123456789ab',
      recovery: null,
    };

    const state = classifyMigrationReport(report);
    expect(state.kind).toBe('partial');
    expect(state.kind === 'partial' && state.hasDisclosure).toBe(true);
    expect(state.kind === 'partial' && state.externalOnlyAttachments).toBe(1);
  });
});

// ── 6. recovery-required reassures correctly ───────────────────────────────

describe('Phase 4 migration surface: recovery-required', () => {
  it('states plainly that nothing was lost and that the original copy is still read', () => {
    render(<MigrationStateSurface migration={recoveryState()} retryMigration={async () => null} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { level: 2 })).toHaveTextContent(
      'The app could not update how it stores your data',
    );
    const dialogText = dialog().textContent ?? '';
    expect(dialogText).toContain('Nothing was lost. Your data is still on this device.');
    expect(dialogText).toContain('still reading the original copy of your data');
    expect(dialogText).toContain('stopped before it switched over');
  });

  it('is a modal dialog named by its heading and described by its summary', () => {
    render(<MigrationStateSurface migration={recoveryState()} retryMigration={async () => null} />);
    const node = dialog();
    expect(node).toHaveAttribute('aria-modal', 'true');
    const heading = within(node).getByRole('heading', { level: 2 });
    const headingId = heading.getAttribute('id');
    expect(headingId).toBeTruthy();
    expect(node).toHaveAttribute('aria-labelledby', headingId);
    const describedBy = node.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain('Nothing was lost');
  });

  it('shows the problem code and the step as diagnostic text', () => {
    render(<MigrationStateSurface migration={recoveryState()} retryMigration={async () => null} />);
    const details = screen.getByRole('list', { name: 'Technical details' });
    expect(details).toHaveTextContent('Problem code: TRANSACTION_ABORTED');
    expect(details).toHaveTextContent('Stopped during: Writing the new records');
  });

  it('does not offer a way to continue in the new store, because nothing is there', () => {
    render(<MigrationStateSurface migration={recoveryState()} retryMigration={async () => null} />);
    const text = dialog().textContent ?? '';
    expect(text).not.toMatch(/continue/i);
    expect(text).not.toMatch(/keep using the new store/i);
    expect(text).not.toMatch(/use the new store anyway/i);
  });

  it('shows the retry control only when the host supplied a callable', () => {
    const { unmount } = render(<MigrationStateSurface migration={recoveryState()} retryMigration={async () => null} />);
    expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    unmount();

    render(<MigrationStateSurface migration={recoveryState()} retryMigration={null} />);
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).not.toBeInTheDocument();
    // The learner's way out is still there.
    expect(screen.getByRole('button', { name: KEEP_USING_LABEL })).toBeInTheDocument();
  });

  it('shows no retry control for a state that is not retryable, even with a callable', () => {
    render(
      <MigrationStateSurface
        migration={recoveryState({ retryable: false, nextActions: [] })}
        retryMigration={async () => null}
      />,
    );
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).not.toBeInTheDocument();
    expect(dialog()).toHaveTextContent('Trying again will not help right now');
  });
});

// ── 7. The retry control's promise handling ────────────────────────────────

describe('Phase 4 migration surface: retry', () => {
  it('disables the control while the promise is in flight and re-renders from its result', async () => {
    const user = userEvent.setup();
    let settle: ((state: MigrationState | null) => void) | null = null;
    const retryMigration = vi.fn(
      () =>
        new Promise<MigrationState | null>((resolve) => {
          settle = resolve;
        }),
    );

    render(<MigrationStateSurface migration={recoveryState()} retryMigration={retryMigration} />);
    const retry = screen.getByRole('button', { name: RETRY_LABEL });
    expect(retry).toBeEnabled();

    await user.click(retry);
    expect(retryMigration).toHaveBeenCalledTimes(1);
    // Disabled while in flight, and the dialog says it is busy.
    expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeDisabled();
    expect(dialog()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Working on it. This can take a moment.')).toBeInTheDocument();

    await act(async () => {
      settle?.(migratedState());
    });

    // The returned state replaced the recovery dialog outright.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('The update finished');
  });

  it('keeps the notice and re-enables the control when the callable resolves null', async () => {
    const user = userEvent.setup();
    const retryMigration = vi.fn(async () => null);

    render(<MigrationStateSurface migration={recoveryState()} retryMigration={retryMigration} />);
    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeEnabled();
    expect(dialog()).toHaveTextContent('Nothing was lost');
  });

  it('keeps the notice and re-enables the control when the callable rejects', async () => {
    const user = userEvent.setup();
    const retryMigration = vi.fn(async () => {
      throw new Error('synthetic retry failure');
    });

    render(<MigrationStateSurface migration={recoveryState()} retryMigration={retryMigration} />);
    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeEnabled();
    });
    expect(screen.getByRole('dialog')).toHaveTextContent('Nothing was lost');
  });

  it('a second failed retry offers the retry again, because the callable can run again', async () => {
    const user = userEvent.setup();
    const retryMigration = vi.fn(async () => recoveryState({ recovery: { code: 'CHECKSUM_MISMATCH', stage: 'compare' } }));

    render(<MigrationStateSurface migration={recoveryState()} retryMigration={retryMigration} />);
    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'Technical details' })).toHaveTextContent(
        'Problem code: CHECKSUM_MISMATCH',
      );
    });
    expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeEnabled();
  });
});

// ── 7b. An in-flight action cannot be dismissed out from under the learner ──

describe('Phase 4 migration surface: the panel cannot be dismissed mid-action', () => {
  /** A `preview` state, the only non-recovery state that offers an action. */
  const panelState = previewState();

  it('disables the dismiss control while an action is in flight, and a second click cannot dismiss', async () => {
    const user = userEvent.setup();
    let settle: ((state: MigrationState | null) => void) | null = null;
    const startMigration = vi.fn(
      () =>
        new Promise<MigrationState | null>((resolve) => {
          settle = resolve;
        }),
    );

    render(<MigrationStateSurface migration={panelState} startMigration={startMigration} />);
    const begin = screen.getByRole('button', { name: START_LABEL });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss).toBeEnabled();

    await user.click(begin);
    // The defect this covers: the action's result is applied to local state rather
    // than pushed in by the host, so a dismissal during the flight left
    // `dismissed` true and the outcome of the learner's own action was never shown.
    // Every control is unavailable for the duration, matching the recovery dialog.
    await waitFor(() => {
      expect(begin).toBeDisabled();
    });
    expect(dismiss).toBeDisabled();

    // A second press cannot dismiss it either.
    await user.click(dismiss);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    // And the learner is told why, so two disabled controls are not a dead end.
    expect(screen.getByText('Working on it. This can take a moment.')).toBeInTheDocument();

    // The returned state is rendered, which is the point of the guard.
    await act(async () => {
      settle?.(migratedState());
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('The update finished');
    });
    // Dismissible again now that the action has settled.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });

  it('returns to a dismissible state when the action rejects', async () => {
    // The guard must not become a trap. `runAction` clears the pending flag on its
    // rejection path, so a failed action leaves the learner able to dismiss.
    const user = userEvent.setup();
    const startMigration = vi.fn(async () => {
      throw new Error('synthetic action failure');
    });

    render(<MigrationStateSurface migration={panelState} startMigration={startMigration} />);
    await user.click(screen.getByRole('button', { name: START_LABEL }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    });
    // Nothing was returned, so the state on screen is unchanged.
    expect(screen.getByRole('status')).toHaveTextContent('The app can update how it stores your data');
    // And the learner really can dismiss it, so they are not stuck.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('returns to a dismissible state when the action resolves null', async () => {
    const user = userEvent.setup();
    const startMigration = vi.fn(async () => null);

    render(<MigrationStateSurface migration={panelState} startMigration={startMigration} />);
    await user.click(screen.getByRole('button', { name: START_LABEL }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('returns to a dismissible state when the action throws synchronously', async () => {
    // A third exit from `runAction`, and the one a throwing callable takes before
    // it ever returns a promise.
    const user = userEvent.setup();
    const startMigration = vi.fn(() => {
      throw new Error('synchronous action failure');
    });

    render(<MigrationStateSurface migration={panelState} startMigration={startMigration} />);
    await user.click(screen.getByRole('button', { name: START_LABEL }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('the recovery dialog applies the same rule to its own dismissing control', async () => {
    // The rule is one rule, not two: the dialog's "Keep using the app as it is" is
    // unavailable while a retry is in flight, exactly like the panel's Dismiss.
    const user = userEvent.setup();
    let settle: (() => void) | null = null;
    const retryMigration = vi.fn(
      () =>
        new Promise<MigrationState | null>((resolve) => {
          settle = () => resolve(migratedState());
        }),
    );

    render(<MigrationStateSurface migration={recoveryState()} retryMigration={retryMigration} />);
    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: KEEP_USING_LABEL })).toBeDisabled();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      settle?.();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('adds no second live region to the panel while pending', () => {
    // The panel is already a polite live region, so the pending line must not add a
    // second one: nested live regions announce the same change twice.
    let settle: ((state: MigrationState | null) => void) | null = null;
    const startMigration = vi.fn(
      () =>
        new Promise<MigrationState | null>((resolve) => {
          settle = resolve;
        }),
    );
    render(<MigrationStateSurface migration={panelState} startMigration={startMigration} />);
    fireEvent.click(screen.getByRole('button', { name: START_LABEL }));

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    act(() => {
      settle?.(migratedState());
    });
  });
});

// ── 8. Focus management, Escape, and restoration ───────────────────────────

describe('Phase 4 migration surface: focus management', () => {
  it('moves focus into the dialog on open and restores it on close', async () => {
    const user = userEvent.setup();
    // The opener is rendered and focused first, so the surface captures it as the
    // element that had focus - the situation a real launch or a real retry has.
    const { rerender } = render(<button type="button">Open the dungeon</button>);
    const opener = screen.getByRole('button', { name: 'Open the dungeon' });
    opener.focus();
    expect(opener).toHaveFocus();

    rerender(
      <>
        <button type="button">Open the dungeon</button>
        <MigrationStateSurface migration={recoveryState()} retryMigration={async () => null} />
      </>,
    );

    await waitFor(() => {
      expect(dialog()).toHaveFocus();
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
  });

  it('closes on Escape when dismissible, and does nothing when an action is in flight', async () => {
    const user = userEvent.setup();
    let settle: (() => void) | null = null;
    const retryMigration = vi.fn(
      () =>
        new Promise<MigrationState | null>((resolve) => {
          settle = () => resolve(migratedState());
        }),
    );

    render(
      <>
        <button type="button">Open the dungeon</button>
        <MigrationStateSurface migration={recoveryState()} retryMigration={retryMigration} />
      </>,
    );
    await waitFor(() => {
      expect(dialog()).toHaveFocus();
    });

    // Start a retry: the surface is no longer dismissible mid-operation.
    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      settle?.();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('contains Tab inside the dialog and cycles in both directions', async () => {
    const user = userEvent.setup();
    render(<MigrationStateSurface migration={recoveryState()} retryMigration={async () => null} />);
    await waitFor(() => {
      expect(dialog()).toHaveFocus();
    });

    const [first, last] = controls();
    expect(first).toHaveAccessibleName(RETRY_LABEL);
    expect(last).toHaveAccessibleName(KEEP_USING_LABEL);

    // Forward from the last control wraps to the first.
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    // Backward from the first control wraps to the last.
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    // Forward again from the last reaches the first, not the page behind.
    await user.tab();
    expect(first).toHaveFocus();
  });

  it('does not trap focus for a non-modal state', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Open the dungeon</button>
        <MigrationStateSurface migration={migratedState()} />
      </>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Tab from the last control continues into the page rather than wrapping.
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    await user.tab();
    expect(dismiss).not.toHaveFocus();
  });

  it('re-opens on a new state after a dismissal', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MigrationStateSurface migration={recoveryState({ recovery: { code: 'TRANSACTION_ABORTED', stage: 'transform' } })} retryMigration={async () => null} />,
    );
    await waitFor(() => {
      expect(dialog()).toHaveFocus();
    });
    await user.click(screen.getByRole('button', { name: KEEP_USING_LABEL }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <MigrationStateSurface
        migration={recoveryState({ recovery: { code: 'MIGRATION_FAILED', stage: 'rollback' } })}
        retryMigration={async () => null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});

// ── 9. The default build renders nothing from this surface ────────────────

describe('Phase 4 migration surface: the default build is unchanged', () => {
  it('mounts the surface with a null migration and produces no node', async () => {
    useSessionStore.setState({ activeSubjectId: null, activeScreen: 'welcome', selectedClass: null });
    useSubjectStore.setState({ snapshot: null, lastError: null });
    useProgressionStore.setState({ activeSubjectId: null, bySubject: {}, xpTotal: 0 });

    const { container } = render(<App />);
    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });

    // No element from this surface exists in the default build's DOM.
    expect(container.querySelector('[class*="migration-"]')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// ── 10. The copy obeys the privacy rules and cannot leak a value ───────────

describe('Phase 4 migration surface: the storage copy overclaims nothing', () => {
  it('makes no absolute no-upload claim and names no store as a catch-all', () => {
    const states: MigrationState[] = [
      previewState(),
      runningState(),
      migratedState(),
      partialState(),
      recoveryState(),
    ];
    for (const state of states) {
      const view = describeMigration(state);
      expect(view).not.toBeNull();
      const sentences = [view?.heading, ...(view?.summary ?? [])].join(' ');
      expect(sentences, state.kind).not.toMatch(/nothing leaves your device/i);
      expect(sentences, state.kind).not.toMatch(/never (leaves|uploaded|sent)/i);
      expect(sentences, state.kind).not.toMatch(/localstorage/i);
      expect(sentences, state.kind).not.toMatch(/stays on your device/i);
    }
  });

  it('discloses unavailability wherever it mentions an image that is not on the device', () => {
    const view = describeMigration(partialState({ externalOnlyAttachments: 1 }));
    expect(view?.disclosure.join(' ')).toMatch(/does not have the bytes on this device and cannot fetch them/);
    expect(view?.disclosure.join(' ')).toMatch(/cannot include them/);
  });

  it('replaces an unrecognised reason with a sentence rather than echoing it', () => {
    // A reason that is URL-shaped. It is not a resolvable address and must never
    // reach the DOM.
    const view = describeMigration(
      partialState({ externalOnlyAttachments: 1, externalOnlyReasons: ['https://example.invalid/image.png'] }),
    );
    const disclosure = view?.disclosure.join(' ') ?? '';
    expect(disclosure).toContain('The app recorded a reason for this that this version does not recognise.');
    expect(disclosure).not.toContain('://');
  });

  it('replaces a value that is not code-shaped in diagnostic text', () => {
    expect(diagnosticCode('VALIDATION_FAILED')).toBe('VALIDATION_FAILED');
    expect(diagnosticCode('stage-records')).toBe('stage-records');
    expect(diagnosticCode('a room topic that should never be rendered')).toBe('unknown');
    expect(diagnosticCode('https://example.invalid/subject')).toBe('unknown');
    expect(diagnosticCode(null)).toBe('unknown');
    expect(diagnosticCode('')).toBe('unknown');

    const view = describeMigration(
      recoveryState({ recovery: { code: 'MIGRATION_FAILED', stage: 'a subject name' } }),
    );
    expect(view?.diagnostics.join(' ')).toContain('Stopped during: Working on the next step');
    expect(view?.diagnostics.join(' ')).not.toContain('a subject name');
  });

  it('renders disclosed problems as codes and counts, and a filename never', () => {
    const view = describeMigration(
      partialState({
        disclosedProblems: [
          { code: 'unindexed-subject-payload', scope: 'subject', count: 1, severity: 'warning' },
        ],
        disclosedProblemCount: 1,
      }),
    );
    expect(view?.diagnostics).toEqual(['1 unindexed subject payload (subject)']);
  });

  it('sanitises a disclosed problem code exactly as a recovery code is sanitised', () => {
    // The asymmetry this covers: the recovery path routed its code through the
    // sanitiser and the disclosed-problems path rendered `problem.code` verbatim,
    // so a value that was not a code reached learner-facing text. Both now go
    // through one implementation, and a disclosed-problem code is additionally
    // checked for membership of the core's union - because a filename satisfies
    // the token shape, so shape alone is not enough here.
    const hostile = {
      ...partialState(),
      disclosedProblems: [
        // Not code-shaped at all: a URL.
        { code: 'https://example.invalid/photo-of-my-cat.png', scope: 'subject', count: 1, severity: 'warning' },
        // Code-shaped but not a code: a filename. This is the case a shape check
        // alone would pass straight through.
        { code: 'photo-of-my-cat.png', scope: 'subject', count: 1, severity: 'warning' },
        // Code-shaped, with spaces, which the shape forbids.
        { code: 'a subject name', scope: 'subject', count: 1, severity: 'warning' },
        // A code from the other half of the union, which must be preserved.
        { code: 'missing-root-room-id', scope: 'subject', count: 1, severity: 'warning' },
        { code: 'not-an-object', scope: 'subject', count: 1, severity: 'warning' },
        // Empty and over-long, the two boundary cases of the shape.
        { code: '', scope: 'subject', count: 1, severity: 'warning' },
        { code: 'a'.repeat(65), scope: 'subject', count: 1, severity: 'warning' },
      ],
    } as unknown as MigrationSucceededState;

    const view = describeMigration(hostile);
    expect(view?.diagnostics).toEqual([
      '1 unknown (subject)',
      '1 unknown (subject)',
      '1 unknown (subject)',
      // Valid codes keep their human-readable meaning, de-hyphenated as before.
      '1 missing root room id (subject)',
      '1 not an object (subject)',
      '1 unknown (subject)',
      '1 unknown (subject)',
    ]);
    const rendered = (view?.diagnostics ?? []).join(' ');
    expect(rendered).not.toContain('example.invalid');
    expect(rendered).not.toContain('cat');
    expect(rendered).not.toContain('a subject name');
  });

  it('sanitises the disclosed problem scope, the other raw value on the same line', () => {
    const hostile = {
      ...partialState(),
      disclosedProblems: [
        { code: 'wrong-type', scope: 'photo-of-my-cat.png', count: 2, severity: 'warning' },
        { code: 'checksum-mismatch', scope: 'https://example.invalid/x', count: 1, severity: 'warning' },
        { code: 'dangling-edge', scope: 'attachment-blob', count: 1, severity: 'warning' },
      ],
    } as unknown as MigrationSucceededState;
    expect(describeMigration(hostile)?.diagnostics).toEqual([
      '2 wrong types (unknown)',
      '1 checksum mismatch (unknown)',
      // A real scope is preserved.
      '1 dangling edge (attachment-blob)',
    ]);
  });

  it('degrades a code outside the union without swallowing the disclosure', () => {
    // The failure mode to rule out: sanitising by dropping the line. That would
    // hide that a difference was recorded at all, which is the opposite of what a
    // disclosure is for. The count, the scope, and the surrounding text must all
    // survive; only the unrecognisable *name* is replaced.
    const hostile = {
      ...partialState({
        externalOnlyAttachments: 2,
        externalOnlyReasons: ['bytes-not-recoverable'],
      }),
      disclosedProblems: [
        { code: 'https://example.invalid/x', scope: 'attachment', count: 3, severity: 'warning' },
      ],
    } as unknown as MigrationSucceededState;

    const view = describeMigration(hostile);
    // The external-only disclosure is untouched by the code sanitisation, and it
    // still tells the learner exactly what a backup will not contain.
    expect(view?.succeededWithDisclosure).toBe(true);
    expect(view?.disclosureHeading).toBe('Not on this device');
    expect(view?.disclosure.join(' ')).toContain('2 images are listed without their data');
    expect(view?.disclosure.join(' ')).toContain('cannot fetch them');
    expect(view?.disclosure.join(' ')).toContain('a backup of this device cannot include them');
    // And the disclosed problem is still disclosed, with its count and scope.
    expect(view?.diagnostics).toEqual(['3 unknowns (attachment)']);
    // Rendered, not just described: the text reaches the DOM a learner reads.
    const { container } = render(<MigrationStateSurface migration={hostile} />);
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('a backup of this device cannot include them');
    expect(text).toContain('3 unknowns (attachment)');
    expect(text).not.toContain('example.invalid');
  });

  it('keeps the sanitiser vocabulary in step with the core\'s own unions', () => {
    // The two vocabularies are transcribed into the copy module rather than
    // imported, because the storage-v2 seam allowlist permits exactly one module
    // outside that tree to name it. This asserts the transcription against the
    // declarations themselves, so a code added to the core without a matching entry
    // here turns this red instead of silently degrading a legitimate disclosure to
    // `unknown`.
    const readUnion = (file: string, name: string): string[] => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const start = source.indexOf(`export type ${name} =`);
      expect(start, `${name} was not found in ${file}`).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf(';', start));
      return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
    };

    const coreCodes = readUnion('src/services/persistence/v2/validation.ts', 'ValidationCode');
    const subjectCodes = readUnion('src/core/validation/persistence/subjectValidation.ts', 'SubjectValidationCode');
    const coreScopes = readUnion('src/services/persistence/v2/validation.ts', 'ValidationScope');

    // Non-vacuous: the assertions below would pass on two empty sets.
    expect(coreCodes.length).toBeGreaterThan(10);
    expect(subjectCodes.length).toBeGreaterThan(10);
    expect(coreScopes.length).toBeGreaterThan(5);

    const expectedCodes = new Set([...coreCodes, ...subjectCodes]);
    expect([...expectedCodes].sort()).toEqual([...DISCLOSED_PROBLEM_CODE_VOCABULARY].sort());
    expect([...coreScopes].sort()).toEqual([...VALIDATION_SCOPE_VOCABULARY].sort());

    // And every member is a token the sanitiser would accept, so a code in the core
    // can never be rejected for its shape and silently downgraded.
    for (const code of expectedCodes) {
      expect(diagnosticCode(code), code).toBe(code);
    }
  });

  it('reads the dataIsIntact and legacyAuthoritative fields rather than assuming them', () => {
    const notIntact = describeMigration(
      recoveryState({ dataIsIntact: false as unknown as true, legacyAuthoritative: false as unknown as true }),
    );
    expect(notIntact?.summary.join(' ')).toContain('may not be able to show all of your data');
    expect(notIntact?.summary.join(' ')).toContain('reading a different copy of your data than before');
    expect(notIntact?.summary.join(' ')).not.toContain('Nothing was lost');
  });
});

// ── 11. The stylesheet contract the accessibility requirement depends on ────

describe('Phase 4 migration surface: the CSS contract', () => {
  const stylesheet = readFileSync(STYLESHEET, 'utf8');

  it('gives every control in the surface a 44 by 44 CSS-pixel minimum', () => {
    const rule = stylesheet.match(/\.migration-action\s*\{([^}]*)\}/);
    expect(rule, 'no .migration-action rule found').not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/min-height:\s*44px/);
    expect(body).toMatch(/min-width:\s*44px/);
    // The surface uses that one class for every control, including dismiss.
    expect(stylesheet).toMatch(/\.migration-panel > \.migration-actions/);
  });

  it('disables the surface animations under prefers-reduced-motion', () => {
    const reduced = stylesheet.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced, 'no prefers-reduced-motion block for this surface').not.toBeNull();
    const body = reduced?.[1] ?? '';
    expect(body).toMatch(/migration-backdrop[\s\S]*animation:\s*none/);
    expect(body).toMatch(/migration-progress::after[\s\S]*animation:\s*none/);
    // The shared 250ms `.modal` slide-and-scale has to be neutralised too: its
    // keyframe runs at `scale(0.96)`, which renders a 44px control at 42.24px.
    expect(body).toMatch(/migration-dialog[\s\S]*animation:\s*none/);
  });

  it('makes wrapping explicit, so a 320-pixel viewport needs no horizontal scrollbar', () => {
    // The two properties that do the work: a flexible child that may shrink, and
    // diagnostic text that wraps mid-token.
    expect(stylesheet).toMatch(/\.migration-body\s*\{[^}]*min-width:\s*0/);
    expect(stylesheet).toMatch(/\.migration-diagnostics-line\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
