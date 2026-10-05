/**
 * Phase 19: the assistance string catalogue covers every key the engine can emit, in
 * every locale, and carries no key that drifts between them.
 *
 * ## Why this file exists and why it is not a rendering test
 *
 * `src/core/assistance/assistanceEngine.ts` never produces a sentence. It produces
 * `titleKey = assistance.title.<kind>`, `detailKey = assistance.detail.<reasonCode>`, and
 * evidence rows whose `labelKey` is `evidence.<member>` - three i18n keys, derived at render
 * time from closed vocabularies. That design is the reason a stale explanation cannot exist,
 * and it has one consequence nobody can check by reading: **a key the engine can emit but the
 * catalogue does not define renders as the raw key string.** A learner would read
 * `assistance.detail.review-low-recall` on a card and be told nothing at all, and because the
 * engine is deterministic that failure is permanent rather than intermittent.
 *
 * So the coverage property is asserted here, against the engine's own exported arrays rather
 * than against a list transcribed into this file. A transcription would pass while the engine
 * gained a tenth kind; importing `ASSISTANCE_SUGGESTION_KINDS` means the gate cannot be
 * satisfied by a stale copy of the vocabulary.
 *
 * ## The three shapes of key, and why two of them are paths
 *
 * i18next resolves a dotted key as a **path**, not as a flat lookup, and the engine's key
 * shapes make that load-bearing:
 *
 * | Engine field | Emitted value | Resolved path |
 * | --- | --- | --- |
 * | `titleKey` | `assistance.title.creator.missing-branch` | `assistance` > `title` > `creator` > `missing-branch` |
 * | `detailKey` | `assistance.detail.review-low-recall` | `assistance` > `detail` > `review-low-recall` |
 * | `labelKey` | `evidence.failed-checks` | `assistance` > `evidence` > `failed-checks` |
 *
 * The first is a four-segment path because `AssistanceSuggestionKind` members contain dots as
 * well as hyphens (`creator.missing-branch`), so a flat key would be ambiguous with the
 * nesting around it. The second is a three-segment path whose leaf carries a hyphen. The third
 * is **not** emitted with the `assistance.` prefix the other two carry - it is the bare
 * evidence vocabulary member - so the catalogue nests it under the same root and this file
 * resolves it as `assistance.${labelKey}`. That prefixing is the one interpretive decision in
 * the catalogue; it is named in a constant below so it is a single line to change rather than
 * a convention buried in a test.
 *
 * ## Symmetry is part of the contract, not hygiene
 *
 * A Spanish learner must not be the only reader who can tell why a card appeared. The parity
 * assertion is therefore about *keys*, and it is deliberately in both directions: a key in
 * `es` that `en` lacks is an untranslated string leaking raw English key paths to a Spanish
 * screen, which is exactly the failure a fallback to `en` hides from a test that only checks
 * one direction.
 */
import { describe, expect, it } from 'vitest';

import {
  ASSISTANCE_EVIDENCE_KEYS,
  ASSISTANCE_SUGGESTION_KINDS,
  type AssistanceReasonCode,
} from '@/core/assistance/types';

import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';

/**
 * Every `AssistanceReasonCode`, as data.
 *
 * The union has no runtime representation - it is a type, so there is no array to import -
 * and the alternative, an array that *claims* to be the union, would be a second source of
 * truth that drifts silently: adding a tenth code to `src/core/assistance/types.ts` would
 * typecheck fine and leave this file testing nine. Each member is therefore asserted to be
 * assignable, so dropping a member is a **typecheck** failure rather than a runtime gap, and
 * the array below is asserted to hold exactly ten distinct entries.
 */
const REASON_CODES = [
  'graph-no-branch',
  'graph-related-tag-unlinked',
  'note-missing-required-section',
  'note-validation-failed',
  'note-adjacent-room-unreferenced',
  'note-rubric-criterion-low',
  'review-due',
  'review-low-recall',
  'fishing-recall-missed',
  'device-reviews-due',
] as const satisfies readonly AssistanceReasonCode[];

