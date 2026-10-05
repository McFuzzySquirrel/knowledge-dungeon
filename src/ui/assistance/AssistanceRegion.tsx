/**
 * The lazy half: reads the mode, gates on it, and renders the card.
 *
 * ## What is in the lazy chunk and why that is the right place for it
 *
 * Everything with a cost: the store, the engine, the subject adapter, the locale bridge, the copy
 * tables, the card, and the stylesheet. `AssistanceSlot` deliberately keeps all of it out of the
 * Welcome closure, so this module is the single place those imports are written down.
 *
 * ## The mode gate, and what it costs
 *
 * `mode === 'off'` renders `null` - byte-identical to a build where the feature does not exist -
 * but reaching this module to find that out is a network request. That is the trade `AssistanceSlot`
 * makes explicitly: one fetch on a non-default build, against ten kilobytes of Welcome budget on
 * every build. The fetch is observable in a network panel; the silence is not observable by a
 * learner, which is the property the requirement names.
 *
 * The check is repeated inside the card as well, and by `rankAssistance` itself. Three checks of one
 * condition is not redundancy for its own sake: the engine's check is the guarantee, the card's is
 * what makes the DOM agree with it, and this one is what avoids *mounting* a card for a learner who
 * switched it off.
 *
 * ## Selector reads, so a signal bump does not re-render four workspaces
 *
 * `mode`, `signals`, and `dismissSuggestion` are read with three separate selectors rather than
 * one whole-state read. A whole-state read re-renders this region on every signal bump anywhere in
 * the device, and the region re-runs every rule in the engine to produce the same rows. The three
 * reads are the minimum this module needs and each one names what it needs.
 */
import type { ReactNode } from 'react';

import { useAssistanceStore } from '@/store/assistanceStore';
import { useTranslation } from 'react-i18next';

import { AssistanceCard } from './AssistanceCard';
import type { AssistanceFishingFacts, AssistanceSlotSurface } from './AssistanceSlot';

export interface AssistanceRegionProps {
  readonly surface: AssistanceSlotSurface;
  readonly snapshot: unknown;
  readonly fishing: AssistanceFishingFacts | null;
  readonly flagEnabled: boolean;
}

export function AssistanceRegion({
  surface,
  snapshot,
  fishing,
  flagEnabled,
}: AssistanceRegionProps): ReactNode {
  const mode = useAssistanceStore((state) => state.mode);
  const signals = useAssistanceStore((state) => state.signals);
  const dismiss = useAssistanceStore((state) => state.dismissSuggestion);
  const { i18n } = useTranslation();

  // Hooks above, gate below. An early return placed *above* a hook is a conditional hook call,
  // which React will one day call with a different hook order in the same component - and this is
  // precisely the component whose mode changes.
  if (!flagEnabled) return null;
  if (mode === 'off') return null;

  return (
    <AssistanceCard
      surface={surface}
      snapshot={snapshot as never}
      fishing={fishing}
      mode={mode}
      signals={signals}
      flagEnabled={flagEnabled}
      locale={narrowLocale(i18n.resolvedLanguage ?? i18n.language)}
      onDismiss={dismiss}
    />
  );
}

/**
 * Narrow an i18next language tag to one of the two supported locales.
 *
 * `es-MX` and `es-419` both become `es`, which is what i18next does with them and what the learner
 * expects. Anything else becomes `en` rather than `null`: a card that declined to render because it
 * did not recognise a language tag would be the same absence a learner is not meant to notice,
 * reached for a different reason.
 */
function narrowLocale(language: string | undefined): 'en' | 'es' {
  const base = (language ?? '').split('-')[0]?.trim().toLowerCase() ?? '';
  return base === 'es' ? 'es' : 'en';
}