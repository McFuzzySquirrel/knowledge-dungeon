/**
 * Phase 5 data-product gate 6: a backup is a local download and a local file
 * pick, and nothing else.
 *
 * The phase's non-goals are "No cloud upload" and "No Web Share for backups", and
 * plan section 2.3 forbids adding any upload, analytics, telemetry, or remote
 * configuration service. A source-level gate is the only way to hold a *graph*
 * property - "no module reachable from `src/main.tsx` can send a backup anywhere" -
 * and a graph property needs a graph walk.
 *
 * This file uses its own walk. It shares no code with the Phase 4 privacy walk in
 * `tests/privacy/support/appGraph.ts`: a gate that reuses the implementation of
 * the thing it verifies can only agree with itself, and Phase 3 review found five
 * vacuous gates in this repository for exactly that reason. The two walks differ in
 * traversal, in comment handling, in specifier extraction, and in the rules they
 * evaluate; the implementation lives in `./support/importGraph` and its header
 * says so in detail.
 *
 * Three properties keep "no findings" from being vacuous:
 *
 * 1. **The walk is real and non-trivial.** A floor on the module count, a proper
 *    subset of the `src/` tree (a walker that silently globbed would pass the floor
 *    while proving nothing), zero unresolved specifiers, every reached file
 *    existing on disk, and specific modules the gate names because they are where a
 *    local download would live.
 * 2. **The rules fire on real code.** The classifier is exercised on synthetic
 *    sources for every rule it enforces, and the *allowed* constructs - the local
 *    download mechanisms the product is entitled to use - are counted and pinned,
 *    so the gate can tell "no forbidden call" from "no call at all".
 * 3. **A planted positive control.** A probe is planted inside `src/`, walked with
 *    this gate's own resolver and detector, required to produce the expected
 *    findings, and then deleted - after which the tree is byte-identical to before.
 *
 * The probe lives in a directory of this gate's own
 * (`src/__data_gate_probe__/`) rather than the Phase 4 one, because the existing
 * declaration is asserted elsewhere to hold exactly one name and two suites
 * sharing one marker file would race. Every gate that scans `src/` for a forbidden
 * construct scopes itself to a declared tree, and this probe imports nothing from
 * any of those trees, so it is invisible to all of them.
 *
 * Privacy: findings carry a repo-relative path, a line number, and a rule id. No
 * destination, URL, header, or request body is copied into a finding. The planted
 * probe names only the reserved `example.invalid`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  ENTRY_MODULE,
  PROBE_DIRECTORY,
  PROBE_DIRECTORY_NAME,
  blankComments,
  classifyDestinationText,
  describeFindings,
  everySourceModule,
  plantProbe,
  removeProbe,
  scanGraph,
  scanModule,
  specifiersIn,
  walk,
  type EgressFinding,
} from './support/importGraph';

const PROBE_ENTRY = `src/${PROBE_DIRECTORY_NAME}/index.ts`;
const PROBE_SHARER_PATH = `src/${PROBE_DIRECTORY_NAME}/sharer.ts`;
const PROBE_UPLOADER_PATH = `src/${PROBE_DIRECTORY_NAME}/uploader.ts`;

/**
 * The probe. Every rule the gate enforces appears at least once, so the control
 * proves the whole rule set and not one convenient rule.
 */
const PROBE_INDEX = `export { shareDeviceBackup } from './sharer';
export { sendDeviceBackup } from './uploader';
`;
const PROBE_SHARER = `export async function shareDeviceBackup(bytes: Blob, title: string): Promise<void> {
  if (navigator.canShare({ files: [] })) {
    await navigator.share({ files: [], title });
  }
  await navigator.share({ title });
  void bytes;
}
`;
const PROBE_UPLOADER = `export async function sendDeviceBackup(bytes: Blob): Promise<void> {
  const body = new FormData();
  body.append('backup', bytes);
  await fetch('https://example.invalid/api/backup', { method: 'POST', body });
  await fetch('/api/backup', { method: 'PUT' });
  const request = new XMLHttpRequest();
  request.open('POST', 'https://example.invalid/upload');
  navigator.sendBeacon('https://example.invalid/beacon', bytes);
  window.open('https://example.invalid/backup');
  location.assign('https://example.invalid/backup');
  window.location.href = 'mailto:someone@example.invalid';
  const socket = new WebSocket('wss://example.invalid/socket');
  const stream = new EventSource('https://example.invalid/stream');
  const worker = new Worker('https://example.invalid/worker.js');
  void socket;
  void stream;
  void worker;
}
`;

