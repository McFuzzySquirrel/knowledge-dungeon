/**
 * Phase 4 privacy gate: a first-party import-graph walk and a
 * network-destination classifier.
 *
 * This module is written by the verification owner for the `test:privacy` gate.
 * It is deliberately independent of the Phase 3 QA walk: a gate that shares an
 * implementation with the thing it verifies can only agree with itself, and
 * Phase 3 review already found five vacuous gates in this repository.
 *
 * What it does:
 *
 * 1. **Walks the real module graph** from an entry module (default
 *    `src/main.tsx`), following static `import`/`export ... from`, side-effect
 *    `import '...'`, dynamic `import('...')`, and `require('...')`, resolving the
 *    `@/` alias to `src/` and relative specifiers against the importing file. A
 *    specifier that resolves to nothing is recorded as *unresolved* rather than
 *    silently dropped, so a broken resolver is visible instead of producing an
 *    empty graph.
 * 2. **Classifies every network call** in every reached module by where it can
 *    possibly send bytes: a same-origin relative destination is the only
 *    destination this application is allowed to use.
 *
 * Privacy rules for this file: it reads source files and reports repo-relative
 * paths, line numbers, and rule identifiers only. It never copies source text,
 * string values, URLs, or request data into a finding, and it never writes
 * learner data anywhere. Every fixture value used with it is synthetic.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// ── Repository layout ──────────────────────────────────────────────────────

export const REPO_ROOT = process.cwd();
export const SRC_ROOT = join(REPO_ROOT, 'src');
export const APP_ENTRY_MODULE = 'src/main.tsx';

/** The `@/` alias configured in `vite.config.ts`. */
const ALIAS_PREFIX = '@/';

// ── Test-owned source directories ─────────────────────────────────────────

/**
 * Directories under `src/` that a test may plant a temporary probe module in.
 *
 * The privacy gate plants its detector probe inside `src/` on purpose: a probe
 * outside the application tree would not prove that the import-graph walk and the
 * network scanner work where production code lives. While that probe exists, a
 * *different* gate that scans `src/` for forbidden imports can see it and report
 * the planted probe as a real offender - a genuine cross-suite flake, because the
 * two suites run in parallel.
 *
 * So the planting is declared here, once, and the other gate reads this list rather
 * than repeating the name. Declaring the *directory* is not by itself an exemption;
 * see {@link writePlantingMarker} and {@link isTestOwnedTransientPath}.
 */
export const TEST_OWNED_SOURCE_DIRECTORIES: readonly string[] = ['__privacy_probe__'];

/**
 * The file a planting test writes for as long as its probe exists, and removes when
 * it is done.
 *
 * Its *contents* are the declaration: a JSON array of the exact repo-relative paths
 * the planting created. That is the whole exemption. It is not the directory that
 * is exempt - the directory is only where the declaration is found.
 */
export const PLANTING_MARKER_NAME = '.test-planted';

/** Absolute path of a test-owned directory under `src/`. */
export function testOwnedDirectory(name: string): string {
  return join(SRC_ROOT, name);
}

/** The marker path whose contents declare a live planting. */
export function plantingMarkerPath(directoryName: string): string {
  return join(SRC_ROOT, directoryName, PLANTING_MARKER_NAME);
}

/**
 * Declare a live planting: the exact files created, and nothing else.
 *
 * A planting that forgets a file it created gets that file scanned like ordinary
 * source - which fails loudly rather than hiding a real offender, the safe
 * direction to err in. A planting that declares a file it did not create is the
 * remaining soft spot, and it is a deliberate trade: a file-level exemption has to
 * be declared by whoever plants, and the alternative - a directory-wide exemption -
 * is the hole this replaced.
 */
