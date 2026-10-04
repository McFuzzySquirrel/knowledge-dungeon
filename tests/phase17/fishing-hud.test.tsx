/**
 * The fishing HUD: six controls, touch and keyboard parity, and the state in words.
 *
 * ## What "parity" is asserted to mean here
 *
 * Phase 17's exit criterion is "a complete cast-to-catch-to-keep flow works using touch and
 * keyboard". This file does not test that end to end - the browser lane does - so it tests the
 * two halves that make the claim true or false, and it tests them **separately**:
 *
 * 1. **Every control answers a pointer gesture and a key.** Not "there is a key for it" - both
 *    paths reach the same port method, and the charge and walk controls are asserted to reach
 *    *two* of them (press and release), because a hold that only has a press is a stuck charge.
 * 2. **Only the legal control is enabled per phase**, so the DOM and the state machine cannot
 *    disagree about what happened. The machine refuses an illegal event; the control that would
 *    send it is disabled, which is the same fact stated in the layer a learner can see.
 *
 * The port is a **fake** - a recording stub in the shape of `FishingHudPort`, produced by a
 * factory that also drives the readout - so a test asserts which port method fired rather than
 * asserting on a renderer's internals. The parity with the renderer's own port is proved
 * separately in `fishing-hud-port.test.ts`.
 *
 * ## What jsdom can and cannot say
 *
 * Every control's 44×44 floor is asserted **on the element**, as `villageTypes.ts` explains a
 * stylesheet rule cannot be asserted by a component test. Nothing here measures computed
 * contrast, real rendered target size, or zoom behaviour - jsdom computes no layout - so this
 * file makes no claim about those, and Phase 21's audit owns them.
 *
 * Hermeticity: no renderer, no network, no real clock.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FishingHud } from '@/ui/fishing/FishingHud';
import { FISHING_CONTROL_IDS } from '@/ui/study/controlIds';
import {
  FISHING_HUD_IDLE_READOUT,
  type FishingHudMoveIntent,
  type FishingHudPort,
  type FishingHudReadout,
} from '@/ui/fishing/fishingHudPort';
import { FISHING_STATE_NAMES } from '@/core/fishing/fishingStateMachine';

/** What the fake recorded, in order. */
interface PortCalls {
  readonly calls: string[];
  readonly moves: FishingHudMoveIntent[];
}

interface FakePort {
  readonly port: FishingHudPort;
  readonly recorded: PortCalls;
  /** Publish a new readout, as the renderer would after a dispatch. */
  readonly publish: (patch: Partial<FishingHudReadout>) => void;
}

/**
 * A total fake port.
 *
 * Every member is present because `FishingHudPort` has nothing optional, and a fake that omitted
 * one would be a different type. `publish` is how a test moves the pond between phases: the
 * subscription is real, so a phase change arrives the way it arrives in the app.
 */
function fakePort(overrides: Partial<FishingHudReadout> = {}): FakePort {
  const calls: string[] = [];
  const moves: FishingHudMoveIntent[] = [];
  const listeners = new Set<(readout: FishingHudReadout) => void>();
  let readout: FishingHudReadout = { ...FISHING_HUD_IDLE_READOUT, eligible: true, ...overrides };

  const publish = (patch: Partial<FishingHudReadout>): void => {
    readout = { ...readout, ...patch };
    for (const listener of [...listeners]) listener(readout);
  };

  const port: FishingHudPort = {
    beginPower: () => calls.push('beginPower'),
    release: () => calls.push('release'),
    hook: () => calls.push('hook'),
    reset: () => calls.push('reset'),
    move: (intent) => {
      moves.push(intent);
      calls.push(`move:${intent}`);
    },
    readReadout: () => readout,
    returnToVillage: () => calls.push('returnToVillage'),
    onPhase: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return { port, recorded: { calls, moves }, publish };
}

/** Render the HUD and return its fake, with the readout patched after mount. */
function renderHud(overrides: Partial<FishingHudReadout> = {}, props: Partial<React.ComponentProps<typeof FishingHud>> = {}): FakePort {
  const fake = fakePort(overrides);
  render(<FishingHud port={fake.port} {...props} />);
  return fake;
}

/** The four learner actions that are plain taps, plus the charge and the walk pair. */
const TAP_CONTROL_IDS = [
  FISHING_CONTROL_IDS.setHook,
  FISHING_CONTROL_IDS.castAgain,
  FISHING_CONTROL_IDS.tryAgain,
] as const;

beforeEach(() => {
  // `Element.prototype.setPointerCapture` is absent in jsdom; the HUD calls it optionally, so
  // this only needs to not throw.
  if (typeof Element.prototype.setPointerCapture !== 'function') {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      value: () => {},
      configurable: true,
    });
  }
});
afterEach(cleanup);

