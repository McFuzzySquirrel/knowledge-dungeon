/**
 * The published words on a private share card (plan section 20).
 *
 * ## Why this module exists
 *
 * A share card is a picture a learner chooses to send to one other human. The pre-Phase-20
 * exporter drew `• ${badge}` for every badge the learner held, and
 * `src/ui/components/InventoryBadgesPanel.tsx` resolved labels with
 * `BADGE_LABELS[badgeId] ?? badgeId` over a map that held exactly one entry. So every badge
 * except `ScribeCentury120` reached the image as a raw identifier - `CreatorPhaseComplete`,
 * `ArchaeologistReviewPass15` - on the one surface whose entire purpose was to be safe to
 * publish. No typing rule catches that. `CreatorPhaseComplete` is a perfectly good `string`.
 *
 * So the words are authored here, deliberately, by the owner of content rather than derived
 * from the identifier. An id that this module does not recognise resolves to `undefined`, and
 * `buildShareCardModel` turns that into **no row at all** - which is what lets a card say
 * "3 badges" honestly while inventing no name for the third.
 *
 * ## The three properties other owners' code depends on
 *
 * 1. **Never the id.** `canonicalBadgeLabel` returns `undefined` for an id it does not know.
 *    There is no `?? id`, no case folding, no trimming, no prefix match, and no second
 *    fallback spelling anywhere in this file.
 * 2. **Total over the canonical set.** Every id in `PHASE_BADGE_IDS`, every id in
 *    `FISHING_BADGE_IDS`, and `SCRIBE_CENTURY_120_BADGE_ID` resolves to a non-empty label.
 * 3. **Total over the field vocabulary.** `SHARE_CARD_FIELD_LABELS` carries a non-empty label
 *    for all seventeen `ShareCardField` members, and no label equals its own field id - that
 *    would be the same fallback defect wearing a different hat, since `shareCardModel`
 *    resolves every row's label from here.
 *
 * `shareCardTitle` and `shareCardCaption` are non-empty and distinct per kind. These four
 * exports are the module's whole public shape; nothing else in the codebase imports from here.
 *
 * ## Where each badge name comes from
 *
 * Three sources, and the provenance is kept visible because a reviewer should be able to tell
 * published copy from copy written here:
 *
 * | Source | Ids | Treatment |
 * | --- | --- | --- |
 * | `FISHING_BADGE_DEFS` | `FshFirstCatch`, `FshAngler`, `FshMasterAngler`, `FshFullCreel` | **Reused verbatim.** These already carry a label the fish domain shows a learner, and a share card must not name a badge differently from the screen it was earned on. |
 * | `SCRIBE_CENTURY_120_BADGE_LABEL` | `ScribeCentury120` | **Reused verbatim.** The inventory panel already shows this one by name. |
 * | {@link PHASE_BADGE_LABELS} | the six in `PHASE_BADGE_IDS` | **Authored here**, because no other module had a name for them. |
 *
 * ## Why the six phase badges had no name to match
 *
 * `InventoryBadgesPanel.tsx` describes each of the six in prose - "Mapped 90%+ of rooms in
 * the creator phase", "Cleared every room by completing scribe encounters", "Completed at
 * least two full archaeology review passes" - but its `BADGE_LABELS` map covers only
 * `ScribeCentury120`, so `badgeDetail()` renders the raw id as the badge's *name* and the
 * prose as its description. There was no warmer existing name to match, and no badge-name
 * vocabulary to join. These six are therefore the first published names for these six badges,
 * and they are written to the words the learner has actually met:
 *
 * - `game.map` is "Map" and the creator phase is described as building the map, so the creator
 *   badge is "First Map".
 * - The scribe phase is "Explore your dungeon and defeat encounters by writing structured
 *   notes", so the scribe badge is "Keeper of the Notes".
 * - The archaeologist phase is "Review cleared rooms with self-check prompts to reinforce
 *   learning", so the phase badge is "Deep Reader".
 * - The three review-pass badges are a ladder of 3, 7, and 15 full passes. They say their
 *   number. A badge a learner cannot place on a ladder is a badge they cannot read at a
 *   glance, and the panel's description is not on a shared image.
 *
 * No name here praises the learner or judges their ability, which is plan section 8's rule for
 * the assistance catalogue and the same rule for a badge name. No name carries an emoji: on an
 * image an emoji is decoration, and a badge whose only meaning was a glyph would mean nothing
 * to a screen reader or in a monochrome print.
 *
 * ## Unit discipline: a label's noun is the unit its value is counted in
 *
 * Phase 19 found a hardcoded literal `1` published under the key `rooms-cleared` and shown to
 * a learner with an unstarted subject as "1 room cleared" - a false claim about the learner's
 * own progress. The unit is not pedantry; it is the difference between a count and a lie.
 *
 * So each label's noun is checked against what `shareCardModel.buildRow` actually puts in the
 * field, and the two room counts are deliberately kept apart. `roomTotal` counts rooms that
 * **exist** (the graph); `roomsCleared` counts rooms that have been **cleared** (the ledger).
 * Labelling the first "Rooms cleared" would repeat the Phase 19 defect in new words, which is
 * why it reads "Rooms in the dungeon" and why neither says "this subject" - a learner may
 * deselect the subject name, and a label may not point at something the card does not show.
 *
 * ## Locale: this module is English-only, and that is a known gap
 *
 * Phase 19 shipped the assistance catalogue as 32 i18n keys present in both `en` and `es`,
 * with parity asserted in both directions. This module does **not** do that, and the reason
 * is structural rather than a preference:
 *
 * - `tests/phase20/shareCardPolicy.test.ts` walks the **runtime** import closure of every
 *   module in `src/core/share/` and fails on any edge outside `src/core/`. Importing
 *   `@/i18n/locales/en.json` is such an edge - the JSON lives in `src/i18n/` - so a locale
 *   table cannot be read from here at all without failing that gate, and this file's gate is
 *   not mine to amend.
 * - Phase 19's own solution points the other way: `assistanceEngine` emits `titleKey` /
 *   `detailKey` / `labelKey` and never a sentence, so its catalogue has a consumer. This
 *   module is *contractually* the thing that returns `string`, and other owners are being
 *   written against that shape right now. Switching to keys is an API change to
 *   `canonicalBadgeLabel`, `SHARE_CARD_FIELD_LABELS`, `shareCardTitle`, and
 *   `shareCardCaption`, not a content edit.
 *
 * So the honest position is: **every word a Spanish-reading learner sees on a card today is
 * English.** That is a real limitation, it is a Phase 21 item, and it is not mitigated by
 * this file. The route that preserves the four exported signatures is for the renderer to
 * resolve a key this module also exposes, with the string here as the `en` fallback - which
 * means adding keys to `en.json` and `es.json` and asserting parity both ways, the way
 * `assistanceCatalogueCoverage.test.ts` does. No such keys are added here, because a key with
 * no consumer is dead copy that looks like localisation.
 *
 * ## Determinism
 *
 * No clock, no locale API, no `Intl`, no randomness, no colour, no font, no storage. Every
 * string here is a constant or the result of a `Map` lookup, which is what lets the same card
 * be byte-identical on two devices - the property the model is tested on, and the reason
 * `shareCardModel` carries no `now` parameter at all.
 */
