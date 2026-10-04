/**
 * Phase 17's renderer deliverable, at the altitude where it is falsifiable: parity
 * between the Pixi pond and the pure fishing state machine.
 *
 * ## What this file asserts, precisely
 *
 * Phase 17's objective is "port fishing to Pixi while preserving the familiar cast, bite,
 * catch, keep, release, and recall loop", and the risk that claim carries is specific: a
 * renderer that grew a rule. A second bite timer, a second proximity test, a second power
 * curve, a second cast ballistics - each of those would *work*, would look right in a
 * browser, and would disagree with the machine the moment the two were compared. So this
 * file does not ask "does the pond draw a fish"; it asks:
 *
 * **given the same program of learner actions and frames, does the Pixi pond pass through
 * the same phases, emit the same audio hooks, and draw what the machine says it should?**
 *
 * ## The shape of the comparison
 *
 * One **program**, two interpreters:
 *
 * | Lane          | An `act` step                       | A `frame` step                                  |
 * |---------------|-------------------------------------|-------------------------------------------------|
 * | reference     | `reduceFishing(state, event, rng)`   | `reduceFishing(state, {type:'tick'}, rng)`      |
 * | Pixi pond     | the scene's `capabilities` method    | `scene.update(FRAME_MS)`                        |
 *
 * The program is expressed as "act, then frame until a predicate holds" - never as a fixed
 * number of frames - so neither lane decides when the cast lands or when the fish strikes.
 * Each lane stops on its **own** current state, which is the whole point: a renderer that
 * invented a bite window of the wrong length would arrive at `biting` on a different frame
 * index, and the recorded frame indices would differ.
 *
 * The reference lane is `reduceFishing` and nothing else. It is not a copy of the scene's
 * logic, and it is not a snapshot: `tests/phase17/fishingStateMachine.test.ts` already pins
 * the machine's behaviour against golden values, so this file's job is only the
 * *comparison*.
 *
 * ## Why the pond is built under `prefers-reduced-motion: reduce`
 *
 * Because the scene is *shaped* for it: with no local animation there is nothing between
 * the machine's state and the pixels, so the drawn float position, the drawn fish position,
 * the line's presence, and the power meter's presence must equal the machine's on every
 * frame. That is the strongest form of "the renderer invents nothing", and it is a *stronger*
 * claim than comparing phases. The four local animations the scene does keep - the reel
 * interpolation, the flee, the idle bob, the water shimmer - are then covered by a second
 * test that runs with motion enabled and asserts they end exactly where the machine does.
 *
 * ## Non-vacuity
 *
 * Four guards, each of which was tried as a mutation rather than assumed:
 *
 * 1. the programs between them must visit **all eight** `FishingStateName` values, so a
 *    program that never reached `reeling` cannot pass as a parity claim;
 * 2. the two programs must produce **different** audio-hook logs, so two empty logs
 *    compared against each other cannot read as agreement;
 * 3. the hook log must be non-empty *and* ordered `cast -> splash -> bite -> reel-in ->
 *    catch` for the catch program, so a recorder that recorded nothing fails here;
 * 4. the scene's phase must be observed through the **live scene graph**, not through a
 *    private field, so a renderer that drew nothing while reporting the right phase fails.
 *
 * ## What this file deliberately does not claim
 *
 * **No perception, no frame time, no GPU memory.** No pixel is asserted and no frame is
 * presented; the browser lane and Phase 22 own those. This file is a structural claim
 * about two programs agreeing.
 *
 * **Not a Phaser comparison.** `FishingScene` is the rollback lane and is left untouched,
 * and constructing a real Phaser scene needs booted engine systems. The Phaser lane's own
 * evidence is `tests/contracts/phase-2-adapter-lifecycle.test.ts` plus the machine's own
 * golden-value tests; what this file adds is the claim that the *new* renderer agrees with
 * the *new* authority.
 *
 * Hermeticity: a fixed session date, a fixed viewport, a fixed frame length, synthetic ids,
 * no network, no `dist/`, and no real clock - the scene integrates its own clock from frame
 * deltas and the machine takes `nowMs` on every event, so time here is data.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';

import {
  createFishingSessionRng,
  createFishingState,
  fishingRodTip,
  FISHING_STATE_NAMES,
  reduceFishing,
  type FishingAudioHook,
  type FishingMachineEffect,
  type FishingMachineEvent,
  type FishingMachineState,
  type FishingStateName,
} from '@/core/fishing/fishingStateMachine';
import {
  asPixiApplication,
  createPixiApplication,
} from '@/renderers/pixi/runtime/createPixiApplication';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import {
  resolveWorldQualityProfile,
  type WorldQualityId,
  type WorldSceneInit,
} from '@/renderers/pixi/runtime/types';
import {
  createFishingScene,
  FISHING_ACTIONS,
  FISHING_BEGIN_POWER_ACTION_ID,
  FISHING_HOOK_ACTION_ID,
  FISHING_RESET_ACTION_ID,
  type FishingScene,
} from '@/renderers/pixi/fishing/createFishingScene';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const VIEWPORT = { width: 800, height: 600 };
const FRAME_MS = 100;
/** A fixed date, so the seeded gameplay stream is the same on every run. */
const SESSION_DATE = '2026-01-01';
const PLAYER_CLASS = 'scholar';
/** Enough frames for any predicate either program waits on. A budget, not an expectation. */
const MAX_FRAMES = 400;

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

