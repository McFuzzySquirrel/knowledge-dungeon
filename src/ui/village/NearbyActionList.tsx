/**
 * The DOM nearby-action list: every world interaction as a real button.
 *
 * ## What this is
 *
 * The Phase 12 exit criterion is **"No Pixi object is required to understand or
 * invoke a village action."** This file is that criterion's implementation. The
 * renderer measures proximity and hands the measurements to
 * `selectVillageNearbyTargets`, which selects and *orders* them; this component
 * renders what it returns, in the order it returns, and nothing else. It does not
 * measure, does not filter, does not re-sort, and does not know which renderer -
 * or whether one - is mounted.
 *
 * The order matters and is not cosmetic. The contract puts structures before NPCs
 * because that is the priority the world's own interact key already has, so the
 * first row here is the action a learner would get by pressing `E`. A list sorted
 * by distance would routinely lead with an NPC the key press would never talk to.
 *
 * ## Data, not a closure
 *
 * Each row's `onClick` is **one shared handler**, defined once for the whole
 * application by {@link useVillageActionHandler} and passed to every row. It does
 * not close over the row: it reads `event.currentTarget`'s `data-*` attributes and
 * rebuilds the invocation from them. So:
 *
 * - the identity of every action lives in the DOM, where a test, a screen reader,
 *   and a reviewer can all read it;
 * - adding a row does not mint a closure, so a list of twenty is not twenty
 *   retained environments;
 * - the handler cannot drift from the markup, because the markup *is* its input.
 *
 * `tests/phase12/village-nearby-actions.test.tsx` asserts the data route by
 * activating a row whose closure would have captured a *different* target, and by
 * reading the invocation the adapter received.
 *
 * ## Degrading, visibly
 *
 * `readNpcSnapshot` and `invokeAction` are optional on the capability port while
 * the two adapters are being wired, and a control that is present but does
 * nothing is worse than no control. So the three states are distinct and each is
 * *stated*:
 *
 * | State                          | What renders                                       |
 * |--------------------------------|----------------------------------------------------|
 * | no snapshot capability         | an empty list, plus a sentence saying so           |
 * | snapshot but no `invokeAction` | the rows, disabled, plus a sentence saying why     |
 * | both                           | the rows, enabled                                   |
 *
 * The second state is not a "you need PixiJS" message: the rows are produced by
 * the contract over renderer-neutral measurements, so they appear on either
 * renderer. It is a "the world has not reported a way to act yet" message, and it
 * names the fallback the learner already has - the Interact control and the `E`
 * key - so it reads as a state, not as a failure.
 */
import { useCallback, useId, type MouseEvent, type ReactNode } from 'react';

import {
  VILLAGE_ACTION_INTERACT,
  type VillageActionId,
  type VillageActionInvocation,
  type VillageActionSource,
  type VillageActionTarget,
  type VillageNearbyTarget,
  type VillageNearbyTargetKind,
} from '@/application/contracts/villageNpc';

import './villagePanels.css';

/** The one input path a DOM control can be. */
const DOM_SOURCE: VillageActionSource = 'dom';

/** The data attributes a row's identity is written to, and read back from. */
const ACTION_ATTRIBUTE = 'data-village-action';
const KIND_ATTRIBUTE = 'data-target-kind';
const ID_ATTRIBUTE = 'data-target-id';
const DISTANCE_ATTRIBUTE = 'data-target-distance';

const ACTION_IDS: ReadonlySet<string> = new Set<string>([VILLAGE_ACTION_INTERACT]);
const TARGET_KINDS: ReadonlySet<string> = new Set<string>(['structure', 'npc']);

const KIND_ICONS: Readonly<Record<VillageNearbyTargetKind, string>> = Object.freeze({
  structure: '🏛',
  npc: '🧙',
});

/**
 * The verb a row offers, by what kind of thing it is.
 *
 * "Interact with" for a building and "Talk to" for a person, because those are the
 * two things a learner means by them, and a control labelled with the raw contract
 * id would satisfy the exit criterion only on paper.
 */
export function villageActionLabel(target: VillageNearbyTarget): string {
  return target.kind === 'npc' ? `Talk to ${target.label}` : `Interact with ${target.label}`;
}

/**
 * Turn a click on a row into an invocation, reading only the DOM.
 *
 * A malformed row is a bug rather than a user error, so it is dropped instead of
 * being turned into an invocation with an invented target: an unknown action id
 * and an unknown target kind are both rejected against the closed vocabularies
 * the contract declares.
 */
function readInvocation(button: HTMLButtonElement): VillageActionInvocation | null {
  const actionId = button.getAttribute(ACTION_ATTRIBUTE);
  const kind = button.getAttribute(KIND_ATTRIBUTE);
  const id = button.getAttribute(ID_ATTRIBUTE);
  if (actionId === null || id === null || kind === null) return null;
  if (!ACTION_IDS.has(actionId) || !TARGET_KINDS.has(kind)) return null;
  return {
    actionId: actionId as VillageActionId,
    target: { kind: kind as VillageNearbyTargetKind, id },
    source: DOM_SOURCE,
  };
}

/**
 * The one data-driven click handler every village action button shares.
 *
 * Memoized on `invoke`, which the surface hook holds stable for the life of the
 * screen, so the identity is stable and the rows are not re-created when a
 * different NPC walks into range. A `null` `invoke` - a renderer that has not
 * wired `invokeAction` - is not an error here: the rows are disabled, and this
 * handler is never reached.
 */
