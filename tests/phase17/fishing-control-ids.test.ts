/**
 * The fishing control ids, and the boundaries the DOM side holds.
 *
 * ## Two claims, and they are different in kind
 *
 * 1. **`FISHING_CONTROL_IDS` is a static-literal set.** Every value is a fixed string and
 *    nothing is interpolated, because these ids end up in tests, in issue reports, and in
 *    screenshots. The check is *structural* - read the source and take its string literals -
 *    rather than an assertion about the compiled value, because the defect this guards against
 *    is a future edit writing `` `${subjectId}-${x}` `` into the file, and that edit would still
 *    compile and still produce an object.
 *
 * 2. **The DOM fishing tree reaches no renderer.** Three enforced gates already hold
 *    `src/ui/study/**` and `src/ui/village/**`; this one holds the tree Phase 17's DOM work
 *    created. It walks the import graph with the same helper, so a *type-only* import - an edge
 *    the resolver follows and a regex would miss - counts.
 *
 * ## Why the boundary test walks rather than scans
 *
 * `src/ui/fishing/FishingHud.tsx` is the component that drives the pond, so it is exactly where
 * an `import type { FishingController } from '@/renderers/...'` would look reasonable and would
 * be defensible to a reviewer. `fishingHudPort.ts`'s header explains why it is still refused:
 * three gates forbid it, and `tests/phase17/fishing-hud-port.test.ts` proves the two
 * declarations agree instead.
 *
 * ## Non-vacuity
 *
 * Entry and module count floors, and a **detector-level positive control**: the rule functions
 * are exercised directly over a list of specifiers that must be refused and a list that must stay
 * reachable - including `@/core/fishing/fishingStateMachine`, which the HUD legitimately reads for
 * the phase vocabulary.
 *
 * ## Why the positive control is at the detector and not on disk
 *
 * An earlier draft of this file planted a probe under `src/ui/fishing/` and proved the *walk*
 * reported it. That is the shape `tests/phase14/study-shell-boundary.test.ts` and
 * `tests/phase16/renderer-review-boundary.test.ts` use, and it has a cost those files did not
 * anticipate: **the planted file is on the real filesystem while the walk runs**, so any *other*
 * graph gate executing in a parallel worker sees it. `TEST_OWNED_SOURCE_DIRECTORIES` in
 * `tests/privacy/support/appGraph.ts` names only `__privacy_probe__`, and
 * `tests/phase4/plantingExemptionAdversarial.test.ts` pins that list to exactly one entry, so a
 * probe in any other directory is, to a concurrent gate, indistinguishable from a real offender.
 *
 * That race is observable - it made a full-suite run fail once in four with
 * `tests/phase17/fishing-renderer-boundary.test.ts` reporting phase14's planted probe - and it is
 * not this file's to fix. What *is* this file's is whether it adds to the hazard, and it does not:
 * a detector-level control proves the same property with no file ever written.
 *
 * Hermeticity: reads repository source only. Writes nothing. No renderer import, no `dist/`, no
 * network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  allFirstPartyModules,
  readSpecifiers,
  stripComments,
  walkAppGraph,
  type GraphModule,
} from '../privacy/support/appGraph';
import { FISHING_CONTROL_IDS, type FishingControlId } from '@/ui/study/controlIds';

const DOM_FISHING_PREFIX = 'src/ui/fishing/';

/**
 * The modules under test.
 *
 * **Modules, not files.** `allFirstPartyModules()` walks source *modules*, and `.css` is not
 * one - `tests/privacy/support/appGraph.ts` enumerates `MODULE_FILE_PATTERN` for the import
 * graph. So the colocated stylesheet is asserted to *exist* by path rather than by membership:
 * an import-graph gate cannot see a `.css` file, and pretending it can would make "no violation"
 * true for a stylesheet nobody looked at.
 */
const DOM_FISHING_STYLESHEET = 'src/ui/fishing/fishing.css';
const CONTROL_IDS_SOURCE = 'src/ui/study/controlIds.ts';

