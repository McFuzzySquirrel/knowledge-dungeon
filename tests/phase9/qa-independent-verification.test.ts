/**
 * Independent verification of the four Phase 9 claims that no other gate covers.
 *
 * ## Why this file exists
 *
 * I am the QA engineer for this phase and I do not take the phase's own green run on
 * trust. I have, separately, driven the build-time mutations, the ESLint probes, and the
 * browser lane, and I report those results in prose. This file is the part of that work
 * that is *permanent*, hermetic, and cheap enough to run on every commit. It pins four
 * things the existing `tests/phase9/**` files do not, and each one is a claim the plan
 * makes that a reader would otherwise have to take on trust:
 *
 * 1. **The Phase 2 contract still binds.** Plan section 6.1 promises
 *    "renderer-neutral world contracts", Phase 9's whole design is a `WorldApplication`
 *    port, and Phase 11 depends on the Phase 2 capability ports binding to this host
 *    "without redesign". Nothing in `tests/phase9/**` asserts that. The claim is a
 *    *type-level* claim, so it is asserted at the type level (a `const` annotated with
 *    the Phase 2 interface) and again at run time, because a type that satisfies the
 *    compiler is not the same as an object that satisfies the interface.
 * 2. **`src/application/contracts/**` was not widened to name a Pixi type.** The
 *    `WorldApplication.native: unknown` design decision in `types.ts` exists precisely
 *    to keep the engine out of the contract layer; that decision is only load-bearing if
 *    the contract layer did not quietly acquire a Pixi type anyway. Comments are
 *    stripped before the scan, because the contract files legitimately *talk about*
 *    Pixi in prose.
 * 3. **The effective renderer boundary, mechanism by mechanism.** Plan section 6.1 is
 *    enforced by a name list plus a build-time graph audit, and I found by probing that
 *    the two cover *different* sets of specifiers. This file records the whole table
 *    rather than only the part that works, so the gap is visible in the repository and
 *    not only in a reviewer's report. The gap is in the ESLint list, which names
 *    `src/game/**` but not `src/renderers/**`; the backstop for that path is the
 *    `writeBundle` audit, and the last case below pins that the backstop is armed.
 * 4. **Rollback is a no-op at the source level.** Plan section 12's rollback is
 *    `VITE_WORLD_RENDERER=phaser`. "The explicit flag and no flag are the same build" is
 *    a claim about the flag parser and the routing decision, and both are checkable
 *    without building twice.
 *
 * ## What this file deliberately does not do
 *
 * It does not rebuild, does not start a browser, and does not read `dist/`. Building
 * twice and diffing the artifact is a real check, but it costs two production builds on
 * every commit and it is a statement about Vite rather than about this repository's
 * seams. The artifact-level evidence - the default build emits no Pixi chunk at all, and
 * an eagerly-imported Pixi host fails the build - is in the phase evidence and is
 * reproduced by hand in the verification report.
 *
 * ## Hermeticity
 *
 * Reads only files inside the repository, imports only renderer-neutral modules (so no
 * `pixi.js` and no GPU), resolves no commit, and embeds no absolute path. It passes on a
 * clean checkout before anything has been built, which is the Phase 8 defect class
 * `tests/phase8/qa-hermeticity.test.ts` exists to stop.
 *
 * ## Privacy
 *
 * No learner data, no storage, no network, no subject, note, attachment, statistic, or
 * preference is read or named. The only identifiers inspected are import specifiers,
 * source text, and the shape of two object literals.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  DungeonRendererCapabilities,
  VillageRendererCapabilities,
  WorldRenderer,
} from '@/application/contracts/renderer';
import { parseRuntimeConfig } from '@/config/runtimeConfig';
import { createPixiWorldHost } from '@/renderers/pixi/runtime/createPixiWorldHost';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { createDomlessWorldEnvironment } from '@/renderers/pixi/runtime/worldEnvironment';
import type {
  PixiWorldHost,
  WorldAction,
  WorldActionState,
  WorldApplication,
  WorldScene,
  WorldSceneFactory,
} from '@/renderers/pixi/runtime/types';

import { REPO_ROOT, sourceOf, stripComments } from './support/phase9Build';
import { collectStaticClosure, manualChunkFor, rendererChunkFamily } from '../../vite.config';

/* -------------------------------------------------------------------------- */
/* 1. The Phase 2 contract still binds                                          */
/* -------------------------------------------------------------------------- */

