/**
 * The one property four CI gates were each holding with their own copy of an integer.
 *
 * ## Why this file exists
 *
 * `.github/workflows/ci.yml` moves artifacts in **both** directions. `web-build` uploads
 * five of them - the release artifact, one per flagged build, and the build census - and
 * `browser-smoke` downloads five - the release artifact twice, and each flagged artifact
 * once, with a production re-download at the end for the Phase 21 absence lane.
 *
 * Six gates across three phases pinned those movements by **count**, and their histories
 * are the same history:
 *
 * - Phase 9 wrote `toBe(2)` for the downloads and a three-entry upload list.
 * - Phase 17 added the fishing artifact and rewrote three of them to `toBe(3)` / four entries.
 * - Phase 19 added the assistance artifact and they all had to be rewritten again, to `toBe(4)` / five.
 * - Phase 21 added the production re-download for the absence lane, so the download count is
 *   `toBe(5)` now.
 *
 * Every one of those amendments was legitimate. That is the point: the gates were holding
 * the right property with the wrong instrument, so a correct change to the workflow arrived
 * as six red files across four phases and two of them had to be edited in a phase that had
 * nothing to do with the artifact. The repository already records this shape twice for a
 * different family of assertions - three whole-list gates in Phase 19, two more in Phase 20 -
 * and the P17 repair replaced an absolute path list with a before/after difference for
 * exactly this reason. A fifth amendment of the same literal is the thing worth stopping,
 * so the number is gone and the property it stood for is here.
 *
 * ## The property, stated
 *
 * **Every artifact that crosses a job boundary in CI is a *named* step that declares which
 * artifact it moves, the transfers are the declared ones in the declared order, and every
 * download after the first is preceded by its own `rm -rf dist`.** Four consequences
 * follow, and each is one of the mutations at the bottom of this file:
 *
 * 1. **A sixth download or upload fails.** Transfers are compared against a *declaration*
 *    - a list of `{artifact, stepName, why}` - not against an integer. An undeclared sixth
 *    transfer has no declaration to satisfy. Growth is still a deliberate act, but it is now
 *    one edit in one declaration, and that edit has to say what the artifact is and why,
 *    instead of four independent integer bumps in four phases. It also fails for the right
 *    reason: `every-transfer-is-declared`, naming the step that arrived unannounced.
 * 2. **An *unnamed* download or upload fails**, which is the actual risk and the one a
 *    count cannot see. `toBe(5)` is perfectly satisfied by an anonymous
 *    `- uses: actions/download-artifact@v4` step with no `name:` at either level, and by
 *    one with no `with: name:` - an artifact that arrives and leaves with no identity
 *    anybody can trace, in a job where several other gates look steps up *by name*.
 * 3. **A download without its own preceding `rm -rf dist` fails.** This is why downloads
 *    need a discard and uploads do not: `actions/download-artifact` extracts *into* the
 *    working directory rather than replacing it, so a second download merges into the tree
 *    the first one left behind. The flagged builds emit the same logical chunk names with
 *    different content hashes, so the merged tree is neither artifact - 179 files, the union
 *    of a 151-file production `dist` and a flagged one. The identity check caught it on the
 *    first CI run of Phase 9, which is the right place for it to be caught, but a red run is
 *    a worse outcome than a correct one, so the tree is replaced explicitly. The **first**
 *    download in a job needs no discard: the working directory is a fresh checkout and there
 *    is nothing yet to replace. That exemption is **positional**, never a name lookup, so a
 *    newly added download cannot quietly inherit it.
 * 4. **Reordering is detected.** The comparison is between two ordered sequences, so a
 *    transposed pair is a finding. Order is load-bearing in both directions: in
 *    `browser-smoke` each download's identity check and its lane run must follow *that*
 *    download, and in `web-build` every flagged upload has to follow the flagged build that
 *    produced the `dist` it uploads.
 *
 * ## What this is not
 *
 * - **Not a shared source of truth about what the workflow should be, by itself.** The
 *   declaration below is asserted *by* the gates that used to hold their own integers, and
 *   each of them keeps its own lane-specific claims - the memory lane's download and its
 *   identity check, the pointer lane's placement between the two Pixi lanes, Phase 10's
 *   production window, Phase 17's six steps. This file owns the one property all four were
 *   restating, and nothing else.
 * - **Not a weaker gate.** An unnamed transfer and a sixth transfer were both invisible to
 *   a count. A count cannot fail on the mutation that matters most.
 *
 * ## Hermeticity and privacy
 *
 * The workflow is read as text by the gates that call this and is never executed. This file
 * spawns nothing, writes nothing, and resolves no path. It contains no learner data, no
 * subject, note, attachment, statistic, or preference field, and no URL.
 */

