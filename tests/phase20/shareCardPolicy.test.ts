/**
 * Phase 20: the privacy and determinism boundary of the share-card domain.
 *
 * This file gates `src/core/share/**` the way `tests/phase19/assistanceDomainBoundary.test.ts`
 * gates `src/core/assistance/**`, and for the same reason: the guarantees that matter here are
 * claims about **what cannot happen**, and a comment cannot hold a claim about absence.
 *
 * ## The claims, and the mechanical form each takes
 *
 * 1. **Nothing outside `src/core/` is reachable at run time.** Not "no renderer" - the stronger
 *    claim, because it also excludes `@/store`, `@/services`, `@/theme`, and therefore excludes
 *    `localStorage` and `indexedDB`. A card model that could reach a store could read a note body.
 * 2. **No renderer in the *type* closure either**, which is the narrower rule this repository
 *    applies to every renderer: `import type` carries no runtime edge but still couples the
 *    domain to a package version.
 * 3. **No DOM global, no network call, no storage key** anywhere in the runtime closure.
 * 4. **No nondeterminism and no locale surface** - `Date.now`, `new Date`, `Math.random`,
 *    `crypto`, `performance.now`, `localeCompare`, `Intl`, `toLocale*`, `String#normalize`.
 *    Phase 19 found `Date.parse` reading an offset-less ISO timestamp as *local* time, which
 *    changed a ranked assistance result between UTC and Asia/Kolkata; a share card that reads a
 *    clock would put a different string on the same image on every device.
 * 5. **No hardcoded colour or font.** The pre-Phase-20 exporter wrote `#141a2c`, `#7be3ff`, and
 *    `'Inter, sans-serif'` into `ctx.fillStyle` / `ctx.font`, a second declaration of the Phase 8
 *    Cozy token system. A domain module must not carry a style literal at all: it cannot read
 *    `@/theme` (claim 1) and it must not restate the values (claim 5).
 *
 * ## Every walk includes a positive control
 *
 * The last two tests exercise the walkers and the scanners **against planted offenders held in
 * memory**. A walker that resolved nothing, or a scanner whose regex never matched, would satisfy
 * every assertion above - and this file would be a vacuous gate that looked exactly like a passing
 * one. That is the failure mode Phase 3 review found five of in this repository, and the reason
 * each walker here reports `unresolved` specifiers rather than dropping them.
 *
 * ## The policy gate proper
 *
 * The blocks after the controls are about `shareCardPolicy.ts`: that the availability table is
 * self-consistent, that the defaults are a subset of what each kind may show, that the denylist
 * denies the categories and permits the published vocabulary, and that a selection carrying denied
 * values yields nothing.
 *
 * ## The value gate's two jobs
 *
 * The final block states the invariant this phase's one confirmed defect violated, and it is the
 * reason the file ends the way it does. `mayValueAppearOnCard` must refuse identifier-shaped values
 * **whatever they look like**, and it must not refuse prose a learner wrote. The `room` rule was a
 * bare `containsWord` test while its `subject` and `session` neighbours both required an identifier
 * marker, so it refused `Room acoustics`, `Room 101 calculus`, `My bedroom notes`, and
 * `A study room for two` - and published `Session planning`. Both halves are table-driven and each
 * entry names the rule that carries it, so neither half can be satisfied by the other.
 *
 * The last describe block is the one place here that reaches into `src/ui/`, and it is deliberate:
 * `visibleShareCardSubjectName` is the single reachable consumer of the value gate and the only place
 * the defect was ever visible. See the block header.
 *
 * Privacy: every string in this file is synthetic. No real subject, note, room, or learner text
 * appears here.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SHARE_CARD_FIELD_LABELS,
  shareCardCaption,
  shareCardTitle,
} from '@/core/share/shareCardContent';
import {
  DENIED_FIELD_VALUES,
  DEFAULT_SELECTION_BY_KIND,
  availableFieldsFor,
  defaultSelectionFor,
  isDeniedField,
  isDeniedValue,
  isFieldAllowed,
  mayFieldAppearOnCard,
  mayValueAppearOnCard,
  normalizeShareCardSelection,
  orderFields,
  splitSelection,
} from '@/core/share/shareCardPolicy';
import { buildShareCardModel } from '@/core/share/shareCardModel';
import {
  SHARE_CARD_FIELDS,
  SHARE_CARD_FIELDS_BY_KIND,
  SHARE_CARD_FIELD_ORDER,
  SHARE_CARD_KINDS,
  isShareCardField,
  isShareCardKind,
  type ShareCardModel,
} from '@/core/share/types';
import {
  shareCardNameWasWithheld,
  visibleShareCardRows,
  visibleShareCardSubjectName,
} from '@/ui/share/shareCardVisibility';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');
const SHARE_DIR = join(SRC, 'core', 'share');
const ALIAS = '@/';

/** Every module a `src/core/share/` module may reach at run time. */
const ALLOWED_PREFIXES = ['src/core/'] as const;

const DOM_APIS = [
  /\bglobalThis\.window\b/,
  /\btypeof\s+window\b/,
  /\bwindow\.(addEventListener|removeEventListener|localStorage|sessionStorage|document|setTimeout|setInterval|requestAnimationFrame|navigator|location|matchMedia)\b/,
  /\bdocument\.(getElementById|querySelector|querySelectorAll|createElement|addEventListener|body|head|canvas)\b/,
  /\blocalStorage\.(getItem|setItem|removeItem|clear)\b/,
  /\bsessionStorage\.(getItem|setItem|removeItem|clear)\b/,
  /\bindexedDB\.open\b/,
  /\bnavigator\.(sendBeacon|clipboard|geolocation|share|canShare)\b/,
  /\bnew\s+XMLHttpRequest\b/,
  /\bHTMLCanvasElement\b/,
  /\bOffscreenCanvas\b/,
] as const;

const NETWORK_CALLS = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bnew\s+Worker\s*\(/,
  /\bnavigator\.connection\b/,
] as const;