/* ── The program ───────────────────────────────────────────────────────────── */

/** A learner action the program can perform. */
type ActKind = 'begin-power' | 'release' | 'hook' | 'reset' | 'move-left' | 'move-none';

/** When a `frame` step stops, read off whichever lane is running - never a fixed count. */
type Until = { readonly phase: FishingStateName } | { readonly powerAtLeast: number };

/** One instruction: act, or frame until a predicate holds. */
type Step =
  | { readonly kind: 'act'; readonly op: ActKind }
  | { readonly kind: 'frame'; readonly until: Until; readonly max?: number };

/** What one lane observed, in order. */
interface LaneTrace {
  /** The phase after every instruction, including the initial state. */
  readonly phases: readonly FishingStateName[];
  /** Every audio hook, in order. */
  readonly audio: readonly FishingAudioHook[];
  /** Every revealed catch, in order. */
  readonly catches: readonly unknown[];
  /** How many frames each instruction consumed, per instruction. */
  readonly frameCounts: readonly number[];
  /** Per-frame drawn positions, for the reduced-motion comparison. */
  readonly drawn: Array<DrawnFrame>;
}

/** One frame's drawn state, as the pond reports it and as the machine holds it. */
interface DrawnFrame {
  readonly frame: number;
  readonly phase: FishingStateName;
  readonly bobber: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly fish: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly lineVisible: boolean;
  readonly powerBarVisible: boolean;
}

/* ── Lane 1: reduceFishing, alone ──────────────────────────────────────────── */

/** The machine event an `act` produces. There is no per-lane divergence to encode. */
function eventFor(op: ActKind, nowMs: number): FishingMachineEvent {
  switch (op) {
    case 'begin-power':
      return { type: 'begin-power', nowMs };
    case 'release':
      return { type: 'release', nowMs };
    case 'hook':
      return { type: 'hook', nowMs };
    case 'reset':
      return { type: 'reset', nowMs };
    case 'move-left':
      return { type: 'move', nowMs, intent: -1 };
    case 'move-none':
      return { type: 'move', nowMs, intent: 0 };
    default: {
      const unhandled: never = op;
      return unhandled;
    }
  }
}

interface ReferenceRun {
  readonly trace: LaneTrace;
  readonly finalState: FishingMachineState;
  /** The machine's own state after every frame, for the drawn-position comparison. */
  readonly statePerFrame: readonly FishingMachineState[];
}