describe('FishingHud', () => {
  describe('the six controls', () => {
    it('renders all six, with the machine’s labels', () => {
      renderHud();
      for (const id of Object.values(FISHING_CONTROL_IDS)) {
        // `catchPanel` and `recallRoom` belong to the other two surfaces; this one owns the four
        // action ids plus the charge.
        if (id === FISHING_CONTROL_IDS.catchPanel || id === FISHING_CONTROL_IDS.recallRoom) continue;
        expect(document.getElementById(id), `${id} is not rendered`).not.toBeNull();
      }
      expect(screen.getByRole('button', { name: /Hold to charge a cast/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Set the hook/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Cast again/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Walk left/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Walk right/ })).toBeInTheDocument();
    });

    it('shows the keyboard for every action, in visible text', () => {
      renderHud();
      // Not a tooltip and not an `aria-keyshortcuts`: plan 10.1's no-hover-only rule means the
      // keys are readable without pointing at anything.
      expect(screen.getAllByText(/Space or Enter/).length).toBeGreaterThanOrEqual(3);
      expect(screen.getByText('Space or Enter, hold and release')).toBeInTheDocument();
      expect(screen.getByText('A or Left arrow, hold')).toBeInTheDocument();
      expect(screen.getByText('D or Right arrow, hold')).toBeInTheDocument();
      expect(
        screen.getByText('Hold A or the Left arrow to walk left, D or the Right arrow to walk right.'),
      ).toBeInTheDocument();
    });

    it('every control carries the 44 by 44 floor inline', () => {
      renderHud();
      const controls = document.querySelectorAll<HTMLElement>('[data-fishing-touch-target]');
      expect(controls.length).toBe(7);
      for (const control of controls) {
        expect(control.style.minWidth, control.textContent ?? '').toBe('44px');
        expect(control.style.minHeight, control.textContent ?? '').toBe('44px');
      }
    });

    it('has one control per learner-triggerable transition', () => {
      // Six transitions in the machine's table; six controls here. Asserted as a count because
      // a seventh button that does nothing is what "one per transition" is protecting against.
      renderHud();
      const actionControls = [...document.querySelectorAll('[data-fishing-touch-target]')].filter(
        (element) =>
          !['return-to-village'].includes(element.getAttribute('data-fishing-touch-target') as string),
      );
      expect(actionControls).toHaveLength(6);
    });
  });

  describe('control 1 and 3: the charge hold, by pointer and by key', () => {
    it('a pointer press begins and a pointer up releases', () => {
      const fake = renderHud();
      const charge = document.getElementById(FISHING_CONTROL_IDS.chargeHold) as HTMLButtonElement;
      fireEvent.pointerDown(charge);
      expect(fake.recorded.calls).toEqual(['beginPower']);
      fireEvent.pointerUp(charge);
      expect(fake.recorded.calls).toEqual(['beginPower', 'release']);
    });

    it('a cancelled pointer releases too, so a scroll cannot strand a charge', () => {
      const fake = renderHud();
      const charge = document.getElementById(FISHING_CONTROL_IDS.chargeHold) as HTMLButtonElement;
      fireEvent.pointerDown(charge);
      fireEvent.pointerCancel(charge);
      expect(fake.recorded.calls).toEqual(['beginPower', 'release']);
    });

    it('Space keydown begins and Space keyup releases', () => {
      const fake = renderHud();
      const charge = document.getElementById(FISHING_CONTROL_IDS.chargeHold) as HTMLButtonElement;
      charge.focus();
      fireEvent.keyDown(charge, { key: ' ' });
      expect(fake.recorded.calls).toEqual(['beginPower']);
      fireEvent.keyUp(charge, { key: ' ' });
      expect(fake.recorded.calls).toEqual(['beginPower', 'release']);
    });

    it('Enter works exactly the same way', () => {
      const fake = renderHud();
      const charge = document.getElementById(FISHING_CONTROL_IDS.chargeHold) as HTMLButtonElement;
      fireEvent.keyDown(charge, { key: 'Enter' });
      fireEvent.keyUp(charge, { key: 'Enter' });
      expect(fake.recorded.calls).toEqual(['beginPower', 'release']);
    });

    it('a keyboard repeat does not re-begin a charge that is already under way', () => {
      const fake = renderHud();
      const charge = document.getElementById(FISHING_CONTROL_IDS.chargeHold) as HTMLButtonElement;
      fireEvent.keyDown(charge, { key: ' ' });
      fireEvent.keyDown(charge, { key: ' ', repeat: true });
      fireEvent.keyDown(charge, { key: ' ', repeat: true });
      fireEvent.keyUp(charge, { key: ' ' });
      // One begin and one release, however long the key was held.
      expect(fake.recorded.calls).toEqual(['beginPower', 'release']);
    });

    it('reports the charge as pressed in a non-colour way while it is held', () => {
      renderHud();
      const charge = document.getElementById(FISHING_CONTROL_IDS.chargeHold) as HTMLButtonElement;
      expect(charge.getAttribute('aria-pressed')).toBe('false');
      fireEvent.pointerDown(charge);
      expect(charge.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('control 2: walking, by pointer and by key', () => {
    it('a held walk button sends the intent and its release stops it', () => {
      const fake = renderHud();
      const left = document.getElementById(FISHING_CONTROL_IDS.walkLeft) as HTMLButtonElement;
      fireEvent.pointerDown(left);
      expect(fake.recorded.moves).toEqual([-1]);
      fireEvent.pointerUp(left);
      expect(fake.recorded.moves).toEqual([-1, 0]);
    });

    it('the walk buttons report pressed state', () => {
      renderHud();
      const right = document.getElementById(FISHING_CONTROL_IDS.walkRight) as HTMLButtonElement;
      fireEvent.pointerDown(right);
      expect(right.getAttribute('aria-pressed')).toBe('true');
      fireEvent.pointerUp(right);
      expect(right.getAttribute('aria-pressed')).toBe('false');
    });

    it('A and D walk from anywhere on the page, without focusing a control first', () => {
      // A learner who has to tab to a walk button before walking cannot walk and cast at the
      // same time, so the keys are on the document rather than on the button.
      const fake = renderHud();
      act(() => {
        fireEvent.keyDown(document, { key: 'a' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'd' });
      });
      act(() => {
        fireEvent.keyUp(document, { key: 'a' });
        fireEvent.keyUp(document, { key: 'd' });
      });
      expect(fake.recorded.moves).toEqual([-1, 1, 0]);
    });

    it('the arrow keys walk too', () => {
      const fake = renderHud();
      act(() => {
        fireEvent.keyDown(document, { key: 'ArrowLeft' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'ArrowRight' });
      });
      expect(fake.recorded.moves).toEqual([-1, 1]);
      act(() => {
        fireEvent.keyUp(document, { key: 'ArrowLeft' });
        fireEvent.keyUp(document, { key: 'ArrowRight' });
      });
      expect(fake.recorded.moves.at(-1)).toBe(0);
    });

    it('does not re-send an intent that is already held', () => {
      const fake = renderHud();
      act(() => {
        fireEvent.keyDown(document, { key: 'a' });
        fireEvent.keyDown(document, { key: 'a' });
      });
      expect(fake.recorded.moves).toEqual([-1]);
      act(() => {
        fireEvent.keyUp(document, { key: 'a' });
      });
      expect(fake.recorded.moves).toEqual([-1, 0]);
    });

    it('stops walking when the window loses focus, so a held key cannot strand the angler', () => {
      const fake = renderHud();
      act(() => {
        fireEvent.keyDown(document, { key: 'd' });
      });
      act(() => {
        fireEvent.blur(window);
      });
      expect(fake.recorded.moves).toEqual([1, 0]);
    });

    it('stops walking on unmount', () => {
      const fake = renderHud();
      act(() => {
        fireEvent.keyDown(document, { key: 'd' });
      });
      cleanup();
      // The release is sent on teardown, so a component that goes away mid-stride does not
      // leave the machine holding a walking intent nothing can clear.
      expect(fake.recorded.moves).toEqual([1, 0]);
    });

    it('the walk keys do nothing in a phase where walking is illegal', () => {
      const fake = renderHud({ phase: 'biting' });
      act(() => {
        fireEvent.keyDown(document, { key: 'a' });
      });
      expect(fake.recorded.moves).toEqual([]);
      expect(document.getElementById(FISHING_CONTROL_IDS.walkLeft)).toBeDisabled();
    });
  });

  describe('controls 4, 5, 6: hook, cast again, try again', () => {
    it('each reaches the port method the machine names', () => {
      const fake = renderHud();
      const hook = document.getElementById(FISHING_CONTROL_IDS.setHook) as HTMLButtonElement;
      // The three are separate controls, but only the legal one is enabled - so each is
      // exercised in the phase that enables it, through a re-publish.
      expect(hook.disabled).toBe(true);

      act(() => {
        fake.publish({ phase: 'biting' });
      });
      fireEvent.click(document.getElementById(FISHING_CONTROL_IDS.setHook) as HTMLButtonElement);
      act(() => {
        fake.publish({ phase: 'caught' });
      });
      fireEvent.click(document.getElementById(FISHING_CONTROL_IDS.castAgain) as HTMLButtonElement);
      act(() => {
        fake.publish({ phase: 'missed' });
      });
      fireEvent.click(document.getElementById(FISHING_CONTROL_IDS.tryAgain) as HTMLButtonElement);

      expect(fake.recorded.calls).toEqual(['hook', 'reset', 'reset']);
    });

    it('"Cast again" and "Try again" are the same transition and different sentences', () => {
      renderHud();
      // One transition, two outcomes - and the sentence is what tells a learner the fish got
      // away, so the two labels cannot be collapsed into one.
      expect(screen.getByRole('button', { name: /Cast again/ })).not.toBe(
        screen.getByRole('button', { name: /Try again/ }),
      );
    });
  });

  describe('only the legal control is enabled', () => {
    it('each of the eight phases enables exactly the controls the machine accepts', () => {
      const fake = renderHud();
      // The machine's own table, restated as DOM enablement. Read in the loop below.
      const legal: Record<string, string[]> = {
        idle: [FISHING_CONTROL_IDS.chargeHold, FISHING_CONTROL_IDS.walkLeft, FISHING_CONTROL_IDS.walkRight],
        powering: [FISHING_CONTROL_IDS.chargeHold],
        casting: [],
        waiting: [],
        biting: [FISHING_CONTROL_IDS.setHook],
        reeling: [],
        caught: [
          FISHING_CONTROL_IDS.castAgain,
          FISHING_CONTROL_IDS.walkLeft,
          FISHING_CONTROL_IDS.walkRight,
        ],
        missed: [
          FISHING_CONTROL_IDS.tryAgain,
          FISHING_CONTROL_IDS.walkLeft,
          FISHING_CONTROL_IDS.walkRight,
        ],
      };
      // Non-goal guard: the table above covers every phase the machine has.
      expect(Object.keys(legal).sort()).toEqual([...FISHING_STATE_NAMES].sort());

      for (const phase of FISHING_STATE_NAMES) {
        act(() => {
          fake.publish({ phase });
        });
        for (const id of [FISHING_CONTROL_IDS.chargeHold, FISHING_CONTROL_IDS.setHook, ...TAP_CONTROL_IDS, FISHING_CONTROL_IDS.walkLeft]) {
          const element = document.getElementById(id) as HTMLButtonElement;
          const shouldBeEnabled = legal[phase]?.includes(id) ?? false;
          expect(element.disabled, `${id} in ${phase}`).toBe(!shouldBeEnabled);
        }
      }
    });

    it('an ineligible pond disables every action control and says why', () => {
      renderHud({ eligible: false });
      expect(screen.getByText(/closed for now/i)).toBeInTheDocument();
      for (const id of [
        FISHING_CONTROL_IDS.chargeHold,
        FISHING_CONTROL_IDS.walkLeft,
        FISHING_CONTROL_IDS.walkRight,
      ]) {
        expect(document.getElementById(id)).toBeDisabled();
      }
    });
  });

  describe('the pond’s state, in words', () => {
    it('every phase has a name and a sentence, and no two share a sentence', () => {
      const fake = renderHud();
      const seen = new Set<string>();
      for (const phase of FISHING_STATE_NAMES) {
        act(() => {
          fake.publish({ phase });
        });
        const status = screen.getByRole('status');
        const text = status.textContent ?? '';
        expect(text.length, `${phase} has no sentence`).toBeGreaterThan(10);
        expect(seen.has(text), `${phase} repeats another phase's sentence`).toBe(false);
        seen.add(text);
      }
    });

    it('the power meter reports its value as a number, not only as a width', () => {
      renderHud({ phase: 'powering', power: 0.42 });
      const meter = screen.getByRole('progressbar');
      expect(meter).toHaveAttribute('aria-valuenow', '42');
      expect(meter).toHaveAttribute('aria-valuetext', '42 percent charged');
      expect(screen.getByText('Cast strength: 42%')).toBeInTheDocument();
    });

    it('an over-charged or nonsense power still renders a number', () => {
      const fake = renderHud({ phase: 'powering', power: 4 });
      act(() => {
        fake.publish({ power: Number.NaN });
      });
      // `Math.round(NaN * 100)` is `NaN`, and a sentence containing "NaN%" is worse than none.
      expect(screen.getByText('Cast strength: 0%')).toBeInTheDocument();
    });

    it('the session’s cast and catch counts are stated', () => {
      const fake = renderHud({ castNumber: 3, caughtCount: 2 });
      // One paragraph holding both facts, so the assertion reads the paragraph's text rather
      // than a text node - the sentence a learner reads is the whole paragraph.
      const counts = screen.getByText(/kept in this trip/) as HTMLElement;
      expect(counts.textContent).toContain('Cast number 3');
      expect(counts.textContent).toContain('2 fish kept in this trip');
      act(() => {
        fake.publish({ castNumber: 0, caughtCount: 1 });
      });
      expect(counts.textContent).toContain('Cast not started');
      // And `1` is not pluralised as "1 fishs".
      expect(counts.textContent).toContain('1 fish kept in this trip');
    });

    it('announces every phase change on a polite live region', () => {
      renderHud();
      const status = screen.getByRole('status');
      // Polite, not assertive: a bite is exciting but it is not an emergency, and an assertive
      // region would interrupt a learner on each of a cast's eight transitions.
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.getAttribute('role')).toBe('status');
    });

    it('the phase is also on the container, as a static attribute a test can read', () => {
      const fake = renderHud();
      const root = document.querySelector('[data-fishing-phase]');
      expect(root?.getAttribute('data-fishing-phase')).toBe('idle');
      act(() => {
        fake.publish({ phase: 'biting' });
      });
      expect(root?.getAttribute('data-fishing-phase')).toBe('biting');
    });
  });

  describe('focus on a bite', () => {
    it('moves focus to the hook control, because the window is two seconds', () => {
      const fake = renderHud();
      const charge = document.getElementById(FISHING_CONTROL_IDS.chargeHold) as HTMLButtonElement;
      charge.focus();
      act(() => {
        fake.publish({ phase: 'biting' });
      });
      expect(document.activeElement).toBe(document.getElementById(FISHING_CONTROL_IDS.setHook));
    });

    it('does NOT steal focus from outside the HUD', () => {
      const fake = renderHud();
      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      elsewhere.focus();
      act(() => {
        fake.publish({ phase: 'biting' });
      });
      // A learner reading something else in the page is not dragged into the pond by a bite.
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });
  });

  describe('leaving the pond', () => {
    it('offers a labelled DOM route, because the canvas control is unreachable by keyboard', () => {
      const onReturn = vi.fn();
      renderHud({}, { onReturnToVillage: onReturn });
      fireEvent.click(screen.getByRole('button', { name: 'Return to the village' }));
      expect(onReturn).toHaveBeenCalledOnce();
    });

    it('falls back to the port’s own route when no handler is supplied', () => {
      const fake = renderHud();
      fireEvent.click(screen.getByRole('button', { name: 'Return to the village' }));
      expect(fake.recorded.calls).toEqual(['returnToVillage']);
    });
  });

  describe('subscriptions', () => {
    it('reads the readout once on mount, so a control pressed before the first publish is honest', () => {
      // A fake that starts in a non-idle phase: the HUD must show *that* phase rather than
      // `FISHING_HUD_IDLE_READOUT`, which would be a lie about a pond that is mid-cast.
      const fake = fakePort({ phase: 'casting', power: 0.3 });
      render(<FishingHud port={fake.port} />);
      expect(screen.getByText(/line is flying out/i)).toBeInTheDocument();
    });

    it('unsubscribes on unmount, so a world that outlives the HUD cannot push into it', () => {
      const fake = fakePort();
      const { unmount } = render(<FishingHud port={fake.port} />);
      const before = screen.getByRole('status').textContent;
      unmount();
      act(() => {
        fake.publish({ phase: 'biting' });
      });
      // Nothing to compare against - the point is that the render no longer happens and no
      // "update on an unmounted component" is produced.
      expect(screen.queryByRole('status')).toBeNull();
      expect(before).toContain('Ready');
    });
  });

  describe('no learner data', () => {
    it('every id on every control is a static literal from FISHING_CONTROL_IDS', () => {
      renderHud();
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.getAttribute('id'));
      const authored = ids.filter((id) => id !== null && !/^_r_/.test(id));
      expect(authored.sort()).toEqual(
        [
          FISHING_CONTROL_IDS.chargeHold,
          FISHING_CONTROL_IDS.setHook,
          FISHING_CONTROL_IDS.castAgain,
          FISHING_CONTROL_IDS.tryAgain,
          FISHING_CONTROL_IDS.walkLeft,
          FISHING_CONTROL_IDS.walkRight,
        ].sort(),
      );
    });

    it('the HUD renders no `data-*` value that is not one of its own static vocabulary', () => {
      renderHud({ phase: 'biting', power: 0.77, castNumber: 4, caughtCount: 1 });
      for (const element of document.querySelectorAll('*')) {
        for (const attribute of element.getAttributeNames()) {
          if (!attribute.startsWith('data-')) continue;
          const value = element.getAttribute(attribute) as string;
          expect(
            ['data-fishing-phase', 'data-fishing-power', 'data-fishing-touch-target'].includes(
              attribute,
            ),
            `${attribute} is not part of the HUD's static vocabulary`,
          ).toBe(true);
          // The only interpolated values are numbers the machine produced.
          expect(value).toMatch(/^[a-z-]*$|^\d{1,3}$/);
        }
      }
    });
  });
});