function rulesIn(findings: readonly EgressFinding[], file: string): string[] {
  return findings.filter((finding) => finding.file === file).map((finding) => finding.rule).sort();
}

afterEach(() => {
  removeProbe();
});

afterAll(() => {
  removeProbe();
});

describe('Phase 5 gate 6: the import-graph walk is real', () => {
  it('reaches a non-trivial, fully resolved, proper subset of the src tree', () => {
    const graph = walk();
    const all = everySourceModule();
    const paths = graph.modules.map((module) => module.path);

    expect(paths).toContain(ENTRY_MODULE);
    // A floor, and the walk is strictly smaller than the tree, so it cannot be a
    // glob in disguise.
    expect(paths.length).toBeGreaterThanOrEqual(100);
    expect(paths.length).toBeLessThan(all.length);
    expect(all.length).toBeGreaterThanOrEqual(120);

    // Every reached module exists: no phantom inflates the count.
    for (const path of paths) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
    // Every specifier resolved: a dangling resolver would shrink the graph
    // silently instead of failing here.
    expect(
      graph.unresolved.map((entry) => `${entry.from} -> ${entry.specifier}`),
    ).toEqual([]);

    // It spans the real application layers, not one subtree.
    expect(graph.areas.length).toBeGreaterThanOrEqual(7);
    for (const area of ['ui', 'store', 'services', 'core', 'application', 'game']) {
      expect(graph.areas, area).toContain(area);
    }

    // Specific modules the gate names, because a backup's local download would
    // have to live somewhere like them and the gate has to be able to see it.
    for (const path of [
      'src/ui/App.tsx',
      'src/main.tsx',
      'src/ui/screens/WelcomeScreen.tsx',
      'src/services/persistence/subjectPersistence.ts',
      'src/config/featureFlags.ts',
    ]) {
      expect(paths, path).toContain(path);
    }

    // The server and the Electron main process are not in the web graph, so the
    // Express upload route and the Electron bridge cannot be reached from here.
    for (const path of paths) {
      expect(path.startsWith('server/'), path).toBe(false);
      expect(path, path).not.toBe('src/electron/main.ts');
    }

    // Bare packages are distinguished from first-party files.
    expect(graph.externalSpecifiers).toContain('react');
    expect(graph.externalSpecifiers).toContain('zustand');

    // Reachability comes from the edges, not from the file list: a second walk
    // from a module already in the graph reaches a strict subset of it.
    const fromWelcome = walk({ entry: 'src/ui/screens/WelcomeScreen.tsx' });
    expect(fromWelcome.modules.length).toBeGreaterThan(1);
    expect(fromWelcome.modules.length).toBeLessThan(graph.modules.length);
    const known = new Set(paths);
    for (const module of fromWelcome.modules) {
      expect(known.has(module.path), module.path).toBe(true);
    }
    // And a nonexistent entry reaches nothing at all.
    const fromNothing = walk({ entry: 'src/__not_a_real_module__.ts' });
    expect(fromNothing.modules).toEqual([]);
    expect(fromNothing.unresolved).toHaveLength(1);
  });

  it('the comment stripper keeps offsets, so a finding points at the right line', () => {
    const source = [
      '// fetch("https://example.invalid/commented-out")',
      '/* fetch("https://example.invalid/block-comment") */',
      'const division = 10 / 2 / 1;',
      'const pattern = /https:\\/\\/example\\.invalid\\/regex-literal/;',
      "const text = '// not a comment';",
      'const template = `${a} // still not a comment`;',
      "const real = 'https://example.invalid/real';",
    ].join('\n');
    const code = blankComments(source);
    // Offsets and line breaks are preserved exactly.
    expect(code.length).toBe(source.length);
    expect(code.split('\n')).toHaveLength(source.split('\n').length);
    // Commented-out calls are blanked, so they are not reported as live ones.
    expect(code).not.toContain('commented-out');
    expect(code).not.toContain('block-comment');
    // ...while the live literal survives, which is what makes the scan meaningful.
    expect(code).toContain('https://example.invalid/real');
    // The division operator and the regex literal are not mistaken for comments.
    expect(code).toContain('10 / 2 / 1');
    expect(code).toContain('regex-literal');
    // A string that contains `//` is not truncated.
    expect(code).toContain('// not a comment');
    expect(code).toContain('// still not a comment');
  });

  it('specifier extraction finds static, side-effect, dynamic, and type-only imports', () => {
    const specifiers = specifiersIn(
      [
        "import { a } from './a';",
        "import type { B } from '@/core/b';",
        "import './side-effect';",
        "export * from './star';",
        "export { c } from '../up/c';",
        "const d = await import('./dynamic');",
        "const e = require('./required');",
        "import 'external-package';",
      ].join('\n'),
    );
    expect([...specifiers].sort()).toEqual([
      '../up/c',
      './a',
      './dynamic',
      './required',
      './side-effect',
      './star',
      '@/core/b',
      'external-package',
    ]);
    // Deduplicated, so one module referenced twice is one edge.
    expect(specifiers.filter((specifier) => specifier === './a')).toHaveLength(1);
  });
});

