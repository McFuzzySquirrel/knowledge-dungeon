/**
 * `readPoi()`'s "no point of interest" sentinel.
 *
 * ## Why this needs its own file, and its own layout
 *
 * `createVillageScene.readPoi()` returns `null` when its nearest point of interest
 * is at least `1e9` world pixels away, which is the sentinel the Phaser scene has
 * always used for "nothing to point at". On the shipped `VILLAGE_MAP` the sentinel
 * is **unreachable**: the map always contains a `keeper-tower`, so `updatePoi`
 * always finds the Keeper at some finite distance and the returned record is never
 * the sentinel. A test that claimed to exercise the branch against the shipped map
 * without a fixture would be testing a branch that cannot run.
 *
 * So this file mocks `@/data/villageLayout` to remove the one always-present POI,
 * which makes the sentinel reachable and lets the branch be driven. The mock is
 * deliberately isolated in this file: `village-scene.test.ts` uses the shipped map,
 * and a `vi.mock` here is file-scoped, so the real-map coverage is untouched.
 *
 * The non-vacuity control comes first: with a dynamic keeper placed on the player,
 * `readPoi()` is non-null again, so a `null` below is the sentinel and not a scene
 * that stopped computing points of interest at all.
 *
 * Hermeticity: no `dist/`, no network, no commit, `storage: null`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/data/villageLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/villageLayout')>();
  return {
    ...actual,
    VILLAGE_MAP: {
      ...actual.VILLAGE_MAP,
      structures: actual.VILLAGE_MAP.structures.filter(
        (structure) => structure.type !== 'keeper-tower' && structure.type !== 'portal-icon',
      ),
    },
  };
});

import {
  asPixiApplication,
  createPixiApplication,
} from '../../src/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import { resolveWorldQualityProfile } from '../../src/renderers/pixi/runtime/types';
import { createVillageScene, type VillageScene } from '../../src/renderers/pixi/village/createVillageScene';
import { VILLAGE_MAP, type VillageStructure } from '../../src/data/villageLayout';
import type { VillageWorldModel } from '../../src/application/contracts/world';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

const theme = resolveCozyWorldTheme({ theme: null, reducedMotion: false });
const quality = resolveWorldQualityProfile('balanced');

let stub: StubbedContext;
let observer: StubbedResizeObserver;

beforeAll(() => {
  stub = installCanvasContextStub();
  observer = installResizeObserverStub();
});

afterAll(() => {
  observer.restore();
  stub.restore();
});

const liveApplications: Array<Awaited<ReturnType<typeof createPixiApplication>>> = [];
const liveScenes: VillageScene[] = [];

afterEach(() => {
  liveScenes.splice(0).forEach((scene) => scene.destroy());
  liveApplications.splice(0).forEach((application) => application.destroy({ releaseGlobalResources: true }));
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

async function mount(world: VillageWorldModel): Promise<VillageScene> {
  const application = await createPixiApplication({
    canvas: document.createElement('canvas'),
    quality,
    background: theme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(640, 480);
  let scene!: VillageScene;
  scene = createVillageScene(
    asPixiApplication(application),
    {
      theme,
      quality,
      onAction: (actionId, source) => scene.activate(actionId, source),
    },
    {
      world,
      callbacks: {
        onStructureApproached: vi.fn(),
        onStructureLeft: vi.fn(),
        onStructureInteract: vi.fn(),
        onReady: vi.fn(),
      },
      storage: null,
      spawn: { gridX: 15, gridY: 14 },
    },
  );
  liveScenes.push(scene);
  return scene;
}

function keeperAtSpawn(): VillageStructure {
  return { id: 'dyn-keeper', type: 'keeper-tower', label: 'Tower', gridX: 15, gridY: 14, width: 1, height: 1 };
}

describe('the no-point-of-interest sentinel', () => {
  it('the mocked map really has no always-present POI, so the branch can run', () => {
    expect(
      VILLAGE_MAP.structures.some(
        (structure) => structure.type === 'keeper-tower' || structure.type === 'portal-icon',
      ),
    ).toBe(false);
  });

  it('returns null when nothing is a candidate, and a record again once a Keeper exists', async () => {
    const scene = await mount({ kind: 'village', structures: [], playerClass: null });
    scene.update(0);
    expect(
      scene.capabilities?.readPoi(),
      'with no candidate at all, the sentinel distance reads as absent rather than as a zero-distance POI',
    ).toBeNull();

    // Non-vacuity: the same scene, one dynamic POI later, is not null.
    scene.capabilities?.setDynamicStructures([keeperAtSpawn()]);
    scene.update(0);
    const poi = scene.capabilities?.readPoi();
    expect(poi?.name).toBe('Keeper');
    expect(Number.isFinite(poi?.distance)).toBe(true);
  });
});
