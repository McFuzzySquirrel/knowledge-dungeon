/**
 * The study surfaces' renderer boundary.
 *
 * ## Why this file was authored in Phase 15 rather than Phase 14
 *
 * `src/ui/study/StudyShell.tsx` has claimed since Phase 14 that
 * "`tests/phase14/study-shell-boundary.test.ts` holds the boundary: no Phaser, no Pixi, no
 * `src/game`, no `src/renderers` anywhere under `src/ui/study/**`". That file did not exist.
 * Phase 14 shipped a header asserting a gate it never wrote, which is worse than no gate: a
 * reader - and Phase 15's author - took the boundary as enforced and had to verify it by hand.
 * Phase 15 added the whole `src/ui/study/scribe/**` subtree underneath the same unenforced
 * claim, so this file is written now, at the path the header already names, and it covers the
 * Scribe subtree along with Creator and the guide.
 *
 * ## What "holds the boundary" means here
 *
 * `src/ui/study/**` is a renderer-neutral DOM surface. It may read domain data and stores; it
 * may not reach a rendering engine, in any module reachable from it. "Reachable" is the
 * load-bearing word: a study module that imports something in `src/core/` that in turn
 * imports `src/renderers/**` has broken the boundary just as thoroughly as a direct import,
 * and a scan of the study files' own text would call it clean. So this file walks the import
 * graph.
 *
 * ## How the walk is done, and why it is not a regex over source
 *
 * The walk reuses `tests/privacy/support/appGraph.ts`, which resolves the `@/` alias,
 * relative specifiers, directory indexes, extensionless specifiers, JSON, and dynamic
 * `import()` / `require()`; which counts type-only imports as edges (a type import is still a
 * file in the module graph); and which strips comments before reading specifiers. That last
 * part is not a nicety - this file names `pixi.js`, `@/renderers`, and `phaser` in prose, and
 * `src/ui/study/StudyShell.tsx` names `src/renderers` in its own header, so a text scan would
 * report the documentation as a violation.
 *
 * Two independent assertions are made, because they catch different shapes of the same
 * defect: no *reached module* lives in a forbidden tree, and no *reached module* names a
 * forbidden engine package or tree. The first catches everything the walker followed; the
 * second catches an edge the resolver could not follow.
 *
 * ## Non-vacuity
 *
 * Three guards, or "no violations" would also be consistent with a walk that reached nothing:
 * the entry count has a floor, the closure must include modules *outside* the study tree (so
 * the boundary is tested against a real graph rather than a subtree of itself), and bare
 * specifiers must be classified at all. The positive control then plants a real probe file
 * *inside* `src/ui/study/`, proves the same walk reports it, and removes it.
 *
 * Privacy: findings carry a repo-relative path, a specifier, and a rule name only. No source
 * text, no destination, and no learner data.
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
  PHASE14_BOUNDARY_PROBE_DIRECTORY,
  readSpecifiers,
  stripComments,
  testOwnedDirectory,
  walkAppGraph,
  writePlantingMarker,
  type GraphModule,
} from '../privacy/support/appGraph';

/** The subtree this file holds the boundary for. */
const STUDY_PREFIX = 'src/ui/study/';

/**
 * First-party trees a renderer-neutral DOM surface may not reach.
 *
 * `src/renderers/**` is the Pixi host (Phase 9), `src/game/**` is the Phaser host and its
 * systems (the current renderer until Phase 24), and `src/electron/**` is the desktop main
 * process, which is not in the web bundle at all.
 *
 * Compared as a path prefix with a trailing slash, or a sibling whose name merely starts the
 * same way would be reported as a violation.
 */
const FORBIDDEN_TREES: readonly string[] = ['src/renderers/', 'src/game/', 'src/electron/'];

/**
 * Engine packages a renderer-neutral DOM surface may not name.
 *
 * Value and type-only imports are both forbidden, for the reason `eslint.config.js` already
 * gives: `import type { Container } from 'pixi.js'` is renderer coupling too. The
 * deep-subpath forms are matched because a root-only test would let `@pixi/graphics` and
 * `pixi.js/unsafe-eval` through.
 */
