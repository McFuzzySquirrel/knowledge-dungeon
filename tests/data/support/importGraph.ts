/**
 * The Phase 5 data-product gate's own first-party import-graph walk.
 *
 * This is a **second, independent** implementation, written for this gate on
 * purpose. It shares no code with the Phase 4 privacy walk in
 * `tests/privacy/support/appGraph.ts`: a gate that reuses the implementation of
 * the thing it verifies can only ever agree with itself, and Phase 3 review found
 * five vacuous gates in this repository for exactly that reason.
 *
 * What makes it a separate implementation rather than a copy:
 *
 * - **Traversal** is an explicit depth-first stack over realpaths, not a queue.
 * - **Comment handling** is a character-class scan with an explicit mode variable
 *   and a regex-literal heuristic driven by the previous significant character,
 *   rather than a blanking pass with an interpolation counter.
 * - **Specifiers** come from one combined pattern with named groups, including an
 *   explicit `export * from` form, rather than four separate patterns.
 * - **The rules** are backup-egress rules (share, upload, off-origin navigation,
 *   form submission) rather than the Phase 4 network-call rules, and the allowed
 *   local-download constructs are recognised as *allowed* call sites so their
 *   counts can be pinned.
 *
 * The entry module is `src/main.tsx`, so a product module only becomes visible to
 * this gate when the application actually imports it.
 *
 * Privacy: findings carry a repo-relative path, a line number, and a rule id. No
 * destination, URL, request body, or source text is ever copied into a finding or
 * a message. Every probe this gate plants is synthetic and names only the
 * reserved `example.invalid` host.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = process.cwd();
export const SRC_ROOT = join(REPO_ROOT, 'src');
export const ENTRY_MODULE = 'src/main.tsx';

/** The `@/` alias configured in `vite.config.ts`. */
const ALIAS = '@/';

/**
 * The directory this gate plants its positive control in.
 *
 * A new top-level directory rather than a shared one, for two reasons. The
 * existing declaration is asserted elsewhere to hold exactly one name, so adding
 * a second would be a cross-suite change; and a shared directory would make two
 * suites race over one marker file. Every gate that scans `src/` for a forbidden
 * construct scopes itself to a declared tree, so a directory of its own is
 * invisible to all of them - and the probe here imports nothing from any of those
 * trees, so it cannot be smuggled into one.
 */
export const PROBE_DIRECTORY_NAME = '__data_gate_probe__';
export const PROBE_DIRECTORY = join(SRC_ROOT, PROBE_DIRECTORY_NAME);
const PROBE_MARKER = '.test-planted';

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'] as const;
const MODULE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

export function repoPath(absolutePath: string): string {
  return toPosix(relative(REPO_ROOT, absolutePath));
}

function listModules(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listModules(full));
      continue;
    }
    if (MODULE_FILE.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every first-party module under `src/`, repo-relative and sorted. */
export function everySourceModule(): readonly string[] {
  return listModules(SRC_ROOT).map(repoPath).sort();
}

// ── Lexical pass ───────────────────────────────────────────────────────────

type LexicalMode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';

/** The scanner's modes, declared once so the vocabulary is checkable. */
export const LEXICAL_MODES: readonly LexicalMode[] = [
  'code',
  'line-comment',
  'block-comment',
  'single',
  'double',
  'template',
];

/** Characters after which a `/` begins a regular expression literal, not division. */
const REGEX_ALLOWED_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
  '\n',
]);

