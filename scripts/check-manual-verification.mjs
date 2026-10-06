#!/usr/bin/env node
/**
 * Validate the Phase 21 **manual verification record** and print its gate-level verdicts.
 *
 * ## Why this exists
 *
 * `tests/e2e/manual-verification.ts` defines the schema and the rules. A schema that only a test can
 * read is a schema a person cannot use: the person discharging a gate is sitting on a Chromebook or a
 * tablet, not at a terminal that can run vitest. This is the same command at the same rules, so the
 * record can be checked where it is written and again in CI, and the two cannot disagree.
 *
 * ## Why the rules are duplicated here rather than imported
 *
 * `manual-verification.ts` is TypeScript and this is plain ESM run by `node`, which does not load a
 * TypeScript module - the identical constraint `scripts/run-a11y-audit.mjs` states, and it is handled
 * the identical way: `tests/e2e/manualVerificationRecord.test.ts` reads **both** and compares them, so
 * a divergence is a red `npm test` rather than a quiet second opinion.
 *
 * That test does not compare the prose of the rules; it compares the *constants* the rules read (the
 * schema version, the manual evidence class, the verdict vocabulary, the gate ids, the claim boundary,
 * and the checklist step ids) and it drives **this file's** validator end to end against both a valid
 * and several malformed records. So the duplication that matters is bounded and checked.
 *
 * ## The evidence-class rule, which is the point of the whole file
 *
 * A record entry may carry exactly one evidence class, and it is `physical-device-manual`. The three
 * automated classes describe things a machine produced - a viewport emulation, a bundled engine, a
 * branded channel - and `tests/e2e/support-matrix.test.ts` already asserts that **no matrix entry**
 * claims the manual one. This file closes the remaining gap: a record entry that carries an automated
 * class is rejected, and so is an entry that names a matrix project in `notDerivedFrom`. That is what
 * makes "the `tablet` Playwright project passed, therefore the tablet gate is discharged" an error
 * rather than a sentence someone can write.
 *
 * ## Privacy
 *
 * Reads one JSON file and writes nothing. Prints only field names, bounded values the record itself
 * declares, and validator messages. No network, no browser, no learner data: the schema has no field
 * for a subject, a note, an attachment, a statistic or a preference, and unknown keys are rejected
 * rather than ignored.
 *
 * ## Exit statuses
 *
 * | status | meaning |
 * | --- | --- |
 * | `0` | the record is valid |
 * | `1` | the record is invalid; every problem is printed |
 * | `2` | usage error - the file is missing, unreadable, or not JSON |
 *
 * `1` is a *record* problem and this file's exit `1` never means anything else, because there is no
 * third status here to confuse: a valid-but-incomplete record exits `0` and prints `UNVERIFIED` lines,
 * which is the honest report, and completeness is a separate question this file answers in words
 * rather than in an exit code a CI summary would collapse.
 *
 * Usage:
 *   node scripts/check-manual-verification.mjs
 *   node scripts/check-manual-verification.mjs --record=<path>
 *   node scripts/check-manual-verification.mjs --json
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RECORD = 'tests/e2e/manual-verification-record.json';

/* ── The mirrored constants ────────────────────────────────────────────────────── */

const MANUAL_RECORD_SCHEMA_VERSION = 1;
const MANUAL_EVIDENCE_CLASS = 'physical-device-manual';
const MANUAL_VERDICTS = ['unverified', 'discharged', 'refused', 'blocked'];
const MANUAL_DEVICE_KINDS = [
  'chromebook',
  'android-tablet',
  'ios-tablet',
  'macos-laptop',
  'windows-laptop',
  'linux-laptop',
];
const MANUAL_GATE_IDS = [
  'physical-chromebook-screen-reader',
  'physical-macos-safari',
  'physical-touch-platform-screen-reader',
  'physical-windows-desktop-browser',
  'physical-linux-desktop-browser',
];
const MANUAL_CLAIM_BOUNDARY =
  'This is a manual observation record from named hardware with named assistive technology. It is not a WCAG ' +
  'conformance claim, not an audit, and not a statement about any browser, device or operating-system version nobody ' +
  'tested. A discharged gate records what one operator saw on one device on one date against one recorded artifact.';

/**
 * Checklist step ids, keyed by gate id.
 *
 * The *ids* only, not the prose. That is the part that has to agree for the validator to behave the
 * same way in both files: a rule that rejects an observation of an undeclared step is useless if one
 * copy of the id list is behind the other, and an observation silently accepted against a step id that
 * exists in only one file is exactly the kind of drift a record is supposed to be immune to.
 *
 * A gate absent from this table accepts no observations, and the key's presence is itself asserted by
 * `tests/e2e/manualVerificationRecord.test.ts` against the module it mirrors.
 */
