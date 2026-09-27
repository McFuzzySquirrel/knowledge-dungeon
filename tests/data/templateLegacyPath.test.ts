/**
 * Phase 7 data-product gate 25: the legacy template path is the pre-Phase-7 one, is
 * retained only for rollback, and after the Phase 7 cutover has no application
 * caller.
 *
 * ## Why this file exists at all
 *
 * Plan section 7.3 defines the `.kdtemplate` product, and this repository has **two**
 * template implementations:
 *
 * - `@/services/persistence/products/subjectTemplate` - the Phase 7 product. A closed-key-set
 *   JSON document, no original identifiers, no attachment metadata, no ambient clock, an
 *   injected id generator, and a privacy gate that proves the absence of each of those.
 * - `exportSubjectAsTemplate` / `createSubjectFromTemplate` in
 *   `src/services/persistence/subjectPersistence.ts` - the **pre-Phase-7** path, retained
 *   verbatim for the plan's rollback line, "Retain the legacy template path behind the old UI
 *   until cutover".
 *
 * Two implementations of one product in one repository is a hazard on its own: a reader who
 * finds the wrong one either believes a leaking exporter is safe, or believes a safe exporter
 * has a defect. So this gate makes the distinction **mechanical** rather than a matter of
 * having read the right comment. It holds four things:
 *
 * 1. **The legacy path still leaks, in all five ways, measured.** Each of the five §7.3
 *    violations is asserted as a live fact about the current code: `roomId` at three levels,
 *    the `attachments` array, the `fileName` and `altText` inside it, the subject's own name,
 *    and an ambient-clock `exportedAt`. These are live assertions, not `it.fails`
 *    registrations - the suite's own integrity gate forbids a waiting reproduction - and
 *    their purpose is to *document the defect precisely* so nobody mistakes this path for the
 *    product.
 * 2. **The legacy importer mints from ambient, un-injectable sources.** `Date.now()` and
 *    `Math.random()`, which is exactly what makes "two imports create independent subjects"
 *    untestable on that path - and it is the negative control the product's own
 *    no-ambient-clock assertion is measured against.
 * 3. **Nothing in the application calls the legacy pair.** **Changed by the cutover.** This
 *    assertion previously pinned the *one* remaining caller - `src/ui/screens/WelcomeScreen.tsx`,
 *    which drove it from an admin panel whose "Export ... as template" button wrote a file
 *    named after the subject. Phase 7's Data Center template tab replaced that call site, so
 *    the caller set is now measured as **empty**, and the rest of this file is the reason an
 *    empty set is trustworthy rather than vacuous: the five leaks are still live above, the
 *    pair still round-trips, the product still refuses a legacy document, and the retention
 *    documentation is still asserted to be in the file.
 * 4. **The two are not interchangeable.** The product **refuses** a legacy document with the
 *    `legacy-template-format-refused` reason, and reads nothing from it. So a file written by
 *    the pre-Phase-7 exporter cannot be smuggled into the product by renaming it, and a
 *    learner who upgraded mid-flight is told their file is a legacy template rather than
 *    being shown a half-imported subject.
 *
 * ## What deleting the legacy path would mean
 *
 * Deleting the two functions would break the plan's rollback, so this gate does not ask for
 * that and does not permit it: an assertion that the *declarations* are gone would make the
 * rollback unrepresentable. What is retired is the **path** - the call site - and the
 * measurement that says so is the empty caller set above. That is also what removes plan
 * section 12, rule 6's violation on the rollback path: the retired call site was the only
 * place in the application that put a subject's own name into a file name, and
 * `noModuleBuildsASubjectNamedTemplateFile` below now holds that no module does.
 *
 * Privacy: the assertions read the legacy exporter's **output** for the presence of field
 * names and of the synthetic marker, and never reproduce a planted value beyond the marker
 * token, which is a fixture constant.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSubjectFromTemplate,
  exportSubjectAsTemplate,
} from '@/services/persistence/subjectPersistence';
import {
  exportSubjectTemplate,
  readSubjectTemplate,
  SUBJECT_TEMPLATE_FILE_NAME,
} from '@/services/persistence/products/subjectTemplate';
import { blankComments, classifySpecifierEdges, walk } from './support/importGraph';
import { MARKER_TOKEN } from './support/marker';
import { TEMPLATE_APPROVED_TAGS, TEMPLATE_NOW, templateSnapshot } from './support/templateSubject';

const REPO_ROOT = process.cwd();
const LEGACY_MODULE = 'src/services/persistence/subjectPersistence.ts';
const PRODUCT_MODULE = 'src/services/persistence/products/subjectTemplate.ts';
const PRE_CUTOVER_SCREEN = 'src/ui/screens/WelcomeScreen.tsx';
/** The module the Phase 7 cutover put in charge of the learner-facing path. */
const CUTOVER_MODULE = 'src/ui/data/SubjectTemplateTab.tsx';