/**
 * Replace comment bytes with spaces, keeping every offset and line break.
 *
 * A mode machine plus a regex-literal heuristic, which is what a JavaScript file
 * with `/` in a string, a `//` inside a template, and a real division expression
 * needs. Finding a line number in the result is therefore a line number in the
 * original file.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  // Deliberately `string` rather than the `LexicalMode` union: a mode machine that
  // assigns each mode inside one loop body defeats TypeScript's control-flow
  // narrowing, and it then reports the `mode === 'block-comment'` arm as
  // unreachable - which is a false positive about a scanner whose whole job is to
  // reach that arm. The vocabulary is declared in `LEXICAL_MODES` and every literal
  // below is one of its entries.
  let mode: string = 'code';
  let previousSignificant = '';
  let templateBraceDepth = 0;

  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (mode === 'line-comment') {
      if (char === '\n') mode = 'code';
      else out[index] = ' ';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 1;
        mode = 'code';
        continue;
      }
      if (char !== '\n') out[index] = ' ';
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"')) mode = 'code';
      continue;
    }
    if (mode === 'template') {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '$' && next === '{') {
        templateBraceDepth = 1;
        index += 1;
        continue;
      }
      if (templateBraceDepth > 0) {
        if (char === '{') templateBraceDepth += 1;
        else if (char === '}') templateBraceDepth -= 1;
        continue;
      }
      if (char === '`') mode = 'code';
      continue;
    }

    // code
    if (char === '/' && next === '/') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 1;
      mode = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop - 1;
      mode = 'code';
      continue;
    }
    if (char === '/' && REGEX_ALLOWED_AFTER.has(previousSignificant)) {
      // A regular expression literal: skip to its closing slash, honouring
      // escapes and a character class.
      let cursor = index + 1;
      let inClass = false;
      while (cursor < source.length) {
        const inner = source[cursor] as string;
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) break;
        else if (inner === '\n') break;
        cursor += 1;
      }
      index = cursor;
      previousSignificant = 'x';
      continue;
    }
    if (char === "'") mode = 'single';
    else if (char === '"') mode = 'double';
    else if (char === '`') mode = 'template';
    if (!/\s/.test(char)) previousSignificant = char;
  }
  return out.join('');
}

/** Every module specifier a source file references, in source order. */
export function specifiersIn(source: string): readonly string[] {
  const code = blankComments(source);
  // The clause between the keyword and `from` is `[^;'"]*?` rather than `[\s\S]*?`
  // on purpose: a lazy wildcard that may cross a statement boundary will happily
  // swallow a side-effect import and pair it with the *next* statement's `from`,
  // which silently drops a module from the graph. Excluding `;` and both quote
  // characters keeps the clause inside one statement.
  const pattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\bfrom\s*)?['"](?<a>[^'"]+)['"]|\bimport\s*\(\s*['"](?<b>[^'"]+)['"]\s*\)|\brequire\s*\(\s*['"](?<c>[^'"]+)['"]\s*\)/g;
  const found: string[] = [];
  for (const match of code.matchAll(pattern)) {
    const specifier = match.groups?.a ?? match.groups?.b ?? match.groups?.c;
    if (specifier !== undefined) found.push(specifier);
  }
  return [...new Set(found)];
}

// ── Resolution ─────────────────────────────────────────────────────────────

function candidatesFor(target: string): string[] {
  const out = [target];
  if (!RESOLVABLE_EXTENSIONS.some((extension) => target.endsWith(extension))) {
    for (const extension of RESOLVABLE_EXTENSIONS) out.push(`${target}${extension}`);
  }
  for (const extension of RESOLVABLE_EXTENSIONS) out.push(join(target, `index${extension}`));
  return out;
}

type Resolution =
  | { readonly kind: 'first-party'; readonly file: string }
  | { readonly kind: 'external' }
  | { readonly kind: 'unresolved' };

function resolveSpecifier(fromFile: string, specifier: string): Resolution {
  let base: string | null = null;
  if (specifier.startsWith(ALIAS)) base = resolve(SRC_ROOT, specifier.slice(ALIAS.length));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  if (base === null) return { kind: 'external' };
  for (const candidate of candidatesFor(base)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { kind: 'first-party', file: realpathSync(candidate) };
    }
  }
  return { kind: 'unresolved' };
}

/**
 * The repo-relative path a specifier names, or `null` when it is external or
 * unresolved.
 *
 * Separate from {@link resolveSpecifier} so the walk keeps the richer
 * `Resolution` (it has to report unresolved specifiers) while the edge classifier
 * only needs the answer. Both go through the same candidate list, so the two
 * cannot disagree about which file a specifier is.
 */
