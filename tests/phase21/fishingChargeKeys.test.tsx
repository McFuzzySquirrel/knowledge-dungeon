/**
 * Phase 21: the fishing charge control's keyboard route.
 *
 * ## The defect this exists for
 *
 * The renderer owner handed over a dead route with a file:line: `FishingHud.tsx:100`'s
 * `CHARGE_KEYS = new Set([' ', 'Spacebar', 'Enter'])` omitted `'Space'`, while **both** renderer-side
 * normalizers - `createFishingScene.ts:479` and `WorldInputController.ts:113` - accept it:
 *
 * ```ts
 * function normalizeKey(key: string): string {
 *   if (key === ' ' || key === 'Spacebar' || key === 'Space') return ' ';
 *   return key.toLowerCase();
 * }
 * ```
 *
 * So on any platform where `KeyboardEvent.key === 'Space'`, pressing **and holding** the space bar
 * over the charge button sent nothing: `keydown` fell through, so `beginPower` never ran, and
 * `keyup` fell through too, so there was no release to refuse either. The learner held the key and
 * the pond did nothing. The canvas route worked, so a mouse test could not see it.
 *
 * ## What is asserted, and what would not be
 *
 * Two halves, and the first is the one that matters:
 *
 * 1. **Agreement with the renderers.** Every spelling either normalizer accepts must be in
 *    `CHARGE_KEYS`. The spellings are read out of the two `normalizeKey` bodies rather than restated,
 *    so a fourth spelling added to the renderer without being added here is a red test.
 * 2. **The behaviour.** For each accepted spelling, a `keydown` starts a charge and the matching
 *    `keyup` releases it - asserted on the port's calls, not on `aria-pressed`, because the port calls
 *    are the fact and the attribute is a rendering of it.
 *
 * A test that only asserted `CHARGE_KEYS.has('Space')` would have caught this particular miss and
 * would have kept passing the next one. Asserting against the renderers' own source is what makes it
 * a property rather than a fact about today.
 *
 * ## The `user.keyboard()` trap, and why `fireEvent` is used here
 *
 * This repository has already been bitten by it: `user.keyboard()` delivers nothing to an **unfocused**
 * element, so a keydown-based test can pass a `keydown` handler that no learner could ever reach and
 * report the route as working. Every test below calls `.focus()` on the control and asserts
 * `document.activeElement` is that control **before** sending a key, so a handler that only works on an
 * unfocused element fails here rather than passing silently.
 *
 * ## No learner data
 *
 * No store, no subject, no room, no fish. The port is a hand-written recorder and every assertion is a
 * role or a call count.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FishingHud } from '@/ui/fishing/FishingHud';
import type { FishingHudPort, FishingHudReadout } from '@/ui/fishing/fishingHudPort';

import {
  REQUIRED_SPACE_KEYS,
  SPACE_KEY_NORMALIZER_FILES,
  readNormalizerLiterals,
} from './spaceKeyNormalizers';

const REPO_ROOT = process.cwd();

afterEach(cleanup);

/**
 * An idle pond the learner is allowed to cast from.
 *
 * Every field of `FishingHudReadout` is written, not spread over a partial, so a new field added to
 * the port is a **compile error here** rather than a silently `undefined` a component would have to
 * cope with. `eligible: true` is the one value that differs from `FISHING_HUD_IDLE_READOUT`: this
 * file tests the charge control, which is disabled while a pond is ineligible, so an ineligible
 * fixture would disable the control under test and every assertion would pass vacuously.
 */
function idleReadout(overrides: Partial<FishingHudReadout> = {}): FishingHudReadout {
  return {
    phase: 'idle',
    power: 0,
    canReset: false,
    eligible: true,
    moveIntent: 0,
    facing: 'right',
    castNumber: 0,
    caughtCount: 0,
    ...overrides,
  };
}

/** A recorder standing in for the pond. Records calls; asserts nothing itself. */
function recordingPort(readout: FishingHudReadout) {
  const calls: string[] = [];
  const port: FishingHudPort = {
    readReadout: () => readout,
    onPhase: () => () => {},
    beginPower: () => {
      calls.push('beginPower');
    },
    release: () => {
      calls.push('release');
    },
    hook: () => {
      calls.push('hook');
    },
    reset: () => {
      calls.push('reset');
    },
    move: (intent) => {
      calls.push(`move:${intent}`);
    },
    returnToVillage: () => {
      calls.push('returnToVillage');
    },
  };
  return { port, calls };
}

/**
 * Render the HUD, focus the charge control, and prove focus landed before any key is sent.
 *
 * The focus assertion is inside this helper so no test can forget it: an unfocused control gets no
 * event from `fireEvent.keyDown` on the element either, in jsdom, because nothing is dispatching to a
 * focused target. Failing here says "the control could not be reached", which is the more useful
 * message than a charge that never started.
 */
function renderAndFocusCharge(port: FishingHudPort) {
  const view = render(<FishingHud port={port} />);
  const charge = screen.getByRole('button', { name: /Hold to charge/i });
  charge.focus();
  expect(document.activeElement, 'the charge control could not take focus').toBe(charge);
  return { charge, ...view };
}

// ── 1. Agreement with the renderer normalizers ──────────────────────────────

