/**
 * The Fish Stand: the fishing collection, as a collection view.
 *
 * ## The counting defect this removes
 *
 * The pre-Phase-17 panel decided whether the collection was complete with
 *
 * ```ts
 * const caughtCatalogIds = new Set(allFish.map((f) => f.id.split(':')[0]));
 * ```
 *
 * That is string-splitting a persisted entry id rather than resolving catalogue identity.
 * `createFishId` builds `"<catalogId>:<suffix>"`, so the split *happens* to work for entries
 * this build wrote - and it is wrong for every entry that came from anywhere else: a
 * hand-edited or imported collection whose id has no `:` yields the whole id and counts as
 * caught; a `catalogId` field on the entry is ignored entirely, even though
 * `CanonicalFishEntry` exists precisely because that field is the authority. Phase 17's exit
 * criterion is "collection counts use canonical catalog IDs and subject IDs", and the resolver
 * that criterion means already exists and is already tested:
 * {@link resolveFishCatalogId} and {@link countCanonicalCatalogTypes}.
 *
 * So **every** count and every grouping here goes through the resolver. The subject grouping
 * had the same defect in a quieter form - `new Set(allFish.map((f) => f.subjectName))` counted
 * *names*, so two subjects with the same display name counted once. It groups by `subjectId`.
 *
 * ## Why a collection view and not a grid of cards
 *
 * The old panel rendered one card per *entry*, so a learner who had caught four Moss Carp
 * saw four identical cards and a learner who had caught one of eight species saw one card and a
 * collection that looked complete. That is a list, and it cannot answer the two questions a
 * collection view exists to answer: *what do I have*, and *what is left*. So this renders:
 *
 * 1. a summary of four numbers, each counted canonically;
 * 2. the **whole catalogue**, every species present whether or not it has been caught, with the
 *    uncaught ones saying "Not caught yet" in words - a collection view that hides what you
 *    are missing is a scoreboard;
 * 3. the catch history grouped by subject, so the "which subject did this come from" question
 *    has an answer.
 *
 * ## The workspace pattern, and the `GamePhase` decision
 *
 * The regions are the Phase 14 `StudyRegion` - the same collapsible, titled, `hidden`-based
 * region the Creator, Scribe, and Archaeologist workspaces are built from - and this file's
 * colocated stylesheet carries the family's styling. It does **not** use `StudyShell`, and it
 * does **not** extend `GamePhase`, for a reason that is a gate rather than a preference:
 *
 * - `GamePhase` is `'creator' | 'scribe' | 'archaeologist'` in `src/store/sessionStore.ts`, and
 *   that file pins it to `StudyFlowPhase` in `src/application/studyFlow.ts` with a
 *   compile-time parity guard (`SessionUnionParity`). Adding a fourth member would make the
 *   guard resolve to `false` and break `npm run typecheck`, and satisfying it would mean
 *   editing `src/application/**`, which this phase does not own.
 * - Independently: a fish collection is not an archetype workspace. Nothing in it is Creator,
 *   Scribe, or Archaeologist work, and putting it in the phase union would claim it is.
 *
 * So the shell's *region primitive* is reused and its *phase identity* is not invented. The
 * panel states its own identity - a `role="dialog"` with `aria-labelledby` at its visible
 * "Fish collection" heading, the four summary numbers, and the labelled close control -
 * which is what a fourth `GamePhase` member would otherwise have supplied.
 *
 * (An earlier version of this comment said the dialog carries `aria-label="Fish collection"`.
 * It does not, and it should not: the name comes from `aria-labelledby` at the visible
 * heading three hundred lines down, which is the form that survives translation and
 * matches the visible text. `aria-label` is *absent*, deliberately - see "Dialog rules".)
 *
 * ## Dialog rules
 *
 * All four of plan 10.1's, through the shared `useModalFocus`: initial focus on the dialog
 * container, capture-phase Tab containment, Escape to close, and restoration to whatever had
 * focus when it opened. `aria-modal="true"`, `aria-labelledby` at the visible heading, and
 * `aria-describedby` at the summary sentence.
 *
 * **No `aria-label` on the dialog.** The accessible name comes from the visible `<h3>` via
 * `aria-labelledby`, and an `aria-label` beside it would be a second, divergent name for the
 * same dialog - one that would not follow the visible text.
 *
 * **The backdrop no longer closes it**, which is a deliberate behaviour change from the
 * pre-Phase-17 panel and matches `DataManagementDialog`'s reasoning: a dialog that discards a
 * learner's place because they tapped a few pixels outside it reacts to mis-aimed touch. The
 * labelled close control and `Escape` are the two routes out, and both are real controls.
 * `tests/unit/FishStandPanel.test.tsx` asserts the backdrop *does not* close it.
 *
 * ## No learner data in any key
 *
 * The catalogue grid is keyed by the **index into `FISH_CATALOG`**, and the history rows by
 * `${subjectId}::${catalogId}` - both app-minted or catalogue identities. A fish's display
 * name is content and appears as text; it is never a key, an id, an attribute, or a selector
 * value. The one learner-authored string in this file's subtree is a subject's *display name*,
 * rendered as text only.
 */
