/**
 * Phase 7 verifier gate V6 - the cutover, and the "no ZIP" conclusion.
 *
 * ## Part one: the cutover
 *
 * The legacy `exportSubjectAsTemplate` / `createSubjectFromTemplate` pair was the only
 * application caller of a leaking template exporter, and `WelcomeScreen.tsx` was the only
 * caller of the pair. Two things must therefore both be true after Phase 7, and they pull
 * in opposite directions:
 *
 * - **no application caller remains** - the leaking path is not reachable;
 * - **the two functions still exist, unchanged** - plan section 7's rollback, "Retain the
 *   legacy template path behind the old UI until cutover", is the *code*, and a gate that
 *   deleted them would make the rollback unrepresentable.
 *
 * The "unchanged" half is measured against commit `8eb2587`, the last commit before this
 * phase, by comparing the two files with **every comment blanked**. That is the honest form
 * of "comments may differ, code may not": a comment rewrite cannot change a single
 * character of code, and a one-character code change cannot hide inside a blanked region.
 * The comparison is run through `git show`, so it measures the committed file rather than
 * anything in the working tree's history.
 *
 * ## Part two: the "no ZIP" conclusion
 *
 * Plan section 7.3 says `.kdtemplate` is a **JSON** document, and ends with "The archive
 * format must use a small audited open-source library ... Do not hand-roll ZIP encoding or
 * decoding." The implementer reads the second sentence as constraining the two products
 * that *are* archives, and concludes this product needs no codec at all.
 *
 * I agree with that reading, and this gate is what makes it checkable rather than asserted:
 * the product's own transitive first-party closure is walked with an **independent**
 * liberal resolver (`./support/closure`), and required to name neither the ZIP codec nor
 * `fflate` nor the archive validator - while the *same* walk is required to still reach the
 * storage-v2 schema and repository modules, so "no codec" cannot be satisfied by a walk that
 * reached nothing.
 *
 * Phase: 7.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSubjectFromTemplate,
  exportSubjectAsTemplate,
} from '@/services/persistence/subjectPersistence';
import {
  inspectSubjectTemplate,
  readSubjectTemplate,
  SUBJECT_TEMPLATE_FILE_NAME,
} from '@/services/persistence/products/subjectTemplate';
import { MARK, NOW, nastySubject, ROOM, SUBJECT_ID } from './support/nastySubject';
import { blankComments, closureOf, sourceFilesUnder } from './support/closure';

const REPO_ROOT = process.cwd();
const LEGACY_MODULE = 'src/services/persistence/subjectPersistence.ts';
const PRODUCT_MODULE = 'src/services/persistence/products/subjectTemplate.ts';
const CUTOVER_SCREEN = 'src/ui/screens/WelcomeScreen.tsx';
const BASE_COMMIT = '8eb2587';

function committed(path: string): string {
  return execFileSync('git', ['show', `${BASE_COMMIT}:${path}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** The file with every comment blanked and every blank line dropped. */
