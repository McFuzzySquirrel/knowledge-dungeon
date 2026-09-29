/**
 * Phase 7 data-product gate 24: the `.kdtemplate` product is renderer-neutral, needs no
 * archive codec, and is not reachable from the application graph.
 *
 * Three boundaries, each asserted against the **real module graph** rather than against a
 * list of file names, so a product module imported from anywhere is caught whichever file
 * did the importing.
 *
 * 1. **No renderer.** Plan section 12, rule 8: "Do not allow renderer imports into
 *    `src/core/` or renderer-neutral application modules." The product lives in the
 *    data-product tree, which `eslint.config.js` already declares renderer-neutral, and
 *    this gate walks the graph reachable *from the product itself* - the transitive
 *    closure, which is the property that matters - and finds no `pixi.js`, no `phaser`, and
 *    no module under `src/game/`. The walk is this gate's own resolver rather than a shared
 *    one: a gate that reuses the implementation of the thing it verifies can only agree with
 *    itself, and this repository has a history of vacuous gates.
 *
 * 2. **No archive codec, and no network.** This is the boundary Phase 7 actually had to
 *    decide rather than inherit. Plan section 7.3 specifies `.kdtemplate` as **JSON**, so
 *    the product needs no ZIP at all, and a ZIP wrapper around a graph-only allowlisted
 *    document would add a codec, a member layout, a path-safety surface and a
 *    compression-ratio surface to a product whose whole claim is that it holds a small
 *    fixed graph. So the gate asserts what "no codec" means mechanically: neither the
 *    product nor anything in its closure names `fflate`, the ZIP codec module, or the other
 *    product that would drag it in - and it walks the **external** specifiers of the whole
 *    closure, which is where a codec would have to appear. It also runs the shared egress
 *    rules over the closure, so no upload, share, beacon, or off-origin navigation is
 *    reachable from a product that is handed a whole subject snapshot.
 *
 *    `archive.ts`'s module header used to name `.kdtemplate` as one of its three products.
 *    Phase 7 corrects that comment, and the last test in this file asserts the correction
 *    is **in the file**, so the documentation and the gate cannot drift apart silently.
 *
 * 3. **Not eagerly reachable, and no ambient anything.** `VITE_DATA_PRODUCTS_V2` owns this
 *    product and plan section 11 keeps new data products opt-in. Since the Phase 7 cutover
 *    landed the Data Center's template tab, one module outside the product tree names the
 *    product - and it names it by **`dynamic` import only**: the value is fetched when a
 *    learner actually presses a template control, and every reference is either a value
 *    `import()` of a string literal or a type-position `import()` that TypeScript erases.
 *    The permitted caller set is therefore a **pinned list of named dynamic callers with no
 *    `static`, `require`, or side-effect edge anywhere**, rather than the empty list this
 *    file asserted before the tab existed. The non-vacuity control is the pair of tests at
 *    the end: a synthetic source that produces all five edge kinds, and a second assertion
 *    that the pinned list is non-empty *and* that a classifier which matched nothing could
 *    not pass it.
 *    The product is also required to read no clock and call no random source: asserted on
 *    the source text, with the non-vacuity control that the *legacy* template path in
 *    `subjectPersistence.ts` - which does read a clock and does mint from `Date.now()` and
 *    `Math.random()` - is required to contain all three, so the rule is known to be able to
 *    fire.
 *
 * Privacy: findings carry a repo-relative path, a line number, and a rule id. The synthetic
 * source names only the reserved `example.invalid`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  blankComments,
  classifySpecifierEdges,
  describeFindings,
  filesReaching,
  scanModule,
  specifiersIn,
  walk,
} from './support/importGraph';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');

/** The plan's Phase 7 expected file, as a repo-relative path. */
export const PHASE_7_MODULE = 'src/services/persistence/products/subjectTemplate.ts';

/** The product tree, which is the boundary this gate measures reachability against. */
const PRODUCTS_TREE = 'src/services/persistence/products/';

/** The module the legacy, pre-Phase-7 template path lives in. */
export const LEGACY_PERSISTENCE_MODULE = 'src/services/persistence/subjectPersistence.ts';