let legacyDocument: Record<string, unknown>;

describe('Phase 7 gate 25: the legacy exporter still carries all five leaks', () => {
  it('each of the plan section 7.3 violations is a live, measured fact about the code', () => {
    // Plan section 5.3 names the defect: "Template metadata can contain attachment
    // information that import later discards." The exporter *writes* the attachment metadata,
    // the importer *discards* it, and the metadata travels in the file in between. The other
    // four violations are the same shape: the exporter writes them and nothing downstream
    // reads them.
    const snapshot = templateSnapshot();
    legacyDocument = JSON.parse(exportSubjectAsTemplate(snapshot)) as Record<string, unknown>;
    const dungeon = snapshot.dungeon;
    const rootRoomId = dungeon.rootRoomId;

    // 1. Original identifiers, at three levels: `rootRoomId`, `rooms[].roomId`, and the
    //    `roomTemplates` map's own keys. §7.3 excludes "original IDs".
    expect(legacyDocument.rootRoomId).toBe(rootRoomId);
    const legacyRooms = legacyDocument.rooms as Array<Record<string, unknown>>;
    expect(legacyRooms.length).toBeGreaterThanOrEqual(6);
    expect(legacyRooms.every((room) => typeof room.roomId === 'string')).toBe(true);
    expect(legacyRooms.map((room) => room.roomId)).toContain(rootRoomId);
    const roomTemplates = legacyDocument.roomTemplates as Record<string, Record<string, unknown>>;
    expect(Object.keys(roomTemplates)).toContain(rootRoomId);
    expect(roomTemplates[rootRoomId]?.roomId).toBe(rootRoomId);
    // The subject id is in there too, under `dungeonId`... which the legacy exporter does not
    // write. Asserted as an absence, so a future edit that adds it is caught here.
    expect(legacyDocument.dungeonId).toBeUndefined();

    // 2. Attachment metadata. §7.3 excludes "attachments".
    const rootTemplate = roomTemplates[rootRoomId] as Record<string, unknown>;
    const attachments = rootTemplate.attachments as Array<Record<string, unknown>>;
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments.length).toBeGreaterThanOrEqual(2);

    // 3. Filenames. §7.3 excludes "filenames" - and `fileName` and `altText` are both here,
    //    plus the marker, which a real learner's filenames would not carry but a real
    //    learner's *contents* might.
    expect(attachments.every((attachment) => typeof attachment.fileName === 'string')).toBe(true);
    expect(
      attachments.some((attachment) => String(attachment.fileName).includes(MARKER_TOKEN)),
    ).toBe(true);

    // 4. The subject's own name. Not one of the six permitted things.
    expect(legacyDocument.subjectName).toBe(dungeon.subjectName);
    expect(String(legacyDocument.subjectName)).toContain(MARKER_TOKEN);

    // 5. An ambient clock. The legacy export is therefore **not** deterministic: two exports
    //    of the same snapshot differ, which is the property the product's own determinism
    //    gate measures and the reason the product takes an injected `now`.
    expect(typeof legacyDocument.exportedAt).toBe('string');
    expect(String(legacyDocument.exportedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The two exports differ only because of the clock, which is asserted rather than assumed
    // by checking that the clock is the one field that moved.
    const second = JSON.parse(exportSubjectAsTemplate(snapshot)) as Record<string, unknown>;
    const firstWithoutClock = { ...legacyDocument, exportedAt: null };
    const secondWithoutClock = { ...second, exportedAt: null };
    expect(JSON.stringify(firstWithoutClock)).toBe(JSON.stringify(secondWithoutClock));
  });

  it('the legacy importer mints from ambient, un-injectable sources', () => {
    // The negative control for the product's "no `Date.now`, no `Math.random`" assertion.
    // Without this, that assertion would be a statement about a file nobody has read.
    const source = readFileSync(join(REPO_ROOT, LEGACY_MODULE), 'utf8');
    const legacyPair = source.slice(source.indexOf('export function exportSubjectAsTemplate'));
    expect(legacyPair).toContain('Date.now()');
    expect(legacyPair).toContain('Math.random()');
    // ...and the product's module contains neither, which is the assertion the sibling gate
    // makes on the product's own source.
    const product = readFileSync(join(REPO_ROOT, PRODUCT_MODULE), 'utf8');
    expect(product).not.toContain('Date.now()');
    expect(product).not.toContain('Math.random()');
  });

  it('the legacy importer accepts a legacy document and produces blank rooms anyway', () => {
    // The pair is mutually consistent, so the rollback path still works end to end: the
    // legacy importer reads the legacy exporter's own output. That is what "retained for
    // rollback" has to mean for the pair to be worth keeping.
    const minted = createSubjectFromTemplate(exportSubjectAsTemplate(templateSnapshot()));
    expect(minted.dungeon.subjectName).toBe(templateSnapshot().dungeon.subjectName);
    expect(minted.dungeon.phaseState).toBe('CreatorActive');
    expect(Object.keys(minted.rooms).length).toBeGreaterThanOrEqual(6);
    for (const room of Object.values(minted.rooms)) {
      expect(room.state).toBe('Created');
      expect(room.noteText).toBe('');
      expect(room.attachments).toEqual([]);
    }
    // ...and the ids it mints are not the source's, which the legacy path does get right.
    for (const roomId of Object.keys(minted.rooms)) {
      expect(roomId).not.toBe(templateSnapshot().dungeon.rootRoomId);
    }
  });
});

describe('Phase 7 gate 25: the cutover, and nothing in the application calls the legacy path', () => {
  it('no module binds either legacy function any more, by any edge kind', () => {
    const applicationGraph = walk().modules.map((module) => module.path);
    const callers = new Map<string, string[]>();
    for (const path of applicationGraph) {
      // The declaring module is not a caller of itself.
      if (path === LEGACY_MODULE) continue;
      const code = blankComments(readFileSync(join(REPO_ROOT, path), 'utf8'));
      for (const name of ['exportSubjectAsTemplate', 'createSubjectFromTemplate']) {
        // A *binding* needs two things, and the original version of this assertion only
        // required the first: a real edge to the module, and the name in **live code**.
        // Comments are blanked, so the two modules that name the pair in prose - the
        // product's own header and the Data Center's - are documentation, not callers.
        // Without the second half, adding a sentence explaining the cutover would have
        // failed this gate, which is the wrong way for a gate to be strict.
        if (!code.includes(name)) continue;
        const edges = classifySpecifierEdges(code, path, LEGACY_MODULE);
        // A `type-only` edge names no binding; anything else that reaches the module and
        // mentions the function is a real call, and this records it by module rather than
        // by edge kind so a future dynamic import would be reported here too.
        if (!edges.some((edge) => edge.kind !== 'type-only')) continue;
        const list = callers.get(name) ?? [];
        list.push(path);
        callers.set(name, list);
      }
    }
    // The measurement, not a claim. This used to be exactly
    // `[PRE_CUTOVER_SCREEN]`, and the Phase 7 cutover is what made it empty: the Data
    // Center's template tab is now the learner-facing path, and the Welcome screen's
    // admin panel - the only thing that still bound the leaking exporter - no longer
    // offers a template at all.
    expect([...callers.entries()].sort()).toEqual([]);
    // ...and the legacy module still declares both, because the plan's rollback is the
    // code and the cutover retired the *path*. A gate that asserted the declarations were
    // gone would be asking for the rollback to be deleted.
    const legacy = readFileSync(join(REPO_ROOT, LEGACY_MODULE), 'utf8');
    expect(legacy).toContain('export function exportSubjectAsTemplate');
    expect(legacy).toContain('export function createSubjectFromTemplate');
  });

  it('the empty caller set is a decision, and the walk that produced it is real', () => {
    // "No callers" is the shape an assertion gets vacuously wrong: a resolver that
    // matched nothing, a walk that reached nothing, or a classifier that recognised no
    // edges would all report exactly this. So the same code is run against the *cutover*
    // module and against the pre-cutover screen, and both are required to produce the
    // answer they should - which is only possible because the cutover module names the
    // product by three dynamic imports and one erased type import, and the screen still
    // reaches the legacy *module* for its other exports without naming these two.
    expect(
      classifySpecifierEdges(
        blankComments(readFileSync(join(REPO_ROOT, CUTOVER_MODULE), 'utf8')),
        CUTOVER_MODULE,
        PRODUCT_MODULE,
      )
        .map((edge) => edge.kind)
        .sort(),
    ).toEqual(['dynamic', 'dynamic', 'dynamic', 'type-only']);
    expect(
      classifySpecifierEdges(
        blankComments(readFileSync(join(REPO_ROOT, PRE_CUTOVER_SCREEN), 'utf8')),
        PRE_CUTOVER_SCREEN,
        LEGACY_MODULE,
      )
        .map((edge) => edge.kind)
        .sort(),
    ).toEqual(['static']);
    // ...and the positive form: the screen really does still import from the legacy
    // module, so the empty caller set above is a measurement about the two *names* and
    // not an artefact of the screen having stopped reaching the module at all.
    expect(readFileSync(join(REPO_ROOT, PRE_CUTOVER_SCREEN), 'utf8')).toContain(
      "from '@/services/persistence/subjectPersistence'",
    );
    // The graph the empty measurement was taken over is a real application graph, and it
    // contains both of those modules - so neither was skipped for being unreachable.
    const applicationGraph = walk().modules.map((module) => module.path);
    expect(applicationGraph).toContain(CUTOVER_MODULE);
    expect(applicationGraph).toContain(PRE_CUTOVER_SCREEN);
    expect(applicationGraph.length).toBeGreaterThanOrEqual(100);
  });

  it('the pre-cutover screen no longer offers a template, or names one', () => {
    // The visible half of the cutover, and the half a screen reader or a screenshot
    // would notice. The screen used to render a "Create from template" button, a hidden
    // template file input, and one "Export <subject> as template" button per subject.
    // Comments are blanked, so the comment in this screen that *explains* the cutover is
    // not what is being asserted about: the assertion is about live code and rendered
    // strings, which is the only place a learner could still reach the old path.
    const code = blankComments(readFileSync(join(REPO_ROOT, PRE_CUTOVER_SCREEN), 'utf8'));
    for (const gone of [
      'Create from template',
      'as template',
      '.template.json',
      'handleExportSubjectAsTemplate',
      'handleImportTemplateFromFile',
      'templateImportInputRef',
    ]) {
      expect(code, gone).not.toContain(gone);
    }
    // The screen's remaining export is an ordinary whole-subject `.json` export, which
    // this phase did not touch and which is *not* covered by this gate: it names its file
    // after the subject, which is pre-existing behaviour outside Phase 7's scope. The
    // template surface is what this gate holds, and the template surface is gone.
    expect(code).toContain('Export all subjects as JSON');
  });

  it('no module in the application builds a template file name, let alone one out of a subject name', () => {
    // Plan section 12, rule 6: learner data in a file name. The retired call site was
    // the only place that composed a *template* file name at all - it was
    // `${sanitizeFilePart(subject.dungeon.subjectName)}.template.json` - so retiring it
    // removes the violation. This is measured over the live module list with comments
    // blanked, so a second offender added tomorrow fails here rather than after someone
    // remembers.
    //
    // Two distinct properties, because they fail differently:
    //
    // 1. the legacy `.template.json` extension appears in no live code at all - it was
    //    the extension of a format this build refuses on read, so leaving any producer of
    //    it would leave a file nothing can import; and
    // 2. the product's own `.kdtemplate` extension never appears **inside an
    //    interpolation**, so no code composes a template file name out of a value. The
    //    extension legitimately appears as a file-picker `accept` filter and as the
    //    product's own constant; neither composes a name.
    const legacyExtension: string[] = [];
    const composedProductName: string[] = [];
    for (const path of walk().modules.map((module) => module.path)) {
      const code = blankComments(readFileSync(join(REPO_ROOT, path), 'utf8'));
      if (code.includes('.template.json')) legacyExtension.push(path);
      if (/\$\{[^}]*\}\s*\.kdtemplate/.test(code) || /`[^`]*\$\{[^`]*\.kdtemplate/.test(code)) {
        composedProductName.push(path);
      }
    }
    expect(legacyExtension).toEqual([]);
    expect(composedProductName).toEqual([]);
    // ...and the product's own constant is a constant: it carries no subject, no template
    // name, and no date, which is what the file name it is applied to inherits.
    expect(SUBJECT_TEMPLATE_FILE_NAME).toBe('knowledge-dungeon-subject-template.kdtemplate');
    expect(SUBJECT_TEMPLATE_FILE_NAME).not.toContain(templateSnapshot().dungeon.subjectName);
    expect(SUBJECT_TEMPLATE_FILE_NAME).not.toContain('.json');
  });

  it('the legacy pair is documented as legacy, and names the product that replaced it', () => {
    // The prose half of "a reader can tell which is which", asserted so the documentation and
    // the code cannot drift apart. Four markers, one per way of telling them apart.
    const source = readFileSync(join(REPO_ROOT, LEGACY_MODULE), 'utf8');
    const start = source.indexOf('export function exportSubjectAsTemplate');
    expect(start).toBeGreaterThan(0);
    const documentation = source.slice(0, start);
    expect(documentation).toContain('LEGACY TEMPLATE PATH (pre-Phase-7)');
    expect(documentation).toContain('Retained for rollback');
    expect(documentation).toContain('products/subjectTemplate');
    expect(documentation).toContain('section 5.3');
    // ...and the file is where it says it is.
    expect(existsSync(join(REPO_ROOT, LEGACY_MODULE))).toBe(true);
  });
});

describe('Phase 7 gate 25: the two paths are not interchangeable', () => {
  it('the product refuses a legacy document without reading any of it', () => {
    // The concrete safety property behind "you have two template implementations": a file
    // written by the leaking exporter cannot be handed to the product and half-imported. The
    // refusal names the format and echoes nothing - in particular not the subject name, not a
    // topic, and not a filename, all three of which the document carries.
    const legacyText = exportSubjectAsTemplate(templateSnapshot());
    expect(legacyText).toContain(MARKER_TOKEN);
    let thrown: unknown;
    try {
      readSubjectTemplate(legacyText);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const report = JSON.stringify(
      (thrown as { toReport(): unknown }).toReport(),
    );
    expect(report).toContain('legacy-template-format-refused');
    expect(report).not.toContain(MARKER_TOKEN);
    expect(report).not.toContain('subjectName');
    expect(report).not.toContain('roomTemplates');
  });

  it('the product never writes the legacy document, under any request', () => {
    // The other direction. Every request shape the product's own type allows - no optional
    // field, all of them, and a biome that is not a fixed vocabulary word - produces a
    // document with the product's own `product` tag and none of the legacy keys.
    const requests = [
      { now: TEMPLATE_NOW },
      { now: TEMPLATE_NOW, approvedTags: TEMPLATE_APPROVED_TAGS },
      { now: TEMPLATE_NOW, approvedTags: TEMPLATE_APPROVED_TAGS, approvedBiome: 'anything at all' },
      { now: TEMPLATE_NOW, name: 'A Name', description: 'A Description' },
    ] as const;
    for (const request of requests) {
      const document = JSON.parse(
        exportSubjectTemplate(templateSnapshot(), request).template,
      ) as Record<string, unknown>;
      expect(document.product, JSON.stringify(request)).toBe('kdtemplate');
      for (const legacyKey of [
        'format',
        'schemaVersion',
        'exportedAt',
        'subjectName',
        'rootRoomId',
        'tagIndex',
        'roomTemplates',
      ]) {
        expect(Object.keys(document), legacyKey).not.toContain(legacyKey);
      }
      expect(document).not.toHaveProperty('rooms');
    }
    // The legacy exporter's own key set, for the record, so a reader can see the difference
    // rather than infer it.
    // Code-unit order, so `roomTemplates` precedes `rooms`: a capital `T` sorts before a
    // lower-case `s`, which is exactly the kind of thing an assertion written from memory
    // gets wrong.
    expect(Object.keys(legacyDocument).sort()).toEqual([
      'biome',
      'edges',
      'exportedAt',
      'format',
      'roomTemplates',
      'rooms',
      'rootRoomId',
      'schemaVersion',
      'subjectName',
      'tagIndex',
    ]);
  });

  it('the product file name is a constant, and the subject-named one is gone with its caller', () => {
    // The other direction of "not interchangeable", and the one the cutover completed.
    // The legacy path's caller chose the file name, and the pre-cutover screen put the
    // **subject's name** in it. That was plan section 12, rule 6 violated on the rollback
    // path. Retiring the call site removes the violation rather than documenting it, and
    // the two facts are asserted here from both sides: the product's name is a constant,
    // and the application contains no code that could still produce the other one.
    expect(SUBJECT_TEMPLATE_FILE_NAME).toBe('knowledge-dungeon-subject-template.kdtemplate');
    expect(SUBJECT_TEMPLATE_FILE_NAME).not.toContain(templateSnapshot().dungeon.subjectName);
    // The export path that exists now hands the product's own constant straight to the
    // download, and the tab has no string of its own that could be a file name.
    const tab = readFileSync(join(REPO_ROOT, CUTOVER_MODULE), 'utf8');
    expect(tab).toContain('downloadBackupFile(bytes, result.fileName');
    expect(tab).not.toMatch(/\.download\s*=\s*[^;]*\$\{/);
    expect(tab).not.toMatch(/`\$\{[^`]*\}\.kdtemplate`/);
  });
});
