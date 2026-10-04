/**
 * The renderer boundary, extended for Phase 17's fishing world.
 *
 * ## What this file adds to Phase 16's gate, and why it is a separate file
 *
 * `tests/phase16/renderer-review-boundary.test.ts` already walks the first-party import graph
 * with `tests/privacy/support/appGraph.ts` and holds `src/renderers/**` out of
 * `src/store/**`, `src/ui/**`, `src/electron/**`, `src/core/progression/**`, and the review
 * command layer. Phase 17 adds three rules that gate does not have, and each has a Phase 17
 * failure behind it:
 *
 * 1. **`@/application/fishingCommands` and `@/store/fishingCommands`.** The catch
 *    transaction `core-logic-engineer` landed in this phase is *exactly* the kind of thing a
 *    renderer reaches for: the machine reveals a catch, and the obvious shortcut is to award
 *    it. A renderer that did that would be a third writer of progression, outside the
 *    idempotent transaction the phase exists to build.
 * 2. **`@/game/**`.** `FishingScene.ts` is the rollback lane and stays untouched. A new
 *    module in the Pixi tree that reached it would couple the new renderer to the old one,
 *    and Phase 24's removal of Phaser would then break the Pixi pond.
 * 3. **`@/ui/study/**`.** Plan 6.1's renderer-free boundary for the study shell. The pond's
 *    React surface is `src/renderers/pixi/fishing/FishingWorld.tsx`, which is in the renderer
 *    tree and therefore *not* a study-shell module - so the rule is that nothing under
 *    `src/renderers/**` imports the study shell, and the reverse direction is held too,
 *    because a renderer reached *from* the study shell would put PixiJS in a neutral module.
 *
 * ## Why the positive control is planted here and not in Phase 16's file
 *
 * Phase 16's file plants a type-only `renderers/__phase16_boundary_probe__` into
 * `@/store/reviewCommands`. This file plants its own, into `@/store/fishingCommands`, because
 * a probe that reuses another phase's directory would be removed by that file's `afterEach`
 * if the two ever ran in the same process and would double-count the probe in the closure.
 * `testOwnedDirectory` names it under this file's own marker, and `clearPlantingDeclarations`
 * is what both share.
 *
 * ## Why every entry list here skips a live planting
 *
 * Because three boundary gates now plant under `src/` on the real filesystem and Vitest runs the
 * files in parallel workers, so one worker's probe is otherwise a real entry in another's scan.
 * The exclusion is `isTestOwnedTransientModule` — the repository's own declaration-keyed
 * predicate — and the positive control below asks for the probe by name, because its whole claim
 * is that the walk sees it. `ui-engineer`'s earlier note claiming a probe-directory comment was
 * "not implemented" was wrong: Phase 14's own file has said this since it was written. It is
 * implemented here now, in all three files, and `tests/phase4/plantingExemptionAdversarial.test.ts`
 * pins the shared inventory that makes it work.
 *
 * ## Non-vacuity
 *
 * - An entry-count floor, and the three new modules named individually, so a filter that
 *   matched nothing cannot satisfy any assertion below.
 * - A closure that must reach **outside** the renderer tree, so "no store was reached" is a
 *   statement about a set that spans modules.
 * - A detector check over both spellings of every forbidden source plus a list of innocent
 *   ones that must stay reachable - including `@/core/fishing/fishingStateMachine`, which the
 *   pond legitimately reads and which a blanket "no `src/core`" rule would have broken.
 * - A positive control that goes red on a planted probe and returns the tree to its prior
 *   state exactly.
 *
 * Hermeticity: reads repository source only. No renderer import, no `dist/`, no network, no
 * clock. Findings carry a repo-relative path, a specifier, and a rule name - never source text
 * and never learner data.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  allFirstPartyModules,
  clearPlantingDeclarations,
  isTestOwnedTransientModule,
  PHASE17_FISHING_PROBE_DIRECTORY,
  readSpecifiers,
  stripComments,
  testOwnedDirectory,
  walkAppGraph,
  writePlantingMarker,
  type GraphModule,
} from '../privacy/support/appGraph';

/** The tree this file holds the boundary for. */
const RENDERER_PREFIX = 'src/renderers/';