/**
 * The one module outside the product tree that is allowed to name the product, and why.
 *
 * **Pinned, not derived.** A list derived from the walk would pass by construction - a
 * classifier that recognised nothing, or a resolver that silently stopped resolving, would
 * produce an empty walk and an empty derived list and agree with each other. Pinning the
 * module name instead means the day a second caller appears, or this one disappears, the
 * assertion below fails *by name* and says which way it moved.
 *
 * Three value `dynamic` imports and one erased type import is what Phase 7's tab contains:
 * the export, the inspection, and the import each fetch the product at the moment of use,
 * and the two type aliases cost a flag-off build nothing. A `static` edge here would put
 * the product - and the storage-v2 schema, the canonical serializer, the tag rule, and the
 * id remapper it reaches - into the entry chunk, which is exactly what plan section 11's
 * "new data products are opt-in" forbids.
 */
export const PERMITTED_PRODUCT_CALLERS: readonly string[] = ['src/ui/data/SubjectTemplateTab.tsx'];

/** The edge kinds that put a module in the graph at build time, before any code runs. */
const EAGER_EDGE_KINDS = ['static', 'side-effect', 'require'] as const;

/** Where a renderer lives, and where its absence is checked. */
const RENDERER_PACKAGES = ['pixi.js', '@pixi/', 'phaser', 'exphaser', 'koreographer'];

/**
 * Modules every Phase 7 product closure must reach.
 *
 * The storage-v2 schema the product's typed refusals are built from, the canonical JSON
 * serializer it writes with, the room-graph tag rule it reuses, the prototype-name rule it
 * shares with the other two products, and the identifier primitives it shares with the
 * `.kdsubject` copy remapper.
 *
 * `v2/prototypeNames.ts` is in the list rather than `products/archiveValidation.ts`, and that
 * is a finding this gate produced rather than a choice made in advance: the prototype-name
 * rule started inside the archive validator, and the archive validator imports the ZIP codec
 * - so a JSON product that needed only a two-clause predicate had `fflate` in its static
 * closure. The rule's definition moved to a leaf, and both this list and the Phase 6 gate's
 * equivalent were updated to name it. See `src/services/persistence/v2/prototypeNames.ts`.
 */
const REQUIRED_IN_CLOSURE = [
  'src/services/persistence/v2/checksum.ts',
  'src/services/persistence/v2/schema.ts',
  'src/services/persistence/v2/repository.ts',
  'src/core/validation/persistence/types.ts',
  'src/core/graph/tagDomain.ts',
  'src/services/persistence/v2/prototypeNames.ts',
  'src/services/persistence/products/idRemapping.ts',
];

/**
 * The archive surface the closure must **not** reach.
 *
 * The ZIP codec itself, and the two sibling products that would pull it in. This list is the
 * mechanical statement of the JSON-versus-codec decision, and it is worth being explicit
 * about why the two sibling product modules are on it rather than only `archive.ts`: a
 * single static re-export from `subjectBackup.ts` - which is tempting, because it publishes
 * the live-device accessors - would put `fflate` in this product's closure and in the
 * bundle that a template export loads. The product therefore reaches the repository and the
 * per-record writer directly and re-exports nothing from its siblings.
 */
const FORBIDDEN_IN_CLOSURE = [
  'src/services/persistence/v2/archive.ts',
  'src/services/persistence/products/subjectBackup.ts',
  'src/services/persistence/products/fullDeviceBackup.ts',
  'src/services/persistence/products/hostileZip.ts',
];

/** Packages that would mean an archive codec had been pulled into a JSON product. */
const CODEC_PACKAGES = ['fflate', 'fflate/', 'jszip', 'jszip/', 'adm-zip', 'yauzl', 'yazl'];

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

function resolveFirstParty(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toPosix(relative(REPO_ROOT, candidate));
    }
  }
  return toPosix(relative(REPO_ROOT, base));
}

/** The transitive closure of first-party modules reachable from an entry module. */
function closureOf(entryPath: string): { paths: string[]; externals: string[] } {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    const absolute = join(REPO_ROOT, path);
    if (!existsSync(absolute)) continue;
    seen.add(path);
    for (const specifier of specifiersIn(readFileSync(absolute, 'utf8'))) {
      const target = resolveFirstParty(absolute, specifier);
      if (target === null) {
        externals.add(specifier);
        continue;
      }
      queue.push(target);
    }
  }
  return { paths: [...seen].sort(), externals: [...externals].sort() };
}