function resolveSpecifierFrom(fromFile: string, specifier: string): string | null {
  const resolution = resolveSpecifier(fromFile, specifier);
  return resolution.kind === 'first-party' ? repoPath(resolution.file) : null;
}

// ── The walk ───────────────────────────────────────────────────────────────

export interface GraphModule {
  readonly path: string;
  readonly specifiers: readonly string[];
  readonly firstPartyEdges: readonly string[];
  readonly externalSpecifiers: readonly string[];
}

export interface Graph {
  readonly entry: string;
  readonly modules: readonly GraphModule[];
  readonly unresolved: readonly { readonly from: string; readonly specifier: string }[];
  readonly externalSpecifiers: readonly string[];
  /** `src/<area>` for every area the walk reached. */
  readonly areas: readonly string[];
}

export interface WalkOptions {
  readonly entry?: string;
  /** Additional roots, used only by the positive control. */
  readonly extraEntries?: readonly string[];
}

function absoluteEntry(entry: string): string {
  return entry.startsWith('/') ? entry : join(REPO_ROOT, entry);
}

/** Depth-first walk of the first-party graph from an entry module. */
export function walk(options: WalkOptions = {}): Graph {
  const roots = [absoluteEntry(options.entry ?? ENTRY_MODULE), ...(options.extraEntries ?? []).map(absoluteEntry)];
  const visited = new Map<string, GraphModule>();
  const unresolved: { from: string; specifier: string }[] = [];
  const externals = new Set<string>();
  const areas = new Set<string>();
  const stack: string[] = [];

  for (const root of roots) {
    if (existsSync(root) && statSync(root).isFile()) stack.push(realpathSync(root));
    else unresolved.push({ from: repoPath(root), specifier: '<entry-missing>' });
  }

  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (visited.has(file)) continue;
    const specifiers = specifiersIn(readFileSync(file, 'utf8'));
    const edges = new Set<string>();
    const moduleExternals = new Set<string>();

    for (const specifier of specifiers) {
      const resolution = resolveSpecifier(file, specifier);
      if (resolution.kind === 'external') {
        moduleExternals.add(specifier);
        externals.add(specifier);
        continue;
      }
      if (resolution.kind === 'unresolved') {
        unresolved.push({ from: repoPath(file), specifier });
        continue;
      }
      edges.add(repoPath(resolution.file));
      const segments = repoPath(resolution.file).split('/');
      if (segments.length >= 3) areas.add(segments[1] as string);
      if (!visited.has(resolution.file)) stack.push(resolution.file);
    }

    visited.set(file, {
      path: repoPath(file),
      specifiers,
      firstPartyEdges: [...edges].sort(),
      externalSpecifiers: [...moduleExternals].sort(),
    });
  }

  return {
    entry: repoPath(roots[0] as string),
    modules: [...visited.values()].sort((left, right) => (left.path < right.path ? -1 : 1)),
    unresolved,
    externalSpecifiers: [...externals].sort(),
    areas: [...areas].sort(),
  };
}

// ── Edge classification ────────────────────────────────────────────────────

/**
 * How one module reference was reached, from a real parse of the source.
 *
 * Five kinds, and the distinction between the last two is what every lazy-boundary
 * claim in this suite rests on:
 *
 * - `static` - a binding import or an `export ... from`. The target's code is in
 *   the graph at module-evaluation time, so it lands in the entry chunk.
 * - `side-effect` - a bare `import '...'`. Also eager, reported separately only so a
 *   finding names the shape.
 * - `require` - a real binding on every bundler that honours it, and eager.
 * - `dynamic` - `import('...')` **in a value position**. A real edge, and the only
 *   kind a screen may have into a data product: it puts the product in a separate
 *   chunk that a build with the flag off never fetches.
 * - `type-only` - `import type ... from '...'`, `export type ... from '...'`, and the
 *   `import('...')` a **type alias** uses, whether or not it is written
 *   `typeof import(...)`. **Erased at build**: no binding, no runtime edge, no
 *   chunk, no byte in any bundle. A screen may name a product's types as freely as
 *   it likes, because none of that reaches a default build.
 *
 * ## Why the compiler and not a pattern
 *
 * The difference between `type P = typeof import('m')` and `const p = await
 * import('m')` is the difference between an erased declaration and a chunk, and a
 * regular expression cannot see it: both are the token sequence `import(` followed
 * by a string literal. A `typeof`-based heuristic also mis-reads
 * `type Q = import('m').Thing`, which is equally erased, and would report callers
 * that do not exist.
 *
 * So this is a real parse, with the project's own TypeScript. That is not reusing an
 * implementation of the thing being verified - the thing being verified is the
 * *application's* import graph, and TypeScript is a compiler, not a gate - and it is
 * strictly stronger than a pattern, because it cannot half-match. The non-vacuity
 * control for it is `tests/data/subjectProductBoundary.test.ts`, which requires all
 * five kinds to be produced from a synthetic source.
 */