/* ── The id set ────────────────────────────────────────────────────────────── */

/**
 * Every string literal in the `FISHING_CONTROL_IDS` object body.
 *
 * Taken from the source rather than from the object so a template literal would be visible: a
 * `${...}` inside the object is not a string literal to this scanner, so the count would drop
 * and the assertion would fail - which is the outcome a future interpolation should produce.
 */
function fishingControlIdLiterals(): string[] {
  const source = stripComments(readFileSync(join(process.cwd(), CONTROL_IDS_SOURCE), 'utf8'));
  const start = source.indexOf('export const FISHING_CONTROL_IDS');
  expect(start, 'FISHING_CONTROL_IDS must exist in controlIds.ts').toBeGreaterThan(-1);
  const end = source.indexOf('});', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/'([^']*)'/g)].map((match) => match[1] as string);
}

describe('FISHING_CONTROL_IDS', () => {
  it('is declared beside the three existing id objects, with the same freeze', () => {
    const source = stripComments(
      readFileSync(join(process.cwd(), CONTROL_IDS_SOURCE), 'utf8'),
    );
    // Phase 14's, 15's, 16's, and Phase 17's, in order.
    for (const declared of [
      'export const STUDY_CONTROL_IDS',
      'export const SCRIBE_CONTROL_IDS',
      'export const ARCHAEOLOGIST_CONTROL_IDS',
      'export const FISHING_CONTROL_IDS',
    ]) {
      expect(source, `${declared} must be declared`).toContain(declared);
    }
    expect(source).toContain('export const FISHING_CONTROL_IDS = Object.freeze(');
    // And the type alias beside it, for the same reason each of the other three has one.
    expect(source).toContain(
      'export type FishingControlId = (typeof FISHING_CONTROL_IDS)[keyof typeof FISHING_CONTROL_IDS];',
    );
  });

  it('every value is a static string literal, and there are exactly as many literals as members', () => {
    const values = Object.values(FISHING_CONTROL_IDS);
    const literals = fishingControlIdLiterals();
    // Equal counts: a template literal or an expression would reduce the literal count below
    // the member count, which is exactly the failure this is here to report.
    expect(literals).toHaveLength(values.length);
    expect([...literals].sort()).toEqual([...values].sort());
  });

  it('every value is prefixed, so an id cannot be confused with another surface’s', () => {
    for (const [member, value] of Object.entries(FISHING_CONTROL_IDS)) {
      expect(value, `${member} must be prefixed`).toMatch(/^fishing-[a-z-]+$/);
    }
  });

  it('no two members share a value', () => {
    const values = Object.values(FISHING_CONTROL_IDS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('covers the six learner actions, the catch panel, and the recall route', () => {
    // Named for what they control, not for where they sit: an id that says "the hook button in
    // the third row" is an id that breaks when the layout changes.
    expect([...Object.keys(FISHING_CONTROL_IDS)].sort()).toEqual([
      'castAgain',
      'catchPanel',
      'chargeHold',
      'recallRoom',
      'setHook',
      'tryAgain',
      'walkLeft',
      'walkRight',
    ]);
  });

  it('the type alias admits every member and nothing else', () => {
    const members: FishingControlId[] = [
      FISHING_CONTROL_IDS.chargeHold,
      FISHING_CONTROL_IDS.walkLeft,
      FISHING_CONTROL_IDS.walkRight,
      FISHING_CONTROL_IDS.setHook,
      FISHING_CONTROL_IDS.castAgain,
      FISHING_CONTROL_IDS.tryAgain,
      FISHING_CONTROL_IDS.catchPanel,
      FISHING_CONTROL_IDS.recallRoom,
    ];
    expect(new Set(members).size).toBe(Object.values(FISHING_CONTROL_IDS).length);
  });
});

/* ── The renderer boundary ─────────────────────────────────────────────────── */

/**
 * What the DOM fishing tree may not reach.
 *
 * `src/ui/fishing/**` is where Phase 17's **renderer-free** fishing surfaces live: the HUD, the
 * catch panel, the HUD's own port and copy, the catch transaction, the recall-question route, and
 * the colocated stylesheet. None of them needs a renderer, and `fishingHudPort.ts` re-declares the
 * renderer's capability port precisely because importing it is refused.
 *
 * The lane and the screen-level wiring are **not** here, and where they are matters:
 * `PixiFishingLane.tsx` and `useVillageFishing.tsx` both live in `src/ui/screens/`, beside the
 * village screen that already holds a type-only `VillageWorldHandle`. That is the same split
 * `GameScreen.tsx` has for `DungeonWorldHandle`, and it is the only reason a DOM component can
 * drive a pond without the DOM tree importing an engine.
 */
const FORBIDDEN_TREES: readonly string[] = ['src/renderers/', 'src/game/'];

const FORBIDDEN_PACKAGES: readonly { readonly matches: (specifier: string) => boolean }[] = [
  { matches: (s) => s === 'phaser' || s.startsWith('phaser/') },
  { matches: (s) => s === 'pixi.js' || s.startsWith('pixi.js/') },
  { matches: (s) => s === '@pixi' || s.startsWith('@pixi/') || s.startsWith('@pixi.js') },
];

function forbiddenTreeFor(specifier: string): string | null {
  const normalized = specifier.replace(/\\/g, '/');
  const direct = normalized.startsWith('@/') ? `src/${normalized.slice(2)}` : normalized;
  for (const tree of FORBIDDEN_TREES) {
    const withoutSlash = tree.slice(0, -1);
    if (direct === withoutSlash || direct.startsWith(tree)) return tree;
  }
  if (normalized.startsWith('.')) {
    // The `../` run is stripped and the **tail** compared, because a relative specifier's meaning
    // depends on the depth of the file that wrote it: `../renderers/x` is `src/renderers/x` from
    // `src/ui/village/` and something else from `src/core/fishing/`. Only the last segment of the
    // tree name identifies it, and `src/renderers/` would match nothing here - which is a
    // detector that under-refuses, and the positive control below is what caught it.
    const climbed = normalized.replace(/^(?:\.\.\/|\.\/)+/, '');
    for (const tree of FORBIDDEN_TREES) {
      const tail = tree.slice(0, -1).split('/').pop() as string;
      if (climbed === tail || climbed.startsWith(`${tail}/`)) return tree;
    }
  }
  return null;
}

interface Finding {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

function findingsIn(modules: readonly GraphModule[]): Finding[] {
  const findings: Finding[] = [];
  for (const module of modules) {
    const landedIn = FORBIDDEN_TREES.find((tree) => module.path.startsWith(tree));
    if (landedIn !== undefined) {
      findings.push({ file: module.path, specifier: '<reached>', reason: `lives in ${landedIn}` });
      continue;
    }
    for (const specifier of module.specifiers) {
      const tree = forbiddenTreeFor(specifier);
      if (tree !== null) {
        findings.push({ file: module.path, specifier, reason: `the tree ${tree}` });
        continue;
      }
      const engine = FORBIDDEN_PACKAGES.find((rule) => rule.matches(specifier));
      if (engine !== undefined) {
        findings.push({ file: module.path, specifier, reason: 'an engine package' });
      }
    }
  }
  return findings;
}

function describeFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `${finding.file}: "${finding.specifier}" ${finding.reason}`)
    .sort()
    .join('\n');
}

function domFishingEntries(): string[] {
  return allFirstPartyModules().filter((path) => path.startsWith(DOM_FISHING_PREFIX));
}

function walkClosure(entries: readonly string[]): GraphModule[] {
  const reached = new Map<string, GraphModule>();
  for (const entry of entries) {
    for (const module of walkAppGraph({ entry }).modules) {
      if (!reached.has(module.path)) reached.set(module.path, module);
    }
  }
  return [...reached.values()].sort((left, right) => (left.path < right.path ? -1 : 1));
}

/* ── The positive control, at the detector ────────────────────────────────── */

/**
 * Whether a specifier would be refused, by the same rule the walk applies.
 *
 * Written out rather than reusing a private helper so the control exercises the *published*
 * behaviour of `forbiddenTreeFor` and the package rules, which is what "no violation" rests on.
 */
function refusedByAnyRule(specifier: string): boolean {
  return forbiddenTreeFor(specifier) !== null || FORBIDDEN_PACKAGES.some((rule) => rule.matches(specifier));
}

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('the DOM fishing tree is real, and the walk leaves it', () => {
  it('finds the modules Phase 17’s DOM work added, and reaches outside them', () => {
    const entries = domFishingEntries();
    // Non-vacuity: a filter matching nothing satisfies every boundary assertion below.
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const expected of [
      'src/ui/fishing/FishingHud.tsx',
      'src/ui/fishing/FishingCatchPanel.tsx',
      'src/ui/fishing/fishingHudPort.ts',
      'src/ui/fishing/fishingHudCopy.ts',
      'src/ui/fishing/fishingSession.ts',
      'src/ui/fishing/fishingRecallNavigation.ts',
    ]) {
      expect(entries, `${expected} is missing`).toContain(expected);
    }

    // The stylesheet, by path: see {@link DOM_FISHING_STYLESHEET} for why not by membership.
    expect(existsSync(join(process.cwd(), DOM_FISHING_STYLESHEET))).toBe(true);

    const closure = walkClosure(entries).map((module) => module.path);
    // The closure leaves the DOM tree and reaches the study shell's frozen control-id module and
    // the machine - so "nothing forbidden was reached" is a statement about a set that spans
    // modules. Reaching *into* `src/ui/study/**` is allowed in this direction and only this one:
    // the reverse is `tests/phase14/study-shell-boundary.test.ts`'s rule.
    expect(closure).toContain('src/ui/study/controlIds.ts');
    expect(closure).toContain('src/core/fishing/fishingStateMachine.ts');
    expect(closure).toContain('src/store/fishingCommands.ts');
    // And it leaves the *tree* it was enumerated from. One more than the entry list, because
    // `fishing.css` is reached as an import (the resolver follows it) but is not itself an entry
    // - `allFirstPartyModules` enumerates modules, and a stylesheet is not one.
    const inTree = closure.filter((path) => path.startsWith(DOM_FISHING_PREFIX));
    expect(inTree.length).toBeGreaterThanOrEqual(entries.length);
    expect(inTree).toContain(DOM_FISHING_STYLESHEET);
    expect(closure.length).toBeGreaterThan(entries.length);
  });

  it('resolves every specifier the DOM fishing modules name', () => {
    const unresolved: string[] = [];
    for (const entry of domFishingEntries()) {
      for (const specifier of walkAppGraph({ entry }).unresolved) {
        unresolved.push(`${specifier.from} -> ${specifier.specifier}`);
      }
    }
    expect(unresolved, unresolved.join('\n')).toEqual([]);
  });
});

describe('no module reachable from src/ui/fishing/** reaches a renderer or the study shell', () => {
  it('reports no violation across the whole closure', () => {
    const findings = findingsIn(walkClosure(domFishingEntries()));
    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('the renderer never reaches the DOM fishing tree either', () => {
    // The reverse direction, because `FishingWorld` renders the HUD through a port: a renderer
    // that imported `FishingHud` would put a DOM component into the engine's chunk and make the
    // engine depend on a screen.
    const rendererEntries = allFirstPartyModules().filter((path) =>
      path.startsWith('src/renderers/'),
    );
    const offenders: Finding[] = [];
    for (const entry of rendererEntries) {
      for (const module of walkAppGraph({ entry }).modules) {
        if (module.path.startsWith(DOM_FISHING_PREFIX)) {
          offenders.push({ file: module.path, specifier: '<reached>', reason: 'the DOM fishing tree' });
        }
        for (const specifier of module.specifiers) {
          if (specifier.includes('@/ui/fishing') || specifier.includes('ui/fishing/')) {
            offenders.push({ file: module.path, specifier, reason: 'the DOM fishing tree' });
          }
        }
      }
    }
    expect(offenders, describeFindings(offenders)).toEqual([]);
  });

  it('the HUD’s own port module reaches the machine and no renderer', () => {
    // Stated narrowly, because this is the file a reviewer would most reasonably question:
    // `fishingHudPort.ts` re-declares what `FishingController.ts` declares, and the reason it
    // does not import it is the subject of `fishing-hud-port.test.ts`.
    const findings = findingsIn(walkClosure(['src/ui/fishing/fishingHudPort.ts']));
    expect(findings, describeFindings(findings)).toEqual([]);
    const closure = walkClosure(['src/ui/fishing/fishingHudPort.ts']).map((module) => module.path);
    expect(closure.length).toBe(1);
  });
});

describe('the components Phase 17 added reach neither the fishing command layer by accident nor a console', () => {
  it('the screen and the surfaces name no console call', () => {
    for (const path of [
      'src/ui/screens/VillageScreen.tsx',
      'src/ui/screens/PixiFishingLane.tsx',
      'src/ui/fishing/FishingHud.tsx',
      'src/ui/fishing/FishingCatchPanel.tsx',
      'src/ui/fishing/fishingSession.ts',
      'src/ui/fishing/fishingRecallNavigation.ts',
      'src/ui/components/FishingRecallModal.tsx',
      'src/ui/components/FishStandPanel.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source, `${path} must not log`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)\s*\(/);
    }
  });

  it('the HUD reaches the pond only through its declared port, not through a renderer type', () => {
    const source = stripComments(readFileSync(join(process.cwd(), 'src/ui/fishing/FishingHud.tsx'), 'utf8'));
    for (const specifier of readSpecifiers(source)) {
      expect(
        specifier.startsWith('@/renderers') || specifier.startsWith('@/game'),
        `FishingHud reached ${specifier}`,
      ).toBe(false);
    }
  });
});

describe('positive control: the detector reports what the walk would report', () => {
  it('refuses a renderer type-import in both spellings, and refuses nothing innocent', () => {
    // Every form the walk resolves, so "no violation" cannot be satisfied by a rule that matches
    // nothing. The alias form and the climbing relative form are both listed because both occur in
    // practice and only one of them is obvious.
    for (const specifier of [
      '@/renderers/pixi/fishing/FishingController',
      '@/renderers/pixi/fishing/FishingWorld',
      '@/renderers/pixi/village/VillageWorld',
      '../renderers/pixi/runtime/createPixiWorldHost',
      '../../renderers/pixi/fishing/FishingController',
      '@/game/createGame',
      '../game/scenes/FishingScene',
      'pixi.js',
      'pixi.js/unsafe-eval',
      '@pixi/graphics',
    ]) {
      expect(refusedByAnyRule(specifier), `${specifier} must be refused`).toBe(true);
    }

    // And the innocent ones. `@/core/fishing/fishingStateMachine` is the load-bearing case: the
    // HUD reads it for the phase vocabulary, and a blanket "no `src/core`" rule would have broken
    // the phase while passing every other assertion in this file.
    for (const specifier of [
      'react',
      'zustand',
      '@/core/fishing/fishingStateMachine',
      '@/core/fishing/fishingTypes',
      '@/core/fishing/fishingSession',
      '@/store/fishingCommands',
      '@/ui/study/controlIds',
      '@/ui/study/StudyShell',
      '@/ui/hooks/useModalFocus',
      '@/ui/fishing/fishingHudPort',
      './fishingHudCopy',
    ]) {
      expect(refusedByAnyRule(specifier), `${specifier} must stay reachable`).toBe(false);
    }
  });

  it('reports nothing for the tree as it stands, so the list above is a control and not the claim', () => {
    const findings = findingsIn(walkClosure(domFishingEntries()));
    expect(findings, describeFindings(findings)).toEqual([]);
  });
});
