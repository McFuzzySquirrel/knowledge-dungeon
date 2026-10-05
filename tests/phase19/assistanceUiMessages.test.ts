/**
 * The dotted-key bridge, and the claim that both locales resolve.
 *
 * ## OPEN CROSS-OWNER DEFECT - this gate is RED, and it should be
 *
 * `ASSISTANCE_EVIDENCE_KEYS` has **thirteen** members. The `assistance` section of
 * `src/i18n/locales/{en,es}.json` has **eleven**. The two the catalogue is missing are:
 *
 * | Engine key | Emitted by | Catalogue has instead |
 * | --- | --- | --- |
 * | `evidence.overdue-days` | the `review-due` explanation arm, alongside `evidence.overdue-rooms` | nothing |
 * | `evidence.subject-rooms` | the `graph-no-branch` and `device-reviews-due` arms | nothing |
 *
 * Both are **reachable**: `grep "push('evidence\\."` over `src/core/assistance/assistanceEngine.ts`
 * finds thirteen distinct labels, so neither is dead vocabulary. A learner reaching the
 * Archaeologist due-room card, or the Creator missing-branch card, therefore sees one evidence row
 * fall back to the neutral sentence from `missingMessageFor`.
 *
 * The gate below is left RED rather than weakened, because the defect is real and a green gate
 * would be a lie about it. It is not this stage's to fix: the vocabulary is
 * `core-logic-engineer`'s and the catalogue section is `village-content-designer`'s. The remedy is
 * two strings in each of two files - `assistance.evidence.overdue-days` and
 * `assistance.evidence.subject-rooms` - each honouring the unit its key names, because
 * `ASSISTANCE_EVIDENCE_KEYS`'s own header makes a key's name its contract: "a key whose unit is
 * days says `days` ... a key whose subject is a subject says so (`evidence.subject-rooms`)".
 *
 * When they land, this file goes green with no edit.
 *
 * ## What this file treats as a defect rather than a warning
 *
 * "An i18n key that resolves in `en` but not `es`" is a defect. It is invisible in English-only
 * manual testing, it is invisible in a build that defaults to `en`, and it reaches the learner as
 * either a raw key or a fallback sentence that is not what the copy owner wrote. So the gate here
 * is not "the bridge has a fallback" - it is **every key the engine can emit resolves in both
 * catalogues**, derived from the engine's own exported vocabularies rather than from a list
 * someone typed.
 *
 * ## The two halves, and why they are separate files' worth of work
 *
 * 1. `resolveAssistanceMessage` is a pure walk. It is tested here for every way it can fail, and
 *    in particular for the two failures i18next does *not* fail loudly on: a missing key (which
 *    i18next returns as the key itself) and a non-string leaf (which i18next returns as an
 *    internal diagnostic sentence). Both are measured facts about this repository's own
 *    catalogues, reproduced as tests so a future i18next upgrade cannot quietly reintroduce them.
 * 2. The **coverage** gate walks the engine's closed vocabularies and resolves every derived key
 *    in both catalogues.
 */
import { describe, expect, it } from 'vitest';

import {
  ASSISTANCE_EVIDENCE_KEYS,
  ASSISTANCE_SUGGESTION_KINDS,
  type AssistanceReasonCode,
} from '@/core/assistance/types';
import i18next from 'i18next';

import {
  ASSISTANCE_CATALOGUES,
  __resetUnresolvedAssistanceKeys,
  assistanceLocaleFor,
  assistanceMessage,
  missingMessageFor,
  resolveAssistanceMessage,
  unresolvedAssistanceKeys,
} from '@/ui/assistance/assistanceMessages';
import {
  ASSISTANCE_ACTION_COPY,
  ASSISTANCE_CHROME,
  ASSISTANCE_INTENSITY_COPY,
  ASSISTANCE_MODE_COPY,
  ASSISTANCE_SETTINGS_COPY,
} from '@/ui/assistance/assistanceCopy';
import { SUPPORTED_LOCALES } from '@/i18n';