const MANUAL_CHECKLIST_STEP_IDS = Object.freeze({
  'physical-chromebook-screen-reader': Object.freeze([
    'cb-01', 'cb-02', 'cb-03', 'cb-04', 'cb-05', 'cb-06',
  ]),
  'physical-touch-platform-screen-reader': Object.freeze([
    'touch-01', 'touch-02', 'touch-03', 'touch-04', 'touch-05', 'touch-06',
  ]),
  'physical-macos-safari': Object.freeze(['safari-01', 'safari-02', 'safari-03', 'safari-04']),
  'physical-windows-desktop-browser': Object.freeze(['win-01', 'win-02', 'win-03']),
  'physical-linux-desktop-browser': Object.freeze(['linux-01', 'linux-02']),
});

const ENTRY_KEYS = ['gateId', 'verdict', 'evidenceClass', 'evidence', 'notDerivedFrom', 'observations', 'note'];
const EVIDENCE_KEYS = [
  'device',
  'deviceModel',
  'operatingSystem',
  'browser',
  'assistiveTechnology',
  'assistiveTechnologyVersion',
  'operator',
  'performedOn',
  'artifactRef',
];
const RECORD_KEYS = ['schemaVersion', 'phase', 'claimBoundary', 'entries'];
const MAX_TEXT = 300;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKLIST_STEP_ID = /^[a-z]+-[0-9]{2}$/;

/**
 * Every matrix project, with the evidence class it is entitled to.
 *
 * Mirrored from `tests/e2e/support-matrix.ts`. It is a hard-coded list rather than a parsed import
 * for the same reason the other mirrors are: `node` cannot load the declaration. The cost is that a
 * ninth cell could be added to the matrix without appearing here - and the gate test asserts this list
 * equals the matrix's, so that is a red `npm test` rather than a gap in the rule.
 */
const MATRIX_CELLS = Object.freeze([
  { project: 'desktop-chromium', evidenceClass: 'emulated-viewport' },
  { project: 'chromebook', evidenceClass: 'emulated-viewport' },
  { project: 'tablet', evidenceClass: 'emulated-viewport' },
  { project: 'tablet-landscape', evidenceClass: 'emulated-viewport' },
  { project: 'compat-chromium', evidenceClass: 'engine-automation' },
  { project: 'compat-firefox', evidenceClass: 'engine-automation' },
  { project: 'compat-webkit', evidenceClass: 'engine-automation' },
  { project: 'compat-edge', evidenceClass: 'branded-channel-automation' },
]);

/* ── Validation ───────────────────────────────────────────────────────────────── */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkText(problems, label, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(`${label} must be a non-empty string.`);
    return;
  }
  if (value.length > MAX_TEXT) {
    problems.push(`${label} is ${value.length} characters; the limit is ${MAX_TEXT}.`);
  }
}

function validateEvidence(problems, label, evidence) {
  for (const key of Object.keys(evidence)) {
    if (!EVIDENCE_KEYS.includes(key)) {
      problems.push(
        `${label} evidence has unknown key "${key}". The evidence has a fixed shape so no field can hold a serial ` +
          'number, an account, or anything else the schema was not written to accept.',
      );
    }
  }
  if (!MANUAL_DEVICE_KINDS.includes(evidence.device)) {
    problems.push(
      `${label} evidence.device is ${JSON.stringify(evidence.device)}; it must be one of ` +
        `${MANUAL_DEVICE_KINDS.join(', ')}.`,
    );
  }
  for (const key of EVIDENCE_KEYS) {
    if (key === 'device') continue;
    checkText(problems, `${label} evidence.${key}`, evidence[key]);
  }
  if (typeof evidence.performedOn === 'string' && !ISO_DATE.test(evidence.performedOn)) {
    problems.push(`${label} evidence.performedOn must be an ISO date, YYYY-MM-DD.`);
  }
}

/**
 * Validate a parsed record. Returns an array of human-readable problems; empty means valid.
 *
 * Returned rather than thrown for the reason the TypeScript twin does it: a person fixing a malformed
 * record wants every problem at once, not the first one.
 */
