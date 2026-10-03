/**
 * The Creator workspace's only path to a graph mutation.
 *
 * ## Why this hook exists rather than a bare controller call in each component
 *
 * Phase 14's exit criterion 4 is "no duplicate graph mutations occur under React
 * StrictMode", and every command this workspace dispatches is asynchronous: the
 * controller reads a snapshot, runs the domain, and *then* commits through
 * `commitSubjectSnapshot`. A mutation fired from an effect therefore applies twice
 * under StrictMode's double-invoked effects, and because each application commits a
 * fresh snapshot, the two applications are both valid - nothing throws, nothing warns,
 * and the learner silently gets the topic they asked for twice.
 *
 * So this module makes the guarantee structural rather than careful:
 *
 * 1. **Every dispatch comes from an event handler.** There is no `useEffect` in this
 *    file that dispatches, and none of the workspace's effects dispatch either - the
 *    workspace's effects only *derive* (`buildCreatorWorkspaceModel` is pure). StrictMode
 *    re-runs effects; it does not re-fire clicks.
 * 2. **A ref guard swallows a re-entrant dispatch of the same scope.** A double tap on
 *    a touch screen, an Enter keydown that a form also submits, or a key held down all
 *    reach the handler twice within one tick. The second dispatch is refused by the
 *    guard *before* the controller is called, and it reports `skipped` rather than
 *    pretending to succeed.
 * 3. **Pending state disables the control.** The guard is the correctness property; the
 *    disabled control is what stops the second attempt from being offered in the first
 *    place. Both are needed: a guard alone leaves a learner clicking a button that
 *    appears broken.
 *
 * `tests/phase14/creator-strictmode.test.tsx` asserts each of these per verb, by counting
 * the writes the store commits rather than by counting renders.
 *
 * ## No learner data leaves this module
 *
 * The messages built here are counts and verbs - "Added 2 child topics." - never a
 * topic, a room id, or a tag. A refusal is the graph domain's own message, passed
 * through verbatim, because restating it here would be a second wording to keep in step
 * with the first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GraphCommand } from '@/application/contracts/commands';
import type { GraphCommandName } from '@/application/contracts/commands';
import type { CreatorGraphController, CreatorGraphOutcome } from '@/application/creatorGraphCommands';
import { creatorGraphController } from '@/store/creatorGraphCommands';

import type { StudyFeedback } from '../StudyShell';

export type CreatorCommandStatus = 'applied' | 'refused' | 'skipped' | 'failed';

export interface CreatorCommandResult {
  readonly status: CreatorCommandStatus;
  readonly command: GraphCommandName;
  /** The sentence to show, or `null` for a skipped dispatch, which shows nothing. */
  readonly message: string | null;
}

/**
 * A scope is one control's worth of work.
 *
 * It is a static label the call site chooses - `'children-add'`, `'reparent'`, or
 * `'tag-add:<room>'` - and it exists so the guard, the pending flag, and the button all
 * agree about what "busy" means. It never contains a topic or a room id: a scope is
 * written into no attribute and no message, but a scope that could carry a learner value
 * is a scope someone will eventually copy into one.
 */
export type CreatorCommandScope = string;

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The sentence for a command that applied.
 *
 * Built from the command's own outcome, so the count is the count the domain reported
 * rather than a count the UI guessed.
 */
function describeApplied(outcome: CreatorGraphOutcome): string {
  switch (outcome.command) {
    case 'graph/children-add':
      return `Added ${plural(outcome.createdRoomIds.length, 'child topic', 'child topics')}.`;
    case 'graph/cross-link-add':
      return 'Linked the two topics. Revalidation ran on both.';
    case 'graph/room-reparent':
      return 'Moved the topic under its new parent.';
    case 'graph/room-remove': {
      const cascaded = outcome.removedRoomIds.length - 1;
      if (cascaded === 0) return 'Removed the topic.';
      return `Removed the topic and ${plural(cascaded, 'subtopic', 'subtopics')} that would have been left unattached.`;
    }
    case 'graph/tags-set':
    case 'graph/tag-add':
    case 'graph/tag-remove':
      return `Tags updated: ${outcome.tags.length === 0 ? 'none left' : plural(outcome.tags.length, 'tag', 'tags')}.`;
    default: {
      // Unreachable while `CreatorGraphOutcome` and `GraphCommandName` agree; written so
      // that a new command added to one union and not the other fails to compile here
      // rather than reporting "applied" with no sentence.
      const exhaustive: never = outcome;
      void exhaustive;
      return 'Applied.';
    }
  }
}