export function writePlantingMarker(directoryName: string, plantedFiles: readonly string[]): void {
  // Drop any cached reading of the previous declaration first. A planting that
  // removes and re-creates the same directory within one filesystem timestamp tick
  // would otherwise leave a concurrent gate reading the previous file list.
  manifestCache.delete(plantingMarkerPath(directoryName));
  writeFileSync(
    plantingMarkerPath(directoryName),
    `${JSON.stringify([...plantedFiles].sort(), null, 2)}\n`,
    'utf8',
  );
}

/** Parsed planting declarations, keyed by marker path, invalidated on mtime. */
const manifestCache = new Map<string, { mtimeMs: number; paths: Set<string> }>();

function plantedPathsFor(directoryName: string): Set<string> {
  const marker = plantingMarkerPath(directoryName);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(marker).mtimeMs;
  } catch {
    manifestCache.delete(marker);
    return new Set();
  }
  const cached = manifestCache.get(marker);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.paths;
  let paths = new Set<string>();
  try {
    const declared: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    if (Array.isArray(declared)) {
      paths = new Set(declared.filter((entry): entry is string => typeof entry === 'string'));
    }
  } catch {
    // A malformed declaration exempts nothing. Failing closed is the whole point:
    // a planting that cannot state its files gets scanned like any other source.
    paths = new Set();
  }
  manifestCache.set(marker, { mtimeMs, paths });
  return paths;
}

/** Forget parsed planting declarations. Test support. */
export function clearPlantingDeclarations(): void {
  manifestCache.clear();
}

/** Every repo-relative path currently declared by a live planting. */
export function livePlantedPaths(): readonly string[] {
  const all = new Set<string>();
  for (const name of TEST_OWNED_SOURCE_DIRECTORIES) {
    for (const entry of plantedPathsFor(name)) all.add(entry);
  }
  return [...all].sort();
}

/**
 * True only when `absolutePath` is one of the exact files a live planting declared.
 *
 * Three conditions, and all three matter:
 *
 * 1. The file is in a declared test-owned directory, so the two gates agree on
 *    where plantings live rather than by a duplicated string.
 * 2. A planting marker exists, so the exemption is scoped to a planting in flight.
 * 3. The file is *named in that marker's declaration*, so a real offender dropped
 *    into the same directory during a live planting is still scanned. This is what
 *    a directory-wide exemption got wrong.
 *
 * A path outside every declared directory fails (1) and is never exempt.
 */
export function isTestOwnedTransientPath(absolutePath: string): boolean {
  for (const name of TEST_OWNED_SOURCE_DIRECTORIES) {
    const directory = testOwnedDirectory(name);
    if (!absolutePath.startsWith(directory + '/')) continue;
    return plantedPathsFor(name).has(repoPath(absolutePath));
  }
  return false;
}

/** Extensions a first-party specifier may resolve to, in probe order. */
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json'] as const;

/** Source files the graph walk will accept as a module. */
const MODULE_FILE_PATTERN = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

