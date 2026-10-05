/**
 * The bridge from the assistance engine's dotted keys to the nested locale catalogues.
 *
 * ## What the engine emits, and why it is a problem
 *
 * `explainAssistanceSuggestion` returns
 * `assistance.title.${suggestion.kind}` and `assistance.detail.${suggestion.reasonCode}`, and a
 * suggestion kind is itself dotted (`creator.missing-branch`). So the string the engine
 * hands the UI is `assistance.title.creator.missing-branch` - a **path** through a nested
 * catalogue, whose segments contain both dots and hyphens - and not a flat key.
 *
 * The locale files are nested objects (`common.close`, `village.title`, and now
 * `assistance.title.creator.missing-branch`), which is the right shape for a catalogue and
 * the wrong shape for a flat `Record<string, string>`.
 *
 * ## Why this module exists rather than calling `t()` directly
 *
 * `src/i18n/index.ts` initialises i18next with its defaults, which include `keySeparator: '.'`,
 * so `t('assistance.title.creator.missing-branch')` *does* resolve the nested path today. Two
 * measured facts make it the wrong call anyway:
 *
 * 1. **A missing key returns the key itself.** Verified against this repository's
 *    catalogues: with `assistance` absent, `t('assistance.title.creator.missing-branch')`
 *    returns the literal string `"assistance.title.creator.missing-branch"`. A learner would
 *    be shown `assistance.title.scribe.rubric-hint` and be expected to work out what it meant.
 * 2. **A non-string leaf returns an i18next error sentence**, not the key:
 *    `t('common')` returns `"key 'common (es)' returned an object instead of string."` - an
 *    internal diagnostic, in the learner's locale, on screen.
 *
 * Neither failure throws, so neither is caught by an error boundary; both are silent. This
 * module therefore resolves the path itself, walks to a **string leaf**, and returns `null`
 * for anything that is not one. A caller cannot render a key it did not receive.
 *
 * ## Why the walk is not `path.split('.').reduce(...)`
 *
 * A `reduce` over `unknown` either needs a cast - which is exactly the cast that turns a
 * missing key into a runtime `undefined` reaching the DOM - or a long chain of narrowing
 * that reads like noise. {@link resolveAssistanceMessage} narrows at every step and returns
 * `null` the moment the walk cannot continue, so the "no raw key" property is a type-level
 * consequence rather than a promise in a comment.
 *
 * ## Why the fallback is a sentence and not the key
 *
 * {@link resolveAssistanceMessage} returning `null` leaves the caller with nothing to render.
 * A missing explanation must degrade **visibly and safely**: the card still renders, it
 * renders the neutral sentence from {@link missingMessageFor}, and the unresolved key is
 * recorded by {@link recordUnresolvedKey} so the gap is observable rather than invisible.
 * A learner never sees an app-owned identifier.
 *
 * Renderer-neutral and framework-free: no React, no store, no engine. Locale JSON is data.
 */
import enCatalogue from '@/i18n/locales/en.json';
import esCatalogue from '@/i18n/locales/es.json';

import { SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n';

/** A locale catalogue: the parsed JSON, whose leaves are strings and whose branches are objects. */
export type AssistanceCatalogue = Readonly<Record<string, unknown>>;

/** The catalogue for each supported locale. */
export const ASSISTANCE_CATALOGUES: Readonly<Record<SupportedLocale, AssistanceCatalogue>> =
  Object.freeze({
    en: enCatalogue as AssistanceCatalogue,
    es: esCatalogue as AssistanceCatalogue,
  });

/**
 * Narrow a language tag to a supported locale, or `null`.
 *
 * Mirrors what i18next does with `es-MX` and `es-419`: the region is dropped and the base
 * language decides. Written out rather than delegated to `i18n.language` directly because the
 * two cards are rendered on different frames and the *renderer* must not depend on when
 * i18next finished detecting a language.
 */
export function assistanceLocaleFor(language: string | null | undefined): SupportedLocale | null {
  if (typeof language !== 'string') return null;
  const base = language.split('-')[0]?.trim().toLowerCase() ?? '';
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === base) return locale;
  }
  return null;
}

