/**
 * The fishing lane's published host, and the one flag both lanes have to agree about.
 *
 * ## Why this file exists
 *
 * `tests/e2e/fishing.spec.ts` runs against a real `VITE_PIXI_FISHING=true` artifact and reported,
 * with four measurements, that the village's fishing-pond entry point mounted **no Pixi pond at
 * all**: one canvas, zero requests for the fishing chunk, zero `.fishing-hud`, zero
 * `.pixi-fishing-world`, and `data-world` reading `fishing`. A flagged browser lane caught it;
 * no unit test could, because the failure is an *ordering* fact about two pieces of React state
 * rather than a wrong value.
 *
 * ## Defect 1: the chicken-and-egg on the host ref
 *
 * `usePixiFishingLane` assigned its host ref inside the `useEffect` guarded by
 * `session !== null`, and `session` was set **only** by calling `hostRef.current.enter(...)`.
 * So the ref was never assigned, `enter` was never reachable, the effect never ran, and
 * `resolveFishingHost()`'s `readPixiFishingHost() ?? readPhaserHandle()?.fishing?.()` always
 * fell through to the Phaser handle. On `build:web:pixi-fishing` - which sets **only**
 * `VITE_PIXI_FISHING`, leaving the village on Phaser - the flagged artifact therefore ran the
 * rollback lane, and every Phase 17 exit criterion went unmeasured behind a green build.
 *
 * The fix publishes the host from the **build flag** rather than from a session. This file pins
 * that order, and pins the distinction the fix depends on: a non-null host is **not** a mounted
 * pond, and nothing in the DOM may read it as one.
 *
 * ## Defect 2: the rollback path never cleared `active`
 *
 * `useVillageFishing`'s `active` flag drives `data-world`, the "You have started fishing" live
 * region, and whether the catch surfaces exist. It was cleared by the **Pixi** lane's teardown
 * and by nothing else - so on the Phaser rollback lane, `FishingScene`'s `ESC` binding and its
 * in-scene return button both ended the scene while the screen went on announcing a pond that no
 * longer existed. `tests/e2e/fishingRollback.spec.ts` recorded that as an evidence note rather
 * than asserting a value it knew was wrong. It was a learner-visible false sentence on the lane
 * that ships by default.
 *
 * ## What this file does and does not prove
 *
 * It drives the real hooks and the real flow adapter in jsdom. It proves the **ordering and the
 * wiring** - who calls what, in what order, on which lane - and it proves the DOM states the
 * learner can observe. It does not mount a pond: `PixiFishingLaneSurface` is rendered only in its
 * no-session state, because reaching a real `FishingWorld` needs the WebGL context the browser
 * lane already measures. Every identifier here is synthetic and is written by this file.
 */
import { act, cleanup, render } from '@testing-library/react';
import { forwardRef, useCallback, useImperativeHandle, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FishingWorldModel, PlayerClassId } from '@/application/contracts/world';
import type { StudyFlowFishCaught } from '@/application/studyFlow';
import { FishingHud } from '@/ui/fishing/FishingHud';
import type { PixiFishingLane } from '@/ui/screens/PixiFishingLane';
import type { UseVillageFishing } from '@/ui/screens/useVillageFishing';
import type { VillageFishingHost, VillageFishingHostHandlers } from '@/ui/village/villageStudyFlow';

/** Synthetic ids only. Nothing here is a learner value or a real structure id. */
const POND_ID = 'synthetic-lane-pond';
const SUBJECT_ID = 'synthetic-lane-subject';

const MODEL: FishingWorldModel = {
  kind: 'fishing',
  playerClass: 'scholar' as PlayerClassId,
  hasClearedRooms: true,
  subjectId: SUBJECT_ID,
};

function handlers(pondId: string | undefined): VillageFishingHostHandlers {
  return {
    onFishCaught: (_data: StudyFlowFishCaught) => {},
    onReturnToVillage: () => {},
    onReady: () => {},
    ...(pondId === undefined ? {} : { pondId }),
  };
}