import {
  FISHING_BADGE_DEFS,
  FISHING_BADGE_IDS,
  PHASE_BADGE_IDS,
  SCRIBE_CENTURY_120_BADGE_ID,
  SCRIBE_CENTURY_120_BADGE_LABEL,
  type PhaseBadgeId,
} from '@/core/progression/types';

import type { ShareCardField, ShareCardKind } from './types';

/**
 * The six phase badges, named.
 *
 * Typed `Record<PhaseBadgeId, string>` on purpose: adding a seventh id to `PHASE_BADGE_IDS`
 * is a **typecheck error** here until somebody writes its name. That is the review gate the
 * phase needs - an id nobody labelled would otherwise be a badge the learner holds, that this
 * module cannot name, and so that quietly vanishes from every card they publish.
 */
const PHASE_BADGE_LABELS: Readonly<Record<PhaseBadgeId, string>> = Object.freeze({
  // Creator: the phase that builds the map of the dungeon's rooms.
  CreatorPhaseComplete: 'First Map',
  // Scribe: the phase that defeats every encounter by writing a valid note.
  ScribePhaseComplete: 'Keeper of the Notes',
  // Archaeologist: the phase that reviews cleared rooms with self-check prompts.
  ArchaeologistPhaseComplete: 'Deep Reader',
  // The review-pass ladder. Each name states its own threshold, because the panel's
  // explanation is not on a shared image.
  ArchaeologistReviewPass3: 'Three Review Passes',
  ArchaeologistReviewPass7: 'Seven Review Passes',
  ArchaeologistReviewPass15: 'Fifteen Review Passes',
});