/** Repo-relative POSIX path, the only path form this module reports. */
export function repoPath(absolutePath: string): string {
  return toPosix(relative(REPO_ROOT, absolutePath));
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (MODULE_FILE_PATTERN.test(entry) && !entry.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

/** Every first-party module file under `src/`, as repo-relative POSIX paths. */
export function allFirstPartyModules(): readonly string[] {
  return listSourceFiles(SRC_ROOT).map(repoPath).sort();
}

// ── Comment stripping ──────────────────────────────────────────────────────

/**
 * Replaces comment characters with spaces, preserving byte offsets and line
 * numbers, so findings still point at the right line and a commented-out
 * `fetch('/api/upload')` is not reported as a live one.
 *
 * A real state machine rather than a regex: this repository contains
 * `https://` inside template literals (the game guide markdown) and `/*`-like
 * text inside strings, and a regex strip would corrupt the literals the
 * destination classifier depends on.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  let index = 0;
  // Depth of `${ ... }` interpolations inside the template literal we are in.
  let templateInterpolationDepth = 0;

  const blank = (from: number, to: number): void => {
    for (let position = from; position < to; position += 1) {
      if (out[position] !== '\n') out[position] = ' ';
    }
  };

  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      const isTemplate = quote === '`';
      let cursor = index + 1;
      while (cursor < source.length) {
        const inner = source[cursor] as string;
        if (inner === '\\') {
          cursor += 2;
          continue;
        }
        if (isTemplate && templateInterpolationDepth === 0 && inner === '$' && source[cursor + 1] === '{') {
          templateInterpolationDepth = 1;
          cursor += 2;
          continue;
        }
        if (templateInterpolationDepth > 0) {
          if (inner === '{') templateInterpolationDepth += 1;
          else if (inner === '}') templateInterpolationDepth -= 1;
          else if (inner === "'" || inner === '"' || inner === '`') {
            // A nested literal inside the interpolation: skip it wholesale.
            const nestedEnd = source.indexOf(inner, cursor + 1);
            cursor = nestedEnd === -1 ? source.length : nestedEnd + 1;
            continue;
          }
          cursor += 1;
          continue;
        }
        if (inner === quote) break;
        cursor += 1;
      }
      index = cursor + 1;
      continue;
    }

    index += 1;
  }

  return out.join('');
}

// ── Specifier extraction ───────────────────────────────────────────────────

/**
 * Every module specifier a source file references.
 *
 * Type-only imports count: a type import is still a file in the module graph,
 * and a privacy-relevant call can hide behind one. The capture is
 * specifier-only; the statements themselves are never retained.
 */
export function readSpecifiers(source: string): readonly string[] {
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function candidatePaths(target: string): string[] {
  const candidates = [target];
  const hasKnownExtension = RESOLVABLE_EXTENSIONS.some((extension) => target.endsWith(extension));
  if (!hasKnownExtension) {
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(`${target}${extension}`);
  }
  for (const extension of RESOLVABLE_EXTENSIONS) {
    candidates.push(join(target, `index${extension}`));
  }
  return candidates;
}

function resolveFirstPartyTarget(
  fromFile: string,
  specifier: string,
): { readonly kind: 'first-party'; readonly path: string } | { readonly kind: 'external' } | { readonly kind: 'unresolved' } {
  let base: string | null = null;
  if (specifier.startsWith(ALIAS_PREFIX)) base = resolve(SRC_ROOT, specifier.slice(ALIAS_PREFIX.length));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  if (base === null) return { kind: 'external' };

  for (const candidate of candidatePaths(base)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { kind: 'first-party', path: candidate };
    }
  }
  return { kind: 'unresolved' };
}

// ── Graph walk ─────────────────────────────────────────────────────────────

export interface GraphModule {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Every specifier this module references, in source order, deduplicated. */
  readonly specifiers: readonly string[];
  /** Repo-relative paths of the first-party modules it reaches. */
  readonly firstPartyEdges: readonly string[];
  /** Bare package specifiers, deduplicated and sorted. */
  readonly externalSpecifiers: readonly string[];
}

export interface UnresolvedSpecifier {
  readonly from: string;
  readonly specifier: string;
}

export interface AppGraph {
  readonly entry: string;
  /** Reached modules, sorted by path. */
  readonly modules: readonly GraphModule[];
  /** Distinct first-party directories under `src/` that the walk reached. */
  readonly sourceDirectories: readonly string[];
  /** Every bare package specifier anywhere in the graph, sorted. */
  readonly externalSpecifiers: readonly string[];
  /** Specifiers that matched no file. Must be empty for a healthy walk. */
  readonly unresolved: readonly UnresolvedSpecifier[];
}

export interface WalkOptions {
  /** Entry module, repo-relative or absolute. Defaults to `src/main.tsx`. */
  readonly entry?: string;
  /** Extra entry modules, used only by the positive control. */
  readonly extraEntries?: readonly string[];
}

function entryAbsolute(entry: string): string {
  return isAbsoluteRepoPath(entry) ? entry : join(REPO_ROOT, entry);
}

function isAbsoluteRepoPath(value: string): boolean {
  return value.startsWith(REPO_ROOT) || value.startsWith('/');
}

/**
 * Breadth-first walk of the first-party module graph.
 *
 * Every reached module is read exactly once. Cycles are handled by the visited
 * set, so a circular import cannot make the walk non-terminating.
 */
export function walkAppGraph(options: WalkOptions = {}): AppGraph {
  const entry = options.entry ?? APP_ENTRY_MODULE;
  const entries = [entryAbsolute(entry), ...(options.extraEntries ?? []).map(entryAbsolute)];

  const visited = new Map<string, GraphModule>();
  const queue: string[] = [];
  const unresolved: UnresolvedSpecifier[] = [];
  const externalSpecifiers = new Set<string>();
  const directories = new Set<string>();

  for (const candidate of entries) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      queue.push(candidate);
      continue;
    }
    unresolved.push({ from: repoPath(candidate), specifier: '<entry-missing>' });
  }

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    const specifiers = [...new Set(readSpecifiers(source))];
    const firstPartyEdges: string[] = [];
    const moduleExternals: string[] = [];

    for (const specifier of specifiers) {
      const target = resolveFirstPartyTarget(file, specifier);
      if (target.kind === 'external') {
        moduleExternals.push(specifier);
        externalSpecifiers.add(specifier);
        continue;
      }
      if (target.kind === 'unresolved') {
        unresolved.push({ from: repoPath(file), specifier });
        continue;
      }
      const edge = repoPath(target.path);
      firstPartyEdges.push(edge);
      const parts = edge.split('/');
      // `src/<area>` is the directory dimension the walk is expected to span.
      if (parts.length >= 3) directories.add(parts[1] as string);
      if (!visited.has(target.path)) queue.push(target.path);
    }

    visited.set(file, {
      path: repoPath(file),
      specifiers,
      firstPartyEdges: [...new Set(firstPartyEdges)].sort(),
      externalSpecifiers: [...new Set(moduleExternals)].sort(),
    });
  }

  return {
    entry: repoPath(entries[0] as string),
    modules: [...visited.values()].sort((left, right) => (left.path < right.path ? -1 : 1)),
    sourceDirectories: [...directories].sort(),
    externalSpecifiers: [...externalSpecifiers].sort(),
    unresolved,
  };
}