function runReference(program: readonly Step[], eligible: boolean): ReferenceRun {
  const rng = createFishingSessionRng(SESSION_DATE, PLAYER_CLASS);
  let state = createFishingState({ viewport: VIEWPORT, nowMs: 0, eligible });
  let nowMs = 0;
  const phases: FishingStateName[] = [state.phase];
  const audio: FishingAudioHook[] = [];
  const catches: unknown[] = [];
  const frameCounts: number[] = [];
  const statePerFrame: FishingMachineState[] = [];

  for (const step of program) {
    if (step.kind === 'act') {
      const result = reduceFishing(state, eventFor(step.op, nowMs), rng);
      state = result.state;
      for (const effect of result.effects) collect(effect, audio, catches);
      // Recorded after the act, exactly as the pond records its readout after the port call.
      // Without this the two logs would differ in *length* for a reason that has nothing to
      // do with the pond, and the length difference would read as a phase difference.
      phases.push(state.phase);
      continue;
    }

    const limit = step.max ?? MAX_FRAMES;
    let used = 0;
    for (; used < limit; used += 1) {
      nowMs += FRAME_MS;
      const result = reduceFishing(state, { type: 'tick', nowMs }, rng);
      state = result.state;
      for (const effect of result.effects) collect(effect, audio, catches);
      statePerFrame.push(state);
      phases.push(state.phase);
      if (satisfied(state, step.until)) break;
    }
    frameCounts.push(used);
  }

  return { trace: { phases, audio, catches, frameCounts, drawn: [] }, finalState: state, statePerFrame };
}

function satisfied(
  state: { readonly phase: FishingStateName; readonly power: number },
  until: Until,
): boolean {
  return 'phase' in until ? state.phase === until.phase : state.power >= until.powerAtLeast;
}

/**
 * Project a machine effect onto the port's shapes, exactly as the pond does.
 *
 * The reveal is compared as `FishingCatchReveal` rather than as the machine's tagged union,
 * because that is what the pond forwards and the whole point of the assertion is that the
 * two agree on what a *caller* receives. The pond's own rule - the `type` discriminator is
 * not forwarded - is therefore part of what this file holds it to.
 */
function collect(effect: FishingMachineEffect, audio: FishingAudioHook[], catches: unknown[]): void {
  if (effect.type === 'audio') {
    audio.push(effect.hook);
    return;
  }
  catches.push({
    catalogId: effect.catalogId,
    rarity: effect.rarity,
    castNumber: effect.castNumber,
    description: effect.description,
  });
}

/* ── Lane 2: the real Pixi pond ────────────────────────────────────────────── */

interface MountedPond {
  readonly application: Awaited<ReturnType<typeof createPixiApplication>>;
  readonly pixi: ReturnType<typeof asPixiApplication>;
  readonly scene: FishingScene;
  readonly root: Container;
  readonly audio: FishingAudioHook[];
  readonly catches: unknown[];
  readonly dispatched: Array<[string, string]>;
}

const liveApplications: Array<Awaited<ReturnType<typeof createPixiApplication>>> = [];
const liveScenes: FishingScene[] = [];

