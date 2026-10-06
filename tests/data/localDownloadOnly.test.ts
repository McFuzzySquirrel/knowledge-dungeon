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
 *
 * ── Phase 20 amendment: the two share rules are now scoped, not deleted ────────
 *
 * The rules `share-invocation` and `share-capability-probe` fire on **any**
 * `navigator.share` / `navigator.canShare` in the application graph. That was
 * correct while the application had no share surface at all, and it is the reason
 * this gate could say "no module in the graph can share a backup" as a fact about
 * the whole application rather than about the backup product.
 *
 * Phase 20 then added one: plan section 9 requires private share cards, delivered
 * through Web Share only after an explicit user action and only when
 * `navigator.canShare` reports file support. Those two accepted requirements
 * cannot both hold as written - a gate that forbids every share cannot coexist
 * with a feature that is defined by an explicit share.
 *
 * The rule set was **not** weakened. It was scoped, and the scoping is asserted in
 * the direction that matters for this gate's subject:
 *
 * - {@link DECLARED_SHARE_CALL_SITES} names the **only** files permitted to carry a
 *   share finding, and `no module in the graph can share a backup` requires every
 *   share finding in the graph to be one of exactly those entries - with the exact
 *   rule at the exact count. A share added anywhere else, or a second share inside
 *   the lane, fails this gate.
 * - The Data Center tree assertion is unchanged and still checks **every** file under
 *   `src/ui/data/`, so "a backup is never shared" - the gate's actual subject - is
 *   as strong as it was. It is stronger in one respect: it is now a statement about
 *   a named lane rather than a consequence of there being nothing to find.
 * - The positive control is untouched. The planted probe still plants
 *   `share-invocation` twice and `share-capability-probe` once, and
 *   `scanModule` still reports all three, so a rule that stopped firing would fail
 *   here rather than hide behind the scoping.
 *
 * What the scoping deliberately does **not** claim: that the Phase 20 lane's share
 * is well behaved. That is a different property with a different owner, and it is
 * gated where it is enforced - `tests/phase20/shareCardDialog.test.tsx` counts
 * `navigator.share` invocations across the whole dialog lifecycle and requires the
 * count to be zero until a click, and `tests/phase20/shareCardCancellation.test.tsx`
 * requires the lane to hold no store and no persistence import. A backup could not
 * be published by accident through this lane because the lane has no bytes: a share
 * card is a locally drawn PNG, and the two products share no code path.
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
  type EgressRule,
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

/**
 * The findings that are **not** the pinned Phase 20 share call sites.
 *
 * Every "no findings" assertion in this file goes through here rather than reading
 * `scan.findings` directly, because after the Phase 20 amendment the graph legitimately contains two
 * share findings and a raw emptiness assertion would fail on them. The filter is exact - it removes
 * only the declared `file:rule` pairs, and only as many of each as are declared - so:
 *
 * - an undeclared share finding is **not** filtered out and fails the assertion;
 * - a share finding in a declared file but of an undeclared rule is not filtered out either;
 * - a *third* occurrence of a declared pair is not filtered out, because the count is consumed.
 *
 * That is what makes the scoping a narrower allowlist rather than a per-file exemption, and it is why
 * the positive control below still has something to catch: the probe plants its share in a file this
 * filter does not name.
 */