// ── Network destination classification ─────────────────────────────────────

export type DestinationClass =
  | 'same-origin-relative'
  | 'absolute-external'
  | 'dynamic-unresolved';

export type NetworkRule =
  | 'app-endpoint-fetch'
  | 'absolute-network-destination'
  | 'unresolved-network-destination'
  | 'external-attachment-fetch'
  | 'non-idempotent-request'
  | 'formdata-construction'
  | 'xhr-construction'
  | 'beacon-post'
  | 'websocket-construction'
  | 'eventsource-construction'
  | 'import-scripts-call'
  | 'uploads-path-literal';

export interface NetworkFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: NetworkRule;
  /** How the destination classified. Meaningless for non-fetch rules. */
  readonly destination: DestinationClass | 'not-applicable';
}

export interface NetworkScan {
  readonly findings: readonly NetworkFinding[];
  /** Every network call site found, whether or not it violated a rule. */
  readonly callSites: number;
  /** Calls whose destination is a same-origin relative path. */
  readonly sameOriginCalls: number;
}

const CALL_KEYWORDS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /\bfetch\s*\(/g, label: 'fetch' },
  { pattern: /\.open\s*\(\s*['"](?:GET|POST|PUT|PATCH|DELETE|HEAD)['"]/g, label: 'xhr.open' },
  { pattern: /\bsendBeacon\s*\(/g, label: 'sendBeacon' },
];

const APP_ENDPOINT_PATH = /^\/api(?:\/|$)/;
const EXTERNAL_ATTACHMENT_NAME = /externalUrl|external[A-Z_]|attachment/i;

/**
 * Module-level `const` string initializers, so a call like
 * `fetch(MANIFEST_URL)` can be resolved instead of reported as unknown.
 */
function moduleStringConstants(source: string): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*;/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const literal = match[2];
    if (name === undefined || literal === undefined) continue;
    constants.set(name, literal);
  }
  return constants;
}

/** Removes quotes and unescapes the trivial escapes a constant can contain. */
function literalValue(raw: string): string {
  if (raw.startsWith('`') || raw.startsWith("'") || raw.startsWith('"')) {
    const inner = raw.slice(1, -1);
    return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(['"`\\])/g, '$1');
  }
  return raw;
}

/**
 * Classifies a `fetch`/XHR destination expression.
 *
 * A call is allowed only when its destination provably resolves to a relative
 * path. Absolute URLs and protocol-relative URLs are rejected outright, and
 * anything the classifier cannot prove same-origin is reported as unresolved
 * rather than waved through: an upload must not be able to hide behind a
 * computed destination.
 */
export function classifyDestination(expression: string, constants: ReadonlyMap<string, string>): DestinationClass {
  const trimmed = expression.trim();

  if (trimmed.startsWith('`')) {
    // A template: substitute the same-origin base for `${BASE}` /
    // `${BASE_URL}` and drop every other interpolation, then judge the prefix.
    const substituted = trimmed
      .replace(/\$\{\s*(?:import\.meta\.env\.)?BASE(?:_URL)?\s*\}/g, '/')
      .replace(/\$\{[^}]*\}/g, '');
    return classifyLiteral(substituted);
  }

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const resolved = constants.get(trimmed);
    if (resolved === undefined) return 'dynamic-unresolved';
    return classifyDestination(resolved, constants);
  }

  return classifyLiteral(trimmed);
}

function classifyLiteral(value: string): DestinationClass {
  const literal = literalValue(value.trim());
  if (literal.startsWith('//')) return 'absolute-external';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(literal)) return 'absolute-external';
  if (/^(?:\/|\.\/|\.\.\/)/.test(literal)) return 'same-origin-relative';
  if (literal.length === 0) return 'dynamic-unresolved';
  return 'dynamic-unresolved';
}

