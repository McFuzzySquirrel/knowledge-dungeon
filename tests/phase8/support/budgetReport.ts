/**
 * The one location-dependent value in the Welcome budget report, and how to remove it.
 *
 * ## The defect this exists to prevent
 *
 * `scripts/check-welcome-budget.mjs` prints where it measured from:
 *
 *     Measured from: <path relative to the repository root>
 *
 * The value is *relative to the repository root*, so its shape depends on where the
 * checkout lives and on nothing else. A synthetic `dist` in the OS temp directory prints
 * `/tmp/kd-welcome-budget-XXXXXX/dist/index.html` from a checkout that sits directly
 * under the temp directory, and `../../kd-welcome-budget-XXXXXX/dist/index.html` from
 * every other checkout - including CI's, and including any `git worktree` outside `/tmp`.
 *
 * The determinism assertion in `welcome-budget-measure.test.ts` used to remove the value
 * with a regex written for the first of those two shapes. In every other checkout the
 * regex did not match, the per-run temporary suffix survived, and two runs of identical
 * bytes compared unequal. The test therefore only ever passed in a tree under `/tmp`, and
 * had never been verified in the shape CI actually runs it. That is a non-hermetic gate:
 * a measurement that depends on the directory the runner happened to be in.
 *
 * ## Why the fix replaces the value instead of matching it
 *
 * The line is `Measured from: <value>`, and the label is fixed by the script. So the
 * robust move is to key on the label and replace everything after it, which is
 * location-independent by construction: there is no path shape left to get wrong, and no
 * second form to remember. A regex for "the temporary directory" is a claim about where
 * the checkout is; a regex for "the value of this labelled field" is a claim about the
 * report.
 *
 * Narrowness is asserted rather than assumed, in `qa-hermeticity.test.ts`: the label
 * survives, the counted total survives, and every measured row survives. A strip that
 * removed more than the one value would make the determinism assertion vacuous, which is
 * the failure mode a too-greedy replacement invites.
 *
 * Privacy: pure string handling. No filesystem, no process, no network, and nothing here
 * reads or names learner data.
 */

/** The label the script prints, and the anchor for the replacement. */
export const MEASURED_FROM_LABEL = 'Measured from:';

/**
 * The value of the `Measured from` line, or `undefined` when the report has no such line.
 *
 * Kept separate from {@link stripMeasuredFrom} so a caller can *assert* that the two runs
 * really did differ in that value - the control that proves a strip is not simply
 * swallowing a difference.
 */
export function measuredFrom(output: string): string | undefined {
  const match = new RegExp(`^[ \\t]*${MEASURED_FROM_LABEL}[ \\t]*(\\S.*)$`, 'm').exec(output);
  return match?.[1];
}

/**
 * Replaces the `Measured from` value with a placeholder, leaving every other byte alone.
 *
 * The pattern is anchored per line, so it replaces the value of that one labelled field
 * and nothing else: no path, no prefix, and no other line in the report.
 */
export function stripMeasuredFrom(output: string): string {
  return output.replace(
    new RegExp(`^([ \\t]*${MEASURED_FROM_LABEL})[ \\t]*\\S.*$`, 'gm'),
    '$1 <dist>',
  );
}