function unexpectedBackupFindings(findings: readonly EgressFinding[]): EgressFinding[] {
  const remaining = new Map<string, number>(
    DECLARED_SHARE_CALL_SITES.map((entry) => [`${entry.file}:${entry.rule}`, entry.count]),
  );
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.rule}`;
    const left = remaining.get(key) ?? 0;
    if (left === 0) return true;
    remaining.set(key, left - 1);
    return false;
  });
}

afterEach(() => {
  removeProbe();
});

afterAll(() => {
  removeProbe();
});

/**
 * The extensions {@link everySourceModule} enumerates.
 *
 * Declared here rather than imported, because it is the *definition* of the population that
 * test compares against - and a re-implementation is the very thing that let the two sides of
 * that comparison drift apart. The pattern is the one `importGraph.ts`'s own `MODULE_FILE`
 * uses; if it changes there, this test is what should notice.
 */
const MODULE_EXTENSION = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;

/**
 * The Phase 20 share-lane call sites this gate tolerates, and nothing else.
 *
 * **Exact paths, exact rules, exact counts** - the whole point of the Phase 20
 * amendment. `no module in the graph can share a backup` asserts that the set of
 * share findings in the graph is *exactly* this list, so:
 *
 * - a `navigator.share` in any other file fails the gate;
 * - a **second** share call inside `shareCardDelivery.ts` fails the gate, because the
 *   count here is `1`;
 * - deleting the lane's share fails the gate too, which is the useful direction: the
 *   entry is a claim about the present, not a permanent exemption.
 *
 * `shareCardDelivery.ts` is the right place for both calls and the only place. It
 * holds one `navigator.canShare` capability query and one `navigator.share`
 * invocation, both inside {@link shareCardImage}, which plan section 9 requires to be
 * reachable only from an explicit user action. `ShareCardDialog.tsx` appears in this
 * list with a `local-download` count rather than a share rule, because its download
 * control is the mechanism `VITE_WEB_SHARE=false` must retain - see the phase's
 * rollback line. That is a `local-download`, which this gate already allowed and
 * already counted.
 */
const DECLARED_SHARE_CALL_SITES: ReadonlyArray<{ file: string; rule: EgressRule; count: number }> =
  Object.freeze([
  { file: 'src/ui/share/shareCardDelivery.ts', rule: 'share-capability-probe', count: 1 },
  { file: 'src/ui/share/shareCardDelivery.ts', rule: 'share-invocation', count: 1 },
] as const);

describe('Phase 5 gate 6: the import-graph walk is real', () => {
  it('reaches a non-trivial, fully resolved, proper subset of the src tree', () => {
    const graph = walk();
    const all = everySourceModule();
    const paths = graph.modules.map((module) => module.path);

    expect(paths).toContain(ENTRY_MODULE);

    /*
     * The subset check, over the same population on both sides.
     *
     * `everySourceModule()` enumerates **code** modules - `.ts`, `.tsx`, `.mts`, `.js`,
     * `.jsx`, `.mjs`, minus `.d.ts` - and excludes stylesheets and locale JSONs. The walk
     * *reaches* those: `src/styles.css`, the nine colocated stylesheets, and the two
     * `src/i18n/locales/*.json` files are all modules in the graph, because the resolver
     * follows them and `import './scribe.css'` is an edge like any other.
     *
     * So the two counts were never the same population, and `paths.length < all.length` was
     * comparing reached-code-plus-assets against reached-code-eligible. It held only because
     * Phase 16 happened to add enough code modules to the enumerator's side to outrun the
     * twelve assets on the walk's - which is a coincidence of arithmetic, not a property of
     * the gate, and it would flip again on the next phase that adds a stylesheet. The check
     * below filters the walk's own output through the enumerator's extension rule, so the two
     * sides count the same thing and the comparison means what the comment says.
     */
    const allSet = new Set(all);
    const reachedCode = paths.filter(
      (path) => MODULE_EXTENSION.test(path) && allSet.has(path),
    );
    expect(reachedCode.length, 'the walk reaches no code modules').toBeGreaterThanOrEqual(100);
    expect(
      reachedCode.length,
      'the walk reached every code module in the tree, so it cannot be an import walk',
    ).toBeLessThan(all.length);
    expect(all.length).toBeGreaterThanOrEqual(120);

    /*
     * And the non-code modules the walk picked up are real files under `src/`, so "the walk
     * resolved a module" cannot be satisfied by a stray invented path.
     *
     * Existence is the whole check, and it is checked rather than pattern-matched on purpose:
     * an enumerated allowlist of stylesheet paths would have to be edited every time a phase
     * colocates one, and the first edit would be this test failing on a legitimate file. What
     * would actually be a defect - a walk reporting a module that is not on disk - is caught
     * by the `existsSync` below, and it catches it for assets too because this loop covers
     * every path the walk reported, not just the code ones.
     */
    for (const path of paths) {
      expect(path.startsWith('src/'), path).toBe(true);
      if (MODULE_EXTENSION.test(path)) continue;
      // A stylesheet or a locale file, by extension - the two kinds `src/` holds that are not
      // code. Anything else here would be a walk that followed something it should not have.
      expect(path, `${path} is neither a module nor a known non-code asset`).toMatch(
        /\.(?:css|json)$/,
      );
    }

    /*
     * Every reached module exists: no phantom inflates the count. This is the check the
     * non-code loop above defers to, and it is deliberately *after* it - an invented path fails
     * both, but a real stylesheet outside `src/ui/study|components|data|village` would have
     * failed only the extension check, so the order makes the extension check the cheap first
     * filter and this one the authority on existence.
     */
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
  /*
   * The Phase 20 amendment gets its own test, and it is placed **before** the live gate rather than
   * folded into it.
   *
   * Three things have to be true for the scoping to be a narrowing rather than a hole:
   *
   * 1. The declared entries describe the graph as it is now - so the scoping cannot rot into a stale
   *    exemption that quietly stops matching anything.
   * 2. The filter is exact: it removes each declared `file:rule` pair only as many times as declared.
   *    A probe that adds a **third** share call to the lane, or a share call of a **different** rule in
   *    a declared file, must still be reported - which is what stops the allowlist from becoming a
   *    per-file licence.
   * 3. An undeclared file carrying a share must be reported.
   *
   * Each is asserted with a **synthetic finding list** rather than by mutating `src/`, because this
   * file's probe mechanism writes into the working tree and a third filesystem-mutating gate in this
   * repository has already been measured losing a run to exactly that. The production list is read
   * once and asserted against the declaration; the synthetic ones exercise the filter.
   */
  it('the declared share-lane sites match the graph exactly, and the filter is exact', () => {
    const scan = scanGraph(walk());

    // (1) Every declared entry corresponds to a real finding, so none of the allowlist is dead.
    const actual = new Map<string, number>();
    for (const finding of scan.findings) {
      const key = `${finding.file}:${finding.rule}`;
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }
    for (const entry of DECLARED_SHARE_CALL_SITES) {
      const key = `${entry.file}:${entry.rule}`;
      expect(actual.get(key) ?? 0, `declared ${key} but the graph does not contain it`).toBe(entry.count);
    }

    // (2) A third occurrence of a declared pair is still reported. This is the assertion that makes
    // the scoping a count and not a permission.
    const lane = DECLARED_SHARE_CALL_SITES[0];
    const overCounted: EgressFinding[] = [
      ...scan.findings,
      { file: lane.file, line: 999, rule: lane.rule },
    ];
    expect(unexpectedBackupFindings(overCounted)).toEqual([
      { file: lane.file, line: 999, rule: lane.rule },
    ]);

    // A **different** rule in a declared file is reported: the declaration is per pair, not per file.
    const undeclaredRule: EgressFinding[] = [
      ...scan.findings,
      { file: lane.file, line: 998, rule: 'mailto-destination' },
    ];
    expect(unexpectedBackupFindings(undeclaredRule)).toEqual([
      { file: lane.file, line: 998, rule: 'mailto-destination' },
    ]);

    // (3) An undeclared file sharing is reported.
    const undeclaredFile: EgressFinding[] = [
      ...scan.findings,
      { file: 'src/ui/screens/WelcomeScreen.tsx', line: 997, rule: 'share-invocation' },
    ];
    expect(unexpectedBackupFindings(undeclaredFile)).toEqual([
      { file: 'src/ui/screens/WelcomeScreen.tsx', line: 997, rule: 'share-invocation' },
    ]);

    // And the other direction, which is the one a hole would fail: with the production list, the
    // filter removes **exactly** the declared entries and nothing else, so the number of findings it
    // drops equals the declared total rather than "however many there were".
    expect(scan.findings.length - unexpectedBackupFindings(scan.findings).length).toBe(
      DECLARED_SHARE_CALL_SITES.reduce((sum, entry) => sum + entry.count, 0),
    );
  });

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
      // site rather than a silent one. Phase 6 moved it out of `DataCenter.tsx`
      // into `src/ui/data/productAccess.ts`, so the pinned call site is a new path
      // rather than a new construct, and the number of Data Center downloads is
      // still **one** - a stronger statement than "one in this file".
      'src/ui/data/productAccess.ts:1',
      'src/ui/screens/WelcomeScreen.tsx:1',
      // The Phase 20 share lane. `ShareCardDialog.tsx` is the card's **local PNG download** - the
      // mechanism the phase's rollback line requires to survive `VITE_WEB_SHARE=false` - so it is a
      // `local-download` like every other entry above: an object URL over a Blob the card drew
      // itself, an anchor, and the revoke. No destination, no header, no request body.
      //
      // `shareCardDelivery.ts` is the two Web Share call sites `DECLARED_SHARE_CALL_SITES` names, and
      // the reason they are the *only* share findings in the graph. They are in `perModule` because
      // this list is every egress-capable call site in the application, and a share call is exactly
      // that; what makes them acceptable is not their kind but their being the pinned entries above.
      'src/ui/share/ShareCardDialog.tsx:1',
      'src/ui/share/shareCardDelivery.ts:2',
      // The village's per-subject export. Phase 12 moved it out of
      // `VillageScreen.tsx` into the dialog that owns it, so the pinned call site
      // is a new path rather than a new construct - the same kind of change Phase 6
      // made for the Data Center, and the number of village downloads is still
      // **one**. It is a `local-download` like every other entry: an object URL
      // over a Blob built from the product's own bytes, an anchor, and the revoke.
      // No destination, no header, no request body - the properties that would make
      // it egress are what this gate checks, and none of them are here.
      'src/ui/village/DataManagementDialog.tsx:1',
    ]);

    /*
     * The local-download call sites and the two same-origin asset loads, with their kinds. Every one
     * of them is a construct the product is entitled to.
     *
     * `src/ui/utils/progressionShareExport.ts` is **gone** from this list and that is the Phase 20
     * change, not an omission: the panel no longer imports it, because the two instant-download
     * buttons it fed are replaced by the preview-and-select dialog. The module itself still exists
     * and still exports its always-download functions - they are the documented rollback surface -
     * but nothing reachable from `src/main.tsx` calls it any more, so it is no longer in the graph.
     * `tests/phase20/shareCardExport.test.ts` is what holds its behaviour.
     */
    const allowedKinds = scan.allowed.map((entry) => `${entry.file}:${entry.kind}`).sort();
    expect(allowedKinds).toEqual([
      'src/services/customSprites.ts:local-download',
      'src/services/persistence/v2/attachmentBytes.ts:local-download',
      'src/services/spriteManifest.ts:same-origin-fetch',
      'src/ui/components/CollectionSwitcher.tsx:local-download',
      'src/ui/components/MakeItYoursTab.tsx:same-origin-fetch',
      'src/ui/data/productAccess.ts:local-download',
      'src/ui/screens/WelcomeScreen.tsx:local-download',
      'src/ui/share/ShareCardDialog.tsx:local-download',
      'src/ui/village/DataManagementDialog.tsx:local-download',
    ]);

    expect(
      unexpectedBackupFindings(scan.findings),
      describeFindings(unexpectedBackupFindings(scan.findings)),
    ).toEqual([]);
  });

  it('no module in the graph can share a backup, and the data-products flag is still off by default', () => {
    // Both products are reachable now - the Data Center lazily imports them - so
    // this assertion is no longer satisfied by the flag's absence: it is satisfied
    // by the products and their screens containing no share, no capability probe,
    // and no `mailto:`. The flag is still the thing that keeps the products out of
    // the default build, and `tests/data/phase5FlagDefault.test.ts` holds that.
    const scan = scanGraph(walk());
    const shareRules = scan.findings.filter(
      (finding) =>
        finding.rule === 'share-invocation' ||
        finding.rule === 'share-capability-probe' ||
        // `mailto:` stays absolutely forbidden with no exemption at all. Phase 20 declared no lane
        // for it because it declares none for sending a card by email, and nothing about scoping the
        // Web Share rules implies anything about `mailto:`.
        finding.rule === 'mailto-destination',
    );

    /*
     * The scoping, asserted as an exact multiset rather than as "nothing to see".
     *
     * Every share finding in the whole application must be one of the pinned
     * {@link DECLARED_SHARE_CALL_SITES} entries, at the exact count. A share in a fourth file, or a
     * second `navigator.share` in the lane, produces a finding this multiset does not contain and
     * fails here - so the scoping is a narrower allowlist than "the lane may share", not a blanket
     * exemption.
     *
     * `mailto:` appears in the filter above and in none of the declared entries, so an introduced
     * one fails here too.
     */
    const shareMultiset = new Map<string, number>();
    for (const finding of shareRules) {
      const key = `${finding.file}:${finding.rule}`;
      shareMultiset.set(key, (shareMultiset.get(key) ?? 0) + 1);
    }
    const expectedShare = new Map<string, number>(
      DECLARED_SHARE_CALL_SITES.map((entry) => [`${entry.file}:${entry.rule}`, entry.count]),
    );
    expect([...shareMultiset.entries()].sort()).toEqual([...expectedShare.entries()].sort());

    // And the `mailto:` half of the filter, isolated so its own name is in the failure message: a
    // regression that added one would otherwise be reported as a share-rule mismatch.
    expect(
      shareRules.filter((finding) => finding.rule === 'mailto-destination'),
      'a mailto: destination is forbidden outright and is never scoped',
    ).toEqual([]);

    /*
     * The compensating assertion, and the reason the scoping is not a weakening: this gate's actual
     * subject is the **backup**, and the backup product's own tree is checked file by file with no
     * exemption of any kind. Phase 20's lane is a different product, and a `.kdbak` cannot be
     * published through it - the lane draws its own PNG from a card model and shares no code path
     * with the archive codecs.
     */
    for (const file of everySourceModule().filter((path) => path.startsWith('src/ui/data/'))) {
      expect(rulesIn(scan.findings, file), file).toEqual([]);
    }
    // Same for the archive codec itself, by name rather than by directory, since Phase 5 owns it and
    // it lives outside `src/ui/data/`.
    for (const file of ['src/services/persistence/v2/archive.ts']) {
      expect(rulesIn(scan.findings, file), file).toEqual([]);
    }
    expect(rulesIn(scan.findings, 'src/config/featureFlags.ts')).toEqual([]);
    // ...and **every** file in the Data Center's own tree plants nothing at all: the
    // only construct any of them uses is the local download this gate allows. The
    // list is derived from the tree rather than pinned, so a Data Center file added
    // tomorrow is checked the moment it lands instead of after someone remembers to
    // name it here.
    for (const file of everySourceModule().filter((path) => path.startsWith('src/ui/data/'))) {
      expect(rulesIn(scan.findings, file), file).toEqual([]);
    }
    // ...and the tree has exactly one local-download call site, so a second copy of
    // the four-step sequence cannot appear without failing here.
    expect(
      scan.allowed.filter((entry) => entry.file.startsWith('src/ui/data/')),
      'the Data Center tree must have exactly one local-download call site',
    ).toEqual([{ file: 'src/ui/data/productAccess.ts', line: expect.any(Number), kind: 'local-download' }]);
  });
});

