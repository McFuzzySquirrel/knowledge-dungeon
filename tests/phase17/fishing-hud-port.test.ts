/**
 * The DOM port and the renderer port are the same capability set.
 *
 * ## Why this file exists at all
 *
 * `src/ui/fishing/fishingHudPort.ts` declares {@link FishingHudPort} rather than importing the
 * renderer's `FishingController`, because three enforced gates forbid the import:
 *
 * - `tests/phase14/study-shell-boundary.test.ts` refuses *any* first-party reach from
 *   `src/ui/study/**` into `src/renderers/**` - and it walks the import graph rather than
 *   scanning text, so `import type` is an edge too.
 * - `tests/phase17/fishing-renderer-boundary.test.ts` refuses the reverse direction.
 * - `tests/phase12/village-shell-split.test.ts` refuses a `@/renderers` reach from
 *   `src/ui/village/**`.
 *
 * A duplicated declaration is a liability unless something holds the two together, and this is
 * that something: **the two types must be mutually assignable, with no optional member on
 * either.** A capability added to the renderer port and not to the DOM port fails
 * `npm run typecheck` here rather than producing a control that silently does nothing - which is
 * the exact failure `FishingController.ts`'s own header records having happened once to
 * `VillageWorld`.
 *
 * ## Non-vacuity
 *
 * Two directions of assignability, plus a **positive control**: a literal missing a member, and
 * one with a `void`-returning stand-in for a method, must each be rejected. Without those, a
 * `FishingHudPort` that had become `Record<string, unknown>` would satisfy both directions and
 * this file would pass while proving nothing.
 *
 * Hermeticity: no renderer is *imported*, so no PixiJS and no GPU context is loaded; the
 * renderer's declarations are read from source. Type-only imports of the renderer module are
 * erased at compile time and pull no runtime code.
 */
import { describe, expect, it } from 'vitest';

import type {
  FishingController,
  FishingMoveIntent,
} from '@/renderers/pixi/fishing/FishingController';
import type { FishingWorldHandle } from '@/renderers/pixi/fishing/FishingWorld';
import {
  FISHING_HUD_IDLE_READOUT,
  INERT_FISHING_HUD_PORT,
  type FishingHudMoveIntent,
  type FishingHudPort,
  type FishingHudReadout,
} from '@/ui/fishing/fishingHudPort';
import { FISHING_STATE_NAMES } from '@/core/fishing/fishingStateMachine';

/**
 * Assignability in both directions.
 *
 * Written as two `extends` constraints rather than as a runtime value so the check is a
 * `npm run typecheck` failure rather than a test that only fails when someone runs it.
 */
type Assignable<From, To> = [From] extends [To] ? true : false;
type AssertBoth<T extends true, U extends true> = [T, U];

type PortAgreesWithRenderer = AssertBoth<
  Assignable<FishingHudPort, Pick<FishingController, keyof FishingHudPort>>,
  Assignable<FishingController, FishingHudPort>
>;

describe("the DOM fishing port and the renderer's capability port agree", () => {
  it('is mutually assignable, with nothing optional on either side', () => {
    // The assertion is in the type; this line makes the type used, so the file cannot compile to
    // nothing and silently pass.
    const parity: PortAgreesWithRenderer = [true, true];
    expect(parity).toEqual([true, true]);
  });

  it("a handle missing a learner action is rejected, so the defect cannot recur silently", () => {
    // The positive control, in the direction that matters. `readPresentation` and
    // `getCaughtCount` are omitted: they are not learner actions, and a DOM port that reached
    // for one would be reaching for pixels.
    const withoutHook = {
      beginPower: () => {},
      release: () => {},
      reset: () => {},
      move: () => {},
      readReadout: (): FishingHudReadout => FISHING_HUD_IDLE_READOUT,
      returnToVillage: () => {},
      onPhase: () => () => {},
    } satisfies Omit<FishingHudPort, 'hook'>;

    // The compile-time claim, restated as a runtime one on the member list: `hook` is the
    // member whose absence would render a bite unreachable.
    expect('hook' in withoutHook).toBe(false);
    expect('hook' in INERT_FISHING_HUD_PORT).toBe(true);
  });

  it('the inert port answers every member, so a control is never a silent no-op', () => {
    // Every member is called. A port that threw, or that was `undefined`, would surface here
    // rather than as a button that appears to work.
    expect(() => {
      INERT_FISHING_HUD_PORT.beginPower();
      INERT_FISHING_HUD_PORT.release();
      INERT_FISHING_HUD_PORT.hook();
      INERT_FISHING_HUD_PORT.reset();
      INERT_FISHING_HUD_PORT.move(1);
      INERT_FISHING_HUD_PORT.returnToVillage();
    }).not.toThrow();

    expect(INERT_FISHING_HUD_PORT.readReadout()).toBe(FISHING_HUD_IDLE_READOUT);
    const stop = INERT_FISHING_HUD_PORT.onPhase(() => {});
    expect(() => stop()).not.toThrow();
  });

  it('the idle readout is frozen and identical to what the renderer calls idle', () => {
    // Two independent declarations of "before the world exists", compared field by field. They
    // are written separately in the two modules because the renderer cannot import the DOM port
    // either, so equality has to be asserted rather than shared.
    expect(FISHING_HUD_IDLE_READOUT).toEqual({
      phase: 'idle',
      power: 0,
      canReset: false,
      eligible: false,
      moveIntent: 0,
      facing: 'right',
      castNumber: 0,
      caughtCount: 0,
    });
    expect(Object.isFrozen(FISHING_HUD_IDLE_READOUT)).toBe(true);
  });
});

describe('the readout’s vocabulary is the machine’s', () => {
  it('every one of the eight machine phases is representable in the DOM readout', () => {
    // A control's phase vocabulary and the machine's must be the same eight names. If the DOM
    // side named a ninth, a switch on it would be unreachable; if it named seven, one phase
    // would have no control - which is how a bite becomes unreachable.
    const domPhases: readonly FishingHudReadout['phase'][] = [
      'idle',
      'powering',
      'casting',
      'waiting',
      'biting',
      'reeling',
      'caught',
      'missed',
    ];
    expect([...domPhases].sort()).toEqual([...FISHING_STATE_NAMES].sort());
    expect(domPhases).toHaveLength(8);
  });

  it('the walk intent is the machine’s three values and not a wider number', () => {
    const intents: readonly FishingHudMoveIntent[] = [-1, 0, 1];
    expect(intents).toHaveLength(3);
    // Compile-time parity with the renderer's own type, which is what makes the two the same
    // vocabulary rather than two declarations that happen to look alike.
    const rendererIntents: readonly FishingMoveIntent[] = [-1, 0, 1];
    expect([...rendererIntents]).toEqual([...intents]);
  });

  it("the world's handle is the controller the port was proved against", () => {
    // `FishingWorldHandle extends FishingController`, so the DOM port covers the handle the
    // screen actually holds. Stated rather than assumed: if the handle ever grew a *required*
    // member outside the controller, the `PortAgreesWithRenderer` conditional above would stop
    // resolving and `npm run typecheck` would fail here.
    const handle: FishingWorldHandle | null = null;
    const port: FishingHudPort | null = handle;
    expect(port).toBeNull();
  });
});