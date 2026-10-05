/**
 * Every string the assistance **chrome** renders, in both supported locales.
 *
 * ## Why this is a module and not `t()` calls
 *
 * The engine emits i18n keys for everything it *derives* - a suggestion's title, its detail,
 * an evidence row's label - and those resolve through
 * {@link import('./assistanceMessages').assistanceMessage} against the nested locale
 * catalogues. Those keys are the domain's, and the catalogue section for them belongs to the
 * content owner.
 *
 * The strings in *this* file are the opposite: the surrounding furniture a card needs and the
 * engine never produces - the region's heading, the Dismiss control's verb, the words that say
 * a suggestion was set aside, the sentence that says the evidence is why this appeared, the
 * five action offers' descriptions, and the settings surface. The engine has no opinion about
 * any of them, and putting them in the shared catalogue would mean adding a copy decision to
 * every future assistance surface.
 *
 * This is the arrangement `src/ui/study/stats/studyStatsCopy.ts` already uses for the
 * statistics dashboard, for the same reason: "no colour-only state" and "the empty state is an
 * explanation" are properties of a dashboard's *words*, and a word table is where they can be
 * read, diffed, and pinned by name.
 *
 * ## Both locales, or it is a defect
 *
 * Every entry here has an `en` and an `es` string, and the type is a two-key record rather
 * than a partial one, so a missing translation is a **typecheck error** rather than an English
 * string leaking into the Spanish build. That is the cheap half. The expensive half - the
 * engine's own keys resolving in both catalogues - is gated by
 * `tests/phase19/assistanceUiMessages.test.ts`, which walks the engine's exported code sets and
 * resolves every derived key against both locale files.
 *
 * ## Nothing here is a learner value
 *
 * No room id, no topic, no note text, no history. `action.detail` is app-owned vocabulary (a
 * required section's name) or an app-minted room id, and the view model resolves the id to the
 * room's visible topic before anything reaches this table's callers.
 */
import type { AssistanceActionKind, AssistanceIntensity, AssistanceMode } from '@/core/assistance/types';
import type { SupportedLocale } from '@/i18n';

/** A string that exists in every supported locale. */
type Localized = Readonly<Record<SupportedLocale, string>>;

export const ASSISTANCE_CHROME = Object.freeze({
  /** The region's heading. */
  cardHeading: {
    en: 'Suggestions',
    es: 'Sugerencias',
  },
  /** The heading over the evidence rows. */
  whyHeading: {
    en: 'Why this appears',
    es: 'Por qué aparece',
  },
  /** The heading over the advisory offer. */
  offerHeading: {
    en: 'What you can do',
    es: 'Lo que puedes hacer',
  },
  /** The Dismiss control's verb. */
  dismiss: {
    en: 'Dismiss',
    es: 'Descartar',
  },
  /**
   * The sentence a dismissed suggestion is replaced with.
   *
   * It states the two properties that make dismissal safe - nothing was set aside for good,
   * and nothing about the learner's work changed - because a Dismiss control with no
   * consequence the learner can see is indistinguishable from a broken button.
   */
  dismissed: {
    en: 'Set aside for now. Nothing was changed and it can come back.',
    es: 'Descartada por ahora. No se cambió nada y puede volver a aparecer.',
  },
  /** The prefix on an evidence row: "3 Required sections missing". */
  evidenceCount: {
    en: '%d',
    es: '%d',
  },
  /** The suffix naming how many times, for a count of one. */
  once: {
    en: 'once',
    es: 'una vez',
  },
  /** The suffix naming a count of more than one. */
  times: {
    en: '%d times',
    es: '%d veces',
  },
  /** Shown when a suggestion names no room at all. */
  wholeSubject: {
    en: 'this subject',
    es: 'esta materia',
  },
  /** The line that says the offer is the learner's to take. */
  advisoryNote: {
    en: 'Nothing here is applied for you. Use your own controls if you want to act on it.',
    es: 'Nada de esto se aplica por ti. Usa tus propios controles si quieres actuar.',
  },
} satisfies Readonly<Record<string, Localized>>);

/**
 * The three intensities the engine can choose, in words.
 *
 * `satisfies Readonly<Record<AssistanceIntensity, Localized>>` and not
 * `Record<string, Localized>`: the engine's intensity union is the key set, so an intensity
 * added to `src/core/assistance/types.ts` fails **this file's** typecheck until a learner-facing
 * word exists for it. A table of three strings that a fourth would quietly miss is the defect
 * this prevents.
 */
export const ASSISTANCE_INTENSITY_COPY = Object.freeze({
  /** The gentlest: a short step. */
  step: { en: 'A short step', es: 'Un paso breve' },
  /** A cue after hesitation or a low rating. */
  cue: { en: 'A cue', es: 'Una pista' },
  /** The strongest presentation the engine offers. */
  example: { en: 'With an example', es: 'Con un ejemplo' },
} satisfies Readonly<Record<AssistanceIntensity, Localized>>);

