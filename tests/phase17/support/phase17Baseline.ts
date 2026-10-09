/**
 * Phase 17's baseline, read from committed fixtures rather than from `git show`.
 *
 * ## Why this exists
 *
 * `tests/phase17/fishingPhaseInvariants.test.ts` compares today's source against the source as it
 * was at the Phase 16 commit (`ade1f78`) - the phase it was authorised to change nothing in. That
 * comparison was originally a `git show ade1f78:<path>` lookup at test time, and it was broken in
 * the two ways the repository's own hermeticity principle forbids
 * (`tests/phase8/qa-hermeticity.test.ts` states it):
 *
 * - `.github/workflows/ci.yml` uses `actions/checkout@v4` with no `fetch-depth`, so every job is a
 *   **depth-1 clone** and `ade1f78` is not in the runner's object store. `git show` then failed, the
 *   helper returned `null`, and every byte-identity assertion took an early `return` - **a gate that
 *   stops gating while staying green**. That is the worse failure of the two.
 * - The `git diff --stat ade1f78...HEAD` recording ran uncaught and threw `fatal: ambiguous
 *   argument`, which is the red CI run that surfaced all of this.
 *
 * The repair follows the Phase 7 precedent (`tests/phase7/support/phase6Fixtures.ts`): the baseline
 * files are committed verbatim under `./fixtures`, each with a header naming the commit and the
 * sha256 of its own body, and this module re-derives that digest at read time. So:
 *
 * - no test depends on clone depth, on history being fetched, or on a SHA staying resolvable;
 * - "unchanged since Phase 16" becomes an explicit, diffable claim a reviewer can read in the
 *   repository;
 * - the fixture is self-verifying: editing a body fails its digest check, so a snapshot cannot
 *   drift into agreeing with whatever the working tree currently is.
 *
 * Every read **throws** when a fixture is missing or a digest disagrees. There is no `null` return
 * for a missing baseline: a gate that cannot compare fails loudly instead of passing vacuously.
 *
 * Phase: 17.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A whole line, and the only line in a fixture that is exactly this text. */
const SENTINEL = '// __P17_FIXTURE_BODY_BELOW__';

const FIXTURE_DIRECTORY = join(process.cwd(), 'tests/phase17/support/fixtures');

/** The baseline commit these fixtures were captured from. */
export const PHASE17_BASELINE_COMMIT = 'ade1f78bbd9271018dbdb818ac4f1fd9b8ca13ab';
export const PHASE17_BASELINE_SHORT_COMMIT = 'ade1f78';

/**
 * Every source path this module pins.
 *
 * Declared so the suite can assert the fixture set and the compared set are the same list rather
 * than drifting apart, and so a missing fixture is a named failure rather than a silent skip.
 */
export const PHASE17_PINNED_PATHS = Object.freeze([
  'src/core/progression/canonicalProgression.ts',
  'src/services/persistence/v2/validation.ts',
  'src/services/persistence/v2/schema.ts',
  'src/services/persistence/v2/database.ts',
  'src/services/persistence/v2/dualWrite.ts',
  'src/core/fishing/fishingTypes.ts',
  'src/core/progression/types.ts',
  'src/core/progression/roomClearRewards.ts',
  'src/core/review/reviewPassRewards.ts',
  'src/core/review/interruptedReviewSession.ts',
  'src/game/systems/fishingMechanics.ts',
  'src/game/systems/fishingTypes.ts',
  'src/game/scenes/FishingScene.ts',
] as const);

/** The fixture file name for a source path: the slashes flattened, suffixed with `.fixture`. */
export function fixtureNameFor(sourcePath: string): string {
  return `${sourcePath.replaceAll('/', '__')}.fixture`;
}

export interface Phase17BaselineFixture {
  readonly file: string;
  /** The pinned source bytes, exactly as the baseline commit carried them. */
  readonly body: string;
  /** SHA-256 of {@link body}, recomputed on read. */
  readonly bodySha256: string;
  readonly declaredSha256: string;
  readonly declaredBytes: number;
  readonly measuredBytes: number;
  readonly declaredPath: string;
  readonly declaredCommit: string;
  readonly declaredShortCommit: string;
}

function one(header: string, pattern: RegExp, what: string): RegExpExecArray {
  const match = pattern.exec(header);
  if (match === null) {
    throw new Error(`a Phase 17 fixture header's "${what}" line is missing or malformed`);
  }
  return match;
}

/**
 * Read one pinned fixture and re-derive its digest.
 *
 * Throws - never returns a degraded value - if the sentinel is missing, the header is malformed,
 * the declared path does not match the requested one, or the body does not hash to what the header
 * declares. A reader that quietly returned a partial value would let a corrupted snapshot pass a
 * byte-identity comparison, which is the one thing this module exists to prevent.
 */
export function readPhase17Fixture(sourcePath: string): Phase17BaselineFixture {
  const file = fixtureNameFor(sourcePath);
  const raw = readFileSync(join(FIXTURE_DIRECTORY, file), 'utf8');
  const marker = raw.indexOf(SENTINEL);
  if (marker < 0) {
    throw new Error(`${file} has no ${SENTINEL} line, so its body cannot be located`);
  }
  const split = raw.indexOf('\n', marker);
  if (split < 0) throw new Error(`${file} ends at its sentinel line and has no body`);
  const header = raw.slice(0, split + 1);
  const body = raw.slice(split + 1);

  const declaredPath = one(header, /^\s*\*\s+Source path\s*:\s*(\S+)\s*$/m, 'Source path')[1] as string;
  const takenFrom = one(
    header,
    /^\s*\*\s+Taken from\s*:\s*commit\s+([0-9a-f]{40})\b.*short form\s+([0-9a-f]{7,40})\)?\s*$/m,
    'Taken from',
  );
  const captured = one(
    header,
    /^\s*\*\s+Captured as\s*:\s*(\d+)\s+bytes,\s+sha256\s+([0-9a-f]{64})\s*$/m,
    'Captured as',
  );

  if (declaredPath !== sourcePath) {
    throw new Error(`${file} declares source path "${declaredPath}", not "${sourcePath}"`);
  }

  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const declaredSha256 = captured[2] as string;
  if (bodySha256 !== declaredSha256) {
    throw new Error(
      `${file} has drifted: its body hashes to ${bodySha256} but its header declares ${declaredSha256}`,
    );
  }

  return {
    file,
    body,
    bodySha256,
    declaredSha256,
    declaredBytes: Number.parseInt(captured[1] as string, 10),
    measuredBytes: Buffer.byteLength(body, 'utf8'),
    declaredPath,
    declaredCommit: takenFrom[1] as string,
    declaredShortCommit: takenFrom[2] as string,
  };
}

/**
 * The pinned baseline bytes for one source path.
 *
 * Throws when the path is not pinned or its fixture is missing or corrupt, so a caller comparing
 * against it can never silently compare against nothing.
 */
export function baselineBody(sourcePath: string): string {
  return readPhase17Fixture(sourcePath).body;
}
