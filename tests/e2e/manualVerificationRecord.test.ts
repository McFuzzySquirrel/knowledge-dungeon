/**
 * Phase 21 **manual verification record** gate.
 *
 * ## What this file is
 *
 * Five manual gates in `PHYSICAL_DEVICE_GATES` cannot be discharged from a Linux container: no
 * Chromebook, no tablet, no touch hardware, no ChromeVox, no TalkBack, no VoiceOver, no released
 * Safari, no installed Edge. The phase's deliverable list nonetheless names a "Screen-reader
 * verification record" and "Keyboard and touch interaction scripts", and its scope requires that real
 * Safari, Edge, ChromeVox and touch-screen-reader evidence be recorded **separately** from automated
 * Playwright evidence.
 *
 * So the deliverable this gate protects is not the evidence - which nobody can produce here - it is
 * the **apparatus**: the written procedure, the fixed result shape, the validator, and the guarantee
 * that a record claiming `physical-device-manual` for an emulated or automated cell is *rejected*.
 *
 * ## The properties asserted, and why each is the one that matters
 *
 * 1. **The shipped record is valid, and all five gates read `UNVERIFIED`.** The default state has to be
 *    a record every reader can see the state of, rather than a missing file whose absence someone has
 *    to infer.
 * 2. **`physical-device-manual` is the only evidence class a record entry may carry**, and the
 *    constant is checked against the matrix's own `EVIDENCE_CLASSES`. If the constant were merely
 *    *named* that, without being a member, the restriction would be a rename.
 * 3. **The CLI validator and the TypeScript validator agree**, constant by constant. They are two
 *    implementations of one set of rules - `scripts/check-manual-verification.mjs` is plain ESM run by
 *    `node`, which cannot load a TypeScript module - and the duplication is bounded by this gate. It
 *    does **not** compare the prose of the rules; it compares the constants the rules read and then
 *    drives the CLI's validator end to end, so the rule that actually matters (below) is exercised
 *    rather than described.
 * 4. **The CLI validator goes red on a malformed record.** Named cases, each asserting the message.
 * 5. **The CLI validator goes red on a misleading one** - a record that tries to discharge a manual
 *    gate *from an emulated Playwright cell*, which is the specific promotion this whole apparatus
 *    exists to prevent. And the mirror image: the **same** record with the citation removed is valid,
 *    so the rule discriminates rather than rejecting everything.
 * 6. **Every checklist step in the TypeScript module appears in the procedure document**, and the
 *    document names all five gates. A procedure whose steps have drifted out of the module is a
 *    procedure nobody can run, and the failure mode is silent.
 * 7. **The runner still refuses to claim what it cannot measure**, and the runner's relay - the
 *    fix that makes a red run readable - does not cost a green run anything.
 *
 * ## Hermeticity
 *
 * Reads repository files, imports two pure modules, and spawns `node` on a script that reads one JSON
 * file. No browser, no build, no network, no `dist/`, no learner data. The only subprocess runs are
 * the validator against fixtures written under `artifacts/`, which is gitignored - and which exists
 * inside the repository because a fixture in the system temp directory cannot resolve the script's own
 * imports, the same measurement `tests/phase21/infraA11ySuite.test.ts` records.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTOMATED_CELL_EVIDENCE_CLASSES,
  dischargeSummary,
  emptyRecord,
  KEYBOARD_LEARNING_PATH,
  MANUAL_CHECKLIST,
  MANUAL_CLAIM_BOUNDARY,
  MANUAL_DEVICE_KINDS,
  MANUAL_EVIDENCE_CLASS,
  MANUAL_GATE_IDS,
  MANUAL_RECORD_SCHEMA_VERSION,
  MANUAL_VERDICTS,
  validateRecord,
  verdictLines,
  WORLD_DOM_MIRROR_WALKTHROUGHS,
  type ManualRecordEntry,
} from './manual-verification';
import { EVIDENCE_CLASSES, PHYSICAL_DEVICE_GATES, SUPPORT_MATRIX } from './support-matrix';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VALIDATOR_PATH = path.join(REPO_ROOT, 'scripts/check-manual-verification.mjs');
const RECORD_PATH = path.join(REPO_ROOT, 'tests/e2e/manual-verification-record.json');
const PROCEDURE_PATH = path.join(REPO_ROOT, 'tests/e2e/PHASE21-MANUAL-VERIFICATION.md');
const RUNNER_PATH = path.join(REPO_ROOT, 'scripts/run-a11y-audit.mjs');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'artifacts/manual-verification-proof');

const validatorSource = readFileSync(VALIDATOR_PATH, 'utf8');
const procedureSource = readFileSync(PROCEDURE_PATH, 'utf8');
const runnerSource = readFileSync(RUNNER_PATH, 'utf8');
const shippedRecord = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as unknown;

/**
 * The mirrored constants, read out of the script's source and parsed.
 *
 * Parsed from text rather than imported, for the same reason `infraA11ySuite.test.ts` parses the
 * runner's `CELLS`: the script's side effects must not run inside `npm test`. Every one of these
 * declarations is a plain literal, so the comparison below is a real one rather than a substring
 * match - and a substring match is exactly the kind of assertion that keeps passing after the thing
 * it was written about has been renamed.
 */
function mirroredConstant(name: string): unknown {
  // `=\s*` rather than `= ` because a multi-line declaration puts the newline after the equals sign,
  // and a reader who has to know that to keep this assertion working would eventually stop bothering.
  const match = new RegExp(`const ${name} =\\s*([^;]+);`).exec(validatorSource);
  if (match === null) {
    throw new Error(`check-manual-verification.mjs no longer declares ${name} as a plain literal.`);
  }
  return new Function(`return ${match[1].trim().replace(/;$/, '')};`)();
}

