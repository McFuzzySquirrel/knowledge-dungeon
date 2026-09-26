/**
 * Phase 4: the storage-move state surface.
 *
 * One component renders every outcome the Phase 4 migration can have, mounted
 * from `App.tsx` on top of the existing shell. It exists because the state model
 * has four *distinguishable* outcomes and two of them are easy to render wrongly:
 *
 * - a `partial` outcome is a **success with a disclosure**, not a failure and not
 *   a clean success. It says the move finished, and separately says that some
 *   image data is not on this device;
 * - a `recovery-required` outcome is a **failure that lost nothing**, and the
 *   reassuring sentence is the one a learner most needs. It is driven by the
 *   state's own `dataIsIntact` and `legacyAuthoritative` fields rather than by an
 *   assumption about what a failure means.
 *
 * Two rules govern what appears:
 *
 * 1. **Nothing renders by default.** `migration` is `null` on the default build -
 *    the legacy repository never produces one - and `no-source-data` means there
 *    is nothing to say. Both return `null`, so the default artifact's output is
 *    byte-for-byte what it was before this component existed.
 * 2. **A control appears only when it can be honoured.** A retry is rendered only
 *    when the state offers `retry-migration` *and* the host supplied a callable
 *    that performs it; a start is rendered only when the host supplied a callable
 *    for it. A button the surface cannot honour is worse than no button, because
 *    it promises an outcome the app cannot deliver.
 *
 * The states are presented two ways, and the choice is not cosmetic:
 *
 * - `recovery-required` is a **dialog**. It is the one state that needs a decision,
 *   it is announced assertively, and it is focus-contained with Escape and
 *   restoration (plan section 10.1).
 * - every other state is a **live-region panel** at the top of the app. A move
 *   that is in flight, finished, or ready to start must not take the app over,
 *   so it never traps focus and never blocks the shell behind it.
 *
 * `preview` is handled for completeness: the current bootstrap never produces one
 * (`migrateLegacyState` reports `migrated`, `partial`, `recovery-required`, or
 * `no-source-data`), and `buildMigrationPreview` exists for a future Data Center
 * screen. The start affordance is wired and tested now so that screen is a mount
 * point rather than a rewrite.
 *
 * Privacy: this component renders only what `describeMigration` produces - fixed
 * sentences, counts, and code-shaped diagnostics. No subject name, room topic,
 * note, filename, or URL reaches the DOM, and there is no path from a migration
 * state to one.
 */

import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useModalFocus } from '@/ui/hooks/useModalFocus';
import { describeMigration, type MigrationTone, type MigrationView } from '@/ui/components/migrationStateCopy';
import type { MigrationNextAction, MigrationState } from '@/application/bootstrap';

/** A host-supplied action: run it, and hand back whatever it produced. */
export type MigrationAction = () => Promise<MigrationState | null> | void;

export interface MigrationStateSurfaceProps {
  /**
   * The state to render, or `null` for "nothing happened".
   *
   * `null` is the default build's value, because the default build selects the
   * legacy repository and never migrates.
   */
  readonly migration: MigrationState | null;
  /**
   * Re-run the migration, or `null` when the surface must not offer it.
   *
   * `BootstrapResult.retryMigration` is non-null only for a state whose
   * `nextActions` include `retry-migration`, so passing it through unchanged keeps
   * the offer and its capability in step.
   */
  readonly retryMigration?: MigrationAction | null;
  /**
   * Begin a migration, or `null`/`undefined` when the host cannot perform one.
   *
   * The bootstrap exposes no start action, so the default application passes
   * nothing and no start control can appear. A host that gains one passes the
   * callable here and the affordance appears with it.
   */
  readonly startMigration?: MigrationAction | null;
}

const TONE_CLASS: Readonly<Record<MigrationTone, string>> = {
  informational: 'migration-panel--informational',
  success: 'migration-panel--success',
  attention: 'migration-panel--attention',
  problem: 'migration-panel--problem',
};