/* ── The two CI jobs this is about ──────────────────────────────────────────────── */

/** The job that builds every artifact. Uploads leave it. */
export const BUILD_JOB = 'web-build';
/** The job that measures them. Downloads arrive in it. */
export const BROWSER_JOB = 'browser-smoke';

/** The artifact name of the release build. Uploaded once, downloaded twice. */
export const RELEASE_ARTIFACT = 'web-artifact';

/**
 * The one command that clears the working directory of a previous artifact.
 *
 * Exact rather than a substring, because `rm -rf dist && npm run build:web` is a build and
 * `rm -rf dist && true` is a discard followed by nothing. The distinction is the same one
 * `tests/phase9/memory-gate-wiring.test.ts` makes when it decides whether a step "reads
 * dist": every mention of `dist` being a removal, and nothing else.
 */
export const DISCARD_COMMAND = 'rm -rf dist';

/* ── Parsing ────────────────────────────────────────────────────────────────────── */

/** One step of one job, with the prose around it removed. */
export interface WorkflowStep {
  /** The step's `- name:` value, or `''` for a step that carries none. */
  readonly name: string;
  /** The step's own lines, every comment line removed. */
  readonly ownText: string;
  /** The command it runs, with a `run: |` block folded in. `''` for a `uses:` step. */
  readonly command: string;
  /** The `uses:` action, or `''` for a run step. */
  readonly uses: string;
  /** Whether the step runs anything at all. */
  readonly executes: boolean;
}

/**
 * Splits a workflow into job bodies keyed by job id.
 *
 * The same shape as the sibling gates, and deliberately: they all have to answer "is this
 * step in *this* job", because `web-build` and `browser-smoke` carry steps of identical
 * names - `Verify the shared production artifact identity` is in both, and a workflow-wide
 * search matches the build job's copy first, which inverts the answer.
 */
export function parseWorkflowJobs(text: string): ReadonlyMap<string, string> {
  const lines = text.split('\n');
  const jobsIndex = lines.indexOf('jobs:');
  if (jobsIndex === -1) return new Map();
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current !== null) jobs.get(current)?.push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

/**
 * The two forms a step's keys come in.
 *
 * `      - run: …` puts the key on the list item itself, and `      - name: …` followed by
 * `        run: …` puts it on the next line. Both are ordinary YAML and this workflow uses
 * both - the `uses:`-only and `run:`-only steps are written in the first form.
 *
 * Both are matched here, and matching only the second is a hole with a name: a step written
 * `- uses: actions/download-artifact@v4` with **no `name:` at all** is the exact unannounced
 * artifact this audit exists to catch, and a parser that only recognises the eight-space form
 * does not see it at all. The mutation table below includes that step, and the parser has to
 * be able to report it for the mutation to prove anything.
 */
const STEP_KEY = String.raw`^(?: {6}- | {8})(?:run|uses|with): ?(.*)$`;

/** The same shape with one key named, for a caller that wants a single key's value. */
function stepKey(key: 'run' | 'uses'): RegExp {
  return new RegExp(STEP_KEY.replace('(?:run|uses|with)', key), 'm');
}

/**
 * The command a step runs, with a `run: |` block scalar folded in.
 *
 * Folding is load-bearing rather than tidy: this workflow records its shell snippets as
 * block scalars, and a scan that read only the first line would miss every command under
 * one. The block ends at the first line no more indented than the `run:` key itself, so a
 * sibling key ends it - which a fixed column of eight would get wrong for a step whose
 * `run: |` sits on the list item at six.
 */
export function runCommandOf(ownLines: readonly string[]): string {
  const key = ownLines.findIndex((line) => stepKey('run').test(line));
  if (key === -1) return '';
  const keyLine = ownLines[key] as string;
  const first = keyLine.trim().replace(/^run:\s*/, '');
  if (!/^[|>][-+]?$/.test(first)) return first;
  const keyIndent = keyLine.length - keyLine.trimStart().length;
  const folded: string[] = [];
  for (const line of ownLines.slice(key + 1)) {
    if (line.trim() === '') {
      folded.push('');
      continue;
    }
    if (line.length - line.trimStart().length <= keyIndent) break;
    folded.push(line.trim());
  }
  return folded.join('\n').trim();
}