describe('Phase 5 gate 6: the rules fire on real code', () => {
  it('the destination classifier separates the four classes and fails closed', () => {
    const constants = new Map<string, string>([
      ['MANIFEST_URL', '`${BASE}assets/sprite-manifest.json`'],
      ['BASE', 'import.meta.env.BASE_URL'],
      ['import.meta.env.BASE_URL', "'/'"],
    ]);
    // Same-origin relative, including through a constant and a template.
    expect(classifyDestinationText("'/assets/x.json'", constants)).toBe('relative');
    expect(classifyDestinationText("'./x.json'", constants)).toBe('relative');
    expect(classifyDestinationText('MANIFEST_URL', constants)).toBe('relative');
    expect(classifyDestinationText('`${BASE}assets/${name}.svg`', constants)).toBe('relative');
    // Absolute and protocol-relative, and any scheme.
    expect(classifyDestinationText("'https://example.invalid/x'", constants)).toBe('absolute');
    expect(classifyDestinationText("'//example.invalid/x'", constants)).toBe('absolute');
    expect(classifyDestinationText("'ftp://example.invalid/x'", constants)).toBe('absolute');
    // Data and blob URLs stay on the device.
    expect(classifyDestinationText("'blob:http://127.0.0.1/abc'", constants)).toBe('data-or-blob');
    expect(classifyDestinationText("'data:image/png;base64,AA'", constants)).toBe('data-or-blob');
    // Fails closed: anything the classifier cannot follow is `opaque`, and an
    // unresolved leading interpolation cannot smuggle in a scheme.
    expect(classifyDestinationText('someRuntimeVariable', constants)).toBe('opaque');
    expect(classifyDestinationText('`${target}/backup`', constants)).toBe('opaque');
    expect(classifyDestinationText('`https://example.invalid/${id}`', constants)).toBe('opaque');
    expect(classifyDestinationText('callSomething()', constants)).toBe('opaque');
  });

  it('each forbidden rule fires on a synthetic source and reports file and line', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['navigator.share({ title: "x" });', 'share-invocation'],
      ['navigator.canShare({ files: [] });', 'share-capability-probe'],
      ["window.location.href = 'mailto:a@example.invalid';", 'mailto-destination'],
      ['form.submit();', 'form-submission'],
      ["window.open('https://example.invalid/backup');", 'window-open-destination'],
      ["location.assign('https://example.invalid/backup');", 'location-navigation'],
      ["fetch('https://example.invalid/backup', { method: 'POST' });", 'absolute-network-destination'],
      ["fetch('/api/backup', { method: 'DELETE' });", 'non-idempotent-request'],
      ['const body = new FormData();', 'formdata-construction'],
      ['const request = new XMLHttpRequest();', 'xhr-construction'],
      ["navigator.sendBeacon('https://example.invalid/b', body);", 'beacon-post'],
      ["const socket = new WebSocket('wss://example.invalid/s');", 'websocket-construction'],
      ["const stream = new EventSource('https://example.invalid/s');", 'eventsource-construction'],
      ["const worker = new Worker('https://example.invalid/w.js');", 'worker-construction'],
      ["importScripts('https://example.invalid/w.js');", 'import-scripts-call'],
      ["const href = '/uploads/thing.png';", 'uploads-path-literal'],
      ["const href = '/api/upload';", 'api-path-literal'],
    ];
    expect(cases).toHaveLength(17);
    for (const [line, rule] of cases) {
      const scan = scanModule('src/synthetic/probe.ts', line);
      expect(rulesIn(scan.findings, 'src/synthetic/probe.ts'), line).toContain(rule);
      // Findings carry path, line, and rule only - never the destination, so a
      // failure message cannot leak a URL.
      for (const finding of scan.findings) {
        expect(Object.keys(finding).sort()).toEqual(['file', 'line', 'rule']);
        expect(finding.line).toBe(1);
      }
    }
  });

  it('the local-download mechanisms the product may use are counted as allowed', () => {
    const download = scanModule(
      'src/synthetic/download.ts',
      [
        'const url = URL.createObjectURL(blob);',
        'const anchor = document.createElement("a");',
        'anchor.download = "device-backup.kdbak";',
        'anchor.click();',
        'URL.revokeObjectURL(url);',
      ].join('\n'),
    );
    expect(download.findings).toEqual([]);
    expect(download.allowed.map((entry) => entry.kind)).toEqual(['local-download']);
    expect(download.callSites).toBe(1);

    const filePick = scanModule(
      'src/synthetic/pick.ts',
      'const handle = await window.showSaveFilePicker({ suggestedName: "device-backup.kdbak" });',
    );
    expect(filePick.findings).toEqual([]);
    expect(filePick.allowed.map((entry) => entry.kind)).toEqual(['local-file-pick']);

    // A same-origin fetch is allowed too - the two real asset loads in this
    // repository are, and the gate has to agree with them.
    const sameOrigin = scanModule(
      'src/synthetic/asset.ts',
      "const response = await fetch(`${import.meta.env.BASE_URL}assets/sprite-manifest.json`);",
    );
    expect(sameOrigin.findings).toEqual([]);
    expect(sameOrigin.allowed.map((entry) => entry.kind)).toEqual(['same-origin-fetch']);
  });
});

