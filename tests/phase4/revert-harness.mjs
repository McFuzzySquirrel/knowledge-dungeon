#!/usr/bin/env node
/**
 * Revert-and-restore harness for the Phase 4 fix verification.
 *
 * For each reported fix: record the sha256 of the production file, apply a
 * minimal revert that removes exactly that fix, run the test that is supposed to
 * hold it open, then restore the file and assert the sha256 is back to the
 * recorded value. The real tree is left byte-identical; the run aborts if any
 * checksum does not match.
 *
 * Usage: node tests/phase4/revert-harness.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const results = [];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runVitest(file, testNamePattern) {
  try {
    const out = execFileSync(
      'npx',
      ['vitest', 'run', file, '-t', testNamePattern],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { passed: true, out };
  } catch (error) {
    return { passed: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * @param {string} label
 * @param {string} file        production file to patch
 * @param {[string,string][]} edits  [search, replace] pairs, applied in order
 * @param {string} testFile
 * @param {string} testName
 */
function revert(label, file, edits, testFile, testName) {
  const absolute = resolve(ROOT, file);
  const before = sha256(absolute);
  const backupDir = mkdtempSync(join(tmpdir(), 'phase4-revert-'));
  const backup = join(backupDir, file.split('/').pop());
  copyFileSync(absolute, backup);
  const original = readFileSync(absolute, 'utf8');
  let patched = original;
  for (const [search, replace] of edits) {
    if (!patched.includes(search)) {
      restore(absolute, backup, before);
      results.push({ label, outcome: 'PATCH-NOT-APPLIED', detail: `search not found: ${search.slice(0, 80)}` });
      return;
    }
    patched = patched.replace(search, replace);
  }
  writeFileSync(absolute, patched);
  const run = runVitest(testFile, testName);
  const redOutput = run.passed ? '' : run.out.split('\n').filter((line) => line.includes('AssertionError') || line.includes('Tests ')).slice(0, 3).join(' | ');
  restore(absolute, backup, before);
  rmSync(backupDir, { recursive: true, force: true });
  results.push({
    label,
    file,
    test: `${testFile} -t "${testName}"`,
    outcome: run.passed ? 'DID-NOT-GO-RED' : 'went red as required',
    detail: redOutput || run.out.split('\n').filter((l) => l.includes('Tests ')).slice(-1)[0] || '',
  });
}

function restore(absolute, backup, expected) {
  copyFileSync(backup, absolute);
  const after = sha256(absolute);
  if (after !== expected) {
    console.error(`FATAL: ${absolute} was not restored (${expected} != ${after})`);
    process.exit(2);
  }
}

// 1. The progression envelope's version marker.
revert(
  'Fix 1 - progression envelope version marker',
  'src/services/persistence/v2/appState.ts',
  [['    version: CANONICAL_PROGRESSION_VERSION,\n', '']],
  'tests/phase4/fixVerification.test.ts',
  'emits the shared constant',
);

// 1b. The same fix, through the behavioural gate rather than the source check.
revert(
  'Fix 1b - progression envelope, behavioural',
  'src/services/persistence/v2/appState.ts',
  [['    version: CANONICAL_PROGRESSION_VERSION,\n', '']],
  'tests/phase4/fixVerification.test.ts',
  'is a fixed point: reading and hydrating twice changes nothing',
);

// 2. The custom-sprite record id.
revert(
  'Fix 2 - custom sprite record id',
  'src/services/persistence/v2/repository.ts',
  [[
    'customSpriteRecordId(value.spritePath, value.kind)',
    'value.spritePath',
  ]],
  'tests/phase4/fixVerification.test.ts',
  'three kinds for one path migrate, activate, and validate',
);

// 3. The preference generation write.
revert(
  'Fix 3 - preferences reach the generation',
  'src/store/preferencesStore.ts',
  [['  const repository = currentStorageV2Repository();\n', '  const repository = null;\n']],
  'tests/phase4/fixVerification.test.ts',
  'survives a reload on the flagged build',
);

// 4. The canonical shortcut order.
revert(
  'Fix 4 - canonical shortcut order',
  'src/store/shortcutStore.ts',
  [[
    'function inCanonicalOrder(bindings: readonly ShortcutBinding[]): ShortcutBinding[] {',
    'function inCanonicalOrder(bindings: readonly ShortcutBinding[]): ShortcutBinding[] {\n  if (bindings.length > 0) return [...bindings];',
  ]],
  'tests/phase4/fixVerification.test.ts',
  'the flagged and legacy hydrations produce the identical order',
);

// 5. The unindexed-payload preservation.
revert(
  'Fix 5 - unindexed payload preserved as a recovery record',
  'src/services/persistence/v2/migrations.ts',
  [[
    'const indexedIds = state.indexedSubjectIds === undefined ? null : new Set(state.indexedSubjectIds);',
    'const indexedIds = null;',
  ]],
  'tests/phase4/fixVerification.test.ts',
  'the bytes are preserved verbatim in a recovery record',
);

// 6. The content predicate the migration asks.
revert(
  'Fix 6 - hasNoLearnerContent in the migration',
  'src/services/persistence/v2/migrations.ts',
  [['    if (hasNoLearnerContent(state)) {', '    if (hasNoLearnerContent(state) && false) {']],
  'tests/phase4/fixVerification.test.ts',
  'classifies a locale-only device as no-source-data',
);

const report = results
  .map((entry) => `| ${entry.label} | ${entry.file} | ${entry.test} | ${entry.outcome} | ${entry.detail} |`)
  .join('\n');
console.log(report);
console.log(`\n${results.filter((r) => r.outcome === 'went red as required').length}/${results.length} reverts made the gate go red.`);