export function useVillageActionHandler(
  invoke: ((invocation: VillageActionInvocation) => boolean) | null,
): (event: MouseEvent<HTMLButtonElement>) => void {
  return useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      if (invoke === null) return;
      const invocation = readInvocation(event.currentTarget);
      if (invocation === null) return;
      invoke(invocation);
    },
    [invoke],
  );
}

export interface VillageActionButtonProps {
  /** What the button acts on. Written to the DOM, read back by the handler. */
  readonly target: VillageActionTarget;
  /** The action id the button will pass to `invokeAction`. */
  readonly actionId: VillageActionId;
  /** The visible, and accessible, label. */
  readonly label: string;
  /**
   * Distance in world pixels, carried for the record.
   *
   * Written to `data-target-distance` and **not** rendered as text: the value is
   * in world pixels, which is a renderer unit a learner has no way to interpret,
   * and printing a bare number next to a name invites reading it as a score. The
   * ordering information the learner needs is already in the row order.
   */
  readonly distance?: number;
  /** The shared handler from {@link useVillageActionHandler}. */
  readonly onInvoke: (event: MouseEvent<HTMLButtonElement>) => void;
  /** `true` when there is no way to act, so the row explains itself instead. */
  readonly disabled?: boolean;
  /** Id of the sentence explaining a disabled row. */
  readonly describedById?: string;
  /** Extra class names, so the quest overview can reuse the same control. */
  readonly className?: string;
}

export function VillageActionButton({
  target,
  actionId,
  label,
  distance,
  onInvoke,
  disabled = false,
  describedById,
  className = 'village-nearby-btn',
}: VillageActionButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={className}
      {...{ [ACTION_ATTRIBUTE]: actionId }}
      {...{ [KIND_ATTRIBUTE]: target.kind }}
      {...{ [ID_ATTRIBUTE]: target.id }}
      {...{ [DISTANCE_ATTRIBUTE]: distance === undefined ? undefined : String(distance) }}
      onClick={onInvoke}
      disabled={disabled}
      aria-describedby={describedById}
      data-village-touch-target="action"
      style={{ minWidth: '44px', minHeight: '44px' }}
    >
      <span className="village-nearby-btn__kind" aria-hidden="true">
        {KIND_ICONS[target.kind]}
      </span>
      <span className="village-nearby-btn__label">{label}</span>
    </button>
  );
}

export interface NearbyActionListProps {
  /** What the contract selected, in the contract's order. */
  readonly targets: readonly VillageNearbyTarget[];
  /** The shared, data-driven click handler. */
  readonly onInvoke: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Whether there is anything to invoke with.
   *
   * `false` disables every row and renders the explanation below the list. It
   * never renders a row that silently does nothing.
   */
  readonly invokeAvailable: boolean;
  /** Whether a snapshot capability was available to produce `targets` at all. */
  readonly listAvailable: boolean;
  /** Visible heading. Defaults to "Nearby". */
  readonly heading?: string;
  /** Overrides for the three explanatory sentences. */
  readonly messages?: {
    readonly unsupported?: string;
    readonly unavailable?: string;
    readonly empty?: string;
  };
}

const DEFAULT_UNSUPPORTED =
  'The village world has not reported a way to act from a button yet, so these actions are unavailable. Use the Interact control, or press E, once the world has started.';
const DEFAULT_UNAVAILABLE =
  'The village world has not reported anything nearby yet. Walk towards a building or a villager and the list will fill in.';
const DEFAULT_EMPTY = 'Nothing is in reach right now. Walk towards a building or a villager.';

export function NearbyActionList({
  targets,
  onInvoke,
  invokeAvailable,
  listAvailable,
  heading = 'Nearby',
  messages,
}: NearbyActionListProps): ReactNode {
  const headingId = useId();
  const noteId = useId();

  const unsupported = !invokeAvailable;
  const note = unsupported
    ? (messages?.unsupported ?? DEFAULT_UNSUPPORTED)
    : listAvailable
      ? targets.length === 0
        ? (messages?.empty ?? DEFAULT_EMPTY)
        : null
      : (messages?.unavailable ?? DEFAULT_UNAVAILABLE);

  return (
    <section className="village-nearby" aria-labelledby={headingId} data-village-nearby="true">
      <h2 className="village-hud-section-label" id={headingId}>
        {heading}
      </h2>
      {targets.length > 0 ? (
        <ul className="village-nearby-list">
          {targets.map((target) => (
            <li key={`${target.kind}:${target.id}`}>
              <VillageActionButton
                target={{ kind: target.kind, id: target.id }}
                actionId={target.actionId}
                label={villageActionLabel(target)}
                distance={target.distance}
                onInvoke={onInvoke}
                disabled={unsupported}
                describedById={unsupported ? noteId : undefined}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {note !== null ? (
        <p
          className={unsupported ? 'village-nearby-note' : 'village-nearby-empty'}
          id={noteId}
          // A status rather than a `role="note"`: the sentence changes when the
          // capability does, and a learner who navigates to the list should hear
          // why it is empty without hunting for a region.
          role="status"
          aria-live="polite"
        >
          {note}
        </p>
      ) : null}
    </section>
  );
}