/** Run the CLI validator and return its status, stdout and stderr. Never throws. */
function runValidator(recordPath: string): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [VALIDATOR_PATH, `--record=${recordPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

/** Write a fixture record under `artifacts/` and return its absolute path. */
function writeFixture(name: string, record: unknown): string {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const target = path.join(FIXTURE_ROOT, `${name}.json`);
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return target;
}

/** A cloned shipped record, so a fixture changes exactly one thing and says which. */
function cloneShipped(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(shippedRecord)) as Record<string, unknown>;
}

/** A complete, valid hardware attestation. Every field the validator requires, none of them optional. */
const ATTESTATION = Object.freeze({
  device: 'android-tablet',
  deviceModel: 'generic Android tablet',
  operatingSystem: 'Android 13',
  browser: 'Chrome 118.0.5993.111',
  assistiveTechnology: 'TalkBack',
  assistiveTechnologyVersion: '13.4',
  operator: 'phase-21 gate fixture',
  performedOn: '2026-10-06',
  artifactRef: 'artifacts/web-artifact-manifest.json',
});

describe('the manual verification record exists, is valid, and claims nothing', () => {
  it('the shipped record passes the validator that defines its own schema', () => {
    expect(validateRecord(shippedRecord)).toEqual([]);
  });

  it('all five gates read UNVERIFIED, which is the default and an absence rather than a pass', () => {
    // The single most important assertion in this file: the record this repository ships must not
    // claim a hardware observation nobody made. A record that arrived green on all five would be the
    // exact overstatement the whole Phase 21 apparatus exists to prevent, and it would be invisible in
    // every other report.
    const entries = (shippedRecord as { entries: readonly ManualRecordEntry[] }).entries;
    expect(entries.map((entry) => entry.gateId).sort()).toEqual([...MANUAL_GATE_IDS].sort());
    for (const entry of entries) {
      expect(entry.verdict, entry.gateId).toBe('unverified');
      expect(entry.evidence, entry.gateId).toBeNull();
      expect(entry.observations, entry.gateId).toEqual([]);
      expect(entry.notDerivedFrom, entry.gateId).toEqual([]);
    }
    expect(dischargeSummary((shippedRecord as never))).toEqual({
      discharged: 0,
      total: MANUAL_GATE_IDS.length,
      complete: false,
    });
  });

  it('records the claim boundary verbatim, so it cannot be trimmed per record', () => {
    expect((shippedRecord as { claimBoundary: string }).claimBoundary).toBe(MANUAL_CLAIM_BOUNDARY);
    // And the boundary itself has to say the things a reader needs, in words a test can check.
    expect(MANUAL_CLAIM_BOUNDARY).toMatch(/not a WCAG conformance claim/i);
    expect(MANUAL_CLAIM_BOUNDARY).toMatch(/not a statement about any browser, device or operating-system version nobody tested/i);
  });

  it('prints one line per gate, and the lines name the evidence class', () => {
    const lines = verdictLines(shippedRecord as never);
    expect(lines).toHaveLength(MANUAL_GATE_IDS.length);
    for (const [index, line] of lines.entries()) {
      expect(line, MANUAL_GATE_IDS[index]).toContain(MANUAL_GATE_IDS[index]);
      expect(line, MANUAL_GATE_IDS[index]).toContain('UNVERIFIED');
      expect(line, MANUAL_GATE_IDS[index]).toContain(MANUAL_EVIDENCE_CLASS);
    }
  });

  it('an empty record is the same fact as the shipped one, and it validates', () => {
    expect(validateRecord(emptyRecord())).toEqual([]);
    expect(emptyRecord().entries.map((entry) => entry.verdict)).toEqual(
      MANUAL_GATE_IDS.map(() => 'unverified'),
    );
  });
});

describe('the evidence class is restricted, not merely named', () => {
  it('physical-device-manual is a real member of the matrix vocabulary', () => {
    // Without this the restriction would be a rename: a constant asserting a value the matrix does
    // not define would make the validator admit something the matrix never contemplated.
    expect(EVIDENCE_CLASSES).toContain(MANUAL_EVIDENCE_CLASS);
    expect(MANUAL_EVIDENCE_CLASS).toBe('physical-device-manual');
  });

  it('every other evidence class is an automated one, and none is admissible to a record', () => {
    expect([...AUTOMATED_CELL_EVIDENCE_CLASSES].sort()).toEqual(
      EVIDENCE_CLASSES.filter((value) => value !== MANUAL_EVIDENCE_CLASS).slice().sort(),
    );
    // The three automated classes, named. If a fourth automated class ever appears, this is the
    // assertion that notices before a record starts admitting it.
    expect([...AUTOMATED_CELL_EVIDENCE_CLASSES].sort()).toEqual([
      'branded-channel-automation',
      'emulated-viewport',
      'engine-automation',
    ]);
  });

  it('the matrix still claims no manual evidence, which is what the record restriction rests on', () => {
    expect(SUPPORT_MATRIX.some((entry) => entry.evidenceClass === MANUAL_EVIDENCE_CLASS)).toBe(false);
  });

  it('a record entry carrying an automated class is rejected, by the module and by the CLI', () => {
    const record = cloneShipped();
    (record.entries as unknown[])[0] = {
      ...((record.entries as unknown[])[0] as Record<string, unknown>),
      evidenceClass: 'emulated-viewport',
    };
    const problems = validateRecord(record);
    expect(problems.join('\n')).toMatch(/may carry only "physical-device-manual"/);
    expect(problems.join('\n')).toMatch(/how an emulated viewport becomes a device check/);

    const run = runValidator(writeFixture('automated-evidence-class', record));
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('may carry only "physical-device-manual"');
  });

  it('the record device vocabulary cannot be satisfied by a matrix form factor', () => {
    // `chromebook` is the one word both vocabularies need, and it means different things on each side:
    // in `SUPPORT_MATRIX` it is a 1366x768 Playwright project with `evidenceClass:
    // emulated-viewport`, and in a record it is a ChromeOS device in a learner's hands. Asserting the
    // two sets are disjoint would be asserting something false and would have "passed" only because
    // nobody checked whether it was true.
    const formFactors = SUPPORT_MATRIX.map((entry) => entry.formFactor);
    expect([...MANUAL_DEVICE_KINDS].sort()).toEqual(
      [
        'android-tablet',
        'chromebook',
        'ios-tablet',
        'linux-laptop',
        'macos-laptop',
        'windows-laptop',
      ].sort(),
    );
    // The tablets are the ones that must not be interchangeable: `tablet-portrait` is an 834x1112
    // window, and no record may be satisfied by naming it.
    for (const kind of MANUAL_DEVICE_KINDS.filter((value) => value.endsWith('-tablet'))) {
      expect(formFactors, `${kind} must not be a matrix form factor`).not.toContain(kind);
    }
    // The matrix's own tablet emulations exist and stay named as they are.
    expect(formFactors).toContain('tablet-portrait');
    expect(formFactors).toContain('tablet-landscape');
    // And the shared word cannot be the *only* thing a record carries: a discharge also needs the model,
    // the OS version and the browser version, none of which a Playwright project has.
    expect(Object.keys(ATTESTATION)).toEqual(
      expect.arrayContaining(['deviceModel', 'operatingSystem', 'browser']),
    );
  });
});