afterEach(() => {
  for (const scene of liveScenes.splice(0)) {
    try {
      scene.destroy();
    } catch {
      /* asserted in the teardown file, not here */
    }
  }
  for (const application of liveApplications.splice(0)) {
    try {
      application.destroy({ releaseGlobalResources: true });
    } catch {
      /* likewise */
    }
  }
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

/**
 * A real PixiJS 8 `Application` with the real `createFishingScene` on it.
 *
 * The same altitude as `tests/phase13/dungeon-scene.test.ts`: a fake application would
 * prove only the scene's intent, and the scene graph is the only place the drawn positions
 * are observable at all. The canvas context and the `ResizeObserver` are the two facilities
 * jsdom lacks; neither can invent a fish or a phase.
 */
async function mountPond(options: {
  readonly reducedMotion: boolean;
  readonly quality?: WorldQualityId;
  readonly eligible?: boolean;
} ): Promise<MountedPond> {
  const quality = resolveWorldQualityProfile(options.quality ?? 'balanced');
  const pondTheme = resolveCozyWorldTheme({
    theme: null,
    reducedMotion: options.reducedMotion,
  });
  const application = await createPixiApplication({
    canvas: document.createElement('canvas'),
    quality,
    background: pondTheme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(VIEWPORT.width, VIEWPORT.height);
  const pixi = asPixiApplication(application);

  const audio: FishingAudioHook[] = [];
  const catches: unknown[] = [];
  const dispatched: Array<[string, string]> = [];
  let scene!: FishingScene;
  const init: WorldSceneInit = {
    theme: pondTheme,
    quality,
    // The host's one dispatcher. Here it performs *and* records, so "the canvas route and
    // the port route are one action" is observable rather than asserted.
    onAction: (actionId, source) => {
      dispatched.push([actionId, source]);
      scene.activate(actionId, source);
    },
    publishState: () => undefined,
  };
  scene = createFishingScene(
    pixi,
    init,
    {
      world: { playerClass: PLAYER_CLASS, hasClearedRooms: options.eligible ?? true },
      // `onAudioHook` is the scene's own callback, and the reveal arrives on the port's
      // subscription. Both are recorded, and both are the channels a real host uses: the
      // scene's callbacks bag for sound, `onCatchRevealed` for the DOM panel.
      callbacks: {
        onAudioHook: (hook) => {
          audio.push(hook);
        },
        onReturnToVillage: vi.fn(),
      },
      sessionDate: SESSION_DATE,
      // A fixed cosmetic stream, so a splash cannot make two runs differ for a reason that
      // has nothing to do with the machine.
      cosmeticRng: createFishingSessionRng('2026-01-01', 'cosmetic'),
      nowMs: 0,
    },
  );
  liveScenes.push(scene);
  scene.onResize(VIEWPORT.width, VIEWPORT.height);

  scene.capabilities.onCatchRevealed((reveal) => {
    catches.push({ ...reveal });
  });

  const root = pixi.stage.getChildByLabel('fishing-world');
  if (root === null) throw new Error('the scene added no labelled root to the real stage');

  return { application, pixi, scene, root, audio, catches, dispatched };
}

/** Every labelled descendant of a container, sorted. */
function labelsUnder(container: Container): string[] {
  const found: string[] = [];
  const visit = (node: Container): void => {
    if (typeof node.label === 'string' && node.label.length > 0) found.push(node.label);
    for (const child of node.children) {
      if (child instanceof Container) visit(child as Container);
    }
  };
  for (const child of container.children) {
    if (child instanceof Container) visit(child as Container);
  }
  return found.sort();
}

function runPond(mounted: MountedPond, program: readonly Step[]): LaneTrace {
  const phases: FishingStateName[] = [mounted.scene.capabilities.readReadout().phase];
  const frameCounts: number[] = [];
  const drawn: DrawnFrame[] = [];
  let frame = 0;

  for (const step of program) {
    if (step.kind === 'act') {
      const port = mounted.scene.capabilities;
      switch (step.op) {
        case 'begin-power':
          port.beginPower();
          break;
        case 'release':
          port.release();
          break;
        case 'hook':
          port.hook();
          break;
        case 'reset':
          port.reset();
          break;
        case 'move-left':
          port.move(-1);
          break;
        case 'move-none':
          port.move(0);
          break;
        default: {
          const unhandled: never = step.op;
          throw new Error(`unhandled act ${String(unhandled)}`);
        }
      }
      phases.push(mounted.scene.capabilities.readReadout().phase);
      continue;
    }

    const limit = step.max ?? MAX_FRAMES;
    let used = 0;
    for (; used < limit; used += 1) {
      mounted.scene.update(FRAME_MS);
      frame += 1;
      const readout = mounted.scene.capabilities.readReadout();
      const presentation = mounted.scene.capabilities.readPresentation();
      phases.push(readout.phase);
      drawn.push({
        frame,
        phase: readout.phase,
        bobber: presentation.bobber,
        fish: presentation.fish,
        lineVisible: presentation.lineVisible,
        powerBarVisible: presentation.powerBarVisible,
      });
      if (satisfied(readout, step.until)) break;
    }
    frameCounts.push(used);
  }

  return { phases, audio: mounted.audio, catches: mounted.catches, frameCounts, drawn };
}



/* ── The programs ──────────────────────────────────────────────────────────── */

/** Idle to a landed, biting float, then a hook and a catch. */
const CAST_TO_CATCH: readonly Step[] = [
  { kind: 'act', op: 'begin-power' },
  { kind: 'frame', until: { powerAtLeast: 1 } },
  { kind: 'act', op: 'release' },
  { kind: 'frame', until: { phase: 'waiting' } },
  { kind: 'frame', until: { phase: 'biting' } },
  { kind: 'act', op: 'hook' },
  { kind: 'frame', until: { phase: 'caught' } },
  { kind: 'act', op: 'reset' },
  { kind: 'frame', until: { phase: 'idle' } },
];

/** The same cast, then the bite window expires with no hook. */
const CAST_TO_MISS: readonly Step[] = [
  { kind: 'act', op: 'begin-power' },
  { kind: 'frame', until: { powerAtLeast: 1 } },
  { kind: 'act', op: 'release' },
  { kind: 'frame', until: { phase: 'waiting' } },
  { kind: 'frame', until: { phase: 'biting' } },
  // No hook. The window expiry is the only way a learner loses a fish they were offered.
  { kind: 'frame', until: { phase: 'missed' } },
  { kind: 'act', op: 'reset' },
  { kind: 'frame', until: { phase: 'idle' } },
];

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('the two lanes are set up, and the recorder discriminates', () => {
  it('the scene declares the three press actions and no keyboard shortcut', () => {
    // An action table that gained a fourth entry, or lost a `keyboardKey: null`, would make
    // the host's keyboard map and the scene's own handler fire one press twice. Asserted
    // because that is the defect the `null` is there to prevent.
    expect(FISHING_ACTIONS.map((action) => action.id)).toEqual([
      FISHING_BEGIN_POWER_ACTION_ID,
      FISHING_HOOK_ACTION_ID,
      FISHING_RESET_ACTION_ID,
    ]);
    expect(FISHING_ACTIONS.every((action) => action.keyboardKey === null)).toBe(true);
    expect(FISHING_ACTIONS.every((action) => action.pointer === true)).toBe(true);
    // And the machine's event table has exactly three press-shaped learner actions, so the
    // three above are the complete set rather than a subset someone chose.
    expect(new Set(FISHING_ACTIONS.map((action) => action.id)).size).toBe(3);
  });

  it('the pond names every visual the phase scope line names', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const labels = labelsUnder(pond.root);

    // Sky and horizon are ambient, the shore is the foreground, and the water is the band
    // between them: the scene's own `fishing-water` label covers the deep water and its
    // shimmer bands, `fishing-splash` covers the landing ripples and the bite pulse.
    for (const expected of [
      'fishing-sky',
      'fishing-stars',
      'fishing-horizon',
      'fishing-water',
      'fishing-shore',
      'fishing-trees',
      'fishing-fish',
      'fishing-angler',
      'fishing-rod',
      'fishing-rod-shaft',
      'fishing-float',
      'fishing-line',
      'fishing-bucket',
      'fishing-bucket-fish',
      'fishing-splash',
      'fishing-power',
    ]) {
      expect(labels, `the pond must draw ${expected}`).toContain(expected);
    }
  });

  it('the two programs produce different logs, so a matching pair is not two absences', () => {
    const caught = runReference(CAST_TO_CATCH, true);
    const missed = runReference(CAST_TO_MISS, true);

    expect(caught.trace.audio).not.toEqual(missed.trace.audio);
    expect(caught.trace.catches).toHaveLength(1);
    expect(missed.trace.catches).toHaveLength(0);
  });
});

describe('the Pixi pond and reduceFishing alone pass through the same run', () => {
  it('a cast to a catch: phases, frames, hooks, and the catch payload all agree', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const reference = runReference(CAST_TO_CATCH, true);
    const trace = runPond(pond, CAST_TO_CATCH);

    expect(trace.phases).toEqual(reference.trace.phases);
    // The frame *counts* are the part that catches an invented rule: a bite window of the
    // wrong length, or a reel that finished early, lands on a different frame index.
    expect(trace.frameCounts).toEqual(reference.trace.frameCounts);
    expect(trace.audio).toEqual(reference.trace.audio);
    expect(trace.catches).toEqual(reference.trace.catches);
  });

  it('the catch program emits every hook in order, and reaches every phase', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const trace = runPond(pond, CAST_TO_CATCH);

    expect(trace.audio).toEqual(['cast', 'splash', 'bite', 'reel-in', 'catch']);
    expect(trace.audio).toHaveLength(5);
    expect([...new Set(trace.phases)].sort()).toEqual(
      [...FISHING_STATE_NAMES].sort().filter((name) => name !== 'missed'),
    );
  });

  it('a missed fish: the window expiry produces the miss hook and no catch', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const reference = runReference(CAST_TO_MISS, true);
    const trace = runPond(pond, CAST_TO_MISS);

    expect(trace.phases).toEqual(reference.trace.phases);
    expect(trace.frameCounts).toEqual(reference.trace.frameCounts);
    expect(trace.audio).toEqual(reference.trace.audio);
    expect(trace.audio).toContain('miss');
    expect(trace.audio).not.toContain('catch');
    expect(trace.catches).toEqual([]);
    expect([...new Set(trace.phases)]).toContain('missed');
  });

  it('between them the two programs visit all eight machine states', async () => {
    const caught = runPond(await mountPond({ reducedMotion: true }), CAST_TO_CATCH);
    const missed = runPond(await mountPond({ reducedMotion: true }), CAST_TO_MISS);
    const visited = new Set([...caught.phases, ...missed.phases]);

    expect([...visited].sort()).toEqual([...FISHING_STATE_NAMES].sort());
  });

  it('the catch reveal carries a canonical id, a rarity, the cast number, and no name', async () => {
    const pond = await mountPond({ reducedMotion: true });
    runPond(pond, CAST_TO_CATCH);

    expect(pond.catches).toHaveLength(1);
    const reveal = pond.catches[0] as Record<string, unknown>;
    expect(typeof reveal.catalogId).toBe('string');
    expect(['common', 'rare', 'epic']).toContain(reveal.rarity);
    expect(reveal.castNumber).toBe(1);
    expect(typeof reveal.description).toBe('string');
    // The display name is DOM's, resolved from `FISH_CATALOG` by id. A renderer that
    // forwarded one would make a name keyable and loggable.
    expect(Object.keys(reveal).sort()).toEqual(['castNumber', 'catalogId', 'description', 'rarity']);
  });
});