/** The first argument text of a call, balanced across nested parentheses. */
function firstArgument(source: string, openParenIndex: number): string | null {
  const argument = nthArgument(source, openParenIndex, 0);
  return argument === null ? null : argument;
}

/** Every argument of a call joined back together, for option-object checks. */
function allArguments(source: string, openParenIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, index);
    }
  }
  return '';
}

/** The `n`-th top-level argument text of a call, balanced across parentheses. */
function nthArgument(source: string, openParenIndex: number, wanted: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  let start = openParenIndex + 1;
  let seen = -1;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      if (depth === 1) start = index + 1;
      continue;
    }
    if (char === ',' && depth === 1) {
      seen += 1;
      if (seen === wanted) return source.slice(start, index);
      start = index + 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return seen === wanted - 1 ? source.slice(start, index) : null;
    }
  }
  return null;
}

/** Whether the call text declares a method that is not GET or HEAD. */
function declaresNonIdempotentMethod(callText: string): boolean {
  const match = /\bmethod\s*:\s*['"]([A-Za-z]+)['"]/.exec(callText);
  if (match === null) return false;
  const method = (match[1] ?? '').toUpperCase();
  return method !== 'GET' && method !== 'HEAD';
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index && position < source.length; position += 1) {
    if (source[position] === '\n') line += 1;
  }
  return line;
}

/**
 * Scans one source file for network calls and privacy-rule violations.
 *
 * Findings carry the repo-relative path, the line, and the rule id. They never
 * carry the destination itself, so a failure message cannot leak a URL.
 */
