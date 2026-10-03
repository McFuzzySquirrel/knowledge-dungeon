/**
 * The Scribe workspace's only path to an encounter mutation.
 *
 * ## Why this exists rather than a bare controller call in each component
 *
 * The same argument `useCreatorGraphActions` makes, unchanged and one verb set over:
 *
 * 1. **Every dispatch comes from an event handler.** There is no `useEffect` in this
 *    file that dispatches, and none of the workspace's effects dispatch either -
 *    the workspace's effects only seed the composer from the room, move focus, and
 *    resolve local image bytes. StrictMode re-runs effects; it does not re-fire clicks.
 * 2. **A ref guard swallows a re-entrant dispatch of the same scope.** A double tap on
 *    a touch screen, an Enter keydown that a form also submits, or a key held down all
 *    reach the handler twice inside one tick. The second attempt is refused *before*
 *    the controller is called, and reports `skipped` rather than pretending to succeed.
 * 3. **Pending state disables the control.** The guard is the correctness property; the
 *    disabled control is what stops the second attempt from being offered. Both are
 *    needed: a guard alone leaves a learner clicking a button that appears broken.
 *
 * The guard is the *first* layer, not the only one. The reward transaction itself is
 * durable and idempotent by (room, valid-clear identity), so a second submission that
 * gets past the guard - a resubmission minutes later, a StrictMode double render, a
 * retried write - is still awarded exactly once by `progressionStore.awardRoomClear`.
 * The two layers answer different questions: the guard answers "was this asked twice?",
 * the ledger answers "has this clear been rewarded before?".
 *
 * ## The feedback channel
 *
 * One {@link StudyFeedback} value, rendered by the shell's single `role="status"`
 * region. Every sentence here is built from the command's own outcome: counts and
 * verbs, never a topic, a room id, a note, or a file name. A refusal is the command's
 * own `error.message`, passed through verbatim, so the wording cannot drift from the
 * domain's.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  EncounterClearRewardOutcome,
  EncounterController,
} from '@/application/encounterCommands';
import { encounterController } from '@/store/encounterCommands';

import type { StudyFeedback } from '../StudyShell';

/**
 * The scope strings the guard and the pending flags agree on, per verb.
 *
 * Static vocabulary, and deliberately *not* per-room: two encounters for two rooms are
 * independent commands and must be able to run at once, while one encounter's submit
 * and its attach are the same learner and the same tick.
 */
export const SCRIBE_COMMAND_SCOPES = Object.freeze({
  noteSubmit: 'note-submit',
  attachmentAdd: 'attachment-add',
  attachmentAddExternal: 'attachment-add-external',
  attachmentRemove: 'attachment-remove',
  artifactCollect: 'artifact-collect',
});

export type ScribeCommandScope = (typeof SCRIBE_COMMAND_SCOPES)[keyof typeof SCRIBE_COMMAND_SCOPES];

export type ScribeCommandStatus = 'applied' | 'refused' | 'skipped' | 'failed';

export interface ScribeCommandResult {
  readonly status: ScribeCommandStatus;
  /** The sentence to show, or `null` for a skipped dispatch, which shows nothing. */
  readonly message: string | null;
}

/**
 * What a clear actually awarded, in one sentence.
 *
 * The suppressed branch is written out rather than folded into the awarded one,
 * because "nothing happened" and "something happened" must never read the same. A
 * duplicate clear says so in words, which is what makes the awarded-once property
 * visible to the learner instead of merely true in the ledger.
 */
function describeClear(reward: EncounterClearRewardOutcome): string {
  /*
   * `awarded` is false for three different reasons, and only one of them is
   * "already rewarded": the ledger suppressing a repeat clear, a progression record
   * that refused, and no active progression subject at all. Telling a learner their
   * clear "was already rewarded" when nothing was ever awarded is a sentence that is
   * simply false, so `duplicate` is the discriminator and the other two cases say
   * what actually happened. `EncounterClearRewardOutcome.duplicate` is the only
   * field that carries that distinction.
   */
  if (!reward.awarded) {
    return reward.duplicate
      ? 'This clear was already rewarded, so nothing was added this time.'
      : 'The encounter was cleared and its artifact was written, but no reward was added this time.';
  }
  const parts: string[] = [`Room cleared. +${reward.xpGained} XP.`];
  if (reward.loot !== null) parts.push(`Loot acquired: ${reward.loot.name}.`);
  for (const badge of reward.unlockedBadges) parts.push(`Badge unlocked: ${badge}.`);
  if (reward.badgeAwarded) parts.push('The long-note badge was added to your collection.');
  return parts.join(' ');
}

export interface ScribeEncounterActions {
  /** True while the given scope has a command in flight. */
  readonly isPending: (scope: ScribeCommandScope) => boolean;
  /** The live status/refusal sentence, or `null` before the first command. */
  readonly feedback: StudyFeedback | null;
  /** `encounter/note-submit`. The idempotent reward path. */
  readonly submitNote: (payload: {
    readonly roomId: string;
    readonly noteText: string;
    readonly manualConfirmed: boolean;
  }) => Promise<ScribeCommandResult>;
  /** `encounter/attachment-add` - device-local bytes only, never an upload. */
  readonly addLocalImage: (
    roomId: string,
    file: Blob & { readonly name?: string },
  ) => Promise<ScribeCommandResult>;
  /** `encounter/attachment-add-external` - record a URL without resolving it. */
  readonly addExternalImage: (roomId: string, url: string) => Promise<ScribeCommandResult>;
  /** `encounter/attachment-remove`. */
  readonly removeAttachment: (roomId: string, attachmentId: string) => Promise<ScribeCommandResult>;
  /** Forward an artifact pickup to the world flow's `artifact/collect`. */
  readonly collectArtifact: (roomId: string) => Promise<ScribeCommandResult>;
  /** Dismiss the live sentence. */
  readonly clearFeedback: () => void;
}

