/**
 * The quest board: the two DOM quest surfaces, both renderer-free.
 *
 * ## Two surfaces, one module, because they answer one question
 *
 * - **`VillageQuestOverview`** - *who* can speak about the quest, derived from
 *   `describeVillageNpcQuests(VILLAGE_MAP.npcs, questStep)`. That function is pure
 *   over the static roster and the current step, so the overview needs **nothing
 *   from either renderer** and renders identically on Phaser and Pixi. This is
 *   the surface that answers "what do I do next, and who do I ask?" before the
 *   learner has walked anywhere.
 * - **`QuestBoard`** - the quest board structure's panel body: every authored step
 *   in order, with its state in words, a way to hear the guidance for a step, and
 *   a manual completion control for the three steps that genuinely need one.
 *
 * ## What changed from the pre-Phase-12 markup, and why it is not cosmetic
 *
 * The quest rows were `<div onClick={...}>`. That is not a control: it is not in
 * the tab order, `Enter` and `Space` do nothing, and a screen reader announces an
 * unlabelled group. So every row is now a real `<button>`, and the state is
 * carried by three things at once:
 *
 * - a **word** in the row ("Done", "Active", "Needs confirm", "Locked"), which is
 *   the only one a screen reader gets and the only one that survives greyscale;
 * - a `data-quest-state` attribute, which a test addresses;
 * - `aria-current="step"` on the active row, which is what a screen reader
 *   announces as "current".
 *
 * The old row also signalled the active state with a border *colour*. That
 * decoration is kept, but nothing depends on it.
 *
 * ## Why "Talk to" is offered only for an NPC who is nearby
 *
 * `VillageActionInvocation.target` is a **named intent, not a guarantee** - the
 * Phaser `handleInteract` always resolves a structure first. So a "Talk to the
 * Keeper" button rendered from a quest board, while the Keeper is forty tiles
 * away, would be a labelled control that does nothing: exactly the failure the
 * contract warns against ("a learner who pressed a labelled control and saw
 * nothing happen learns that the control lies"). The row therefore offers the
 * action when the nearby-action list contains that NPC, and when it does not it
 * *says* where to go instead of offering a button.
 */
import { useId, useMemo, type MouseEvent, type ReactNode } from 'react';

import { VILLAGE_MAP } from '@/data/villageLayout';
import {
  MANUAL_QUESTS,
  QUEST_LABELS,
  QUEST_ORDER,
  type QuestStep,
} from '@/store/sessionStore';
import {
  VILLAGE_ACTION_INTERACT,
  describeVillageNpcQuests,
  type VillageActionInvocation,
  type VillageNpcQuestRow,
  type VillageNearbyTarget,
} from '@/application/contracts/villageNpc';

import { VillagePanel } from './VillagePanel';
import { VillageActionButton } from './NearbyActionList';
import type { VillageSurfaceMode } from './villageTypes';

import './villagePanels.css';

type QuestState = 'done' | 'active' | 'locked';

const STATE_WORDS: Readonly<Record<QuestState, string>> = Object.freeze({
  done: 'Done',
  active: 'Active',
  locked: 'Locked',
});

const MANUAL_ACTIVE_WORDS = 'Active — needs your confirmation';

const STATE_GLYPHS: Readonly<Record<QuestState, string>> = Object.freeze({
  done: '✅',
  active: '▶',
  locked: '⬜',
});

function questState(step: QuestStep, current: QuestStep): QuestState {
  if (step === current) return 'active';
  return QUEST_ORDER.indexOf(step) < QUEST_ORDER.indexOf(current) ? 'done' : 'locked';
}

function stateWord(state: QuestState, step: QuestStep, current: QuestStep): string {
  if (state !== 'active') return STATE_WORDS[state];
  return step === current && MANUAL_QUESTS.has(step) ? MANUAL_ACTIVE_WORDS : STATE_WORDS.active;
}

export interface VillageQuestOverviewProps {
  /** The learner's current quest step. Opaque to the contract; owned here. */
  readonly questStep: QuestStep;
  /** The contract's selected nearby rows, so a "Talk to" can be offered truthfully. */
  readonly nearbyTargets?: readonly VillageNearbyTarget[];
  /** `null` when the village has not wired an action dispatcher. */
  readonly invoke?: ((invocation: VillageActionInvocation) => boolean) | null;
  /** The shared, data-driven handler from `useVillageActionHandler`. */
  readonly onInvoke?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Heading for the section. */
  readonly heading?: string;
}

/**
 * Who can speak about the current quest, and the only truthful way to reach them.
 *
 * Renders a `<ul>` of `VillageNpcQuestRow`s, so the DOM is the whole story: no
 * renderer, no camera, no scene. A row that `speaksCurrentStep` says so in words
 * and offers a Talk-to button **iff** the nearby list contains that NPC; a row
 * that does not says which steps it can speak about, by name, and nothing else.
 */
