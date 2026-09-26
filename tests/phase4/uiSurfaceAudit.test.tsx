/**
 * Independent audit of the Phase 4 migration-state surface.
 *
 * Written by the verification owner, from the component and the copy module
 * outward, without importing the specialist's own fixtures: a state model is
 * easy to render plausibly and wrongly, so every state here is built from the
 * *core* (`classifyMigrationReport`) wherever a real one can be produced, and by
 * hand only where the core cannot produce it (`preview`, `running`).
 *
 * What this file adds to the specialist's suite:
 *
 * 1. **Every `MigrationStateKind` against the real model.** Six kinds, six
 *    states, and for the four the core can produce the state is built by
 *    `classifyMigrationReport` from a `MigrationReport`, so the surface is tested
 *    against what the migration really emits rather than against a hand-written
 *    shape that happens to type-check.
 * 2. **A control the surface cannot honour is never rendered** - attacked from
 *    both directions: a `retryable` state with no callable, and a callable with a
 *    state that offers no retry.
 * 3. **`partial` never reads as a clean success**, attacked with a `migrated`
 *    state that nevertheless carries external-only attachments, a `partial` with
 *    zero reasons, and a reason that could render a URL or a filename.
 * 4. **A dismissal race the specialist's suite does not cover**: the panel's
 *    Dismiss control is not disabled while an action is in flight, and the state
 *    a completed action returns is then never shown.
 * 5. **The live-region and dialog structure**, asserted from the rendered DOM.
 *
 * The browser measurements - touch targets, focus, Escape, contrast, viewport -
 * are in `phase4UiProbe.spec.ts`, because jsdom has no layout and a measurement
 * taken in jsdom is not a measurement.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MigrationStateSurface } from '@/ui/components/MigrationStateSurface';
import { describeMigration } from '@/ui/components/migrationStateCopy';
import { classifyMigrationReport } from '@/services/persistence/v2/migrationState';
import type { MigrationState } from '@/application/bootstrap';
import type { MigrationReport } from '@/services/persistence/v2/schema';
import type { ValidationProblem } from '@/services/persistence/v2/validation';

const COUNTS = {
  subjects: 2,
  progression: 2,
  sessions: 1,
  preferences: 1,
  shortcuts: 3,
  assistance: 1,
  attachmentMetadata: 1,
  attachmentBlobs: 0,
  customSprites: 0,
  recovery: 0,
} as const;

const NO_KEYS = {
  allowlistedKeys: 6,
  present: 6,
  absent: 14,
  parseErrors: 0,
  unsupportedShapes: 0,
} as const;

const problems = (...entries: ValidationProblem[]): ValidationProblem[] => [...entries];

/** A `MigrationReport` with the given outcome, built by hand. */
function report(overrides: Partial<MigrationReport>): MigrationReport {
  return {
    status: 'migrated',
    stagedGenerationId: 'gen-phase4-ui',
    previousActiveGenerationId: null,
    activated: true,
    recordCounts: {
      subjects: COUNTS.subjects,
      progression: COUNTS.progression,
      sessions: COUNTS.sessions,
      preferences: COUNTS.preferences,
      shortcuts: COUNTS.shortcuts,
      assistance: COUNTS.assistance,
      attachments: COUNTS.attachmentMetadata,
      attachmentBlobs: COUNTS.attachmentBlobs,
      customSprites: COUNTS.customSprites,
      recovery: COUNTS.recovery,
      meta: 0,
      migrationReceipts: 1,
    } as MigrationReport['recordCounts'],
    legacyKeys: NO_KEYS,
    externalOnlyAttachments: [],
    problems: problems(),
    contentChecksum: 'a'.repeat(64),
    receiptId: 'receipt-phase4-ui',
    recovery: null,
    ...overrides,
  } as MigrationReport;
}

/** The four states the core can actually produce. */
const CORE_STATES: readonly { label: string; state: MigrationState }[] = [
  { label: 'migrated', state: classifyMigrationReport(report({})) },
  {
    label: 'partial',
    state: classifyMigrationReport(
      report({
        externalOnlyAttachments: [
          {
            attachmentId: 'att-phase4-ui',
            subjectId: 'subject-phase4-ui',
            roomId: 'room-phase4-ui-root',
            contentHash: null,
            byteLength: null,
            reason: 'bytes-not-recoverable',
            sourceType: 'local',
          },
        ],
      }),
    ),
  },
  {
    label: 'recovery-required',
    state: classifyMigrationReport(
      report({
        status: 'recovery-required',
        activated: false,
        recovery: { code: 'TRANSACTION_ABORTED', stage: 'stage-records' } as MigrationReport['recovery'],
      }),
    ),
  },
  { label: 'no-source-data', state: classifyMigrationReport(report({ status: 'no-source-data' })) },
];