/**
 * Phase 17's additions to the forbidden trees.
 *
 * `src/game/**` is the rollback lane rather than a store, and it is listed here because a
 * Pixi module reaching Phaser would couple the two renderers Phase 24 is meant to separate.
 * `src/ui/study/**` is listed because it is the plan 6.1 renderer-free shell: nothing in the
 * renderer tree may reach it, and nothing there may be reached *from* it.
 */
const PHASE17_RENDERER_TREES: readonly string[] = ['src/store/', 'src/game/', 'src/ui/study/'];

interface ForbiddenSpecifier {
  readonly label: string;
  readonly matches: (specifier: string) => boolean;
}

/**
 * True when a specifier addresses one of the forbidden first-party trees.
 *
 * Both spellings, for `tests/phase14/study-shell-boundary.test.ts`'s reason: the alias form
 * `@/store/fishingCommands` and the climbing relative form `../../game/createGame`, whose
 * meaning depends on the depth of the file that wrote it.
 */
function forbiddenTreeFor(specifier: string): string | null {
  const normalized = specifier.replace(/\\/g, '/');
  const direct = normalized.startsWith('@/') ? `src/${normalized.slice(2)}` : normalized;
  for (const tree of PHASE17_RENDERER_TREES) {
    if (direct === tree.slice(0, -1) || direct.startsWith(tree)) return tree;
  }
  if (normalized.startsWith('.')) {
    const climbed = normalized.replace(/^(?:\.\.\/|\.\/)+/, '');
    // `src/ui/study/`, **not** `study/`: Phase 16's trees are all one segment below `src`, so
    // its helper can take the last segment and be exact. A nested tree breaks that - the last
    // segment of `src/ui/study/` is `study`, and matching a bare `study/...` tail would both
    // miss `../ui/study/x` and refuse an innocent `../lib/study/x`. So the `src/` prefix is
    // stripped and the whole remaining path compared.
    for (const tree of PHASE17_RENDERER_TREES) {
      const relative = tree.replace(/^src\//, '').slice(0, -1);
      if (climbed === relative || climbed.startsWith(`${relative}/`)) return tree;
    }
  }
  return null;
}

/**
 * The fishing command layer, by both of its spellings.
 *
 * Named separately from the trees above because these are two files rather than two
 * directories, and because they are *this phase's* temptation: the catch transaction is the
 * one thing the machine's `catch-revealed` effect most invites a renderer to skip.
 */
/**
 * Whether a specifier addresses a forbidden module, in either spelling.
 *
 * The alias form (`@/store/fishingCommands`) and the climbing relative form
 * (`../../store/fishingCommands`) both match, for the reason
 * `tests/phase14/study-shell-boundary.test.ts` gives. A tree rule can be exact about depth
 * because a tree name identifies itself; a *module* rule cannot, because `../store/x` from
 * two directories down is `src/core/store/x` and from three is `src/store/x`. So the relative
 * form is matched on its **tail**: any relative specifier whose path ends in
 * `store/fishingCommands` or `application/fishingCommands` is refused, whatever depth wrote
 * it. That over-refuses rather than under-refuses, which is the right direction for a gate -
 * the cost of a false positive is a renamed import, and the cost of a false negative is a
 * renderer awarding a catch.
 */
function matchesCommandPath(specifier: string, modulePath: string): boolean {
  const normalized = specifier.replace(/\\/g, '/');
  if (normalized.startsWith('@/')) return normalized === `@/${modulePath}`;
  if (!normalized.startsWith('.')) return false;
  return normalized.replace(/^(?:\.\.\/|\.\/)+/, '') === modulePath;
}

const FISHING_COMMAND_SPECIFIERS: readonly ForbiddenSpecifier[] = [
  {
    label: 'the application fishing command layer',
    matches: (specifier) => {
      if (specifier.startsWith('@/')) {
        return (
          specifier === '@/application/fishingCommands' ||
          specifier.startsWith('@/application/fishingCommands/')
        );
      }
      const tail = specifier.replace(/^(?:\.\.\/|\.\/)+/, '');
      return tail === 'application/fishingCommands' || tail.startsWith('application/fishingCommands/');
    },
  },
  {
    label: 'the store fishing command binding',
    matches: (specifier) => {
      if (specifier.startsWith('@/')) {
        return specifier === '@/store/fishingCommands' || specifier.startsWith('@/store/fishingCommands/');
      }
      const tail = specifier.replace(/^(?:\.\.\/|\.\/)+/, '');
      return tail === 'store/fishingCommands' || tail.startsWith('store/fishingCommands/');
    },
  },
];

/**
 * The Phase 16 rule, re-derived rather than inherited.
 *
 * `@/core/progression` is forbidden *for renderer modules*, and the qualification matters:
 * `src/application/fishingCommands.ts` legitimately imports `@/core/progression/types`,
 * because awarding a catch is the command layer's job. If the rule were applied to every
 * module in the renderer *closure*, then any legitimate reach into a command module would
 * report that module's own correct imports as violations - which is why this list is matched
 * against renderer-tree modules only, and why the check is a separate assertion rather than
 * one of the closure rules.
 */
const RENDERER_PROGRESSION_RULE: ForbiddenSpecifier = {
  label: 'the progression core module',
  matches: (specifier) =>
    specifier === '@/core/progression' || specifier.startsWith('@/core/progression/'),
};

const PHASE17_RENDERER_FORBIDDEN: readonly ForbiddenSpecifier[] = [
  ...PHASE17_RENDERER_TREES.map((tree) => ({
    label: `the tree ${tree}`,
    matches: (specifier: string) => forbiddenTreeFor(specifier) === tree,
  })),
  ...FISHING_COMMAND_SPECIFIERS,
];

interface BoundaryFinding {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

function findingsIn(
  modules: readonly GraphModule[],
  rules: readonly ForbiddenSpecifier[],
  forbiddenTrees: readonly string[],
): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  for (const module of modules) {
    const landedIn = forbiddenTrees.find((tree) => module.path.startsWith(tree));
    if (landedIn !== undefined) {
      findings.push({
        file: module.path,
        specifier: '<reached>',
        reason: `the module itself lives in ${landedIn}`,
      });
      continue;
    }
    for (const specifier of module.specifiers) {
      const rule = rules.find((candidate) => candidate.matches(specifier));
      if (rule !== undefined) {
        findings.push({ file: module.path, specifier, reason: rule.label });
      }
    }
  }
  return findings;
}

function describeFindings(findings: readonly BoundaryFinding[]): string {
  return findings
    .map((finding) => `${finding.file}: "${finding.specifier}" ${finding.reason}`)
    .sort()
    .join('\n');
}

function rendererEntries(options: { includeLivePlantings?: boolean } = {}): string[] {
  return allFirstPartyModules().filter(
    (path) =>
      path.startsWith(RENDERER_PREFIX) &&
      (options.includeLivePlantings === true || !isTestOwnedTransientModule(path)),
  );
}

/**
 * Every module under a first-party tree, minus any module a live planting declared.
 *
 * **Why this filter exists.** Three boundary gates plant probes on the real filesystem inside
 * `src/` as positive controls, Vitest runs files in parallel workers, and a probe one worker
 * planted is otherwise a real entry in this worker's scan. That is not hypothetical: this file's
 * "study shell is renderer-free in both directions" walk used to fail roughly one `npm test` run
 * in four, naming `src/ui/study/__boundary_probe__/probe.ts` — Phase 14's probe, whose whole
 * purpose is to import `@/renderers/pixi/dungeon/dungeonArtifact` so that Phase 14's own
 * positive control goes red. The probe is a deliberate violation; it is not a finding.
 *
 * The exclusion is `isTestOwnedTransientModule`, the repository's own predicate, and it is keyed
 * on the **declaration** the planting wrote rather than on a directory name — so a real offender
 * dropped into one of those directories while a planting is in flight is still scanned, and a
 * probe left behind after the planting ended is scanned like any other source file. The marker,
 * not the name, is what has always been load-bearing here; see
 * `tests/privacy/support/appGraph.ts` and `tests/phase4/plantingExemptionAdversarial.test.ts`.
 */
function treeEntries(...prefixes: readonly string[]): string[] {
  return allFirstPartyModules().filter(
    (path) => prefixes.some((prefix) => path.startsWith(prefix)) && !isTestOwnedTransientModule(path),
  );
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

function readRepoFile(repoRelativePath: string): string {
  return readFileSync(join(process.cwd(), repoRelativePath), 'utf8');
}

/* ── The positive control's probe ───────────────────────────────────────────── */

/**
 * A *value* import of the store binding, deliberately.
 *
 * Phase 16's probe is type-only because its claim is the stronger one there. This phase's
 * claim is the ordinary one - a renderer must not *call* the catch transaction - so the probe
 * is the shape a real mistake would have: a value import of the binding, which is what a
 * renderer reaching for an award would write.
 */
const PROBE_DIRECTORY_NAME = PHASE17_FISHING_PROBE_DIRECTORY;
const PROBE_DIRECTORY = testOwnedDirectory(PROBE_DIRECTORY_NAME);
const PROBE_PATH = `src/${PROBE_DIRECTORY_NAME}/probe.ts`;
const PROBE_SOURCE = `import { awardFishingCatch } from '@/store/fishingCommands';

export const PHASE17_FISHING_BOUNDARY_PROBE: number = awardFishingCatch.length;
`;

function removeProbe(): void {
  rmSync(PROBE_DIRECTORY, { recursive: true, force: true });
  clearPlantingDeclarations();
}

function plantProbe(): void {
  removeProbe();
  mkdirSync(PROBE_DIRECTORY, { recursive: true });
  writeFileSync(join(PROBE_DIRECTORY, 'probe.ts'), PROBE_SOURCE, 'utf8');
  writePlantingMarker(PROBE_DIRECTORY_NAME, [PROBE_PATH]);
}

afterEach(() => {
  removeProbe();
});

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('the fishing renderer tree is enumerated, and the walk reaches real modules', () => {
  it('finds the three Phase 17 modules and leaves the subtree', () => {
    const entries = rendererEntries();

    // Non-vacuity floor: a filter matching nothing satisfies every boundary below.
    expect(entries.length).toBeGreaterThan(25);
    // Named individually, so a module added to this tree that *did* reach a store fails here
    // rather than passing while a prefix assertion stays satisfied by a sibling.
    expect(entries).toContain('src/renderers/pixi/fishing/FishingWorld.tsx');
    expect(entries).toContain('src/renderers/pixi/fishing/FishingController.ts');
    expect(entries).toContain('src/renderers/pixi/fishing/createFishingScene.ts');

    const closure = walkClosure(entries).map((module) => module.path);
    // The closure leaves the renderer tree, and it reaches the machine the pond is built on -
    // so "nothing forbidden was reached" is a statement about a set that spans modules.
    expect(closure).toContain('src/application/contracts/renderer.ts');
    expect(closure).toContain('src/core/fishing/fishingStateMachine.ts');
    expect(closure).toContain('src/services/audioManager.ts');
    expect(closure.length).toBeGreaterThan(entries.length);
  });

  it('resolves every specifier the renderer modules name', () => {
    const unresolved: string[] = [];
    for (const entry of rendererEntries()) {
      for (const specifier of walkAppGraph({ entry }).unresolved) {
        unresolved.push(`${specifier.from} -> ${specifier.specifier}`);
      }
    }
    expect(unresolved, unresolved.join('\n')).toEqual([]);
  });
});

describe('no module reachable from src/renderers/** reaches the fishing command layer', () => {
  it('the command-path matcher handles both spellings and refuses a cross-tree impostor', () => {
    // The matcher on its own. `matchesCommandPath` over-refuses on the relative form by
    // design, and this states the boundary of that: a same-named module under a *different*
    // tree is not matched by the alias form, and the tail form is what a depth-independent
    // rule can actually say.
    expect(matchesCommandPath('@/store/fishingCommands', 'store/fishingCommands')).toBe(true);
    expect(matchesCommandPath('../../store/fishingCommands', 'store/fishingCommands')).toBe(true);
    expect(matchesCommandPath('./fishingCommands', 'store/fishingCommands')).toBe(false);
    expect(matchesCommandPath('@/ui/store/fishingCommands', 'store/fishingCommands')).toBe(false);
    // And the real relative spelling a renderer could write from three directories down.
    expect(matchesCommandPath('../../../store/fishingCommands', 'store/fishingCommands')).toBe(
      true,
    );
  });
  it('reports no violation across the whole renderer closure', () => {
    const findings = findingsIn(
      walkClosure(rendererEntries()),
      PHASE17_RENDERER_FORBIDDEN,
      PHASE17_RENDERER_TREES,
    );

    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('no renderer module names the progression core, checked on the renderer tree itself', () => {
    // A separate assertion rather than one of the closure rules above, and the reason is in
    // `RENDERER_PROGRESSION_RULE`: `src/application/fishingCommands.ts` legitimately imports
    // `@/core/progression/types`, because awarding a catch is its job. Applying the rule to
    // the closure would report that correct import as a violation, so the rule is matched
    // against the modules a renderer *is*.
    const offenders: BoundaryFinding[] = [];
    for (const entry of rendererEntries()) {
      for (const specifier of walkAppGraph({ entry }).modules.flatMap((m) => m.specifiers)) {
        if (RENDERER_PROGRESSION_RULE.matches(specifier)) {
          offenders.push({ file: entry, specifier, reason: RENDERER_PROGRESSION_RULE.label });
        }
      }
    }

    expect(offenders, describeFindings(offenders)).toEqual([]);
  });

  it('classifies both spellings of every forbidden source, and no innocent one', () => {
    // The detector on its own, with no filesystem: cheap, and it covers the forms a planted
    // file would not exercise. The progression rule is checked too, as a *rule* - its
    // application is scoped separately, and the reason is in `RENDERER_PROGRESSION_RULE`.
    const rules = [...PHASE17_RENDERER_FORBIDDEN, RENDERER_PROGRESSION_RULE];
    for (const specifier of [
      '@/store/fishingCommands',
      '@/store/fishingCommands/awardFishingCatch',
      '@/application/fishingCommands',
      '@/application/fishingCommands/createFishingController',
      '../store/fishingCommands',
      '../../application/fishingCommands',
      '@/core/progression',
      '@/core/progression/badges',
      '@/game/createGame',
      '@/game/adapters',
      '@/game/scenes/FishingScene',
      '../game/createGame',
      '@/ui/study/StudyShell',
      '../ui/study/creator/useCreatorGraphActions',
    ]) {
      expect(rules.some((rule) => rule.matches(specifier)), `${specifier} must be refused`).toBe(
        true,
      );
    }

    // And the innocent ones. `@/core/fishing/fishingStateMachine` is the load-bearing one: the
    // pond is built on it, and a blanket "no `src/core`" rule would have broken the phase. It
    // is *reachable* while the progression core and the command layer are not.
    for (const specifier of [
      'react',
      'pixi.js',
      'zustand',
      '@/application/contracts/renderer',
      '@/application/contracts/world',
      '@/core/fishing/fishingStateMachine',
      '@/core/fishing/fishingTypes',
      '@/core/fishing/fishingMechanics',
      '@/data/villageLayout',
      '@/theme',
      '@/services/audioManager',
      '@/renderers/pixi/runtime/createPixiWorldHost',
      './FishingController',
      './createFishingScene',
    ]) {
      expect(rules.some((rule) => rule.matches(specifier)), `${specifier} must stay reachable`).toBe(
        false,
      );
    }
  });

  it('is not fooled by the forbidden words in the modules it is checking', () => {
    // `createFishingScene.ts` and `FishingController.ts` both *name* the forbidden sources in
    // prose - each explains why a renderer may not award a catch itself. A scan that read raw
    // text would report the documentation as a violation.
    for (const path of [
      'src/renderers/pixi/fishing/createFishingScene.ts',
      'src/renderers/pixi/fishing/FishingController.ts',
    ]) {
      const raw = readRepoFile(path);
      expect(raw, `${path} must still explain the rule it is held to`).toContain('fishingCommands');

      const code = stripComments(raw);
      expect(code, 'the claim lives in a comment and must be stripped').not.toContain(
        'fishingCommands',
      );
      // And what survives stripping - the module's actual imports - is clean.
      for (const specifier of readSpecifiers(code)) {
        expect(
          PHASE17_RENDERER_FORBIDDEN.some((rule) => rule.matches(specifier)),
          `${path} -> ${specifier}`,
        ).toBe(false);
      }
    }
  });
});

describe('no domain module reaches the fishing renderer, in either direction', () => {
  it('src/core and src/application may not import the pond or the Phaser rollback lane', () => {
    // Re-derived rather than trusted to the Phase 16 gate, because Phase 17 added
    // `src/core/fishing/**` and `src/application/contracts/**` members and the gate that covers
    // them should say so. No store rule in this direction, and the omission is Phase 16's:
    // `src/core/**` legitimately reads a store today.
    const entries = treeEntries('src/core/', 'src/application/');
    expect(entries).toContain('src/core/fishing/fishingStateMachine.ts');
    expect(entries).toContain('src/core/fishing/catchRewards.ts');
    expect(entries.length).toBeGreaterThan(40);

    const findings = findingsIn(
      walkClosure(entries),
      [
        {
          label: 'the PixiJS renderer tree',
          matches: (specifier) => specifier.startsWith('@/renderers'),
        },
        {
          label: 'the Phaser host',
          matches: (specifier) => specifier.startsWith('@/game'),
        },
        {
          label: 'an engine package',
          matches: (specifier) =>
            specifier === 'phaser' ||
            specifier.startsWith('phaser/') ||
            specifier === 'pixi.js' ||
            specifier.startsWith('pixi.js/') ||
            specifier.startsWith('@pixi/'),
        },
      ],
      [],
    );

    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('the study shell is renderer-free in both directions', () => {
    // Plan 6.1 plus plan 10.1's rule that no neutral module may pull in an engine. The shell
    // reaching a renderer would put PixiJS into a module that must work without it; a renderer
    // reaching the shell would make the engine depend on a screen.
    const shellEntries = treeEntries('src/ui/study/');
    expect(shellEntries.length).toBeGreaterThan(10);

    const shellToRenderer: BoundaryFinding[] = [];
    for (const module of walkClosure(shellEntries)) {
      if (module.path.startsWith(RENDERER_PREFIX)) {
        shellToRenderer.push({
          file: module.path,
          specifier: '<reached>',
          reason: 'the module itself lives in the renderer tree',
        });
        continue;
      }
      for (const specifier of module.specifiers) {
        if (specifier.startsWith('@/renderers') || specifier.startsWith('@/game')) {
          shellToRenderer.push({ file: module.path, specifier, reason: 'a renderer tree' });
        }
      }
    }
    expect(shellToRenderer, describeFindings(shellToRenderer)).toEqual([]);

    // And the reverse direction, through the pond's own modules rather than by rule.
    const fishingEntries = rendererEntries().filter((path) =>
      path.startsWith('src/renderers/pixi/fishing/'),
    );
    expect(fishingEntries).toHaveLength(3);
    const fishingToShell = findingsIn(walkClosure(fishingEntries), [], ['src/ui/study/']);
    expect(fishingToShell, describeFindings(fishingToShell)).toEqual([]);
  });

  it('the catch transaction is the renderer one layer above, and the two are separate', () => {
    // Stated so the boundary has both halves on the record: the binding exists, it is where
    // the catch crosses into the application, and the pond must not reach it. The Phase 16
    // file asserts the same pair for the review ledger, and the two are read together.
    expect(readRepoFile('src/store/fishingCommands.ts')).toContain('fishingCommands');
    expect(readRepoFile('src/store/fishingCommands.ts')).not.toContain('@/renderers');
    expect(readRepoFile('src/core/fishing/catchRewards.ts')).not.toContain('@/renderers');
  });
});

describe('positive control: the same walk reports a planted renderer-to-store import', () => {
  it('goes red on a probe inside src/renderers/, and the tree is clean once it is gone', () => {
    const baselineEntries = rendererEntries();
    const baselineFindings = findingsIn(
      walkClosure(rendererEntries()),
      PHASE17_RENDERER_FORBIDDEN,
      PHASE17_RENDERER_TREES,
    );
    expect(baselineFindings, describeFindings(baselineFindings)).toEqual([]);

    try {
      plantProbe();
      expect(existsSync(join(process.cwd(), PROBE_PATH))).toBe(true);

      // The probe is inside the renderer subtree, so it becomes an entry and the walk follows
      // its edge out into the store.
      expect(
        rendererEntries({ includeLivePlantings: true }),
        'the probe must become an entry or nothing is proved',
      ).toContain(PROBE_PATH);

      const findings = findingsIn(
        walkClosure(rendererEntries({ includeLivePlantings: true })),
        PHASE17_RENDERER_FORBIDDEN,
        PHASE17_RENDERER_TREES,
      );
      // Attributable to the probe by the specifier it used - and also to the store module the
      // walk reached, so both halves of the check are exercised.
      expect(
        findings.some(
          (finding) =>
            finding.file === PROBE_PATH && finding.specifier === '@/store/fishingCommands',
        ),
        describeFindings(findings),
      ).toBe(true);
      expect(
        findings.some(
          (finding) =>
            finding.file === 'src/store/fishingCommands.ts' &&
            finding.reason.includes('the module itself lives in src/store/'),
        ),
        describeFindings(findings),
      ).toBe(true);
    } finally {
      removeProbe();
    }

    // Removing the probe returns the tree to its prior state exactly.
    expect(existsSync(join(process.cwd(), PROBE_PATH))).toBe(false);
    expect(rendererEntries()).toEqual(baselineEntries);
    expect(
      findingsIn(
        walkClosure(rendererEntries()),
        PHASE17_RENDERER_FORBIDDEN,
        PHASE17_RENDERER_TREES,
      ),
    ).toEqual([]);
  });

  /*
   * The non-vacuity control for the exclusion, and the one that pins the cross-file flake shut.
   *
   * The positive control above proves the detector still sees a planted probe when asked to. This
   * proves the *default* is the other way round, which is the whole fix: a probe declared by a
   * live planting is not an entry, so a probe another worker planted mid-run is not reported as an
   * offender. The failure it closes was real and reproducible — "study shell is renderer-free in
   * both directions" naming Phase 14's `src/ui/study/__boundary_probe__/probe.ts`, about one run in
   * four — and it is exactly what this control would fail on if the filter were removed or its
   * predicate were inert.
   *
   * It plants into **this file's own** declared directory on purpose. Planting into Phase 14's
   * would be a more literal reproduction and would reintroduce exactly the race being fixed, since
   * that file's own `afterEach` removes the whole directory. The predicate is the same one for every
   * declared directory, so the control proves the mechanism rather than the one directory.
   */
  it('a live declared planting is not an entry, while the same walk still finds it on request', () => {
    const baseline = rendererEntries();
    try {
      plantProbe();
      expect(existsSync(join(process.cwd(), PROBE_PATH))).toBe(true);

      // The default: excluded, in every entry list that could have seen it.
      expect(rendererEntries()).toEqual(baseline);
      expect(treeEntries('src/renderers/')).toEqual(baseline);
      expect(treeEntries('src/ui/study/', 'src/core/', 'src/application/')).not.toContain(
        PROBE_PATH,
      );
      // ...and therefore it is not reachable through the closure either, which is where the
      // cross-suite finding was reported from.
      expect(
        findingsIn(walkClosure(rendererEntries()), PHASE17_RENDERER_FORBIDDEN, PHASE17_RENDERER_TREES),
      ).toEqual([]);

      // On request: present, and the walk follows it. So the exclusion above is a decision and not
      // an empty list.
      expect(rendererEntries({ includeLivePlantings: true })).toContain(PROBE_PATH);
    } finally {
      removeProbe();
    }
    expect(rendererEntries()).toEqual(baseline);
  });
});