export function VillageQuestOverview({
  questStep,
  nearbyTargets = [],
  invoke = null,
  onInvoke,
  heading = 'Who can help',
}: VillageQuestOverviewProps): ReactNode {
  const headingId = useId();
  // The one renderer-free derivation in the village shell: the static roster and a
  // quest step in, rows out. No capability port, no ref, no effect.
  const rows = useMemo<readonly VillageNpcQuestRow[]>(
    () => describeVillageNpcQuests(VILLAGE_MAP.npcs, questStep),
    [questStep],
  );
  const currentLabel = QUEST_LABELS[questStep]?.label ?? questStep;
  const nearbyNpcIds = useMemo(
    () => new Set(nearbyTargets.filter((row) => row.kind === 'npc').map((row) => row.id)),
    [nearbyTargets],
  );

  return (
    <section
      className="village-quest-overview"
      aria-labelledby={headingId}
      data-village-quest-overview="true"
    >
      <h4 className="village-hud-section-label" id={headingId}>
        {heading}
      </h4>
      <p className="village-info-desc">Current quest: {currentLabel}.</p>
      {rows.length === 0 ? (
        <p className="village-quest-overview-row__hint">
          No villager has a prepared answer for this quest yet. The quest list still
          names every step.
        </p>
      ) : (
        <ul className="village-quest-overview-list">
          {rows.map((row) => {
            const inRange = nearbyNpcIds.has(row.npcId);
            const stepNames = row.questSteps
              .map((step) => QUEST_LABELS[step as QuestStep]?.label ?? step)
              .join(', ');
            return (
              <li
                key={row.npcId}
                className="village-quest-overview-row"
                data-speaks-current-step={row.speaksCurrentStep ? 'true' : 'false'}
                data-npc-id={row.npcId}
              >
                <p className="village-quest-overview-row__head">
                  <span className="village-quest-overview-row__who">{row.label}</span>
                  <span className="village-quest-overview-row__state">
                    {row.speaksCurrentStep
                      ? 'Can speak to your current quest.'
                      : 'Has other quest guidance.'}
                  </span>
                </p>
                <p className="village-quest-overview-row__steps">Quests covered: {stepNames}.</p>
                {row.speaksCurrentStep ? (
                  inRange && onInvoke !== undefined ? (
                    <VillageActionButton
                      target={{ kind: 'npc', id: row.npcId }}
                      actionId={VILLAGE_ACTION_INTERACT}
                      label={`Talk to ${row.label}`}
                      onInvoke={onInvoke}
                      disabled={invoke === null}
                    />
                  ) : (
                    <p className="village-quest-overview-row__hint">
                      {row.label} is not in reach right now. Walk over to them, then use
                      the Nearby list.
                    </p>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface QuestBoardProps {
  /** The learner's current quest step. */
  readonly questStep: QuestStep;
  /** The Cozy shape to take. */
  readonly mode: VillageSurfaceMode;
  /** Closes the panel. */
  readonly onClose: () => void;
  /** Selects a step and shows its guidance. */
  readonly onSelectStep: (step: QuestStep) => void;
  /** Confirms a manual quest step. The store owns the policy. */
  readonly onCompleteManualStep: () => void;
  /** The contract's nearby rows, for a truthful Talk-to. */
  readonly nearbyTargets: readonly VillageNearbyTarget[];
  /** The village's action dispatcher, or `null`. */
  readonly invoke: ((invocation: VillageActionInvocation) => boolean) | null;
  /** The shared, data-driven handler. */
  readonly onInvoke: (event: MouseEvent<HTMLButtonElement>) => void;
  /** The `data-theme` value the screen is themed with. */
  readonly colorTheme: string;
}

/**
 * The quest board structure's panel body.
 *
 * The step list is the authored `QUEST_ORDER` minus `intro` (which is "you have
 * arrived", not something to select).
 */
export function QuestBoard({
  questStep,
  mode,
  onClose,
  onSelectStep,
  onCompleteManualStep,
  nearbyTargets,
  invoke,
  onInvoke,
  colorTheme,
}: QuestBoardProps): ReactNode {
  const steps = useMemo(() => QUEST_ORDER.filter((step) => step !== 'intro'), []);

  return (
    <VillagePanel
      mode={mode}
      title="Keeper's Quest Board"
      subtitle="Choose a quest to hear its guidance. Each row states its own progress in words."
      icon="📜"
      onClose={onClose}
      colorTheme={colorTheme}
    >
      <ol className="village-quest-rows">
        {steps.map((step) => {
          const state = questState(step, questStep);
          const manual = MANUAL_QUESTS.has(step);
          return (
            <li key={step} className="village-quest-row">
              <button
                type="button"
                data-quest-step={step}
                data-quest-state={state}
                aria-current={step === questStep ? 'step' : undefined}
                // An explicit accessible name rather than the concatenation of the
                // three spans. JSX drops the whitespace-only lines between elements,
                // so the derived name would be "Create a SubjectActive" - and a name
                // a screen reader has to parse is a name a learner has to parse too.
                // The visible text is unchanged.
                aria-label={`${QUEST_LABELS[step].label}: ${stateWord(state, step, questStep)}`}
                onClick={() => onSelectStep(step)}
                data-village-touch-target="quest-step"
                style={{ minWidth: '44px', minHeight: '44px' }}
              >
                <span aria-hidden="true">{STATE_GLYPHS[state]}</span>
                <span className="village-quest-row__title">{QUEST_LABELS[step].label}</span>
                <span className="village-quest-row__state">{stateWord(state, step, questStep)}</span>
              </button>
              {step === questStep && manual ? (
                <button
                  type="button"
                  className="village-quest-row__complete"
                  onClick={onCompleteManualStep}
                  data-quest-complete={step}
                  data-village-touch-target="quest-complete"
                  style={{ minWidth: '44px', minHeight: '44px' }}
                >
                  <span aria-hidden="true">✓</span> Mark Complete
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <VillageQuestOverview
        questStep={questStep}
        nearbyTargets={nearbyTargets}
        invoke={invoke}
        onInvoke={onInvoke}
        heading="Who can speak to this quest"
      />
    </VillagePanel>
  );
}