function render_(state: MigrationState | null, props: Record<string, unknown> = {}) {
  return render(<MigrationStateSurface migration={state} {...props} />);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Every MigrationStateKind is accounted for, and each is reachable', () => {
  it('the surface handles all six kinds, and the core produces four of them', () => {
    // The union the copy module switches over. A seventh kind would be a compile
    // error there, so this asserts the *set* is what the model declares.
    const declared: readonly MigrationState['kind'][] = [
      'preview',
      'running',
      'migrated',
      'partial',
      'recovery-required',
      'no-source-data',
    ];
    expect([...declared].sort()).toEqual(
      ['migrated', 'no-source-data', 'partial', 'preview', 'recovery-required', 'running'],
    );
    // The four the core produces are exactly the four the model documents.
    expect(CORE_STATES.map((entry) => entry.state.kind).sort()).toEqual([
      'migrated',
      'no-source-data',
      'partial',
      'recovery-required',
    ]);
  });

  for (const { label, state } of CORE_STATES) {
    it(`renders the core's ${label} state the way the model describes it`, () => {
      const view = describeMigration(state);
      if (label === 'no-source-data') {
        // A device with nothing to move is a normal, correct state: nothing to say.
        expect(view).toBeNull();
        const { container } = render_(state);
        expect(container.innerHTML).toBe('');
        return;
      }
      expect(view).not.toBeNull();
      expect(view?.kind).toBe(state.kind);
      // Every rendered view names its state in words, so nothing is colour-only.
      expect(view?.statusLabel.length ?? 0).toBeGreaterThan(0);
      expect(view?.heading.length ?? 0).toBeGreaterThan(0);
      // And the tone is a separate axis, never the only carrier.
      expect(['informational', 'success', 'attention', 'problem']).toContain(view?.tone);

      const { container } = render_(state);
      const text = container.textContent ?? '';
      // The state is stated in words, and the glyph is hidden from assistive tech.
      expect(text).toContain(view?.statusLabel as string);
      expect(container.querySelector('.migration-glyph')?.getAttribute('aria-hidden')).toBe('true');
      // The live-region role differs by whether the state takes the app over.
      if (label === 'recovery-required') {
        const dialog = screen.getByRole('dialog', { name: view?.heading as string });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.hasAttribute('aria-describedby')).toBe(true);
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
      } else {
        const panel = screen.getByRole('status');
        expect(panel.getAttribute('aria-live')).toBe('polite');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(container.querySelector('[role="alert"]')).toBeNull();
      }
    });
  }

  it('renders preview and running, which the current bootstrap never produces', () => {
    // Built by hand because the core has no producer yet, which is the point: the
    // surface is a mount point for a future Data Center rather than dead code.
    const preview: MigrationState = {
      kind: 'preview',
      repository: 'v2',
      blockingPolicy: 'error-blocks-warning-discloses',
      nextActions: ['start-migration'],
      stagedGenerationId: null,
      previousActiveGenerationId: null,
      activeGenerationFlipped: false,
      counts: { ...COUNTS, subjects: 0, progression: 0, sessions: 0, preferences: 0, shortcuts: 0, assistance: 0, attachmentMetadata: 0 },
      blockingProblems: [],
      disclosedProblems: [],
      disclosedProblemCount: 0,
      unreadableSourceRecords: 0,
      externalOnlyAttachments: 0,
      legacyKeys: NO_KEYS,
    } as MigrationState;
    const running: MigrationState = {
      kind: 'running',
      repository: 'v2',
      blockingPolicy: 'error-blocks-warning-discloses',
      nextActions: [],
      stagedGenerationId: null,
      previousActiveGenerationId: null,
      activeGenerationFlipped: false,
      counts: { ...COUNTS, subjects: 0, progression: 0, sessions: 0, preferences: 0, shortcuts: 0, assistance: 0, attachmentMetadata: 0 },
      blockingProblems: [],
      disclosedProblems: [],
      disclosedProblemCount: 0,
      stage: 'validate',
    } as MigrationState;

    const viewPreview = describeMigration(preview);
    expect(viewPreview?.kind).toBe('preview');
    expect(viewPreview?.succeeded).toBe(false);
    expect(viewPreview?.tally).toEqual(['0 subjects', '0 images']);
    // With a callable to honour it with, which the control requires.
    render_(preview, { startMigration: vi.fn() });
    expect(screen.getByRole('button', { name: 'Update how this device stores my data' })).toBeVisible();

    cleanup();
    const viewRunning = describeMigration(running);
    expect(viewRunning?.kind).toBe('running');
    expect(viewRunning?.stageSentence).toBe('Checking the new records');
    const { container } = render_(running);
    // An indeterminate bar, named in words, with no invented percentage.
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar?.getAttribute('aria-label')).toContain('Checking the new records');
    // And no action is offered while a move is in flight.
    expect(screen.queryByRole('button', { name: /Try the update again/ })).toBeNull();
  });
});