import { useCallback, useEffect, useId, useMemo, useState, type JSX } from 'react';

import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useModalFocus } from '@/ui/hooks/useModalFocus';
import { StudyRegion } from '@/ui/study/StudyShell';
import { listSubjectIds } from '@/services/persistence/subjectPersistence';
import {
  countCanonicalCatalogTypes,
  resolveFishCatalogId,
} from '@/core/fishing/fishCollectionService';
import { FISH_CATALOG, type FishEntry } from '@/core/fishing/fishingTypes';

import '@/ui/fishing/fishing.css';

/** The static region ids this view is composed of. Static vocabulary, never a subject or a fish. */
const FISH_STAND_REGION_IDS = Object.freeze({
  summary: 'fish-summary',
  catalog: 'fish-catalog',
  history: 'fish-history',
});

/** One caught entry, with the two facts this view needs decided once. */
interface StandEntry {
  readonly entry: FishEntry;
  /** Resolved through {@link resolveFishCatalogId}, never split off the entry id. */
  readonly catalogId: string;
  /** Whether the subject this entry was recorded under still exists on this device. */
  readonly subjectDeleted: boolean;
}

/** One catalogue species, and everything the collection view says about it. */
interface CatalogCell {
  /** The index into `FISH_CATALOG`. The React key, because an index into a static catalogue is static. */
  readonly index: number;
  readonly catalogId: string;
  readonly name: string;
  readonly rarity: FishEntry['rarity'];
  readonly description: string;
  /** How many entries of this species are in the collection. */
  readonly caught: number;
}

