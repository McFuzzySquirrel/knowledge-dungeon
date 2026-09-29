/**
 * One action, one owner: the host is the only thing that can change a world, and
 * changing one always republishes it.
 *
 * ## The defect this file exists for
 *
 * `src/renderers/pixi/runtime/types.ts` used to say, in the contract a scene author
 * reads first:
 *
 * > `activate` is the *only* way into a world action, whichever input path arrived.
 * > [...] the canvas keyboard handler, the canvas pointer handler, and the DOM mirror
 * > control all call the same function, so a route through the canvas cannot exist
 * > without the mirror control existing too - and this phase's gates assert that
 * > mapping rather than trusting it.
 *
 * Two of the three were true. The pointer handler called the *scene's own* `activate`,
 * not the host's dispatch, so the host never learned the tap had happened and never
 * called `publishState()`. In a real browser, two taps on the bell left the mirror's
 * `aria-live` line reading `Bell quiet`, and the next DOM-mirror click jumped to
 * `Bell rung 3 times` - a count the learner never saw reach one. The visible copy on
 * the screen, that "every canvas action has a control here", was false in the shipped
 * build.
 *
 * ## Why no gate caught it
 *
 * Because the three tests that looked like they covered it covered three different
 * things, none of them the path that broke:
 *
 * - `test-world-scene.test.ts` did `bell.emit('pointertap', ...)`, which calls the
 *   listener directly, bypasses Pixi's event system entirely, and then asserted on
 *   the scene's own counter.
 * - `pixi-composition-root.test.tsx` asserted `bell.listenerCount('pointertap') === 1`
 *   - that a listener *exists*. A listener that never fires satisfies that.
 * - `tests/e2e/pixiMemory.spec.ts` exercised the keyboard and the DOM control and
 *   never clicked the canvas.
 *
 * A listener count is not a delivery. So the gate here is not "the mapping is
 * documented": it is a scan of the whole renderer tree for every call to `activate`,
 * plus a behavioural check that the dispatcher the host hands a scene is one
 * function, is the same one after a restart, and republishes.
 *
 * ## Why a source scan, and not only a behavioural test
 *
 * Because the property is an *absence* - "no module but the host calls `activate`" -
 * and no behavioural test can observe an absence. A behavioural test can only show
 * that the paths somebody thought of work. The scan is what covers the path nobody
 * thought of, and it is cheap: it reads the repository's own sources and does not
 * import `pixi.js`, so it runs in a realm with no GPU in a few milliseconds.
 *
 * The behavioural half is still here, because the scan cannot prove the dispatcher
 * the scene receives is the one the host uses for its own two routes.
 *
 * ## Hermeticity
 *
 * No `dist/`, no commit, no network, no spawned process, no `pixi.js` import. It
 * reads files inside the repository and runs the host against a plain object
 * application, which is the same `WorldApplication` port the Phaser adapter era used.
 * No learner data, no subject, note, attachment, statistic, or preference is read or
 * named.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPixiWorldHost } from '../../src/renderers/pixi/runtime/createPixiWorldHost';
import { resolveCozyWorldTheme } from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import { createDomlessWorldEnvironment } from '../../src/renderers/pixi/runtime/worldEnvironment';
import type {
  PixiWorldHost,
  WorldAction,
  WorldActionDispatcher,
  WorldActionState,
  WorldApplication,
  WorldScene,
  WorldSceneInit,
} from '../../src/renderers/pixi/runtime/types';

import { REPO_ROOT, sourceOf, stripComments } from './support/phase9Build';

const RENDERERS_DIR = path.join(REPO_ROOT, 'src', 'renderers');
const HOST_MODULE = 'src/renderers/pixi/runtime/createPixiWorldHost.ts';
const SCENE_MODULE = 'src/renderers/pixi/testworld/createTestWorld.ts';

/** Every renderer source under `src/renderers`, in a stable order. */
function rendererSources(): { readonly relative: string; readonly code: string }[] {
  const found: { relative: string; code: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        found.push({
          relative: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
          code: stripComments(readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(RENDERERS_DIR);
  return found;
}

/* -------------------------------------------------------------------------- */
/* 1. The structural half: only the host may perform an action                  */
/* -------------------------------------------------------------------------- */

describe('only the host performs a world action', () => {
  it('the host is the single call site of `activate`, and it publishes on the next line', () => {
    const sources = rendererSources();
    // Non-vacuity: the walk reached the modules the claims below are about, so an
    // empty list further down is a clean scan rather than a scan that read nothing.
    expect(sources.map((entry) => entry.relative)).toContain(HOST_MODULE);
    expect(sources.map((entry) => entry.relative)).toContain(SCENE_MODULE);
    expect(sources.length).toBeGreaterThan(5);

    const callSites = sources.flatMap((entry) =>
      [...entry.code.matchAll(/[.\]]activate\s*\(/g)].map((match) => ({
        module: entry.relative,
        at: match.index ?? 0,
        text: match[0],
      })),
    );

    // One. Not "one per input path", not "one per scene": one, in the host.
    expect(
      callSites.map((site) => `${site.module}:${site.text.trim()}`),
      'something in the renderer tree calls `activate` directly, so a world can change without the mirror hearing it',
    ).toEqual([`${HOST_MODULE}:.activate(`]);

    // And it is the host's `dispatch`, with the publication on the adjacent line.
    // Split on the two-line gap so a reformat cannot quietly turn this into a
    // vacuous pass: the order and the adjacency are the property.
    const host = sourceOf(HOST_MODULE);
    const body = host.slice(host.indexOf('function dispatch('), host.indexOf('function onKeydown('));
    expect(body).toMatch(/scene\.activate\(actionId, source\);\s*\n\s*publishState\(\);/);
    // Publication is not conditional on the action having succeeded either: an
    // unknown id from a stale control still republishes, so the mirror cannot be
    // left describing a state the world is not in.
    expect(body).not.toMatch(/if\s*\([^)]*activate/);
  });

  it('the scene binds its action verb once, and never calls it', () => {
    const code = stripComments(sourceOf(SCENE_MODULE));
    const declarations = [...code.matchAll(/\bapplyAction\b/g)].length;
    // Exactly two: the declaration, and the `activate:` property that hands it to
    // the host. A third would be a closure over it - which is a scene able to
    // perform an action behind the host's back, which is the whole defect.
    expect(declarations).toBe(2);
    expect(code).toMatch(/activate:\s*applyAction,/);
    // The pointer handler asks the host instead.
    expect(code).toMatch(/init\.onAction\(TEST_WORLD_ACTIONS\.ring, 'pointer'\)/);
    // And the identifier is not called anywhere at all: the host calls it, through
    // the `activate` property, and the host is the only module that does.
    expect(code).not.toMatch(/\bapplyAction\s*\(/);
  });

  it('the contract tells the scene author the rule, and does not claim a gate that does not exist', () => {
    const code = stripComments(sourceOf('src/renderers/pixi/runtime/types.ts'));
    // `onAction` is required, not optional: a scene cannot be built without a route
    // through the host, so "a pointer target calls the host" is a type-level fact.
    expect(code).toMatch(/readonly onAction: WorldActionDispatcher;/);
    expect(code).not.toMatch(/onAction\?/);
    // The false claim, and its replacement, are both recorded rather than quietly
    // deleted - a reader who remembers the old wording can find out what changed.
    // Whitespace collapsed, because the contract is line-wrapped prose and a
    // reflow is not a change of claim; each fragment is one line of that prose, so
    // the assertion cannot be satisfied by a paragraph that says something else.
    const prose = sourceOf('src/renderers/pixi/runtime/types.ts').replace(/\s+/g, ' ');
    expect(prose).toContain('gates assert that mapping rather than');
    expect(prose).toContain('and the gates did not exist');
    expect(prose).toContain('pixi-dispatch-ownership.test.ts');
    expect(prose).toContain('pixi-canvas-pointer.spec.ts');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The behavioural half: one dispatcher, handed in, and it publishes         */
/* -------------------------------------------------------------------------- */

const ACTION: WorldAction = {
  id: 'ring',
  label: 'Ring the bell (key B)',
  hint: 'Rings the bell.',
  keyboardKey: 'b',
  pointer: true,
};

interface Recorder {
  readonly host: PixiWorldHost;
  readonly dispatchers: WorldActionDispatcher[];
  readonly activations: [string, string][];
  readonly published: WorldActionState[];
}

/** A host over a plain-object application, with a scene that records everything. */
function buildHost(): Recorder {
  const dispatchers: WorldActionDispatcher[] = [];
  const activations: [string, string][] = [];
  const published: WorldActionState[] = [];

  const scene: WorldScene = {
    actions: [ACTION],
    activate: (actionId, source) => {
      activations.push([actionId, source]);
      return actionId === ACTION.id;
    },
    readState: () => ({ [ACTION.id]: `Bell rung ${activations.length} times` }),
    update: () => {},
    onResize: () => {},
    destroy: () => {},
  };

  const host = createPixiWorldHost<WorldApplication, WorldScene>({
    host: document.createElement('div'),
    createApplication: async (spec) => {
      return {
        native: null,
        canvas: spec.canvas,
        screenWidth: 640,
        screenHeight: 480,
        tickerRunning: true,
        resize: () => {},
        startTicker: () => {},
        stopTicker: () => {},
        onFrame: () => () => {},
        destroy: () => {},
      };
    },
    createScene: (_application, init: WorldSceneInit) => {
      dispatchers.push(init.onAction);
      return scene;
    },
    theme: resolveCozyWorldTheme({ theme: null }),
    quality: { id: 'balanced', resolution: 2, antialias: true, maxFps: 0, preference: 'webgl' },
    reducedMotion: false,
    environment: createDomlessWorldEnvironment(),
  });
  host.onState((state) => published.push(state));

  return { host, dispatchers, activations, published };
}

describe('the dispatcher a scene is given is the one that publishes', () => {
  it('performs the action and republishes, from the scene\'s own pointer route', async () => {
    const { host, dispatchers, activations, published } = buildHost();
    await host.mount();
    try {
      // One publication from the mount itself, before anything has been done.
      expect(published).toHaveLength(1);

      // The canvas pointer route: exactly what a scene's `pointertap` handler calls.
      dispatchers[0](ACTION.id, 'pointer');
      expect(activations).toEqual([['ring', 'pointer']]);
      expect(published).toHaveLength(2);
      expect(published[1]).toEqual({ ring: 'Bell rung 1 times' });
    } finally {
      host.unmount();
    }
  });

  it('all three input routes land on the same activation and the same publication', async () => {
    const { host, dispatchers, activations, published } = buildHost();
    await host.mount();
    try {
      // The canvas pointer route: the function the scene was handed at construction.
      dispatchers[0](ACTION.id, 'pointer');
      // The DOM mirror control, through the host's port.
      host.activateFromDom(ACTION.id);
      // The world's own shortcut, with focus off the mirror.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));

      // Three routes, three activations, and the only difference between them is
      // `source` - which the scene contract says is reported and never branched on.
      expect(activations).toEqual([
        ['ring', 'pointer'],
        ['ring', 'dom'],
        ['ring', 'keyboard'],
      ]);
      // Three actions, three publications after the mount's own. This count is the
      // gate: the shipped defect was a pointer tap that moved the world and left the
      // mirror exactly where it was, so the pointer entry above would be missing
      // from the first list and the second count would be one short.
      expect(published).toHaveLength(4);
      expect(published[3]).toEqual({ ring: 'Bell rung 3 times' });
    } finally {
      host.unmount();
    }
  });

  it('is the same function after a restart, so a rebuilt scene cannot hold a stale one', async () => {
    const { host, dispatchers, published } = buildHost();
    await host.mount();
    try {
      expect(dispatchers).toHaveLength(1);
      host.restart();
      expect(dispatchers).toHaveLength(2);
      // Identity, not equality: a fresh closure per mount would be a dispatcher
      // closing over a different `scene` binding, and the old scene - already
      // destroyed - would still be reachable from the first one.
      expect(dispatchers[1]).toBe(dispatchers[0]);
      // And the rebuilt scene's route still reaches the new scene and still
      // republishes.
      dispatchers[1](ACTION.id, 'pointer');
      expect(published).toHaveLength(3);
    } finally {
      host.unmount();
    }
  });

  it('a route that arrives after unmount performs nothing and publishes nothing', async () => {
    const { host, dispatchers, activations, published } = buildHost();
    await host.mount();
    const before = published.length;
    host.unmount();
    dispatchers[0](ACTION.id, 'pointer');
    expect(activations).toHaveLength(0);
    expect(published).toHaveLength(before);
  });
});