export function validateManualVerificationRecord(record) {
  const problems = [];
  if (!isPlainObject(record)) return ['the record must be an object.'];

  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.includes(key)) {
      problems.push(
        `unknown top-level key "${key}". The record carries a fixed set so a field nobody validated cannot hold ` +
          'anything, including learner data.',
      );
    }
  }
  if (record.schemaVersion !== MANUAL_RECORD_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be ${MANUAL_RECORD_SCHEMA_VERSION}; the record says ${JSON.stringify(record.schemaVersion)}.`,
    );
  }
  if (typeof record.phase !== 'string' || record.phase.trim().length === 0) {
    problems.push('phase must be a non-empty string.');
  }
  if (record.claimBoundary !== MANUAL_CLAIM_BOUNDARY) {
    problems.push(
      'claimBoundary must be the MANUAL_CLAIM_BOUNDARY text, verbatim. The boundary is fixed rather than written per ' +
        'record so it cannot be trimmed.',
    );
  }
  if (!Array.isArray(record.entries)) return [...problems, 'entries must be an array.'];

  const seen = new Set();
  record.entries.forEach((raw, index) => {
    const label = `entries[${index}]`;
    if (!isPlainObject(raw)) {
      problems.push(`${label} must be an object.`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!ENTRY_KEYS.includes(key)) problems.push(`${label} has unknown key "${key}".`);
    }
    const gateId = raw.gateId;
    if (typeof gateId !== 'string' || !MANUAL_GATE_IDS.includes(gateId)) {
      problems.push(
        `${label} names gate "${String(gateId)}", which is not one of the ${MANUAL_GATE_IDS.length} gates this phase ` +
          'declared. A record cannot discharge a gate that does not exist.',
      );
      return;
    }
    if (seen.has(gateId)) {
      problems.push(`${label} repeats gate "${gateId}"; each gate appears once.`);
      return;
    }
    seen.add(gateId);

    if (raw.evidenceClass !== MANUAL_EVIDENCE_CLASS) {
      problems.push(
        `${label} (${gateId}) carries evidenceClass ${JSON.stringify(raw.evidenceClass)}. A manual record may carry only ` +
          `"${MANUAL_EVIDENCE_CLASS}". The automated classes describe machine-produced evidence, and letting a record ` +
          'carry one is how an emulated viewport becomes a device check.',
      );
    }
    if (!MANUAL_VERDICTS.includes(raw.verdict)) {
      problems.push(
        `${label} (${gateId}) has verdict ${JSON.stringify(raw.verdict)}; it must be one of ${MANUAL_VERDICTS.join(', ')}.`,
      );
    }

    if (raw.verdict === 'discharged') {
      if (!isPlainObject(raw.evidence)) {
        problems.push(
          `${label} (${gateId}) is marked "discharged" with no hardware attestation. A discharge requires a device, a ` +
            'device model, an operating-system version, a browser version, the assistive technology and its version, an ' +
            'operator, a date, and the recorded artifact it was run against.',
        );
      } else {
        validateEvidence(problems, `${label} (${gateId})`, raw.evidence);
      }
    } else if (raw.evidence !== null && raw.evidence !== undefined) {
      problems.push(
        `${label} (${gateId}) carries hardware evidence but its verdict is "${String(raw.verdict)}". Evidence without a ` +
          'discharge is fine; a discharge without evidence is not.',
      );
    }

    if (!Array.isArray(raw.notDerivedFrom)) {
      problems.push(`${label} (${gateId}) must carry notDerivedFrom as an array.`);
    } else {
      for (const cited of raw.notDerivedFrom) {
        const cell = MATRIX_CELLS.find((candidate) => candidate.project === cited);
        if (cell !== undefined) {
          problems.push(
            `${label} (${gateId}) names automated cell "${cited}" (${cell.evidenceClass}). A manual gate cannot be ` +
              'derived from an automated cell; if the Playwright run informed this observation, the observation is ' +
              "automated evidence and belongs in the runner's report, not here.",
          );
        } else if (typeof cited !== 'string' || cited.trim().length === 0) {
          problems.push(`${label} (${gateId}) has a non-string entry in notDerivedFrom.`);
        }
      }
    }

    if (!Array.isArray(raw.observations)) {
      problems.push(`${label} (${gateId}) must carry observations as an array.`);
    } else {
      const steps = MANUAL_CHECKLIST_STEP_IDS[gateId] ?? [];
      raw.observations.forEach((observation, obsIndex) => {
        const obsLabel = `${label} (${gateId}) observations[${obsIndex}]`;
        if (!isPlainObject(observation)) {
          problems.push(`${obsLabel} must be an object.`);
          return;
        }
        if (typeof observation.stepId !== 'string' || !CHECKLIST_STEP_ID.test(observation.stepId)) {
          problems.push(`${obsLabel} stepId must look like "cb-01".`);
          return;
        }
        if (!steps.includes(observation.stepId)) {
          problems.push(
            `${obsLabel} answers step "${observation.stepId}", which is not a step of the "${gateId}" checklist.`,
          );
        }
        checkText(problems, `${obsLabel} note`, observation.note);
        if (!['met', 'not-met', 'not-run'].includes(observation.outcome)) {
          problems.push(`${obsLabel} outcome must be "met", "not-met" or "not-run".`);
        }
      });
    }

    if (typeof raw.note !== 'string') {
      problems.push(`${label} (${gateId}) must carry a note string.`);
    } else if ((raw.verdict === 'refused' || raw.verdict === 'blocked') && raw.note.trim().length === 0) {
      problems.push(`${label} (${gateId}) is "${raw.verdict}" with an empty note. A refused or blocked gate records why.`);
    }
  });

  for (const gateId of MANUAL_GATE_IDS) {
    if (!seen.has(gateId)) problems.push(`no entry for declared gate "${gateId}"; every declared gate appears in the record.`);
  }

  return problems;
}

/** One line per gate, and the discharge count. The one-line-per-gate table a maintainer reads. */
export function manualVerdictTable(record) {
  const entries = new Map((record.entries ?? []).map((entry) => [entry.gateId, entry]));
  return MANUAL_GATE_IDS.map((gateId) => {
    const entry = entries.get(gateId);
    const verdict = entry?.verdict ?? 'unverified';
    const device = entry?.evidence?.device ?? 'no device recorded';
    return `  ${verdict.toUpperCase().padEnd(11)} ${gateId.padEnd(38)} ${MANUAL_EVIDENCE_CLASS}  ${device}`;
  });
}

export function dischargeSummary(record) {
  const entries = new Map((record.entries ?? []).map((entry) => [entry.gateId, entry]));
  const discharged = MANUAL_GATE_IDS.filter((gateId) => entries.get(gateId)?.verdict === 'discharged').length;
  return { discharged, total: MANUAL_GATE_IDS.length, complete: discharged === MANUAL_GATE_IDS.length };
}

/* ── Entry point ─────────────────────────────────────────────────────────────── */

function main(argv) {
  const recordArg = argv.find((argument) => argument.startsWith('--record='));
  const recordPath = path.resolve(REPO_ROOT, recordArg === undefined ? DEFAULT_RECORD : recordArg.slice('--record='.length));
  const asJson = argv.includes('--json');

  let text;
  try {
    text = readFileSync(recordPath, 'utf8');
  } catch {
    process.stderr.write(
      `check-manual-verification: cannot read ${path.relative(REPO_ROOT, recordPath)}. The record lives at ` +
        `${DEFAULT_RECORD} and is created by npm run check:manual-verification -- --init.\n`,
    );
    process.exitCode = 2;
    return;
  }

  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    process.stderr.write(
      `check-manual-verification: ${path.relative(REPO_ROOT, recordPath)} is not valid JSON ` +
        `(${error instanceof Error ? error.message.split('\n')[0] : 'unparseable'}).\n`,
    );
    process.exitCode = 2;
    return;
  }

  const problems = validateManualVerificationRecord(record);
  const summary = dischargeSummary(record);
  const relative = path.relative(REPO_ROOT, recordPath);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          record: relative,
          valid: problems.length === 0,
          problems,
          evidenceClass: MANUAL_EVIDENCE_CLASS,
          verdictTable: manualVerdictTable(record),
          ...summary,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = problems.length === 0 ? 0 : 1;
    return;
  }

  const lines = [];
  lines.push('');
  lines.push('== Phase 21 manual verification record ==');
  lines.push(`record: ${relative}    evidence class: ${MANUAL_EVIDENCE_CLASS} (the only class a manual entry may carry)`);
  lines.push('');
  lines.push(`GATE VERDICTS (${summary.discharged}/${summary.total} discharged):`);
  for (const line of manualVerdictTable(record)) lines.push(line);
  lines.push('');
  if (problems.length > 0) {
    lines.push(`RECORD IS INVALID - ${problems.length} problem(s):`);
    for (const problemText of problems) lines.push(`  - ${problemText}`);
  } else {
    lines.push('RECORD: valid.');
  }
  if (summary.complete) {
    lines.push('');
    lines.push(
      'All declared gates carry a "discharged" verdict. That is a manual observation record from named hardware and\n' +
        '  named assistive technology. It is NOT a WCAG conformance claim, not an audit, and not a statement about any\n' +
        '  browser, device or operating-system version nobody tested.',
    );
  } else {
    lines.push('');
    lines.push(
      `This record does not discharge the phase: ${summary.discharged} of ${summary.total} gates are discharged. An\n` +
        '  "unverified" gate is an absence, not a pass, and the phase exit criterion cannot be claimed from it.',
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  process.exitCode = problems.length === 0 ? 0 : 1;
}

// Only run when invoked directly, so the test file can import the validator without executing it.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}