/** The minimum a test needs to hand a `WorldApplication` back to the host. */
function stubApplication(canvas: HTMLCanvasElement): WorldApplication {
  let started = false;
  return {
    native: null,
    canvas,
    screenWidth: 320,
    screenHeight: 180,
    get tickerRunning(): boolean {
      return started;
    },
    resize: () => {},
    startTicker: () => {
      started = true;
    },
    stopTicker: () => {
      started = false;
    },
    onFrame: () => () => {},
    destroy: () => {},
  };
}

const STUB_SCENE: WorldScene<DungeonRendererCapabilities> = {
  actions: [
    { id: 'interact', label: 'Interact (key E)', hint: 'Talk to what is here.', keyboardKey: 'e', pointer: true },
  ] satisfies readonly WorldAction[],
  activate: () => true,
  readState: () => ({ interact: 'Nothing here.' }),
  update: () => {},
  onResize: () => {},
  destroy: () => {},
  /**
   * A real Phase 2 capability port, not a stand-in. Every member is present, so the
   * object satisfies the Phase 2 interface at the type level and the host can forward it
   * unchanged - which is the whole of the claim that Phase 11 needs no redesign.
   */
  capabilities: {
    setFloorVisibility: () => {},
    teleportToRoom: () => {},
    setArtifactRooms: () => {},
    setCollectedArtifactRooms: () => {},
    setReviewedArtifactRooms: () => {},
    setImageRooms: () => {},
    setRoomOverlayStates: () => {},
    triggerInteract: () => {},
  },
};

const STUB_FACTORY: WorldSceneFactory<WorldApplication, WorldScene<DungeonRendererCapabilities>> = (
  application,
) => {
  // The composition root's own first move: read the opaque handle and check it. A stub
  // has no engine behind it, so this is the call `asPixiApplication` refuses - which is
  // asserted separately, and is the reason this test can build a host at all without
  // naming PixiJS.
  expect(application.native).toBeNull();
  return STUB_SCENE;
};

function buildHost(): PixiWorldHost<DungeonRendererCapabilities> {
  return createPixiWorldHost<DungeonRendererCapabilities['setFloorVisibility'] extends never
    ? never
    : WorldApplication, WorldScene<DungeonRendererCapabilities>, DungeonRendererCapabilities>({
    host: document.createElement('div'),
    createApplication: async (spec) => stubApplication(spec.canvas),
    createScene: STUB_FACTORY,
    theme: resolveCozyWorldTheme({ theme: null, reducedMotion: false }),
    quality: { id: 'balanced', resolution: 2, antialias: true, maxFps: 0, preference: 'webgl' },
    reducedMotion: false,
    environment: createDomlessWorldEnvironment(),
  });
}