/** How `titleKey` is built. Mirrors `assistanceEngine.ts` exactly. */
function titleKeyFor(kind: string): string {
  return `assistance.title.${kind}`;
}

/** How `detailKey` is built. Mirrors `assistanceEngine.ts` exactly. */
function detailKeyFor(reasonCode: string): string {
  return `assistance.detail.${reasonCode}`;
}

/**
 * How an evidence `labelKey` becomes a catalogue path.
 *
 * The engine emits the bare `evidence.<member>`; the catalogue hangs it off the same
 * `assistance.` root as the other two key shapes.
 */
function evidenceKeyFor(labelKey: string): string {
  return `assistance.${labelKey}`;
}

/** A nested locale tree. */
type LocaleTree = { readonly [key: string]: string | LocaleTree };

/**
 * Flatten a nested locale tree to dotted leaf paths.
 *
 * Only string leaves are emitted: a key that resolves to an object is a branch, and a branch
 * named where a leaf is expected is precisely the bug the four-segment title paths exist to
 * prevent (`assistance.title.creator` as a string instead of an object).
 */
function flatten(tree: LocaleTree, prefix: string): Map<string, string> {
  const leaves = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (typeof value === 'string') leaves.set(path, value);
    else for (const [nested, text] of flatten(value, path)) leaves.set(nested, text);
  }
  return leaves;
}

/** Resolve a dotted path against a flattened tree, or `null` if any segment is missing. */
function resolve(leaves: ReadonlyMap<string, string>, path: string): string | null {
  const value = leaves.get(path);
  return typeof value === 'string' ? value : null;
}

const EN = flatten(en as LocaleTree, '');
const ES = flatten(es as LocaleTree, '');

/** Every key the engine can emit, per locale. */
const REQUIRED_KEYS: readonly string[] = [
  ...ASSISTANCE_SUGGESTION_KINDS.map(titleKeyFor),
  ...REASON_CODES.map(detailKeyFor),
  ...ASSISTANCE_EVIDENCE_KEYS.map(evidenceKeyFor),
];

/**
 * Every catalogue leaf path under the `assistance` root, in one locale, sorted.
 *
 * Leaves only: `flatten` records string values, so a branch such as `assistance.title` or
 * `assistance.title.creator` is not in this set and a branch where a leaf belongs is
 * therefore invisible here - which is why {@link REQUIRED_KEYS} resolution, not this set, is
 * the assertion that catches a mis-nested key.
 */
function assistanceKeys(leaves: ReadonlyMap<string, string>): string[] {
  return [...leaves.keys()].filter((key) => key.startsWith('assistance.')).sort();
}

/**
 * Words a suggestion must never use about the learner.
 *
 * Plan section 8 forbids sensitive-trait inference, and the sharper version of that rule is
 * the one these words break: a card is allowed to say what the work in front of the learner
 * is, and is not allowed to say what kind of person the learner is. Every entry here is a
 * word that would make a card a statement about the person rather than about the note, the
 * map, or the review schedule.
 *
 * `behind` is in this list and is also an ordinary English word, which is the point: the
 * fishing title originally read "Open the room behind that question" and was reworded, because
 * a banned-phrase gate that a good sentence can trip is a gate nobody trusts. Spanish has its
 * own list rather than a translation of this one, because `lento` and `viejo` are not the same
 * trap as `slow` and `old` and a mechanical translation would miss the local one.
 */
const BANNED_EN = [
  'slow', 'slower', 'slowest', 'behind', 'weak', 'weaker', 'weakest', 'lazy', 'lazier',
  'struggle', 'struggles', 'struggling', 'young', 'younger', 'youth', 'old', 'older',
  'ability', 'able', 'clever', 'smart', 'dumb', 'stupid', 'careless', 'hopeless', 'insecure',
];

const BANNED_ES = [
  'lento', 'lenta', 'lentos', 'lentas', 'retrasado', 'retrasada', 'débil', 'debil', 'débiles',
  'flojo', 'floja', 'perezoso', 'perezosa', 'joven', 'viejo', 'vieja', 'incapaz', 'torpe',
  'torpes', 'inseguro', 'insegura', 'desesperado', 'desesperada',
];