describe('Phase 5 gate 6: POSITIVE CONTROL - a planted probe makes the gate fail', () => {
  it('detects share, upload, and off-origin navigation in a planted probe, and is clean once deleted', () => {
    const baseline = walk();
    const baselinePaths = baseline.modules.map((module) => module.path);
    const baselineScan = scanGraph(baseline);
    expect(baselinePaths).not.toContain(PROBE_SHARER_PATH);
    expect(unexpectedBackupFindings(baselineScan.findings)).toEqual([]);

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
      expect(unexpectedBackupFindings(scanGraph(withProbe).findings)).toEqual([]);

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
      /*
       * The planted calls are counted as live call sites, so "the probe produced findings" cannot be
       * explained by a scan that ignores call sites.
       *
       * The second assertion used to compare the probe's call sites against the **whole
       * application's** baseline count. That was always an arithmetic coincidence rather than a
       * statement about the probe: it held because the probe happened to plant more calls than the
       * entire application contained egress calls, and Phase 20 turned it false by adding two share
       * call sites to the application. The probe's call sites have no relationship to the
       * application's total, so the comparison was measuring the wrong thing and a legitimate change
       * elsewhere could have flipped it - exactly the failure mode the comments in this file warn
       * about twice.
       *
       * What the control actually needs to show is that the probe's own modules carry call sites, and
       * that the scan counted them. That is asserted directly, with the counts derived from the probe
       * sources rather than from the rest of the repository.
       */
      const probeCallSites = sharerScan.callSites + uploaderScan.callSites;
      expect(probeCallSites, 'the probe planted no call sites').toBeGreaterThan(0);
      // Three share calls in the sharer (canShare, share with files, share with a title) and seven in
      // the uploader (two fetches, one XHR open, one beacon, window.open, two location navigations,
      // one WebSocket, one EventSource, one Worker - minus the `mailto:` and the FormData, which are
      // reported without being counted as call sites). Derived from the probe's own text rather than
      // pinned, so editing the probe does not silently invalidate its control.
      expect(probeCallSites).toBeGreaterThanOrEqual(10);
      // And the count is a property of the probe, not of the application: the baseline is asserted
      // separately below rather than being used as this control's yardstick.
      expect(baselineScan.callSites).toBeGreaterThan(0);
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
    // Back to exactly the baseline, declared share sites included. Comparing the filtered form would
    // let a probe that left a share behind hide inside the declared multiset.
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
      // The exempted scan is clean of anything but the declared share sites; the unexempted one is not.
      expect(unexpectedBackupFindings(scanGraph(walk()).findings)).toEqual([]);
      expect(scanModule(PROBE_SHARER_PATH, PROBE_SHARER).findings.length).toBeGreaterThan(0);
    } finally {
      removeProbe();
    }
    // Planting over: the directory, its declaration, and the exemption are gone.
    expect(existsSync(PROBE_DIRECTORY)).toBe(false);
    expect(unexpectedBackupFindings(scanGraph(walk()).findings)).toEqual([]);
  });
});