export type EdgeKind = 'static' | 'side-effect' | 'dynamic' | 'require' | 'type-only';

export interface Edge {
  /** Repo-relative path of the file the edge starts in. */
  readonly file: string;
  /** The specifier exactly as it was written. */
  readonly specifier: string;
  readonly kind: EdgeKind;
}

/**
 * Whether a source could possibly name `targetPath` at all.
 *
 * A parse is the expensive part of this file, and almost no module in the graph
 * refers to a given product. This is a sound *negative* filter: a first-party
 * specifier that resolves to a named file contains that file's stem, because
 * Vite, TypeScript, and the resolver in this file all build the candidate list by
 * appending an extension to the written specifier. A module whose blanked source
 * contains none of `subjectBackup`, `products`, or the full repo-relative path
 * therefore cannot reference it, and is skipped without a parse.
 *
 * The `index` case is covered by the directory check: a specifier that resolves
 * through `<dir>/index.ts` contains the directory. The one shape neither check
 * catches is a bare `.` or `..` specifier, and reaching a Phase 6 product module
 * that way requires being inside the product's own directory - which the
 * outside-the-product-tree scans exclude anyway. Both callers are asserted
 * against this filter by the non-vacuity controls that require all five edge
 * kinds to be produced from a synthetic source.
 */
function mayNameTarget(source: string, targetPath: string): boolean {
  const cut = targetPath.lastIndexOf('/');
  const stem = targetPath.slice(cut + 1).replace(/\.[^.]+$/, '');
  const directory = targetPath.slice(0, cut);
  return source.includes(stem) || source.includes(targetPath) || source.includes(directory);
}