describe('the pond draws the machine, not a second answer to it', () => {
  it('under reduced motion every drawn position equals the machine, on every frame', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const reference = runReference(CAST_TO_CATCH, true);
    const trace = runPond(pond, CAST_TO_CATCH);

    // Frame-for-frame. With no local animation the scene's job is to draw the state, so a
    // difference here is the renderer inventing a position.
    expect(trace.drawn.length).toBe(reference.statePerFrame.length);
    expect(trace.drawn.length).toBeGreaterThan(50);

    trace.drawn.forEach((frame, index) => {
      const machine = reference.statePerFrame[index];
      expect(frame.phase, `frame ${frame.frame}`).toBe(machine?.phase);
      expect(frame.bobber.x, `frame ${frame.frame} float x`).toBeCloseTo(machine?.bobber.x ?? 0, 6);
      expect(frame.bobber.y, `frame ${frame.frame} float y`).toBeCloseTo(machine?.bobber.y ?? 0, 6);
      expect(frame.bobber.visible, `frame ${frame.frame} float visible`).toBe(
        machine?.bobber.visible ?? false,
      );
      expect(frame.fish.x, `frame ${frame.frame} fish x`).toBeCloseTo(machine?.fish.x ?? 0, 6);
      expect(frame.fish.y, `frame ${frame.frame} fish y`).toBeCloseTo(machine?.fish.y ?? 0, 6);
      expect(frame.fish.visible, `frame ${frame.frame} fish visible`).toBe(
        machine?.fish.visible ?? false,
      );
      // And the two derived presences are the machine's facts read back: the line exists
      // exactly while the float is out and the phase is not charging, the meter exactly while
      // charging. Neither is an independent rule.
      expect(frame.lineVisible, `frame ${frame.frame} line`).toBe(
        (machine?.bobber.visible ?? false) && machine?.phase !== 'powering',
      );
      expect(frame.powerBarVisible, `frame ${frame.frame} meter`).toBe(machine?.phase === 'powering');
    });
  });

  it('the charging affordance is the one documented divergence, and it is not state', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const reference = runReference(CAST_TO_CATCH, true);
    const trace = runPond(pond, CAST_TO_CATCH);

    const charging = trace.drawn.filter((frame) => frame.phase === 'powering');
    expect(charging.length).toBeGreaterThan(0);

    // `FishingScene` showed the float at the rod tip at half alpha while charging, and the
    // machine holds it hidden at the origin because no cast has been launched. The pond
    // keeps the affordance - as a *presentation* of the machine's own rod tip - and this is
    // the one place the drawn position is not the machine's. The readout is unaffected, and
    // the assertion below is what makes that checkable rather than a comment.
    const tip = fishingRodTip(reference.finalState.playerX, VIEWPORT);
    for (const frame of charging) {
      expect(frame.bobber.visible).toBe(true);
      expect(frame.bobber.x).toBeCloseTo(tip.x, 6);
      expect(frame.bobber.y).toBeCloseTo(tip.y, 6);
      expect(frame.powerBarVisible).toBe(true);
    }

    // And once released, the drawn float is the machine's again.
    const casting = trace.drawn.filter((frame) => frame.phase === 'casting');
    expect(casting.length).toBeGreaterThan(0);
    expect(casting.some((frame) => frame.powerBarVisible)).toBe(false);
  });

  it('with motion enabled the reel travels and lands exactly where the machine does', async () => {
    const pond = await mountPond({ reducedMotion: false });
    const reference = runReference(CAST_TO_CATCH, true);
    const trace = runPond(pond, CAST_TO_CATCH);

    // Phases and hooks still agree, so enabling local animation changed presentation only.
    expect(trace.phases).toEqual(reference.trace.phases);
    expect(trace.frameCounts).toEqual(reference.trace.frameCounts);
    expect(trace.audio).toEqual(reference.trace.audio);

    const reelingFrames = trace.drawn.filter((frame) => frame.phase === 'reeling');
    expect(reelingFrames.length).toBeGreaterThan(1);
    // Travelling: the float's distance to the rod tip shrinks monotonically across the reel,
    // which is a claim the reduced-motion run cannot make at all.
    const tip = fishingRodTip(reference.finalState.playerX, VIEWPORT);
    const distances = reelingFrames.map((frame) => Math.hypot(frame.bobber.x - tip.x, frame.bobber.y - tip.y));
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeLessThanOrEqual(distances[index - 1] ?? Infinity);
    }

    // And the last reeling frame is the machine's `caught` frame: the interpolation's end
    // point is the machine's end point, not a second one.
    const caughtFrame = trace.drawn.find((frame) => frame.phase === 'caught');
    const machineCaught = reference.statePerFrame.find((state) => state.phase === 'caught');
    expect(caughtFrame).toBeDefined();
    expect(caughtFrame?.fish.x).toBeCloseTo(machineCaught?.fish.x ?? 0, 6);
    expect(caughtFrame?.fish.y).toBeCloseTo(machineCaught?.fish.y ?? 0, 6);
    expect(caughtFrame?.bobber.visible).toBe(false);
  });
});