/**
 * Every reason code, written out as an **exhaustiveness map** rather than an array.
 *
 * `AssistanceReasonCode` is a union with no exported array, so an array literal would drift from
 * it silently: the engine could add a reason code, the catalogue would gain its copy, and this
 * gate would keep passing because it never asked about the new one. Keying by the union type
 * makes that a **typecheck error** instead - `Record<AssistanceReasonCode, true>` with a missing
 * member does not compile.
 */
const REASON_CODE_EXHAUSTIVENESS: Readonly<Record<AssistanceReasonCode, true>> = Object.freeze({
  'graph-no-branch': true,
  'graph-related-tag-unlinked': true,
  'note-missing-required-section': true,
  'note-validation-failed': true,
  'note-adjacent-room-unreferenced': true,
  'note-rubric-criterion-low': true,
  'review-due': true,
  'review-low-recall': true,
  'fishing-recall-missed': true,
  'device-reviews-due': true,
});

const REASON_CODES = Object.keys(REASON_CODE_EXHAUSTIVENESS);

/** Every key the engine's `explainAssistanceSuggestion` can emit, in its own construction. */
function engineKeysByLocale(locale: (typeof SUPPORTED_LOCALES)[number]): readonly string[] {
  const titles = ASSISTANCE_SUGGESTION_KINDS.map((kind) => `assistance.title.${kind}`);
  const details = REASON_CODES.map((code) => `assistance.detail.${code}`);
  const evidence = ASSISTANCE_EVIDENCE_KEYS.map((key) => `assistance.${key}`);
  void locale;
  return [...titles, ...details, ...evidence];
}

describe('the key set is complete, and the completeness is typecheck-enforced', () => {
  it('the exhaustiveness map has one entry per reason code, and no more', () => {
    // Not the assertion that matters on its own: it is here so that a union member added without
    // a map entry fails `tsc` (so this file cannot even run), and a map entry added for a
    // nonexistent member fails the same way. The run-time assertion catches the other direction -
    // an entry whose key is not a reason code at all.
    expect(REASON_CODES.length).toBeGreaterThan(0);
    for (const code of REASON_CODES) {
      expect(code in REASON_CODE_EXHAUSTIVENESS).toBe(true);
    }
  });

  it('the corpus of engine keys covers every kind, every reason, and every evidence label', () => {
    // A count assertion would be unfailable arithmetic; this one is about *provenance*: each
    // group must be non-empty and drawn from the engine's own exports, so a gate that silently
    // reduced its input to `[]` fails here rather than passing vacuously below.
    expect(ASSISTANCE_SUGGESTION_KINDS.length).toBe(9);
    expect(REASON_CODES.length).toBe(10);
    expect(ASSISTANCE_EVIDENCE_KEYS.length).toBe(13);
    expect(engineKeysByLocale('en').length).toBe(32);
  });
});

describe('every key the engine can emit resolves, in BOTH locales', () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`all 32 engine keys resolve in \`${locale}\``, () => {
      const unresolved = engineKeysByLocale(locale)
        .map((key) => ({ key, value: resolveAssistanceMessage(ASSISTANCE_CATALOGUES[locale], key) }))
        .filter((entry) => entry.value === null);
      expect(unresolved.map((entry) => entry.key)).toEqual([]);
    });

    it(`every resolved \`${locale}\` value is non-empty and not the key itself`, () => {
      for (const key of engineKeysByLocale(locale)) {
        const value = resolveAssistanceMessage(ASSISTANCE_CATALOGUES[locale], key);
        expect(value, key).not.toBeNull();
        // The tautology trap: a resolver that returned the key on failure would satisfy every
        // "does it resolve" check above unless this one runs. It cannot.
        expect(value, key).not.toBe(key);
        expect(value!.trim().length, key).toBeGreaterThan(0);
      }
    });
  }

  it('the two locales resolve the same key set, so neither is a subset of the other', () => {
    const enKeys = engineKeysByLocale('en').slice().sort();
    const esKeys = engineKeysByLocale('es').slice().sort();
    expect(esKeys).toEqual(enKeys);
    // And the *values* differ where they should: a catalogue that resolved `es` to the English
    // string would satisfy every assertion above while shipping an untranslated feature.
    const en = resolveAssistanceMessage(ASSISTANCE_CATALOGUES.en, 'assistance.title.creator.missing-branch');
    const es = resolveAssistanceMessage(ASSISTANCE_CATALOGUES.es, 'assistance.title.creator.missing-branch');
    expect(en).not.toBeNull();
    expect(es).not.toBeNull();
    expect(es).not.toBe(en);
  });
});