/** Classify every module reference in `source` that resolves to `targetPath`. */
export function classifySpecifierEdges(
  source: string,
  repoRelativeFile: string,
  targetPath: string,
): readonly Edge[] {
  const code = blankComments(source);
  if (!mayNameTarget(code, targetPath)) return [];
  const fromFile = join(REPO_ROOT, repoRelativeFile);
  const parsed = ts.createSourceFile(repoRelativeFile, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edges: Edge[] = [];
  const record = (specifier: string | undefined, kind: EdgeKind): void => {
    if (specifier === undefined) return;
    if (resolveSpecifierFrom(fromFile, specifier) !== targetPath) return;
    edges.push({ file: repoRelativeFile, specifier, kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral | undefined)?.text;
      const clause = node.importClause;
      record(
        specifier,
        clause === undefined ? 'side-effect' : clause.isTypeOnly ? 'type-only' : 'static',
      );
    } else if (ts.isExportDeclaration(node)) {
      record((node.moduleSpecifier as ts.StringLiteral | undefined)?.text, node.isTypeOnly ? 'type-only' : 'static');
    } else if (ts.isImportTypeNode(node)) {
      // An `ImportTypeNode`'s argument is a `LiteralTypeNode` wrapping a string
      // literal; the narrowing is a check rather than a cast, so a future change to
      // the node's shape is a compile error here instead of an `undefined`.
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        record(argument.literal.text, 'type-only');
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record((node.arguments[0] as ts.StringLiteral | undefined)?.text, 'dynamic');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        record((node.arguments[0] as ts.StringLiteral | undefined)?.text, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return edges;
}

/** Repo-relative path of every module that reaches `targetPath` by a given kind. */
export function filesReaching(
  paths: readonly string[],
  targetPath: string,
  kinds: readonly EdgeKind[],
  excludedPrefix?: string,
): readonly string[] {
  const found: string[] = [];
  for (const path of paths) {
    if (excludedPrefix !== undefined && path.startsWith(excludedPrefix)) continue;
    const edges = classifySpecifierEdges(readFileSync(join(REPO_ROOT, path), 'utf8'), path, targetPath);
    if (edges.some((edge) => kinds.includes(edge.kind))) found.push(path);
  }
  return found;
}

// ── Backup-egress rules ────────────────────────────────────────────────────

export type EgressRule =
  | 'share-invocation'
  | 'share-capability-probe'
  | 'mailto-destination'
  | 'form-submission'
  | 'window-open-destination'
  | 'location-navigation'
  | 'absolute-network-destination'
  | 'unresolved-network-destination'
  | 'non-idempotent-request'
  | 'formdata-construction'
  | 'xhr-construction'
  | 'beacon-post'
  | 'websocket-construction'
  | 'eventsource-construction'
  | 'worker-construction'
  | 'import-scripts-call'
  | 'uploads-path-literal'
  | 'api-path-literal';

export interface EgressFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: EgressRule;
}

/** A construct the gate allows, counted so its absence is also a change. */
export interface AllowedCallSite {
  readonly file: string;
  readonly line: number;
  readonly kind: 'local-download' | 'local-file-pick' | 'same-origin-fetch';
}

export interface ModuleScan {
  readonly findings: readonly EgressFinding[];
  readonly allowed: readonly AllowedCallSite[];
  /** Every egress-capable call, allowed or not. */
  readonly callSites: number;
}

const SHARE_CALL = /\bnavigator\s*\.\s*(share|canShare)\s*\(/g;
const MAILTO_LITERAL = /['"`]mailto:[^'"`]*['"`]/g;
const FORM_SUBMIT = /\.\s*(submit|requestSubmit)\s*\(/g;
const FORM_ACTION_ATTRIBUTE = /\bformaction\s*=/g;
const WINDOW_OPEN = /\bwindow\s*\.\s*open\s*\(/g;
const LOCATION_NAVIGATION = /\blocation\s*\.\s*(?:assign|replace)\s*\(|\blocation\s*\.\s*href\s*=/g;
const CREATE_OBJECT_URL = /\bcreateObjectURL\s*(?:\?\.)?\s*\(/g;
const FILE_PICKER = /\bshow(?:Save|Directory|Open)FilePicker\s*\(/g;
const XHR_OPEN = /\.open\s*\(\s*['"](?:GET|POST|PUT|PATCH|DELETE|HEAD)['"]/g;
const FETCH_CALL = /\bfetch\s*\(/g;
const SEND_BEACON = /\bsendBeacon\s*\(/g;

const FORBIDDEN_CONSTRUCTS: ReadonlyArray<{ readonly pattern: RegExp; readonly rule: EgressRule }> = [
  { pattern: /\bnew\s+FormData\s*\(/g, rule: 'formdata-construction' },
  { pattern: /\bnew\s+XMLHttpRequest\s*\(/g, rule: 'xhr-construction' },
  { pattern: /\bsendBeacon\s*\(/g, rule: 'beacon-post' },
  { pattern: /\bnew\s+WebSocket\s*\(/g, rule: 'websocket-construction' },
  { pattern: /\bnew\s+EventSource\s*\(/g, rule: 'eventsource-construction' },
  { pattern: /\bnew\s+Worker\s*\(/g, rule: 'worker-construction' },
  { pattern: /\bimportScripts\s*\(/g, rule: 'import-scripts-call' },
  { pattern: /['"`][^'"`]*\/uploads\/[^'"`]*['"`]/g, rule: 'uploads-path-literal' },
  { pattern: /['"`][^'"`]*\/api(?:\/|['"`])/g, rule: 'api-path-literal' },
];

const ABSOLUTE_DESTINATION = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const SCHEME_PREFIX = /^\s*[a-z][a-z0-9+.-]*:/i;

/**
 * Module-level `const NAME = <literal>`, plus the Vite base-URL identifier.
 *
 * A template's right-hand side is stored verbatim, so `${BASE}` can be expanded
 * from the real `const BASE = import.meta.env.BASE_URL` declaration instead of
 * being treated as an unknown value.
 */
function stringConstants(code: string): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*;/g;
  for (const match of code.matchAll(pattern)) {
    const name = match[1];
    const literal = match[2];
    if (name !== undefined && literal !== undefined) constants.set(name, literal);
  }
  // `const BASE = import.meta.env.BASE_URL;` is the shape every same-origin
  // asset load in this repository is built from, and BASE_URL is a same-origin
  // base by Vite's contract: it is derived from the deployment's base path.
  const baseAlias = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*import\.meta\.env\.BASE_URL\s*;/g;
  for (const match of code.matchAll(baseAlias)) {
    const name = match[1];
    if (name !== undefined) constants.set(name, "'/'");
  }
  constants.set('import.meta.env.BASE_URL', "'/'");
  return constants;
}

function unquote(literal: string): string {
  const inner = literal.slice(1, -1);
  return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(['"`\\])/g, '$1');
}

/** How a destination expression can possibly resolve. */
export type DestinationClass = 'relative' | 'absolute' | 'opaque' | 'data-or-blob';

function classifyLiteral(literal: string): DestinationClass {
  if (literal.startsWith('data:') || literal.startsWith('blob:')) return 'data-or-blob';
  if (ABSOLUTE_DESTINATION.test(literal)) return 'absolute';
  if (SCHEME_PREFIX.test(literal)) return 'absolute';
  // A relative reference resolves against the document, so it cannot change the
  // origin. That is a property of the URL specification, not a guess.
  return 'relative';
}

/**
 * Classify a destination expression.
 *
 * `relative` is the only class a backup may use. `opaque` is a destination this
 * classifier cannot follow, and it is reported rather than waved through: a
 * backup must not be able to hide its destination behind a computed value.
 *
 * Interpolations are resolved where they can be and *bounded* where they cannot:
 *
 * - An unresolved interpolation in the **leading** position makes the
 *   destination `opaque`, because that value could carry a scheme.
 * - An unresolved interpolation elsewhere cannot lift a path-relative
 *   destination off the origin, so the literal prefix decides the class - and an
 *   otherwise `absolute` classification is downgraded to `opaque` rather than
 *   trusted, because an unresolved value could still have supplied the scheme.
 */
export function classifyDestinationText(
  expression: string,
  constants: ReadonlyMap<string, string>,
  depth = 0,
): DestinationClass {
  const text = expression.trim();
  if (text.length === 0) return 'opaque';
  if (depth > 4) return 'opaque';

  if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) {
    const segments = text.slice(1, -1).split(/\$\{([^}]*)\}/);
    let leading = true;
    let unresolved = false;
    let rebuilt = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      if (index % 2 === 0) {
        rebuilt += segment;
        if (segment.trim().length > 0) leading = false;
        continue;
      }
      const inner = segment.trim();
      const resolved = constants.get(inner);
      if (resolved === undefined) {
        if (leading) return 'opaque';
        unresolved = true;
        rebuilt += 'x';
        continue;
      }
      const expanded = classifyDestinationText(resolved, constants, depth + 1);
      if (expanded === 'absolute') return 'opaque';
      if (expanded === 'data-or-blob') return 'data-or-blob';
      rebuilt += resolved.startsWith('`') ? 'x' : unquote(resolved);
    }
    const classified = classifyLiteral(rebuilt);
    return unresolved && classified === 'absolute' ? 'opaque' : classified;
  }

  if (text.length >= 2 && /^['"`]/.test(text) && text.endsWith(text[0] as string)) {
    return classifyLiteral(unquote(text));
  }

  if (/^[A-Za-z_$][\w$.]*$/.test(text)) {
    const resolved = constants.get(text);
    if (resolved === undefined) return 'opaque';
    return classifyDestinationText(resolved, constants, depth + 1);
  }

  return 'opaque';
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (source[position] === '\n') line += 1;
  }
  return line;
}

/** The `-th` top-level argument of a call, balanced across brackets. */
function argumentAt(code: string, openParen: number, wanted: number): string | null {
  let depth = 0;
  let start = openParen + 1;
  let seen = -1;
  for (let index = openParen; index < code.length; index += 1) {
    const char = code[index] as string;
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < code.length && code[index] !== quote) {
        if (code[index] === '\\') index += 1;
        index += 1;
      }
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      if (depth === 1) start = index + 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return seen === wanted - 1 ? code.slice(start, index) : null;
      continue;
    }
    if (char === ',' && depth === 1) {
      seen += 1;
      if (seen === wanted) return code.slice(start, index);
      start = index + 1;
    }
  }
  return null;
}