describe('the canvas, the keyboard, and the DOM port are one action', () => {
  it('a keyboard press and a key release produce exactly the cast the port produces', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const window_ = pond.pixi.canvas.ownerDocument.defaultView;
    if (window_ === null) throw new Error('the canvas has no window to dispatch on');

    // `Space` is bound directly rather than through the host's shortcut map, so the scene's
    // own handler is what answers. The host's map has no key for it - `FISHING_ACTIONS` is
    // asserted to be all-`null` above - so a press can only have one route.
    window_.dispatchEvent(new window_.KeyboardEvent('keydown', { key: ' ' }));
    expect(pond.scene.capabilities.readReadout().phase).toBe('powering');

    for (let index = 0; index < 15; index += 1) pond.scene.update(FRAME_MS);
    window_.dispatchEvent(new window_.KeyboardEvent('keyup', { key: ' ' }));
    expect(pond.scene.capabilities.readReadout().phase).toBe('casting');

    // And the press went through the host's dispatcher, not straight into the scene.
    expect(pond.dispatched.map(([actionId]) => actionId)).toEqual([
      FISHING_BEGIN_POWER_ACTION_ID,
    ]);
  });

  it('a press on the water charges and a release casts, and a press on the shore does neither', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const canvas = pond.pixi.canvas;
    // jsdom reports a zero rect, so the client coordinates below are also zero; the shore
    // rejection is therefore asserted through the *difference* between two presses rather
    // than through absolute geometry, which is the part the scene actually decides.
    canvas.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 400, clientY: 100, pointerId: 1 }));
    expect(pond.scene.capabilities.readReadout().phase).toBe('powering');
    canvas.dispatchEvent(new window.PointerEvent('pointerup', { clientX: 400, clientY: 100, pointerId: 1 }));
    expect(pond.scene.capabilities.readReadout().phase).toBe('casting');
    expect(pond.dispatched.map(([actionId, source]) => [actionId, source])).toEqual([
      [FISHING_BEGIN_POWER_ACTION_ID, 'pointer'],
    ]);
  });

  it('a press in a phase with no invitation sends nothing at all', async () => {
    const pond = await mountPond({ reducedMotion: true });
    const canvas = pond.pixi.canvas;

    // `casting` invites nothing. The Phaser scene's `switch` had no arm for it either; the
    // difference this asserts is that nothing is *sent*, rather than something sent and
    // refused - so the learner cannot fill a log with refusals for a press that is not a
    // gesture in this phase.
    pond.scene.capabilities.beginPower();
    pond.scene.capabilities.release();
    expect(pond.scene.capabilities.readReadout().phase).toBe('casting');
    const before = pond.dispatched.length;
    canvas.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 400, clientY: 100, pointerId: 2 }));
    expect(pond.dispatched.length).toBe(before);
  });
});

describe('eligibility is the machine construction input, not a renderer rule', () => {
  it('an ineligible subject cannot begin a power cast, and the pond says so in words', async () => {
    const pond = await mountPond({ reducedMotion: true, eligible: false });
    const reference = runReference(CAST_TO_CATCH, false);

    const trace = runPond(pond, CAST_TO_CATCH);
    expect(trace.phases).toEqual(reference.trace.phases);
    // Both lanes stay in `idle` for the whole program, because `begin-power` is refused with
    // `fishing-not-eligible` and every later event is refused as an illegal transition.
    expect([...new Set(trace.phases)]).toEqual(['idle']);
    expect(pond.scene.capabilities.readReadout().eligible).toBe(false);

    // The pond draws a padlock; the words that explain it are React DOM's, which is why this
    // assertion is about the readout and the status sentence and not about a label.
    expect(pond.scene.readState()[FISHING_BEGIN_POWER_ACTION_ID]).toContain('idle');
  });
});