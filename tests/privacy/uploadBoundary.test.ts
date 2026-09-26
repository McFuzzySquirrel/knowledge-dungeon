/**
 * Phase 4 privacy gate, test 1: no upload dependency in the web application
 * graph.
 *
 * Plan section 2.3 and the Phase 4 exit criterion: "The redesigned app makes no
 * learner-data upload request." The redesigned web build must reach no upload
 * endpoint, must not construct a `FormData` body, must not open an
 * `XMLHttpRequest`, and must not post to any non-same-origin destination.
 *
 * This file proves the gate three ways, because a source scan that matches
 * nothing is indistinguishable from a source scan that is broken:
 *
 * - **Non-vacuity.** The walk is asserted against real counts, real key sets,
 *   and real invariants (see "the import-graph walk is real").
 * - **Positive control.** A temporary probe module is planted inside `src/`,
 *   walked with the same resolver and detector, and required to produce the
 *   expected findings; deleting it must return the tree to its prior state. The
 *   probe also pulls a real module in through the `@/` alias, so the control
 *   also proves alias resolution.
 * - **The gate itself.** The live assertion is registered as `it.fails` while
 *   `src/ui/components/NoteEditorModal.tsx` still posts the picked image to
 *   `/api/upload`. That is the exact defect Phase 4's application change
 *   removes, and the reproduction turns RED the moment it is removed, which is
 *   when this file must be updated rather than deleted.
 *
 * This file is self-contained about non-vacuity: it names every surviving network
 * call site in the graph itself, so it does not depend on another gate to prove
 * that "no findings" is a decision rather than a broken scan.
 *
 * The probe is planted inside `src/`, on purpose, and declares its exact paths while
 * it exists (see `TEST_OWNED_SOURCE_DIRECTORIES` in `./support/appGraph`). A gate
 * that scans `src/` for forbidden imports would otherwise report the planted probe
 * as a real offender, which is a cross-suite flake rather than a finding. The
 * declaration is file-level, not directory-level: another file in the same
 * directory is still that gate's business.
 *
 * Privacy: findings carry a repo-relative path, a line number, and a rule id
 * only. No destination, URL, request body, or source text is copied into a
 * finding or a failure message. Every value used here is synthetic.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APP_ENTRY_MODULE,
  TEST_OWNED_SOURCE_DIRECTORIES,
  allFirstPartyModules,
  classifyDestination,
  describeFindings,
  scanGraphForNetworkRules,
  scanModuleForNetworkRules,
  testOwnedDirectory,
  walkAppGraph,
  writePlantingMarker,
  type NetworkFinding,
} from './support/appGraph';

// The directory name comes from the shared declaration, so the gate that owns the
// planting and the gate that scans `src/` for forbidden imports agree by
// construction rather than by a duplicated string.
const PROBE_DIRECTORY_NAME = TEST_OWNED_SOURCE_DIRECTORIES[0];
const PROBE_DIRECTORY = testOwnedDirectory(PROBE_DIRECTORY_NAME);
const PROBE_ENTRY = `src/${PROBE_DIRECTORY_NAME}/index.ts`;
const PROBE_UPLOADER = `src/${PROBE_DIRECTORY_NAME}/uploader.ts`;

const PROBE_INDEX_SOURCE = `export { postPickedImage } from './uploader';
`;

const PROBE_UPLOADER_SOURCE = `import { checksumBytes } from '@/services/persistence/v2/checksum';

export async function postPickedImage(bytes: Uint8Array): Promise<string | null> {
  const body = new FormData();
  void checksumBytes(bytes);
  const response = await fetch('/api/upload', { method: 'POST', body });
  return response.ok ? null : null;
}
`;

const PROBE_EXTERNAL_SOURCE = `export async function warmExternalCache(url: string): Promise<void> {
  await fetch(url, { method: 'GET' });
  const absolute = await fetch('https://example.invalid/remote.png');
  void absolute;
}
`;

function removeProbe(): void {
  rmSync(PROBE_DIRECTORY, { recursive: true, force: true });
}

function plantProbe(entrySource: string, entryName: string, moduleSource: string, moduleName: string): void {
  removeProbe();
  mkdirSync(PROBE_DIRECTORY, { recursive: true });
  writeFileSync(join(PROBE_DIRECTORY, entryName), entrySource, 'utf8');
  writeFileSync(join(PROBE_DIRECTORY, moduleName), moduleSource, 'utf8');
  // Declared for as long as the probe exists, and by *exact path*, so a gate
  // scanning `src/` while this runs can tell these two planted files from any
  // other file in the directory. The declaration is written after the files, so a
  // gate that reads it never sees a name for a file that does not exist yet.
  writePlantingMarker(PROBE_DIRECTORY_NAME, [
    `src/${PROBE_DIRECTORY_NAME}/${entryName}`,
    `src/${PROBE_DIRECTORY_NAME}/${moduleName}`,
  ]);
}

function rulesIn(findings: readonly NetworkFinding[], file: string): string[] {
  return findings.filter((finding) => finding.file === file).map((finding) => finding.rule).sort();
}

afterEach(() => {
  removeProbe();
});

describe('Phase 4 privacy gate 1: the application import graph', () => {
  it('walks a real, non-trivial, fully resolved first-party graph from src/main.tsx', () => {
    const graph = walkAppGraph();
    const allModules = allFirstPartyModules();
    const paths = graph.modules.map((module) => module.path);

    // The entry itself is always reached.
    expect(paths).toContain(APP_ENTRY_MODULE);

    // A non-vacuous module count. Phase 3 measured 84 modules for this graph;
    // a lower number here means the resolver stopped following imports.
    expect(
      graph.modules.length,
      `The walk reached ${graph.modules.length} modules, which is fewer than the ${allModules.length} ` +
        'first-party modules in src/. The resolver is not following the import graph.',
    ).toBeGreaterThanOrEqual(60);

    // The graph is a proper subset of the tree: a walker that silently globbed
    // src/ would pass the count check above while proving nothing.
    expect(graph.modules.length).toBeLessThan(allModules.length);
    expect(allModules.length).toBeGreaterThanOrEqual(120);

    // Every reached file exists on disk, so no phantom module inflates the count.
    for (const module of graph.modules) {
      expect(existsSync(join(process.cwd(), module.path)), module.path).toBe(true);
    }

    // Every specifier resolved. A dangling resolver would show up here instead
    // of silently shrinking the graph.
    expect(
      graph.unresolved,
      graph.unresolved.map((entry) => `${entry.from} -> ${entry.specifier}`).join('\n'),
    ).toEqual([]);

    // The walk spans the real application layers, not one subtree.
    expect(graph.sourceDirectories.length).toBeGreaterThanOrEqual(6);
    for (const area of ['ui', 'store', 'services', 'core']) {
      expect(graph.sourceDirectories, area).toContain(area);
    }

    // Real edges, not just a count: the note editor is where the upload path
    // lives today, so the walk must actually reach it or the gate is blind.
    expect(paths).toContain('src/ui/components/NoteEditorModal.tsx');
    expect(paths).toContain('src/ui/App.tsx');
    expect(paths).toContain('src/store/subjectStore.ts');
    expect(paths).toContain('src/services/persistence/subjectPersistence.ts');

    // Bare package specifiers are recorded, so the walk distinguishes first
    // party from third party instead of treating `react` as a file.
    expect(graph.externalSpecifiers).toContain('react');
    expect(graph.externalSpecifiers).toContain('zustand');
    expect(
      graph.modules.find((module) => module.path === 'src/main.tsx')?.externalSpecifiers ?? [],
    ).toContain('react-dom/client');

    // The server-side and Electron-main modules are NOT in the web bundle graph.
    // The Express `/api/upload` endpoint exists in `server/index.js`; the
    // redesigned web app must not reach it through any import.
    for (const modulePath of paths) {
      expect(modulePath.startsWith('server/'), modulePath).toBe(false);
      expect(modulePath, modulePath).not.toBe('src/electron/main.ts');
    }

    // A second walk from a module that is already in the graph reaches a
    // strict subset of it: proof that reachability comes from the edges and
    // not from the file listing.
    const fromNoteEditor = walkAppGraph({ entry: 'src/ui/components/NoteEditorModal.tsx' });
    expect(fromNoteEditor.modules.length).toBeGreaterThan(1);
    expect(fromNoteEditor.modules.length).toBeLessThan(graph.modules.length);
    const mainPaths = new Set(paths);
    for (const module of fromNoteEditor.modules) {
      expect(mainPaths.has(module.path), module.path).toBe(true);
    }

    // And a nonexistent entry resolves to nothing at all, which is what makes
    // the counts above meaningful.
    const fromNothing = walkAppGraph({ entry: 'src/__not_a_real_module__.ts' });
    expect(fromNothing.modules).toEqual([]);
    expect(fromNothing.unresolved).toHaveLength(1);
  });

  it('resolves aliases, relative paths, directory indexes, and JSON imports', () => {
    const graph = walkAppGraph();
    const modulePaths = new Set(graph.modules.map((module) => module.path));

    // A JSON import reached through the `@/` alias from `src/i18n/index.ts`.
    expect(modulePaths.has('src/i18n/locales/en.json')).toBe(true);
    // `@/core/validation/persistence` resolves to the directory index, which
    // proves the alias and the index probe together.
    expect(modulePaths.has('src/core/validation/persistence/index.ts')).toBe(true);
    expect(modulePaths.has('src/game/adapters/index.ts')).toBe(true);
    // A relative path from a nested module.
    expect(modulePaths.has('src/core/validation/persistence/types.ts')).toBe(true);

    // The edges are the resolved files, not the raw specifiers.
    const subjectStore = graph.modules.find(
      (module) => module.path === 'src/store/subjectStore.ts',
    );
    expect(subjectStore?.specifiers ?? []).toContain('@/core/validation/persistence');
    expect(subjectStore?.firstPartyEdges ?? []).toContain(
      'src/core/validation/persistence/index.ts',
    );

    // The index is a real edge in its own right, and its own relative
    // `export * from './types'` is resolved to a file.
    const persistenceIndex = graph.modules.find(
      (module) => module.path === 'src/core/validation/persistence/index.ts',
    );
    expect(persistenceIndex?.firstPartyEdges ?? []).toContain(
      'src/core/validation/persistence/types.ts',
    );
    expect(persistenceIndex?.firstPartyEdges ?? []).toContain(
      'src/core/validation/persistence/subjectValidation.ts',
    );
  });

  it('accepts the real same-origin asset loads, so "no findings" is a decision and not a default', () => {
    // `fetch(MANIFEST_URL)` where MANIFEST_URL is a module-level const built
    // from `import.meta.env.BASE_URL`, and `fetch(`${BASE}assets/${path}`)`:
    // both must classify as same-origin-relative and produce no finding. If the
    // classifier could not follow an identifier or an interpolation, these
    // would be reported as unresolved and the gate would cry wolf on every
    // future same-origin load.
    const manifest = scanModuleForNetworkRules(
      'src/services/spriteManifest.ts',
      readFileSync(join(process.cwd(), 'src/services/spriteManifest.ts'), 'utf8'),
    );
    expect(manifest.callSites).toBe(1);
    expect(manifest.sameOriginCalls).toBe(1);
    expect(manifest.findings).toEqual([]);

    const makeItYours = scanModuleForNetworkRules(
      'src/ui/components/MakeItYoursTab.tsx',
      readFileSync(join(process.cwd(), 'src/ui/components/MakeItYoursTab.tsx'), 'utf8'),
    );
    expect(makeItYours.callSites).toBe(1);
    expect(makeItYours.sameOriginCalls).toBe(1);
    expect(makeItYours.findings).toEqual([]);

    // And the classifier really does separate the two destination classes,
    // rather than returning one answer for every input.
    expect(classifyDestination("'/assets/sprite-manifest.json'", new Map())).toBe(
      'same-origin-relative',
    );
    expect(classifyDestination("'https://example.invalid/x.png'", new Map())).toBe(
      'absolute-external',
    );
    expect(classifyDestination("'//example.invalid/x.png'", new Map())).toBe('absolute-external');
    expect(classifyDestination('someUntrackedVariable', new Map())).toBe('dynamic-unresolved');
    expect(
      classifyDestination('MANIFEST_URL', new Map([['MANIFEST_URL', '`${BASE}assets/x.json`']])),
    ).toBe('same-origin-relative');
    expect(
      classifyDestination("'/api/upload'", new Map()),
    ).toBe('same-origin-relative');
  });

  it('detects every forbidden network construct in a planted probe and is clean once it is deleted', () => {
    const baseline = walkAppGraph();
    const baselinePaths = baseline.modules.map((module) => module.path);
    expect(baselinePaths).not.toContain(PROBE_UPLOADER);

    try {
      plantProbe(PROBE_INDEX_SOURCE, 'index.ts', PROBE_UPLOADER_SOURCE, 'uploader.ts');
      expect(existsSync(join(process.cwd(), PROBE_UPLOADER))).toBe(true);

      const withProbe = walkAppGraph({ extraEntries: [PROBE_ENTRY] });
      const probePaths = withProbe.modules.map((module) => module.path);

      // The probe was reached through the walker's own extension and index
      // resolution, and it pulled a real first-party module in through `@/`.
      expect(probePaths).toContain(PROBE_ENTRY);
      expect(probePaths).toContain(PROBE_UPLOADER);
      expect(probePaths).toContain('src/services/persistence/v2/checksum.ts');
      // ...and it changed nothing else: the extra entry and the module it
      // exported are the only new paths.
      //
      // `src/services/persistence/v2/checksum.ts` is NOT in this delta, because
      // Phase 4 routes the application through storage-v2, so that module is
      // already in the baseline graph. The alias resolution this probe exists to
      // prove is therefore checked on its own below, by rooting a walk at the
      // probe, where `checksum.ts` is reachable only through the probe's `@/`
      // specifier.
      expect(probePaths.filter((path) => !baselinePaths.includes(path)).sort()).toEqual(
        [PROBE_ENTRY, PROBE_UPLOADER].sort(),
      );
      const probeOnly = walkAppGraph({ entry: PROBE_ENTRY });
      expect(probeOnly.modules.map((module) => module.path)).toContain(
        'src/services/persistence/v2/checksum.ts',
      );
      expect(withProbe.unresolved).toEqual([]);

      const scan = scanGraphForNetworkRules(withProbe);
      // The upload endpoint, the FormData body, the non-idempotent POST, and
      // the unclassifiable destination are each reported, in the probe module
      // only. Nothing is reported against the real module the probe imported,
      // which is the point of importing it.
      expect(rulesIn(scan.findings, PROBE_UPLOADER)).toEqual([
        'app-endpoint-fetch',
        'formdata-construction',
        'non-idempotent-request',
      ]);
      expect(rulesIn(scan.findings, 'src/services/persistence/v2/checksum.ts')).toEqual([]);
      // The findings carry no destination text, only path, line, and rule.
      const probeFindings = scan.findings.filter((finding) => finding.file === PROBE_UPLOADER);
      expect(probeFindings).toHaveLength(3);
      for (const finding of probeFindings) {
        expect(Object.keys(finding).sort()).toEqual(['destination', 'file', 'line', 'rule']);
        expect(finding.line).toBeGreaterThan(0);
      }
      // A planted POST is counted as a live call site, so "the probe produced
      // findings" cannot be explained by a scan that ignores call sites.
      expect(scan.callSites).toBeGreaterThan(baselineScan().callSites);
    } finally {
      removeProbe();
    }

    // Deleting the probe returns the tree to its prior state.
    expect(existsSync(join(process.cwd(), PROBE_UPLOADER))).toBe(false);
    const afterDelete = walkAppGraph();
    expect(afterDelete.modules.map((module) => module.path)).toEqual(baselinePaths);
    const cleaned = scanGraphForNetworkRules(afterDelete);
    expect(rulesIn(cleaned.findings, PROBE_UPLOADER)).toEqual([]);
    expect(cleaned.findings).toEqual(scanGraphForNetworkRules(baseline).findings);
  });

  it('detects a fetch of a user-supplied external attachment URL', () => {
    const baselinePaths = walkAppGraph().modules.map((module) => module.path);
    const externalModule = 'src/__privacy_probe__/external.ts';

    try {
      plantProbe(
        `export { warmExternalCache } from './external';\n`,
        'index.ts',
        PROBE_EXTERNAL_SOURCE,
        'external.ts',
      );
      const withProbe = walkAppGraph({ extraEntries: [PROBE_ENTRY] });
      const scan = scanGraphForNetworkRules(withProbe);
      const rules = rulesIn(scan.findings, externalModule);

      // One unresolvable destination (the `url` argument) and one absolute
      // external destination that is literally named `url`, which is the
      // shape a learner-supplied attachment URL takes.
      expect(rules).toContain('unresolved-network-destination');
      expect(rules).toContain('absolute-network-destination');
    } finally {
      removeProbe();
    }

    expect(walkAppGraph().modules.map((module) => module.path)).toEqual(baselinePaths);
  });

  it('no module reachable from src/main.tsx can reach an upload endpoint, construct a FormData body, or post off-origin', () => {
    // The interface this reproduction waited on: the Phase 4 application change
    // that replaced `src/ui/components/NoteEditorModal.tsx`'s
    // `fetch('/api/upload', { method: 'POST', body: formData })` with a
    // device-local IndexedDB attachment-bytes write. That landed, so this is now a
    // live assertion.
    const graph = walkAppGraph();
    const scan = scanGraphForNetworkRules(graph);

    // Non-vacuity floor: the scan really classified live call sites, and the
    // only allowed destination is same-origin. Without this, "no findings" would
    // also be consistent with a scan that found no calls at all.
    expect(scan.callSites).toBeGreaterThanOrEqual(2);
    expect(scan.sameOriginCalls).toBeGreaterThanOrEqual(2);
    expect(scan.sameOriginCalls).toBeLessThanOrEqual(scan.callSites);

    // And this file names every one of them itself, rather than deferring to
    // another gate. The two remaining call sites are the real same-origin asset
    // loads, and requiring this exact map means a graph that quietly lost a call
    // site, or gained one, fails here on its own: the floor above would still be
    // satisfied by any single surviving call.
    const perModule = graph.modules
      .map((module) => ({
        path: module.path,
        ...scanModuleForNetworkRules(module.path, readFileSync(join(process.cwd(), module.path), 'utf8')),
      }))
      .filter((entry) => entry.callSites > 0)
      .map((entry) => `${entry.path}:${entry.callSites}`)
      .sort();
    expect(perModule).toEqual([
      'src/services/spriteManifest.ts:1',
      'src/ui/components/MakeItYoursTab.tsx:1',
    ]);

    expect(scan.findings, describeFindings(scan.findings)).toEqual([]);
  });
});

function baselineScan() {
  return scanGraphForNetworkRules(walkAppGraph());
}