function formatDate(iso: string): string {
  try {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return iso;
    return parsed.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export interface FishStandPanelProps {
  readonly onClose: () => void;
}

export function FishStandPanel({ onClose }: FishStandPanelProps): JSX.Element {
  const colorTheme = usePreferencesStore((s) => s.colorTheme);
  const bySubject = useProgressionStore((s) => s.bySubject);
  const titleId = useId();
  const summaryId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>({ active: true, onEscape: onClose });

  const [existingSubjectIds, setExistingSubjectIds] = useState<ReadonlySet<string> | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set([FISH_STAND_REGION_IDS.summary, FISH_STAND_REGION_IDS.catalog]),
  );

  useEffect(() => {
    let cancelled = false;
    void listSubjectIds()
      .then((ids) => {
        if (cancelled) return;
        setExistingSubjectIds(new Set(ids));
      })
      .catch(() => {
        // A subject list that cannot be read is not a reason to refuse the panel: the fish
        // are on the device, and "some subjects may be deleted" is a worse answer than the
        // entries themselves. Recorded as "unknown" rather than "none exist".
        if (!cancelled) setExistingSubjectIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Every entry, with its canonical catalogue id resolved once.
   *
   * The resolution happens here rather than at each count site so the grid, the history, and
   * the completion check cannot disagree with each other - which is the whole defect.
   */
  const entries = useMemo<readonly StandEntry[]>(() => {
    const collected: StandEntry[] = [];
    for (const [recordSubjectId, progression] of Object.entries(bySubject)) {
      for (const entry of progression.fishCollection) {
        collected.push({
          entry,
          catalogId: resolveFishCatalogId(entry).catalogId,
          // The record's own key is the authority for *which record* this is; the entry's
          // `subjectId` field is what an older build wrote and is what a learner reads. They
          // can disagree, and when they do the record is where the fish actually lives.
          subjectDeleted:
            existingSubjectIds !== null &&
            existingSubjectIds.size > 0 &&
            !existingSubjectIds.has(entry.subjectId) &&
            !existingSubjectIds.has(recordSubjectId),
        });
      }
    }
    return collected;
  }, [bySubject, existingSubjectIds]);

  /**
   * The catalogue grid: every species, caught or not.
   *
   * `countCanonicalCatalogTypes` is used for the one number the resolver owns, and the per-cell
   * count is a plain tally over the *already resolved* ids rather than a second resolution,
   * so the grid and the summary are computed from the same values.
   */
  const cells = useMemo<readonly CatalogCell[]>(() => {
    const caughtPerCatalogId = new Map<string, number>();
    for (const item of entries) {
      caughtPerCatalogId.set(item.catalogId, (caughtPerCatalogId.get(item.catalogId) ?? 0) + 1);
    }
    return FISH_CATALOG.map((catalogEntry, index) => ({
      index,
      catalogId: catalogEntry.id,
      name: catalogEntry.name,
      rarity: catalogEntry.rarity,
      description: catalogEntry.description,
      caught: caughtPerCatalogId.get(catalogEntry.id) ?? 0,
    }));
  }, [entries]);

  /**
   * The distinct species count, from the resolver rather than from a hand-rolled set.
   *
   * Computed over the whole collection at once - the resolver's own function - and then
   * **reported alongside** the catalogue tally, so a collection holding an entry that is no
   * longer in the catalogue (a species from a subject the learner edited) is visible as the
   * difference between the two numbers instead of silently inflating completion.
   */
  const distinctCanonicalTypes = useMemo(
    () => countCanonicalCatalogTypes(entries.map((item) => item.entry)),
    [entries],
  );

  /**
   * How many fish are in the collection, counted from the entries themselves.
   *
   * Not the sum of the grid's per-cell tallies: a species the catalogue does not list has no
   * cell, so a grid sum would silently drop it and "1 fish kept" would become "0" for a
   * collection that demonstrably holds one. The grid answers "of the catalogue"; this answers
   * "what do I have", and the difference between them is stated rather than reconciled away.
   */
  const keptFishCount = entries.length;
  const caughtCellCount = cells.reduce((sum, cell) => sum + cell.caught, 0);
  const caughtSpecies = cells.filter((cell) => cell.caught > 0).length;
  const totalSpecies = cells.length;
  const complete = totalSpecies > 0 && caughtSpecies === totalSpecies;
  const unknownSpecies = Math.max(0, distinctCanonicalTypes - caughtSpecies);

  /**
   * The history, grouped by the subject **id**.
   *
   * Not the name: two subjects can share a display name, and a name is a learner value. The
   * group's React key is the subject id, which is an app-minted identifier.
   */
  const bySubjectId = useMemo(() => {
    const groups = new Map<string, { subjectId: string; subjectName: string; deleted: boolean; rows: StandEntry[] }>();
    for (const item of entries) {
      const key = item.entry.subjectId;
      const group = groups.get(key) ?? {
        subjectId: key,
        // The most recent entry's name, or the id when the entry carried none. Display text
        // only - it is never a key, an id, or an attribute.
        subjectName: item.entry.subjectName.length > 0 ? item.entry.subjectName : key,
        deleted: item.subjectDeleted,
        rows: [],
      };
      group.rows.push(item);
      groups.set(key, group);
    }
    return [...groups.values()].sort((left, right) =>
      left.subjectName.localeCompare(right.subjectName),
    );
  }, [entries]);

  const subjectsRepresented = bySubjectId.length;
  const subjectNoun = subjectsRepresented === 1 ? 'subject' : 'subjects';

  return (
    <div className="modal-backdrop" role="presentation" onClick={(event) => event.stopPropagation()}>
      <div
        className="village-info-panel ui-skin fish-stand-panel fish-stand__dialog"
        data-theme={colorTheme}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="village-info-panel-header">
          <span className="village-info-portal-icon" aria-hidden="true">
            🐟
          </span>
          <div>
            <h3 id={titleId}>Fish collection</h3>
            <p className="village-info-meta">
              {caughtCellCount > 0
                ? `${keptFishCount} fish kept across ${subjectsRepresented} ${subjectNoun}`
                : 'No fish kept yet'}
            </p>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close the fish collection"
            style={{ minWidth: '44px', minHeight: '44px' }}
            data-fishing-touch-target="close-collection"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <p id={summaryId} className="fishing-recall__outcome">
          {caughtCellCount > 0
            ? `You have kept ${keptFishCount} fish, ${caughtSpecies} of them species from the catalogue's ${totalSpecies}.`
            : 'No fish kept yet. Visit a fishing pond near a dungeon portal to start your collection.'}
        </p>

        {complete ? (
          <p className="fish-stand__complete">
            You have caught every species in the catalogue. Your collection is complete.
          </p>
        ) : null}

        <StudyRegion
          id={FISH_STAND_REGION_IDS.summary}
          title="Totals"
          description="Counted from the collection's canonical catalogue identities, not from entry ids or display names."
          expanded={expanded.has(FISH_STAND_REGION_IDS.summary)}
          onToggle={() => toggle(FISH_STAND_REGION_IDS.summary)}
        >
          <div className="fish-stand__summary">
            <p className="fish-stand__stat">
              <span className="fish-stand__stat-label">Fish kept</span>
              <span className="fish-stand__stat-value" data-fish-stat="kept">
                {keptFishCount}
              </span>
            </p>
            <p className="fish-stand__stat">
              <span className="fish-stand__stat-label">Species caught</span>
              <span className="fish-stand__stat-value" data-fish-stat="species">
                {caughtSpecies} of {totalSpecies}
              </span>
            </p>
            <p className="fish-stand__stat">
              <span className="fish-stand__stat-label">Species in your collection</span>
              {/*
                A third number, and the reason it is here rather than folded into "species
                caught": `countCanonicalCatalogTypes` counts *resolved* identities, including
                any that are not in the catalogue. When it disagrees with the catalogue tally,
                the difference is a fish the collection holds whose species the catalogue no
                longer lists, and hiding that behind one number would be a silent merge.
              */}
              <span className="fish-stand__stat-value" data-fish-stat="canonical-types">
                {distinctCanonicalTypes}
              </span>
            </p>
            <p className="fish-stand__stat">
              <span className="fish-stand__stat-label">Subjects fished</span>
              <span className="fish-stand__stat-value" data-fish-stat="subjects">
                {subjectsRepresented}
              </span>
            </p>
          </div>
          {unknownSpecies > 0 ? (
            <p className="fishing-recall__outcome" data-fish-unknown-species={unknownSpecies}>
              {unknownSpecies === 1
                ? 'One fish in your collection is a species the catalogue does not list any more. It is counted here and not in the grid below.'
                : `${unknownSpecies} fish in your collection are species the catalogue does not list any more. They are counted here and not in the grid below.`}
            </p>
          ) : null}
        </StudyRegion>

        <StudyRegion
          id={FISH_STAND_REGION_IDS.catalog}
          title="Catalogue"
          description="Every species you can catch, including the ones you have not caught yet."
          expanded={expanded.has(FISH_STAND_REGION_IDS.catalog)}
          onToggle={() => toggle(FISH_STAND_REGION_IDS.catalog)}
        >
          <ul className="fish-stand__grid">
            {cells.map((cell) => (
              <li
                // The index into `FISH_CATALOG`, which is a static list, is the key. The
                // catalogue id would also be stable, and the *display name* - the thing a
                // learner might edit - is not a key anywhere in this file.
                key={cell.index}
                className={
                  cell.caught > 0 ? 'fish-stand__cell' : 'fish-stand__cell fish-stand__cell--uncaught'
                }
                data-fish-catalog-id={cell.catalogId}
                data-fish-caught={cell.caught}
              >
                <span className="fish-stand__cell-name">{cell.name}</span>
                <span className="fish-rarity-badge" data-rarity={cell.rarity}>
                  {cell.rarity.toUpperCase()}
                </span>
                {/*
                  The state, in words. `aria-hidden` on the words would be exactly the
                  colour-only-adjacent mistake plan 10.1 forbids, so the sentence is the state
                  and the dashed border is a second signal.
                */}
                <span className="fish-stand__stat-label">
                  {cell.caught > 0
                    ? `Caught ${cell.caught === 1 ? 'once' : `${cell.caught} times`}`
                    : 'Not caught yet'}
                </span>
              </li>
            ))}
          </ul>
        </StudyRegion>

        <StudyRegion
          id={FISH_STAND_REGION_IDS.history}
          title="Catch history"
          description="Every fish you have kept, grouped by the subject it was caught while studying."
          expanded={expanded.has(FISH_STAND_REGION_IDS.history)}
          onToggle={() => toggle(FISH_STAND_REGION_IDS.history)}
        >
          {bySubjectId.length === 0 ? (
            <p className="fish-stand__empty">
              Nothing kept yet. Once you keep a fish it will be listed here with the subject it
              came from.
            </p>
          ) : (
            bySubjectId.map((group) => (
              <section className="fish-stand__subject-group" key={group.subjectId}>
                <h4
                  className={
                    group.deleted
                      ? 'fish-stand__subject-name fish-stand__subject-name--deleted'
                      : 'fish-stand__subject-name'
                  }
                >
                  {group.subjectName}
                  {group.deleted ? ' (deleted subject)' : ''}
                </h4>
                <ul className="fish-stand__rows">
                  {group.rows.map((item) => (
                    <li
                      // The entry id is app-minted (`createFishId` mints it) and unique within
                      // the collection, and it is joined with the resolved catalogue id so a
                      // legacy entry with a colliding id still keys uniquely. Never the name.
                      key={`${item.entry.id}::${item.catalogId}`}
                      className="fish-stand__row"
                    >
                      <span className="fish-stand__row-name">{item.entry.name}</span>
                      <span className="fish-rarity-badge" data-rarity={item.entry.rarity}>
                        {item.entry.rarity.toUpperCase()}
                      </span>
                      <time dateTime={item.entry.caughtAt} className="fish-stand__row-date">
                        {formatDate(item.entry.caughtAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </StudyRegion>
      </div>
    </div>
  );
}