/**
 * Every badge id this build can name, read off the progression module.
 *
 * Derived rather than transcribed, so it cannot drift: adding an id upstream grows this list
 * with it. Exported for a totality test to walk - the property "every canonical id resolves"
 * is the one thing in this file that reading it cannot establish.
 */
export const CANONICAL_SHARE_BADGE_IDS: readonly string[] = Object.freeze([
  ...PHASE_BADGE_IDS,
  SCRIBE_CENTURY_120_BADGE_ID,
  ...FISHING_BADGE_IDS,
]);

/**
 * The lookup, as a `Map` rather than an object literal.
 *
 * Structural, not stylistic. `BADGE_LABELS[badgeId] ?? badgeId` was the defect, and an object
 * lookup keeps a second one available to the next reader: on `{ ScribeCentury120: '...' }`,
 * `BADGE_LABELS['constructor']` and `BADGE_LABELS['toString']` both return something truthy
 * from `Object.prototype` without the map ever having declared them. A `Map` has no prototype,
 * so every one of those lookups returns `undefined` for free.
 */
const BADGE_LABELS_BY_ID: ReadonlyMap<string, string> = new Map<string, string>([
  ...Object.entries(PHASE_BADGE_LABELS),
  // The already-published labels, reused rather than reworded: the scribe-century badge the
  // inventory panel shows by name, and every fishing badge.
  [SCRIBE_CENTURY_120_BADGE_ID, SCRIBE_CENTURY_120_BADGE_LABEL],
  ...FISHING_BADGE_IDS.map((id) => [id, FISHING_BADGE_DEFS[id].label] as const),
]);

/**
 * The published name of a badge id, or `undefined` when the id is not one of ours.
 *
 * **Total, and never the id.** An unrecognised id yields `undefined`, which
 * `buildShareCardModel` turns into no row - so the learner keeps a `badgeCount` of their real
 * badges and the card invents no name. That is the whole promise of this phase.
 *
 * Three deliberate refusals:
 *
 * - **No trimming.** `' CreatorPhaseComplete '` is not the canonical id. Repairing it would be
 *   a guess about which badge a corrupt record meant, and a guess that silently names the
 *   wrong achievement on a published image is worse than naming none.
 * - **No case folding.** Badge ids are exact, app-owned tokens. `'scribecentury120'` is not
 *   `ScribeCentury120`, and the same argument applies.
 * - **No prefix or fuzzy match.** Near-misses are how the wrong badge gets named.
 *
 * The `typeof` guard is for a value read back from a restored preference, which is `string`
 * only in the type and not in the storage.
 */
export function canonicalBadgeLabel(badgeId: string): string | undefined {
  if (typeof badgeId !== 'string' || badgeId.length === 0) return undefined;
  return BADGE_LABELS_BY_ID.get(badgeId);
}

/**
 * The display name of every selectable field, and of nothing else.
 *
 * Total over `ShareCardField`, so `shareCardModel.fieldLabel` never falls back to printing the
 * field id onto a card. The trailing comment on each entry is the unit the value is counted
 * in, checked against `shareCardModel.buildRow`:
 *
 * | Field | Label | Unit of the value |
 * | --- | --- | --- |
 * | `subjectName` | Subject name | not a count: the learner's own name, and their choice to publish it |
 * | `rank` | Rank | a closed tier - Novice, Scholar, or Master - not a number |
 * | `xpTotal` | Total XP | XP points, a lifetime total rather than a gain |
 * | `roomsCleared` | Rooms cleared | rooms, cleared so far, from the clear ledger |
 * | `roomTotal` | Rooms in the dungeon | rooms that exist, from the graph - **not** rooms cleared |
 * | `badgeCount` | Badges | badges held, counting ids that have no published name too |
 * | `badgeLabels` | Badges earned | a list of badge names; each entry is one badge |
 * | `inventoryCount` | Artifacts | artifacts held in the inventory |
 * | `collectedNoteCount` | Collected notes | notes, counted; never a note body |
 * | `fishTotal` | Fish caught | individual fish, one per catch |
 * | `fishUniqueTypes` | Different species | species, counted once however often caught |
 * | `fishRarityCounts` | Fish by rarity | fish, grouped into common, rare, and epic |
 * | `studyStreakDays` | Study streak in days | days, consecutive |
 * | `activeStudyDays` | Days with activity recorded | days on which activity was recorded |
 * | `sessionsCompleted` | Study sessions | sessions |
 * | `recallAccuracy` | Recall accuracy | a ratio of correct answers to answers given |
 * | `assistanceSummary` | Sessions with assistance | sessions in which assistance was shown |
 *
 * Three of these are the wording the app already ships elsewhere, reused rather than
 * reinvented: "Rooms cleared" and "Days with activity recorded" are
 * `assistance.evidence.rooms-cleared` and `assistance.evidence.active-study-days` verbatim, and
 * "Different species" is the statistics screen's label for `distinctFishSpecies`. A count a
 * learner has already read in one place should read identically in the next.
 *
 * `badgeCount` and `badgeLabels` are the one pair that looks redundant and is not: the count
 * includes badge ids this module has no name for, while the list can only show named ones. A
 * learner holding three badges whose names are all unrecognised gets "Badges 3" and no list -
 * which is honest, and is why the two labels must not collapse into the same words.
 */
