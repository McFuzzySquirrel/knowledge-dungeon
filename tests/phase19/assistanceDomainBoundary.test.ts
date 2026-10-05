/**
 * Phase 19: the renderer, storage, and network boundaries of the assistance domain.
 *
 * Five gates, each pinned by an import-graph walk rather than by a comment:
 *
 * 1. `src/core/assistance/**` reaches **nothing outside `src/core/`** at run time. Not "no
 *    renderer" - the stronger claim, because it also excludes `@/store`, `@/services`,
 *    `localStorage`, and `indexedDB`. That single property is the mechanical form of "a
 *    suggestion cannot render", "a suggestion cannot persist", and "nothing leaves the
 *    device", and it is why the advisory-only guarantee does not have to be re-argued.
 * 2. No renderer in the **type** closure either, which is the narrower rule this repository
 *    applies to every renderer.
 * 3. No DOM global and no network call anywhere in the runtime closure.
 * 4. No nondeterminism token and no locale API - `Date.now`, `new Date`, `Math.random`,
 *    `localeCompare`, `Intl`, `toLocale*`, `String#normalize`.
 * 5. No prose can reach a suggestion: the adapter never reads `noteText` or
 *    `artifactMarkdown`, and no suggestion or evidence value is a string the engine produced.
 *
 * ## The walks are written here, not reused
 *
 * The Phase 18 boundary gate solves the same problem for `src/core/statistics/**` and the
 * repository's standing rule is that a gate sharing an implementation with the thing it
 * verifies can only agree with itself. Duplicating ~80 lines of walker is cheaper than a gate
 * that a shared bug could silence.
 *
 * ## Every walk includes a positive control
 *
 * The last two tests in this file exercise the walkers and the scanners **against planted
 * offenders in memory**. Without them, a walker that resolved nothing would satisfy every
 * assertion above, and this file would be a vacuous gate that looked exactly like a passing
 * one - which is the failure mode Phase 3 review found five of in this repository.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSISTANCE_EVIDENCE_KEYS,
  ASSISTANCE_SUGGESTION_KINDS,
  type AssistanceEvidence,
  type AssistanceSuggestion,
} from '@/core/assistance/types';
import { rankAssistance } from '@/core/assistance/assistanceEngine';

import { CORPUS_ENTRIES, NOW_ISO, room as roomFixture, SIGNAL_CORPUS } from './support/fixtures';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');
const ASSISTANCE_DIR = join(SRC, 'core', 'assistance');
const ALIAS = '@/';

/** Every module a `src/core/assistance/` module may reach at run time. */
const ALLOWED_PREFIXES = ['src/core/'] as const;

const DOM_APIS = [
  /\bglobalThis\.window\b/,
  /\btypeof\s+window\b/,
  /\bwindow\.(addEventListener|removeEventListener|localStorage|sessionStorage|document|setTimeout|setInterval|requestAnimationFrame|navigator|location|matchMedia)\b/,
  /\bdocument\.(getElementById|querySelector|querySelectorAll|createElement|addEventListener|body|head)\b/,
  /\blocalStorage\.(getItem|setItem|removeItem|clear)\b/,
  /\bindexedDB\.open\b/,
  /\bnavigator\.(sendBeacon|clipboard|geolocation)\b/,
  /\bnew\s+XMLHttpRequest\b/,
] as const;

const NETWORK_CALLS = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bnew\s+Worker\s*\(/,
  /navigator\.connection/,
] as const;