type LaneModule = typeof import('@/ui/screens/PixiFishingLane');
type HookModule = typeof import('@/ui/screens/useVillageFishing');
type FlowModule = typeof import('@/ui/village/villageStudyFlow');

/**
 * The lane module, loaded with the build flag at a chosen value.
 *
 * `vi.resetModules` plus a fresh `import()` because the flag is read at **module scope** - the
 * same reason `PixiFishingLane.tsx`'s own header exists - so a statically imported copy would
 * carry the flag this file did not set. `vi.stubEnv` is what makes `import.meta.env` writable in
 * vitest at all.
 */
async function loadLane(pixiFishing: boolean): Promise<LaneModule> {
  vi.resetModules();
  vi.stubEnv('VITE_PIXI_FISHING', pixiFishing ? 'true' : 'false');
  return import('@/ui/screens/PixiFishingLane');
}

/**
 * The hook module, loaded after the lane.
 *
 * It reaches the lane's flag through a static import, so it has to be re-imported in the same
 * registry generation or it would close over the lane module from the previous one.
 */
async function loadHook(): Promise<HookModule> {
  return import('@/ui/screens/useVillageFishing');
}

/**
 * A box the probe writes each render and the assertions read after each `act`.
 *
 * The hook returns a **fresh object every render**, so a test that captures one and keeps it
 * reads the values from before the update - which is how a test can pass a `setState` and then
 * assert against the state it was trying to change. Reading through the box is what makes each
 * assertion about the render `act` actually produced.
 */
interface Box<T> {
  current: T | null;
}

function laneProbe(lane: LaneModule): {
  readonly box: Box<PixiFishingLane>;
  readonly Probe: () => null;
} {
  const box: Box<PixiFishingLane> = { current: null };
  function Probe(): null {
    // Stable identities, exactly as `useVillageFishing` supplies them. An inline arrow per
    // render is legal and still works - `readHost` reads a ref - but it would make the
    // "one identity across renders" assertion below measure this file rather than the product.
    const onSessionChange = useCallback((_active: boolean) => {}, []);
    const onSessionStarted = useCallback((_pondId: string) => {}, []);
    box.current = lane.usePixiFishingLane(onSessionChange, onSessionStarted);
    return null;
  }
  return { box, Probe };
}