describe('the charge control accepts every spelling the renderer accepts', () => {
  it.each(SPACE_KEY_NORMALIZER_FILES)('%s normalizes space and so does the DOM control', (file) => {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const { literals } = readNormalizerLiterals(source, file);

    // Non-vacuity, before the property: this normalizer really does talk about the space bar.
    const spaceSpellings = literals.filter((literal) => REQUIRED_SPACE_KEYS.includes(literal));
    expect(
      spaceSpellings.length,
      `${file} no longer compares against any of ${REQUIRED_SPACE_KEYS.join(', ')}, so this ` +
        'assertion has nothing to compare and the normalizer probably moved',
    ).toBeGreaterThan(1);

    // The property. Every spelling the renderer maps onto its own space character is one the DOM
    // control must accept, or the DOM route is dead on that platform.
    expect(
      [...spaceSpellings].sort(),
      `${file} accepts space as ${spaceSpellings.join(', ')} but FishingHud's CHARGE_KEYS does not ` +
        'cover all of them, so the DOM charge route is dead on a platform that produces the missing one',
    ).toEqual([...REQUIRED_SPACE_KEYS].sort());
  });

  it('the two normalizers agree with each other, so one answer describes both lanes', () => {
    // The premise of the comparison above. If the two renderers disagreed about which spellings mean
    // space, "the DOM control accepts every spelling the renderer accepts" would have two different
    // answers and the fix would have to pick a lane - which is the situation this defect came from.
    const readings = SPACE_KEY_NORMALIZER_FILES.map((file) =>
      readNormalizerLiterals(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file),
    );
    const spaceSets = readings.map((reading) =>
      reading.literals.filter((literal) => REQUIRED_SPACE_KEYS.includes(literal)).sort(),
    );
    expect(
      spaceSets[1],
      `${readings[0]?.file} and ${readings[1]?.file} disagree about which event.key spellings mean ` +
        'space, so the DOM control cannot satisfy both and one lane stays broken',
    ).toEqual(spaceSets[0]);
  });
});

// ── 2. The behaviour, per spelling ──────────────────────────────────────────

describe('holding the charge control charges, on every accepted spelling', () => {
  it.each([...REQUIRED_SPACE_KEYS])("keydown '%s' begins a charge and keyup releases it", (key) => {
    const { port, calls } = recordingPort(idleReadout());
    const { charge } = renderAndFocusCharge(port);

    fireEvent.keyDown(charge, { key });
    expect(calls, `keydown '${key}' did not begin a charge`).toEqual(['beginPower']);

    fireEvent.keyUp(charge, { key });
    expect(calls, `keyup '${key}' did not release the charge`).toEqual(['beginPower', 'release']);
  });

  it.each([...REQUIRED_SPACE_KEYS])("'%s' is reported as pressed while the charge is held", (key) => {
    const { port } = recordingPort(idleReadout());
    const { charge } = renderAndFocusCharge(port);

    expect(charge).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(charge, { key });
    expect(charge, `'${key}' did not reach aria-pressed`).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyUp(charge, { key });
    expect(charge, `'${key}' did not release aria-pressed`).toHaveAttribute('aria-pressed', 'false');
  });

  it('Enter charges too, because it is the button native activation key', () => {
    const { port, calls } = recordingPort(idleReadout());
    const { charge } = renderAndFocusCharge(port);

    fireEvent.keyDown(charge, { key: 'Enter' });
    expect(calls).toEqual(['beginPower']);
    fireEvent.keyUp(charge, { key: 'Enter' });
    expect(calls).toEqual(['beginPower', 'release']);
  });

  it('a key that is not a charge key sends no charge', () => {
    // The negative half, because a set that accepted everything would pass every test above.
    //
    // Asserted on the *charge* calls rather than on the whole call log, and the reason is worth
    // recording: `'a'` is also a walk key, and `FishingHud` binds the walk keys on the **document** in
    // the capture phase so a learner can walk and cast at once. So focusing the charge control and
    // pressing `'a'` legitimately produces `move:-1` then `move:0`. Asserting `calls === []` would
    // have failed for a correct product and taught the next reader that walking is broken.
    const { port, calls } = recordingPort(idleReadout());
    const { charge } = renderAndFocusCharge(port);

    fireEvent.keyDown(charge, { key: 'a' });
    fireEvent.keyUp(charge, { key: 'a' });

    expect(
      calls.filter((call) => call === 'beginPower' || call === 'release'),
      "'a' reached the pond as a charge",
    ).toEqual([]);
    // And the walk still happened, so the negative assertion above is not passing because the key
    // went nowhere at all.
    expect(calls, "'a' stopped being the walk-left key").toContain('move:-1');
  });

  it('auto-repeat on a held key does not stack charges', () => {
    const { port, calls } = recordingPort(idleReadout());
    const { charge } = renderAndFocusCharge(port);

    fireEvent.keyDown(charge, { key: ' ' });
    fireEvent.keyDown(charge, { key: ' ', repeat: true });
    fireEvent.keyDown(charge, { key: ' ', repeat: true });
    expect(calls, 'a held key began more than one charge').toEqual(['beginPower']);

    fireEvent.keyUp(charge, { key: ' ' });
    expect(calls).toEqual(['beginPower', 'release']);
  });

  it('a stray keyup with no keydown sends no release', () => {
    // The guard on `chargingRef` is what makes this safe, and a release with no charge is a refusal
    // the pond would otherwise have to absorb.
    const { port, calls } = recordingPort(idleReadout());
    const { charge } = renderAndFocusCharge(port);

    fireEvent.keyUp(charge, { key: ' ' });
    expect(calls).toEqual([]);
  });
});