export const SHARE_CARD_FIELD_LABELS: Readonly<Record<ShareCardField, string>> = Object.freeze({
  // A picker label: the value is a name, not a count.
  subjectName: 'Subject name',
  rank: 'Rank',
  xpTotal: 'Total XP',
  // The pair the Phase 19 unit defect lived in. These two must never swap nouns.
  roomsCleared: 'Rooms cleared',
  roomTotal: 'Rooms in the dungeon',
  badgeCount: 'Badges',
  badgeLabels: 'Badges earned',
  inventoryCount: 'Artifacts',
  collectedNoteCount: 'Collected notes',
  fishTotal: 'Fish caught',
  fishUniqueTypes: 'Different species',
  fishRarityCounts: 'Fish by rarity',
  studyStreakDays: 'Study streak in days',
  activeStudyDays: 'Days with activity recorded',
  sessionsCompleted: 'Study sessions',
  recallAccuracy: 'Recall accuracy',
  assistanceSummary: 'Sessions with assistance',
});

/**
 * The title drawn at the top of a card.
 *
 * These appear on a **published image**, so they are written to be read with no other context:
 *
 * - **First person, not second.** "My" attributes the numbers to the person who sent the
 *   image, which is knowable to whoever received it. Addressing the reader as "you" would not
 *   be - the reader is not the one who studied - and the pre-Phase-20 exporter's unattributed
 *   "Progress Snapshot" had the opposite problem, reading like a system-wide statistic.
 * - **"so far" on every one.** A card is a sample of a learner's work at a moment, not a
 *   result, and no field on it implies completion. The pre-Phase-20 image claimed
 *   completeness by saying nothing about it; "so far" is the honest word and it costs four
 *   characters.
 * - **No date, no time, no count.** The date is not there because it cannot be - the model has
 *   no clock - and it is also better absent: a timestamp on a shared image is a small fact
 *   about the learner's schedule that they never chose to publish.
 */
const TITLES: Readonly<Record<ShareCardKind, string>> = Object.freeze({
  'subject-summary': 'My subject so far',
  collection: 'My collection so far',
  fish: 'My fish so far',
  statistics: 'My study so far',
});

/**
 * The caption drawn under the title.
 *
 * Each states the **scope** of the card and never its contents. A caption that listed rows -
 * "Rooms cleared, XP, and badges" - would be false the moment a learner deselects one of them,
 * which is the single most likely thing to happen on this surface. So the caption names what
 * kind of thing the card is, and stops there.
 *
 * None of them refers to anything the viewer cannot see. "this subject" is deliberately absent
 * from every caption and from every field label in this file, because a learner may publish a
 * card with no subject name on it and a label pointing at a missing thing reads as an error.
 */
const CAPTIONS: Readonly<Record<ShareCardKind, string>> = Object.freeze({
  // One subject, and the card says so rather than implying a whole dungeon.
  'subject-summary': 'Progress on one subject',
  collection: 'Collected along the way',
  // The pond is where fishing happens in this app, so the caption locates the catches.
  fish: 'Caught at the pond',
  // No field is named, and no praise is offered for the days.
  statistics: 'One study, day by day',
});

/**
 * The card's title for a kind. Never empty, never the kind's id.
 *
 * Falls back to the subject-summary title for a kind this build does not know, because a card
 * with no title would be worse than a card with the wrong one, and the caller has already been
 * filtered to real kinds by `normalizeShareCardSelection`.
 */
export function shareCardTitle(kind: ShareCardKind): string {
  return TITLES[kind] ?? TITLES['subject-summary'];
}

/** The card's caption for a kind. Never empty. Same unknown-kind fallback as the title. */
export function shareCardCaption(kind: ShareCardKind): string {
  return CAPTIONS[kind] ?? CAPTIONS['subject-summary'];
}