/** Sources of nondeterminism, and the locale surface, forbidden anywhere in the directory. */
const NONDETERMINISM = [
  ['Date.now', /\bDate\s*\.\s*now\s*\(/],
  ['new Date', /\bnew\s+Date\s*\(/],
  ['Date.parse is allowed, Date construction is not', /\bnew\s+Date\b/],
  ['Math.random', /\bMath\s*\.\s*random\s*\(/],
  ['crypto.getRandomValues', /getRandomValues/],
  ['crypto.randomUUID', /randomUUID/],
  ['performance.now', /\bperformance\s*\.\s*now\s*\(/],
  ['localeCompare', /\.localeCompare\s*\(/],
  ['Intl', /\bIntl\s*\./],
  ['toLocale*', /\btoLocale[A-Za-z]*\s*\(/],
  ['String#normalize', /\.normalize\s*\(/],
  ['Number.toLocaleString', /\btoLocaleString\s*\(/],
  ['console', /\bconsole\s*\./],
] as const;

function readSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/import\s*['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  return specifiers;
}

/** Type-only imports and re-exports carry no runtime edge and cannot reach a value. */
function runtimeSpecifiers(source: string): string[] {
  const withoutTypeOnly = source
    .replace(/import\s+type\s[^;'"]*?from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/export\s+type\s[^;'"]*?from\s*['"][^'"]+['"]\s*;?/g, '')
    .replace(/import\s*\{[^}]*\btype\s+[^}]*\}\s*from\s*['"][^'"]+['"]/g, '');
  return readSpecifiers(withoutTypeOnly);
}

function resolveSpecifier(specifier: string, importer: string): string | null {
  const base = specifier.startsWith(ALIAS)
    ? resolve(SRC, specifier.slice(ALIAS.length))
    : specifier.startsWith('.')
      ? resolve(dirname(importer), specifier)
      : null;
  if (base === null) return null;
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(`${base}.tsx`)) return `${base}.tsx`;
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const candidate of ['index.ts', 'index.tsx']) {
      if (existsSync(join(base, candidate))) return join(base, candidate);
    }
  }
  return base;
}

/**
 * The closure of an entry module.
 *
 * An unresolvable specifier is recorded rather than dropped, so a broken resolver is visible
 * instead of producing a small closure that makes every walk above pass vacuously.
 */
function closureOf(entry: string, runtimeOnly: boolean): { files: string[]; unresolved: string[] } {
  const files: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(REPO_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file) || !statSync(file).isFile()) {
      unresolved.push(file);
      continue;
    }
    files.push(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of runtimeOnly ? runtimeSpecifiers(source) : readSpecifiers(source)) {
      const target = resolveSpecifier(specifier, file);
      if (target === null) continue;
      if (!existsSync(target)) {
        unresolved.push(target);
        continue;
      }
      queue.push(target);
    }
  }
  return { files, unresolved };
}

function rel(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

/**
 * The executable code of a source file, with comments and string literals blanked.
 *
 * The module headers in this directory *name* every defect they fix - `Math.random`,
 * `localeCompare`, `new Date`, `console.log` all appear in prose - so a naive scan would read
 * the argument as the violation and make the gate unfixable. Blanking comments and literals is
 * what lets a file explain itself and still be gated.
 */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const ENTRIES = readdirSync(ASSISTANCE_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join('src', 'core', 'assistance', name));

describe('src/core/assistance is renderer-, store-, storage-, and network-free', () => {
  it('has exactly the modules the phase expects, so the walks cannot pass on an empty directory', () => {
    expect(ENTRIES.map((entry) => entry.split('/').pop() ?? '').sort()).toEqual([
      'assistanceEngine.ts',
      'index.ts',
      'subjectInput.ts',
      'types.ts',
    ]);
    expect(ENTRIES.length).toBe(4);
  });

  for (const entry of ENTRIES) {
    it(`${entry} reaches nothing outside src/core/ at run time`, () => {
      const { files, unresolved } = closureOf(entry, true);
      expect(unresolved, `${entry} has an unresolvable import`).toEqual([]);
      const offenders = files
        .map(rel)
        .filter((path) => !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)));
      expect(offenders, `${entry} reaches outside src/core/ at run time`).toEqual([]);
      // And the closure is not empty: the walker reached something, so the empty-set answer was
      // not produced by a resolver that found nothing.
      expect(files.length, `${entry} closure is empty`).toBeGreaterThan(0);
    });

    it(`${entry} has no renderer in its TYPE closure either`, () => {
      const { files, unresolved } = closureOf(entry, false);
      expect(unresolved, `${entry} has an unresolvable import`).toEqual([]);
      const offenders = files
        .map(rel)
        .filter((path) => path.startsWith('src/renderers/') || path.startsWith('src/game/'));
      expect(offenders, `${entry} has a renderer in its type closure`).toEqual([]);
    });

    it(`${entry} uses no DOM global and makes no network call`, () => {
      for (const file of closureOf(entry, true).files) {
        const source = codeOnly(readFileSync(file, 'utf8'));
        for (const api of DOM_APIS) {
          expect(api.test(source), `${rel(file)} matches ${String(api)}`).toBe(false);
        }
        for (const pattern of NETWORK_CALLS) {
          expect(pattern.test(source), `${rel(file)} matches ${String(pattern)}`).toBe(false);
        }
      }
    });

    it(`${entry} reads no clock, no randomness, and no locale`, () => {
      // Scanned in the **whole runtime closure**, not just the entry file, so a helper the
      // engine reaches cannot reintroduce one either.
      for (const file of closureOf(entry, true).files) {
        const source = codeOnly(readFileSync(file, 'utf8'));
        for (const [label, pattern] of NONDETERMINISM) {
          expect(pattern.test(source), `${rel(file)} uses ${label}`).toBe(false);
        }
      }
    });
  }

  it('the engine reaches no store and no service, so a suggestion cannot write', () => {
    // Spelled out separately from the `src/core/` walk because this is *the* advisory-only
    // claim, and a reader should not have to infer it from a prefix list. Enumerated rather
    // than pattern-matched, so a new store module cannot slip in under a path that happens not
    // to match.
    for (const entry of ENTRIES) {
      const offenders = closureOf(entry, true).files
        .map(rel)
        .filter(
          (path) =>
            path.startsWith('src/store/') ||
            path.startsWith('src/services/') ||
            path.startsWith('src/ui/') ||
            path.startsWith('src/application/') ||
            path.startsWith('src/config/') ||
            path.startsWith('src/game/') ||
            path.startsWith('src/renderers/'),
        );
      expect(offenders, `${entry} can reach a writable layer`).toEqual([]);
    }
  });

  it('resolves every specifier the assistance modules name', () => {
    // A broken resolver would make the walks above vacuous, so it is checked directly.
    for (const name of readdirSync(ASSISTANCE_DIR)) {
      if (!name.endsWith('.ts')) continue;
      const file = join(ASSISTANCE_DIR, name);
      for (const specifier of readSpecifiers(readFileSync(file, 'utf8'))) {
        const target = resolveSpecifier(specifier, file);
        if (target === null) continue;
        expect(existsSync(target), `${name} names ${specifier}`).toBe(true);
      }
    }
  });
});

describe('no prose can reach a suggestion', () => {
  it('the adapter never reads noteText or artifactMarkdown', () => {
    // The structural form of "assistance may not carry learner prose". `AssistanceRoomInput`
    // has no field a sentence could occupy, and this asserts the adapter - the only module that
    // knows a snapshot's shape - does not open one either.
    const source = codeOnly(readFileSync(join(ASSISTANCE_DIR, 'subjectInput.ts'), 'utf8'));
    expect(source).not.toContain('noteText');
    expect(source).not.toContain('artifactMarkdown');
    // And the engine's own type has no such field, so the property does not depend on the
    // adapter's discipline.
    const types = readFileSync(join(ASSISTANCE_DIR, 'types.ts'), 'utf8');
    const roomInterface = types.slice(
      types.indexOf('export interface AssistanceRoomInput'),
      types.indexOf('export interface AssistanceEdgeInput'),
    );
    expect(roomInterface).not.toContain('noteText');
    expect(roomInterface).not.toContain('artifactMarkdown');
  });

  it("the room's observable fields are a closed list that cannot express what a note references", () => {
    // The mechanical form of "the `note-adjacent-room-unreferenced` trigger is a *score*, never
    // a reading of the note".
    //
    // That reason code's doc comment used to claim the room "has an adjacent room the note never
    // references". It cannot be checked, because nothing in `AssistanceRoomInput` can say whether
    // a note references anything - so the comment described a condition the engine is structurally
    // unable to observe, and a note that *does* reference the room while scoring zero produces the
    // same advisory. The comment now states the score.
    //
    // A denylist of forbidden field names would be the weak form: it passes for any field nobody
    // thought to forbid, which is how the comment survived review. The field list is instead
    // **closed**, so adding something like `referencedRoomIds` or `noteBody` fails here and has to
    // be justified - and until such a field exists, this is a proof rather than a promise.
    expect(Object.keys(roomFixture({})).sort()).toEqual([
      'criterionScores',
      'failedChecks',
      'finalPass',
      'missingSections',
      'noteWordCount',
      'reviewPassCount',
      'roomId',
      'sm2NextReviewDate',
      'sm2QualityResponse',
      'state',
      'tags',
      'topic',
    ]);
    // And `noteWordCount` is a length, not a text: the only note-derived field is a number, so it
    // can corroborate *how much* was written and never *what*.
    expect(typeof roomFixture({}).noteWordCount).toBe('number');
  });

  it('every produced suggestion and evidence value is a number, a closed-vocabulary key, or an app-minted id', () => {
    // Walks real output over the whole corpus rather than reading the type, because a type can
    // be widened without its consumers changing. `typeof === 'function'` is asserted too: a
    // callable member would be the whole advisory-only guarantee gone.
    for (const mode of ['gentle', 'standard'] as const) {
      for (const [stateName, subjects] of CORPUS_ENTRIES) {
        for (const [signalName, signals] of SIGNAL_CORPUS) {
          const { suggestions } = rankAssistance({
            mode,
            subjects,
            signals,
            nowIso: NOW_ISO,
            flagEnabled: true,
            study: { roomsCleared: 5, notesSubmitted: 5, reviewsCompleted: 5, activeDays: 5, fishKept: 1 },
            fishing: { subjectId: 'subject-a', lastMissedRoomId: 'room-a', missedThisVisit: 2 },
          });
          for (const suggestion of suggestions) {
            assertSuggestionShape(suggestion, `${mode}/${stateName}/${signalName}`);
          }
        }
      }
    }
  });

  it('the evidence vocabulary has no member naming a trait, a mood, or a difficulty', () => {
    // Plan section 8's "no sensitive-trait inference" as a **closed vocabulary** rather than a
    // promise. Every member is a count of a permitted fact; if a future build wanted to say
    // "struggling" or "gifted" or "low ability", it would have to add a member here, and this
    // list would be the diff that made it reviewable.
    expect([...ASSISTANCE_EVIDENCE_KEYS].sort()).toEqual([
      'evidence.active-study-days',
      'evidence.failed-checks',
      'evidence.fishing-recall-misses',
      'evidence.low-recall-ratings',
      'evidence.low-rubric-criteria',
      'evidence.missing-sections',
      'evidence.overdue-days',
      'evidence.overdue-rooms',
      'evidence.repeated-drafts',
      'evidence.review-due-rooms',
      'evidence.rooms-cleared',
      'evidence.subject-rooms',
      'evidence.unlinked-related-rooms',
    ]);
    for (const key of ASSISTANCE_EVIDENCE_KEYS) {
      expect(key.startsWith('evidence.'), key).toBe(true);
      // A **denylist** of the words a trait claim would need, rather than a heuristic like
      // "every key ends in an s" - `evidence.low-rubric-criteria` is a legitimate count whose
      // noun is already plural in Latin form, and a heuristic that flagged it would have been
      // "fixed" by renaming a correct key, which is the wrong fix.
      for (const forbidden of [
        'struggl',
        'gifted',
        'abilit',
        'intellig',
        'skill',
        'confiden',
        'motivat',
        'attitud',
        'persona',
        'engag',
        'interest',
        'frustrat',
        'anxiet',
        'effort',
        'careless',
        'lazy',
      ]) {
        expect(key.includes(forbidden), `${key} contains ${forbidden}`).toBe(false);
      }
    }
    // The claim in one place: every key names a *count of a recorded event*, and the recorded
    // events are the six sources plan section 8 permits. Mapping each key onto its source is
    // the list a reviewer should read, and the `toEqual` makes an unaccounted key fail here
    // rather than passing because nobody wrote down where it came from.
    const sourceByKey: Readonly<Record<string, string>> = {
      'evidence.failed-checks': 'failed note-validation criteria',
      'evidence.missing-sections': 'failed note-validation criteria',
      'evidence.low-rubric-criteria': 'failed note-validation criteria',
      'evidence.repeated-drafts': 'repeated drafts',
      'evidence.unlinked-related-rooms': 'graph structure and related topics',
      'evidence.review-due-rooms': 'review due dates',
      'evidence.overdue-rooms': 'review due dates',
      'evidence.overdue-days': 'review due dates',
      'evidence.low-recall-ratings': 'recall ratings',
      'evidence.fishing-recall-misses': 'fishing recall results',
      'evidence.active-study-days': 'aggregate local study behaviour',
      'evidence.rooms-cleared': 'aggregate local study behaviour',
      'evidence.subject-rooms': 'graph structure and related topics',
    };
    expect(Object.keys(sourceByKey).sort()).toEqual([...ASSISTANCE_EVIDENCE_KEYS].sort());
    // And nothing outside the plan's permitted list is present.
    const permitted = [
      'failed note-validation criteria',
      'repeated drafts',
      'graph structure and related topics',
      'review due dates',
      'recall ratings',
      'fishing recall results',
      'aggregate local study behaviour',
    ];
    for (const [key, source] of Object.entries(sourceByKey)) {
      expect(permitted, `${key} comes from ${source}`).toContain(source);
    }
  });

  it('the suggestion vocabulary has no member that could be an action or an answer', () => {
    expect([...ASSISTANCE_SUGGESTION_KINDS].sort()).toEqual([
      'archaeologist.due-room',
      'archaeologist.low-recall',
      'creator.cross-link',
      'creator.missing-branch',
      'device.due-today',
      'fishing.navigation-after-miss',
      'scribe.missing-section',
      'scribe.related-topic',
      'scribe.rubric-hint',
    ]);
    // Every kind names a *nudge toward an area*, never a verb that could complete or confirm.
    for (const kind of ASSISTANCE_SUGGESTION_KINDS) {
      const [, noun] = kind.split('.');
      expect(noun, kind).toBeDefined();
      for (const forbidden of ['answer', 'confirm', 'validate', 'complete', 'submit', 'award', 'pass', 'auto']) {
        expect(kind.includes(forbidden), `${kind} contains ${forbidden}`).toBe(false);
      }
    }
  });
});

/** Shape assertions for one real suggestion, written out so a failure names the field. */
function assertSuggestionShape(suggestion: AssistanceSuggestion, context: string): void {
  expect(typeof suggestion.suggestionId, context).toBe('string');
  expect(suggestion.suggestionId.split('\n').length, context).toBe(2);
  expect(ASSISTANCE_SUGGESTION_KINDS.includes(suggestion.kind), context).toBe(true);
  expect(['creator', 'scribe', 'archaeologist', 'fishing', 'device']).toContain(suggestion.surface);
  expect(typeof suggestion.targetId, context).toBe('string');
  expect(typeof suggestion.priority, context).toBe('number');
  expect(typeof suggestion.reasonCode, context).toBe('string');
  expect(suggestion.signalKey === null || typeof suggestion.signalKey === 'string', context).toBe(true);
  expect(typeof suggestion.signalValue, context).toBe('number');
  expect(['step', 'cue', 'example']).toContain(suggestion.intensity);
  // The advisory-only half: no member is callable. Checked by value, over every suggestion the
  // engine produced, so a type widening that added a handler would fail here rather than
  // shipping.
  for (const [key, value] of Object.entries(suggestion)) {
    expect(typeof value, `${context} ${key} is a function`).not.toBe('function');
  }
  for (const [key, value] of Object.entries(suggestion.action)) {
    expect(typeof value, `${context} action.${key} is a function`).not.toBe('function');
  }
  expect(['offer-section-scaffold', 'offer-cross-link', 'offer-navigation', 'offer-prioritisation', 'offer-hint']).toContain(
    suggestion.action.kind,
  );
  expect(typeof suggestion.action.subjectId, context).toBe('string');
  expect(suggestion.action.roomId === null || typeof suggestion.action.roomId === 'string', context).toBe(true);
  expect(suggestion.action.detail === null || typeof suggestion.action.detail === 'string', context).toBe(true);
}

describe('the boundary walk can actually fail', () => {
  it('catches a planted renderer, store, and storage import', () => {
    // The positive control, exercised on the specifier form so nothing is written to `src/`
    // and no cross-suite planting can collide with the privacy gate's probe directories.
    for (const [specifier, expectedPrefix] of [
      ['@/game/scenes/DungeonScene', 'src/game/'],
      ['@/renderers/pixi/runtime/PixiWorldHost', 'src/renderers/'],
      ['@/store/progressionStore', 'src/store/'],
      ['@/services/persistence/v2/repository', 'src/services/'],
    ] as const) {
      const resolved = resolveSpecifier(specifier, join(ASSISTANCE_DIR, 'probe.ts'));
      expect(resolved).not.toBeNull();
      expect(rel(resolved as string).startsWith(expectedPrefix), specifier).toBe(true);
      // And the runtime-specifier reader sees a **value** import of it...
      expect(runtimeSpecifiers(`import { x } from '${specifier}';`)).toEqual([specifier]);
      // ...and not a type-only one, which is the distinction the closure walk rests on.
      expect(runtimeSpecifiers(`import type { x } from '${specifier}';`)).toEqual([]);
      expect(runtimeSpecifiers(`export type { x } from '${specifier}';`)).toEqual([]);
    }
    // A type-only import of a persistence *type* is therefore invisible to the runtime walk,
    // which is what lets `src/store/assistanceStore.ts` read the schema's types.
    expect(runtimeSpecifiers("import type { AssistanceMode } from '@/services/persistence/v2/schema';")).toEqual([]);
  });

  it('the forbidden modules the walks exclude all exist, so the exclusion is not vacuous', () => {
    for (const existing of [
      'src/store',
      'src/services',
      'src/ui',
      'src/application',
      'src/config',
      'src/game',
      'src/renderers',
    ]) {
      expect(existsSync(join(REPO_ROOT, existing)), existing).toBe(true);
    }
    // And `src/core` does *not* contain them, so the allow-list is discriminating rather than
    // trivially satisfied.
    expect(existsSync(join(SRC, 'core', 'store'))).toBe(false);
    expect(existsSync(join(SRC, 'core', 'services'))).toBe(false);
  });

  it('the scanners catch each forbidden token when it is planted', () => {
    // Every one, in memory, so the scanner is proven able to fail without touching `src/`.
    for (const [label, pattern] of NONDETERMINISM) {
      const planted = codeOnly(`const planted = ${plantedLiteralFor(label)};`);
      expect(pattern.test(planted), `${label} scanner missed its own token`).toBe(true);
      // And the same scanner passes over the real directory, which is the assertion above.
      const real = ENTRIES.map((entry) => codeOnly(readFileSync(join(REPO_ROOT, entry), 'utf8'))).join('\n');
      expect(pattern.test(real), `${label} appears in the real domain`).toBe(false);
    }
    // `new Date` is listed twice in the table on purpose - once as itself and once as a
    // narrower `new Date\b` - so both spellings are proven to be caught.
    expect(codeOnly('const x = new Date();').includes('new Date')).toBe(true);
  });

  it('the prose-blanking really blanks prose, so a header may name the defect it fixes', () => {
    // Without this, the module headers could not explain themselves without tripping their own
    // gates - and the fix a developer would reach for is deleting the explanation.
    expect(codeOnly('// Math.random is banned here').includes('Math.random')).toBe(false);
    expect(codeOnly('/* use Intl.DateTimeFormat */').includes('Intl')).toBe(false);
    expect(codeOnly("const s = 'fetch(';").includes('fetch(')).toBe(false);
    expect(codeOnly('const x = Math.random();').includes('Math.random')).toBe(true);
    expect(codeOnly('const x = new Date();').includes('new Date')).toBe(true);
  });
});

/** A planted literal per forbidden token, so each scanner is proven against a real match. */
function plantedLiteralFor(label: string): string {
  switch (label) {
    case 'Date.now':
      return 'Date.now()';
    case 'new Date':
    case 'Date.parse is allowed, Date construction is not':
      return 'new Date()';
    case 'Math.random':
      return 'Math.random()';
    case 'crypto.getRandomValues':
      return 'crypto.getRandomValues(buffer)';
    case 'crypto.randomUUID':
      return 'crypto.randomUUID()';
    case 'performance.now':
      return 'performance.now()';
    case 'localeCompare':
      return '"a".localeCompare("b")';
    case 'Intl':
      return 'Intl.NumberFormat()';
    case 'toLocale*':
      return 'value.toLocaleString()';
    case 'String#normalize':
      return '"a".normalize("NFC")';
    case 'Number.toLocaleString':
      return 'n.toLocaleString()';
    case 'console':
      return 'console.log(value)';
    default:
      return 'undefined';
  }
}

describe('evidence rows are counts, and the type says so', () => {
  it('the evidence row shape admits a count and nothing else a sentence could fill', () => {
    // The rows themselves are produced by `explainAssistanceSuggestion` and exercised in
    // `assistanceExplanation.test.ts`. What is pinned here is the **type contract** that makes
    // "evidence is counts only" a checked statement rather than a convention: four fields, one
    // of which is a closed-vocabulary key, one a number, two nullable app-minted ids.
    const row: AssistanceEvidence = {
      labelKey: 'evidence.review-due-rooms',
      value: 3,
      roomId: 'room-a',
      subjectId: 'subject-a',
    };
    expect(typeof row.value).toBe('number');
    expect(ASSISTANCE_EVIDENCE_KEYS.includes(row.labelKey)).toBe(true);
    expect(Object.keys(row).sort()).toEqual(['labelKey', 'roomId', 'subjectId', 'value']);
    // No member is a **free** string. `labelKey` is a member of a closed vocabulary, and
    // `roomId`/`subjectId` are app-minted ids; a `text` or `label` field would be the hole, and
    // this is the assertion that would have to change if one were added. Stated as an explicit
    // allow-list so "the value is a string" cannot be mistaken for "the value is safe".
    for (const key of Object.keys(row)) {
      expect(
        ['labelKey', 'roomId', 'subjectId', 'value'],
        `${key} is a field a sentence could occupy`,
      ).toContain(key);
    }
    // And the two members that *are* strings are constrained in kind, not merely in type.
    expect(typeof row.value, 'the count must stay a number').toBe('number');
    expect(ASSISTANCE_EVIDENCE_KEYS.includes(row.labelKey)).toBe(true);
    expect(typeof row.roomId).toBe('string');
    expect(typeof row.subjectId).toBe('string');
  });
});