/**
 * A job body split into its steps, in the order they run.
 *
 * Comment lines are removed **per line** before anything is read, and that is the reason
 * this parser is not a convenience. This workflow's comment blocks sit at the step
 * indentation and explain the step that follows them, and they discuss the very things
 * these gates check: the Phase 10 block states in so many words that its step adds "no
 * build, no download, no browser install, no second `npm ci`", and the assistance block
 * names the discard that precedes its download. A scan that read a step's raw slice would
 * report the comment's own words as the step's, and the fix a maintainer would reach for
 * is to delete the comment - which is how the prose explaining a gate gets lost.
 */
export function stepsOf(jobBody: string): WorkflowStep[] {
  const starts: number[] = [];
  const pattern = /^ {6}- /gm;
  for (let match = pattern.exec(jobBody); match !== null; match = pattern.exec(jobBody)) {
    starts.push(match.index);
  }
  const usesKey = stepKey('uses');
  return starts.map((start, index) => {
    const body = jobBody.slice(start, starts[index + 1] ?? jobBody.length);
    const ownLines = body.split('\n').filter((line) => !/^\s*#/.test(line));
    // The slice ends at the next step, so it ends with whatever separated the two.
    while (ownLines.at(-1)?.trim() === '') ownLines.pop();
    const ownText = ownLines.join('\n');
    return {
      // Read from the raw slice: a comment line is the only thing that could put a `name:`
      // where this key is not, and those were removed from `ownLines` above.
      name: /^ {6}- name: (.+)$/m.exec(body)?.[1] ?? '',
      ownText,
      command: runCommandOf(ownLines),
      uses: usesKey.exec(ownText)?.[1]?.trim() ?? '',
      // Matched over the step's own lines rather than derived from `command` and `uses`, because
      // a consumer asking "does anything run here" wants the answer a YAML reader would give: a
      // step with a `run:` key whose value happens to be empty still executes.
      executes: /^\s*(?:run|uses)\s*:/m.test(ownText),
    };
  });
}

/* ── The transfers ─────────────────────────────────────────────────────────────── */

/** Which direction an artifact transfer goes. */
export type TransferAction = 'download' | 'upload';

/** One step that moves an artifact across a job boundary. */
export interface ArtifactTransfer {
  /** Which way this artifact is going. */
  readonly action: TransferAction;
  /** The step's `- name:`, or `''` when the step carries none. */
  readonly stepName: string;
  /** The `with: name:` value, or `''` when the step names no artifact. */
  readonly artifact: string;
  /** The `uses:` line as the workflow wrote it, for a finding that names the step. */
  readonly uses: string;
  /** Whether the step immediately before this one is its own {@link DISCARD_COMMAND}. */
  readonly hasOwnDiscard: boolean;
}

/**
 * The `with: name:` value of a transfer step, or `''` when it names none.
 *
 * Scanned forward from the `with:` key rather than matched by indentation, so a
 * re-indented step still reports its artifact and a step whose own key *is* `name:` cannot
 * be mistaken for one that names an artifact.
 */
function withArtifactName(ownText: string): string {
  const lines = ownText.split('\n');
  const withAt = lines.findIndex((line) => /^\s*with\s*:/.test(line));
  if (withAt === -1) return '';
  for (const line of lines.slice(withAt + 1)) {
    const match = /^\s*name\s*:\s*(\S+)\s*$/.exec(line);
    if (match) return match[1] as string;
  }
  return '';
}

/**
 * Every step in `steps` that moves an artifact, in the order they run.
 *
 * Each transfer carries whether the step **immediately** before it is its own
 * {@link DISCARD_COMMAND}. Immediate is the whole of it: a discard with another step
 * between it and the download leaves a window in which something can put a `dist` back,
 * and `tests/phase9/pixi-pointer-lane-wiring.test.ts` already holds the Phase 9 window's
 * near end for exactly that reason. Stating it once for every download is what lets a
 * *fourth* flagged artifact inherit the invariant instead of a maintainer remembering to
 * add a discard for it - which is the amendment this file exists to end.
 */
export function transfersOf(
  steps: readonly WorkflowStep[],
  action: TransferAction,
): readonly ArtifactTransfer[] {
  const transfers: ArtifactTransfer[] = [];
  for (const [index, step] of steps.entries()) {
    if (!step.uses.startsWith(`actions/${action}-artifact@`)) continue;
    const previous = index > 0 ? steps[index - 1] : undefined;
    transfers.push({
      action,
      stepName: step.name,
      artifact: withArtifactName(step.ownText),
      uses: step.uses,
      hasOwnDiscard: previous?.command.trim() === DISCARD_COMMAND,
    });
  }
  return transfers;
}

/* ── The declaration ────────────────────────────────────────────────────────────── */

/**
 * How many artifact-transfer lines the **raw** job text holds, in either YAML spelling.
 *
 * A count - and the only one left in this module. It exists to keep the parse honest: every
 * property below reads *parsed* steps, so a parser that quietly stopped matching one spelling
 * would report a clean job for the wrong reason, which is the vacuity this repository has
 * already found in its own gates. Comparing the raw lines against the parsed transfers catches
 * that, and comparing them against the *declaration* rather than a fixed integer is what keeps
 * this from becoming the count it replaced: a legitimate sixth artifact grows the declaration
 * and this follows it, where a hard-coded number would have needed its fifth amendment.
 */
export function rawTransferLineCount(jobText: string, action: TransferAction): number {
  const pattern = new RegExp(String.raw`^\s*(?:- )?uses:\s*actions/${action}-artifact\S*\s*$`, 'gm');
  return [...jobText.matchAll(pattern)].length;
}

/** One transfer the workflow is expected to make, and why it is there. */
export interface DeclaredTransfer {
  /** Which way it goes. */
  readonly action: TransferAction;
  /** The `with: name:` value the step must declare. */
  readonly artifact: string;
  /** The step's `- name:`, which must be present and unique in the job. */
  readonly stepName: string;
  /**
   * What this transfer is for.
   *
   * Required, and load-bearing rather than decoration: an amendment to a declaration has
   * to state what the new artifact is for, so the sixth artifact is a sentence somebody
   * wrote rather than an integer somebody incremented. Read by the gates only as a
   * non-empty string, so it cannot drift into prose the workflow would then also have to
   * match, and it is echoed into the finding when a declared transfer goes missing - which
   * is the one place a reader genuinely needs to know why it was there.
   */
  readonly why: string;
}

export const DOWNLOAD_DECLARATION: readonly DeclaredTransfer[] = Object.freeze([
  {
    action: 'download',
    artifact: RELEASE_ARTIFACT,
    stepName: 'Download the shared production artifact',
    why: 'The release artifact, which the Phase 1 viewport suite and the Phase 10 media lane both certify before anything replaces it. First in the job, so it needs no discard: a fresh checkout has no dist to clear.',
  },
  {
    action: 'download',
    artifact: 'pixi-web-artifact',
    stepName: 'Download the Pixi-flagged artifact',
    why: 'The Phase 9 flagged build, measured by the memory lane and the canvas-pointer lane. It replaces the production tree, so it needs its own discard.',
  },
  {
    action: 'download',
    artifact: 'pixi-fishing-web-artifact',
    stepName: 'Download the Pixi-fishing-flagged artifact',
    why: 'The Phase 17 flagged build, and the only way the flagged pond can be measured in a browser at all, because VITE_PIXI_FISHING is a build-time flag. It replaces the Pixi-flagged tree, so it needs its own discard.',
  },
  {
    action: 'download',
    artifact: 'assistance-web-artifact',
    stepName: 'Download the assistance-flagged web artifact',
    why: 'The Phase 19 flagged build, and the first browser evidence the learner-facing half of that phase ever had. It replaces the fishing tree, so it needs its own discard.',
  },
  {
    action: 'download',
    artifact: RELEASE_ARTIFACT,
    stepName: 'Download the shared production artifact for the absence lane',
    why: 'The release artifact downloaded back, and its identity re-verified, so the Phase 19 absence lane can claim the card is absent from a production build rather than from a flagged one. It replaces the assistance tree, so it needs its own discard.',
  },
]);

export const UPLOAD_DECLARATION: readonly DeclaredTransfer[] = Object.freeze([
  {
    action: 'upload',
    artifact: 'web-build-metadata',
    stepName: 'Upload build metadata',
    why: 'The build census the metadata record writes. Not an artifact of its own - it is the provenance of the ones below - and uploaded before any dist exists, so a reader can tell which build produced what.',
  },
  {
    action: 'upload',
    artifact: RELEASE_ARTIFACT,
    stepName: 'Upload the shared production web artifact',
    why: 'The release artifact, with the production manifest beside it. The single production upload: every upload below it is a flagged build that exists to be measured and then discarded.',
  },
  {
    action: 'upload',
    artifact: 'pixi-web-artifact',
    stepName: 'Upload the Pixi-flagged web artifact',
    why: 'The Phase 9 flagged build, with its own manifest, so it can never be mistaken for the release identity or overwrite it.',
  },
  {
    action: 'upload',
    artifact: 'pixi-fishing-web-artifact',
    stepName: 'Upload the Pixi-fishing-flagged web artifact',
    why: 'The Phase 17 flagged build, with its own manifest, on the same terms.',
  },
  {
    action: 'upload',
    artifact: 'assistance-web-artifact',
    stepName: 'Upload the assistance-flagged web artifact',
    why: 'The Phase 19 flagged build, with its own manifest, on the same terms. Phase 19 deferred this lane to Phase 21 and authorised it there, on the grounds that this phase runs the accessibility audit anyway.',
  },
]);

/* ── The checks ────────────────────────────────────────────────────────────────── */

/**
 * The properties, named.
 *
 * Findings carry the check's name so a red run reports *which* property broke rather than
 * printing a diff of two arrays, and so {@link TRANSFER_MUTATIONS} can name the one check
 * each mutation has to be caught by. Four rather than one because they fail for four
 * different reasons, and a maintainer reading a red run needs to know which one they hit.
 */
export type TransferCheck =
  | 'every-transfer-is-a-named-step'
  | 'every-transfer-is-declared'
  | 'transfers-run-in-declared-order'
  | 'every-download-has-its-own-discard';

export interface TransferFinding {
  readonly check: TransferCheck;
  readonly detail: string;
}

function describeTransfer(transfer: ArtifactTransfer): string {
  const name = transfer.stepName === '' ? '(an unnamed step)' : `"${transfer.stepName}"`;
  const artifact = transfer.artifact === '' ? 'no artifact name' : `"${transfer.artifact}"`;
  return `the ${transfer.action} step ${name} declaring ${artifact}`;
}

/**
 * Every way `observed` fails to be `declaration`, as findings.
 *
 * Empty means the job moves exactly the declared artifacts, in the declared order, each as
 * a named step that says which artifact it moves, and - for downloads - each after its own
 * discard.
 *
 * Two consumers and one implementation: the four gates' expectations, which report a red
 * run as a named check with the transfer that broke it, and the mutation table below,
 * which proves each of these can fail. A second implementation for the mutation table
 * would prove only that the second implementation can fail, which is the defect this file
 * was written to remove from four places at once.
 */
export function auditArtifactTransfers(
  observed: readonly ArtifactTransfer[],
  declaration: readonly DeclaredTransfer[],
): readonly TransferFinding[] {
  const findings: TransferFinding[] = [];
  const verb = observed[0]?.action ?? declaration[0]?.action ?? 'artifact';

  // 1. Every transfer is a named step that says which artifact it moves.
  for (const transfer of observed) {
    if (transfer.stepName === '') {
      findings.push({
        check: 'every-transfer-is-a-named-step',
        detail: `a step runs \`${transfer.uses}\` with no \`name:\` at the step level, so the artifact it moves is unannounced in the job log and unnameable by every gate that looks a step up by name.`,
      });
    }
    if (transfer.artifact === '') {
      findings.push({
        check: 'every-transfer-is-a-named-step',
        detail: `${describeTransfer(transfer)} has no \`with: name:\`, so it moves an artifact nobody can name on either side of the boundary.`,
      });
    }
  }
  // Two steps sharing a name is not a count problem, it is a traceability problem: several
  // gates in this repository find a step by name, and they would all find the first one,
  // so the second becomes unreferenceable while looking perfectly wired.
  const counts = new Map<string, number>();
  for (const transfer of observed) {
    if (transfer.stepName === '') continue;
    counts.set(transfer.stepName, (counts.get(transfer.stepName) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) {
      findings.push({
        check: 'every-transfer-is-a-named-step',
        detail: `${count} ${verb} steps are all named "${name}", so a gate that looks a step up by name can only ever find the first of them.`,
      });
    }
  }

  // 2. The transfers are the declared ones: nothing undeclared arrived, and nothing
  //    declared went missing. Compared as a multiset rather than a sequence, so a
  //    transposition is reported by check 3 and not as a missing-plus-extra pair here.
  const isDeclared = (stepName: string, artifact: string): boolean =>
    declaration.some((entry) => entry.stepName === stepName && entry.artifact === artifact);
  for (const transfer of observed) {
    if (!isDeclared(transfer.stepName, transfer.artifact)) {
      findings.push({
        check: 'every-transfer-is-declared',
        detail: `${describeTransfer(transfer)} is not in the declaration. An artifact crossing this boundary has to be declared - which artifact it is, what its step is called, and what it is for - rather than arriving because a count was satisfied.`,
      });
    }
  }
  for (const entry of declaration) {
    const present = observed.some(
      (transfer) => transfer.stepName === entry.stepName && transfer.artifact === entry.artifact,
    );
    if (!present) {
      findings.push({
        check: 'every-transfer-is-declared',
        detail: `the declaration expects the ${entry.action} "${entry.stepName}" ("${entry.artifact}"), which this job does not make. ${entry.why}`,
      });
    }
  }

  // 3. Order, which is load-bearing in both directions.
  const observedOrder = observed.map((transfer) => transfer.stepName);
  const declaredOrder = declaration.map((entry) => entry.stepName);
  if (observedOrder.join('\u0000') !== declaredOrder.join('\u0000')) {
    findings.push({
      check: 'transfers-run-in-declared-order',
      detail: `these ${verb} transfers run in the order [${observedOrder.join(' -> ')}] rather than [${declaredOrder.join(' -> ')}]. Order is load-bearing: a download's identity check and its lane must follow that download, and a flagged upload must follow the flagged build that produced the dist it uploads.`,
    });
  }

  // 4. Every download after the first clears the tree it is about to replace. The first is
  //    exempt by position and by nothing else.
  for (const [index, transfer] of observed.entries()) {
    if (transfer.action !== 'download' || index === 0) continue;
    if (!transfer.hasOwnDiscard) {
      findings.push({
        check: 'every-download-has-its-own-discard',
        detail: `${describeTransfer(transfer)} is not immediately preceded by its own \`${DISCARD_COMMAND}\`. \`actions/download-artifact\` extracts into the working directory rather than replacing it, so this download merges into the tree the previous one left behind - a union of two builds that is neither of them.`,
      });
    }
  }

  return findings;
}

/**
 * The findings for one workflow and one job, for consumers that read the workflow text
 * themselves rather than assembling the transfers.
 *
 * The single entry point the four gates use, so none of them can reimplement the audit over
 * a different parse and quietly hold a different property under the same name.
 */
export function auditJobTransfers(
  workflow: string,
  jobName: string,
  declaration: readonly DeclaredTransfer[],
): readonly TransferFinding[] {
  const body = parseWorkflowJobs(workflow).get(jobName) ?? '';
  if (body === '') {
    return [
      {
        check: 'every-transfer-is-declared',
        detail: `ci.yml has no ${jobName} job, so none of its ${declaration.length} declared ${declaration[0]?.action ?? 'artifact'} transfers can be checked. A job that cannot be found is not a job whose transfers are correct.`,
      },
    ];
  }
  const action = declaration[0]?.action ?? 'download';
  return auditArtifactTransfers(transfersOf(stepsOf(body), action), declaration);
}

/* ── Mutations that prove each check can fail ───────────────────────────────────── */

export interface TransferMutation {
  /** What the mutated workflow does, in the words a reader would use. */
  readonly what: string;
  /** The check that has to reject it. */
  readonly check: TransferCheck;
  /**
   * Which direction it attacks.
   *
   * Declared rather than inferred, because the two directions live in different jobs and a
   * gate scoped to one of them must not be handed the other's mutations. `tests/e2e/phase10-media-lane.test.ts`
   * reads one job's parsed steps and would silently "prove" itself against a `web-build`
   * upload mutation it cannot see - a green proof of nothing, which is the one thing its own
   * completeness assertion exists to prevent.
   */
  readonly direction: TransferAction;
  readonly apply: (text: string) => string;
}

/** Replaces text through a function, so `$` in the replacement is never a pattern. */
export function rewrite(text: string, from: string, to: string): string {
  return text.replace(from, () => to);
}

/** A job header: two spaces, a job id, a colon. Never a comment line, which carries a `#`. */
const JOB_HEADER = /\n {2}[a-z0-9_-]+:[ \t]*(?:\n|$)/g;

/**
 * The half-open text range one named step occupies.
 *
 * The end is the earlier of the next step in the same job and the next job header, and the
 * job header is what makes it correct rather than merely plausible: the last step of a job
 * runs to the end of *that job's body*, not to the end of the file, so a helper that searched
 * only for the next step hands back a block containing the following job's header and its
 * comments. That is how a "move this step" mutation becomes a no-op that still reports
 * having changed something - it moves the step together with everything after it, which is
 * the same position it started in.
 */
function stepBounds(text: string, stepName: string): { start: number; end: number } {
  const start = text.indexOf(`      - name: ${stepName}\n`);
  if (start === -1) return { start: -1, end: -1 };
  const nextStep = text.indexOf('\n      - ', start + 1);
  JOB_HEADER.lastIndex = 0;
  JOB_HEADER.exec(text.slice(0, start));
  const header = JOB_HEADER.exec(text.slice(start));
  const end = Math.min(
    nextStep === -1 ? text.length : nextStep + 1,
    header === null ? text.length : start + header.index + 1,
  );
  return { start, end };
}

/**
 * Moves a run of consecutive named steps to sit next to the step called `anchor`.
 *
 * Used by the reorder mutations, which move a discard **together with** its download, so a
 * swap isolates ordering instead of also breaking the discard invariant. A swap that moved a
 * download away from its own discard would be rejected by two checks at once and would prove
 * nothing about either one on its own - which is the mistake this helper exists to prevent,
 * and the reason the download mutations below are written against pairs rather than steps.
 *
 * Returns the text unchanged when an anchor is missing, and every mutation below asserts
 * that it changed something - a no-op reported as a proof is worse than no mutation at all.
 */
export function moveSteps(
  text: string,
  stepNames: readonly string[],
  anchor: string,
  where: 'before' | 'after',
): string {
  const first = stepBounds(text, stepNames[0] ?? '');
  const last = stepBounds(text, stepNames[stepNames.length - 1] ?? '');
  if (first.start === -1 || last.start === -1) return text;
  const block = text.slice(first.start, last.end);
  const withoutBlock = text.slice(0, first.start) + text.slice(last.end);
  // The anchor is located in the text the block has already been lifted out of. Measuring it
  // against the original instead would splice at an offset that the removal has already
  // shifted, which lands the block in the wrong place entirely - and, when it lands *inside*
  // another step, produces a workflow that is neither the original nor a clean mutation.
  const anchorBounds = stepBounds(withoutBlock, anchor);
  if (anchorBounds.start === -1) return text;
  const at = where === 'before' ? anchorBounds.start : anchorBounds.end;
  return withoutBlock.slice(0, at) + block + withoutBlock.slice(at);
}

/**
 * The Phase 17 discard and download, which move together so a swap isolates ordering.
 *
 * Declared as a pair because that is what a reorder has to move: a transposition that moved
 * the download and left its discard behind would also break the discard invariant, so the
 * mutation would be caught by two checks at once and would prove nothing about ordering on
 * its own.
 */
export const PIXI_FISHING_PAIR: readonly string[] = Object.freeze([
  'Discard the Pixi-flagged dist before the fishing download',
  'Download the Pixi-fishing-flagged artifact',
]);

/** The step each reorder mutation lands relative to, named so the anchors are not retyped. */
export const ASSISTANCE_DOWNLOAD_STEP = 'Download the assistance-flagged web artifact';
export const ASSISTANCE_UPLOAD_STEP = 'Upload the assistance-flagged web artifact';

/** One mutation's verdict, so a caller asserts two booleans instead of reimplementing the audit. */
export interface TransferMutationResult {
  /** What the mutated workflow does, in the words a reader would use. */
  readonly what: string;
  /** The check the mutation is meant to trip. */
  readonly check: TransferCheck;
  /** Whether the mutation changed the workflow at all. */
  readonly changed: boolean;
  /** Whether the named check appears in the mutated workflow's findings. */
  readonly caught: boolean;
  /** Every check that fired, so a failure message can show what else was noticed. */
  readonly fired: readonly TransferCheck[];
}

/**
 * Applies every mutation in {@link TRANSFER_MUTATIONS} to `workflow` and reports which ones
 * were rejected.
 *
 * One implementation for three consumers - the memory gate, the fishing gate and the pointer
 * gate - so "this property can fail" is established once rather than by three copies of a loop
 * that could drift. Each consumer still asserts the result for itself, because a property that
 * only one file ever tried to break is a property the other two are merely reading.
 *
 * `tests/e2e/phase10-media-lane.test.ts` does **not** use this: it has its own check registry
 * whose completeness assertion requires every check to appear in its own table, so it calls
 * {@link auditJobTransfers} directly and its findings have to be check-name-addressable.
 */
export function transferMutationResults(workflow: string): readonly TransferMutationResult[] {
  return TRANSFER_MUTATIONS.map((mutation) => {
    const mutated = mutation.apply(workflow);
    const findings = [
      ...auditJobTransfers(mutated, BROWSER_JOB, DOWNLOAD_DECLARATION),
      ...auditJobTransfers(mutated, BUILD_JOB, UPLOAD_DECLARATION),
    ];
    const fired = [...new Set(findings.map((finding) => finding.check))];
    return {
      what: mutation.what,
      check: mutation.check,
      changed: mutated !== workflow,
      caught: fired.includes(mutation.check),
      fired,
    };
  });
}

/**
 * Every way this wiring has actually been got wrong, each naming the check that must
 * reject it.
 *
 * Four kinds, and they are the four the property was written to catch: an undeclared
 * arrival (a sixth), an unannounced one (no name), a download that does not replace the
 * tree it is about to replace, and a transposition. Both directions - download and upload -
 * are mutated for the first three, because a gate that only proves the download side can
 * fail is half a gate and the two directions share nothing worth trusting for it.
 *
 * A consumer asserts that each mutation changed the workflow at all - a mutation whose
 * anchor matched nothing is a no-op that reads exactly like a proof - and that the named
 * check appears in its findings.
 */
export const TRANSFER_MUTATIONS: readonly TransferMutation[] = Object.freeze([
  {
    what: 'a sixth artifact download is added to browser-smoke',
    check: 'every-transfer-is-declared',
    direction: 'download',
    apply: (text) =>
      rewrite(
        text,
        '      - name: Run the default-artifact assistance lane\n',
        '      - name: Download a sixth artifact\n' +
          '        uses: actions/download-artifact@v4\n' +
          '        with:\n' +
          '          name: sixth-web-artifact\n' +
          '          path: .\n' +
          '      - name: Run the default-artifact assistance lane\n',
      ),
  },
  {
    what: 'a sixth artifact upload is added to web-build',
    check: 'every-transfer-is-declared',
    direction: 'upload',
    apply: (text) =>
      rewrite(
        text,
        '      - name: Upload the assistance-flagged web artifact\n',
        '      - name: Upload a sixth artifact\n' +
          '        uses: actions/upload-artifact@v4\n' +
          '        with:\n' +
          '          name: sixth-web-artifact\n' +
          '          path: dist\n' +
          '      - name: Upload the assistance-flagged web artifact\n',
      ),
  },
  {
    what: 'a download step carries no name',
    check: 'every-transfer-is-a-named-step',
    direction: 'download',
    apply: (text) =>
      rewrite(
        text,
        '      - name: Download the Pixi-flagged artifact\n        uses: actions/download-artifact@v4\n',
        '      - uses: actions/download-artifact@v4\n',
      ),
  },
  {
    what: 'an upload step carries no name',
    check: 'every-transfer-is-a-named-step',
    direction: 'upload',
    apply: (text) =>
      rewrite(
        text,
        '      - name: Upload the Pixi-fishing-flagged web artifact\n        uses: actions/upload-artifact@v4\n',
        '      - uses: actions/upload-artifact@v4\n',
      ),
  },
  {
    what: "a download's own `rm -rf dist` is dropped",
    check: 'every-download-has-its-own-discard',
    direction: 'download',
    apply: (text) =>
      rewrite(
        text,
        '      - name: Discard the Pixi-flagged dist before the fishing download\n        run: rm -rf dist\n',
        '',
      ),
  },
  {
    what: 'two downloads are transposed, each keeping its own discard',
    check: 'transfers-run-in-declared-order',
    direction: 'download',
    apply: (text) => moveSteps(text, PIXI_FISHING_PAIR, ASSISTANCE_DOWNLOAD_STEP, 'after'),
  },
  {
    what: 'two uploads are transposed',
    check: 'transfers-run-in-declared-order',
    direction: 'upload',
    apply: (text) =>
      moveSteps(text, ['Upload the Pixi-fishing-flagged web artifact'], ASSISTANCE_UPLOAD_STEP, 'after'),
  },
]);