function allArguments(code: string, openParen: number): string {
  const first = argumentAt(code, openParen, 0);
  void first;
  let depth = 0;
  for (let index = openParen; index < code.length; index += 1) {
    const char = code[index] as string;
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < code.length && code[index] !== quote) {
        if (code[index] === '\\') index += 1;
        index += 1;
      }
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(openParen + 1, index);
    }
  }
  return '';
}

/** Scans one module for backup-egress violations and for allowed local calls. */
export function scanModule(repoRelativePath: string, source: string): ModuleScan {
  const code = blankComments(source);
  const constants = stringConstants(code);
  const findings: EgressFinding[] = [];
  const allowed: AllowedCallSite[] = [];
  let callSites = 0;

  const report = (index: number, rule: EgressRule): void => {
    findings.push({ file: repoRelativePath, line: lineOf(code, index), rule });
  };

  for (const match of code.matchAll(SHARE_CALL)) {
    callSites += 1;
    report(match.index, match[0].includes('canShare') ? 'share-capability-probe' : 'share-invocation');
  }
  for (const match of code.matchAll(MAILTO_LITERAL)) report(match.index, 'mailto-destination');
  for (const match of code.matchAll(FORM_SUBMIT)) report(match.index, 'form-submission');
  for (const match of code.matchAll(FORM_ACTION_ATTRIBUTE)) report(match.index, 'form-submission');
  for (const match of code.matchAll(WINDOW_OPEN)) {
    const destination = argumentAt(code, match.index + match[0].lastIndexOf('('), 0);
    const classification = destination === null ? 'opaque' : classifyDestinationText(destination, constants);
    if (classification === 'relative' || classification === 'data-or-blob') {
      allowed.push({ file: repoRelativePath, line: lineOf(code, match.index), kind: 'local-download' });
      continue;
    }
    callSites += 1;
    report(match.index, 'window-open-destination');
  }
  for (const match of code.matchAll(LOCATION_NAVIGATION)) {
    const destination = argumentAt(code, match.index + match[0].lastIndexOf('('), 0);
    const classification = destination === null ? 'opaque' : classifyDestinationText(destination, constants);
    if (classification === 'relative') {
      allowed.push({ file: repoRelativePath, line: lineOf(code, match.index), kind: 'same-origin-fetch' });
      continue;
    }
    callSites += 1;
    report(match.index, 'location-navigation');
  }
  for (const match of code.matchAll(CREATE_OBJECT_URL)) {
    // The local-download mechanism the product is *allowed* to use. Counted, so a
    // product that adopts it produces a visible, pinned call site rather than a
    // silent one.
    callSites += 1;
    allowed.push({ file: repoRelativePath, line: lineOf(code, match.index), kind: 'local-download' });
  }
  for (const match of code.matchAll(FILE_PICKER)) {
    callSites += 1;
    allowed.push({ file: repoRelativePath, line: lineOf(code, match.index), kind: 'local-file-pick' });
  }

  for (const { pattern, rule } of FORBIDDEN_CONSTRUCTS) {
    for (const match of code.matchAll(pattern)) report(match.index, rule);
  }

  for (const match of code.matchAll(FETCH_CALL)) {
    const openParen = match.index + match[0].lastIndexOf('(');
    const destination = argumentAt(code, openParen, 0);
    const call = allArguments(code, openParen);
    callSites += 1;
    if (destination === null) {
      report(match.index, 'unresolved-network-destination');
      continue;
    }
    const classification = classifyDestinationText(destination, constants);
    if (classification === 'relative') {
      allowed.push({ file: repoRelativePath, line: lineOf(code, match.index), kind: 'same-origin-fetch' });
    } else if (classification === 'data-or-blob') {
      allowed.push({ file: repoRelativePath, line: lineOf(code, match.index), kind: 'same-origin-fetch' });
    } else {
      report(
        match.index,
        classification === 'absolute' ? 'absolute-network-destination' : 'unresolved-network-destination',
      );
    }
    if (/\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(call)) {
      report(match.index, 'non-idempotent-request');
    }
  }

  for (const match of code.matchAll(XHR_OPEN)) {
    const destination = argumentAt(code, match.index + match[0].lastIndexOf('('), 1);
    callSites += 1;
    const classification = destination === null ? 'opaque' : classifyDestinationText(destination, constants);
    if (classification === 'relative') {
      allowed.push({ file: repoRelativePath, line: lineOf(code, match.index), kind: 'same-origin-fetch' });
    } else {
      report(match.index, 'unresolved-network-destination');
    }
  }
  for (const match of code.matchAll(SEND_BEACON)) {
    callSites += 1;
    report(match.index, 'beacon-post');
  }

  return { findings, allowed, callSites };
}

