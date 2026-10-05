/**
 * Phase 19: non-vacuity probes.
 *
 * ## What this file is for
 *
 * A green suite proves nothing about itself. This file answers one question about every
 * behavioural claim in `tests/phase19/`: **if the decision were reverted, would the gate that
 * claims it go red?** Each probe reverts exactly one decision and runs the gate that is
 * supposed to notice.
 *
 * ## Two kinds of probe, with different strength, stated honestly
 *
 * | Kind | How the mutation is delivered | What it proves |
 * | --- | --- | --- |
 * | **Predicate** (P01-P04) | The gate's *scanner* is run over a mutated source **string**, in memory | The scanner matches the token it claims to forbid |
 * | **Isolated gate** (P05-P12) | A **child vitest process** runs the real gate file against **mutated module copies in `/tmp`**, wired in through a temporary `resolve.alias` | The real gate file goes red on this revert |
 *
 * The second is much stronger and is used for every behavioural claim. The first is weaker -
 * it does not run a gate file - and is used only where a gate's subject *is* a source string,
 * which is the four static scans. The difference is recorded here rather than blurred, because
 * "the probe passed" means different things for the two kinds and a reader should know which.
 *
 * ## Why the behavioural probes run in a child process at all
 *
 * Two things went wrong on the way to this design, and both are worth stating:
 *
 * 1. **Mutating `src/` and calling the imported function proves nothing.** Vitest transforms a
 *    module once and caches it per worker, so a module already imported by the running test file
 *    is the *unmutated* one. Five probes reported `detected: false` for exactly this reason: the
 *    mutation was on disk, the checksum had changed, and the gate still passed because it was
 *    calling the cached original.
 * 2. **Mutating `src/` while the 5923-test suite runs in parallel is a flake generator.** Another
 *    worker could read a half-written module mid-probe. Phase 18 already lost a run to a
 *    filesystem-mutating gate timing out because a second agent was editing underneath it, and
 *    that failure mode is not acceptable to reproduce.
 *
 * So the behavioural probes write mutated copies to `/tmp/opencode/phase19-probe/` and run the
 * child process against a **temporary vitest config** whose `resolve.alias` redirects
 * `@/core/assistance/types` and `@/core/assistance/assistanceEngine` to those copies. Nothing in
 * `src/` or `tests/` is ever written, so there is no cross-suite window at all - which is
 * strictly safer than the in-place mutation it replaces.
 *
 * ## Every probe restores and verifies
 *
 * A probe that leaves the world changed is worse than a probe that fails. Each one verifies
 * the child process left no residue, the git working tree is unchanged, and the three cutover
 * flag gates are byte-identical to `HEAD`. P13 and P14 are those checks, and they are probes in
 * their own right.
 *
 * ## A probe that cannot fail is reported, not hidden
 *
 * If a mutation turns out not to break its gate, the probe fails **with the reason** - anchor
 * missing, mutation a no-op, control already red - rather than recording a pass. A silently
 * ineffective probe reads exactly like a working one.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SCRATCH = '/tmp/opencode/phase19-probe';
const MUTATED = join(SCRATCH, 'mutated');
const PROBE_CONFIG = join(SCRATCH, 'probe.vitest.config.ts');

/** The two modules a behavioural probe may mutate. Everything else is out of scope. */
const MUTABLE = ['types.ts', 'assistanceEngine.ts'] as const;
type MutableModule = (typeof MUTABLE)[number];

/** The executable code of a source file, with comments and string literals blanked. */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function sourceOf(module: MutableModule): string {
  return readFileSync(join(REPO_ROOT, 'src', 'core', 'assistance', module), 'utf8');
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The original bytes of every mutable module, captured once at load. */
const ORIGINALS = new Map<MutableModule, string>(MUTABLE.map((name) => [name, sourceOf(name)]));

/**
 * A fresh, unmutated copy tree plus the alias config.
 *
 * Written on every probe so a previous probe's mutation cannot leak into the next one through
 * the scratch directory. That is the scratch-directory equivalent of the checksum discipline:
 * a probe run twice must produce the same result.
 */
function writeScratch(mutations: Partial<Record<MutableModule, string>>): void {
  mkdirSync(MUTATED, { recursive: true });
  for (const name of MUTABLE) {
    writeFileSync(join(MUTATED, name), mutations[name] ?? (ORIGINALS.get(name) as string));
  }
  // The `find` pattern is the **import specifier**, which has no file extension:
  // `@/core/assistance/types`, not `@/core/assistance/types.ts`. The extension-stripping regex is
  // written out as `/\.ts$/` rather than derived with a string `.replace`, because a first
  // attempt used `/\\.ts$/` - which matches a literal backslash followed by `ts`, strips nothing,
  // and leaves every pattern unmatchable. The symptom was nine probes reporting "not detected"
  // while their gates stayed green, which is indistinguishable from "the gate is not sensitive".
  const aliases = MUTABLE.map(
    (name) =>
      `      { find: /^@\\/core\\/assistance\\/${name.replace(/\.ts$/, '')}$/, replacement: '${join(MUTATED, name)}' },`,
  ).join('\n');
  writeFileSync(
    PROBE_CONFIG,
    [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      `  root: '${REPO_ROOT}',`,
      '  resolve: {',
      '    alias: [',
      aliases,
      `      { find: '@', replacement: '${REPO_ROOT}/src' },`,
      '    ],',
      '  },',
      '  test: {',
      "    include: ['tests/phase19/**/*.test.ts'],",
      "    exclude: ['**/assistanceNonVacuity.test.ts'],",
      "    environment: 'jsdom',",
      '    globals: true,',
      "    setupFiles: ['vitest.setup.ts'],",
      '  },',
      '});',
      '',
    ].join('\n'),
  );
}

interface GateRun {
  readonly failed: boolean;
  readonly output: string;
}

/**
 * Run one named test in one gate file, in a child process, against the current scratch tree.
 *
 * `--root` is pinned so the child resolves `vitest.setup.ts` and the `@` alias the same way the
 * parent does, and `--no-file-parallelism` is not needed because a single file is named.
 */
function runGate(gateFile: string, testName: string): GateRun {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        PROBE_CONFIG,
        gateFile,
        '-t',
        testName,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
    return { failed: false, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      failed: true,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
    };
  }
}

