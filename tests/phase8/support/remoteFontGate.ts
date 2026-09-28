/**
 * The remote-font gate predicate for `tests/e2e/currentBuild.spec.ts`.
 *
 * ## Why this file exists
 *
 * Phase 8's exit criterion is "The app renders without remote font requests", and
 * `currentBuild.spec.ts` has always *recorded* the requests it recognises as
 * known-legacy static font hosts - but it never asserted anything about the
 * count. A recorded-but-unasserted list is a log line, not a gate: the criterion
 * had no failing state, so "renders without remote font requests" was untested
 * even after Phase 8 removed the `@import` from `src/styles.css`.
 *
 * The predicate lives here rather than inline in the spec so that there is exactly
 * one implementation with two consumers: the Playwright test that applies it to a
 * real browser's real request log, and the negative control in
 * `tests/phase8/qa-verification.test.ts` that feeds it a synthetic request and
 * proves it actually fails when the condition recurs. A predicate duplicated
 * inline in the spec could be asserted one way and tested another, and the
 * negative control would then prove nothing about the shipped assertion.
 *
 * ## Why the tolerance stays
 *
 * The known-legacy font hostnames are still recognised in `inspectPrivacyNetwork`,
 * and that recognition is what makes a regression readable. Without it, a
 * reintroduced `@import` surfaces as an anonymous "external destination" failure
 * in a suite whose job is to prove there is no external traffic at all - a
 * confusing report about a network condition the reader has to reverse-engineer.
 * This predicate converts that into one number and one sentence.
 *
 * ## No framework import, on purpose
 *
 * This module is loaded by a Playwright spec and by a vitest test. Importing
 * either runner's `expect` here would bind the other one to the wrong runner, so
 * the assertion is a plain thrown `Error`: it fails a Playwright test and a vitest
 * test identically, with the same message.
 *
 * ## Privacy
 *
 * Neither the assertion nor its failure message names a hostname, a path, a query,
 * or a request body. The only things reported are the count and the set of
 * resource types, because a resource type is a browser constant (`stylesheet`,
 * `font`) and cannot carry anything a learner typed. The hostnames stay in the
 * spec's `knownLegacyFontHosts` set, which is matched but never printed.
 *
 * The gate is therefore a *closed* claim: the list it receives must be empty. A
 * request to an unrecognised external host is still an ordinary privacy violation
 * reported by `inspectPrivacyNetwork`; this gate covers the other half - the hosts
 * that were tolerated on purpose.
 */

export interface RemoteFontRequestObservation {
  /** Deliberately not read by this module. Present so callers can pass their own shape. */
  readonly url?: string;
  readonly method?: string;
  readonly resourceType: string;
}

const DEFAULT_LABEL = 'the default production artifact';

/**
 * Counts the requests that reached a recognised known-legacy static font host.
 *
 * The observations arrive already filtered by the spec's `knownLegacyFontHosts`
 * match, so this counts rather than re-matches. Keeping the host list in exactly
 * one place is what stops the two halves of the check - which hosts are tolerated,
 * and whether anything reached one - from disagreeing.
 */
export function countRemoteFontRequests(
  observations: readonly RemoteFontRequestObservation[],
): number {
  return observations.length;
}

/** The distinct resource types in the observations, sorted, for the failure message. */
export function remoteFontResourceTypeSummary(
  observations: readonly RemoteFontRequestObservation[],
): string {
  return [...new Set(observations.map((observation) => observation.resourceType || 'unknown'))]
    .sort()
    .join(', ');
}

/**
 * The failure message, built without ever reading a destination.
 *
 * Returned separately from the assertion so a test can assert on the message
 * itself - in particular that it does not leak a hostname - without having to
 * reconstruct the failure.
 */
export function remoteFontRequestsFailureMessage(
  observations: readonly RemoteFontRequestObservation[],
  label: string = DEFAULT_LABEL,
): string {
  const count = countRemoteFontRequests(observations);
  return [
    `${count} request(s) reached a recognised legacy static font host while loading ${label}.`,
    'Plan section 10.2 and the Phase 8 exit criterion require the app to render with no',
    'remote font request, so this count must be zero.',
    `Resource types involved: ${remoteFontResourceTypeSummary(observations)}.`,
    'The hostnames are deliberately omitted from this message: the privacy suite exists to',
    'prove there is no destination, so a failing run must not print one. The recognised set',
    'is knownLegacyFontHosts in tests/e2e/currentBuild.spec.ts.',
  ].join(' ');
}

/**
 * The assertion: zero recognised legacy remote font requests.
 *
 * Throws a plain `Error` naming the count, the criterion it protects, and the
 * resource types involved - and nothing else.
 */
export function assertNoRemoteFontRequests(
  observations: readonly RemoteFontRequestObservation[],
  label: string = DEFAULT_LABEL,
): void {
  if (countRemoteFontRequests(observations) !== 0) {
    throw new Error(remoteFontRequestsFailureMessage(observations, label));
  }
}