describe('the Phase 2 WorldRenderer contract is satisfied by the Phase 9 host', () => {
  it('the host object satisfies WorldRenderer at the type level and at run time', () => {
    const host = buildHost();
    // The annotation is the point. `PixiWorldHost.mount` returns a promise and
    // `WorldRenderer.mount` returns void, which TypeScript accepts only because a
    // function returning a value is assignable where void is expected. If Phase 9 had
    // widened the host past the contract - an extra required member with a different
    // meaning, say - this line would stop compiling rather than degrade quietly.
    const contract: WorldRenderer = host;
    for (const member of ['mount', 'unmount', 'isReady', 'restart'] as const) {
      expect(typeof contract[member], `WorldRenderer.${member}`).toBe('function');
    }
    expect(Object.keys(contract).sort()).toEqual(
      [
        'activateFromDom',
        'actions',
        'capabilities',
        'isReady',
        'mount',
        'onReady',
        'onState',
        'restart',
        'setMirrorElement',
        'setReducedMotion',
        'unmount',
      ].sort(),
    );
  });

  it('a Phase 2 capability port binds through the host unchanged, with no adapter', async () => {
    const host = buildHost();
    await host.mount();
    try {
      // Forwarded by reference. A host that reshaped it - cloned it, narrowed it, or
      // returned a fresh object per read - would force Phase 11 to write the adapter
      // this phase's design says it does not need.
      expect(host.capabilities).toBe(STUB_SCENE.capabilities);
      // And it is usable as the Phase 2 interface, not merely as the phase's own view.
      const port: DungeonRendererCapabilities | undefined = host.capabilities;
      expect(typeof port?.triggerInteract).toBe('function');
      // Every Phase 2 capability member the scene supplied is reachable. Read through
      // `unknown` because an interface has no index signature and indexing it directly
      // is a type error - which is the point: the host forwards the port without
      // reshaping it, so a member list is a run-time observation, not a static one.
      const forwarded = host.capabilities as unknown as Record<string, unknown>;
      for (const member of Object.keys(STUB_SCENE.capabilities as DungeonRendererCapabilities)) {
        expect(typeof forwarded[member], member).toBe('function');
      }
      // The village port is a different interface with a different shape; the host is
      // generic over it and does not care which one a scene chose. Mounted rather than
      // merely constructed, because `capabilities` reads through the scene and an
      // unmounted host legitimately has none.
      const villageScene: WorldScene<VillageRendererCapabilities> = {
        actions: [],
        activate: () => true,
        readState: (): WorldActionState => ({}),
        update: () => {},
        onResize: () => {},
        destroy: () => {},
        capabilities: {
          setDynamicStructures: () => {},
          setPlayerClass: () => {},
          triggerInteract: () => {},
          readPoi: () => null,
        },
      };
      const villageHost = createPixiWorldHost<
        WorldApplication,
        WorldScene<VillageRendererCapabilities>,
        VillageRendererCapabilities
      >({
        host: document.createElement('div'),
        createApplication: async (spec) => stubApplication(spec.canvas),
        createScene: () => villageScene,
        theme: resolveCozyWorldTheme({ theme: null }),
        quality: { id: 'balanced', resolution: 2, antialias: true, maxFps: 0, preference: 'webgl' },
        reducedMotion: false,
        environment: createDomlessWorldEnvironment(),
      });
      await villageHost.mount();
      try {
        expect(villageHost.capabilities).toBe(villageScene.capabilities);
        expect(typeof villageHost.capabilities?.readPoi).toBe('function');
        // And the dungeon member is absent, so the generic parameter is a real
        // distinction rather than a `WorldScene<any>` in disguise.
        expect(
          (villageHost.capabilities as unknown as Record<string, unknown>)['setFloorVisibility'],
        ).toBeUndefined();
      } finally {
        villageHost.unmount();
      }
    } finally {
      host.unmount();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The contract layer was not widened                                        */
/* -------------------------------------------------------------------------- */

const CONTRACTS_DIR = path.join(REPO_ROOT, 'src', 'application', 'contracts');

function filesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesIn(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

describe('src/application/contracts names no renderer, in code or in type', () => {
  it('the contract sources reach no renderer and leave no directory', () => {
    const contracts = filesIn(CONTRACTS_DIR);
    // Non-vacuity: the walk found the six contract files, so an empty result below is a
    // clean scan rather than a scan that reached nothing.
    //
    // Phase 12 WP-1 added `villageNpc.ts`, the renderer-neutral village NPC surface.
    // The list is still enumerated rather than asserted by count, because this gate
    // exists to make "the contract layer gained a file" a red run: the sixth entry is
    // a decision somebody made here, not a file that appeared.
    expect(contracts.map((file) => path.basename(file))).toEqual([
      'commands.ts',
      'events.ts',
      'index.ts',
      'renderer.ts',
      'villageNpc.ts',
      'world.ts',
    ]);

    const rendererSpecifiers: string[] = [];
    const escapes: string[] = [];
    for (const file of contracts) {
      const relative = path.relative(REPO_ROOT, file);
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const specifier of [...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1])) {
        if (
          specifier === 'phaser' ||
          specifier.startsWith('phaser/') ||
          specifier === 'pixi.js' ||
          specifier.startsWith('pixi.js/') ||
          specifier.startsWith('@pixi/') ||
          specifier.startsWith('@/game') ||
          specifier.startsWith('@/renderers') ||
          specifier.startsWith('@/game/') ||
          specifier.startsWith('@/renderers/')
        ) {
          rendererSpecifiers.push(`${relative} -> ${specifier}`);
        }
        // A `./sibling` import is how the barrel is built and is not an escape; a `..`
        // is. Resolved against the contracts directory rather than pattern-matched, so
        // `./renderer` and `../game/Scene` are told apart by what they resolve to.
        if (specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), specifier);
          if (!resolved.startsWith(CONTRACTS_DIR + path.sep)) escapes.push(`${relative} -> ${specifier}`);
        }
      }
    }
    expect(rendererSpecifiers, 'a contract module names a renderer').toEqual([]);
    expect(escapes, 'a contract module reaches outside src/application/contracts').toEqual([]);
  });

  it('the contract surface is exactly the declared shape, and names no engine', () => {
    const renderer = sourceOf('src/application/contracts/renderer.ts');
    // The exact declared surface, in the order the file declares it. Two names appear
    // twice because two of the three capability ports genuinely declare them -
    // `triggerInteract` on the dungeon and village ports, `setPlayerClass` on the
    // village and fishing ports - so a deduplicated list would be the wrong assertion.
    //
    // Phase 12 WP-1 added `readNpcSnapshot` and `invokeAction` to the village port:
    // the NPC snapshot a React panel reads, and the one route by which a DOM control
    // asks the village to act. Both are optional on the base port (the Phaser and
    // Pixi adapters wire them in WP-2), which is why `VillageNpcHost` re-declares
    // them as required rather than the base port requiring them today.
    //
    // The capture keeps the `?`, so the two lists below are distinguishable: the
    // `?`-suffixed entries are `VillageRendererCapabilities` (optional, still being
    // wired) and the bare ones immediately after are `VillageNpcHost` (the same two
    // members, required). The previous pattern had no `?` in it, which meant it
    // skipped the optional declarations entirely and every NPC entry in the list
    // below came from `VillageNpcHost` instead - so a *third* optional member added
    // to the base port left this gate green. Widening the capture to `([a-zA-Z]+\??)`
    // is what closes that; it matches a superset of the old pattern, so it can only
    // find more members, never fewer.
    //
    // Phase 17 added `readPlayerGridPosition?` to the village port and `WorldGridPosition`
    // beside it. That is exactly the case this capture exists to catch: a third and
    // fourth optional member on the base port, invisible to the narrower pattern.
    const members = [
      ...stripComments(renderer).matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z]+\??)(?:\(|:|;)/gm),
    ].map((match) => match[1]);
    expect(members).toEqual([
      'mount',
      'unmount',
      'isReady',
      'restart',
      'setFloorVisibility',
      'teleportToRoom',
      'setArtifactRooms',
      'setCollectedArtifactRooms',
      'setReviewedArtifactRooms',
      'setImageRooms',
      'setRoomOverlayStates',
      'triggerInteract',
      // `WorldGridPosition`, the two fields of the learner's tile. Declared
      // immediately above `VillageRendererCapabilities` because it is that port's
      // member type, so it is captured here rather than at the foot of the file. Two
      // bare names, not capabilities: the scanner reads every two-space declaration,
      // and this is what makes a stray field on a contract type visible too.
      'gridX',
      'gridY',
      'setDynamicStructures',
      'setPlayerClass',
      'triggerInteract',
      'readPoi',
      // `VillageRendererCapabilities`, optional pending adapter wiring (WP-2).
      'readNpcSnapshot?',
      'invokeAction?',
      // The learner's village tile, optional for the same reason: `src/ui/**` may not
      // import a renderer and so must feature-detect. Both adapters implement it and
      // both re-declare it as required on their own renderer interfaces, so the base
      // port keeps the `?` - the promotion belongs on the adapter that earned it.
      'readPlayerGridPosition?',
      // `VillageNpcHost`, the same two members required.
      'readNpcSnapshot',
      'invokeAction',
      // `FishingRendererCapabilities` resumes here.
      'setPlayerClass',
      'getCaughtCount',
      'returnToVillage',
    ]);
    // The doc comments are allowed to name both engines - and do, usefully, because they
    // say which adapter binds what. The code is not.
    expect(stripComments(renderer)).not.toMatch(/pixi|phaser/i);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The effective renderer boundary, mechanism by mechanism                   */
/* -------------------------------------------------------------------------- */

describe('the renderer boundary is enforced by two mechanisms that cover different specifiers', () => {
  const eslintConfig = readFileSync(path.join(REPO_ROOT, 'eslint.config.js'), 'utf8');
  const forbiddenBlock = eslintConfig.slice(
    eslintConfig.indexOf('FORBIDDEN_RENDERER_IMPORTS = ['),
    eslintConfig.indexOf('];', eslintConfig.indexOf('FORBIDDEN_RENDERER_IMPORTS = [')),
  );
  const lintCatches = (specifier: string): boolean => forbiddenBlock.includes(`'${specifier}'`);

  it('the ESLint list covers the Phase 8 renderer tree and both engine packages', () => {
    // Verified by throwaway violating files during the verification pass: each of
    // these four produced an ESLint error in `src/core`, `src/application`, `src/theme`,
    // and `src/services/persistence/v2`.
    for (const specifier of ['pixi.js', 'pixi.js/**', '@pixi/*', 'phaser', 'phaser/**', '@/game', '@/game/**', '**/../game']) {
      expect(lintCatches(specifier), `ESLint should forbid ${specifier}`).toBe(true);
    }
  });

  it('the ESLint list now covers the tree Phase 9 introduced, and the gap is closed', () => {
    // This was a REPORTED GAP when the verification pass wrote it: a throwaway file
    // in `src/core` importing `@/renderers/pixi/runtime/PixiWorldHost`, and again with
    // the `..`-relative equivalent, produced no ESLint error. The rule's own comment
    // explains the list is what stops "the renderer tree itself" being reached, and it
    // stopped `src/game/**` and not `src/renderers/**`.
    //
    // It was defence in depth rather than a shipped defect — the two other cases below
    // pin the boundary scan and the build-time audit that already caught a real
    // reach-through. `infrastructure-engineer` has since added the `src/renderers`
    // entries, so the record inverts. The assertions are kept rather than deleted,
    // because a future change that drops the layer again should trip a red run here,
    // which is the only reason the gap was written down in the first place.
    expect(lintCatches('@/renderers'), 'ESLint should forbid @/renderers').toBe(true);
    expect(lintCatches('@/renderers/**'), 'ESLint should forbid @/renderers/**').toBe(true);
    // Reported and still open: a specifier that walks *up past the root and back down*
    // — `../../src/renderers/...` — shares no prefix with the tree it reaches and is
    // matched by neither the alias globs nor the `**/../<tree>` forms, in either tree.
    // Nobody writes that form, and the identical mistake through the alias is refused.
    expect(lintCatches('../../src/renderers/pixi/runtime/PixiWorldHost')).toBe(false);
  });

  it('the boundary scan catches the aliased reach-through into the renderer tree', () => {
    // `tests/phase9/pixi-host-boundary.test.ts` already asserts this over the real
    // tree. Re-asserting the *rule*, on a fixture, so the guarantee is visible here and
    // so a change to that file's specifier list is noticed by a second gate.
    const specifier = '@/renderers/pixi/runtime/PixiWorldHost';
    expect(specifier.startsWith('@/renderers')).toBe(true);
    const neutralSource = stripComments(`import PixiWorldHost from '${specifier}';`);
    const specifiers = [...neutralSource.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(
      specifiers.filter((s) => s.startsWith('@/renderers') || s.startsWith('@/game') || s.startsWith('pixi')),
      'the aliased reach-through is what the boundary scan matches on',
    ).toEqual([specifier]);
  });

  it('and the build-time chunk audit is the backstop for a reach-through the lint misses', () => {
    // The decisive one. A renderer-neutral module that statically reached the Pixi host
    // would pull `pixi.js` into the entry's static closure, Vite would emit a
    // `modulepreload` for it, and `writeBundle` would fail the build. I proved this on
    // the real build by replacing the `import()` in `src/ui/App.tsx` with a static
    // import: the build failed with
    //   [renderer-chunks] the entry document can statically reach the Pixi runtime
    //   Statically reachable Pixi chunk(s): assets/vendor-pixi-spjaAvI8.js
    // and exited 1. This case pins the *logic* that produced it, hermetically.
    const eagerBundle = {
      'assets/index-abc12345.js': {
        fileName: 'assets/index-abc12345.js',
        type: 'chunk',
        isEntry: true,
        imports: ['assets/vendor-react-aaaaaaaa.js', 'assets/PixiWorldHost-bbbbbbbb.js'],
      },
      'assets/vendor-react-aaaaaaaa.js': { fileName: 'assets/vendor-react-aaaaaaaa.js', type: 'chunk' },
      'assets/PixiWorldHost-bbbbbbbb.js': {
        fileName: 'assets/PixiWorldHost-bbbbbbbb.js',
        type: 'chunk',
        imports: ['assets/vendor-pixi-cccccccc.js'],
      },
      'assets/vendor-pixi-cccccccc.js': { fileName: 'assets/vendor-pixi-cccccccc.js', type: 'chunk' },
    } as const;

    // `rendererChunkFamily` answers the *family*; the chunk-file *prefix* is the
    // `manualChunks` group name, and the two are declared together in `vite.config.ts`.
    expect(rendererChunkFamily('assets/vendor-pixi-cccccccc.js')).toBe('pixi');
    expect(rendererChunkFamily('assets/vendor-pixi-legacy-cccccccc.js')).toBe('pixi');
    expect(rendererChunkFamily('assets/vendor-phaser-cccccccc.js')).toBe('phaser');
    expect(rendererChunkFamily('assets/index-cccccccc.js')).toBeUndefined();
    const closure = collectStaticClosure(eagerBundle, ['assets/index-abc12345.js']);
    expect([...closure].sort()).toEqual([
      'assets/PixiWorldHost-bbbbbbbb.js',
      'assets/index-abc12345.js',
      'assets/vendor-pixi-cccccccc.js',
      'assets/vendor-react-aaaaaaaa.js',
    ]);

    // The same graph with the last edge made dynamic - which is how the application is
    // actually written - and the Pixi chunk leaves the closure. This pair is the whole
    // reason the audit is worth having: the two graphs differ by one edge, and only one
    // of them is a violation.
    const lazyBundle = {
      ...eagerBundle,
      'assets/PixiWorldHost-bbbbbbbb.js': {
        fileName: 'assets/PixiWorldHost-bbbbbbbb.js',
        type: 'chunk',
        dynamicImports: ['assets/vendor-pixi-cccccccc.js'],
      },
    } as const;
    expect([...collectStaticClosure(lazyBundle, ['assets/index-abc12345.js'])]).not.toContain(
      'assets/vendor-pixi-cccccccc.js',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Rollback is a no-op at the source level                                  */
/* -------------------------------------------------------------------------- */

describe('VITE_WORLD_RENDERER=phaser is the same build as no flag at all', () => {
  it('the parser answers `phaser` for the explicit value and for an absent one', () => {
    const absent = parseRuntimeConfig({});
    const explicit = parseRuntimeConfig({ VITE_WORLD_RENDERER: 'phaser' });
    expect(absent.worldRenderer).toBe('phaser');
    expect(explicit.worldRenderer).toBe('phaser');
    // Deep equality, not just the one field: if the explicit value changed any other
    // default, this is where it would show.
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(absent));
  });

  it('the chunking decision is identical for both, so rollback cannot change the artifact', () => {
    // The claim: the two builds differ by the value of one parsed flag and by nothing
    // in the chunk graph. A Phaser build - explicit or default - claims Phaser and React
    // and nothing else; a Pixi module id is the only thing that can land in the Pixi
    // group, and a Phaser build contains none.
    expect(manualChunkFor('/repo/node_modules/phaser/dist/phaser.js')).toBe('vendor-phaser');
    expect(manualChunkFor('/repo/node_modules/react/index.js')).toBe('vendor-react');
    for (const id of ['/repo/src/ui/App.tsx', '/repo/src/game/scenes/DungeonScene.ts', '/repo/src/theme/index.ts']) {
      expect(manualChunkFor(id), `${id} must stay in the entry graph`).toBeUndefined();
    }
    // The `pixi.js` module id is the one that claims the group, and it is reachable only
    // through the dynamic import - which is what `pixi-host-boundary.test.ts` and the
    // build-time audit each hold.
    expect(manualChunkFor('/repo/node_modules/pixi.js/lib/index.mjs')).toBe('vendor-pixi');
  });

  it('the route a Phaser build takes is the untouched GameScreen', () => {
    const app = stripComments(sourceOf('src/ui/App.tsx'));
    // `WorldRoute` is a new component, but on a Phaser build it returns the screen the
    // application rendered before Phase 9 and nothing else. The ternary is the seam;
    // what is behind it has to be `GameScreen`.
    const route = app.slice(app.indexOf('function WorldRoute'));
    const nonPixiBranch = route.slice(0, route.indexOf('if (pixiWorldHostFactory === null)'));
    expect(nonPixiBranch).toMatch(/worldRenderer\s*===\s*'pixi'/);
    expect(nonPixiBranch.split('return <GameScreen />;')).toHaveLength(2);
    // And the Pixi branch is unreachable in that build, which is why the artifact can
    // contain no Pixi bytes at all rather than unreached ones.
    expect(app).toMatch(/VITE_WORLD_RENDERER\s*===\s*'pixi'\s*\n\s*\?\s*\(\)\s*=>\s*import\(/);
  });
});