function codeOnly(source: string): string {
  return blankComments(source)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

describe('phase 7 verifier V6a: the cutover removed the caller and kept the rollback', () => {
  it('no module under src/ binds either legacy function, in live code', () => {
    const offenders: string[] = [];
    for (const absolute of sourceFilesUnder(join(REPO_ROOT, 'src'))) {
      const path = absolute.slice(REPO_ROOT.length + 1).split('\\').join('/');
      if (path === LEGACY_MODULE) continue;
      const code = blankComments(readFileSync(absolute, 'utf8'));
      // Two conditions, and both are needed. A name alone is not a caller: the product
      // exports `createSubjectFromTemplateSnapshot`, which contains the legacy name as a
      // substring and is a different function. And a file that merely mentions a name is
      // not a caller either: it has to actually reach the legacy module.
      if (!code.includes(`'@/services/persistence/subjectPersistence'`)) continue;
      for (const name of ['exportSubjectAsTemplate', 'createSubjectFromTemplate']) {
        if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${path}:${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Welcome screen no longer imports either name, in live code', () => {
    const code = blankComments(readFileSync(join(REPO_ROOT, CUTOVER_SCREEN), 'utf8'));
    expect(code).not.toContain('exportSubjectAsTemplate');
    expect(code).not.toContain('createSubjectFromTemplate');
    // ...and it still imports from the legacy module for its other exports, so the empty
    // result above is about the two names rather than about the import having vanished.
    expect(code).toContain('@/services/persistence/subjectPersistence');
  });

  it('the legacy module still declares and still exports both functions', () => {
    const legacy = readFileSync(join(REPO_ROOT, LEGACY_MODULE), 'utf8');
    expect(legacy).toContain('export function exportSubjectAsTemplate');
    expect(legacy).toContain('export function createSubjectFromTemplate');
    expect(typeof exportSubjectAsTemplate).toBe('function');
    expect(typeof createSubjectFromTemplate).toBe('function');
  });

  it("subjectPersistence.ts's code is byte-identical to 8eb2587 once comments are blanked", () => {
    const before = codeOnly(committed(LEGACY_MODULE));
    const after = codeOnly(readFileSync(join(REPO_ROOT, LEGACY_MODULE), 'utf8'));
    // Reported as a line-level diff of the *code* so a failure names what moved.
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const changed: string[] = [];
    for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
      if (beforeLines[index] !== afterLines[index]) {
        changed.push(`${index + 1}: ${String(beforeLines[index])} -> ${String(afterLines[index])}`);
      }
    }
    expect(changed).toEqual([]);
    expect(after.length).toBeGreaterThan(1000);
  });

  it('the legacy exporter still leaks, so the rollback is a real rollback and not a stub', () => {
    const snapshot = nastySubject({ subjectName: `${MARK}LEGACY-NAME` });
    const document = JSON.parse(exportSubjectAsTemplate(snapshot)) as Record<string, unknown>;
    expect(document.subjectName).toBe(`${MARK}LEGACY-NAME`);
    expect(document.rootRoomId).toBe(ROOM.root);
    const rooms = document.rooms as Array<{ roomId: string }>;
    expect(rooms.map((room) => room.roomId)).toContain(ROOM.childA);
    const templates = document.roomTemplates as Record<string, Record<string, unknown>>;
    const attachments = templates[ROOM.root]?.attachments as Array<Record<string, unknown>>;
    expect(attachments.length).toBeGreaterThan(0);
    expect(attachments[0]?.fileName).toContain('ATTACHMENT-FILENAME');
  });

  it('the legacy importer still round-trips, from ambient sources', () => {
    const document = exportSubjectAsTemplate(nastySubject());
    const minted = createSubjectFromTemplate(document);
    const rooms = minted.rooms as unknown as Record<string, { roomId: string }>;
    expect(Object.keys(rooms)).toHaveLength(4);
    expect(Object.keys(rooms)).not.toContain(ROOM.root);
    expect(minted.dungeon.phaseState).toBe('CreatorActive');
  });

  it('the product refuses a legacy document whole, and reads nothing from it', () => {
    const legacy = exportSubjectAsTemplate(nastySubject({ subjectName: `${Mark()}` }));
    let thrown: unknown;
    try {
      readSubjectTemplate(legacy);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { details: { reason?: string } }).details.reason).toBe('legacy-template-format-refused');
    const report = JSON.stringify((thrown as { toReport: () => unknown }).toReport());
    for (const marker of [MARK, 'roomTemplates', 'attachments', 'rootRoomId', 'exportedAt']) {
      expect(report.includes(marker)).toBe(false);
    }
    // And the inspection path agrees.
    expect(inspectSubjectTemplate(legacy).ok).toBe(false);
  });

  it('the product refuses a legacy document even after every field is renamed', () => {
    const legacy = JSON.parse(exportSubjectAsTemplate(nastySubject())) as Record<string, unknown>;
    const renamed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(legacy)) {
      renamed[`x-${key}`] = value;
    }
    let thrown: unknown;
    try {
      readSubjectTemplate(JSON.stringify(renamed));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { details: { reason?: string } }).details.reason).toBe('document-unexpected-field');
  });
});