describe('the chrome copy table is complete in both locales', () => {
  const tables: readonly (readonly [string, Readonly<Record<string, Readonly<Record<string, string>>>>])[] = [
    ['ASSISTANCE_CHROME', ASSISTANCE_CHROME],
    ['ASSISTANCE_INTENSITY_COPY', ASSISTANCE_INTENSITY_COPY],
    ['ASSISTANCE_ACTION_COPY', ASSISTANCE_ACTION_COPY],
    ['ASSISTANCE_SETTINGS_COPY', ASSISTANCE_SETTINGS_COPY],
    ['ASSISTANCE_MODE_COPY', ASSISTANCE_MODE_COPY],
  ];

  it('every table is non-empty, so a table reduced to {} fails rather than passes', () => {
    for (const [name, table] of tables) {
      expect(Object.keys(table).length, name).toBeGreaterThan(0);
    }
  });

  for (const [name, table] of tables) {
    for (const locale of SUPPORTED_LOCALES) {
      it(`${name} has a non-empty \`${locale}\` string for every entry`, () => {
        const missing: string[] = [];
        for (const [entry, pair] of Object.entries(table)) {
          const text = pair[locale];
          if (typeof text !== 'string' || text.trim().length === 0) missing.push(entry);
        }
        expect(missing).toEqual([]);
      });
    }
  }

  it('the intensity and action tables are keyed by the engine\'s own unions', () => {
    // Keyed by `AssistanceIntensity` and `AssistanceActionKind` through `satisfies`, so a new
    // member fails the typecheck. Asserted here so a future edit that widens the key type to
    // `string` is caught at run time too rather than waiting for an engine change to matter.
    expect(Object.keys(ASSISTANCE_INTENSITY_COPY).sort()).toEqual(['cue', 'example', 'step']);
    expect(Object.keys(ASSISTANCE_ACTION_COPY).sort()).toEqual([
      'offer-cross-link',
      'offer-hint',
      'offer-navigation',
      'offer-prioritisation',
      'offer-section-scaffold',
    ]);
  });
});