/** Sources of nondeterminism, and the locale surface, forbidden anywhere in the closure. */
const NONDETERMINISM = [
  ['Date.now', /\bDate\s*\.\s*now\s*\(/],
  ['new Date', /\bnew\s+Date\s*\(/],
  ['Math.random', /\bMath\s*\.\s*random\s*\(/],
  ['crypto.getRandomValues', /getRandomValues/],
  ['crypto.randomUUID', /randomUUID/],
  ['performance.now', /\bperformance\s*\.\s*now\s*\(/],
  ['localeCompare', /\.localeCompare\s*\(/],
  ['Intl', /\bIntl\s*\./],
  ['toLocale*', /\btoLocale[A-Za-z]*\s*\(/],
  ['String#normalize', /\.normalize\s*\(/],
  ['console', /\bconsole\s*\./],
] as const;

/**
 * Style literals a domain module must never carry.
 *
 * `progressionShareExport.ts` wrote `#141a2c`, `#7be3ff`, and `'Inter, sans-serif'` directly into
 * canvas calls. The fix is not "use the tokens here"; it is that a `src/core/` module has no canvas
 * and therefore no business holding a colour. Phase 8's Cozy token system is the only place a hex
 * colour lives, and `src/core/share/` may not import it (claim 1).
 *
 * Scanned against **literals intact**, because a colour *is* a string literal - see
 * {@link codeWithLiterals}.
 */
const STYLE_LITERALS = [
  ['hex colour', /#[0-9a-fA-F]{3,8}\b/],
  ['font stack', /font-family|fontFamily|sans-serif|serif\s*['"`]/],
  ['CSS property', /\.fillStyle\b|\.strokeStyle\b|\.font\b|\.textAlign\b/],
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
 * The module headers in this directory *name* every defect they fix - `Date.now`,
 * `localeCompare`, `new Date`, `Math.random` all appear in prose - so a naive scan would read the
 * argument as the violation and make the gate unfixable. Blanking comments and literals is what
 * lets a file explain itself and still be gated.
 */
function codeOnly(source: string): string {
  return commentsBlanked(source)
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * The source with **comments blanked but literals intact**.
 *
 * The module headers here name every defect they fix - `#141a2c`, `'Inter, sans-serif'`,
 * `Date.now` - so a gate has to be able to explain itself without tripping itself. Comments are
 * therefore removed; string literals are kept, because for the style gate the literal *is* the
 * violation.
 */
function commentsBlanked(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const ENTRIES = readdirSync(SHARE_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join('src', 'core', 'share', name))
  .sort();

describe('src/core/share is renderer-, store-, storage-, clock-, and network-free', () => {
  it('has the modules the phase expects, so the walks cannot pass on an empty directory', () => {
    expect(ENTRIES.map((entry) => entry.split('/').pop() ?? '')).toEqual([
      'shareCardContent.ts',
      'shareCardModel.ts',
      'shareCardPolicy.ts',
      'types.ts',
    ]);
  });

  it('resolves every specifier, so no walk below is measuring an empty closure', () => {
    for (const entry of ENTRIES) {
      const { unresolved } = closureOf(entry, false);
      expect(unresolved.map(rel)).toEqual([]);
    }
  });

  it('reaches nothing outside src/core/ at run time', () => {
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const file of closureOf(entry, true).files) {
        const path = rel(file);
        if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
          offenders.push(`${rel(entry)} -> ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches no renderer even in the type closure', () => {
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const file of closureOf(entry, false).files) {
        const path = rel(file);
        if (path.startsWith('src/renderers/') || path.startsWith('src/ui/') || path.startsWith('src/app/')) {
          offenders.push(`${rel(entry)} -> ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no DOM global and no network call in the runtime closure', () => {
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const file of closureOf(entry, true).files) {
        const code = codeOnly(readFileSync(file, 'utf8'));
        for (const pattern of DOM_APIS) {
          if (pattern.test(code)) offenders.push(`${rel(file)} matches ${pattern}`);
        }
        for (const pattern of NETWORK_CALLS) {
          if (pattern.test(code)) offenders.push(`${rel(file)} matches ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no clock, no randomness, and no locale surface in the runtime closure', () => {
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const file of closureOf(entry, true).files) {
        const code = codeOnly(readFileSync(file, 'utf8'));
        for (const [name, pattern] of NONDETERMINISM) {
          if (pattern.test(code)) offenders.push(`${rel(file)} uses ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no colour, font, or canvas styling literal', () => {
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      for (const file of closureOf(entry, true).files) {
        // Literals **intact**: a colour and a font family are both string literals, so
        // blanking literals would make this gate unfalsifiable.
        const code = commentsBlanked(readFileSync(file, 'utf8'));
        for (const [name, pattern] of STYLE_LITERALS) {
          if (pattern.test(code)) offenders.push(`${rel(file)} carries a ${name} literal`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no persistence key, no storage name, and no room, note, or session identifier shape', () => {
    // A domain module cannot *call* storage without the DOM walk failing, but it can still
    // hardcode a key name and hand it to whoever calls it. These are the literals that would do
    // that, plus the shapes the app's minted ids take.
    const offenders: string[] = [];
    for (const entry of ENTRIES) {
      const code = codeOnly(readFileSync(entry, 'utf8'));
      for (const pattern of [
        /\bSTORAGE_KEYS\b/,
        /\blocalStorage\b/,
        /\bindexedDB\b/,
        /\bdatabaseName\b(?!\s*[:?])/,
        /\broom-\d/,
        /\bsubj_/,
        /\bses_\d/,
      ]) {
        if (pattern.test(code)) offenders.push(`${rel(entry)} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── Positive controls: the walks and scanners above, against planted offenders ─────────────

describe('the boundary walks detect offenders (positive controls)', () => {
  /** A module that breaks every claim at once, written to a temp file so the walker reads it. */
  const PLANTED = `
    import { something } from '@/store/progressionStore';
    export async function bad(): Promise<string> {
      const canvas = document.createElement('canvas');
      localStorage.setItem('kd.progression', String(Date.now()));
      const context = canvas.getContext('2d');
      if (context !== null) {
        context.fillStyle = '#141a2c';
        context.font = 'Inter, sans-serif';
      }
      await fetch('/upload', { method: 'POST' });
      const sorted = ['b', 'A'].sort((l, r) => l.localeCompare(r));
      void something;
      return sorted.join(String(Math.random()));
    }
  `;

  it('resolves a planted module and classifies it against the allowed prefixes', () => {
    // The walker is a file reader, so a control that never hands it a file proves nothing. Both
    // files go under the OS temp directory rather than the repository: `closureOf` resolves an
    // absolute path unchanged, and a temporary file inside `src/core/share/` would be picked up by
    // the `readdirSync` that builds `ENTRIES`, which could turn an unrelated gate red.
    const dir = mkdtempSync(join(tmpdir(), 'kd-share-probe-'));
    try {
      const inside = join(dir, 'inside.ts');
      const outside = join(dir, 'outside.ts');
      writeFileSync(inside, PLANTED, 'utf8');
      writeFileSync(outside, PLANTED, 'utf8');

      expect(closureOf(inside, true).files).toContain(inside);

      const path = rel(inside);
      expect(path.startsWith('src/')).toBe(false);
      expect(ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))).toBe(false);

      expect(closureOf(outside, true).files).toContain(outside);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags every planted DOM, network, clock, locale, and style token', () => {
    // Literals **intact** for the style patterns - a colour and a font family are both string
    // literals - and blanked for the rest, matching how the real gate uses each transform.
    const code = codeOnly(PLANTED);
    const withLiterals = commentsBlanked(PLANTED);
    const domHits = DOM_APIS.filter((pattern) => pattern.test(code));
    const networkHits = NETWORK_CALLS.filter((pattern) => pattern.test(code));
    const nondeterminismHits = NONDETERMINISM.filter(([, pattern]) => pattern.test(code));
    const styleHits = STYLE_LITERALS.filter(([, pattern]) => pattern.test(withLiterals));

    expect(domHits.length).toBeGreaterThanOrEqual(2);
    expect(domHits.map(String)).toContain(String(DOM_APIS[3]));
    expect(domHits.map(String)).toContain(String(DOM_APIS[4]));
    expect(networkHits.map(String)).toContain(String(NETWORK_CALLS[0]));
    expect(nondeterminismHits.map(([name]) => name).sort()).toEqual([
      'Date.now',
      'Math.random',
      'localeCompare',
    ]);
    expect(styleHits.map(([name]) => name)).toEqual(['hex colour', 'font stack', 'CSS property']);
  });

  it('reports a broken resolver instead of silently shrinking the closure', () => {
    // A specifier that resolves to nothing is recorded as `unresolved`, not skipped. This is
    // what stops a typo'd path from turning the whole gate into a no-op.
    const { unresolved, files } = closureOf('src/core/share/__no_such_module__.ts', false);
    expect(files).toEqual([]);
    expect(unresolved.length).toBe(1);
  });
});

// ── The policy itself ──────────────────────────────────────────────────────────────────────

describe('the field vocabulary is a closed, self-consistent contract', () => {
  it('declares exactly the four kinds the plan names', () => {
    expect(SHARE_CARD_KINDS).toEqual(['subject-summary', 'collection', 'fish', 'statistics']);
    for (const kind of SHARE_CARD_KINDS) expect(isShareCardKind(kind)).toBe(true);
    expect(isShareCardKind('poster')).toBe(false);
    expect(isShareCardKind(undefined)).toBe(false);
  });

  it('declares exactly the seventeen fields the phase contract fixes', () => {
    expect(SHARE_CARD_FIELDS).toEqual([
      'subjectName',
      'rank',
      'xpTotal',
      'roomsCleared',
      'roomTotal',
      'badgeCount',
      'badgeLabels',
      'inventoryCount',
      'collectedNoteCount',
      'fishTotal',
      'fishUniqueTypes',
      'fishRarityCounts',
      'studyStreakDays',
      'activeStudyDays',
      'sessionsCompleted',
      'recallAccuracy',
      'assistanceSummary',
    ]);
    expect(SHARE_CARD_FIELDS.length).toBe(17);
    for (const field of SHARE_CARD_FIELDS) expect(isShareCardField(field)).toBe(true);
    expect(isShareCardField('noteMarkdown')).toBe(false);
  });

  it('never names a denied category in the allowlist', () => {
    // The two lists are independent declarations, so nothing forces them to agree. This is the
    // gate that says a field can never be both selectable and forbidden.
    for (const field of SHARE_CARD_FIELDS) {
      expect(isDeniedField(field)).toBe(false);
    }
  });

  it('gives every kind a table of known fields, and every kind a field', () => {
    for (const kind of SHARE_CARD_KINDS) {
      const available = SHARE_CARD_FIELDS_BY_KIND[kind];
      expect(available.length).toBeGreaterThan(0);
      for (const field of available) {
        expect(isShareCardField(field)).toBe(true);
        expect(isFieldAllowed(kind, field)).toBe(true);
        expect(mayFieldAppearOnCard(kind, field)).toBe(true);
      }
    }
  });

  it('keeps the render order and the availability table identical', () => {
    for (const kind of SHARE_CARD_KINDS) {
      expect(SHARE_CARD_FIELD_ORDER[kind]).toBe(SHARE_CARD_FIELDS_BY_KIND[kind]);
    }
  });

  it('leaves every field reachable from at least one kind', () => {
    // A field declared in the allowlist and available in no kind would be a dead entry: it could
    // never be selected, so a renderer could never draw it. Either it belongs somewhere or it
    // should not be in the vocabulary.
    const reachable = new Set(SHARE_CARD_KINDS.flatMap((kind) => SHARE_CARD_FIELDS_BY_KIND[kind]));
    for (const field of SHARE_CARD_FIELDS) {
      expect(reachable.has(field)).toBe(true);
    }
  });

  it('gives each kind exactly the fields its card can honestly show', () => {
    // Pinned literally, per kind. A probe that widened the `fish` table to every declared field
    // stayed green against the "every field is reachable from some kind" gate above, because
    // widening a table does not make a field *unreachable*. Only this literal catches it.
    expect(SHARE_CARD_FIELDS_BY_KIND['subject-summary']).toEqual([
      'subjectName',
      'rank',
      'xpTotal',
      'roomsCleared',
      'roomTotal',
      'badgeCount',
      'badgeLabels',
      'inventoryCount',
      'collectedNoteCount',
      'studyStreakDays',
      'activeStudyDays',
      'assistanceSummary',
    ]);
    expect(SHARE_CARD_FIELDS_BY_KIND.collection).toEqual([
      'subjectName',
      'rank',
      'xpTotal',
      'badgeCount',
      'badgeLabels',
      'inventoryCount',
      'collectedNoteCount',
      'fishTotal',
      'fishUniqueTypes',
      'fishRarityCounts',
    ]);
    // A fish card is about fish. `recallAccuracy` and the room counts belong to a statistics or
    // subject-summary card, and a card that mixed them would answer a question nobody asked.
    expect(SHARE_CARD_FIELDS_BY_KIND.fish).toEqual([
      'subjectName',
      'rank',
      'fishTotal',
      'fishUniqueTypes',
      'fishRarityCounts',
    ]);
    expect(SHARE_CARD_FIELDS_BY_KIND.statistics).toEqual([
      'subjectName',
      'rank',
      'roomsCleared',
      'roomTotal',
      'badgeCount',
      'collectedNoteCount',
      'fishTotal',
      'fishUniqueTypes',
      'studyStreakDays',
      'activeStudyDays',
      'sessionsCompleted',
      'recallAccuracy',
      'assistanceSummary',
    ]);
    // And no table may name a kind the vocabulary does not declare: a fifth entry would be a card
    // kind the other gates could not see.
    expect(Object.keys(SHARE_CARD_FIELDS_BY_KIND).sort()).toEqual([...SHARE_CARD_KINDS].sort());
  });

  it('answers the renderer question for an unknown kind or field without throwing', () => {
    expect(isFieldAllowed('poster' as never, 'xpTotal')).toBe(false);
    expect(mayFieldAppearOnCard('statistics', 'noteMarkdown')).toBe(false);
    expect(mayFieldAppearOnCard('statistics', 42)).toBe(false);
    expect(mayFieldAppearOnCard('statistics', null)).toBe(false);
    expect(availableFieldsFor('poster' as never)).toEqual([]);
  });
});

describe('defaults are a subset of what each kind may show', () => {
  it('defaults every field in each kind to an allowed field', () => {
    for (const kind of SHARE_CARD_KINDS) {
      for (const field of DEFAULT_SELECTION_BY_KIND[kind]) {
        expect(isFieldAllowed(kind, field)).toBe(true);
      }
      expect(defaultSelectionFor(kind)).toEqual(DEFAULT_SELECTION_BY_KIND[kind]);
    }
  });

  it('never defaults assistance, note counts, or badge labels', () => {
    // The three exclusions the module header argues for. Each is available on request; none is a
    // default, because a card is a surface the learner hands to someone else.
    for (const kind of SHARE_CARD_KINDS) {
      const defaults = DEFAULT_SELECTION_BY_KIND[kind];
      expect(defaults).not.toContain('assistanceSummary');
      expect(defaults).not.toContain('collectedNoteCount');
      expect(defaults).not.toContain('badgeLabels');
    }
  });

  it('always defaults the subject name, because sharing it is the point', () => {
    for (const kind of SHARE_CARD_KINDS) {
      expect(DEFAULT_SELECTION_BY_KIND[kind]).toContain('subjectName');
    }
  });

  it('offers no default card that can show fish on a fish-free kind', () => {
    expect(DEFAULT_SELECTION_BY_KIND.fish).toEqual([
      'subjectName',
      'fishTotal',
      'fishUniqueTypes',
      'fishRarityCounts',
    ]);
  });
});

describe('the denylist denies the never-shareable categories', () => {
  it('denies each category, whatever its casing or spacing', () => {
    for (const denied of DENIED_FIELD_VALUES) {
      expect(isDeniedField(denied)).toBe(true);
      expect(isDeniedField(denied.toUpperCase())).toBe(true);
      expect(isDeniedField(`  ${denied}  `)).toBe(true);
      expect(isDeniedValue(denied)).toBe(true);
    }
  });

  it('denies minted identifier shapes, not only the literal names', () => {
    // The literal list catches `roomId`. These are the values that actually reach a card.
    for (const minted of [
      'room-7f3a',
      'room_a1b2c3',
      'room.4',
      'subj_a1b2c3d4',
      'subjectId',
      'ses_0001',
      'session-9',
      'note-abc',
      'generation-3',
      'database.knowledge-dungeon',
    ]) {
      expect(isDeniedField(minted)).toBe(true);
    }
  });

  it('denies a wall-clock timestamp in any shape', () => {
    for (const stamp of ['2026-10-05', '2026-10-05T12:00:00.000Z', 'made on 2026-10-05']) {
      expect(isDeniedField(stamp)).toBe(true);
    }
  });

  it('denies an empty string, so a blank field is never treated as publishable', () => {
    expect(isDeniedField('')).toBe(true);
    expect(isDeniedField('   ')).toBe(true);
  });

  it('permits the published vocabulary a card is made of', () => {
    // A denylist that denied these would deny the card: the rank tiers and rarities are
    // app-owned content with a closed set, and every canonical badge label is published copy.
    for (const allowed of [
      'Novice',
      'Scholar',
      'Master',
      'common',
      'rare',
      'epic',
      'First Catch',
      'Master Angler',
      'Scribe Century',
      'roomsCleared',
      'subjectName',
      'xpTotal',
      'assistanceSummary',
      'Badge',
    ]) {
      expect(isDeniedField(allowed)).toBe(false);
    }
  });

  it('ignores non-strings rather than throwing', () => {
    for (const value of [undefined, null, 42, true, {}, [], Symbol('x'), () => 1]) {
      expect(isDeniedField(value)).toBe(false);
    }
  });

  it('is reachable as the value-level renderer check, and refuses every denied category', () => {
    // This is the load-bearing use of the denylist. `splitSelection` cannot use it - the allowlist
    // rejects every denied *name* before the denylist is consulted - so `mayValueAppearOnCard` is
    // where a renderer asks about a string it is about to draw. Probe P3 confirms: neutering the
    // predicate turns these red.
    for (const denied of [...DENIED_FIELD_VALUES, 'room-7f3a', 'subj_a1b2c3', '2026-10-05']) {
      expect(mayValueAppearOnCard(denied)).toBe(false);
      expect(mayValueAppearOnCard(denied)).toBe(!isDeniedField(denied));
    }
    for (const allowed of ['Novice', 'Master', 'common', 'epic', 'First Catch', 'Rooms cleared', '']) {
      expect(mayValueAppearOnCard(allowed)).toBe(!isDeniedField(allowed));
    }
    // Total, like the predicate it wraps: the blank string is the only value that differs, and it
    // is denied on purpose.
    expect(mayValueAppearOnCard(undefined)).toBe(true);
    expect(mayValueAppearOnCard(42)).toBe(true);
  });

  it('never denies a declared field, whatever else it looks like', () => {
    // The allowlist is authoritative. `roomsCleared` contains "room" and `fishUniqueTypes`
    // contains "fish", so a shape-only rule would deny the vocabulary itself.
    for (const field of SHARE_CARD_FIELDS) {
      expect(isDeniedField(field)).toBe(false);
      expect(isDeniedField(field.toUpperCase())).toBe(false);
    }
  });
});

describe('a hostile or over-broad selection cannot make a field render', () => {
  it('drops every denied value and unknown field, and keeps the legitimate survivors', () => {
    const { allowed, dropped } = splitSelection('subject-summary', [
      'xpTotal',
      'noteMarkdown',
      'room-7f3a',
      'badgeId',
      'subjectId',
      '2026-10-05',
      'madeUpField',
      'rank',
      42,
      null,
      undefined,
      'xpTotal',
    ]);
    // Declaration order, not request order: `rank` precedes `xpTotal` in the kind's table.
    expect(allowed).toEqual(['rank', 'xpTotal']);
    expect(dropped).toEqual([
      'noteMarkdown',
      'room-7f3a',
      'badgeId',
      'subjectId',
      '2026-10-05',
      'madeUpField',
      42,
      null,
      undefined,
    ]);
  });

  it('drops a field that is real but belongs to another kind', () => {
    // `recallAccuracy` exists, and is not a fish-card field. Availability is a second axis
    // from the allowlist, and this is where it bites.
    expect(isFieldAllowed('statistics', 'recallAccuracy')).toBe(true);
    expect(isFieldAllowed('fish', 'recallAccuracy')).toBe(false);
    expect(normalizeShareCardSelection('fish', ['recallAccuracy', 'fishTotal'])).toEqual(['fishTotal']);
  });

  it('returns nothing at all for an unknown kind', () => {
    const { allowed, dropped } = splitSelection('poster' as never, ['xpTotal', 'rank']);
    expect(allowed).toEqual([]);
    // Nothing is "dropped" for an unknown kind: the model does not exist, so there is no
    // selection to have rejected entries in.
    expect(dropped).toEqual([]);
  });

  it('normalizes an empty, absent, or non-array selection to nothing without throwing', () => {
    for (const requested of [undefined, null, [], 'xpTotal', 42, {}]) {
      expect(normalizeShareCardSelection('statistics', requested as never)).toEqual([]);
    }
  });

  it('normalizes a selection carrying nothing but denied values to nothing', () => {
    const hostile = [
      'noteBody',
      'noteTopic',
      'roomId',
      'roomList',
      'subjectId',
      'attachmentId',
      'badgeId',
      'sessionId',
      'generatedAt',
      'storageKey',
      'fileName',
      'suggestionId',
      'reasonCode',
      'dismissalRecord',
    ];
    for (const kind of SHARE_CARD_KINDS) {
      expect(normalizeShareCardSelection(kind, hostile)).toEqual([]);
    }
  });
});

describe('field order is a function of the declaration, not of who asked first', () => {
  it('returns a selection in the kind order however it was requested', () => {
    const table = availableFieldsFor('statistics');
    const reversed = [...table].reverse();
    expect(normalizeShareCardSelection('statistics', reversed)).toEqual(table);
    expect(normalizeShareCardSelection('statistics', [...table].sort())).toEqual(table);
    expect(normalizeShareCardSelection('statistics', [...table].sort().reverse())).toEqual(table);
  });

  it('orders an arbitrary subset into the declared order', () => {
    expect(orderFields('collection', ['fishRarityCounts', 'subjectName', 'rank'])).toEqual([
      'subjectName',
      'rank',
      'fishRarityCounts',
    ]);
  });

  it('drops fields not in the kind when ordering', () => {
    expect(orderFields('fish', ['recallAccuracy', 'fishTotal', 'assistanceSummary'])).toEqual([
      'fishTotal',
    ]);
  });

  it('collapses duplicates in a selection', () => {
    expect(normalizeShareCardSelection('fish', ['fishTotal', 'fishTotal', 'fishTotal'])).toEqual([
      'fishTotal',
    ]);
  });
});

// ── The gate's two jobs, which are different ─────────────────────────────────────────────────

/**
 * ## The invariant
 *
 * {@link mayValueAppearOnCard} has exactly two jobs and they pull in opposite directions:
 *
 * 1. refuse an **identifier-shaped** value whatever it looks like - a minted id, a property path, a
 *    storage key, a wall-clock stamp, a note body; and
 * 2. **not** refuse **prose** a learner typed, however many denylisted words it happens to contain.
 *
 * A gate that only does (1) is not conservative, it is broken: it deletes a learner's own words from
 * their own card and calls that privacy. The defect this block pins was exactly that - the `room`
 * rule was a bare `containsWord` test while its `subject` and `session` neighbours both required an
 * identifier marker, so `Room acoustics` and `My bedroom notes` were refused and `Session planning`
 * was not.
 *
 * So both halves are table-driven below, and neither table is allowed to be satisfied by the other.
 * Each entry names the rule that carries it, so the next edit that removes a rule is shown exactly
 * which entry went uncovered rather than "the test failed".
 */
describe('the value gate refuses identifiers and permits the learner prose', () => {
  it('refuses every identifier-shaped value, whatever it looks like', () => {
    /*
     * The **identifier** side. The second element of each pair is the **exact** set of rules that
     * refuse the value, derived by evaluating every predicate in isolation rather than by reading the
     * source - so an entry that claims a rule and is really carried by another one shows up here
     * rather than in a code review. It matters because the three room branches overlap on purpose,
     * and because the entries marked as a rule's *sole* carrier are exactly what probes P3, P4, P5,
     * and P6 remove.
     */
    const IDENTIFIERS: readonly (readonly [string, string])[] = [
      // ── isRoomIdentifier, branch 1 (a marker beside the word). ────────────────────────────────
      // `room-7f3a` is caught by the marker test and independently as a minted prefix; that overlap
      // is why probes P3/P4/P5 use the spellings below, which only one branch each can reach.
      ['room-7f3a', 'isRoomIdentifier:marker + MINTED_ID_PREFIXES'],
      ['room_id', 'isRoomIdentifier:marker + isRoomIdentifier:path + MINTED_ID_PREFIXES'],
      // Sole carriers of branch 1. `room id` has a space, so the path branch cannot see it, and no
      // prefix, so MINTED_ID_PREFIXES cannot either: only the marker test reaches these.
      ['room id', 'isRoomIdentifier:marker (sole carrier)'],
      ['room ids', 'isRoomIdentifier:marker (sole carrier)'],
      ['room key', 'isRoomIdentifier:marker (sole carrier)'],
      // ── isRoomIdentifier, branch 2 (a camel-glued marker). ───────────────────────────────────
      // `roomIds` folds to `roomids`, which has no non-letter boundary for the marker test, and no
      // separator for the path test. Sole carriers of branch 2 - probe P3 removes exactly this.
      ['roomKey', 'isRoomIdentifier:camel (sole carrier)'],
      ['dungeonRoomId', 'isRoomIdentifier:camel (sole carrier)'],
      ['dungeonRoomIds', 'isRoomIdentifier:camel (sole carrier)'],
      ['dungeonRoomKey', 'isRoomIdentifier:camel (sole carrier)'],
      // ── isRoomIdentifier, branch 3 (a path token). ───────────────────────────────────────────
      // The two shapes the module header promises, plus their underscore and dotted spellings.
      // `_42` is too short for the marker test's minted-tail alternative, so these are sole carriers
      // of branch 3 - probe P4 removes exactly this.
      ['dungeonRoom_42', 'isRoomIdentifier:path (sole carrier)'],
      ['dungeon_room_42', 'isRoomIdentifier:path (sole carrier)'],
      ['rooms.visited', 'isRoomIdentifier:path (sole carrier)'],
      ['room.4', 'isRoomIdentifier:path (sole carrier)'],
      // ── The literal list, which `isDeniedField` consults before any shape rule. ──────────────
      ['roomId', 'DENIED_FIELD_VALUES (matched first) + isRoomIdentifier:camel'],
      ['roomIds', 'DENIED_FIELD_VALUES (matched first) + isRoomIdentifier:camel'],
      ['roomList', 'DENIED_FIELD_VALUES (matched first) + isRoomIdentifier:camel'],
      ['roomName', 'DENIED_FIELD_VALUES'],
      ['noteBody', 'DENIED_FIELD_VALUES'],
      ['topic', 'DENIED_FIELD_VALUES'],
      ['subjectId', 'DENIED_FIELD_VALUES'],
      ['sessionId', 'DENIED_FIELD_VALUES'],
      // ── MINTED_ID_PREFIXES: the prefixes this application actually mints. ──────────────────────
      // Sole carriers of that rule - it is the only rule that covers the `subj`/`ses`/`note` families
      // at all, and probe P6 drops one of its prefixes to prove it.
      ['subj_a1b2c3d4', 'MINTED_ID_PREFIXES (sole carrier)'],
      ['ses_0001', 'MINTED_ID_PREFIXES (sole carrier)'],
      ['note-abc', 'MINTED_ID_PREFIXES (sole carrier)'],
      // ── The session and subject word rules, each with its own marker requirement. ────────────
      // Spaced, so neither is a minted prefix and neither has a camel boundary: only the marker
      // requirement reaches them, which is the same reason `room id` is above.
      ['session id', 'isDeniedField:session (sole carrier)'],
      ['subject id', 'isDeniedField:subject (sole carrier)'],
      // ── Storage-key and timestamp shapes, untouched by any room work. ────────────────────────
      ['localStorage.progression', 'isDeniedField:storage-key (sole carrier)'],
      ['database.knowledge-dungeon', 'isDeniedField:storage-key (sole carrier)'],
      ['generation-3', 'isDeniedField:storage-key (sole carrier)'],
      ['2026-10-05', 'isDeniedField:iso-date (sole carrier)'],
      ['2026-10-05T12:00:00.000Z', 'isDeniedField:iso-date (sole carrier)'],
      // A timestamp embedded in prose. The most likely casualty of a "spaced values are prose"
      // patch, and the reason the prose table below is not simply "anything with a space".
      ['made on 2026-10-05', 'isDeniedField:iso-date (sole carrier)'],
      // ── Casing and spacing variants, because `fold` is what makes them equivalent. ────────────
      ['ROOM-7F3A', 'isRoomIdentifier:marker + MINTED_ID_PREFIXES'],
      ['  DungeonRoom_42  ', 'isRoomIdentifier:path (sole carrier)'],
      ['ROOM_ID', 'isRoomIdentifier:marker + isRoomIdentifier:path + MINTED_ID_PREFIXES'],
    ];

    for (const [value, carriedBy] of IDENTIFIERS) {
      expect(isDeniedField(value), `${value} must be denied (carried by ${carriedBy})`).toBe(true);
      // And the renderer-facing form, which is the one a surface actually calls.
      expect(mayValueAppearOnCard(value), `${value} must not appear on a card`).toBe(false);
    }
  });

  it('permits the prose a learner typed, including the substring traps', () => {
    /*
     * The **prose** side. The first four are the four measured false positives, verbatim; the rest
     * are the traps that a "just require a marker" fix gets wrong in the other direction, or that a
     * naive word-boundary fix would have caught.
     */
    const PROSE: readonly (readonly [string, string])[] = [
      // ── The four measured false positives. Each is ordinary English a learner chose. ──────────
      ['Room acoustics', 'was refused by the bare substring test'],
      ['Room 101 calculus', 'was refused by the bare substring test'],
      ['My bedroom notes', "was refused: 'bedroom' contains 'room'"],
      ['A study room for two', 'was refused by the bare substring test'],
      // ── The declared labels the content owner found, which are prose by the same argument. ────
      ['Rooms cleared', 'SHARE_CARD_FIELD_LABELS.roomsCleared'],
      ['Rooms in the dungeon', 'SHARE_CARD_FIELD_LABELS.roomTotal'],
      // ── Substring traps: "room" glued to a prefix, or preceded by a space. ─────────────────────
      ['Bedroom organisation', "'bedroom' contains 'room'"],
      ['Classroom management', "'classroom' contains 'room'"],
      ['Living room acoustics', "'living room' contains 'room'"],
      ['Dining room layout', 'a room in a house, not a room id'],
      // ── The two rules that were already correct, held in place so the fix cannot undo them. ────
      ['Session planning', "the 'session' rule already required a marker"],
      ['Subject 3 revision', "the 'subject' rule already required a marker"],
      ['Sessions completed', 'the statistics field the session rule must not touch'],
      // ── Published vocabulary and the vocabulary of fields. ─────────────────────────────────────
      ['Novice', 'a rank tier'],
      ['First Catch', 'a canonical badge label'],
      ['roomsCleared', 'a declared field id'],
      ['roomsCleared extra', 'prose built from a field id'],
      // ── Single words, and the compounds whose "room" is glued to a prefix. ─────────────────────
      ['Room', 'one word, no separator, no marker'],
      ['Showroom ideas', "a hyphen-free 'room' glued to 'show'"],
      ['Bedroom notes', "a second glued compound, because one test proves nothing"],
    ];

    for (const [value, why] of PROSE) {
      expect(isDeniedField(value), `${value} must not be denied (${why})`).toBe(false);
      expect(mayValueAppearOnCard(value), `${value} must appear on a card (${why})`).toBe(true);
    }
  });

  it('still refuses hyphenated single-token prose, and says which rule is responsible', () => {
    /*
     * A **residual** false refusal of the same class, recorded rather than fixed in passing.
     *
     * `showroom-physics` and `study-room-notes` are ordinary English a learner could have typed, and
     * the gate refuses them. This is **not** the `room` rule: it is the second alternative of
     * `hasIdentifierMarker`, the pre-existing "minted-id tail" test `-`/`_` plus four or more
     * alphanumerics at the end of the value. That branch is the same one refusing `room-7f3a`, and
     * the same one the `subject` and `session` rules depend on.
     *
     * So widening it is a **trade**, not a correction: it would let `showroom-physics` through at the
     * cost of the minted-id guarantee the whole module exists to provide, and it would change the
     * two neighbouring rules at the same time. The measured defect was about *spaced* prose carrying
     * a denylisted word, and every spaced case in the tables above is now published. This is filed
     * here so the next reader knows the case was considered and where it lives, instead of finding it
     * by typing a hyphen.
     */
    for (const value of ['showroom-physics', 'study-room-notes', 'rooms-cleared-notes']) {
      expect(mayValueAppearOnCard(value), `${value} is refused by the minted-tail branch`).toBe(false);
    }
    // The control for that claim: drop the tail and the same value is prose again. Not reachable
    // through the public API, so this states the shape rather than pretending to test the branch.
    for (const value of ['showroom physics', 'study room notes', 'rooms cleared notes']) {
      expect(mayValueAppearOnCard(value), `${value} is prose`).toBe(true);
    }
  });

  it('permits every authored field label, so the value gate can police the values instead', () => {
    /*
     * The decision, defended.
     *
     * `SHARE_CARD_FIELD_LABELS` is app-owned published copy, and it arrived here through a
     * different accident: `roomsCleared: 'Rooms cleared'` and `roomTotal: 'Rooms in the dungeon'`
     * were the only two of the seventeen labels the value gate refused, purely because they contain
     * the word "room". `visibleShareCardRows` does not filter row labels, so nothing shipped broken;
     * it was found because an earlier version *did* filter labels and silently deleted both room
     * rows from every subject-summary card.
     *
     * The choice was between exempting the labels inside the gate and fixing the rule that refused
     * them. The rule won, because **a declared label and a learner's subject name are the same kind
     * of string**: app- or learner-authored prose that identifies nothing. A gate that needs an
     * exemption for one of them needs it for the other, and an exemption list is a second mechanism
     * that the next rule change quietly defeats.
     *
     * So this assertion is the forward-looking guard. If a future label trips the value gate, it
     * fails **here**, in the policy suite, naming the label - rather than being silently deleted by
     * a renderer that a future author decides to filter. The gate keeps every value-level protection
     * below; only this class of app-owned prose is asserted safe.
     */
    const refused = Object.entries(SHARE_CARD_FIELD_LABELS)
      .filter(([, label]) => !mayValueAppearOnCard(label))
      .map(([field, label]) => `${field}: ${label}`);

    expect(refused).toEqual([]);
    // And the control: the gate is not doing this for *everything*. Two of these were, a moment ago,
    // the only labels it refused - which is the whole reason this test can now say "none".
    expect(SHARE_CARD_FIELD_LABELS.roomsCleared).toBe('Rooms cleared');
    expect(mayValueAppearOnCard(SHARE_CARD_FIELD_LABELS.roomsCleared)).toBe(true);
    expect(SHARE_CARD_FIELD_LABELS.roomTotal).toBe('Rooms in the dungeon');
    expect(mayValueAppearOnCard(SHARE_CARD_FIELD_LABELS.roomTotal)).toBe(true);
  });

  it('permits no title and no caption either, for the same reason', () => {
    // The rest of the authored vocabulary on a card. `shareCardTitle`/`shareCardCaption` are
    // functions rather than a table, so every kind is asked for both.
    for (const kind of SHARE_CARD_KINDS) {
      for (const text of [shareCardTitle(kind), shareCardCaption(kind)]) {
        expect(isDeniedField(text), `${text} must not be denied`).toBe(false);
      }
    }
  });

  it('keeps the two halves from trading places: a gate that only permits prose is refused', () => {
    /*
     * The vacuity check, stated as a test rather than left to a probe.
     *
     * Every entry below is refused **for a reason unrelated to the word "room"** - a minted prefix,
     * a literal, a storage-key shape, an ISO date. So if someone "fixes" a false refusal by
     * weakening the gate generally - by allowing anything with a space, or by dropping the shape
     * rules - these go red even though the prose table above stays green. Neither half of the
     * invariant can be bought with the other.
     */
    for (const value of [
      'localStorage.progression',
      'indexedDB.subjects',
      'made on 2026-10-05',
      'noteBody',
      'topic',
      'subj_a1b2c3d4',
      'ses_0001',
      'note-abc',
      'generation-3',
      'session id',
      'subject id',
      'room id',
      'dungeonRoomIds',
      'dungeonRoom_42',
      'rooms.visited',
    ]) {
      expect(mayValueAppearOnCard(value), `${value} must stay refused`).toBe(false);
    }
  });

  it('still answers the renderer question totally, for the values a surface may hand it', () => {
    // The gate is called on whatever is about to be drawn, so it must not throw and must not depend
    // on being handed a string. Only the blank string is denied for being empty.
    for (const value of [undefined, null, 42, true, {}, [], Symbol('x')]) {
      expect(() => mayValueAppearOnCard(value)).not.toThrow();
      expect(mayValueAppearOnCard(value)).toBe(true);
    }
    expect(mayValueAppearOnCard('')).toBe(false);
    expect(mayValueAppearOnCard('   ')).toBe(false);
    // A very long learner name, which is prose, is not truncated into an identifier by accident.
    expect(mayValueAppearOnCard(`${'Room acoustics '.repeat(400)}`)).toBe(true);
  });
});

/**
 * ## The reachable consumer
 *
 * The last block deliberately imports from `src/ui/`, which is a departure from this file's stated
 * scope, and the reason is that **the defect was only ever visible there**.
 *
 * {@link mayValueAppearOnCard} is load-bearing for exactly one caller: `visibleShareCardSubjectName`,
 * which drops the subject name from the card, the dialog's text list, and the suggested file name.
 * A gate tested only through itself proves it agrees with itself; this block asks the surface that
 * actually ships, so a regression in the rule shows up as a card with no title rather than as a
 * disagreement between a predicate and its own test table.
 *
 * Nothing is added to `src/core/share/**`, so the boundary walks above are unaffected - the import
 * runs in the test process, not in the domain's runtime closure.
 */
describe('the value gate reaches the card through the one surface that calls it', () => {
  function modelNamed(name: string): ShareCardModel {
    return buildShareCardModel({ kind: 'subject-summary', subjectName: name }, ['subjectName']);
  }

  it('publishes the four measured false positives, and withholds the ids', () => {
    // Before the fix all four of these returned `null` here, and `shareCardNameWasWithheld` told
    // the learner their name had been withheld - a correct explanation of a wrong refusal.
    for (const name of [
      'Room acoustics',
      'Room 101 calculus',
      'My bedroom notes',
      'A study room for two',
    ]) {
      const model = modelNamed(name);
      expect(visibleShareCardSubjectName(model), name).toBe(name);
      expect(shareCardNameWasWithheld(model), name).toBe(false);
    }

    // The refusal still happens, and the explanation still fires, for the values it exists for.
    for (const id of ['room-7f3a', 'roomId', 'dungeonRoom_42', 'room_id', 'rooms.visited']) {
      const model = modelNamed(id);
      expect(visibleShareCardSubjectName(model), id).toBeNull();
      expect(shareCardNameWasWithheld(model), id).toBe(true);
    }
  });

  it('never withholds a name a learner could reasonably have chosen', () => {
    // The same two tables as above, asserted at the surface rather than at the predicate, so the
    // invariant is pinned where the symptom appeared.
    for (const name of [
      'Rooms cleared',
      'Room 101 calculus',
      'Bedroom organisation',
      'Classroom management',
      'Living room acoustics',
      'Session planning',
      'Subject 3 revision',
      'Novice',
      'First Catch',
    ]) {
      expect(visibleShareCardSubjectName(modelNamed(name)), name).toBe(name);
    }
  });

  it('keeps every declared row label on the card, which is why labels need no exemption', () => {
    // `visibleShareCardRows` does not filter labels - deliberately - and `mayValueAppearOnCard`
    // permits all of them anyway. Both halves are asserted: the rows are present, and the value gate
    // would not have deleted them if a renderer ever did start asking. This is the "defended by a
    // test" half of the label decision, at the surface that would have eaten the rows.
    const model = buildShareCardModel(
      { kind: 'subject-summary', rooms: { total: 40, cleared: 12 } },
      ['roomsCleared', 'roomTotal'],
    );
    const rows = visibleShareCardRows(model);
    expect(rows.map((entry) => entry.row.label)).toEqual(['Rooms cleared', 'Rooms in the dungeon']);
    expect(rows.map((entry) => entry.value)).toEqual(['12', '40']);
    for (const entry of rows) {
      expect(mayValueAppearOnCard(entry.row.label), entry.row.label).toBe(true);
    }
  });
});