export interface ScribeEncounterActionsOptions {
  /**
   * The controller to dispatch through.
   *
   * Defaults to the store-bound `encounterController`. Injectable so a test can count
   * dispatches without a store, and so the workspace never has to know that the default
   * controller happens to be bound to one.
   */
  readonly controller?: EncounterController;
}

type Outcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

function dismissed(): ScribeCommandResult {
  return { status: 'skipped', message: null };
}

export function useScribeEncounterActions(
  options: ScribeEncounterActionsOptions = {},
): ScribeEncounterActions {
  const controller = options.controller ?? encounterController;
  const [pendingScopes, setPendingScopes] = useState<ReadonlySet<string>>(() => new Set());
  const [feedback, setFeedback] = useState<StudyFeedback | null>(null);

  /*
   * The guard. A ref rather than state because it has to be readable synchronously
   * inside the handler: state is committed on the next render, so a second activation
   * in the same tick would read `false` and dispatch again - which is exactly the bug.
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
    async (scope: ScribeCommandScope, invoke: () => Promise<Outcome>): Promise<ScribeCommandResult> => {
      if (inFlight.current.has(scope)) return dismissed();

      inFlight.current = new Set(inFlight.current).add(scope);
      if (mounted.current) {
        setPendingScopes((current) => new Set(current).add(scope));
        setFeedback({ tone: 'progress', message: 'Working on it…' });
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
        const outcome = await invoke();
        if (mounted.current) {
          setFeedback({ tone: outcome.ok ? 'done' : 'refusal', message: outcome.message });
        }
        return { status: outcome.ok ? 'applied' : 'refused', message: outcome.message };
      } catch (error) {
        /*
         * A rejected write is not a domain refusal: the note is already saved in memory
         * and the persistence step failed, which is what the pre-Phase-15 modal's own
         * `catch` reported. The thrown message is the only description that exists.
         */
        const message =
          error instanceof Error ? error.message : 'That could not be saved to this device.';
        if (mounted.current) setFeedback({ tone: 'refusal', message });
        return { status: 'failed', message };
      } finally {
        release();
      }
    },
    [],
  );

  const submitNote = useCallback(
    (payload: { roomId: string; noteText: string; manualConfirmed: boolean }) =>
      run(SCRIBE_COMMAND_SCOPES.noteSubmit, async () => {
        const result = await controller.submitNote(payload);
        if (!result.ok) return { ok: false, message: result.error.message };
        return result.value.kind === 'draft'
          ? {
              ok: true,
              message: 'Draft saved. Nothing was awarded, because the note is not complete yet.',
            }
          : { ok: true, message: describeClear(result.value.progression) };
      }),
    [controller, run],
  );

  const addLocalImage = useCallback(
    (roomId: string, file: Blob & { readonly name?: string }) =>
      run(SCRIBE_COMMAND_SCOPES.attachmentAdd, async () => {
        const result = await controller.addAttachment({ roomId, file });
        if (!result.ok) return { ok: false, message: result.error.message };
        return result.value.attachment === null
          ? { ok: false, message: 'No image was attached.' }
          : { ok: true, message: 'Image saved on this device and attached to the room.' };
      }),
    [controller, run],
  );

  const addExternalImage = useCallback(
    (roomId: string, url: string) =>
      run(SCRIBE_COMMAND_SCOPES.attachmentAddExternal, async () => {
        const result = await controller.addExternalAttachment({ roomId, url });
        if (!result.ok) return { ok: false, message: result.error.message };
        return result.value.attachment === null
          ? { ok: false, message: 'No image link was recorded.' }
          : { ok: true, message: 'Image link recorded. It is stored as a link and never downloaded.' };
      }),
    [controller, run],
  );

  const removeAttachment = useCallback(
    (roomId: string, attachmentId: string) =>
      run(SCRIBE_COMMAND_SCOPES.attachmentRemove, async () => {
        const result = await controller.removeAttachment({ roomId, attachmentId });
        if (!result.ok) return { ok: false, message: result.error.message };
        return { ok: true, message: 'Image removed from the room.' };
      }),
    [controller, run],
  );

  const collectArtifact = useCallback(
    (roomId: string) =>
      run(SCRIBE_COMMAND_SCOPES.artifactCollect, async () => {
        const result = await controller.artifactCollect({ roomId });
        return result.ok
          ? { ok: true, message: 'Artifact picked up. It is in your journal now.' }
          : { ok: false, message: result.error.message };
      }),
    [controller, run],
  );

  const isPending = useCallback(
    (scope: ScribeCommandScope): boolean => pendingScopes.has(scope),
    [pendingScopes],
  );

  const clearFeedback = useCallback((): void => {
    if (mounted.current) setFeedback(null);
  }, []);

  return useMemo(
    () => ({
      addExternalImage,
      addLocalImage,
      clearFeedback,
      collectArtifact,
      feedback,
      isPending,
      removeAttachment,
      submitNote,
    }),
    [
      addExternalImage,
      addLocalImage,
      clearFeedback,
      collectArtifact,
      feedback,
      isPending,
      removeAttachment,
      submitNote,
    ],
  );
}