/**
 * What each advisory action offers, in the learner's words.
 *
 * Every entry is phrased as something **on offer**, never as something done or to be done by
 * the application. "You can add a starter section for X" rather than "Adding a starter
 * section", because the second reads as a status report about a write that has not happened -
 * and, in a card whose whole claim is that it does not write, that reading would be a lie.
 */
export const ASSISTANCE_ACTION_COPY = Object.freeze({
  'offer-section-scaffold': {
    en: 'You could start this note with a section called “%s”.',
    es: 'Podrías empezar esta nota con una sección llamada «%s».',
  },
  'offer-cross-link': {
    en: 'You could link this to “%s”.',
    es: 'Podrías enlazar esto con «%s».',
  },
  'offer-navigation': {
    en: 'You could go to “%s” from here.',
    es: 'Podrías ir a «%s» desde aquí.',
  },
  'offer-prioritisation': {
    en: 'You could move “%s” to the front of the review queue.',
    es: 'Podrías poner «%s» al principio de la cola de repaso.',
  },
  'offer-hint': {
    en: 'You could ask for a hint on this part.',
    es: 'Podrías pedir una pista sobre esta parte.',
  },
} satisfies Readonly<Record<AssistanceActionKind, Localized>>);

/** Every string the settings surface renders. */
export const ASSISTANCE_SETTINGS_COPY = Object.freeze({
  regionHeading: { en: 'Assistance', es: 'Asistencia' },
  purpose: {
    en: 'Suggestions are worked out on this device from your own notes, rooms, and review history. Nothing is sent anywhere, and nothing is decided for you.',
    es: 'Las sugerencias se calculan en este dispositivo a partir de tus notas, tus salas y tu historial de repaso. No se envía nada a ningún sitio y no se decide nada por ti.',
  },
  modeHeading: { en: 'How much to show', es: 'Cuánto mostrar' },
  off: {
    en: 'Off',
    es: 'Apagada',
  },
  offNote: {
    en: 'Nothing is suggested anywhere.',
    es: 'No se sugiere nada en ninguna parte.',
  },
  gentle: {
    en: 'Gentle',
    es: 'Suave',
  },
  gentleNote: {
    en: 'Short steps and a little more time.',
    es: 'Pasos breves y algo más de tiempo.',
  },
  standard: {
    en: 'Standard',
    es: 'Estándar',
  },
  standardNote: {
    en: 'Hints after hesitation, repeated attempts, or a low recall rating.',
    es: 'Pistas tras dudar, reintentar varias veces o obtener una recuperación baja.',
  },
  dismissalHeading: { en: 'Dismissals', es: 'Descartes' },
  dismissalNone: {
    en: 'You have not dismissed any suggestions.',
    es: 'No has descartado ninguna sugerencia.',
  },
  dismissalSome: {
    en: 'You have dismissed %d suggestion(s). They were not removed for good, and dismissing one changes nothing else.',
    es: 'Has descartado %d sugerencia(s). No se eliminaron para siempre y descartar una no cambia nada más.',
  },
  clearDismissals: {
    en: 'Forget this count',
    es: 'Olvidar esta cuenta',
  },
  clearDismissalsDone: {
    en: 'Count forgotten.',
    es: 'Cuenta olvidada.',
  },
  /** The status line a screen reader announces after a mode change. */
  modeChanged: {
    en: 'Assistance set to %s.',
    es: 'Asistencia establecida en %s.',
  },
} satisfies Readonly<Record<string, Localized>>);

/**
 * The mode names the settings surface and the status line use.
 *
 * Keyed by the engine's own `AssistanceMode` union for the reason the intensity table names:
 * a fourth mode has no sentence here until someone writes one, which is the correct moment to
 * find out.
 */
export const ASSISTANCE_MODE_COPY = Object.freeze({
  off: { en: 'Off', es: 'Apagada' },
  gentle: { en: 'Gentle', es: 'Suave' },
  standard: { en: 'Standard', es: 'Estándar' },
} satisfies Readonly<Record<AssistanceMode, Localized>>);

/**
 * Substitute `%s` and `%d` placeholders.
 *
 * A hand-rolled substitution rather than `String.prototype.replace` with a replacer *function*,
 * because the replacer form would put a closure in the copy table's call path and this table is
 * imported by a module that must stay free of behaviour. Counted occurrences, so a template
 * with two placeholders and one argument fails loudly in development instead of rendering
 * `'%d'` to a learner.
 */
export function formatAssistanceTemplate(
  template: string,
  values: readonly (string | number)[],
): string {
  let index = 0;
  return template.replace(/%[sd]/g, (match) => {
    const value = values[index];
    index += 1;
    return value === undefined ? match : String(value);
  });
}