/** Every gate the probes aim at, with the single test that carries the claim. */
const GATES = {
  localeScan: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'never calls localeCompare anywhere in the assistance domain',
  },
  localeOrder: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'orders the unicode fixture by code unit even where localeCompare would reverse it',
  },
  nondeterminismScan: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'the engine directory reads no clock, no randomness, and no ambient state',
  },
  reordering: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'produces identical results when every room list is reversed',
  },
  integerScores: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'scores are integers, so no rounding can move a suggestion across a threshold',
  },
  mergeKeyOrder: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'emits a merged signal map in a stable key order regardless of input order',
  },
  signedZero: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'daysUntilDue never returns a negative zero',
  },
  cappedCounts: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'a capped count cannot push a priority past the cap',
  },
  signalCoercion: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'resolves a hostile signal map without leaking NaN or Infinity into any known key',
  },
  // The HIGH defect's behavioural gate: same state, same `nowIso`, five-plus host zones.
  //
  // This is the **only** probe in the file that can be described as covering a leak of ambient
  // state, because every other forbidden input was already banned by a static scan - and a static
  // scan cannot see that `Date.parse` *itself* reads the host's zone for an offset-less
  // date-time. The token `Date.parse` is not forbidden anywhere; what was wrong was which
  // interpretation it was left to choose.
  zoneStability: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'an offset-less stored timestamp ranks identically in every host time zone',
  },
  zoneStabilityShapes: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'every stored-timestamp shape is zone-stable, not just the one that was reported',
  },
  zoneStabilityRanked: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'the ranked bytes for a stored offset-less date are zone-stable end to end',
  },
  shapeRefusal: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'a timestamp the rule does not recognise yields no evidence rather than a host-local guess',
  },
  singleTimestampParser: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'the assistance domain parses a timestamp in exactly one function',
  },
  roomAttribution: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'a room id held by two subjects is attributed the same way whatever the array order',
  },
  scribeCoFiring: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'the two scribe-rule pairings that co-fire, co-fire on purpose and not by accident',
  },
  offMode: {
    file: 'tests/phase19/assistanceOffMode.test.ts',
    test: 'Off returns an empty list, an empty rule trace, and the right reason - over the corpus',
  },
  totalOrder: {
    file: 'tests/phase19/assistanceDeterminism.test.ts',
    test: 'is antisymmetric and irreflexive over a real corpus result',
  },
} as const satisfies Record<string, { file: string; test: string }>;

type GateName = keyof typeof GATES;

/** The keys, as a runtime array, so a `for...of` over `Object.entries` is typed. */
const GATE_NAMES = Object.keys(GATES) as GateName[];

interface ProbeResult {
  readonly id: string;
  readonly kind: 'predicate' | 'isolated-gate';
  readonly gate: string;
  readonly decision: string;
  readonly detected: boolean;
  /** Why the probe could not be evaluated. A probe with a caveat is a failure. */
  readonly caveat?: string;
}

const RESULTS: ProbeResult[] = [];

// ── Control: every gate is green before anything is mutated ──────────────────

const CONTROLS = new Map<GateName, GateRun>();

