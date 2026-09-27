/**
 * The two pinned pre-cutover source files, read from fixtures rather than from git.
 *
 * ## Why these exist, and why they are fixtures
 *
 * Two of the strongest assertions in the Phase 7 verification compare today's source
 * against the source as it was before the cutover:
 *
 * 1. `subjectPersistence.ts`'s function bodies must be byte-identical to Phase 6 once
 *    comments are blanked - which is the whole of the "comments may differ, code may
 *    not" claim, and the evidence that the documented rollback is still the rollback.
 * 2. The pre-cutover `WelcomeScreen.tsx` must still be readable by the legacy-caller
 *    detector and must still bind the leaking pair - which is the positive control that
 *    stops "no application caller remains" from being a detector that silently stopped
 *    working.
 *
 * Both were originally expressed as `git show 8eb2587:<path>` at test time. **That is a
 * gate defect and it failed in CI**: `.github/workflows/ci.yml` uses `actions/checkout@v4`
 * with no `fetch-depth`, so every job is a depth-1 clone, `8eb2587` is not in the
 * runner's object store, and both tests failed with `fatal: invalid object name` while
 * passing locally on a full clone. Reproduced exactly in a depth-1 clone: 2 failed / 142
 * passed files, 2 failed / 1985 passed tests.
 *
 * The repair is hermeticity, not a deeper clone. The two files are committed verbatim
 * under `./fixtures`, each with a header recording the commit it was captured from and
 * the **sha256 of its own body**, and {@link readPhase6Fixture} re-derives that digest at
 * read time. So:
 *
 * - no test depends on clone depth, on history being fetched, or on a SHA staying
 *   resolvable;
 * - "unchanged since Phase 6" becomes an explicit, diffable claim a reviewer can read in
 *   the repository, rather than a lookup that depends on what the runner happened to
 *   fetch;
 * - and the fixture is self-verifying: editing the body fails the digest check, so the
 *   snapshot cannot drift into agreeing with whatever the working tree currently is.
 *
 * The assertions themselves are **not** weakened. The byte-identity comparison is still a
 * byte comparison between the pinned bytes and the working file, and the positive control
 * is still the real pre-cutover screen, not a synthetic stand-in.
 *
 * ## Why not simply keep the SHA and fetch history
 *
 * Because it is the wrong trade, twice over. It would make eight CI jobs download full
 * repository history to satisfy two unit tests, and it would keep a gate's strength
 * contingent on a repository setting that has nothing to do with the property under
 * test. A gate that can only run in one clone configuration is a gate that will be
 * reported as "environment-dependent" again.
 *
 * Phase: 7.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The line that separates a fixture's header from its body.
 *
 * A whole line, and the only line in either fixture that is exactly this text, so
 * `indexOf` on the newline-delimited string is an unambiguous split rather than a
 * heuristic.
 */
const SENTINEL = '// __P7_FIXTURE_BODY_BELOW__';

const FIXTURE_DIRECTORY = join(process.cwd(), 'tests/phase7/support/fixtures');

/** The two fixtures, named by what they are rather than by the commit they came from. */
export const PHASE_6_FIXTURE_FILES = {
  subjectPersistence: 'phase6-subject-persistence.ts.fixture',
  welcomeScreen: 'phase6-welcome-screen.tsx.fixture',
} as const;

export interface Phase6Fixture {
  /** The file name under `tests/phase7/support/fixtures`. */
  readonly file: string;
  /** The header comment, sentinel line included. */
  readonly header: string;
  /**
   * The pinned source bytes, **exactly** as `git show` produced them: no header, no
   * reformatting, no trailing-newline adjustment.
   */
  readonly body: string;
  /** SHA-256 of {@link body}, recomputed at read time. */
  readonly bodySha256: string;
  /** The digest the header declares. */
  readonly declaredSha256: string;
  /** The byte length the header declares. */
  readonly declaredBytes: number;
  /** `Buffer.byteLength` of {@link body}, measured. */
  readonly measuredBytes: number;
  /** The source path the header declares. */
  readonly declaredPath: string;
  /** The full commit sha the header declares. */
  readonly declaredCommit: string;
  /** The short commit sha the header declares. */
  readonly declaredShortCommit: string;
}

/**
 * The header's three declaration lines, parsed by shape rather than by token position.
 *
 * Tolerant of the spacing a hand-edited header might carry, strict about the shapes: a
 * commit must be 40 hex characters, a byte count a number, and a digest 64. So a header
 * that has been edited into saying something else is a **throw**, not a quietly different
 * baseline.
 */
function declarations(header: string): {
  path: string;
  commit: string;
  shortCommit: string;
  bytes: number;
  sha256: string;
} {
  const one = (pattern: RegExp, what: string): RegExpExecArray => {
    const match = pattern.exec(header);
    if (match === null) throw new Error(`the fixture header's "${what}" line is missing or malformed`);
    return match;
  };
  return {
    path: one(/^\s*\*\s+Source path\s+:\s+(\S+)\s*$/m, 'Source path')[1] as string,
    commit: one(
      /^\s*\*\s+Taken from\s+:\s+commit\s+([0-9a-f]{40})\b.*short form\s+([0-9a-f]{7,40})\s*$/m,
      'Taken from',
    )[1] as string,
    shortCommit: one(
      /^\s*\*\s+Taken from\s+:\s+commit\s+([0-9a-f]{40})\b.*short form\s+([0-9a-f]{7,40})\s*$/m,
      'Taken from',
    )[2] as string,
    bytes: Number.parseInt(
      one(/^\s*\*\s+Captured as\s+:\s+(\d+)\s+bytes\b/m, 'Captured as')[1] as string,
      10,
    ),
    sha256: one(
      /^\s*\*\s+Captured as\s+:\s+\d+\s+bytes,\s+sha256\s+([0-9a-f]{64})\s*$/m,
      'Captured as',
    )[1] as string,
  };
}

/**
 * Read one pinned fixture and re-derive its digest.
 *
 * Throws - rather than returning a partial value - if the sentinel is missing or the
 * body does not hash to what the header declares. A reader that quietly returned a
 * degraded value here would let a corrupted snapshot pass a byte-identity comparison,
 * which is the one thing this file exists to prevent.
 */
export function readPhase6Fixture(file: string): Phase6Fixture {
  const raw = readFileSync(join(FIXTURE_DIRECTORY, file), 'utf8');
  const marker = raw.indexOf(SENTINEL);
  if (marker < 0) {
    throw new Error(`${file} has no ${SENTINEL} line, so its body cannot be located`);
  }
  const split = raw.indexOf('\n', marker);
  if (split < 0) throw new Error(`${file} ends at its sentinel line and has no body`);
  const header = raw.slice(0, split + 1);
  const body = raw.slice(split + 1);
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const declared = declarations(header);
  return {
    file,
    header,
    body,
    bodySha256,
    declaredSha256: declared.sha256,
    declaredBytes: declared.bytes,
    measuredBytes: Buffer.byteLength(body, 'utf8'),
    declaredPath: declared.path,
    declaredCommit: declared.commit,
    declaredShortCommit: declared.shortCommit,
  };
}

/** The Phase 6 `src/services/persistence/subjectPersistence.ts`, verbatim. */
export function phase6SubjectPersistence(): Phase6Fixture {
  return readPhase6Fixture(PHASE_6_FIXTURE_FILES.subjectPersistence);
}

/** The Phase 6 `src/ui/screens/WelcomeScreen.tsx`, verbatim. */
export function phase6WelcomeScreen(): Phase6Fixture {
  return readPhase6Fixture(PHASE_6_FIXTURE_FILES.welcomeScreen);
}