/** The box's current value, or a failure naming what was missing. */
function read<T>(box: Box<T>, what: string): T {
  if (box.current === null) throw new Error(`${what} was never rendered.`);
  return box.current;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('defect 1: the Pixi host is published before any session exists', () => {
  it('a build with the chunk publishes a host with nothing entered', async () => {
    const lane = await loadLane(true);
    const { box, Probe } = laneProbe(lane);
    render(<Probe />);

    const current = read(box, 'the lane');
    expect(current.readHost(), 'a build with a Pixi fishing chunk published no host to the flow').not.toBeNull();

    // **No session.** This is the whole of the distinction the fix rests on, so it is asserted
    // rather than assumed: the host exists, the pond does not.
    expect(
      current.session,
      'a pre-session host reported a session, so "a host exists" and "a pond is running" are one fact',
    ).toBeNull();
  });

  it('a build with no chunk publishes nothing, so the Phaser lane keeps the entry point', async () => {
    const lane = await loadLane(false);
    const { box, Probe } = laneProbe(lane);
    render(<Probe />);

    // The rollback half of the cutover. `resolveFishingHost()`'s `??` only reaches the Phaser
    // `FishingScene` while this is `null`, so this assertion is the one that keeps
    // `VITE_PIXI_FISHING=false` shipping the scene it shipped before.
    expect(read(box, 'the lane').readHost()).toBeNull();
  });

  it('`enter` is reachable, and it carries the pond id the flow resolved', async () => {
    const lane = await loadLane(true);
    const { box } = laneProbe(lane);
    const started: string[] = [];
    const onSessionChange = (_active: boolean): void => {};
    const onSessionStarted = (pondId: string): void => {
      started.push(pondId);
    };
    function StartedProbe(): null {
      box.current = lane.usePixiFishingLane(onSessionChange, onSessionStarted);
      return null;
    }
    render(<StartedProbe />);

    const host = read(box, 'the lane').readHost() as VillageFishingHost;

    // The call that was unreachable before. If the host were published by `enter`, this line is
    // the first statement in the function and `host` would be `null`.
    act(() => {
      host.enter(MODEL, handlers(POND_ID));
    });

    const current = read(box, 'the lane');
    expect(current.session, '`enter` published no session').not.toBeNull();
    expect(current.session?.model).toBe(MODEL);
    expect(current.session?.pondId, 'the pond id the flow resolved was dropped again').toBe(POND_ID);
    expect(started, 'the screen was never told which pond the world was published for').toEqual([
      POND_ID,
    ]);
  });

  it('`returnToVillage` ends the session, and `exit` is the very same function', async () => {
    const lane = await loadLane(true);
    const { box } = laneProbe(lane);
    const reports: boolean[] = [];
    const onSessionChange = (active: boolean): void => {
      reports.push(active);
    };
    const onSessionStarted = (_pondId: string): void => {};
    function ReportingProbe(): null {
      box.current = lane.usePixiFishingLane(onSessionChange, onSessionStarted);
      return null;
    }
    render(<ReportingProbe />);

    const host = read(box, 'the lane').readHost() as VillageFishingHost;
    act(() => {
      host.enter(MODEL, handlers(POND_ID));
    });
    act(() => {
      host.returnToVillage();
    });

    expect(read(box, 'the lane').session, 'the pond outlived the world that was told to stop').toBeNull();
    expect(reports, 'the screen was not told the session closed').toEqual([false]);

    // One teardown, not two. A screen return control and a renderer return control are one
    // event, and two copies of the teardown is how `session` and the screen's flag drift apart.
    expect(host.returnToVillage).toBe(read(box, 'the lane').exit);
  });

  it('an undecided catch cannot be answered after the pond closes', async () => {
    const lane = await loadLane(true);
    const { box, Probe } = laneProbe(lane);
    render(<Probe />);

    act(() => {
      read(box, 'the lane').recordPendingCatch('moss-carp', 3);
    });
    expect(read(box, 'the lane').takePendingCatch()).toEqual({ catalogId: 'moss-carp', castNumber: 3 });

    act(() => {
      read(box, 'the lane').recordPendingCatch('moss-carp', 4);
      (read(box, 'the lane').readHost() as VillageFishingHost).returnToVillage();
    });
    expect(
      read(box, 'the lane').takePendingCatch(),
      'a catch identity survived the session that owned it',
    ).toBeNull();

    // And the fallback counter restarts, so a second trip cannot reuse a dead trip's number.
    act(() => {
      read(box, 'the lane').recordPendingCatch('river-trout', null);
    });
    expect(read(box, 'the lane').takePendingCatch()).toEqual({ catalogId: 'river-trout', castNumber: 1 });
  });

  it('the published host keeps one identity across renders', async () => {
    const lane = await loadLane(true);
    const { box, Probe } = laneProbe(lane);
    const view = render(<Probe />);
    const first = read(box, 'the lane').readHost();

    view.rerender(<Probe />);
    view.rerender(<Probe />);

    // `VillageScreen` builds its study flow once inside a ref guard, so the
    // `readPixiFishingHost` it keeps for the life of the screen would otherwise be reading a
    // host that no longer exists.
    expect(read(box, 'the lane').readHost()).toBe(first);
  });

  it('the surface renders nothing while a host exists and no session does', async () => {
    const lane = await loadLane(true);
    const box: Box<PixiFishingLane> = { current: null };
    function Probe(): JSX.Element {
      box.current = lane.usePixiFishingLane(
        useCallback((_active: boolean) => {}, []),
        useCallback((_pondId: string) => {}, []),
      );
      return (
        <lane.PixiFishingLaneSurface
          lane={read(box, 'the lane')}
          renderControls={() => <div data-testid="controls" />}
        />
      );
    }
    const view = render(<Probe />);

    // The assertion is only meaningful because the host exists and the session does not: this is
    // the state a learner is in whenever they are standing in the village, and it must not read
    // as "a pond is running".
    expect(read(box, 'the lane').readHost()).not.toBeNull();
    expect(read(box, 'the lane').session).toBeNull();
    expect(view.container.innerHTML, 'a pre-session host rendered a pond surface').toBe('');
    expect(view.queryByTestId('controls')).toBeNull();
  });
});

/**
 * A stand-in for the lazy chunk, which is what the real boundary cannot give a jsdom test.
 *
 * `src/renderers/pixi/fishing/FishingWorld` imports PixiJS and asks for a WebGL context, so the
 * real one cannot be evaluated here - and `tests/phase17/fishing-flag-boundary.test.ts` forbids
 * naming the chunk specifier from a test in a way that would count as a second reach. What the
 * ordering under test needs from the chunk is only two things: that it attaches a handle through
 * a ref, and that it does so only after the boundary resolves.
 *
 * The stand-in is registered with `vi.doMock` **before** the lane module is imported, because
 * `PixiFishingLane` captures the module-scope `lazy()` whose factory calls
 * `import('@/renderers/pixi/fishing/FishingWorld')` on first render - so the mock intercepts the
 * real chunk specifier while leaving the product's own `Suspense`, effect ordering, and port
 * adapter exactly as they ship. Nothing else in the test is simulated.
 */

/**
 * The live readout the stand-in publishes, chosen so every member differs from
 * `FISHING_HUD_IDLE_READOUT`.
 *
 * `phase: 'idle'` on purpose. The defect's learner-visible symptom is **a greyed-out charge
 * button on an eligible pond**, and the charge is legal in `idle` and in nothing else - so a
 * stand-in reporting a later phase would make that control legitimately disabled and the
 * strongest signal would be lost. `eligible: true` and a non-zero `power` are what distinguish
 * this readout from the fallback, and all three reach the DOM.
 */
const LIVE_READOUT = { phase: 'idle', eligible: true, power: 0.42 } as const;

const FakeFishingWorld = forwardRef(function FakeFishingWorld(
  _props: Record<string, unknown>,
  ref: React.Ref<{ readReadout: () => typeof LIVE_READOUT }>,
): JSX.Element {
  // Suspend exactly as a not-yet-loaded chunk does. The thrown thenable is the *boundary's*
  // trigger to render its fallback and to commit nothing inside itself, which is the condition
  // the defect needs.
  if (liveGate !== null) throw liveGate;
  useImperativeHandle(
    ref,
    () => ({
      readReadout: () => LIVE_READOUT,
      onPhase: (listener: (readout: typeof LIVE_READOUT) => void) => {
        listener(LIVE_READOUT);
        return () => {};
      },
      beginPower: () => {},
      release: () => {},
      hook: () => {},
      reset: () => {},
      move: () => {},
      returnToVillage: () => {},
    }),
    [],
  );
  return <div data-testid="fake-world">fake pond</div>;
});

/** The thenable the stand-in throws while it is "loading", or `null` once it has loaded. */
let liveGate: Promise<void> | null = null;

describe('defect 3: the HUD port is built after the chunk mounts, not before', () => {
  it('the HUD reads the world it subscribed to, not the idle fallback', async () => {
    vi.doMock('@/renderers/pixi/fishing/FishingWorld', () => ({ default: FakeFishingWorld }));
    liveGate = new Promise<void>(() => {});
    const laneModule = await loadLane(true);
    const hookModule = await loadHook();

    const box: Box<UseVillageFishing> = { current: null };
    function Probe(): JSX.Element {
      box.current = hookModule.useVillageFishing(() => {}, true);
      return (
        <laneModule.PixiFishingLaneSurface
          lane={read(box, 'the fishing surface').lane}
          renderControls={(port) => <FishingHud port={port} />}
        />
      );
    }
    const view = render(<Probe />);

    // Enter the pond. The chunk is still suspended, so the boundary commits its fallback and the
    // HUD mounts on a port whose `onPhase` has nothing to subscribe to.
    act(() => {
      read(box, 'the fishing surface').prepareSession();
      (
        read(box, 'the fishing surface').lane.readHost() as VillageFishingHost
      ).enter(MODEL, handlers(POND_ID));
    });
    expect(
      view.container.querySelector('.fishing-hud'),
      'the HUD is not rendered while the chunk is suspended, so there is nothing to re-subscribe',
    ).not.toBeNull();
    // The baseline is read rather than assumed: a HUD that was somehow already reading the world
    // would make every assertion after it prove nothing.
    expect(
      (view.container.querySelector('#fishing-charge-hold') as HTMLButtonElement | null)?.disabled,
      'the charge control was enabled while the chunk was still suspended, so this test is not ' +
        'proving the ordering',
    ).toBe(true);

    // The chunk resolves and the boundary commits, attaching the world's handle.
    await act(async () => {
      liveGate = null;
    });

    // **The assertion.** Without the port being rebuilt once the chunk committed, `onPhase`
    // subscribed while `worldRef.current` was `null`, its fallback reported
    // `FISHING_HUD_IDLE_READOUT` (`eligible: false`, `power: 0`) and returned a no-op, and the
    // HUD stayed there for the rest of the session - on an eligible pond, with no error thrown
    // anywhere. In a browser that presented as a pond that was reachable, presented, ready, and
    // unusable, and the only symptom was a greyed-out button.
    const after = view.container.querySelector('.fishing-hud') as HTMLElement | null;
    expect(
      after?.getAttribute('data-fishing-phase'),
      'the HUD is not reporting the phase the world published',
    ).toBe(LIVE_READOUT.phase);
    expect(
      after?.querySelector('[data-fishing-power]')?.getAttribute('data-fishing-power'),
      'the HUD is still reading the idle fallback (0 percent) instead of the world it subscribed to',
    ).toBe('42');
    // The ineligible sentence by its **text**, not by its class: `.fishing-hud__phase-status` is
    // used twice, and the second use is the catch tally, which is legitimately present.
    expect(after?.textContent, 'the padlock sentence rendered on an eligible pond').not.toContain(
      'closed for now',
    );
    expect(
      (view.container.querySelector('#fishing-charge-hold') as HTMLButtonElement | null)?.disabled,
      'the charge control is permanently disabled because the port never re-subscribed',
    ).toBe(false);

    vi.doUnmock('@/renderers/pixi/fishing/FishingWorld');
    liveGate = null;
  });
});

describe('defect 2: every exit route clears the one flag both lanes share', () => {
  /** A flow over the two hosts, with the calls the assertions count. */
  function makeFlow(
    module: FlowModule,
    hosts: {
      readonly pixi: VillageFishingHost | null;
      readonly phaser: VillageFishingHost | null;
    },
    calls: { finished: number },
  ): ReturnType<FlowModule['createVillageStudyFlow']> {
    return module.createVillageStudyFlow({
      readPhaserHandle: () => (hosts.phaser === null ? null : { fishing: () => hosts.phaser as VillageFishingHost }),
      readPixiFishingHost: () => hosts.pixi,
      readDynamicStructures: () => [],
      readSubjects: () => [],
      setInfoPanel: () => {},
      setWelcomeMessage: () => {},
      setCreateOpen: () => {},
      setMakeItYoursOpen: () => {},
      setShowStats: () => {},
      setFishCaught: () => {},
      prepareFishingSession: () => {},
      finishFishingSession: () => {
        calls.finished += 1;
      },
    });
  }

  it("the flow's exit stops the Phaser world and tells the screen", async () => {
    const module = await import('@/ui/village/villageStudyFlow');
    const calls = { finished: 0, phaserReturn: 0 };
    const phaserHost: VillageFishingHost = {
      enter: () => {},
      // `createPhaserFishingRenderer` stops the scene and wakes the village inside a
      // `Phaser.Game` and reports **nothing** to the DOM. This stand-in is faithful to that.
      returnToVillage: () => {
        calls.phaserReturn += 1;
      },
    };
    const flow = makeFlow(module, { pixi: null, phaser: phaserHost }, calls);

    flow.exitFishing();

    expect(calls.phaserReturn, 'the Phaser scene was not told to stop').toBe(1);
    // **This** is the assertion that was missing: without it the screen's `data-world` stayed
    // `fishing` and its live region kept saying "You have started fishing" after the learner had
    // walked back - on the lane that ships by default.
    expect(
      calls.finished,
      'the rollback lane ended a session without telling the DOM, so data-world stayed fishing',
    ).toBe(1);
  });

  it('the flow prefers the Pixi host and still ends the session, so only one lane ever runs', async () => {
    const module = await import('@/ui/village/villageStudyFlow');
    const calls = { finished: 0, pixiReturn: 0, phaserReturn: 0 };
    const flow = makeFlow(
      module,
      {
        pixi: {
          enter: () => {},
          returnToVillage: () => {
            calls.pixiReturn += 1;
          },
        },
        phaser: {
          enter: () => {},
          returnToVillage: () => {
            calls.phaserReturn += 1;
          },
        },
      },
      calls,
    );

    flow.exitFishing();

    expect(calls.pixiReturn, 'the Pixi host was not told to stop').toBe(1);
    expect(calls.phaserReturn, 'the Phaser host was also told to stop, so both lanes ran').toBe(0);
    expect(calls.finished).toBe(1);
  });

  it('`active` and the catch surfaces clear together, from the screen-level door', async () => {
    const lane = await loadLane(true);
    const hook = await loadHook();
    const box: Box<UseVillageFishing> = { current: null };
    function Probe(): JSX.Element {
      box.current = hook.useVillageFishing(() => {}, true);
      return (
        <lane.PixiFishingLaneSurface
          lane={read(box, 'the fishing surface').lane}
          renderControls={() => <div data-testid="controls" />}
        />
      );
    }
    render(<Probe />);

    expect(read(box, 'the fishing surface').active, 'a session was open before anything was entered').toBe(
      false,
    );

    // Door one: the flow's `prepareFishingSession`, which runs only after its mount guard.
    act(() => {
      read(box, 'the fishing surface').prepareSession();
    });
    expect(read(box, 'the fishing surface').active, 'starting a session published no signal').toBe(
      true,
    );

    // A catch the learner never decided about, which a closing pond must not strand.
    act(() => {
      read(box, 'the fishing surface').onFishCaught({
        fishName: 'Moss Carp',
        rarity: 'common',
        catalogId: 'moss-carp',
        description: 'A slow, patient fish.',
      });
    });
    expect(read(box, 'the fishing surface').catch, 'the catch was never offered').not.toBeNull();

    // Door two: the screen-level end, which is what the flow's `fishing/exit` calls.
    act(() => {
      read(box, 'the fishing surface').endSession();
    });
    expect(
      read(box, 'the fishing surface').active,
      'ending a session left the screen claiming it was still fishing',
    ).toBe(false);
    expect(read(box, 'the fishing surface').catch, 'a catch outlived the session that caught it').toBeNull();
  });

  it("the Pixi lane's own teardown routes through the same clear", async () => {
    await loadLane(true);
    const hook = await loadHook();
    const box: Box<UseVillageFishing> = { current: null };
    function Probe(): null {
      box.current = hook.useVillageFishing(() => {}, true);
      return null;
    }
    render(<Probe />);

    act(() => {
      read(box, 'the fishing surface').prepareSession();
      (
        read(box, 'the fishing surface').lane.readHost() as VillageFishingHost
      ).enter(MODEL, handlers(POND_ID));
    });
    expect(read(box, 'the fishing surface').active).toBe(true);
    expect(read(box, 'the fishing surface').lane.session).not.toBeNull();

    // The renderer asking to return, which is what `PixiFishingLaneSurface` wires the world's
    // own return control to.
    act(() => {
      read(box, 'the fishing surface').lane.exit();
    });

    expect(read(box, 'the fishing surface').lane.session).toBeNull();
    expect(
      read(box, 'the fishing surface').active,
      'the Pixi lane cleared its own session but left the screen announcing a pond',
    ).toBe(false);
  });
});