export interface CreatorGraphActions {
  /** True while the given scope has a command in flight. */
  readonly isPending: (scope: CreatorCommandScope) => boolean;
  /** The live status/refusal sentence, or `null` before the first command. */
  readonly feedback: StudyFeedback | null;
  /** The refusal from the last attempt, for a control that wants to restate it. */
  readonly lastRefusal: { readonly scope: CreatorCommandScope; readonly message: string } | null;
  /** Run one command. Never throws: a rejection becomes a `failed` result. */
  readonly run: (scope: CreatorCommandScope, command: GraphCommand) => Promise<CreatorCommandResult>;
  /** Dismiss the live sentence. */
  readonly clearFeedback: () => void;
}

export interface CreatorGraphActionsOptions {
  /**
   * The controller to dispatch through.
   *
   * Defaults to the store-bound `creatorGraphController`. It is injectable so a test can
   * count dispatches without a store, and so the workspace never has to know that the
   * default controller happens to be bound to one.
   */
  readonly controller?: CreatorGraphController;
}

export function useCreatorGraphActions(
  options: CreatorGraphActionsOptions = {},
): CreatorGraphActions {
  const controller = options.controller ?? creatorGraphController;
  const [pendingScopes, setPendingScopes] = useState<ReadonlySet<string>>(() => new Set());
  const [feedback, setFeedback] = useState<StudyFeedback | null>(null);
  const [lastRefusal, setLastRefusal] = useState<CreatorGraphActions['lastRefusal']>(null);

  /*
   * The guard. A ref rather than state because it has to be readable synchronously
   * inside the handler: state is committed on the next render, so a second click in the
   * same tick would read `false` and dispatch again, which is the exact bug.
   */
  const inFlight = useRef<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (scope: string, command: GraphCommand): Promise<CreatorCommandResult> => {
      if (inFlight.current.has(scope)) {
        // Re-entrant attempt: refused here, before the controller is reached.
        return { status: 'skipped', command: command.type, message: null };
      }

      inFlight.current = new Set(inFlight.current).add(scope);
      if (mounted.current) {
        setPendingScopes((current) => new Set(current).add(scope));
        setFeedback({ tone: 'progress', message: 'Applying the change…' });
      }

      const release = (): void => {
        inFlight.current = new Set([...inFlight.current].filter((entry) => entry !== scope));
        if (!mounted.current) return;
        setPendingScopes((current) => {
          const next = new Set(current);
          next.delete(scope);
          return next;
        });
      };

      try {
        const result = await controller.dispatch(command);
        if (!mounted.current) {
          return { status: result.ok ? 'applied' : 'refused', command: command.type, message: null };
        }
        if (result.ok) {
          setLastRefusal(null);
          setFeedback({ tone: 'done', message: describeApplied(result.value) });
          return { status: 'applied', command: command.type, message: describeApplied(result.value) };
        }
        setLastRefusal({ scope, message: result.error.message });
        setFeedback({ tone: 'refusal', message: result.error.message });
        return { status: 'refused', command: command.type, message: result.error.message };
      } catch (error) {
        /*
         * A rejected write is not a domain refusal - the snapshot already landed and the
         * persistence step failed, which is what the pre-Phase-14 store actions did too.
         * The message is the thrown one, because it is the only description of the
         * failure that exists.
         */
        const message =
          error instanceof Error ? error.message : 'The change could not be saved to this device.';
        if (mounted.current) {
          setLastRefusal({ scope, message });
          setFeedback({ tone: 'refusal', message });
        }
        return { status: 'failed', command: command.type, message };
      } finally {
        release();
      }
    },
    [controller],
  );

  const clearFeedback = useCallback((): void => {
    if (mounted.current) setFeedback(null);
  }, []);

  const isPending = useCallback(
    (scope: string): boolean => pendingScopes.has(scope),
    [pendingScopes],
  );

  return useMemo(
    () => ({ isPending, feedback, lastRefusal, run, clearFeedback }),
    [clearFeedback, feedback, isPending, lastRefusal, run],
  );
}