export interface GraphScan {
  readonly findings: readonly EgressFinding[];
  readonly allowed: readonly AllowedCallSite[];
  readonly callSites: number;
  /** `path:callSiteCount` for every module with at least one call site. */
  readonly perModule: readonly string[];
}

/** Scans every module of a graph, minus this gate's own planted probe. */
export function scanGraph(graph: Graph): GraphScan {
  const findings: EgressFinding[] = [];
  const allowed: AllowedCallSite[] = [];
  const perModule: string[] = [];
  let callSites = 0;
  for (const module of graph.modules) {
    if (module.path.startsWith(`src/${PROBE_DIRECTORY_NAME}/`)) continue;
    const scan = scanModule(module.path, readFileSync(join(REPO_ROOT, module.path), 'utf8'));
    findings.push(...scan.findings);
    allowed.push(...scan.allowed);
    callSites += scan.callSites;
    if (scan.callSites > 0) perModule.push(`${module.path}:${scan.callSites}`);
  }
  return { findings, allowed, callSites, perModule: perModule.sort() };
}

/** Compact, leak-free rendering of findings. */
export function describeFindings(findings: readonly EgressFinding[]): string {
  if (findings.length === 0) return 'no findings';
  return findings
    .slice(0, 12)
    .map((finding) => `${finding.file}:${finding.line} ${finding.rule}`)
    .join('\n');
}

// ── Positive control ───────────────────────────────────────────────────────

/**
 * Plant a probe inside `src/` and declare exactly which files it created.
 *
 * The declaration is a JSON list written to `.test-planted` in the probe
 * directory, and it is written *after* the files, so a concurrent reader never
 * sees a name for a file that does not exist yet. It is also removed with the
 * directory, so the exemption exists only while the probe does.
 */
export function plantProbe(files: Readonly<Record<string, string>>): readonly string[] {
  rmSync(PROBE_DIRECTORY, { recursive: true, force: true });
  mkdirSync(PROBE_DIRECTORY, { recursive: true });
  const planted: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(PROBE_DIRECTORY, name), contents, 'utf8');
    planted.push(`src/${PROBE_DIRECTORY_NAME}/${name}`);
  }
  writeFileSync(
    join(PROBE_DIRECTORY, PROBE_MARKER),
    `${JSON.stringify([...planted].sort(), null, 2)}\n`,
    'utf8',
  );
  return planted;
}

/** Remove the probe and its declaration. Safe to call when nothing was planted. */
export function removeProbe(): void {
  rmSync(PROBE_DIRECTORY, { recursive: true, force: true });
}