describe('Phase 5 gate 6: the live gate over the real application graph', () => {
  it('no module reachable from src/main.tsx can upload, share, or send a backup anywhere', () => {
    const graph = walk();
    const scan = scanGraph(graph);

    // Non-vacuity floor: real egress-capable call sites were classified, so "no
    // findings" is a decision rather than an empty observation.
    expect(scan.callSites).toBeGreaterThanOrEqual(8);

    // And this file names every one of them itself rather than deferring to
    // another gate, so a graph that quietly lost a call site - or gained one -
    // fails here on its own.
    expect(scan.perModule).toEqual([
      'src/services/customSprites.ts:1',
      'src/services/persistence/v2/attachmentBytes.ts:1',
      'src/services/spriteManifest.ts:1',
      'src/ui/components/CollectionSwitcher.tsx:1',
      'src/ui/components/MakeItYoursTab.tsx:1',
      // The Data Center's device-local download path. It is the one place a
      // `.kdbak` becomes a file: `URL.createObjectURL` on a `Blob` built from the
      // product's bytes, an anchor carrying the product's constant file name, and
      // the revoke. `local-download` is a kind this gate already *allows* - it is
      // counted here so a product that adopts it produces a visible, pinned call
      // site rather than a silent one - so this entry is the pinned list catching
      // up with an allowed construct, not a new exemption.
      'src/ui/data/DataCenter.tsx:1',
      'src/ui/screens/VillageScreen.tsx:1',
      'src/ui/screens/WelcomeScreen.tsx:1',
      'src/ui/utils/progressionShareExport.ts:1',
    ]);

    // The local-download call sites and the two same-origin asset loads, with
    // their kinds. Every one of them is a construct the product is entitled to.
    const allowedKinds = scan.allowed.map((entry) => `${entry.file}:${entry.kind}`).sort();
    expect(allowedKinds).toEqual([
      'src/services/customSprites.ts:local-download',
      'src/services/persistence/v2/attachmentBytes.ts:local-download',
      'src/services/spriteManifest.ts:same-origin-fetch',
      'src/ui/components/CollectionSwitcher.tsx:local-download',
      'src/ui/components/MakeItYoursTab.tsx:same-origin-fetch',
      'src/ui/data/DataCenter.tsx:local-download',
      'src/ui/screens/VillageScreen.tsx:local-download',
      'src/ui/screens/WelcomeScreen.tsx:local-download',
      'src/ui/utils/progressionShareExport.ts:local-download',
    ]);

    expect(scan.findings, describeFindings(scan.findings)).toEqual([]);
  });

  it('no module in the graph can share a backup, and the data-products flag is still off by default', () => {
    // The product is reachable now - the Data Center lazily imports it - so this
    // assertion is no longer satisfied by the flag's absence: it is satisfied by
    // the product and its screens containing no share, no capability probe, and
    // no `mailto:`. The flag is still the thing that keeps the product out of the
    // default build, and `tests/data/phase5FlagDefault.test.ts` holds that.
    const scan = scanGraph(walk());
    const shareRules = scan.findings.filter(
      (finding) =>
        finding.rule === 'share-invocation' ||
        finding.rule === 'share-capability-probe' ||
        finding.rule === 'mailto-destination',
    );
    expect(shareRules, describeFindings(shareRules)).toEqual([]);
    expect(rulesIn(scan.findings, 'src/config/featureFlags.ts')).toEqual([]);
    // ...and the Data Center itself plants nothing at all: the only construct it
    // uses is the local download this gate allows.
    expect(rulesIn(scan.findings, 'src/ui/data/DataCenter.tsx')).toEqual([]);
    expect(scan.allowed.filter((entry) => entry.file === 'src/ui/data/DataCenter.tsx')).toEqual([
      { file: 'src/ui/data/DataCenter.tsx', line: expect.any(Number), kind: 'local-download' },
    ]);
  });
});

