/**
 * The renderer boundary, restated for Phase 16's review state machine.
 *
 * ## Why this file exists
 *
 * Phase 16 moved durable review state into the *progression* record - the
 * `reviewPassRewardLedger` and `interruptedReviewSession` live in its preserved
 * `extraFields` carrier - and added a command layer at `src/application/reviewCommands.ts` plus a
 * store binding at `src/store/reviewCommands.ts`. The renderer is downstream of all of it, and
 * the plan's deliverable for this phase is renderer *parity*, which is exactly the kind of
 * claim that is cheapest to satisfy by letting a renderer read the thing it is supposed to be
 * told.
 *
 * `src/renderers/**` must therefore answer every question about a room through the neutral
 * capability port, and must never:
 *
 * - import `@/store/**` (the progression ledger, the review command binding, the session
 *   store's phase);
 * - import `@/core/progression/**` (the badge and rank vocabulary a review pass feeds); or
 * - import the review command layer, by either of its two spellings.
 *
 * Nothing in the shipped renderer does. That is the good news and also the risk: a clean tree
 * is a fact that decays silently, because the next person to add a *convenient* read finds no
 * gate. This file is that gate.
 *
 * ## The established pattern, extended rather than replaced
 *
 * `tests/phase14/study-shell-boundary.test.ts` already walks the first-party import graph with
 * `tests/privacy/support/appGraph.ts` for `src/ui/study/**` - it resolves the `@/` alias,
 * relative and extensionless specifiers, and dynamic `import()`, counts type-only imports as
 * edges, and strips comments before reading a specifier. This file reuses that walker and that
 * rule shape rather than inventing a second detector, and mirrors its non-vacuity discipline:
 * an entry-count floor, a closure that must reach outside the subtree, and a positive control
 * that plants a real probe inside the tree being guarded and removes it afterwards.
 *
 * The two directions are the ones that matter for a renderer:
 *
 * | Direction | Rule | Phase 16's specific risk |
 * | --- | --- | --- |
 * | `src/renderers/**` outward | may not reach a store, `src/core/progression`, or the review command layer | reading `reviewPassCount` or the ledger directly instead of being handed a room id |
 * | domain inward | `src/core/**` and `src/application/**` may not reach a renderer | a review command module importing `DungeonWorld` to ask "is this room drawn" |
 *
 * The second direction is re-derived here rather than trusted to the Phase 13 gate, because
 * Phase 16 added four new modules under `src/application/` and `src/core/review/` and the gate
 * that covers them should say so.
 *
 * ## What is deliberately NOT forbidden
 *
 * `src/core/review/**` is reachable and `src/core/biomes` is reachable. A renderer reading a
 * *pure* domain fact - a biome palette, a due-date comparator - is not a boundary break; the
 * break is a renderer deciding *policy* from mutable application state. The rule is therefore
 * about state-holding and decision-holding modules, not about `src/core` as a whole, and a
 * blanket "no `src/core`" rule would have been both wrong and easy to route around.
 *
 * Privacy: findings carry a repo-relative path, a specifier, and a rule name. No source text,
 * no destination content, no learner data.
 *
 * Hermeticity: this file imports no renderer, makes no request, and uses no clock.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  allFirstPartyModules,
  clearPlantingDeclarations,
  isTestOwnedTransientModule,
  PHASE16_BOUNDARY_PROBE_DIRECTORY,
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
 * First-party trees `src/renderers/**` may not reach.
 *
 * `src/store/**` is the load-bearing one: it is where the Phase 16 review ledger is written
 * (`src/store/reviewCommands.ts`, `src/store/progressionStore.ts`), where the session phase
 * lives, and where a renderer's `pickupPermitted` and `reviewedArtifactRoomIds` answers are
 * *supposed* to come from - as data the host pushes, never as a store the renderer reads.
 * `src/ui/**` is here for the same reason in the other direction: a renderer importing a React
 * surface would make the engine depend on a screen.
 */
const FORBIDDEN_RENDERER_TREES: readonly string[] = [
  'src/store/',
  'src/ui/',
  'src/electron/',
];

/**
 * Engine-specific packages and the two review-state sources, for both directions.
 *
 * The renderer may name `pixi.js` - it is the engine - so the engine rule appears only in the
 * domain-inward table. `@/core/progression` and the review command layer are forbidden in both
 * directions: a domain module reaching the renderer is a layering break, and a renderer
 * reaching them is the Phase 16 break this file is named for.
 */
interface ForbiddenSpecifier {
  readonly label: string;
  readonly matches: (specifier: string) => boolean;
}