const FORBIDDEN_PACKAGES: ReadonlyArray<{
  readonly label: string;
  readonly matches: (specifier: string) => boolean;
}> = [
  { label: 'phaser', matches: (s) => s === 'phaser' || s.startsWith('phaser/') },
  { label: 'pixi.js', matches: (s) => s === 'pixi.js' || s.startsWith('pixi.js/') },
  {
    label: '@pixi/*',
    matches: (s) => s === '@pixi' || s.startsWith('@pixi/') || s.startsWith('@pixi.js'),
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

/**
 * Repo-relative paths of every module under the study subtree, sorted.
 *
 * **Live plantings are excluded unless the caller asks for them.** Three boundary gates plant
 * probes on the real filesystem inside `src/` as positive controls, Vitest runs the files in
 * parallel workers, and a probe one worker planted is otherwise a real entry in another worker's
 * scan — a cross-file flake, not a finding. The exclusion is `isTestOwnedTransientModule`, which
 * is the repository's own predicate and is keyed on the *declaration* a planting wrote, so a
 * module left behind in one of those directories after the planting ended is scanned like any
 * other source file again.
 *
 * The positive control passes `{ includeLivePlantings: true }` because its whole claim is that
 * the walk sees the probe; it is the one caller for which the probe must be an entry.
 */
function studyEntries(options: { includeLivePlantings?: boolean } = {}): string[] {
  return allFirstPartyModules().filter(
    (path) =>
      path.startsWith(STUDY_PREFIX) &&
      (options.includeLivePlantings === true || !isTestOwnedTransientModule(path)),
  );
}

/**
 * True when a specifier addresses a forbidden first-party tree.
 *
 * Two spellings have to be understood, because both occur in practice:
 *
 * - the alias form, `@/renderers/pixi/dungeon/DungeonWorld`, which is a repo path once the
 *   alias is expanded; and
 * - a climbing relative form, `../../renderers/pixi/runtime` from `scribe/`, whose meaning
 *   depends on how deep the file that wrote it is. That one is matched on its last segment
 *   after the `../` run is stripped, so a renderer tree is refused from any depth in the
 *   study subtree without the detector needing to know which file it is looking at.
 */
function forbiddenTreeFor(specifier: string): string | null {
  const normalized = specifier.replace(/\\/g, '/');
  const direct = normalized.startsWith('@/') ? `src/${normalized.slice(2)}` : normalized;
  for (const tree of FORBIDDEN_TREES) {
    const withoutSlash = tree.slice(0, -1);
    if (direct === withoutSlash || direct.startsWith(tree)) return tree;
  }
  if (normalized.startsWith('.')) {
    const climbed = normalized.replace(/^(?:\.\.\/|\.\/)+/, '');
    for (const tree of FORBIDDEN_TREES) {
      const name = withoutSlashTail(tree);
      if (climbed === name || climbed.startsWith(`${name}/`)) return tree;
    }
  }
  return null;
}

/** The last path segment of a forbidden tree, e.g. `renderers` for `src/renderers/`. */
function withoutSlashTail(tree: string): string {
  const segments = tree.slice(0, -1).split('/');
  return segments[segments.length - 1] ?? '';
}

/** Why one specifier is forbidden, or `null` when it is fine. */
function forbiddenReason(specifier: string): string | null {
  const tree = forbiddenTreeFor(specifier);
  if (tree !== null) return `reaches the forbidden tree ${tree}`;
  for (const forbidden of FORBIDDEN_PACKAGES) {
    if (forbidden.matches(specifier)) return `names the renderer package ${forbidden.label}`;
  }
  return null;
}

/** Every boundary violation in a walked closure, as sanitized findings. */
function findingsIn(modules: readonly GraphModule[]): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  for (const module of modules) {
    // (A) A reached module that lives in a forbidden tree. This is the transitive check: it
    // fires however the edge was formed, including through a `@/core` or store hop.
    const landedIn = FORBIDDEN_TREES.find((tree) => module.path.startsWith(tree));
    if (landedIn !== undefined) {
      findings.push({
        file: module.path,
        specifier: '<reached>',
        reason: `the module itself lives in ${landedIn}`,
      });
      continue;
    }
    // (B) A specifier that names a forbidden tree or package, whether or not the resolver
    // could follow it.
    for (const specifier of module.specifiers) {
      const reason = forbiddenReason(specifier);
      if (reason !== null) findings.push({ file: module.path, specifier, reason });
    }
  }
  return findings;
}

/** Render findings for an assertion message: path, specifier, rule. No source text. */
function describeFindings(findings: readonly BoundaryFinding[]): string {
  return findings
    .map((finding) => `${finding.file}: "${finding.specifier}" ${finding.reason}`)
    .sort()
    .join('\n');
}

/** Walk the closure of every study module and return the union of reached modules. */
function walkStudyClosure(options: { includeLivePlantings?: boolean } = {}): GraphModule[] {
  const reached = new Map<string, GraphModule>();
  for (const entry of studyEntries(options)) {
    for (const module of walkAppGraph({ entry }).modules) {
      if (!reached.has(module.path)) reached.set(module.path, module);
    }
  }
  return [...reached.values()].sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** Read one repo-relative source file, for the comment-stripping self-check. */
function readRepoFile(repoRelativePath: string): string {
  return readFileSync(join(process.cwd(), repoRelativePath), 'utf8');
}

/* ── The positive control's probe ───────────────────────────────────────────── */

/*
 * The probe lives *inside* `src/ui/study/`, not in `tests/` and not in `src/`, for two
 * reasons: a probe outside the tree would prove only that the walk follows imports in
 * general rather than that it follows one *out of* the study subtree, and a probe placed in
 * `tests/` would never become a study entry at all. It is declared through `appGraph`'s
 * planting marker while it exists and removed in `afterEach`, the same discipline the Phase 4
 * privacy gate uses for its detector probe, so a gate that scans `src/` while this runs can
 * tell this planted file from a real offender instead of reporting it as one. Its directory name
 * is {@link PHASE14_BOUNDARY_PROBE_DIRECTORY} rather than a literal here, because the shared
 * inventory is what makes the declaration readable; see `studyEntries` for why the gates now
 * skip a declared planting and why this file's own positive control does not.
 *
 * It is a *value* import, which is the stronger of the two cases; the detector test below
 * proves the type-only spelling without a second planting.
 */
const PROBE_DIRECTORY_NAME = PHASE14_BOUNDARY_PROBE_DIRECTORY;
const PROBE_DIRECTORY = testOwnedDirectory(PROBE_DIRECTORY_NAME);
const PROBE_PATH = `src/${PROBE_DIRECTORY_NAME}/probe.ts`;
const PROBE_SOURCE = `import { IDLE_DUNGEON_ARTIFACT_SNAPSHOT } from '@/renderers/pixi/dungeon/dungeonArtifact';

export const STUDY_BOUNDARY_PROBE_PICKUP_PERMITTED: boolean =
  IDLE_DUNGEON_ARTIFACT_SNAPSHOT.pickupPermitted;
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

describe('the study surfaces resolve, and the walk reaches real modules', () => {
  it('enumerates the study subtree and reaches past it', () => {
    const entries = studyEntries();

    // Non-vacuity floor. A filter that matched nothing would satisfy every boundary
    // assertion below.
    expect(entries.length).toBeGreaterThan(8);
    expect(entries).toContain('src/ui/study/StudyShell.tsx');
    // Phase 15's subtree, which is the reason this file was written late.
    expect(entries).toContain('src/ui/study/scribe/ScribeEncounter.tsx');
    expect(entries).toContain('src/ui/study/scribe/NoteComposer.tsx');
    expect(entries).toContain('src/ui/study/creator/CreatorWorkspace.tsx');
    // Phase 16's subtree. Named individually rather than by pattern, for the reason the
    // three above are: a subtree that grew a module which *did* reach a renderer has to fail
    // here, and a prefix assertion would keep passing as long as one other module in the
    // directory stayed clean.
    expect(entries).toContain('src/ui/study/review/ArchaeologistWorkspace.tsx');
    expect(entries).toContain('src/ui/study/review/RecallCard.tsx');
    expect(entries).toContain('src/ui/study/review/ReviewProgress.tsx');
    expect(entries).toContain('src/ui/study/review/reviewViewModel.ts');
    expect(entries).toContain('src/ui/study/review/useReviewActions.ts');

    const closure = walkStudyClosure();
    const paths = closure.map((module) => module.path);

    // The closure leaves the study tree: the study surfaces read domain data and stores. If
    // it did not, "no renderer was reached" would be a statement about a leaf set.
    expect(paths).toContain('src/core/validation/persistence/index.ts');
    expect(paths.length).toBeGreaterThan(entries.length);

    // And bare specifiers are being classified rather than ignored, or check (B) would be a
    // rule that can never fire.
    const externals = new Set(closure.flatMap((module) => module.externalSpecifiers));
    expect(externals.has('react')).toBe(true);
  });

  it('resolves every specifier the study modules name', () => {
    // A dangling specifier would mean the walk could not see an edge, so this is part of the
    // boundary rather than a separate tidiness concern. Stylesheets resolve because the
    // walker probes the literal path first, and `study.css` is a file.
    const unresolved: string[] = [];
    for (const entry of studyEntries()) {
      for (const specifier of walkAppGraph({ entry }).unresolved) {
        unresolved.push(`${specifier.from} -> ${specifier.specifier}`);
      }
    }

    expect(unresolved, unresolved.join('\n')).toEqual([]);
  });
});

describe('no module reachable from src/ui/study/** reaches a renderer', () => {
  it('reports no violation across the whole study closure', () => {
    const findings = findingsIn(walkStudyClosure());

    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('classifies every forbidden specifier form, including the deep-subpath ones', () => {
    // The detector on its own, with no filesystem: cheap, and it covers the forms a planted
    // file would not exercise. A root-only match would let `@pixi/graphics`,
    // `pixi.js/unsafe-eval`, and a climbing `../../renderers/...` through.
    for (const specifier of [
      'phaser',
      'phaser/src/scene',
      'pixi.js',
      'pixi.js/unsafe-eval',
      '@pixi/graphics',
      '@pixi.js/node',
      '@/renderers',
      '@/renderers/pixi/dungeon/DungeonWorld',
      '@/game/createGame',
      '@/game/systems/playerClasses',
      '@/electron/main',
      '../renderers/pixi/runtime',
      '../../renderers/pixi/runtime',
      '../game/systems/playerClasses',
    ]) {
      expect(forbiddenReason(specifier), specifier).not.toBeNull();
    }

    for (const specifier of [
      'react',
      'zustand',
      '@/ui/utils/markdown',
      '@/ui/study/StudyShell',
      '../StudyShell',
      './scribe.css',
      './review.css',
      '../controlIds',
      '@/core/graph',
      '@/core/review',
      '@/core/validation/notes',
      '@/store/sessionStore',
      '@/store/reviewCommands',
      '@/theme/tokens',
    ]) {
      expect(forbiddenReason(specifier), specifier).toBeNull();
    }
  });

  it('is not fooled by the forbidden words in the modules it is checking', () => {
    // `StudyShell.tsx` names `src/renderers` in its own header, and this file names
    // `pixi.js`, `@/renderers`, and `phaser` in prose. A scan that read raw text would report
    // the documentation as violations. Proved on the real file, so it cannot pass while the
    // real modules change.
    const raw = readRepoFile('src/ui/study/StudyShell.tsx');

    expect(raw, 'the header must still name the tree it claims this file guards').toContain(
      'src/renderers',
    );
    expect(stripComments(raw), 'the claim lives in a comment and must be stripped').not.toContain(
      'src/renderers',
    );

    // And what survives stripping - the module's actual imports - is clean.
    for (const specifier of readSpecifiers(stripComments(raw))) {
      expect(forbiddenReason(specifier), specifier).toBeNull();
    }
  });
});

describe('positive control: the same walk reports a planted renderer import', () => {
  it('goes red on a probe inside src/ui/study/, and the tree is clean once it is gone', () => {
    const baselineEntries = studyEntries();
    const baselineFindings = findingsIn(walkStudyClosure());
    expect(baselineFindings, describeFindings(baselineFindings)).toEqual([]);

    try {
      plantProbe();
      expect(existsSync(join(process.cwd(), PROBE_PATH))).toBe(true);

      // The probe is inside the study subtree, so it becomes an entry, and the walk follows
      // its edge out into the renderer tree. `includeLivePlantings` is the whole reason this
      // positive control still works: the gate's own scans skip a declared planting, so the one
      // walk that must *not* skip it asks for it by name.
      const withProbe = studyEntries({ includeLivePlantings: true });
      expect(withProbe, 'the probe must become a study entry or nothing is proved').toContain(
        PROBE_PATH,
      );

      const findings = findingsIn(walkStudyClosure({ includeLivePlantings: true }));
      // Reported by check (A), against the module the walk actually reached - not merely
      // because the probe's own text said something.
      expect(
        findings.some(
          (finding) =>
            finding.file === 'src/renderers/pixi/dungeon/dungeonArtifact.ts' &&
            finding.reason.includes('src/renderers/'),
        ),
        describeFindings(findings),
      ).toBe(true);
      // ...and attributable to the probe, by check (B) on the specifier it used.
      expect(
        findings.some(
          (finding) =>
            finding.specifier.includes('@/renderers') && finding.file === PROBE_PATH,
        ),
        describeFindings(findings),
      ).toBe(true);
    } finally {
      removeProbe();
    }

    // Removing the probe returns the tree to its prior state exactly.
    expect(existsSync(join(process.cwd(), PROBE_PATH))).toBe(false);
    expect(studyEntries()).toEqual(baselineEntries);
    expect(findingsIn(walkStudyClosure())).toEqual([]);
  });
});