/** Diagnostic-only steps, shown as code-shaped text a learner can quote back. */
function CodeList({ lines }: { lines: readonly string[] }): JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <ul className="migration-diagnostics" aria-label="Technical details">
      {lines.map((line) => (
        <li key={line} className="migration-diagnostics-line">
          {line}
        </li>
      ))}
    </ul>
  );
}

function Paragraphs({ lines }: { lines: readonly string[] }): JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <div className="migration-copy">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

/** The heading plus the words that stand in for colour. */
function ViewHeading({ view, headingId }: { view: MigrationView; headingId: string }): JSX.Element {
  return (
    <>
      <p className="migration-status">
        {/* Decorative. `statusLabel` below is the text equivalent, so the state is
            never communicated by the glyph or by colour alone. */}
        <span className="migration-glyph" aria-hidden="true">
          {view.glyph}
        </span>
        <span>{view.statusLabel}</span>
      </p>
      <h2 id={headingId} className="migration-heading">
        {view.heading}
      </h2>
    </>
  );
}

export function MigrationStateSurface({
  migration,
  retryMigration = null,
  startMigration = null,
}: MigrationStateSurfaceProps): JSX.Element | null {
  const colorTheme = usePreferencesStore((state) => state.colorTheme);
  const [state, setState] = useState<MigrationState | null>(migration);
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState<MigrationNextAction | null>(null);

  // A new state from the host re-opens the surface: dismissal is a statement about
  // the state that was on screen, not a permanent decision about storage.
  useEffect(() => {
    setState(migration);
    setDismissed(false);
  }, [migration]);

  const view = describeMigration(state);
  const recoveryOpen = view !== null && view.kind === 'recovery-required' && !dismissed;
  const busy = pending !== null;

  const dialogRef = useModalFocus<HTMLDivElement>({
    active: recoveryOpen && !busy,
    // Escape is Escape-equals-Close, so it is unavailable while an action is in
    // flight: abandoning a retry half way would leave the learner's storage in a
    // state no screen is describing.
    onEscape: recoveryOpen && !busy ? () => setDismissed(true) : null,
  });

  const runAction = useCallback((action: MigrationNextAction, run: MigrationAction) => {
    setPending(action);
    let started: Promise<MigrationState | null> | void;
    try {
      started = run();
    } catch {
      setPending(null);
      return;
    }
    if (started === undefined) {
      setPending(null);
      return;
    }
    void started.then(
      (next) => {
        // `null` means the host could not run it. Keep the state that is on screen
        // rather than blanking the notice, because nothing has changed.
        if (next !== null) setState(next);
        setPending(null);
      },
      () => setPending(null),
    );
  }, []);

  const viewId = useId();
  const headingId = `${viewId}-heading`;
  const summaryId = `${viewId}-summary`;

  if (view === null || dismissed) return null;

  const canRetry = view.kind === 'recovery-required' && view.retryable && retryMigration !== null;
  const canStart = view.kind === 'preview' && startMigration !== null;
  const showStart = canStart && state !== null && state.nextActions.includes('start-migration');
  const showReview = view.kind === 'partial' && state !== null && state.nextActions.includes('review-disclosures');

  // ── recovery-required: a dialog, because it needs a decision ─────────────
  if (view.kind === 'recovery-required') {
    return (
      <div className="modal-backdrop migration-backdrop" role="presentation">
        <div
          className={`modal migration-dialog ui-skin ${TONE_CLASS[view.tone]}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          aria-describedby={summaryId}
          aria-busy={busy || undefined}
          tabIndex={-1}
          ref={dialogRef}
          data-theme={colorTheme}
        >
          {/* Assertive: a failed move is the one outcome the learner must hear
              without asking for it. The surface is inserted into the DOM when the
              state arrives, which is what triggers the announcement. */}
          <div role="alert">
            <ViewHeading view={view} headingId={headingId} />
          </div>
          <div id={summaryId}>
            <Paragraphs lines={view.summary} />
          </div>
          <CodeList lines={view.diagnostics} />

          {busy && (
            <p className="migration-pending" role="status" aria-live="polite">
              Working on it. This can take a moment.
            </p>
          )}

          <div className="migration-actions">
            {canRetry && retryMigration !== null && (
              <button
                type="button"
                className="migration-action"
                onClick={() => runAction('retry-migration', retryMigration)}
                disabled={busy}
                aria-busy={pending === 'retry-migration' || undefined}
              >
                Try the update again
              </button>
            )}
            <button
              type="button"
              className="ghost migration-action"
              onClick={() => setDismissed(true)}
              disabled={busy}
            >
              Keep using the app as it is
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── every other state: a live-region panel that never takes the app over ──
  return (
    <section
      className={`migration-panel ui-skin ${TONE_CLASS[view.tone]}`}
      data-theme={colorTheme}
      // `status` is polite, so a state change is announced without interrupting
      // whatever the learner is doing.
      role="status"
      aria-live="polite"
      aria-labelledby={headingId}
    >
      <div className="migration-body">
        <ViewHeading view={view} headingId={headingId} />
        <Paragraphs lines={view.summary} />
        {view.stageSentence !== null && <p className="migration-step">Now: {view.stageSentence}.</p>}
        {view.tally.length > 0 && (
          <p className="migration-tally">
            {view.tally.join(' · ')}
          </p>
        )}

        {view.kind === 'running' && (
          // Present and named in words above, so the bar is a supplement rather
          // than the only signal. No `aria-valuenow`: the move has no measurable
          // percentage, and an invented one would be a false reading.
          <div
            className="migration-progress"
            role="progressbar"
            aria-label={
              view.stageSentence === null
                ? 'Moving your data. In progress.'
                : `Moving your data. ${view.stageSentence}`
            }
          />
        )}

        {view.disclosureHeading !== null && (
          <div className="migration-disclosure">
            <h4 className="migration-subheading">{view.disclosureHeading}</h4>
            <Paragraphs lines={view.disclosure.slice(0, 1)} />
            {view.disclosure.length > 1 && (
              <ul className="migration-reasons">
                {view.disclosure.slice(1).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* `review-disclosures` is honoured by always rendering the disclosure
            above, not by a control that would hide it: a collapsed disclosure
            would also be a disclosure a live region never announces. This note
            appears only when there are disclosed problems for it to introduce. */}
        {showReview && view.diagnostics.length > 0 && (
          <p className="migration-review-note">
            These are the other differences recorded during the update. Nothing was deleted.
          </p>
        )}

        <CodeList lines={view.diagnostics} />
      </div>

      {/* Every control here is unavailable while an action is in flight, Dismiss
          included - the same rule the recovery dialog already follows for Escape.
          The reason is the same: an action's result is applied to local state
          rather than pushed in by the host, so dismissing mid-flight leaves
          `dismissed` true and the state the action returns is never rendered. The
          learner would trigger an action and lose the outcome of it. */}
      {/* No `role` of its own, deliberately: the panel is already a polite live
          region, and a second one nested inside it would announce the same change
          twice. A change inside the panel is announced by the panel, which is the
          behaviour this line is relying on. (The dialog's equivalent sits beside
          its `role="alert"` heading rather than inside a live region, so there it
          does carry its own role.) */}
      {busy && <p className="migration-pending">Working on it. This can take a moment.</p>}

      <div className="migration-actions">
        {showStart && startMigration !== null && (
          <button
            type="button"
            className="migration-action"
            onClick={() => runAction('start-migration', startMigration)}
            disabled={busy}
            aria-busy={pending === 'start-migration' || undefined}
          >
            Update how this device stores my data
          </button>
        )}
        <button
          type="button"
          className="ghost migration-action"
          onClick={() => setDismissed(true)}
          disabled={busy}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