describe('Phase 7 gate 24: the template product is renderer-neutral', () => {
  it('its closure reaches no renderer, and no module in the renderer tree', () => {
    const { paths, externals } = closureOf(PHASE_7_MODULE);
    // Non-vacuity: the closure is a real product closure, not one file.
    expect(paths.length).toBeGreaterThanOrEqual(12);
    for (const required of REQUIRED_IN_CLOSURE) {
      expect(paths, `the product must reach ${required}`).toContain(required);
    }
    for (const external of externals) {
      for (const forbidden of RENDERER_PACKAGES) {
        expect(
          external === forbidden || external.startsWith(forbidden),
          `${PHASE_7_MODULE} -> ${external}`,
        ).toBe(false);
      }
    }
    for (const path of paths) {
      expect(path.startsWith('src/game/'), path).toBe(false);
      expect(path, path).not.toBe('src/main.tsx');
    }
    // The application graph is not reachable *from* the product either, so the closure is
    // really bounded by the storage-v2 and core trees.
    expect(paths.some((path) => path.startsWith('src/ui/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('src/application/'))).toBe(false);
  });
});

describe('Phase 7 gate 24: a JSON product needs no archive codec', () => {
  it('neither the product nor its closure names a ZIP module or a codec package', () => {
    const { paths, externals } = closureOf(PHASE_7_MODULE);
    for (const forbidden of FORBIDDEN_IN_CLOSURE) {
      expect(paths, `the template product must not reach ${forbidden}`).not.toContain(forbidden);
    }
    // The external-specifier walk is the real test: a codec would have to arrive as a
    // package import, and this is where the check has to be or it is checking nothing.
    for (const external of externals) {
      for (const codec of CODEC_PACKAGES) {
        expect(
          external === codec || external.startsWith(codec),
          `${PHASE_7_MODULE} -> ${external}`,
        ).toBe(false);
      }
    }
    // The product's *own* specifiers name the repository, the serializer, the schema, the
    // core types, the tag rule, and the two shared product primitives - and nothing else
    // from the product tree. Stated positively, because a negative-only assertion here would
    // be satisfied by a product that imported nothing at all.
    const own = specifiersIn(readFileSync(join(REPO_ROOT, PHASE_7_MODULE), 'utf8')).map((specifier) =>
      resolveFirstParty(join(REPO_ROOT, PHASE_7_MODULE), specifier),
    );
    expect(own).toContain('src/services/persistence/v2/checksum.ts');
    expect(own).toContain('src/services/persistence/v2/schema.ts');
    expect(own).toContain('src/services/persistence/v2/repository.ts');
    expect(own).toContain('src/core/graph/tagDomain.ts');
    expect(own).toContain('src/services/persistence/v2/prototypeNames.ts');
    expect(own).toContain('src/services/persistence/products/idRemapping.ts');
    // ...and specifically *not* the archive validator, whose ZIP codec is the whole reason
    // the prototype-name rule was extracted. Asserted as an absence on the product's own
    // specifiers as well as on its closure above, because the closure check would also pass
    // for a product that reached the codec by a longer chain.
    expect(own).not.toContain('src/services/persistence/products/archiveValidation.ts');
    // ...and no sibling product module, which is the part that would drag `fflate` in.
    for (const specifier of specifiersIn(readFileSync(join(REPO_ROOT, PHASE_7_MODULE), 'utf8'))) {
      const target = resolveFirstParty(join(REPO_ROOT, PHASE_7_MODULE), specifier);
      if (target === null) continue;
      if (!target.startsWith(PRODUCTS_TREE)) continue;
      expect(['subjectBackup.ts', 'fullDeviceBackup.ts'], target).not.toContain(target);
    }
  });

  it('the product returns text and a constant name, and never builds a file itself', () => {
    // The local-download mechanism Phase 5 allows a product to *describe* and the user
    // interface to *perform*. A product that created an object URL or clicked an anchor
    // would be doing the interface's job, and would be the one place a `.kdtemplate` could
    // reach the DOM.
    const source = blankComments(readFileSync(join(REPO_ROOT, PHASE_7_MODULE), 'utf8'));
    for (const forbidden of [
      'createObjectURL',
      'revokeObjectURL',
      'createElement',
      'showSaveFilePicker',
      'showOpenFilePicker',
      '.click()',
      'document.',
      'window.',
      'localStorage',
      'indexedDB',
      'fetch',
      'XMLHttpRequest',
      'sendBeacon',
      'WebSocket',
      'navigator.share',
      'navigator.canShare',
      'FormData',
    ]) {
      expect(source, `the product must not use ${forbidden}`).not.toContain(forbidden);
    }
    // ...and it does hand back text and a name, which is the whole contract.
    expect(specifiersIn(source).length).toBeGreaterThan(0);
  });

  it('the product reads no clock and calls no random source', () => {
    const source = blankComments(readFileSync(join(REPO_ROOT, PHASE_7_MODULE), 'utf8'));
    for (const forbidden of ['Date.now', 'new Date(', 'Math.random', 'crypto.randomUUID', 'performance.now']) {
      expect(source, `the product must not use ${forbidden}`).not.toContain(forbidden);
    }
    // The clock is a parameter, and the generator is a parameter. Both names appear, so the
    // assertion is about the *absence* of an ambient source rather than about a file that
    // happens not to mention time.
    expect(source).toContain('readonly now: string');
    expect(source).toContain('readonly generator: SubjectIdGenerator');
    // ...and the closed reason set is genuinely closed, which is what makes "no ambient
    // anything" checkable at the boundary of every refusal too.
    expect(source).toContain('SUBJECT_TEMPLATE_REFUSAL_REASONS');
  });

  it('the legacy template path is the negative control for the three rules above', () => {
    // Without this, "the product contains no `Date.now`" would be a statement about a file
    // nobody has ever read. The pre-Phase-7 path in `subjectPersistence.ts` is the other
    // template implementation in this repository and it does all three, so the rules are
    // known to be able to fire on real code.
    const legacy = blankComments(readFileSync(join(REPO_ROOT, LEGACY_PERSISTENCE_MODULE), 'utf8'));
    expect(legacy).toContain('Date.now()');
    expect(legacy).toContain('Math.random()');
    expect(legacy).toContain('new Date().toISOString()');
  });

  it('no module in the product closure can send anything anywhere', () => {
    // The Phase 5 egress walk, run over this product's own transitive closure, so a call the
    // product added is reported with its file, its line, and its rule id.
    const findings = [];
    for (const path of closureOf(PHASE_7_MODULE).paths) {
      findings.push(...scanModule(path, readFileSync(join(REPO_ROOT, path), 'utf8')).findings);
    }
    expect(findings, describeFindings(findings)).toEqual([]);
    // Non-vacuity: the closure really is a set of real modules and the scan really ran over
    // them, rather than over nothing.
    expect(closureOf(PHASE_7_MODULE).paths.length).toBeGreaterThanOrEqual(12);
  });

  it('the egress rules fire on a synthetic source, so "no findings" is a decision', () => {
    // The positive control for the control. Each rule the gate forbids is exercised here and
    // required to produce a finding, so a rule that stopped matching would fail this test
    // rather than silently passing the gate above.
    const cases: ReadonlyArray<[string, string]> = [
      ['navigator.share({ title: "x" });', 'share-invocation'],
      ['navigator.canShare({ files: [] });', 'share-capability-probe'],
      ["window.location.href = 'mailto:someone@example.invalid';", 'mailto-destination'],
      ["await fetch('https://example.invalid/template', { method: 'POST' });", 'absolute-network-destination'],
      ['const body = new FormData();', 'formdata-construction'],
      ['const request = new XMLHttpRequest();', 'xhr-construction'],
      ["navigator.sendBeacon('https://example.invalid/b', body);", 'beacon-post'],
      ["const socket = new WebSocket('wss://example.invalid/s');", 'websocket-construction'],
      ["const href = '/uploads/subject.kdtemplate';", 'uploads-path-literal'],
      ["const href = '/api/import';", 'api-path-literal'],
      ['form.submit();', 'form-submission'],
    ];
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const [line, rule] of cases) {
      const scan = scanModule('src/synthetic/egress.ts', line);
      expect(scan.findings.map((finding) => finding.rule), line).toContain(rule);
      // Findings carry a path, a line, and a rule id only - never the destination, so a
      // finding cannot leak a URL.
      for (const finding of scan.findings) {
        expect(Object.keys(finding).sort()).toEqual(['file', 'line', 'rule']);
      }
    }
  });

  it('the ZIP codec header no longer claims to serve .kdtemplate, and says why', () => {
    // The correction Phase 7 makes to `archive.ts`'s module comment, asserted rather than
    // trusted. A reader who finds `.kdtemplate` named in the ZIP codec's header would
    // reasonably expect a codec call, and the plan's "do not hand-roll ZIP" rule would read
    // as if it applied here. The header now names two products, and says which reading of
    // section 7.3 it took and why.
    const header = readFileSync(join(REPO_ROOT, 'src/services/persistence/v2/archive.ts'), 'utf8').slice(0, 3000);
    expect(header).not.toContain('`.kdbak`, `.kdsubject`, and `.kdtemplate`');
    // The positive form: the header names the two ZIP products and points at the JSON one.
    expect(header).toContain('`.kdbak` and `.kdsubject`');
    expect(header).toContain('subjectTemplate');
    expect(header).toContain('RAIL CHANGE');
  });
});

describe('Phase 7 gate 24: the one module outside the product tree reaches the product lazily', () => {
  it('the permitted caller set is a pinned list of dynamic callers, and nothing else names the product', () => {
    expect(existsSync(join(REPO_ROOT, PHASE_7_MODULE))).toBe(true);
    const applicationGraph = walk().modules.map((module) => module.path);
    // Every edge any module outside the product tree has to the product, by kind. Before
    // the cutover this list was empty, and it was pinned as such so the day a tab landed
    // it would fail *here by name* rather than the product becoming eagerly reachable
    // without comment. The tab has now landed, so the list is the one caller it is
    // entitled to have - still by kind, still pinned, and still refusing anything eager.
    const edges: string[] = [];
    for (const path of applicationGraph) {
      if (path.startsWith(PRODUCTS_TREE)) continue;
      for (const edge of classifySpecifierEdges(
        readFileSync(join(REPO_ROOT, path), 'utf8'),
        path,
        PHASE_7_MODULE,
      )) {
        edges.push(`${path} ${edge.kind}`);
      }
    }
    // The pinned form: exactly the named caller, and **no** eager edge of any kind. An
    // empty dynamic list would also satisfy "no eager edge", so both halves are required
    // and the non-vacuity test below is what keeps them from agreeing for the wrong reason.
    // Deduplicated by module, because the pinned list is a list of *modules* and the tab
    // has three separate `import()` call sites - one per operation - which is deliberate:
    // the product is fetched when a learner presses a control, not when a screen mounts.
    expect([
      ...new Set(
        edges
          .filter((entry) => entry.endsWith(' dynamic'))
          .map((entry) => (entry.split(' ')[0] as string)),
      ),
    ].sort()).toEqual([...PERMITTED_PRODUCT_CALLERS].sort());
    expect(edges.filter((entry) => EAGER_EDGE_KINDS.some((kind) => entry.endsWith(` ${kind}`)))).toEqual([]);
    // ...and the dynamic edges are counted as well as listed, so "one module, three call
    // sites" is stated rather than left to be re-derived by the next reader. Three is the
    // export, the inspection, and the import.
    expect(edges.filter((entry) => entry.endsWith(' dynamic'))).toHaveLength(3);
    // Erased type edges are allowed and expected - they cost a default build nothing - but
    // they are listed so that adding one is a visible change rather than a silent one.
    expect(edges.filter((entry) => entry.endsWith(' type-only')).sort()).toEqual([
      'src/ui/data/SubjectTemplateTab.tsx type-only',
    ]);
    // ...and the whole set is exactly those two kinds, so no sixth edge kind has appeared.
    expect([...new Set(edges.map((entry) => (entry.split(' ')[1] as string)))].sort()).toEqual([
      'dynamic',
      'type-only',
    ]);
    // The product **is** in the walked graph now, and it should be: the tab reached by
    // `dynamic` import is a real edge, and a walk that refused to follow it would be a
    // walk measuring something other than the application. So the statement is not
    // "absent" but "present, and reachable only through the pinned caller": the product
    // and its storage-v2 closure are in the graph, and the assertion above is what says no
    // module outside the product tree has any other way in. The `filesReaching`
    // assertion at the end of this file is the same claim through the shared helper.
    expect(applicationGraph).toContain(PHASE_7_MODULE);
    expect(applicationGraph).toContain('src/services/persistence/v2/schema.ts');
    // What *is* newly true of the graph, and is the reason this file's closing assertion
    // used to be `[]`: the product and the schema module are now reachable from the
    // entry point. The ZIP codec is still not, on any path - and the statement is scoped
    // to the template product's own closure, because the *other* two tabs legitimately
    // reach the two archive products and this gate has no business claiming otherwise.
    const templateClosure = closureOf(PHASE_7_MODULE).paths;
    for (const codecCarryingModule of [
      'src/services/persistence/products/subjectBackup.ts',
      'src/services/persistence/products/fullDeviceBackup.ts',
      'src/services/persistence/v2/archive.ts',
    ]) {
      expect(templateClosure, codecCarryingModule).not.toContain(codecCarryingModule);
    }
    expect(templateClosure).not.toContain('src/ui/data/SubjectTemplateTab.tsx');
  });

  it('a classifier that matched nothing could not pass the pinned list, and one more caller fails it', () => {
    // The non-vacuity control for a pinned list. Two halves:
    //
    // 1. The pinned caller is *read* by the same classifier the gate uses and is required
    //    to produce a dynamic edge, so a classifier that stopped recognising `import()`
    //    would fail here rather than making the gate above pass for the wrong reason.
    // 2. A **second** synthetic caller is required to produce a dynamic edge too, and is
    //    then shown to be absent from the pinned list. So a gate that widened itself
    //    silently, or a caller that appeared without anyone updating the list, is visible
    //    rather than absorbed.
    const pinned = PERMITTED_PRODUCT_CALLERS[0] as string;
    const probe = [
      `const product = await import('@/services/persistence/products/subjectTemplate');`,
      'void product;',
      '',
    ].join('\n');
    for (const [label, source] of [
      ['the pinned caller', readFileSync(join(REPO_ROOT, pinned), 'utf8')],
      ['a synthetic second caller', probe],
    ] as const) {
      expect(
        classifySpecifierEdges(source, pinned, PHASE_7_MODULE).map((edge) => edge.kind),
        label,
      ).toContain('dynamic');
    }
    // The gate's own comparison, run on both lists, so the assertion the gate makes is
    // shown to be capable of distinguishing them.
    const withASecond = [pinned, 'src/ui/data/synthetic/secondCaller.tsx'];
    expect(withASecond.filter((path) => !PERMITTED_PRODUCT_CALLERS.includes(path))).toEqual([
      'src/ui/data/synthetic/secondCaller.tsx',
    ]);
    expect([...PERMITTED_PRODUCT_CALLERS].filter((path) => !withASecond.includes(path))).toEqual([]);
    // ...and the pinned list is not vacuous to begin with.
    expect(PERMITTED_PRODUCT_CALLERS.length).toBeGreaterThanOrEqual(1);
  });

  it('the edge classifier this gate relies on tells all five kinds apart, on a synthetic source', () => {
    // Non-vacuity. Without this, "one dynamic caller and nothing eager" would be exactly
    // what a classifier that recognised nothing would report, and Phase 3 review found five
    // gates in this repository with that shape. Every kind is produced by a line that really
    // contains it, and a mention in a comment and in a string produces nothing.
    const source = [
      `import { exportSubjectTemplate } from '@/services/persistence/products/subjectTemplate';`,
      `import '@/services/persistence/products/subjectTemplate';`,
      `import type { SubjectTemplatePreview } from '@/services/persistence/products/subjectTemplate';`,
      `export type { SubjectTemplateExportResult } from '@/services/persistence/products/subjectTemplate';`,
      `type P = typeof import('@/services/persistence/products/subjectTemplate');`,
      `type Q = import('@/services/persistence/products/subjectTemplate').SubjectTemplatePreview;`,
      `const p = await import('@/services/persistence/products/subjectTemplate');`,
      `const r = require('@/services/persistence/products/subjectTemplate');`,
      `// import x from '@/services/persistence/products/subjectTemplate';`,
      `const note = '@/services/persistence/products/subjectTemplate';`,
      `import { isPrototypeMemberName } from '@/services/persistence/products/archiveValidation';`,
    ].join('\n');
    const kinds = classifySpecifierEdges(
      source,
      'src/ui/synthetic/edgeProbe.tsx',
      PHASE_7_MODULE,
    )
      .map((edge) => edge.kind)
      .sort();
    expect(kinds).toEqual([
      'dynamic',
      'require',
      'side-effect',
      'static',
      'type-only',
      'type-only',
      'type-only',
      'type-only',
    ]);
    // A second, also-real target has exactly its own edge and no others, so the classifier is
    // not matching every specifier it sees.
    expect(
      classifySpecifierEdges(
        source,
        'src/ui/synthetic/edgeProbe.tsx',
        'src/services/persistence/products/archiveValidation.ts',
      ).map((edge) => edge.kind),
    ).toEqual(['static']);
    // ...and the pre-filter's negative half: a source that never mentions the target is
    // skipped rather than parsed, and reports nothing.
    expect(
      classifySpecifierEdges(
        `import { thing } from '@/ui/other';\nconst note = 'subject template';\n`,
        'src/ui/synthetic/unrelated.ts',
        PHASE_7_MODULE,
      ),
    ).toEqual([]);
  });

  it('the owner flag is still VITE_DATA_PRODUCTS_V2 and still defaults to false', async () => {
    // The product is a new data product, and plan section 11 keeps new data products
    // opt-in until their cutover, so the flag that owns it must not have moved. Phase 5 and
    // Phase 6 gates hold the same flag from the runtime's side; this is the Phase 7 statement
    // that adding a third product and a third tab did not add or change a flag.
    const { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig } = await import('@/config/runtimeConfig');
    const { FEATURE_FLAG_MATRIX } = await import('@/config/featureFlags');
    expect(DEFAULT_RUNTIME_CONFIG.dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({}).dataProductsV2).toBe(false);
    expect(parseRuntimeConfig({ VITE_DATA_PRODUCTS_V2: 'true' }).dataProductsV2).toBe(true);
    expect(FEATURE_FLAG_MATRIX.dataProductsV2.productionDefault).toBe(false);
    // The flag set still holds no per-product flag, so a data product cannot quietly
    // acquire one - plan section 11's list is closed and Phase 1 owns it. Phase 10
    // added one flag to that closed set, `audioEnabled`, for the audio service; it is a
    // service flag, not a product flag, and adding it here keeps the list closed rather
    // than opening it: an eleventh flag still fails this assertion.
    expect(Object.keys(FEATURE_FLAG_MATRIX).sort()).toEqual([
      'adaptiveAssistance',
      'audioEnabled',
      'cozyVisuals',
      'dataProductsV2',
      'pixiDungeon',
      'pixiFishing',
      'pixiVillage',
      'storageRepository',
      'webShare',
      'worldRenderer',
    ]);
  });

  it('the product cannot be reached eagerly from outside the product tree', () => {
    // The same claim as the first test in this describe, expressed through the shared
    // reachability helper, so the two are not one assertion written twice. `filesReaching`
    // is given the three non-erased edge kinds; a `type-only` edge is erased at build time
    // and names no binding, so it is not a runtime edge. This list was empty before the
    // cutover and is required to still be empty afterwards - the tab that now reaches the
    // product does so with a `dynamic` import, which is deliberately not in this set.
    expect(
      filesReaching(
        walk().modules.map((module) => module.path),
        PHASE_7_MODULE,
        [...EAGER_EDGE_KINDS],
        PRODUCTS_TREE,
      ),
    ).toEqual([]);
    // ...and the positive form, so the empty list above is a measurement rather than a
    // walk that reached nothing: the same helper, given the `dynamic` kind, does find the
    // pinned caller.
    expect(
      [...filesReaching(walk().modules.map((module) => module.path), PHASE_7_MODULE, ['dynamic'], PRODUCTS_TREE)].sort(),
    ).toEqual([...PERMITTED_PRODUCT_CALLERS].sort());
  });
});