/**
 * Walk a dotted path to a string leaf, or `null`.
 *
 * `null` for every way the walk can fail: an empty path, a missing intermediate branch, an
 * intermediate value that is not an object, an empty segment, and a leaf that is absent, not
 * a string, or blank. Every one of those is a **catalogue gap**, and none of them can produce
 * a value this function's return type admits other than a real string.
 *
 * The hyphenated segments the engine emits (`missing-branch`, `note-validation-failed`) are
 * ordinary object keys and need no special handling; splitting only on `.` is what keeps them
 * whole.
 */
export function resolveAssistanceMessage(
  catalogue: AssistanceCatalogue,
  dottedPath: string,
): string | null {
  if (typeof dottedPath !== 'string' || dottedPath.length === 0) return null;
  let node: unknown = catalogue;
  for (const segment of dottedPath.split('.')) {
    if (segment.length === 0) return null;
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return null;
    // Own properties only: an inherited `toString` is not a translation.
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'string') return null;
  const trimmed = node.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The neutral sentence a card renders when a key does not resolve.
 *
 * Deliberately says nothing about *which* key was missing: the missing key is app-owned
 * vocabulary and reporting it to a learner would be reporting our bug in their language.
 * {@link recordUnresolvedKey} is where that report belongs.
 */
const MISSING_MESSAGE: Readonly<Record<SupportedLocale, string>> = Object.freeze({
  en: 'This suggestion is shown without a description.',
  es: 'Esta sugerencia se muestra sin una descripción.',
});

/** The safe text for a key that did not resolve, in the given locale. */
export function missingMessageFor(locale: SupportedLocale): string {
  return MISSING_MESSAGE[locale];
}

/**
 * Keys that were asked for and did not resolve, deduplicated and sorted.
 *
 * Module state on purpose: this is a diagnostics surface, not a render input, so it must not
 * be the reason a component re-renders. A test asserts it is **empty** for a complete
 * catalogue, which is what turns "both languages resolve" from a claim into a gate.
 */
const unresolved = new Set<string>();

/**
 * Note that a key did not resolve, and warn once per key.
 *
 * One line, one key, and the key is app-owned vocabulary (`assistance.title.scribe.rubric-hint`)
 * rather than anything a learner wrote - the same rule `src/renderers/pixi/assets/AssetLoader.ts`
 * states for its own one-line-per-signature log. A dedupe set is not an unbounded log.
 */
export function recordUnresolvedKey(dottedPath: string): void {
  if (unresolved.has(dottedPath)) return;
  unresolved.add(dottedPath);
  // A catalogue gap is a shipped-surface defect, and one line per key is the budget; see the
  // `AssetLoader` precedent named above.
  console.warn(`[assistance] no message for "${dottedPath}"`);
}

/**
 * Resolve a key, recording the gap and falling back when it does not resolve.
 *
 * The single call a card makes. It **cannot** return the key: on the happy path it returns
 * the catalogue's string, and on every other path it returns {@link missingMessageFor}.
 */
export function assistanceMessage(
  locale: SupportedLocale,
  dottedPath: string,
): string {
  const resolved = resolveAssistanceMessage(ASSISTANCE_CATALOGUES[locale], dottedPath);
  if (resolved !== null) return resolved;
  recordUnresolvedKey(`${locale}:${dottedPath}`);
  return missingMessageFor(locale);
}

/** The unresolved keys recorded so far, sorted. Test and diagnostics support. */
export function unresolvedAssistanceKeys(): readonly string[] {
  return [...unresolved].sort();
}

/** Forget the recorded gaps. Test teardown only. */
export function __resetUnresolvedAssistanceKeys(): void {
  unresolved.clear();
}