describe('phase 7 verifier V6b: the template product has no archive codec in its closure', () => {
  const productClosure = closureOf(PRODUCT_MODULE);

  it('reaches the storage-v2 implementation, so the walk is not vacuous', () => {
    expect(productClosure.paths).toContain('src/services/persistence/v2/schema.ts');
    expect(productClosure.paths).toContain('src/services/persistence/v2/repository.ts');
    expect(productClosure.paths).toContain('src/services/persistence/v2/appRepository.ts');
    expect(productClosure.paths.length).toBeGreaterThanOrEqual(8);
  });

  it('does not name the ZIP codec, the archive validator, or fflate', () => {
    expect(productClosure.paths).not.toContain('src/services/persistence/v2/archive.ts');
    expect(productClosure.paths).not.toContain('src/services/persistence/products/archiveValidation.ts');
    expect(productClosure.paths).not.toContain('src/services/persistence/products/subjectBackup.ts');
    expect(productClosure.paths).not.toContain('src/services/persistence/products/fullDeviceBackup.ts');
    for (const external of productClosure.externals) {
      expect(external.startsWith('fflate')).toBe(false);
    }
  });

  it('the shared remapper it reuses also has no codec in its closure', () => {
    const remapper = closureOf('src/services/persistence/products/idRemapping.ts');
    // The positive control: the walk reaches real modules.
    expect(remapper.paths).toContain('src/services/persistence/v2/schema.ts');
    expect(remapper.paths).toContain('src/services/persistence/v2/prototypeNames.ts');
    expect(remapper.paths.length).toBeGreaterThanOrEqual(3);
    // ...and not the codec.
    expect(remapper.paths).not.toContain('src/services/persistence/v2/archive.ts');
    expect(remapper.paths).not.toContain('src/services/persistence/products/archiveValidation.ts');
  });

  it('the prototype-name leaf really is a leaf, which is what makes the split sound', () => {
    const leaf = closureOf('src/services/persistence/v2/prototypeNames.ts');
    expect(leaf.paths).toEqual(['src/services/persistence/v2/prototypeNames.ts']);
    expect(leaf.externals).toEqual([]);
  });

  it('the Data Center tab, with all three products on it, does reach the codec - as it must', () => {
    // The negative control for the negative claim: the other two tabs legitimately inflate
    // archives, so a walk that found no codec anywhere would mean the walk is broken.
    const dataCenter = closureOf('src/ui/data/DataCenter.tsx');
    expect(dataCenter.paths).toContain('src/services/persistence/v2/archive.ts');
    expect(dataCenter.paths).toContain(PRODUCT_MODULE);
  });

  it('the product file names no ZIP extension and no archive vocabulary in live code', () => {
    const code = blankComments(readFileSync(join(REPO_ROOT, PRODUCT_MODULE), 'utf8'));
    for (const forbidden of ['fflate', 'unzip', 'zipSync', 'zip', 'PK', '.kdbak', '.kdsubject']) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
    // ...and the file name it offers is a JSON product's name.
    expect(SUBJECT_TEMPLATE_FILE_NAME.endsWith('.kdtemplate')).toBe(true);
  });

  it('the archive header it corrected says what it now does', () => {
    const header = readFileSync(join(REPO_ROOT, 'src/services/persistence/v2/archive.ts'), 'utf8');
    // The correction under review: the header must not claim to serve the template product.
    expect(header.slice(0, 4000)).toContain('`.kdbak` and `.kdsubject`');
    expect(header.slice(0, 4000)).not.toContain('`.kdbak`, `.kdsubject`, and `.kdtemplate`');
  });
});

/** A fresh marker for the legacy round-trip, so the two documents are distinguishable. */
function Mark(): string {
  return `${MARK}LEGACY-SUBJECT-NAME`;
}

describe('phase 7 verifier V6c: NOW is only used by the gates, never read by the product', () => {
  it('the product takes its clock as a parameter and reads none itself', () => {
    const code = blankComments(readFileSync(join(REPO_ROOT, PRODUCT_MODULE), 'utf8'));
    expect(code).not.toContain('new Date(');
    expect(code).not.toContain('Date.now(');
    expect(code).not.toContain('Math.random(');
    void NOW;
    void SUBJECT_ID;
  });
});