export function scanModuleForNetworkRules(repoRelativePath: string, source: string): NetworkScan {
  const code = stripComments(source);
  const constants = moduleStringConstants(code);
  const findings: NetworkFinding[] = [];
  let callSites = 0;
  let sameOriginCalls = 0;

  for (const { pattern, label } of CALL_KEYWORDS) {
    for (const match of code.matchAll(pattern)) {
      const openParen = match.index + match[0].lastIndexOf('(');
      // `xhr.open(method, url, ...)` takes the method first; `fetch(url, ...)`
      // takes the destination first.
      const destinationText = label === 'xhr.open' ? nthArgument(code, openParen, 1) : firstArgument(code, openParen);
      if (destinationText === null) continue;
      const callText = allArguments(code, openParen);
      callSites += 1;
      const destination = classifyDestination(destinationText, constants);
      const line = lineOf(code, match.index);
      if (destination === 'same-origin-relative') sameOriginCalls += 1;
      else {
        findings.push({
          file: repoRelativePath,
          line,
          rule:
            destination === 'absolute-external'
              ? 'absolute-network-destination'
              : 'unresolved-network-destination',
          destination,
        });
        if (destination === 'absolute-external' && EXTERNAL_ATTACHMENT_NAME.test(destinationText)) {
          findings.push({
            file: repoRelativePath,
            line,
            rule: 'external-attachment-fetch',
            destination,
          });
        }
      }

      // An application endpoint is forbidden regardless of the HTTP method: the
      // redesigned web app has no `/api/` route to call, and the Express server
      // that does is not part of the web release.
      if (APP_ENDPOINT_PATH.test(literalValue(destinationText.trim()))) {
        findings.push({
          file: repoRelativePath,
          line,
          rule: 'app-endpoint-fetch',
          destination,
        });
      }
      if (label === 'fetch' && declaresNonIdempotentMethod(callText)) {
        findings.push({
          file: repoRelativePath,
          line,
          rule: 'non-idempotent-request',
          destination,
        });
      }
    }
  }

  const simpleRules: ReadonlyArray<{ readonly pattern: RegExp; readonly rule: NetworkRule }> = [
    { pattern: /\bnew\s+FormData\s*\(/g, rule: 'formdata-construction' },
    { pattern: /\bnew\s+XMLHttpRequest\s*\(/g, rule: 'xhr-construction' },
    { pattern: /\bsendBeacon\s*\(/g, rule: 'beacon-post' },
    { pattern: /\bnew\s+WebSocket\s*\(/g, rule: 'websocket-construction' },
    { pattern: /\bnew\s+EventSource\s*\(/g, rule: 'eventsource-construction' },
    { pattern: /\bimportScripts\s*\(/g, rule: 'import-scripts-call' },
    { pattern: /['"`][^'"`]*\/uploads\/[^'"`]*['"`]/g, rule: 'uploads-path-literal' },
  ];

  for (const { pattern, rule } of simpleRules) {
    for (const match of code.matchAll(pattern)) {
      findings.push({
        file: repoRelativePath,
        line: lineOf(code, match.index),
        rule,
        destination: 'not-applicable',
      });
    }
  }

  return { findings, callSites, sameOriginCalls };
}

/** Scans every module of a graph. */
export function scanGraphForNetworkRules(graph: AppGraph): NetworkScan {
  const findings: NetworkFinding[] = [];
  let callSites = 0;
  let sameOriginCalls = 0;
  for (const module of graph.modules) {
    const scan = scanModuleForNetworkRules(module.path, readFileSync(join(REPO_ROOT, module.path), 'utf8'));
    findings.push(...scan.findings);
    callSites += scan.callSites;
    sameOriginCalls += scan.sameOriginCalls;
  }
  return { findings, callSites, sameOriginCalls };
}

/** Compact, sanitized rendering of findings for an assertion message. */
export function describeFindings(findings: readonly NetworkFinding[]): string {
  if (findings.length === 0) return 'no findings';
  return findings
    .slice(0, 12)
    .map((finding) => `${finding.file}:${finding.line} ${finding.rule}`)
    .join('\n');
}