describe('control: every gate is green before a single mutation', () => {
  // Without this, a probe whose gate was already red would "detect" its mutation trivially, and
  // the ledger would report twelve detections that prove nothing. The control is run once per
  // gate in `beforeAll`, and each probe re-checks its own gate's control.
  beforeAll(() => {
    writeScratch({});
    for (const name of GATE_NAMES) {
      const gate = GATES[name];
      CONTROLS.set(name, runGate(gate.file, gate.test));
    }
  }, 600_000);

  afterAll(() => {
    // The scratch directory is removed unconditionally by default. `P19_KEEP_PROBE_SCRATCH=1`
    // leaves it behind so a failed probe's generated config and mutated copies can be inspected -
    // which is how the alias-escaping bug above was diagnosed at all, since the symptom was only
    // ever visible in the child process's output.
    if (process.env.P19_KEEP_PROBE_SCRATCH === '1') return;
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  const alreadyRed = (): GateName[] =>
    [...CONTROLS.entries()]
      .filter(([, run]) => run.failed)
      .map(([name]) => name);

  it('every gate passes against the unmutated tree', () => {
    const red = alreadyRed();
    // The output of a red gate is included, because "the gate is red" without the reason is the
    // least useful possible failure message.
    // Asserted on `red` (the array of names), not on the joined detail string. The first version
    // compared `''` - an empty join - against `[]`, which failed for a reason that had nothing to
    // do with the gates. The detail is carried in the failure *message*, where it belongs.
    const detail = red.map((name) => `${name}: ${CONTROLS.get(name)?.output ?? ''}`.slice(0, 800)).join('\n---\n');
    expect(red, `these gates were already red before any mutation:\n${detail}`).toEqual([]);
    expect(CONTROLS.size).toBe(GATE_NAMES.length);
    expect(CONTROLS.size).toBeGreaterThanOrEqual(10);
  });

  // ── Isolated-gate probes ──────────────────────────────────────────────────

  /**
   * Revert one decision in one module and require the named gate to go red.
   *
   * The mutation is applied to a `/tmp` copy and the gate runs in a child process, so `src/` is
   * never written. The `control` check is re-run per probe so a gate that went red for an
   * unrelated reason between the control and this probe is reported as such.
   */
  function isolated(input: {
    id: string;
    module: MutableModule;
    gate: GateName;
    decision: string;
    find: string;
    replace: string;
  }): void {
    it(`${input.id} ${input.decision}`, () => {
      const gate = GATES[input.gate];
      const control = CONTROLS.get(input.gate);
      const original = sourceOf(input.module);
      if (!original.includes(input.find)) {
        RESULTS.push({
          id: input.id,
          kind: 'isolated-gate',
          gate: `${gate.file} -t "${gate.test}"`,
          decision: input.decision,
          detected: false,
          caveat: 'ANCHOR NOT FOUND - the mutation could not be applied, so nothing was measured',
        });
        expect(control?.failed, `${input.id} control gate is red: ${control?.output ?? ''}`.slice(0, 400)).toBe(false);
        expect(`${input.id}: anchor not found`).toBe('anchor found');
        return;
      }
      const mutated = original.split(input.find).join(input.replace);
      if (checksum(mutated) === checksum(original)) {
        RESULTS.push({
          id: input.id,
          kind: 'isolated-gate',
          gate: `${gate.file} -t "${gate.test}"`,
          decision: input.decision,
          detected: false,
          caveat: 'MUTATION WAS A NO-OP - the replacement is identical to the original',
        });
        expect(`${input.id}: mutation was a no-op`).toBe('mutation changed the source');
        return;
      }

      writeScratch({ [input.module]: mutated });
      const run = runGate(gate.file, gate.test);
      // Restore the scratch tree immediately, before any assertion, so a failing probe cannot
      // leave a mutated module where the next probe would read it.
      writeScratch({});

      RESULTS.push({
        id: input.id,
        kind: 'isolated-gate',
        gate: `${gate.file} -t "${gate.test}"`,
        decision: input.decision,
        detected: run.failed,
      });
      expect(
        run.failed,
        `${input.id}: the gate did not go red on this mutation.\n${run.output.slice(0, 1500)}`,
      ).toBe(true);
    });
  }

  isolated({
    id: 'P05',
    module: 'assistanceEngine.ts',
    gate: 'reordering',
    decision: 'every rule sorts subjects and rooms before reading them',
    // Remove the sort from `sortedRoomIds` itself, rather than from one rule.
    //
    // The first attempt removed the sort from `archaeologistDueRoomRule` alone and was **not
    // detected** - honestly reported rather than quietly replaced. The reason is a property worth
    // keeping: that rule's candidates are per-room and de-duplicated by `(kind, targetId)`, so
    // *no* input order can change its output. The invariance is stronger than one rule's sort, and
    // that is a good property for the engine to have.
    //
    // Breaking it needs the shared helper, because `roomsSharingTags` walks `sortedRoomIds` and
    // keeps the **first** match - so an unsorted list makes the Creator cross-link depend on which
    // room the caller happened to store first.
    find: `  return [
    ...new Set(subject.rooms.map((room) => room.roomId).filter((id) => id.length > 0)),
  ].sort(compareCodeUnits);`,
    replace: `  return [
    ...new Set(subject.rooms.map((room) => room.roomId).filter((id) => id.length > 0)),
  ];`,
  });

  isolated({
    id: 'P06',
    module: 'assistanceEngine.ts',
    gate: 'integerScores',
    decision: 'priorities are integers, so rounding cannot move a suggestion across a threshold',
    // `value * 1.001`, not `value + 0.5`.
    //
    // `+ 0.5` was the first attempt and it was **not detected**, for a reason worth recording
    // because it is the kind of coincidence that makes a mutation probe look broken when it is
    // merely blind: `clampPriority` is applied **twice** per candidate (once by the rule that
    // builds the candidate, once by `rankProactiveAssistance` when it materialises it), so
    // `35 -> 35.5 -> 36.0`. The fractional part cancelled itself and the integrality gate saw a
    // whole number.
    //
    // A multiplicative perturbation survives any number of applications, so this one is visible
    // however many times the clamp runs. The double application is harmless and is left in place;
    // it is documented on `rankProactiveAssistance` rather than "cleaned up" here.
    find: '  const truncated = Math.trunc(value);\n  if (truncated < 0) return 0;',
    replace: '  const truncated = value * 1.001;\n  if (truncated < 0) return 0;',
  });

  isolated({
    id: 'P07',
    module: 'assistanceEngine.ts',
    gate: 'offMode',
    decision: 'off mode returns before any rule runs, rather than filtering afterwards',
    // The exact defect the module header claims is not what happens: run the whole rule set and
    // then throw the results away. The *visible* list is still empty, so a filter-based gate would
    // pass; only `evaluatedRuleKinds` catches it.
    find: `  if (input.mode === 'off') {
    return Object.freeze({
      mode: 'off' as AssistanceMode,
      suggestions: Object.freeze([] as AssistanceSuggestion[]),
      emptyReason: 'mode-off' as AssistanceEmptyReason,
      evaluatedRuleKinds: Object.freeze([] as AssistanceSuggestionKind[]),
    });
  }`,
    replace: `  if (input.mode === 'off') {
    const computed = rankProactiveAssistance({ ...input, mode: 'standard' });
    return Object.freeze({
      mode: 'off' as AssistanceMode,
      suggestions: Object.freeze([] as AssistanceSuggestion[]),
      emptyReason: 'mode-off' as AssistanceEmptyReason,
      evaluatedRuleKinds: computed.evaluatedRuleKinds,
    });
  }`,
  });

  isolated({
    id: 'P08',
    module: 'assistanceEngine.ts',
    gate: 'totalOrder',
    decision: 'the comparator is a total order, so sort stability is never load-bearing',
    // Remove the final tie-break, leaving a comparator that returns 0 for two suggestions sharing
    // a priority and a kind. Several `scribe.missing-section` candidates in the corpus do exactly
    // that, and their order then depends on which rule reached them first.
    find: `  const byKind = compareCodeUnits(left.kind, right.kind);
  if (byKind !== 0) return byKind;
  return compareCodeUnits(left.targetId, right.targetId);`,
    replace: `  const byKind = compareCodeUnits(left.kind, right.kind);
  if (byKind !== 0) return byKind;
  return 0;`,
  });

  isolated({
    id: 'P09',
    module: 'types.ts',
    gate: 'mergeKeyOrder',
    decision: 'unknown signal keys are sorted, so a persisted record has a stable byte order',
    find: `    .filter((key) => !(ASSISTANCE_SIGNAL_KEYS as readonly string[]).includes(key))
    .sort(compareSignalKeys);`,
    replace: `    .filter((key) => !(ASSISTANCE_SIGNAL_KEYS as readonly string[]).includes(key));`,
  });

  isolated({
    id: 'P10',
    module: 'assistanceEngine.ts',
    gate: 'cappedCounts',
    decision: 'signal-driven increments are capped, so a pathological count cannot dominate',
    // Aimed at the **cap** gate rather than the integrality gate. Removing the cap leaves every
    // priority a whole number - `clampPriority` clamps the runaway total back to `100` - so an
    // integrality assertion cannot see this revert at all. `tests/phase19/assistanceDeterminism
    // .test.ts` now has a value assertion for the cap, and this is the probe that needed it.
    find: '  const truncated = Math.trunc(count);\n  return truncated < cap ? truncated : cap;',
    replace: '  return Math.trunc(count);',
  });

  isolated({
    id: 'P11',
    module: 'assistanceEngine.ts',
    gate: 'signedZero',
    decision: 'daysUntilDue never returns -0, because Object.is(-0, 0) is false',
    find: '  return whole + 0 === 0 ? 0 : whole;',
    replace: '  return whole;',
  });

  isolated({
    id: 'P12',
    module: 'types.ts',
    gate: 'signalCoercion',
    decision: 'every stored count is coerced to a finite non-negative integer',
    find: `    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
  };`,
    replace: '    return typeof value === \'number\' ? value : 0;\n  };',
  });

  // ── Probes for the offset-less stored timestamp (the HIGH defect) ───────────

  isolated({
    id: 'P05tza',
    module: 'assistanceEngine.ts',
    gate: 'zoneStability',
    decision: 'an offset-less stored timestamp is read as UTC in every host time zone',
    // The fix, reverted to its absence: no `Z` is appended, so `Date.parse` is free to read the
    // wall clock as local. Measured under this mutation: `1` under UTC and America/New_York, `0`
    // under Asia/Kolkata, Australia/Adelaide and Pacific/Chatham.
    find: "    !dateOnly && !EXPLICIT_OFFSET_SUFFIX.test(iso) ? `${iso}Z` : iso;",
    replace: '    !dateOnly && !EXPLICIT_OFFSET_SUFFIX.test(iso) ? iso : iso;',
  });

  isolated({
    id: 'P06tza',
    module: 'assistanceEngine.ts',
    gate: 'zoneStabilityShapes',
    decision: 'every stored-timestamp shape is zone-stable, not only the reported one',
    // A narrower fix - honouring the `Z` marker but dropping the shape rule - would still leave
    // the SQL `DATETIME` case (`2026-03-17T04:00`) and the truncated-fraction case diverging.
    // Probed separately because a fix that handles only the reported string is a fix that has not
    // happened.
    find: 'const ISO_DATE_TIME_PREFIX = /^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}/;',
    replace: "const ISO_DATE_TIME_PREFIX = /^\\d{4}-\\d{2}-\\d{2}[T ]\\d{1}:\\d{1}/;",
  });

  isolated({
    id: 'P07tza',
    module: 'assistanceEngine.ts',
    gate: 'zoneStabilityRanked',
    decision: 'the ranked bytes for a stored offset-less date are zone-stable end to end',
    // The same revert as P05tza, aimed at the **output** gate rather than the helper, because
    // "the helper is right" and "the ranked list is right" are different claims and a phase whose
    // headline criterion is about the ranked list should be probed there.
    find: "    !dateOnly && !EXPLICIT_OFFSET_SUFFIX.test(iso) ? `${iso}Z` : iso;",
    replace: '    !dateOnly && !EXPLICIT_OFFSET_SUFFIX.test(iso) ? iso : iso;',
  });

  isolated({
    id: 'P08tza',
    module: 'assistanceEngine.ts',
    gate: 'shapeRefusal',
    decision: 'a non-ISO timestamp is refused rather than read through the legacy local parser',
    // Removing the shape guard lets `'March 17, 2026 04:00:00'` through to `Date.parse`, whose
    // fallback parser is host-local too. Measured pre-fix: `1` under UTC, `0` under three eastern
    // zones. This is the quieter half of the same defect, and it would survive a fix that only
    // appended `Z` to strings matching an ISO prefix.
    find: '  if (!dateOnly && !ISO_DATE_TIME_PREFIX.test(iso)) return null;',
    replace: '  // shape guard removed',
  });

  // **P09tza is a predicate probe, not an isolated-gate one, and the reason is a limitation
  // rather than a choice of convenience.** Its gate reads `src/core/assistance/` from disk - it is
  // a static scan - so redirecting `@/core/assistance/assistanceEngine` to a `/tmp` copy changes
  // nothing it looks at. An alias cannot reach a `readFileSync`. This was measured, not assumed:
  // the first version of this probe was an isolated-gate one and it reported
  // `the gate did not go red on this mutation` while the mutation was correctly applied, which
  // is exactly the indistinguishable-from-a-broken-gate failure this file exists to prevent. It is
  // declared with the other predicate probes below, next to P13 and P14, which are in the same
  // position for the same reason.
  //
  // The probe is therefore not omitted - a static-scan gate with no probe is a gate that can rot
  // silently - and P05tza already carries the same decision behaviourally, against a gate that
  // genuinely executes.

  isolated({
    id: 'P10tza',
    module: 'assistanceEngine.ts',
    gate: 'roomAttribution',
    decision: 'an ambiguous room id is attributed by code-unit-first subject id, not caller order',
    // The MEDIUM defect, reverted. `action.subjectId` flips between `subject-aaa` and
    // `subject-zzz` with the array order.
    find: `  for (const subject of [...subjects].sort((left, right) =>
    compareCodeUnits(left.subjectId, right.subjectId),
  )) {
    if (subject.rooms.some((room) => room.roomId === roomId)) return subject.subjectId;
  }`,
    replace: `  for (const subject of subjects) {
    if (subject.rooms.some((room) => room.roomId === roomId)) return subject.subjectId;
  }`,
  });

  isolated({
    id: 'P11tza',
    module: 'assistanceEngine.ts',
    gate: 'scribeCoFiring',
    decision: 'the scribe co-firing asymmetry is pinned behaviour, so changing it must be deliberate',
    // Remove `scribeRubricHintRule`'s suppression, so a room with a missing section *and* a zero
    // rubric score produces three cards instead of two. A **compiling** mutation: a first attempt
    // injected a call to a function that does not exist, which turned the gate red with a
    // TypeError and would have counted a broken probe as a detection. This one changes the
    // behaviour and nothing else, so the gate that fires is the co-firing gate rather than the
    // module loader.
    find: '      if (missingRequiredSections(room).length > 0) continue;',
    replace: '      // suppression removed: the asymmetry is gone',
  });

  // ── Predicate probes ──────────────────────────────────────────────────────

  /**
   * Revert one decision and run the gate's **scanner** over the mutated source in memory.
   *
   * Weaker than an isolated-gate run, because no gate file executes: it proves the scanner
   * matches the token it claims to forbid, not that a whole file goes red. It is the right tool
   * for the two gates whose subject *is* a source string, and the two kinds are never mixed in
   * the ledger.
   */
  function predicate(input: {
    id: string;
    module: MutableModule;
    decision: string;
    find: string;
    replace: string;
    /** The gate's scanner, as a pure predicate over the whole directory's source. */
    scan: (directory: ReadonlyMap<string, string>) => boolean;
  }): void {
    it(`${input.id} ${input.decision}`, () => {
      const original = sourceOf(input.module);
      if (!original.includes(input.find)) {
        RESULTS.push({
          id: input.id,
          kind: 'predicate',
          gate: 'the scanner itself',
          decision: input.decision,
          detected: false,
          caveat: 'ANCHOR NOT FOUND - nothing was measured',
        });
        expect(`${input.id}: anchor not found`).toBe('anchor found');
        return;
      }
      const mutated = original.split(input.find).join(input.replace);
      expect(checksum(mutated), `${input.id} mutation was a no-op`).not.toBe(checksum(original));

      const sources = new Map<string, string>(
        MUTABLE.map((name) => [name, name === input.module ? mutated : sourceOf(name)]),
      );
      const clean = input.scan(new Map(MUTABLE.map((name) => [name, sourceOf(name)])));
      const dirty = input.scan(sources);

      RESULTS.push({
        id: input.id,
        kind: 'predicate',
        gate: 'the scanner itself',
        decision: input.decision,
        detected: !dirty && clean,
      });
      // Both halves: the scanner passes on the real tree and fails on the mutated one. Without the
      // first half, "fails on the mutated tree" could just mean the scanner never passes.
      expect(clean, `${input.id}: the scanner already fails on the real tree`).toBe(true);
      expect(dirty, `${input.id}: the scanner still passed on the mutated tree`).toBe(false);
    });
  }

  /**
   * P13 lives here rather than above, and the reason is a real limitation of the isolated-gate
   * mechanism rather than a preference.
   *
   * The locale gate **reads `src/core/assistance/` from disk** - that is the whole point of a
   * static scan - so redirecting `@/core/assistance/assistanceEngine` to a `/tmp` copy changes
   * nothing it looks at. An alias cannot reach a `readFileSync`. So this decision is probed with
   * the gate's own scanner over a mutated source string, which is the strongest form available
   * and is honest about being the weaker one.
   */
  predicate({
    id: 'P13',
    module: 'assistanceEngine.ts',
    decision: 'string comparisons use code units, never localeCompare',
    find: 'if (left < right) return -1;\n  if (left > right) return 1;\n  return 0;',
    replace: 'return left.localeCompare(right);',
    scan: (sources) => {
      for (const [, source] of sources) {
        if ([...codeOnly(source).matchAll(/\.localeCompare\s*\(/g)].length > 0) return false;
        if (codeOnly(source).includes('Intl.')) return false;
        if (codeOnly(source).includes('toLocale')) return false;
        if (codeOnly(source).includes('normalize(')) return false;
      }
      return true;
    },
  });

  predicate({
    id: 'P14',
    module: 'assistanceEngine.ts',
    decision: 'no Intl anywhere, so no host locale can reach a comparison',
    find: 'const MS_PER_DAY = 86_400_000;',
    replace: "const MS_PER_DAY = 86_400_000;\nconst LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;",
    scan: (sources) => {
      for (const [, source] of sources) {
        if ([...codeOnly(source).matchAll(/\.localeCompare\s*\(/g)].length > 0) return false;
        if (codeOnly(source).includes('Intl.')) return false;
        if (codeOnly(source).includes('toLocale')) return false;
        if (codeOnly(source).includes('normalize(')) return false;
      }
      return true;
    },
  });

  predicate({
    id: 'P15',
    module: 'assistanceEngine.ts',
    decision: 'time is injected as nowIso; no ambient clock is read',
    // **The anchor moved, and the probe failed loudly rather than silently passing.**
    //
    // This probe used to anchor on `const toMs = Date.parse(toIso);` inside `daysUntilDue`. The
    // canonical-UTC fix moved every timestamp parse into `readUtcEpochMs`, so that string no
    // longer exists - and the probe reported `ANCHOR NOT FOUND - nothing was measured` and went
    // red, which is the file's stated behaviour for a probe that cannot be evaluated. That is
    // the correct outcome and it is why the anchor is quoted rather than derived: a reader who
    // changes the parser has to come here, and a stale anchor will tell them so.
    //
    // The mutation is delivered at the same single `Date.parse` call site the real implementation
    // has, so the scanner it is aimed at is the one that matters.
    find: '  const ms = Date.parse(canonical);',
    replace: '  const ms = Date.parse(canonical) + (Date.now() % 1);',
    scan: (sources) => {
      const patterns = [/\bDate\s*\.\s*now\s*\(/, /\bnew\s+Date\s*\(/, /\bMath\s*\.\s*random\s*\(/];
      for (const [, source] of sources) {
        const code = codeOnly(source);
        if (patterns.some((pattern) => pattern.test(code))) return false;
      }
      return true;
    },
  });

  predicate({
    id: 'P15b',
    module: 'assistanceEngine.ts',
    decision: 'an offset-less timestamp is read as UTC, never as host-local time',
    // The HIGH defect's own decision, probed a second time. Removing the `Z` this appends restores
    // `Date.parse`'s host-local reading, which is what made one archive rank three different ways
    // on three continents.
    //
    // This is a **predicate**, so it only proves the scanner matched a token. It is not the probe
    // that carries the claim: P05tza reverts the same decision and runs the real five-zone gate,
    // which is the stronger form and the one worth reading first. Both are kept because the
    // predicate also fails when the decision is reintroduced as a *different* implementation -
    // a second `Date.parse` that does not append `Z` anywhere - which the isolated probe cannot see.
    find: "    !dateOnly && !EXPLICIT_OFFSET_SUFFIX.test(iso) ? `${iso}Z` : iso;",
    replace: '    !dateOnly && !EXPLICIT_OFFSET_SUFFIX.test(iso) ? iso : iso;',
    scan: (sources) => {
      // Scoped to the module that owns the decision rather than to the directory: the first
      // version required *every* mutable module to mention the constant, and `types.ts` correctly
      // does not, so the probe reported "the scanner already fails on the real tree" and measured
      // nothing. A scanner that is wrong on the clean tree is a scanner that cannot detect
      // anything, so the scoping matters more than the assertion.
      //
      // The **second** version looked for `EXPLICIT_OFFSET_SUFFIX`, which the mutation leaves
      // intact on the same line, so it passed the mutated tree too - reported as "the scanner still
      // passed". So the scan is on the **raw** source, not `codeOnly`: the thing being detected is
      // a template literal, and `codeOnly` blanks literals by design.
      const engine = sources.get('assistanceEngine.ts');
      return engine !== undefined && engine.includes('${iso}Z');
    },
  });

  predicate({
    id: 'P16',
    module: 'assistanceEngine.ts',
    decision: 'no randomness, so identical state yields identical output',
    find: 'function clampPriority(value: number): number {',
    replace: 'function clampPriority(value: number): number {\n  value += Math.random();',
    scan: (sources) => {
      const patterns = [/\bMath\s*\.\s*random\s*\(/, /\bcrypto\./, /randomUUID/];
      for (const [, source] of sources) {
        const code = codeOnly(source);
        if (patterns.some((pattern) => pattern.test(code))) return false;
      }
      return true;
    },
  });

  predicate({
    id: 'P17tza',
    module: 'assistanceEngine.ts',
    decision: 'the assistance domain parses a timestamp in exactly one function',
    // A second, ad-hoc `Date.parse` in a new rule is how the host-zone reading comes back, one
    // rule at a time. This adds one and requires the count gate's scanner to fire.
    //
    // The scanner mirrors `the assistance domain parses a timestamp in exactly one function`:
    // `codeOnly` first, because the module headers *name* `Date.parse` repeatedly while explaining
    // why it cannot be trusted on its own, and a naive scan would report the prose as a second
    // call site.
    find: "const EXPLICIT_OFFSET_SUFFIX = /(?:[Zz]|[+-]\\d{2}:?\\d{2}|[+-]\\d{2})$/;",
    replace:
      "const EXPLICIT_OFFSET_SUFFIX = /(?:[Zz]|[+-]\\d{2}:?\\d{2}|[+-]\\d{2})$/;\n" +
      'const ELSEWHERE_MS = Date.parse(\'2026-01-01T00:00:00Z\');',
    scan: (sources) => {
      let total = 0;
      for (const [, source] of sources) {
        total += [...codeOnly(source).matchAll(/Date\s*\.\s*parse\s*\(/g)].length;
      }
      // One call in the whole directory, and it is beside the declaration - the two assertions
      // the real gate makes, in the order it makes them.
      if (total !== 1) return false;
      const engine = sources.get('assistanceEngine.ts');
      return engine !== undefined && /function\s+readUtcEpochMs\b/.test(codeOnly(engine));
    },
  });

  // ── Meta probes ───────────────────────────────────────────────────────────

  it('P17 the working tree holds nothing this file wrote', () => {
    // The independent witness. The checksums prove the probe copies matched what was expected;
    // `git status` proves no *tracked or untracked* file was created or changed by the run - the
    // only thing that catches a scratch file accidentally written into the repository.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const lines = status.split('\n').filter((line) => line.trim().length > 0);
    // Every path this stage is allowed to have changed, named explicitly so anything else fails.
    // Two of these are **existing** gates this stage had to amend rather than new files, and both
    // are listed because amending a gate is a visible change rather than a silent one:
    //
    // - `tests/phase4/uiSurfaceAudit.test.tsx` - its whole-list equality on the storage-v2 seam
    //   registry was replaced by the two assertions the gate is actually named for, because a
    //   fourth dual-writing store is a legitimate registry entry.
    // - `tests/phase17/fishingPhaseInvariants.test.ts` - `dualWrite.ts` moved out of its absolute
    //   byte-identity list and into a tighter assertion that permits exactly one added union
    //   member and nothing else.
    const permitted = [
      'src/core/assistance/',
      'src/store/assistanceStore.ts',
      'src/services/persistence/v2/appRepository.ts',
      'src/services/persistence/v2/dualWrite.ts',
      'tests/phase19/',
      'tests/migrations/qaHardening.test.ts',
      'tests/phase4/uiSurfaceAudit.test.tsx',
      'tests/phase17/fishingPhaseInvariants.test.ts',
      // **This list was incomplete, and the gate was red because of it** - verified by reading the
      // residue, not by guessing: it named only the domain half of Phase 19 while the working tree
      // also held the UI, i18n, build-config and lane-script halves. A gate that is red for a
      // reason that has nothing to do with what it measures trains its reader to ignore it, which
      // is the whole failure mode this probe exists to catch, so it is completed rather than left.
      //
      // Named **exactly**, not as `src/ui/` or `vite.config.ts`-prefixes-by-luck: the property this
      // probe protects is "the probe machinery wrote nothing", and a broad prefix would let a
      // stray file under a permitted directory pass. Each entry below is another owner's Phase 19
      // work, listed so that a change there is visible here rather than silently absorbed.
      'package.json',
      'vite.config.ts',
      'src/application/bootstrap.ts',
      'src/i18n/locales/en.json',
      'src/i18n/locales/es.json',
      'src/ui/assistance/',
      'src/ui/components/SettingsModal.tsx',
      'src/ui/screens/VillageScreen.tsx',
      'src/ui/screens/useVillageFishing.tsx',
      'src/ui/study/creator/CreatorWorkspace.tsx',
      'src/ui/study/review/ArchaeologistWorkspace.tsx',
      'src/ui/study/scribe/ScribeEncounter.tsx',
      'tests/e2e/assistance-build-lane.test.ts',
      'tests/unit/assistanceBootstrapWiring.test.ts',
      'tests/unit/assistanceEngine.determinismDefects.test.ts',
      'tests/unit/assistanceEngine.test.ts',
    ];
    const unexpected = lines.filter((line) => !permitted.some((prefix) => line.slice(3).trim().startsWith(prefix)));
    expect(unexpected, `git status residue:\n${lines.join('\n')}`).toEqual([]);
    // And the scratch directory is outside the repository.
    expect(SCRATCH.startsWith('/tmp/opencode/')).toBe(true);
    expect(SCRATCH.startsWith(REPO_ROOT)).toBe(false);
  });

  it('P18 the three cutover-flag gates are byte-identical to HEAD', () => {
    // The orchestrator's standing constraint: `adaptiveAssistance` is registered, is a cutover
    // flag, and `NON_CUTOVER_FLAG_KEYS` must remain exactly `['audioEnabled']`. Asserted against
    // `HEAD` rather than against a literal, so an edit to either file fails here whether it was
    // this stage's doing or not.
    for (const path of ['src/config/featureFlags.ts', 'src/config/runtimeConfig.ts']) {
      const onDisk = checksum(readFileSync(join(REPO_ROOT, path), 'utf8'));
      const atHead = checksum(
        execFileSync('git', ['show', `HEAD:${path}`], { cwd: REPO_ROOT, encoding: 'utf8' }),
      );
      expect(onDisk, `${path} was modified`).toBe(atHead);
    }
    // And the list itself, read from the module, is exactly the one value.
    const source = readFileSync(join(REPO_ROOT, 'src/config/featureFlags.ts'), 'utf8');
    // Sliced to the `Object.freeze([` **call**, not to the first `]` - which lands inside the
    // `readonly RuntimeConfigKey[]` annotation and yields a slice that never reaches the value.
    const start = source.indexOf('export const NON_CUTOVER_FLAG_KEYS');
    const valueStart = source.indexOf('[', source.indexOf('Object.freeze', start));
    const valueEnd = source.indexOf(']', valueStart);
    expect(valueStart, 'NON_CUTOVER_FLAG_KEYS has no Object.freeze array').toBeGreaterThan(start);
    const declaration = source.slice(valueStart, valueEnd + 1);
    expect(declaration).toContain("'audioEnabled'");
    expect(declaration).not.toContain('adaptiveAssistance');
  });
});

describe('probe ledger', () => {
  it('every probe reported a detection, and the ledger is complete', () => {
    // The closing anti-tautology gate. If a probe never ran, or reported `detected: false`, or
    // reported a caveat, this fails with the probe id - so the *probe* is what gets fixed rather
    // than the assertion being relaxed.
    const expected = [
      'P05',
      'P05tza',
      'P06',
      'P06tza',
      'P07',
      'P07tza',
      'P08',
      'P08tza',
      'P09',
      'P10',
      'P10tza',
      'P11',
      'P11tza',
      'P12',
      'P13',
      'P14',
      'P15',
      'P15b',
      'P16',
      'P17tza',
    ];
    // Read as: fourteen isolated-gate probes and six predicate probes. Stated so a reader does not
    // have to count, and so a probe silently changing kind fails here.
    //
    // The `tza` probes are the eight added for the offset-less-timestamp defects (HIGH), the
    // caller-order attribution defect (MEDIUM), and the unpinned scribe co-firing rule (LOW).
    // They are named with a suffix rather than renumbered so a report can cite `P05` and mean the
    // same thing it meant before this fix - a probe id is evidence, and renumbering evidence
    // between reports would break exactly the traceability the ledger exists to provide.
    expect(RESULTS.map((entry) => entry.id).sort()).toEqual(expected);
    const ineffective = RESULTS.filter((entry) => !entry.detected).map(
      (entry) => `${entry.id} (${entry.kind}, gate: ${entry.gate}): ${entry.caveat ?? 'NOT DETECTED'}`,
    );
    expect(ineffective, 'probes that did not show their gate is sensitive').toEqual([]);
    // Both kinds are represented, and the distinction is recorded rather than blurred.
    expect(new Set(RESULTS.map((entry) => entry.kind))).toEqual(new Set(['isolated-gate', 'predicate']));
    // Sorted, because these two assertions are about **which** probes are of each kind and not
    // about the order they happened to be declared in. They read as declaration order before the
    // `tza` probes were added, and declaration order coincided with sorted order only because the
    // original ids were already ascending - so the assertion was passing for a reason that had
    // nothing to do with what it claimed to check. That is the same class of mistake this phase
    // found twice in prose, and it was only visible once the ids stopped being consecutive.
    expect(
      RESULTS.filter((entry) => entry.kind === 'isolated-gate')
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([
      'P05',
      'P05tza',
      'P06',
      'P06tza',
      'P07',
      'P07tza',
      'P08',
      'P08tza',
      'P09',
      'P10',
      'P10tza',
      'P11',
      'P11tza',
      'P12',
    ]);
    expect(
      RESULTS.filter((entry) => entry.kind === 'predicate')
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['P13', 'P14', 'P15', 'P15b', 'P16', 'P17tza']);
    expect(RESULTS.every((entry) => entry.decision.length > 20)).toBe(true);
  });
});

/** The ledger, for a report. */
export function probeLedger(): readonly ProbeResult[] {
  return RESULTS;
}

/** True when a path is inside the probe scratch directory. Never true for repository paths. */
export function isProbeScratch(path: string): boolean {
  return path.startsWith(SCRATCH);
}

/** Exported so a report can assert the scratch directory was cleaned up. */
export function probeScratchExists(): boolean {
  return existsSync(SCRATCH);
}