describe('a discharge requires a complete, attributed, dated attestation', () => {
  it('a discharged gate with no evidence is rejected, naming what is missing', () => {
    const record = cloneShipped();
    (record.entries as unknown[])[0] = {
      ...((record.entries as unknown[])[0] as Record<string, unknown>),
      verdict: 'discharged',
    };
    const problems = validateRecord(record);
    expect(problems.join('\n')).toMatch(/marked "discharged" with no hardware attestation/);
    expect(problems.join('\n')).toMatch(/device model, an operating-system version, a browser version/);
  });

  it('a discharge with one field missing is still rejected, field by field', () => {
    // One missing field at a time, because "the validator wants an object" is a weaker guarantee than
    // "the validator wants *these nine fields*", and a partial attestation is the realistic failure:
    // somebody who typed eight of them and forgot the date.
    for (const field of Object.keys(ATTESTATION)) {
      const evidence: Record<string, unknown> = { ...ATTESTATION };
      delete evidence[field];
      const record = cloneShipped();
      (record.entries as unknown[])[0] = {
        ...((record.entries as unknown[])[0] as Record<string, unknown>),
        verdict: 'discharged',
        evidence,
      };
      expect(validateRecord(record).join('\n'), `omitting ${field}`).toMatch(
        new RegExp(`evidence\\.${field}`),
      );
    }
  });

  it('a complete attestation is accepted, so the gate is not simply refusing everything', () => {
    const record = cloneShipped();
    (record.entries as unknown[])[0] = {
      ...((record.entries as unknown[])[0] as Record<string, unknown>),
      verdict: 'discharged',
      evidence: { ...ATTESTATION, device: 'chromebook', assistiveTechnology: 'ChromeVox' },
      observations: [{ stepId: 'cb-02', note: 'Fourteen named stops.', outcome: 'met' }],
    };
    expect(validateRecord(record)).toEqual([]);
    const run = runValidator(writeFixture('valid-discharge', record));
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('1/5 discharged');
    expect(run.output).toContain('does not discharge the phase');
  });

  it('rejects a malformed date, an unknown device class, and an unknown evidence key', () => {
    const withDate = {
      ...ATTESTATION,
      performedOn: 'the sixth of October',
    };
    const withDevice = { ...ATTESTATION, device: 'ipad' };
    const withKey = { ...ATTESTATION, serialNumber: 'XB-1234' };

    for (const [label, evidence] of Object.entries({ withDate, withDevice, withKey })) {
      const record = cloneShipped();
      (record.entries as unknown[])[0] = {
        ...((record.entries as unknown[])[0] as Record<string, unknown>),
        verdict: 'discharged',
        evidence,
      };
      const problems = validateRecord(record).join('\n');
      expect(problems, label).not.toBe('');
    }
    expect(validateRecord(cloneShippedWithEvidence(withKey)).join('\n')).toMatch(
      /unknown key "serialNumber"/,
    );
  });

  it('a refused or blocked gate must say why', () => {
    for (const verdict of ['refused', 'blocked'] as const) {
      const record = cloneShipped();
      (record.entries as unknown[])[0] = {
        ...((record.entries as unknown[])[0] as Record<string, unknown>),
        verdict,
        note: '',
      };
      expect(validateRecord(record).join('\n'), verdict).toMatch(/empty note/);
    }
  });

  it('every verdict is from the declared vocabulary', () => {
    expect([...MANUAL_VERDICTS]).toEqual(['unverified', 'discharged', 'refused', 'blocked']);
    const record = cloneShipped();
    (record.entries as unknown[])[0] = {
      ...((record.entries as unknown[])[0] as Record<string, unknown>),
      verdict: 'passed',
    };
    expect(validateRecord(record).join('\n')).toMatch(/must be one of unverified, discharged, refused, blocked/);
  });
});

