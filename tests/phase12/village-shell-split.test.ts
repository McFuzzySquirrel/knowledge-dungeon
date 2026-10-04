/**
 * The split is structural, and a structural claim needs a structural gate.
 *
 * ## What this file is for
 *
 * Phase 12's scope says to "Split `VillageScreen` into focused HUD, structure
 * panel, NPC dialogue, quest board, subject creation, stats, data, and settings
 * launchers" and its deliverable list ends with "Focused Village component
 * structure". Those are statements about a *file layout*, and no component test
 * can fail when a panel is added to the wrong file. So this file reads the tree.
 *
 * It also pins the three claims that are only checkable at the source level and
 * that the exit criteria phrase as absolutes:
 *
 * 1. **"No Pixi object is required to understand or invoke a village action."**
 *    Stated as: no file under `src/ui/village/**` imports the engine, a renderer
 *    module, or the Phaser adapter - statically or dynamically. So there is no
 *    version of this feature that could *need* a renderer object.
 * 2. **"Village screens no longer directly import Phaser types."** Carried
 *    forward from Phase 11 and re-asserted over the split, because the split
 *    created nine new UI files and a new file is exactly how that criterion rots.
 * 3. **The build-time switch is still a literal.** The bundler folds
 *    `VITE_PIXI_VILLAGE === 'true'` away and deletes the renderer chunk with it.
 *    Rewriting that comparison as `String(raw).trim()` reads the same at run time
 *    and puts a Pixi chunk back in the default build, so the property is pinned
 *    against the *text* of the file rather than trusted to review.
 *
 * ## Why the walk is re-derived rather than listed
 *
 * Every list here is compared as a *set* against files found on disk, and each one
 * has a floor assertion, so a scanner that silently stopped walking cannot turn
 * into a green run. That is the same rule `tests/phase9/pixi-host-boundary.test.ts`
 * follows for the same reason.
 *
 * Hermeticity: reads only files inside the repository. No `dist/`, no network, no
 * commit, no renderer import. The only identifiers it inspects are import
 * specifiers, file names, and class names - no learner data.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../phase9/support/phase9Build';
import { COZY_TOUCH_TARGET_MIN } from '../../src/theme';

const VILLAGE_UI = path.join(REPO_ROOT, 'src', 'ui', 'village');
const SCREEN = 'src/ui/screens/VillageScreen.tsx';

/** The five modules the plan's "Expected files" names, plus what the split added. */
const REQUIRED_MODULES: readonly string[] = [
  'VillageHud.tsx',
  'StructurePanel.tsx',
  'NpcDialog.tsx',
  'QuestBoard.tsx',
  'CompassOverlay.tsx',
  'NearbyActionList.tsx',
  'VillagePanel.tsx',
  'VillageLaunchers.tsx',
  'CreateSubjectDialog.tsx',
  'DataManagementDialog.tsx',
  'useVillageNpcSurface.ts',
  'useVillageSurfaceMode.ts',
  'villageTypes.ts',
  // Phase 17's addition, and the list's standing purpose rather than a favour to it: the
  // entry is what makes the "walk finds the modules" check below non-vacuous for a module
  // added after this file was written, and the two gates that read the tree - the renderer
  // boundary and the 44px floor - then cover it without being asked to.
  'villagePlayerPosition.ts',
];

function sourceFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesIn(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

/** Comments stripped, so this file may explain a rule it also enforces. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function dynamicImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
}

const villageFiles = sourceFilesIn(VILLAGE_UI).map((file) => ({
  relative: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
  source: readFileSync(file, 'utf8'),
}));

describe('the walk finds the modules this file is about', () => {
  it('found the split, and found it non-vacuously', () => {
    expect(villageFiles.length).toBeGreaterThanOrEqual(REQUIRED_MODULES.length);
    const relatives = villageFiles.map((entry) => entry.relative);
    for (const expected of REQUIRED_MODULES) {
      expect(relatives, `${expected} is missing from src/ui/village`).toContain(
        `src/ui/village/${expected}`,
      );
    }
  });

  it('the specifier scan finds both static and dynamic imports, so the rules have teeth', () => {
    const control = "import { Application } from 'pixi.js';\nconst f = () => import('@/renderers/pixi/x');";
    expect(importSpecifiers(control)).toContain('pixi.js');
    expect(dynamicImportSpecifiers(control)).toEqual(['@/renderers/pixi/x']);
    // A comment naming a package must not count, or this file could not explain
    // the rule it enforces.
    expect(importSpecifiers(codeOf('// import "pixi.js";\nconst a = 1;'))).toEqual([]);
  });
});

function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the screen is a composition root, not a container', () => {
  const screen = readFileSync(path.join(REPO_ROOT, SCREEN), 'utf8');
  const screenCode = codeOf(screen);

  it('is short enough that the panels are visibly elsewhere', () => {
    // Not a magic number for its own sake: the pre-split file was 1798 lines, and
    // the point of the phase is that the composition root is the *small* thing.
    const lines = screen.split('\n').length;
    expect(lines, 'the screen has grown back past its pre-split size').toBeLessThan(900);
  });

  it('delegates each of the seven named concerns to a module', () => {
    for (const module of [
      'VillageHud',
      'StructurePanel',
      'NpcDialog',
      'QuestBoard',
      'CompassOverlay',
      'CreateSubjectDialog',
      'DataManagementDialog',
      'VillageLaunchers',
    ]) {
      expect(screen, `${module} is not used by the composition root`).toContain(module);
    }
  });

  it('no longer defines a panel body of its own', () => {
    // The three file-local components this phase was asked to extract. If one is
    // still declared here, the split is claimed and not done.
    for (const local of ['function CompassOverlay', 'function VillageHudContent', 'function SignpostPanel']) {
      expect(screenCode, `${local} is still declared in the screen`).not.toContain(local);
    }
  });

  it('still owns the build-time switch, and it is still a literal comparison', () => {
    // The bundler folds this arm away and deletes the dynamic import with it, and
    // therefore the whole renderer chunk. A normalisation step before the
    // comparison reads the same at run time and defeats the folding.
    expect(screen).toContain("import.meta.env.VITE_PIXI_VILLAGE === 'true'");
    const branch = screen.slice(screen.indexOf("import.meta.env.VITE_PIXI_VILLAGE === 'true'"));
    expect(branch.split('\n').slice(1, 6).join('\n')).not.toMatch(/\.(trim|toLowerCase|toUpperCase)\s*\(/);
    // And the run-time decision still reads the parsed flag, so a
    // spelled-differently value produces a stated message rather than a silent
    // Phaser fallback.
    expect(screen).toContain('runtimeConfig.pixiVillage');
  });

  it('reaches Phaser only through a dynamic import, so the default build keeps no Phaser chunk', () => {
    const body = codeOf(screen);
    expect(importSpecifiers(body)).not.toContain('phaser');
    expect(importSpecifiers(body).some((specifier) => specifier.startsWith('@/game/create'))).toBe(
      false,
    );
    expect(dynamicImportSpecifiers(body)).toContain('@/game/createVillageGame');
    // The one type-only reach into the Pixi tree stays, and stays type-only: it is
    // erased at build time and the criterion here is about Phaser.
    expect(screen).toContain(
      "import type { VillageWorldHandle } from '@/renderers/pixi/village/VillageWorld';",
    );
  });
});

describe('no village panel needs a renderer object to exist', () => {
  it('no module under src/ui/village imports an engine, a renderer, or the Phaser adapter', () => {
    // The exit criterion, stated as a graph property. A panel that imported the
    // engine would make "no Pixi object is required" true only in the version of
    // the product where that panel was not rendered.
    const forbidden: readonly RegExp[] = [
      /^pixi\.js(?:\/|$)/,
      /^@pixi\//,
      /^phaser(?:\/|$)/,
      /^@\/renderers(?:\/|$)/,
      /^@\/game\/scenes(?:\/|$)/,
      /^@\/game\/adapters(?:\/|$)/,
      /^@\/game\/create/,
    ];
    const offenders: string[] = [];
    for (const entry of villageFiles) {
      const specifiers = [
        ...importSpecifiers(codeOf(entry.source)),
        ...dynamicImportSpecifiers(codeOf(entry.source)),
      ];
      for (const specifier of specifiers) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${entry.relative} -> ${specifier}`);
        }
      }
    }
    expect(
      offenders,
      'plan 12: "No Pixi object is required to understand or invoke a village action"',
    ).toEqual([]);
  });

  it('reads the renderer only through the two optional capability members, by name', () => {
    // The one legitimate reach: the members the contract declares optional while the
    // adapters are being wired. `readPoi` is here because the compass still samples it
    // (outside React - see the compass test), not because a panel holds a handle.
    // `readVillagePlayerGridPosition` is Phase 17's `data-village-player` read: it reaches
    // the neutral port through `villagePlayerPosition.ts`'s feature detection rather than
    // through a member the contract declares today, and naming it here is what stops a
    // later edit from reaching past that module into an adapter object directly.
    const screen = codeOf(readFileSync(path.join(REPO_ROOT, SCREEN), 'utf8'));
    for (const member of [
      'readNpcSnapshot',
      'invokeAction',
      'readPoi',
      'readVillagePlayerGridPosition',
    ]) {
      expect(screen, `${member} is not feature-detected in the screen`).toContain(member);
    }
    // And it never fabricates a stand-in: a no-op dispatcher would be the silent
    // no-op the exit criterion forbids.
    expect(screen).not.toMatch(/invokeAction:\s*\(\)\s*=>\s*\{?\s*\}?/);
  });

  it('the compass module has no React state and no frame loop', () => {
    // Duplicated here from the behavioural compass test on purpose: that one proves
    // the *effect*, and this one names the file so a reader of the split can see
    // the property without opening the other test.
    const compass = villageFiles.find((entry) => entry.relative.endsWith('CompassOverlay.tsx'));
    expect(compass).toBeDefined();
    const body = codeOf(compass?.source ?? '');
    expect(body).not.toMatch(/\buse(State|Reducer|SyncExternalStore)\b/);
    expect(body).not.toMatch(/requestAnimationFrame/);
  });
});

describe('the split left no panel without an accessible route', () => {
  it('every module that renders a control outside the shared frame floors it to 44 pixels', () => {
    // Three spellings of one number, and this is the check that keeps them
    // together: the inline style jsdom can read, the shared constant, and the
    // stylesheet rule that covers the panel bodies' reused legacy classes. A
    // module that adds its *own* control must use one of the first two; the third
    // covers a module whose controls live inside `VillagePanel`, which is asserted
    // separately.
    const sharedFrame = new Set([
      'VillagePanel.tsx',
      'villageTypes.ts',
      'useVillageNpcSurface.ts',
      'useVillageSurfaceMode.ts',
      'villageStudyFlow.ts',
      'villageSceneCallbacks.ts',
    ]);
    for (const entry of villageFiles) {
      const name = entry.relative.split('/').pop() as string;
      if (sharedFrame.has(name)) continue;
      const body = codeOf(entry.source);
      if (!/<button/.test(body)) continue;
      expect(
        body,
        `${name} renders a button with no 44px floor and is not the shared frame`,
      ).toMatch(/minHeight: '44px'|VILLAGE_TOUCH_TARGET_STYLE/);
    }
  });

  it('the shared constant and the stylesheet agree on 44, and the token says why', () => {
    const types = readFileSync(path.join(VILLAGE_UI, 'villageTypes.ts'), 'utf8');
    expect(types).toMatch(/minWidth: '44px'/);
    expect(types).toMatch(/minHeight: '44px'/);
    const sheet = readFileSync(path.join(VILLAGE_UI, 'villagePanels.css'), 'utf8');
    expect(sheet).toMatch(/--village-target-min, 44px/);
    // The token is the reason the number is 44; if the plan ever changed it, this
    // is the line a reviewer would want to see fail.
    expect(COZY_TOUCH_TARGET_MIN).toBe(44);
  });

  it('the shared frame floors every control in its own subtree', () => {
    const sheet = readFileSync(path.join(VILLAGE_UI, 'villagePanels.css'), 'utf8');
    expect(sheet).toMatch(/\.village-panel button/);
    expect(sheet).toMatch(/\.village-nearby button/);
  });

  it('the panels stylesheet is reachable from a named module, not a computed path', () => {
    // The CC0 gate only accepts a stylesheet a module names, so an unreferenced
    // sheet would be a shipped-but-unregistered file rather than dead code.
    const importers = villageFiles.filter((entry) =>
      importSpecifiers(entry.source).includes('./villagePanels.css'),
    );
    expect(importers.length, 'villagePanels.css is imported by nobody').toBeGreaterThan(0);
  });

  it('the new stylesheet declares the non-colour state rules unscoped, in both flag states', () => {
    // `VITE_COZY_VISUALS` is false in the production default, so a state signal
    // behind `[data-cozy-visuals='true']` is a signal the shipped artifact does not
    // have. The rule that matters is the quest row's, and it must be unscoped.
    const sheet = readFileSync(path.join(VILLAGE_UI, 'villagePanels.css'), 'utf8');
    expect(sheet).toContain("[aria-current='step']");
    expect(sheet).toContain("[data-quest-state='done']");
    const scopedRule = sheet.slice(sheet.indexOf("[aria-current='step']") - 200);
    expect(scopedRule, 'the quest state signal is behind the Cozy flag').not.toContain(
      "data-cozy-visuals='true'] .ui-skin .village-quest-row",
    );
  });

  it('removes the sheet transition under reduced motion', () => {
    const sheet = readFileSync(path.join(VILLAGE_UI, 'villagePanels.css'), 'utf8');
    const block = sheet.slice(sheet.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/animation: none/);
  });

  it('supports a forced-colours mode on the new panels', () => {
    const sheet = readFileSync(path.join(VILLAGE_UI, 'villagePanels.css'), 'utf8');
    expect(sheet).toContain('@media (forced-colors: active)');
  });
});