/**
 * Words that turn a *count* into praise for the learner.
 *
 * Separate from {@link BANNED_EN} because the two lists catch different failures. That one
 * catches a card calling the learner slow; this one catches a card calling the learner's work
 * good. The second is the easier mistake to make and the harder to spot by eye, because "Rooms
 * cleared" and "Rooms you cleared" are the same five words with a different claim - and only one
 * of them is a fact about a room.
 *
 * `done` and `completad[oa]` are here rather than in the applied-suggestion list because a count
 * label is where they do their damage: "Rooms done: 5" reads as an app judgement about progress,
 * where the honest claim is only that the clear ledger recorded five.
 */
const PRAISE_EN = ['you finished', 'you completed', 'you cleared', 'you got', 'great', 'well done', 'rooms done', 'impressive', 'proud', 'achievement', 'mastered', 'mastery', 'excellent'];
const PRAISE_ES = ['terminaste', 'completaste', 'superaste', 'lo lograste', 'enhorabuena', 'muy bien', 'logro', 'dominio', 'dominaste', 'impresionante', 'excelente'];

/**
 * Drop combining marks so `sección` and `seccion` compare equal.
 *
 * A combining-diacritic class rather than the precomposed `À-ÿ` range, which excludes several
 * precomposed characters and would make the fold asymmetric. Escaped rather than literal so the
 * class survives a copy-paste or an editor that normalises the range into raw marks.
 */
const COMBINING_MARKS = /\p{M}/gu;

/** Fold a string for accent-insensitive comparison: lowercase, then marks removed. */
function foldForCompare(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

function bannedHits(leaves: ReadonlyMap<string, string>, banned: readonly string[]): string[] {
  const hits: string[] = [];
  for (const key of assistanceKeys(leaves)) {
    const text = (leaves.get(key) ?? '').toLowerCase();
    for (const word of banned) {
      // Whole-word match via Unicode letter lookarounds rather than `\b`, because `\b` is
      // ASCII-only and would split a Spanish word at an accented vowel.
      const pattern = new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'u');
      if (pattern.test(text)) hits.push(`${key}: ${word}`);
    }
  }
  return hits;
}