/** A cloned shipped record whose first entry carries the given evidence. */
function cloneShippedWithEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const record = cloneShipped();
  (record.entries as unknown[])[0] = {
    ...((record.entries as unknown[])[0] as Record<string, unknown>),
    verdict: 'discharged',
    evidence,
  };
  return record;
}

describe('no manual gate can be derived from an automated cell - the promotion rule', () => {
  /** A complete, well-formed entry that also names automated cells as its source. */
  function misleadingRecord(): Record<string, unknown> {
    const record = cloneShipped();
    (record.entries as unknown[])[2] = {
      ...((record.entries as unknown[])[2] as Record<string, unknown>),
      verdict: 'discharged',
      evidence: { ...ATTESTATION },
      notDerivedFrom: ['tablet', 'tablet-landscape'],
      observations: [{ stepId: 'touch-02', note: 'Drawer toggle announced.', outcome: 'met' }],
      note: '',
    };
    return record;
  }

  it('the tablet gate, discharged by an emulated Playwright cell, is rejected - exit 1 and the reason', () => {
    // The precise deception this apparatus exists to prevent: the `tablet` Playwright project passes,
    // its viewport is 834x1112, and a hurried reader promotes that to "we tested a tablet". The record
    // has to *refuse* the promotion, not merely discourage it in prose.
    const record = misleadingRecord();
    const problems = validateRecord(record).join('\n');
    expect(problems).toMatch(/names automated cell "tablet" \(emulated-viewport\)/);
    expect(problems).toMatch(/A manual gate cannot be derived from an automated cell/);
    expect(problems).toMatch(/belongs in the runner's report, not here/);

    const run = runValidator(writeFixture('promotion-from-emulated-cell', record));
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('names automated cell "tablet" (emulated-viewport)');
    expect(run.output).toContain('A manual gate cannot be derived from an automated cell');
  });

  it('all eight matrix projects are rejected as a source, each naming its own evidence class', () => {
    // Every one, not just the emulated ones. `compat-webkit` is `engine-automation` and `compat-edge`
    // is `branded-channel-automation`; neither is a Safari or an Edge release, and a record must not be
    // able to say it is.
    for (const entry of SUPPORT_MATRIX) {
      expect(entry.evidenceClass, entry.project).not.toBe(MANUAL_EVIDENCE_CLASS);
      const record = cloneShipped();
      (record.entries as unknown[])[0] = {
        ...((record.entries as unknown[])[0] as Record<string, unknown>),
        notDerivedFrom: [entry.project],
      };
      expect(validateRecord(record).join('\n'), entry.project).toMatch(
        new RegExp(`names automated cell "${entry.project}" \\(${entry.evidenceClass}\\)`),
      );
    }
  });

  it('the SAME record without the automated citation is valid, so the rule discriminates', () => {
    // The mirror image, and the reason the previous test is meaningful: a validator that rejected
    // everything would also reject this. Two records differing in exactly one field - the citation -
    // and opposite verdicts, is what makes the rule a rule rather than a wall.
    const cited = misleadingRecord();
    const uncited = misleadingRecord();
    (uncited.entries as unknown[])[2] = {
      ...((uncited.entries as unknown[])[2] as Record<string, unknown>),
      notDerivedFrom: [],
    };
    expect(validateRecord(cited).length).toBeGreaterThan(0);
    expect(validateRecord(uncited)).toEqual([]);
    expect(runValidator(writeFixture('genuine-manual-record', uncited)).status).toBe(0);
    expect(runValidator(writeFixture('cited-manual-record', cited)).status).toBe(1);
  });

  it('the runner never emits a manual evidence class either, and the two gates agree', () => {
    // The record restriction is only half the answer. The other half is that the automated report still
    // cannot be the source of one, and `infraA11ySuite.test.ts` already asserts that of the cell
    // plan. Asserted here too so that removing either assertion is visible in this file as well.
    const a11yEvidenceDir = path.join(REPO_ROOT, 'artifacts/compatibility-evidence');
    expect(SUPPORT_MATRIX.map((entry) => entry.evidenceClass)).not.toContain(MANUAL_EVIDENCE_CLASS);
    expect(runnerSource).toContain("physical-device-manual is not among them");
    expect(path.basename(a11yEvidenceDir)).toBe('compatibility-evidence');
  });
});

describe('a malformed record is rejected, by the module and by the CLI', () => {
  const namedCases: readonly { name: string; mutate: (record: Record<string, unknown>) => void; pattern: RegExp }[] = [
    {
      name: 'unknown top-level key',
      mutate: (record) => {
        record.learnerNotes = 'a subject name that must not be filable here';
      },
      pattern: /unknown top-level key "learnerNotes"/,
    },
    {
      name: 'wrong schema version',
      mutate: (record) => {
        record.schemaVersion = 99;
      },
      pattern: /schemaVersion must be 1/,
    },
    {
      name: 'trimmed claim boundary',
      mutate: (record) => {
        record.claimBoundary = 'Passed.';
      },
      pattern: /claimBoundary must be the MANUAL_CLAIM_BOUNDARY text, verbatim/,
    },
    {
      name: 'invented gate',
      mutate: (record) => {
        (record.entries as unknown[])[0] = {
          ...((record.entries as unknown[])[0] as Record<string, unknown>),
          gateId: 'physical-iphone-16-pro-max',
        };
      },
      pattern: /is not one of the 5 gates this phase declared/,
    },
    {
      name: 'a gate omitted entirely',
      mutate: (record) => {
        record.entries = (record.entries as unknown[]).slice(0, 4);
      },
      pattern: /no entry for declared gate "physical-linux-desktop-browser"/,
    },
    {
      name: 'a repeated gate',
      mutate: (record) => {
        const entries = record.entries as unknown[];
        entries[1] = { ...(entries[0] as Record<string, unknown>) };
      },
      pattern: /repeats gate/,
    },
    {
      name: 'an observation of an undeclared step',
      mutate: (record) => {
        (record.entries as unknown[])[0] = {
          ...((record.entries as unknown[])[0] as Record<string, unknown>),
          observations: [{ stepId: 'cb-99', note: 'invented step', outcome: 'met' }],
        };
      },
      pattern: /not a step of the "physical-chromebook-screen-reader" checklist/,
    },
    {
      name: 'an observation of another gate\'s step',
      mutate: (record) => {
        (record.entries as unknown[])[0] = {
          ...((record.entries as unknown[])[0] as Record<string, unknown>),
          observations: [{ stepId: 'safari-01', note: 'wrong gate', outcome: 'met' }],
        };
      },
      pattern: /not a step of the "physical-chromebook-screen-reader" checklist/,
    },
    {
      name: 'a malformed outcome value',
      mutate: (record) => {
        (record.entries as unknown[])[0] = {
          ...((record.entries as unknown[])[0] as Record<string, unknown>),
          observations: [{ stepId: 'cb-01', note: 'x', outcome: 'fine' }],
        };
      },
      pattern: /outcome must be "met", "not-met" or "not-run"/,
    },
    {
      name: 'an unbounded observation note',
      mutate: (record) => {
        (record.entries as unknown[])[0] = {
          ...((record.entries as unknown[])[0] as Record<string, unknown>),
          observations: [{ stepId: 'cb-01', note: 'x'.repeat(4_000), outcome: 'met' }],
        };
      },
      pattern: /is 4000 characters; the limit is 300/,
    },
  ];

  for (const { name, mutate, pattern } of namedCases) {
    it(`rejects ${name}`, () => {
      const record = cloneShipped();
      mutate(record);
      expect(validateRecord(record).join('\n'), name).toMatch(pattern);

      const run = runValidator(writeFixture(`malformed-${name.replace(/\W+/g, '-')}`, record));
      expect(run.status, `${name}: ${run.output}`).toBe(1);
      expect(run.output, name).toMatch(pattern);
    });
  }

  it('rejects a non-object and an unparseable file with the usage status, not the validation status', () => {
    // Two different failures, two different statuses. A missing or unparseable file is the operator's
    // invocation being wrong (exit 2); a well-formed file that breaks the schema is the record being
    // wrong (exit 1). Collapsing them would make "you passed the wrong path" read as "your record is
    // invalid", which sends a person looking in the wrong place.
    const notAnObject = writeFixture('not-an-object', ['not', 'a', 'record']);
    expect(runValidator(notAnObject).status).toBe(1);

    const missing = path.join(FIXTURE_ROOT, 'does-not-exist.json');
    expect(runValidator(missing).status).toBe(2);

    const unparseable = path.join(FIXTURE_ROOT, 'unparseable.json');
    mkdirSync(FIXTURE_ROOT, { recursive: true });
    writeFileSync(unparseable, '{ "entries": [', 'utf8');
    const run = runValidator(unparseable);
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain('not valid JSON');
  });

  it('every problem is reported at once, so one pass tells a person everything', () => {
    // A validator that stops at the first problem makes a malformed record take several edits to fix.
    // Asserted on the output text rather than on an internal call count, because the number of
    // messages is the thing a person reads.
    const record = cloneShipped();
    record.schemaVersion = 99;
    (record.entries as unknown[])[0] = {
      ...((record.entries as unknown[])[0] as Record<string, unknown>),
      verdict: 'discharged',
      evidenceClass: 'emulated-viewport',
      notDerivedFrom: ['tablet'],
    };
    const output = runValidator(writeFixture('several-problems', record)).output;
    expect(output).toMatch(/schemaVersion must be 1/);
    expect(output).toMatch(/may carry only "physical-device-manual"/);
    expect(output).toMatch(/no hardware attestation/);
    expect(output).toMatch(/names automated cell "tablet"/);
    expect(output).toMatch(/RECORD IS INVALID - [3-9] problem\(s\)/);
  });
});

describe('the checklists and the walkthroughs cover what the automated suite does not', () => {
  it('every declared gate has a checklist, and every step is fully written', () => {
    expect(Object.keys(MANUAL_CHECKLIST).sort()).toEqual([...MANUAL_GATE_IDS].sort());
    for (const gateId of MANUAL_GATE_IDS) {
      const steps = MANUAL_CHECKLIST[gateId];
      expect(steps.length, `${gateId} needs at least two observable steps`).toBeGreaterThanOrEqual(2);
      expect(new Set(steps.map((step) => step.id)).size, `${gateId} has duplicate step ids`).toBe(
        steps.length,
      );
      for (const step of steps) {
        expect(step.action.length, `${step.id} action`).toBeGreaterThan(40);
        expect(step.passCriterion.length, `${step.id} passCriterion`).toBeGreaterThan(30);
        // `countsAsFailure` is what makes the record actionable. A step that says what to do without
        // saying what a defect looks like produces an observation nobody can adjudicate later.
        expect(step.countsAsFailure.length, `${step.id} countsAsFailure`).toBeGreaterThan(20);
      }
    }
  });

  it('the touch gate checks the drawer, because that is where the product can strand a learner', () => {
    // The drawer is unmounted until its toggle is pressed, so a scan that did not open it would be
    // scanning a tablet's village with no nearby list and no way to reach Settings. The manual gate
    // exists to close that gap on real hardware, and it is checked as its own step.
    const touchSteps = MANUAL_CHECKLIST['physical-touch-platform-screen-reader'];
    const drawer = touchSteps.find((step) => step.id === 'touch-02');
    expect(drawer, 'the touch checklist must have a drawer step').toBeDefined();
    expect(drawer?.action).toMatch(/HUD drawer/);
    expect(drawer?.passCriterion).toMatch(/Village status and controls/);
    // And the three named surfaces a touch learner otherwise cannot reach, each of which is inside the
    // unmounted column until the toggle is pressed.
    for (const phrase of ['Nearby', 'Settings', /unmount/i]) {
      const haystack = `${drawer?.passCriterion} ${drawer?.action} ${drawer?.countsAsFailure}`;
      expect(typeof phrase === 'string' ? haystack.includes(phrase) : phrase.test(haystack), String(phrase)).toBe(true);
    }
  });

  it('the ChromeVox gate checks the Settings radiogroup by its own semantics', () => {
    // The phase gave Settings a real `radiogroup` with roving tabindex and removed `aria-pressed` from
    // that surface. A manual gate that did not check the arrow-key/selected-state behaviour would pass
    // on a group that is still eight tab stops.
    const steps = MANUAL_CHECKLIST['physical-chromebook-screen-reader'];
    const radio = steps.find((step) => step.id === 'cb-04');
    expect(radio).toBeDefined();
    expect(radio?.passCriterion).toMatch(/arrow press/i);
    expect(radio?.passCriterion).toMatch(/single tab stop/i);
    expect(radio?.countsAsFailure).toMatch(/separate tab stop/i);
    expect(radio?.passCriterion).toMatch(/selected/i);
    // The other half: `aria-pressed` is written nowhere on this surface, so selection must arrive as a
    // spoken checked state. A gate that only checked "does it move" would pass on a group that is
    // eight tab stops with no selection announced.
    expect(`${radio?.passCriterion} ${radio?.countsAsFailure}`).toMatch(/not-selected state|selected or not-selected/i);
  });

  it('the touch gate names the three things it must reach with the screen reader', () => {
    const steps = MANUAL_CHECKLIST['physical-touch-platform-screen-reader'];
    const body = steps.map((step) => `${step.action} ${step.passCriterion}`).join('\n');
    // The three the phase names for this gate, each with its own step: the drawer's accessible name,
    // the nearby-action list, and the share-card dialog.
    expect(body).toMatch(/Village status and controls/);
    expect(body).toMatch(/Nearby/);
    expect(body).toMatch(/share card dialog/i);
    expect(steps.some((step) => step.id === 'touch-03')).toBe(true);
    expect(steps.some((step) => step.id === 'touch-04')).toBe(true);
  });

  it('the keyboard walkthrough covers the complete learning path, in order', () => {
    const ids = KEYBOARD_LEARNING_PATH.map((step) => step.id);
    expect(ids[0]).toBe('kb-01');
    expect(new Set(ids).size).toBe(ids.length);
    expect(KEYBOARD_LEARNING_PATH.length).toBeGreaterThanOrEqual(12);

    // Every surface the phase names, named in the walkthrough itself so a reader can find the step.
    // Case-insensitively, because a walkthrough written for a human says "in the village" and the surface
    // name is "Village" - and an assertion that insisted on the capital would be testing my typography
    // rather than the coverage.
    const body = KEYBOARD_LEARNING_PATH.map((step) => step.action).join('\n');
    for (const surface of ['Welcome', 'Village', 'Creator', 'Scribe', 'Archaeologist', 'Statistics', 'Data Center', 'Settings']) {
      expect(body, `the keyboard path omits ${surface}`).toMatch(new RegExp(surface, 'i'));
    }
    expect(body).toMatch(/fish/i);
    expect(body).toMatch(/share card dialog/i);
    // And the two viewport conditions the phase's exit criteria name.
    expect(body).toMatch(/200% browser zoom/);
    expect(body).toMatch(/320 CSS-pixel/);

    for (const step of KEYBOARD_LEARNING_PATH) {
      expect(step.passCriterion.length, step.id).toBeGreaterThan(20);
      expect(step.countsAsFailure.length, step.id).toBeGreaterThan(10);
    }
  });

  it('the three worlds each have a DOM-mirror walkthrough, with a keyboard activation step', () => {
    const body = WORLD_DOM_MIRROR_WALKTHROUGHS.map((step) => `${step.id} ${step.action} ${step.passCriterion}`).join('\n');
    for (const world of ['village', 'dungeon', 'fishing']) {
      expect(body, `no DOM-mirror step for ${world}`).toMatch(new RegExp(`mirror-${world}-01`, 'i'));
    }
    // Each world needs a step that fires the action *from the mirror* and compares against the canvas;
    // a mirror that merely exists proves nothing.
    for (const world of ['village', 'dungeon', 'fishing']) {
      const activation = WORLD_DOM_MIRROR_WALKTHROUGHS.find((step) => step.id === `mirror-${world}-02`);
      expect(activation, `${world} has no activation step`).toBeDefined();
      expect(activation?.passCriterion.length ?? 0).toBeGreaterThan(20);
    }
  });

  it('every checklist step and walkthrough step appears in the written procedure', () => {
    // The document is the thing a person with hardware and no codebase knowledge actually reads. A
    // step that exists in the module but not in the document is a step nobody can run, and the
    // document drifting is exactly the failure a generated-from-data file would have prevented - so
    // this is asserted rather than generated.
    const ids = [
      ...MANUAL_GATE_IDS.flatMap((gateId) => (MANUAL_CHECKLIST[gateId] ?? []).map((step) => step.id)),
      ...KEYBOARD_LEARNING_PATH.map((step) => step.id),
      ...WORLD_DOM_MIRROR_WALKTHROUGHS.map((step) => step.id),
    ];
    expect(ids.length).toBeGreaterThan(30);
    for (const id of ids) {
      expect(procedureSource, `the procedure does not mention step ${id}`).toContain(id);
    }
    for (const gateId of MANUAL_GATE_IDS) {
      expect(procedureSource, `the procedure does not name gate ${gateId}`).toContain(gateId);
    }
  });

  it('the procedure says what to do, what to observe, and what counts as a pass', () => {
    // The brief's requirement, stated as an assertion rather than trusted. Each gate's section must
    // carry the four columns, and the document must state the evidence class and the drawer.
    expect(procedureSource).toMatch(/physical-device-manual/);
    expect(procedureSource).toMatch(/UNVERIFIED/);
    for (const heading of [
      'Gate 1 — Physical Chromebook',
      'Gate 2 — Physical tablet',
      'Gate 3 — Real macOS Safari',
      'Gate 4 — Real Windows desktop browser',
      'Gate 5 — Real Linux desktop browser',
    ]) {
      expect(procedureSource, `the procedure is missing "${heading}"`).toContain(heading);
    }
    // The drawer, in words a person can act on, and the fact that the column is unmounted.
    expect(procedureSource).toMatch(/unmounts the entire column/);
    expect(procedureSource).toMatch(/does not exist until the drawer is opened/);
    // And the build/run instructions, since a dev server is not the artifact.
    expect(procedureSource).toMatch(/npm run build:web/);
    expect(procedureSource).toMatch(/npm run record:web-artifact/);
    expect(procedureSource).toMatch(/npm run check:manual-verification/);
    // The privacy instruction.
    expect(procedureSource).toMatch(/[Dd]o not put learner data in it/);
  });
});

describe('the CLI validator and the TypeScript validator are the same rules', () => {
  it('mirrors the schema version, the evidence class, the verdicts, and the devices', () => {
    expect(mirroredConstant('MANUAL_RECORD_SCHEMA_VERSION')).toBe(MANUAL_RECORD_SCHEMA_VERSION);
    expect(mirroredConstant('MANUAL_EVIDENCE_CLASS')).toBe(MANUAL_EVIDENCE_CLASS);
    expect(mirroredConstant('MANUAL_VERDICTS')).toEqual([...MANUAL_VERDICTS]);
    expect(mirroredConstant('MANUAL_DEVICE_KINDS')).toEqual([...MANUAL_DEVICE_KINDS]);
    expect(mirroredConstant('MANUAL_CLAIM_BOUNDARY')).toBe(MANUAL_CLAIM_BOUNDARY);
  });

  it('mirrors the gate ids, in the matrix order', () => {
    expect(mirroredConstant('MANUAL_GATE_IDS')).toEqual([...MANUAL_GATE_IDS]);
    expect([...MANUAL_GATE_IDS]).toEqual(PHYSICAL_DEVICE_GATES.map((gate) => gate.id));
  });

  it('mirrors the checklist step ids, so an observation cannot pass one copy and fail the other', () => {
    // The part of the duplication that changes behaviour. If one copy knew a step the other did not,
    // an observation would be accepted by one validator and rejected by the other, and which one a
    // record was judged against would depend on which command the person happened to run.
    const mirrored = mirroredConstant('MANUAL_CHECKLIST_STEP_IDS') as Record<string, readonly string[]>;
    expect(Object.keys(mirrored).sort()).toEqual([...MANUAL_GATE_IDS].sort());
    for (const gateId of MANUAL_GATE_IDS) {
      expect([...(mirrored[gateId] ?? [])].sort(), gateId).toEqual(
        MANUAL_CHECKLIST[gateId].map((step) => step.id).sort(),
      );
    }
  });

  it('mirrors the matrix cells and their evidence classes, so the promotion rule covers all eight', () => {
    const mirrored = mirroredConstant('MATRIX_CELLS') as readonly { project: string; evidenceClass: string }[];
    expect(mirrored.map((cell) => cell.project)).toEqual(SUPPORT_MATRIX.map((entry) => entry.project));
    for (const [index, cell] of mirrored.entries()) {
      expect(cell.evidenceClass, cell.project).toBe(SUPPORT_MATRIX[index]?.evidenceClass);
    }
    expect(mirrored).toHaveLength(SUPPORT_MATRIX.length);
  });

  it('mirrors the field allowlists, so a fixed shape is fixed in both copies', () => {
    expect(mirroredConstant('ENTRY_KEYS')).toHaveLength(7);
    expect(mirroredConstant('EVIDENCE_KEYS')).toEqual(Object.keys(ATTESTATION));
    expect(mirroredConstant('RECORD_KEYS')).toHaveLength(4);
  });

  it('the CLI prints the shipped record as valid, and says the phase is not discharged', () => {
    const run = runValidator(RECORD_PATH);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('RECORD: valid.');
    expect(run.output).toContain('GATE VERDICTS (0/5 discharged)');
    expect(run.output).toContain('does not discharge the phase');
    for (const gateId of MANUAL_GATE_IDS) {
      expect(run.output, gateId).toContain(`UNVERIFIED  ${gateId}`);
    }
  });

  it('the CLI has its own exit statuses and does not collapse them', () => {
    expect(validatorSource).toMatch(/\| `2` \| usage error/);
    expect(validatorSource).toContain('process.exitCode = 2');
    expect(validatorSource).toContain('process.exitCode = problems.length === 0 ? 0 : 1');
  });
});

describe('the runner makes a red run readable, and does not spend a green run anything', () => {
  it('names its stdio choice, because the default is what hid the output', () => {
    expect(runnerSource).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    // Not inherited - that would interleave with the coverage table - and not ignored, which was the
    // defect. Both halves are named in the source so a reader can see the choice was made.
    expect(runnerSource).toMatch(/Reading a red run/);
  });

  it('takes the assertion message from the report rather than scraping prose', () => {
    expect(runnerSource).toContain('assertionFailures');
    expect(runnerSource).toContain('last?.errors ?? []');
    expect(runnerSource).toContain('redactAndBound');
  });

  it('relays only when there is something to relay, and bounds what it relays', () => {
    expect(runnerSource).toContain('ASSERTION FAILURES');
    expect(runnerSource).toMatch(/RELAY_FAILURE_LIMIT = 6/);
    expect(runnerSource).toMatch(/RELAY_FAILURE_LINE_LIMIT = 6/);
    expect(runnerSource).toMatch(/RELAY_FAILURE_CHAR_LIMIT = 400/);
    // The green path adds nothing: the relay is inside an `if`.
    expect(runnerSource).toMatch(/if \(\(run\.failures \?\? \[\]\)\.length > 0\) \{/);
  });

  it('keeps the three exit statuses and the coverage verdict exactly as they were', () => {
    // Nothing in the relay may change what the runner *decides*. These are the strings and codes the
    // existing gate asserts, re-asserted here so a change to the relay that altered a verdict would be
    // caught in this file too.
    expect(runnerSource).toContain('const EXIT_FAILED = 1;');
    expect(runnerSource).toContain('const EXIT_INCOMPLETE = 3;');
    expect(runnerSource).toContain('COVERAGE: INCOMPLETE');
    expect(runnerSource).toContain('RESULT: FAILED');
    expect(runnerSource).toContain('RESULT: INCOMPLETE');
  });

  it('puts the relay outside the evidence file, because that file is uploaded', () => {
    // The privacy rule for this runner is that the recorded block carries counts, version strings and
    // bounded category names. Assertion text is terminal output for a person standing at the run.
    expect(runnerSource).toContain('failedCells');
    const evidenceBlock = runnerSource.slice(
      runnerSource.indexOf('const evidencePath = writeEvidence({'),
      runnerSource.indexOf('if (!asJson) console.log(`Evidence:'),
    );
    expect(evidenceBlock.length).toBeGreaterThan(200);
    // Asserted on the **keys** rather than on prose: the block carries a comment explaining why the
    // text is absent, and an assertion matching the words would be failed by that explanation rather
    // than by anything the block actually records.
    expect(evidenceBlock).not.toMatch(/^\s{4}(failures|childOutput|assertionFailures):/m);
    expect(evidenceBlock).not.toMatch(/\brun\.(failures|childOutput)\b/);
  });

  it('counts a skipped test once, so the per-cell line agrees with the report', () => {
    /*
     * The defect this guards: `perProjectCounts` recorded Playwright's outcome category
     * (`bucket[testCase.status]`) *and* tallied the last result, so a skipped test was counted in
     * `skipped` twice. The per-cell line then printed `skipped 2` for a cell with one skipped test
     * while the report's own `stats.skipped` said one - a count that is wrong in exactly the way
     * this file's header says a report must not be. The real suite is what exposes it; this is the
     * cheap arithmetic check that keeps the count honest without a browser.
     *
     * The function is extracted from source rather than imported because the runner is a
     * side-effecting script - importing it would launch every browser it can find. It is the same
     * extraction pattern `infraA11ySuite.test.ts` uses for `CELLS` and this file uses for
     * `mirroredConstant`.
     */
    const start = runnerSource.indexOf('function perProjectCounts');
    expect(start, 'the runner no longer declares perProjectCounts').toBeGreaterThan(-1);
    const rest = runnerSource.slice(start);
    const nextFunction = rest.indexOf('\nfunction ', 1);
    const fnSource = nextFunction === -1 ? rest : rest.slice(0, nextFunction);
    const perProjectCounts = new Function(`${fnSource}; return perProjectCounts;`)() as (
      report: unknown,
      projectPrefix: string,
    ) => Record<string, { passed: number; failed: number; skipped: number; expected: number }>;

    const report = {
      suites: [
        {
          specs: [
            {
              title: 'a passing test',
              tests: [
                { projectName: 'a11y-desktop-chromium', status: 'expected', results: [{ status: 'passed' }] },
              ],
            },
            {
              title: 'a skipped test',
              tests: [
                { projectName: 'a11y-desktop-chromium', status: 'skipped', results: [{ status: 'skipped' }] },
              ],
            },
          ],
        },
      ],
    };

    const counts = perProjectCounts(report, 'a11y-');
    // One passed and one skipped, each counted exactly once. Before the fix, `skipped` was 2 here.
    expect(counts['desktop-chromium']).toMatchObject({ passed: 1, failed: 0, skipped: 1, expected: 1 });
    expect(counts['desktop-chromium'].skipped).toBe(1);
  });
});