const RENDERER_FORBIDDEN: readonly ForbiddenSpecifier[] = [
  ...FORBIDDEN_RENDERER_TREES.map((tree) => ({
    label: `the tree ${tree}`,
    matches: (specifier: string) => forbiddenTreeFor(specifier) === tree,
  })),
  {
    label: 'the progression core module',
    matches: (specifier) =>
      specifier === '@/core/progression' || specifier.startsWith('@/core/progression/'),
  },
  {
    label: 'the review command layer',
    matches: (specifier) =>
      specifier === '@/application/reviewCommands' ||
      specifier.startsWith('@/application/reviewCommands/') ||
      specifier === '@/store/reviewCommands' ||
      specifier.startsWith('@/store/reviewCommands/'),
  },
];

const DOMAIN_FORBIDDEN: readonly ForbiddenSpecifier[] = [
  {
    label: 'the PixiJS host',
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
];

interface BoundaryFinding {
  /** The module whose import broke the boundary. */
  readonly file: string;
  /** The specifier it used, or `<reached>` for a transitive arrival. */
  readonly specifier: string;
  /** Why it was refused, in words. */
  readonly reason: string;
}

function withoutSlashTail(tree: string): string {
  const segments = tree.slice(0, -1).split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * True when a specifier addresses one of the forbidden first-party trees.
 *
 * Both spellings have to be understood, for the reason `tests/phase14/study-shell-boundary.test.ts`
 * gives: the alias form `@/store/reviewCommands`, and the climbing relative form
 * `../../store/reviewCommands`, whose meaning depends on the depth of the file that wrote it.
 * The relative form is matched on the path after the `../` run is stripped, so a tree is refused
 * from any depth without the detector needing to know which file it is reading.
 */
function forbiddenTreeFor(specifier: string): string | null {
  const normalized = specifier.replace(/\\/g, '/');
  const direct = normalized.startsWith('@/') ? `src/${normalized.slice(2)}` : normalized;
  for (const tree of FORBIDDEN_RENDERER_TREES) {
    if (direct === tree.slice(0, -1) || direct.startsWith(tree)) return tree;
  }
  if (normalized.startsWith('.')) {
    const climbed = normalized.replace(/^(?:\.\.\/|\.\/)+/, '');
    for (const tree of FORBIDDEN_RENDERER_TREES) {
      const name = withoutSlashTail(tree);
      if (climbed === name || climbed.startsWith(`${name}/`)) return tree;
    }
  }
  return null;
}

/** Every violation in a walked closure, as sanitized findings. */
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

/**
 * Repo-relative paths of every module under `src/renderers/`, sorted.
 *
 * **Live plantings are excluded unless the caller asks for them.** Three boundary gates plant
 * probes on the real filesystem inside `src/` as positive controls, Vitest runs the files in
 * parallel workers, and a probe one worker planted is otherwise a real entry in another worker's
 * scan — a cross-file flake, not a finding. Phase 17's probe is a value import of
 * `@/store/fishingCommands` from `src/renderers/`, so this gate reading it mid-planting reports a
 * renderer-to-store violation that does not exist. The exclusion is
 * `isTestOwnedTransientModule`, the repository's own predicate, keyed on the *declaration* the
 * planting wrote — so a module left behind in one of those directories after the planting ended
 * is scanned like any other source file again.
 */
function rendererEntries(options: { includeLivePlantings?: boolean } = {}): string[] {
  return allFirstPartyModules().filter(
    (path) =>
      path.startsWith(RENDERER_PREFIX) &&
      (options.includeLivePlantings === true || !isTestOwnedTransientModule(path)),
  );
}

/** Repo-relative paths of every domain module, sorted. */
function domainEntries(): string[] {
  return allFirstPartyModules().filter(
    (path) =>
      (path.startsWith('src/core/') || path.startsWith('src/application/')) &&
      !isTestOwnedTransientModule(path),
  );
}

/** Walk the closure of every entry under `prefix` and return the union, sorted. */
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

/*
 * A *type-only* import, deliberately: a value import is the easier case and the one the
 * Phase 14 probe already plants. The claim this file needs is the stronger one - that
 * `import type { RoomMetadata } from '@/store/...'` is refused too - because a renderer that
 * reached a store for a *type* would be one refactor away from reading a value, and
 * `eslint.config.js`'s reasoning for `pixi.js` (that a type import is renderer coupling too)
 * applies unchanged.
 */
const PROBE_DIRECTORY_NAME = PHASE16_BOUNDARY_PROBE_DIRECTORY;
const PROBE_DIRECTORY = testOwnedDirectory(PROBE_DIRECTORY_NAME);
const PROBE_PATH = `src/${PROBE_DIRECTORY_NAME}/probe.ts`;
const PROBE_SOURCE = `import type { ReviewPassRewardLedger } from '@/store/reviewCommands';

export const PHASE16_RENDERER_BOUNDARY_PROBE_ENTRIES: number =
  ({} as { entries: ReviewPassRewardLedger['entries'] }).entries.length;
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

describe('the renderer tree is enumerated, and the walk reaches real modules', () => {
  it('finds the Phase 13 dungeon modules and leaves the subtree', () => {
    const entries = rendererEntries();

    // Non-vacuity floor. A filter that matched nothing would satisfy every boundary
    // assertion below.
    expect(entries.length).toBeGreaterThan(20);
    // Named individually, not by pattern: a module added to this tree that *did* reach a store
    // has to fail here, and a prefix assertion keeps passing as long as one other file in the
    // directory stays clean.
    expect(entries).toContain('src/renderers/pixi/dungeon/DungeonWorld.tsx');
    expect(entries).toContain('src/renderers/pixi/dungeon/DungeonRenderer.ts');
    expect(entries).toContain('src/renderers/pixi/dungeon/createDungeonScene.ts');
    expect(entries).toContain('src/renderers/pixi/dungeon/dungeonArtifact.ts');
    expect(entries).toContain('src/renderers/pixi/dungeon/RoomNode.ts');

    const closure = walkClosure(entries).map((module) => module.path);
    // The closure leaves the renderer tree: the dungeon renderer reads the neutral world
    // contract and a couple of pure domain modules. If it did not, "no store was reached"
    // would be a statement about a leaf set.
    expect(closure).toContain('src/application/contracts/renderer.ts');
    expect(closure).toContain('src/core/biomes/index.ts');
    expect(closure.length).toBeGreaterThan(entries.length);
  });

  it('resolves every specifier the renderer modules name', () => {
    // A dangling specifier would mean the walk could not see an edge, so this is part of the
    // boundary rather than a separate tidiness concern.
    const unresolved: string[] = [];
    for (const entry of rendererEntries()) {
      for (const specifier of walkAppGraph({ entry }).unresolved) {
        unresolved.push(`${specifier.from} -> ${specifier.specifier}`);
      }
    }

    expect(unresolved, unresolved.join('\n')).toEqual([]);
  });
});

describe('no module reachable from src/renderers/** reaches review state or a store', () => {
  it('reports no violation across the whole renderer closure', () => {
    const findings = findingsIn(
      walkClosure(rendererEntries()),
      RENDERER_FORBIDDEN,
      FORBIDDEN_RENDERER_TREES,
    );

    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('classifies both spellings of every forbidden source, and no innocent one', () => {
    // The detector on its own, with no filesystem: cheap, and it covers the forms a planted
    // file would not exercise.
    for (const specifier of [
      '@/store/progressionStore',
      '@/store/reviewCommands',
      '@/store/sessionStore',
      '@/store/progressionStore/awardReviewPass',
      '../store/progressionStore',
      '../../store/reviewCommands',
      '@/core/progression',
      '@/core/progression/badges',
      '@/application/reviewCommands',
      '@/application/reviewCommands/createReviewController',
      '@/ui/screens/GameScreen',
      '../ui/study/StudyShell',
      '@/electron/main',
    ]) {
      expect(
        RENDERER_FORBIDDEN.some((rule) => rule.matches(specifier)),
        `${specifier} must be refused`,
      ).toBe(true);
    }

    // And the innocent ones, including the pure domain modules the renderer legitimately
    // reads. `reviewPasses` is in this list deliberately: it is a *pure* derivation, and a
    // renderer that imported it to answer "is this room reviewed" would be making a policy
    // decision - so it is allowed to be *reachable* while the ledger it depends on is not,
    // and the distinction this file enforces is the ledger, not the derivation.
    for (const specifier of [
      'react',
      'pixi.js',
      'zustand',
      '@/application/contracts/renderer',
      '@/application/contracts/world',
      '@/application/contracts/villageNpc',
      '@/application/studyFlow',
      '@/core/biomes',
      '@/core/layout/dungeonTypes',
      '@/core/review/reviewPasses',
      '@/core/review/spacedRepetition',
      '@/data/villageLayout',
      '@/theme/tokens',
      '@/renderers/pixi/camera/CameraRig',
      './dungeonArtifact',
      './createDungeonScene',
    ]) {
      expect(
        RENDERER_FORBIDDEN.some((rule) => rule.matches(specifier)),
        `${specifier} must stay reachable`,
      ).toBe(false);
    }
  });

  it('is not fooled by the forbidden words in the modules it is checking', () => {
    // This file and `src/renderers/pixi/dungeon/dungeonArtifact.ts` both *name* the forbidden
    // sources in prose - that module's header explains why a renderer may not import the
    // session store. A scan that read raw text would report the documentation as a violation.
    const raw = readRepoFile('src/renderers/pixi/dungeon/dungeonArtifact.ts');

    expect(raw, 'the module must still explain the rule it is held to').toContain(
      'session store',
    );
    expect(stripComments(raw), 'the claim lives in a comment and must be stripped').not.toContain(
      'session store',
    );

    // And what survives stripping - the module's actual imports - is clean.
    for (const specifier of readSpecifiers(stripComments(raw))) {
      expect(
        RENDERER_FORBIDDEN.some((rule) => rule.matches(specifier)),
        specifier,
      ).toBe(false);
    }
  });
});

describe('no domain module reaches a renderer, including Phase 16 review modules', () => {
  it('reports no violation across src/core/** and src/application/**', () => {
    const entries = domainEntries();
    // Phase 16's own application modules, named rather than counted, because they are the
    // reason this direction is re-derived instead of trusted to the Phase 13 gate.
    expect(entries).toContain('src/application/reviewCommands.ts');
    expect(entries).toContain('src/application/studyFlow.ts');
    expect(entries).toContain('src/core/review/reviewPassRewards.ts');
    expect(entries).toContain('src/core/review/interruptedReviewSession.ts');
    expect(entries.length).toBeGreaterThan(40);

    // **No store rule in this direction**, and the omission is deliberate: `src/core/**`
    // legitimately reads `@/store/preferencesStore` and `@/store/progressionStore`
    // (`src/core/progression/lootSystem.ts` does, today), and the Phase 13 gate does not forbid
    // it either. Re-deriving a *different* rule here would have turned a green tree red for a
    // pre-existing arrangement nobody asked about. What this direction owns is the engine
    // boundary: a domain module may not reach a renderer.
    const findings = findingsIn(walkClosure(entries), DOMAIN_FORBIDDEN, []);

    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('the review command layer is renderer-free and engine-free by source, as it claims', () => {
    // `src/application/reviewCommands.ts`'s header states "No renderer imports. No learner data
    // in any id, key, message, or log." The renderer half is asserted here; the learner-data
    // half belongs to `tests/phase16/reviewCommands.test.ts`.
    const source = stripComments(readRepoFile('src/application/reviewCommands.ts'));
    for (const specifier of readSpecifiers(source)) {
      expect(
        DOMAIN_FORBIDDEN.some((rule) => rule.matches(specifier)),
        `${specifier} must not appear in a domain module`,
      ).toBe(false);
    }
    // The store binding is the *other* half and does reach a store, which is why it lives in
    // `src/store/` and is named as one module rather than as a rule about the domain. This is
    // also the module the planted probe above impersonates, so the pair reads as one argument:
    // the binding exists, it is where review state crosses into the application, and a renderer
    // must not reach it.
    expect(readRepoFile('src/store/reviewCommands.ts')).toContain('useProgressionStore');
  });
});

describe('positive control: the same walk reports a planted renderer-to-store import', () => {
  it('goes red on a probe inside src/renderers/, and the tree is clean once it is gone', () => {
    const baselineEntries = rendererEntries();
    const baselineFindings = findingsIn(
      walkClosure(rendererEntries()),
      RENDERER_FORBIDDEN,
      FORBIDDEN_RENDERER_TREES,
    );
    expect(baselineFindings, describeFindings(baselineFindings)).toEqual([]);

    try {
      plantProbe();
      expect(existsSync(join(process.cwd(), PROBE_PATH))).toBe(true);

      // The probe is inside the renderer subtree, so it becomes an entry, and the walk follows
      // its edge out into the store. `includeLivePlantings` is what makes this control work at
      // all: the gate's own scans skip a declared planting, so the one walk that must *not* skip
      // it asks for it by name.
      expect(
        rendererEntries({ includeLivePlantings: true }),
        'the probe must become an entry or nothing is proved',
      ).toContain(PROBE_PATH);

      const findings = findingsIn(
        walkClosure(rendererEntries({ includeLivePlantings: true })),
        RENDERER_FORBIDDEN,
        FORBIDDEN_RENDERER_TREES,
      );
      // Attributable to the probe, by the specifier it used - and *also* to the store module the
      // walk reached, so both halves of the check are exercised.
      expect(
        findings.some(
          (finding) =>
            finding.file === PROBE_PATH && finding.specifier === '@/store/reviewCommands',
        ),
        describeFindings(findings),
      ).toBe(true);
      expect(
        findings.some(
          (finding) =>
            finding.file === 'src/store/reviewCommands.ts' &&
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
        RENDERER_FORBIDDEN,
        FORBIDDEN_RENDERER_TREES,
      ),
    ).toEqual([]);
  });
});