describe('the assistance catalogue is complete', () => {
  it('the vocabularies this gate tests against are the ones the engine exports', () => {
    // The anti-vacuity guard. If an import ever silently resolved to an empty array, every
    // assertion below would pass over zero keys.
    expect(ASSISTANCE_SUGGESTION_KINDS.length).toBeGreaterThan(0);
    expect(ASSISTANCE_EVIDENCE_KEYS.length).toBeGreaterThan(0);
    expect(REASON_CODES.length).toBeGreaterThan(0);
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    // Every derived key is distinct, and the total is the **sum of the three vocabularies**
    // rather than a literal. A fourteenth evidence key or a fifth suggestion kind therefore
    // needs no edit here: `REQUIRED_KEYS` grows with the arrays it is built from, the
    // "no invented keys" assertion below then fails until the catalogue catches up, and the
    // count that a reader can check is arithmetic rather than a number somebody remembered.
    // When this did hold literals, the eleventh evidence key made it RED on a vocabulary
    // change nobody had asked this file about.
    expect(new Set(REQUIRED_KEYS).size).toBe(REQUIRED_KEYS.length);
    expect(REQUIRED_KEYS.length).toBe(
      ASSISTANCE_SUGGESTION_KINDS.length + REASON_CODES.length + ASSISTANCE_EVIDENCE_KEYS.length,
    );
  });

  it('every settings tab is localized in both locales', () => {
    // Outside the `assistance.` root, so the engine-key walk above cannot reach it, and it was
    // genuinely missing from both files once. The defect it guards is asymmetric and therefore
    // invisible in English-only testing: `settings.tabs.assistance` resolving to nothing means
    // the Spanish settings build shows the **English** fallback for that one tab while the four
    // beside it are translated.
    //
    // The tab list itself is the engine's business - `SettingsModal` owns it - so it is
    // asserted to be non-empty and consistent between locales rather than pinned here. A sixth
    // tab is `SettingsModal`'s edit to make, and this fails until both catalogues carry it.
    const enTabs = (en as LocaleTree).settings as LocaleTree;
    const esTabs = (es as LocaleTree).settings as LocaleTree;
    const enTabKeys = Object.keys(enTabs.tabs as LocaleTree).sort();
    const esTabKeys = Object.keys(esTabs.tabs as LocaleTree).sort();
    expect(enTabKeys.length).toBeGreaterThan(0);
    expect(esTabKeys).toEqual(enTabKeys);
    // Every tab has a non-empty string in both locales.
    const absent: string[] = [];
    for (const tab of enTabKeys) {
      if (resolve(EN, `settings.tabs.${tab}`) === null) absent.push(`en: ${tab}`);
      if (resolve(ES, `settings.tabs.${tab}`) === null) absent.push(`es: ${tab}`);
    }
    expect(absent).toEqual([]);
    // `assistance` specifically, named rather than left to the loop above. The loop proves both
    // catalogues carry every tab key; this proves the one this phase added is among them, so a
    // future edit that drops it fails with the tab's name in the message instead of as one
    // unlabelled entry in an array.
    expect(resolve(EN, 'settings.tabs.assistance')).toBe('Assistance');
    expect(resolve(ES, 'settings.tabs.assistance')).toBe('Asistencia');
    // Deliberately **not** asserted that every tab's two translations differ. A language may
    // legitimately share a word with English - `Audio` is `Audio` in both files today - and a
    // gate that flagged correct copy would train the next person to route around it. What
    // matters is that a Spanish tab is present and is not the raw key; a same-text pair is
    // reviewable by reading the file, and `es.json` being a real locale is a property of its
    // whole contents rather than of this one tab.
  });

  it('every title the engine can emit resolves to real text in both locales', () => {
    const missing: string[] = [];
    for (const key of ASSISTANCE_SUGGESTION_KINDS.map(titleKeyFor)) {
      for (const [label, leaves] of [['en', EN], ['es', ES]] as const) {
        const value = resolve(leaves, key);
        if (value === null) missing.push(`${label}: ${key} is absent`);
        else if (value.trim().length === 0) missing.push(`${label}: ${key} is empty`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every detail the engine can emit resolves to real text in both locales', () => {
    const missing: string[] = [];
    for (const key of REASON_CODES.map(detailKeyFor)) {
      for (const [label, leaves] of [['en', EN], ['es', ES]] as const) {
        const value = resolve(leaves, key);
        if (value === null) missing.push(`${label}: ${key} is absent`);
        else if (value.trim().length === 0) missing.push(`${label}: ${key} is empty`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every evidence label the engine can emit resolves to real text in both locales', () => {
    const missing: string[] = [];
    for (const key of ASSISTANCE_EVIDENCE_KEYS.map(evidenceKeyFor)) {
      for (const [label, leaves] of [['en', EN], ['es', ES]] as const) {
        const value = resolve(leaves, key);
        if (value === null) missing.push(`${label}: ${key} is absent`);
        else if (value.trim().length === 0) missing.push(`${label}: ${key} is empty`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a dotted title key resolves as a path, not as a flat key', () => {
    // The shape check that a `hasOwnProperty` lookup would not catch. If a title were ever
    // authored as one flat key `"creator.missing-branch"`, i18next would look for
    // `assistance.title.creator` > `missing-branch`, find an object or nothing, and render
    // the raw key - while a naive `keys().includes('assistance.title.creator.missing-branch')`
    // assertion would happily pass.
    expect(resolve(EN, 'assistance.title.creator.missing-branch')).not.toBeNull();
    expect(resolve(ES, 'assistance.title.creator.missing-branch')).not.toBeNull();
    // The branch itself is not a leaf.
    expect(EN.get('assistance.title.creator')).toBeUndefined();
    expect(EN.get('assistance.title')).toBeUndefined();
  });

  it('neither locale carries an assistance key the other lacks', () => {
    const enOnly = assistanceKeys(EN).filter((key) => !ES.has(key));
    const esOnly = assistanceKeys(ES).filter((key) => !EN.has(key));
    // Both directions, reported together: a key present only in `es` is a Spanish screen
    // showing an English fallback path, and a one-directional check would never see it.
    expect({ enOnly, esOnly }).toEqual({ enOnly: [], esOnly: [] });
  });

  it('the catalogue holds exactly the keys the engine emits, and no invented ones', () => {
    // The reverse direction of coverage: a stale key left behind after the engine renamed a
    // reason code is dead copy that will never render and that nobody will ever re-check.
    const required = [...REQUIRED_KEYS].sort();
    expect(assistanceKeys(EN)).toEqual(required);
    expect(assistanceKeys(ES)).toEqual(required);
  });
});

describe('the assistance copy stays about the work, not about the learner', () => {
  it('no string names the learner slow, behind, weak, lazy, or by an age or an ability', () => {
    expect(bannedHits(EN, BANNED_EN)).toEqual([]);
    expect(bannedHits(ES, BANNED_ES)).toEqual([]);
  });

  it('every label names the unit its key names', () => {
    // The regression guard for the unit collision that made one label false on one of two
    // cards. `evidence.overdue-days` is days and `evidence.overdue-rooms` is rooms, so a label
    // reading "Rooms" on the days key is false every time it renders - and "days" on the rooms
    // key is false every time it renders. Both are reachable: the `review-due` arm publishes
    // `overdue-days` and the device arm publishes `overdue-rooms`.
    //
    // Asserted as a required word per key rather than a banned word per label, because the
    // failure mode is a *missing* unit, and a banned-word list cannot notice an omission.
    // One list per language, because the unit nouns are language-specific and a shared list
    // would force the Spanish wording to contain English stems. Both are checked, since the
    // Spanish copy is a real translation rather than a transliteration and can drift from the
    // English claim independently.
    const units: Readonly<Record<'en' | 'es', Readonly<Record<string, readonly string[]>>>> = {
      en: {
        'evidence.overdue-days': ['day'],
        'evidence.overdue-rooms': ['room'],
        'evidence.subject-rooms': ['room'],
        'evidence.rooms-cleared': ['room'],
        'evidence.review-due-rooms': ['room'],
        'evidence.active-study-days': ['day'],
        'evidence.missing-sections': ['section'],
        'evidence.unlinked-related-rooms': ['room'],
      },
      es: {
        'evidence.overdue-days': ['día'],
        'evidence.overdue-rooms': ['sala'],
        'evidence.subject-rooms': ['sala'],
        'evidence.rooms-cleared': ['sala'],
        'evidence.review-due-rooms': ['sala'],
        'evidence.active-study-days': ['día'],
        'evidence.missing-sections': ['sección'],
        'evidence.unlinked-related-rooms': ['sala'],
      },
    };
    const offenders: string[] = [];
    for (const [locale, leaves] of [['en', EN], ['es', ES]] as const) {
      for (const [labelKey, words] of Object.entries(units[locale])) {
        const key = evidenceKeyFor(labelKey);
        const text = resolve(leaves, key) ?? '';
        if (text.length === 0) {
          offenders.push(`${locale}: ${key} is absent`);
          continue;
        }
        // Folded, so a Spanish label that spells `sección` correctly is not reported as
        // missing its unit by an accent-sensitive comparison.
        const folded = foldForCompare(text);
        if (!words.map(foldForCompare).some((stem) => folded.includes(stem))) {
          offenders.push(`${locale}: ${key} names no unit (${text})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the two room counts stay distinguishable, so neither claims the other\'s unit', () => {
    // The defect this whole pair of keys exists to fix, asserted on the words rather than only
    // on the engine. `evidence.subject-rooms` used to publish a hardcoded `1` under the key
    // `evidence.rooms-cleared`, so an unstarted five-room subject was told it had cleared a
    // room. Splitting the keys fixed the engine; if the two *labels* ever collapse back to the
    // same wording, the split stops being visible to a learner again, and no engine test can
    // see that because both keys would still be resolving correctly.
    const offenders: string[] = [];
    for (const leaves of [EN, ES]) {
      const subjectRooms = resolve(leaves, 'assistance.evidence.subject-rooms');
      const roomsCleared = resolve(leaves, 'assistance.evidence.rooms-cleared');
      if (subjectRooms === null || roomsCleared === null) continue;
      if (foldForCompare(subjectRooms) === foldForCompare(roomsCleared)) {
        offenders.push(`identical labels: "${subjectRooms}"`);
      }
      // And the direction of the distinction: the subject count describes what *exists*, the
      // cleared count describes what was *finished*. A subject-count label that contains a
      // completion word has drifted into claiming clearance.
      const completion = ['clear', 'complet', 'finish', 'done', 'super', 'termin', 'pasad'];
      if (completion.map(foldForCompare).some((word) => foldForCompare(subjectRooms).includes(word))) {
        offenders.push(`subject-rooms claims completion: "${subjectRooms}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no count label praises the learner for the thing it counts', () => {
    // The `subject-rooms` case specifically. A subject with nothing cleared still publishes its
    // room count, so a label like "Rooms you finished" would tell an unstarted learner they had
    // finished something, and "Rooms cleared" on that same key would have done it too - which is
    // why `evidence.subject-rooms` and `evidence.rooms-cleared` are now separate keys and the
    // split has to be protected in the words as well as in the engine.
    expect(bannedHits(EN, PRAISE_EN)).toEqual([]);
    expect(bannedHits(ES, PRAISE_ES)).toEqual([]);
  });

  it('no title or detail claims a suggestion was applied, accepted, or recorded', () => {
    // Advisory only is a structural property the engine enforces by having no write path and
    // no callable in a suggestion. The wording half of the same claim is checked here: a card
    // that says a suggestion "has been applied" is asserting a write the module cannot
    // perform.
    //
    // Scoped to `title` and `detail`, deliberately excluding `evidence`. An evidence row is a
    // count of something the learner did - "notes saved again with a check still open",
    // "days with activity recorded" - and those words describe work that really happened. The
    // claim at risk is a suggestion being *asserted as done*, and an evidence label is the one
    // place a card states a past fact rather than an offer, so including it here flagged two
    // honest strings and taught the gate nothing.
    const applied = /\b(applied|accepted|recorded|completed|automatically|auto-)\b/i;
    const appliedEs = /\b(aplicad[oa]s?|aceptad[oa]s?|registrad[oa]s?|completad[oa]s?|automátic[oa]s?)\b/i;
    const offenders: string[] = [];
    for (const [label, leaves, pattern] of [
      ['en', EN, applied],
      ['es', ES, appliedEs],
    ] as const) {
      for (const key of assistanceKeys(leaves)) {
        if (key.startsWith('assistance.evidence.')) continue;
        if (pattern.test(leaves.get(key) ?? '')) offenders.push(`${label}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no string makes dismissal sound like it costs something', () => {
    // The non-punitive half of plan section 8. There is no dismissal copy in this catalogue -
    // the engine emits no such key - so the risk is a *neighbouring* word: a detail that warns
    // a learner off dismissing, or that names a consequence for ignoring the card.
    const punitive = /\b(warn|lose|lost|forfeit|consequence|penalt|ignored|ignore)\b/i;
    const punitiveEs = /\b(perder|perdés|pierdes|aviso|consecuencia|penaliza|ignorad[oa]s?)\b/i;
    const offenders: string[] = [];
    for (const [label, leaves, pattern] of [
      ['en', EN, punitive],
      ['es', ES, punitiveEs],
    ] as const) {
      for (const key of assistanceKeys(leaves)) {
        if (pattern.test(leaves.get(key) ?? '')) offenders.push(`${label}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