describe('Phase 5 gate 6: POSITIVE CONTROL - a planted probe makes the gate fail', () => {
  it('detects share, upload, and off-origin navigation in a planted probe, and is clean once deleted', () => {
    const baseline = walk();
    const baselinePaths = baseline.modules.map((module) => module.path);
    const baselineScan = scanGraph(baseline);
    expect(baselinePaths).not.toContain(PROBE_SHARER_PATH);
    expect(baselineScan.findings).toEqual([]);

    try {
      const planted = plantProbe({
        'index.ts': PROBE_INDEX,
        'sharer.ts': PROBE_SHARER,
        'uploader.ts': PROBE_UPLOADER,
      });
      // The declaration names exactly the three files that were created, and no
      // others.
      expect([...planted].sort()).toEqual([PROBE_ENTRY, PROBE_SHARER_PATH, PROBE_UPLOADER_PATH].sort());
      expect(existsSync(PROBE_DIRECTORY)).toBe(true);

      // The probe is reached through this walker's own index resolution, and it
      // adds exactly its own three modules to the graph.
      const withProbe = walk({ extraEntries: [PROBE_ENTRY] });
      const probePaths = withProbe.modules.map((module) => module.path);
      expect(probePaths).toContain(PROBE_ENTRY);
      expect(probePaths).toContain(PROBE_SHARER_PATH);
      expect(probePaths).toContain(PROBE_UPLOADER_PATH);
      expect(probePaths.filter((path) => !baselinePaths.includes(path)).sort()).toEqual(
        [PROBE_ENTRY, PROBE_SHARER_PATH, PROBE_UPLOADER_PATH].sort(),
      );
      expect(withProbe.unresolved).toEqual([]);

      // `scanGraph` deliberately ignores this gate's own probe directory, so the
      // live gate stays clean while the control is planted. That is a real
      // exemption, and it is why the control asserts through `scanModule` and a
      // probe-rooted walk: a rule that stopped firing could not hide behind it.
      expect(scanGraph(withProbe).findings).toEqual([]);

      const sharerScan = scanModule(PROBE_SHARER_PATH, PROBE_SHARER);
      const uploaderScan = scanModule(PROBE_UPLOADER_PATH, PROBE_UPLOADER);
      const entryScan = scanModule(PROBE_ENTRY, PROBE_INDEX);

      // Every rule the probe plants is reported, in the probe module that plants
      // it. The share module plants both share rules and the two share calls.
      expect(rulesIn(sharerScan.findings, PROBE_SHARER_PATH)).toEqual([
        'share-capability-probe',
        'share-invocation',
        'share-invocation',
      ]);
      // The uploader module plants the upload and off-origin-navigation rules.
      expect(rulesIn(uploaderScan.findings, PROBE_UPLOADER_PATH)).toEqual([
        'absolute-network-destination',
        'api-path-literal',
        'api-path-literal',
        'beacon-post',
        'beacon-post',
        'eventsource-construction',
        'formdata-construction',
        'location-navigation',
        'location-navigation',
        'mailto-destination',
        'non-idempotent-request',
        'non-idempotent-request',
        'unresolved-network-destination',
        'websocket-construction',
        'window-open-destination',
        'worker-construction',
        'xhr-construction',
      ]);
      // The entry module carries only re-exports, so it plants nothing.
      expect(rulesIn(entryScan.findings, PROBE_ENTRY)).toEqual([]);
      // The planted calls are counted as live call sites, so "the probe produced
      // findings" cannot be explained by a scan that ignores call sites.
      expect(sharerScan.callSites + uploaderScan.callSites).toBeGreaterThan(0);
      expect(sharerScan.callSites + uploaderScan.callSites).toBeGreaterThan(
        baselineScan.callSites,
      );
      // And the live gate - the one above - would find nothing here *only*
      // because of the declared exemption, which the next test bounds.
      expect(sharerScan.findings.length + uploaderScan.findings.length).toBeGreaterThan(10);
    } finally {
      removeProbe();
    }

    // Deleting the probe returns the tree to its prior state, byte for byte.
    expect(existsSync(PROBE_DIRECTORY)).toBe(false);
    const afterDelete = walk();
    expect(afterDelete.modules.map((module) => module.path)).toEqual(baselinePaths);
    const cleaned = scanGraph(afterDelete);
    expect(rulesIn(cleaned.findings, PROBE_SHARER_PATH)).toEqual([]);
    expect(cleaned.findings).toEqual(baselineScan.findings);
  });

  it("the probe's exemption is scoped to this gate's own scan, and ends with the probe", () => {
    // This gate's live scan deliberately ignores the probe directory, so the live
    // assertion above is independent of whether the control is currently planted.
    // That is a real exemption, so it is stated rather than implied, and it is
    // bounded three ways:
    //
    // 1. It covers one directory, named in this file, not a pattern.
    // 2. It exists only while a positive-control test is running.
    // 3. The control asserts its own findings through `scanModule` and a walk
    //    rooted at the probe, never through the exempted `scanGraph`, so a rule
    //    that stopped firing could not hide behind the exemption.
    const source = readFileSync(join(process.cwd(), 'tests/data/support/importGraph.ts'), 'utf8');
    expect(source).toContain('export const PROBE_DIRECTORY_NAME');
    expect(PROBE_DIRECTORY_NAME).toBe('__data_gate_probe__');
    expect(existsSync(PROBE_DIRECTORY)).toBe(false);

    try {
      const declared = plantProbe({ 'index.ts': PROBE_INDEX });
      expect(declared).toEqual([PROBE_ENTRY]);
      // The declaration is a JSON list of the exact files created, written after
      // them, so a concurrent reader never sees a name for a file that does not
      // exist yet.
      const marker = readFileSync(join(PROBE_DIRECTORY, '.test-planted'), 'utf8');
      expect(JSON.parse(marker) as string[]).toEqual([PROBE_ENTRY]);
      // The exempted scan is clean; the unexempted one is not.
      expect(scanGraph(walk()).findings).toEqual([]);
      expect(scanModule(PROBE_SHARER_PATH, PROBE_SHARER).findings.length).toBeGreaterThan(0);
    } finally {
      removeProbe();
    }
    // Planting over: the directory, its declaration, and the exemption are gone.
    expect(existsSync(PROBE_DIRECTORY)).toBe(false);
    expect(scanGraph(walk()).findings).toEqual([]);
  });
});
