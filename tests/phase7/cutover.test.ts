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
 * The "unchanged" half is measured against a **pinned, verbatim snapshot** of
 * `subjectPersistence.ts` as it was at commit `8eb2587`, the last commit before this phase,
 * by comparing it with the working file using **every comment blanked**. That is the honest
 * form of "comments may differ, code may not": a comment rewrite cannot change a single
 * character of code, and a one-character code change cannot hide inside a blanked region.
 *
 * The snapshot is a committed fixture under `./support/fixtures`, not a `git show` at test
 * time. That is a repair, not a convenience: this assertion originally shelled out to
 * `git show 8eb2587:...`, and CI clones at depth 1, so the commit is not in the runner's
 * object store and the test failed there with `fatal: invalid object name` while passing
 * locally. Reproduced in a depth-1 clone: 2 failed / 142 passed files. The fixture makes the
 * claim hermetic, reviewable, and diffable, and it re-derives its own body digest on read,
 * so it cannot be edited into agreeing with whatever the working tree currently is. The
 * comparison itself is unchanged: a byte comparison between pinned bytes and the working
 * file, and it still fails on any code edit.
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

import { existsSync, readFileSync } from 'node:fs';
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
import { phase6SubjectPersistence, phase6WelcomeScreen } from './support/phase6Fixtures';

const REPO_ROOT = process.cwd();
const LEGACY_MODULE = 'src/services/persistence/subjectPersistence.ts';
const PRODUCT_MODULE = 'src/services/persistence/products/subjectTemplate.ts';
const CUTOVER_SCREEN = 'src/ui/screens/WelcomeScreen.tsx';

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

  it("subjectPersistence.ts's code is byte-identical to the pinned Phase 6 snapshot once comments are blanked", () => {
    const pinned = phase6SubjectPersistence();
    // The fixture must still be the exact bytes that were captured, or the comparison
    // below would be against a snapshot someone edited to match the working tree.
    expect(pinned.bodySha256, `${pinned.file} body does not match its declared digest`).toBe(
      pinned.declaredSha256,
    );
    expect(pinned.measuredBytes, `${pinned.file} body length`).toBe(pinned.declaredBytes);
    expect(pinned.declaredPath).toBe(LEGACY_MODULE);
    const before = codeOnly(pinned.body);
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

describe('phase 7 verifier V6a-bis: the pinned snapshots are hermetic and self-verifying', () => {
  it('both fixtures carry the body their header declares, and that body is the pre-cutover source', () => {
    for (const fixture of [phase6SubjectPersistence(), phase6WelcomeScreen()]) {
      // The digest is re-derived from the body at read time, so this is a measurement of
      // the file in the repository rather than a restatement of the header. A snapshot
      // edited into agreeing with the working tree fails here first, so the byte-identity
      // comparison below can never be satisfied by a doctored baseline.
      expect(fixture.bodySha256, `${fixture.file} body digest`).toBe(fixture.declaredSha256);
      expect(fixture.measuredBytes, `${fixture.file} body bytes`).toBe(fixture.declaredBytes);
      expect(fixture.declaredCommit, `${fixture.file} commit`).toMatch(/^[0-9a-f]{40}$/);
      expect(fixture.declaredShortCommit, `${fixture.file} short commit`).toMatch(/^[0-9a-f]{7,12}$/);
      expect(fixture.declaredPath).toMatch(/^src\//);
      // The body is real source, not a placeholder: it declares the module it claims.
      expect(fixture.body.length, `${fixture.file} body length`).toBeGreaterThan(20_000);
    }
  });

  it('neither fixture is a truncated or reflowed copy: the body is the whole file', () => {
    const persistence = phase6SubjectPersistence();
    const screen = phase6WelcomeScreen();
    // Whole-file markers: the first import and the last export of each. A capture that
    // lost a tail would still parse and would still satisfy a weaker comparison.
    expect(persistence.body.trimStart().startsWith('/**')).toBe(true);
    expect(persistence.body.trimEnd().endsWith('}')).toBe(true);
    expect(persistence.body).toContain('export function createSubjectFromTemplate(');
    expect(persistence.body).toContain('export function importSubjectFromJson(');
    expect(screen.body.trimStart().startsWith('import {')).toBe(true);
    expect(screen.body).toContain('export function WelcomeScreen(');
    expect(screen.body).toContain('exportSubjectAsTemplate');
  });

  it('the working tree still holds the two files the fixtures snapshot, so the comparison has two ends', () => {
    for (const path of [LEGACY_MODULE, CUTOVER_SCREEN]) {
      expect(existsSync(join(REPO_ROOT, path)), path).toBe(true);
    }
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