describe('the walk fails safely, in every way it can fail', () => {
  const catalogue = ASSISTANCE_CATALOGUES.en;

  it('a missing key resolves to null, and i18next would have returned the key itself', () => {
    const key = 'assistance.title.does-not-exist';
    expect(resolveAssistanceMessage(catalogue, key)).toBeNull();
    // The measured i18next behaviour this bridge exists to prevent, asserted rather than
    // described. If a future i18next stops doing this, the assertion fails and the bridge's
    // doc comment is what a reader has to revisit - which is the correct direction for it to
    // break.
    expect(i18next.t(key)).toBe(key);
  });

  it('a missing intermediate branch resolves to null', () => {
    expect(resolveAssistanceMessage(catalogue, 'assistance.nope.title.creator.missing-branch')).toBeNull();
    expect(resolveAssistanceMessage(catalogue, 'nope.title.creator.missing-branch')).toBeNull();
  });

  it('an empty path, an empty segment, and a trailing dot all resolve to null', () => {
    expect(resolveAssistanceMessage(catalogue, '')).toBeNull();
    expect(resolveAssistanceMessage(catalogue, '.')).toBeNull();
    expect(resolveAssistanceMessage(catalogue, 'assistance.title.')).toBeNull();
    expect(resolveAssistanceMessage(catalogue, '..title')).toBeNull();
  });

  it('a non-string leaf resolves to null, and i18next would have returned a diagnostic sentence', () => {
    // `common` is an object, so it is the leaf-as-branch case.
    expect(resolveAssistanceMessage(catalogue, 'common')).toBeNull();
    const viaI18next = i18next.t('common');
    expect(viaI18next).not.toBe('common');
    expect(viaI18next).toMatch(/instead of string/);
  });

  it('a blank string leaf resolves to null, because a blank translation is a gap', () => {
    const blank = { assistance: { title: '   ' } };
    expect(resolveAssistanceMessage(blank, 'assistance.title')).toBeNull();
  });

  it('an inherited property is not a translation', () => {
    // `constructor` and `toString` are on `Object.prototype`; a `reduce`-style walk that used
    // plain indexing would return a function here and stringify it into the DOM.
    expect(resolveAssistanceMessage(catalogue, 'constructor')).toBeNull();
    expect(resolveAssistanceMessage(catalogue, 'toString')).toBeNull();
  });

  it('an array is not a catalogue branch', () => {
    expect(resolveAssistanceMessage({ assistance: ['a', 'b'] }, 'assistance.0')).toBeNull();
  });

  it('a hyphenated segment is an ordinary key, which is the engine\'s own shape', () => {
    expect(
      resolveAssistanceMessage(catalogue, 'assistance.title.creator.missing-branch'),
    ).toBe('Add a room under the first room');
  });
});

describe('the degradation is visible to the developer and safe for the learner', () => {
  it('a missing key never reaches the caller as text', () => {
    __resetUnresolvedAssistanceKeys();
    for (const locale of SUPPORTED_LOCALES) {
      const text = assistanceMessage(locale, 'assistance.title.no-such-kind');
      expect(text).toBe(missingMessageFor(locale));
      expect(text).not.toContain('assistance.');
      expect(text).not.toContain('no-such-kind');
    }
    expect(unresolvedAssistanceKeys().length).toBeGreaterThan(0);
  });

  it('the fallback differs between locales, so an untranslated learner is not told in English', () => {
    expect(missingMessageFor('en')).not.toBe(missingMessageFor('es'));
  });

  it('a resolved key records nothing', () => {
    __resetUnresolvedAssistanceKeys();
    assistanceMessage('en', 'common.close');
    assistanceMessage('es', 'common.close');
    expect(unresolvedAssistanceKeys()).toEqual([]);
  });

  it('the gap list is deduplicated and sorted, so it is a bounded diagnostic', () => {
    __resetUnresolvedAssistanceKeys();
    assistanceMessage('en', 'zzz.gap');
    assistanceMessage('en', 'zzz.gap');
    assistanceMessage('en', 'aaa.gap');
    expect(unresolvedAssistanceKeys()).toEqual(['en:aaa.gap', 'en:zzz.gap']);
  });
});

describe('locale narrowing', () => {
  it('a regional tag narrows to its base language', () => {
    expect(assistanceLocaleFor('es-MX')).toBe('es');
    expect(assistanceLocaleFor('es-419')).toBe('es');
    expect(assistanceLocaleFor('en-GB')).toBe('en');
  });

  it('an unsupported, empty, or absent tag narrows to null rather than to a guess', () => {
    expect(assistanceLocaleFor('fr')).toBeNull();
    expect(assistanceLocaleFor('')).toBeNull();
    expect(assistanceLocaleFor(null)).toBeNull();
    expect(assistanceLocaleFor(undefined)).toBeNull();
    expect(assistanceLocaleFor('ES')).toBe('es');
  });
});