describe('A control the surface cannot honour is never rendered', () => {
  const recovery = CORE_STATES.find((entry) => entry.label === 'recovery-required')?.state as MigrationState;

  it('a retryable state with no callable offers no retry', () => {
    expect(recovery.nextActions).toContain('retry-migration');
    render_(recovery, { retryMigration: null });
    expect(screen.queryByRole('button', { name: 'Try the update again' })).toBeNull();
    // The safe way out is always there.
    expect(screen.getByRole('button', { name: 'Keep using the app as it is' })).toBeVisible();
  });

  it('a callable with a state that offers no retry renders no retry', () => {
    const migrated = CORE_STATES.find((entry) => entry.label === 'migrated')?.state as MigrationState;
    expect(migrated.nextActions).not.toContain('retry-migration');
    const retry = vi.fn(async () => null);
    render_(migrated, { retryMigration: retry });
    expect(screen.queryByRole('button', { name: 'Try the update again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  });

  it('a non-retryable recovery state renders no retry even with a callable', () => {
    const notRetryable = classifyMigrationReport(
      report({
        status: 'recovery-required',
        activated: false,
        recovery: { code: 'INDEXEDDB_UNAVAILABLE', stage: 'read-legacy' } as MigrationReport['recovery'],
      }),
    );
    expect(notRetryable.nextActions).not.toContain('retry-migration');
    render_(notRetryable, { retryMigration: vi.fn(async () => null) });
    expect(screen.queryByRole('button', { name: 'Try the update again' })).toBeNull();
  });

  it('a start control appears only with a callable and only when the state offers it', () => {
    const withoutCallable = {
      kind: 'preview',
      nextActions: ['start-migration'],
      counts: { ...COUNTS },
    } as unknown as MigrationState;
    expect(describeMigration(withoutCallable)?.kind).toBe('preview');
    render_(withoutCallable, { startMigration: null });
    expect(screen.queryByRole('button', { name: /Update how this device stores/ })).toBeNull();
    cleanup();
    // ...and a state that does not name the action gets no control even with one.
    const noAction = { ...withoutCallable, nextActions: [] } as unknown as MigrationState;
    render_(noAction as MigrationState, { startMigration: vi.fn() });
    expect(screen.queryByRole('button', { name: /Update how this device stores/ })).toBeNull();
  });
});

describe('partial never reads as a clean success', () => {
  it('a migrated state carrying external-only attachments is disclosed anyway', () => {
    // The core cannot produce this - `classifyMigrationReport` maps any
    // external-only attachment to `partial` - so it is built by hand to prove the
    // presentation does not depend on the core's classification being right.
    const contradictory = {
      ...(CORE_STATES.find((entry) => entry.label === 'migrated')?.state as MigrationState),
      externalOnlyAttachments: 2,
      externalOnlyReasons: ['bytes-not-recoverable'],
    } as MigrationState;
    const view = describeMigration(contradictory);
    expect(view?.succeededWithDisclosure).toBe(true);
    expect(view?.tone).toBe('attention');
    expect(view?.heading).toMatch(/image data is not on this device/i);
    expect(view?.statusLabel).toMatch(/something to know/i);
    // The reassuring "every image has its data" sentence is gone.
    expect(view?.summary.join(' ')).not.toMatch(/Every image that was listed/);
    const { container } = render_(contradictory);
    const text = container.textContent ?? '';
    expect(text).toMatch(/2 images are listed without their data/);
    expect(text).not.toMatch(/Every image that was listed/);
  });

  it('a partial with no reasons still refuses to read as a clean success', () => {
    // A contradictory state: the heading would claim something the (empty)
    // disclosure list does not list. The state cannot be produced, so the only
    // question is which way the surface falls.
    const partialNoReasons = {
      ...(CORE_STATES.find((entry) => entry.label === 'partial')?.state as MigrationState),
      externalOnlyAttachments: 0,
      externalOnlyReasons: [],
    } as MigrationState;
    const view = describeMigration(partialNoReasons);
    expect(view?.succeededWithDisclosure).toBe(true);
    expect(view?.tone).toBe('attention');
    // Recorded: the heading asserts a fact the disclosure does not support, which
    // is the least defensible of the available renderings.
    expect(view?.disclosure).toEqual([]);
    expect(view?.disclosureHeading).toBeNull();
    expect(view?.heading).toMatch(/Some image data is not on this device/);
  });

  it('a reason that could render a URL or a filename is replaced by a sentence', () => {
    const hostile = {
      ...(CORE_STATES.find((entry) => entry.label === 'partial')?.state as MigrationState),
      externalOnlyAttachments: 1,
      externalOnlyReasons: [
        'https://example.invalid/photo-of-my-cat.png',
        'photo-of-my-cat.png',
        'Phase4 Independent Synthetic Subject',
        '',
      ],
    } as MigrationState;
    const view = describeMigration(hostile);
    const rendered = [view?.heading, ...(view?.summary ?? []), ...(view?.disclosure ?? []), ...(view?.diagnostics ?? [])].join(' ');
    expect(rendered).not.toContain('example.invalid');
    expect(rendered).not.toContain('photo-of-my-cat');
    expect(rendered).not.toContain('Phase4 Independent Synthetic Subject');
    // Every hostile reason became the one "unrecognised" sentence.
    const unrecognised = 'The app recorded a reason for this that this version does not recognise.';
    expect(view?.disclosure?.filter((line) => line === unrecognised)).toHaveLength(4);
  });

  it('a disclosed problem code outside the core\'s union is replaced, not rendered', () => {
    // HISTORY: this assertion was registered red to hold a real asymmetry open. The
    // recovery path routed its codes through `diagnosticCode` while this path built
    // its line straight from `problem.code`, so a value that was not a code reached
    // learner-facing text. The type forbids such a value today -
    // `ValidationProblem['code']` is a fixed union, so a new code is a compile
    // error - which is why it was a hardening finding rather than a live privacy
    // hole. Both paths now share one sanitiser, and a disclosed-problem code is
    // checked for *membership* of the core's union rather than for token shape,
    // because a filename satisfies the token shape perfectly well.
    //
    // It is now a positive assertion: a value outside the union becomes `unknown`,
    // the line still renders, and the count and scope survive. Sanitisation that
    // dropped the line would hide that a difference exists, which is the opposite of
    // the disclosure this surface exists to make.
    const withHostileCode = {
      ...(CORE_STATES.find((entry) => entry.label === 'migrated')?.state as MigrationState),
      disclosedProblems: [
        { code: 'photo-of-my-cat.png', scope: 'subject', count: 1, severity: 'warning' },
        { code: 'https://example.invalid/x', scope: 'attachment', count: 2, severity: 'warning' },
        { code: 'not-an-object', scope: 'subject', count: 3, severity: 'warning' },
      ],
    } as unknown as MigrationState;
    const view = describeMigration(withHostileCode);
    expect(view?.diagnostics).toEqual([
      // A filename and a URL both degrade to `unknown`, keeping their count and
      // scope so the difference is still disclosed rather than hidden.
      '1 unknown (subject)',
      '2 unknowns (attachment)',
      // `not-an-object` IS in the union, so it keeps its meaning.
      '3 not an objects (subject)',
    ]);
    const rendered = (view?.diagnostics ?? []).join(' ');
    expect(rendered).not.toContain('photo-of-my-cat');
    expect(rendered).not.toContain('my cat');
    expect(rendered).not.toContain('example.invalid');
  });

  it('a disclosed problem scope outside the core\'s union is replaced too', () => {
    // The scope is the other raw value on the same rendered line, so it is the same
    // defect. Leaving it unsanitised would have left half the line open.
    const withHostileScope = {
      ...(CORE_STATES.find((entry) => entry.label === 'migrated')?.state as MigrationState),
      disclosedProblems: [
        { code: 'wrong-type', scope: 'photo-of-my-cat.png', count: 1, severity: 'warning' },
        { code: 'wrong-type', scope: 'https://example.invalid/x', count: 1, severity: 'warning' },
      ],
    } as unknown as MigrationState;
    const view = describeMigration(withHostileScope);
    expect(view?.diagnostics).toEqual(['1 wrong type (unknown)', '1 wrong type (unknown)']);
    const rendered = (view?.diagnostics ?? []).join(' ');
    expect(rendered).not.toContain('my cat');
    expect(rendered).not.toContain('example.invalid');
    // The code half is untouched by a hostile scope half.
    expect(rendered).toContain('wrong type');
  });

  it('a code-shaped disclosed problem is rendered with its count and scope', () => {
    // The other half: the common case must keep working, so closing the gap above
    // cannot be done by dropping the line.
    const wellFormed = {
      ...(CORE_STATES.find((entry) => entry.label === 'migrated')?.state as MigrationState),
      disclosedProblems: [
        { code: 'unindexed-subject-payload', scope: 'subject', count: 2, severity: 'warning' },
      ],
    } as unknown as MigrationState;
    expect(describeMigration(wellFormed)?.diagnostics).toEqual([
      '2 unindexed subject payloads (subject)',
    ]);
  });
});

describe('An in-flight action cannot be dismissed out from under the learner', () => {
  it('the panel Dismiss is disabled while an action is in flight, and the returned state is shown', async () => {
    // HISTORY: this test was written to *pin* the defect - it asserted that Dismiss
    // stayed enabled and that the state the action returned was then never shown.
    // It has been flipped to assert the guard, following the same convention this
    // repository uses elsewhere: a test registered against an open defect becomes a
    // test that holds it closed. The action's result is applied to local state
    // rather than pushed in by the host, so a dismissal during the flight leaves
    // `dismissed` true and the outcome of the learner's own action is lost.
    let release: (() => void) | null = null;
    const start = vi.fn(
      () =>
        new Promise<MigrationState | null>((resolve) => {
          release = () => resolve(CORE_STATES[0]?.state as MigrationState);
        }),
    );
    const preview = {
      kind: 'preview',
      nextActions: ['start-migration'],
      counts: { ...COUNTS },
    } as unknown as MigrationState;

    render_(preview, { startMigration: start });
    const begin = screen.getByRole('button', { name: /Update how this device stores/ });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(begin);

    // In flight: the action control is disabled, and so is Dismiss, for the same
    // reason the dialog's controls are.
    await waitFor(() => expect(begin).toBeDisabled());
    expect(dismiss).toBeDisabled();
    // A second press cannot dismiss it either: a disabled button has no handler to
    // run, and the surface is still there.
    fireEvent.click(dismiss);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    // And the learner is told why, so disabled controls are not a dead end.
    expect(screen.getByText('Working on it. This can take a moment.')).toBeInTheDocument();

    // The action completes with a real state, and the learner does see it.
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent('The update finished');
    // Dismissible again once the action has settled.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  });

  it('a rejected action returns the surface to a dismissible state', async () => {
    // The guard must not become a trap. `runAction` clears the pending flag on
    // every exit - resolution, rejection, and a synchronous throw - so the learner
    // is never left unable to dismiss.
    const reject = vi.fn(async () => {
      throw new Error('synthetic action failure');
    });
    const preview = {
      kind: 'preview',
      nextActions: ['start-migration'],
      counts: { ...COUNTS },
    } as unknown as MigrationState;

    render_(preview, { startMigration: reject });
    fireEvent.click(screen.getByRole('button', { name: /Update how this device stores/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    });
    // The state on screen is unchanged, because nothing was returned.
    expect(screen.getByRole('status')).toHaveTextContent('The app can update how it stores your data');
    // And the learner can actually dismiss it.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an action that resolves null returns the surface to a dismissible state', async () => {
    const resolveNull = vi.fn(async () => null);
    const preview = {
      kind: 'preview',
      nextActions: ['start-migration'],
      counts: { ...COUNTS },
    } as unknown as MigrationState;

    render_(preview, { startMigration: resolveNull });
    fireEvent.click(screen.getByRole('button', { name: /Update how this device stores/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('The surface is inert on the default build and adds no static edge', () => {
  it('renders no DOM for a null migration', () => {
    const { container } = render_(null);
    expect(container.innerHTML).toBe('');
  });

  it('imports no storage-v2 module, so the entry chunk gains no static edge', () => {
    // The surface reads its types from the application seam, so the only thing
    // that could create a static edge to the storage-v2 tree is a value import.
    const files = [
      'src/ui/components/MigrationStateSurface.tsx',
      'src/ui/components/migrationStateCopy.ts',
      'src/ui/hooks/useModalFocus.ts',
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      for (const match of source.matchAll(/(?:^|\n)\s*import\s(?!type\s)([^;]*?from\s*)?['"]([^'"]+)['"]/g)) {
        const specifier = match[2] as string;
        if (/persistence\/v2/.test(specifier)) offenders.push(`${file} -> ${specifier}`);
        if (specifier === '@/application/bootstrap') offenders.push(`${file} -> ${specifier} (a value import)`);
      }
    }
    expect(offenders).toEqual([]);
    // And the seam it does use is type-only in both places.
    expect(readFileSync(join(process.cwd(), 'src/ui/components/MigrationStateSurface.tsx'), 'utf8')).toContain(
      "import type { MigrationNextAction, MigrationState } from '@/application/bootstrap';",
    );
    expect(readFileSync(join(process.cwd(), 'src/ui/components/migrationStateCopy.ts'), 'utf8')).toContain(
      'import type {',
    );
  });

  it('the application seam re-export is type-only, so it is erased and cannot cycle', () => {
    const source = readFileSync(join(process.cwd(), 'src/application/bootstrap.ts'), 'utf8');
    const block = source.slice(source.indexOf('export type {'), source.indexOf('// ── Result shape'));
    // Every statement in the block is `export type`, so TypeScript erases all of
    // it: no runtime import, no runtime cycle, no bytes in the artifact.
    const withoutComments = block
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, (_match, lead: string) => lead);
    const statements = withoutComments
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.startsWith('export type {')).toBe(true);
    }
    expect(block).not.toMatch(/export \{/);
    expect(block).not.toMatch(/export const/);
    expect(block).not.toMatch(/export function/);
  });

  it('the closed seam allowlist was not widened for the new UI', () => {
    // The gate's own list, read from the gate. The new surface files import
    // through the application seam, so they must not appear on it.
    const gate = readFileSync(join(process.cwd(), 'tests/migrations/qaHardening.test.ts'), 'utf8');
    const declaration = 'const STORAGE_V2_SEAMS: ReadonlyMap<string, string> = new Map([';
    const start = gate.indexOf(declaration);
    expect(start, 'the seam allowlist declaration was not found in the gate').toBeGreaterThan(-1);
    const end = gate.indexOf('\n]);', start);
    expect(end, 'the end of the seam allowlist was not found').toBeGreaterThan(start);
    const block = gate.slice(start, end);
    const entries = [...block.matchAll(/extensionless\(join\(SRC([^)]*)\)\)/g)].map(
      (match) =>
        [...(match[1] as string).matchAll(/'([^']+)'/g)]
          .map((segment) => segment[1] as string)
          .join('/'),
    );
    // Exactly the seven Phase 4 seams, unchanged.
    expect(entries.sort()).toEqual([
      'application/bootstrap.ts',
      'services/persistence/deviceAttachments.ts',
      'services/persistence/subjectPersistence.ts',
      'services/sessionTracker.ts',
      'store/preferencesStore.ts',
      'store/progressionStore.ts',
      'store/shortcutStore.ts',
    ]);
    for (const forbidden of ['ui/components/MigrationStateSurface.tsx', 'ui/components/migrationStateCopy.ts', 'ui/hooks/useModalFocus.ts']) {
      expect(entries).not.toContain(forbidden);
    }
  });
});

describe('The default-build rendering suite is unmodified', () => {
  it('renders the four tabs and no cutover text, and does not know about the surface', () => {
    const source = readFileSync(join(process.cwd(), 'tests/unit/defaultBuildRendering.test.tsx'), 'utf8');
    // The file must not have been edited to accommodate the new component, and it
    // must not be asserting the surface's absence by name.
    expect(source).not.toContain('MigrationStateSurface');
    expect(source).not.toContain('migrationState');
    // Its own subject matter is intact: the legacy repository, the four tabs, the
    // primary action, the disabled entry, and the checklist.
    expect(source).toContain("'legacy'");
    expect(source).toMatch(/Create \/ Load/);
    expect(source).toContain('Start Tutorial');
    expect(source).toContain('Enter Dungeon');
    expect(source.toLowerCase()).toContain('checklist');
  });
});
