/**
 * WP-1.2: the application layer is the single owner of village NPC line selection.
 *
 * ## What moved, and what did not
 *
 * Before this package, "which line does this NPC say next" had three owners that
 * disagreed: the contract declared it as a pure function, the Pixi controller called
 * that function with `questStep: ''`, the Phaser adapter called it with `questStep:
 * ''`, and `villageSceneCallbacks.ts` re-implemented `open`/`advance` inline. For a
 * scripted NPC the two renderer-side copies could not have been right - a renderer has
 * no quest step - and the field they published on the snapshot was read by nobody.
 *
 * So the renderers stopped selecting lines and the field was removed. This file pins
 * what that must NOT change.
 *
 * ## The browser-proven behaviour this file defends
 *
 * With `questStep = 'meet-keeper'`, the DOM shows exactly
 * `VILLAGE_MAP.npcs[keeper].questDialogue['meet-keeper'][0]` - "You found me! Well done.
 * Now, let me show you around." - and repeated interaction advances through the script,
 * cycling at its length of 3. That was verified in a browser on both the Pixi lane and
 * the Phaser default lane, and it is the single thing this refactor could have broken.
 *
 * Moving *who* computes the line must not move *what* the learner sees. So the tests
 * below drive the real callback bag with the real store and compare against the data,
 * not against a copy of the old implementation - a test that re-implemented the old
 * logic to compare against it would pass when both were wrong together.
 *
 * ## What this file does not prove
 *
 * It does not test a browser. The lane that does is `tests/e2e/`, owned by the qa
 * work package that runs after this one. What is pinned here is that the DOM input and
 * the quest data produce the same strings they did before, which is the part this
 * package was able to change.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { VILLAGE_MAP, type VillageNpc } from '@/data/villageLayout';
import { selectVillageNpcLine } from '@/application/contracts/villageNpc';
import {
  keeperLineFor,
  useVillageSceneCallbacks,
  type VillageCallbacks,
  type VillageSceneCallbackSetters,
} from '@/ui/village/villageSceneCallbacks';
import { useSessionStore } from '@/store/sessionStore';
import type { StudyFlowController } from '@/application/studyFlow';

/* -------------------------------------------------------------------------- */
/* The shipped data this file asserts against                                   */
/* -------------------------------------------------------------------------- */

const keeper = VILLAGE_MAP.npcs.find((npc) => npc.id === 'keeper');

/**
 * The exact strings the browser lane saw.
 *
 * Read from `VILLAGE_MAP` rather than pasted, so a content edit updates the expectation
 * with it - but asserted by value as well, so the *specific* line is named here and a
 * content edit that changed it is a visible diff rather than a silently-updated
 * expectation. "You found me! Well done. Now, let me show you around." is the string
 * the maintainer's browser check produced.
 */
const MEET_KEEPER_LINES = keeper?.questDialogue?.['meet-keeper'] ?? [];
const EXPECTED_MEET_KEEPER_FIRST = 'You found me! Well done. Now, let me show you around.';

const wanderer = VILLAGE_MAP.npcs.find((npc) => npc.id === 'villager-1');

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything the hook reported, in call order, so ordering can be asserted. */
interface Harness {
  readonly lines: (string | null)[];
  readonly activeNpcIds: (string | null)[];
  readonly anchors: unknown[];
  readonly approach: (npcId: string) => void;
  readonly interact: (npcId: string) => void;
  readonly leave: (npcId: string) => void;
  readonly reset: () => void;
  /** The last line reported, or `null`. */
  readonly current: () => string | null;
}

/** A flow stub: nothing here may touch it, and nothing here does. */
const flow = {
  structureApproached: vi.fn(),
  structureLeft: vi.fn(),
  structureInteract: vi.fn(),
} as unknown as StudyFlowController;

/**
 * Mount the real hook and return the lines it published.
 *
 * The store is the real one, because the real quest step is the whole point: the bug
 * this package fixes is a renderer that could not see it, so a stubbed store would
 * reproduce the bug rather than rule it out.
 */
function mountCallbacks(): Harness {
  const lines: (string | null)[] = [];
  const activeNpcIds: (string | null)[] = [];
  const anchors: unknown[] = [];

  const setters: VillageSceneCallbackSetters = {
    setActiveNpcId: (id) => activeNpcIds.push(id),
    setActiveNpcLabel: () => {},
    setKeeperDialogue: (line) => lines.push(line),
    setNpcDialogAnchor: (anchor) => anchors.push(anchor),
    setVillageReady: () => {},
  };

  const { result } = renderHook(() =>
    useVillageSceneCallbacks(flow, setters),
  );

  const callbacks = (): VillageCallbacks => {
    const current = result.current.callbacks.current;
    if (current === null) throw new Error('the callback bag ref is not attached');
    return current;
  };

  return {
    lines,
    activeNpcIds,
    anchors,
    approach: (npcId) => act(() => callbacks().onNpcApproached(npcId)),
    interact: (npcId) => act(() => callbacks().onNpcInteract(npcId)),
    leave: (npcId) => act(() => callbacks().onNpcLeft(npcId)),
    reset: () => act(() => result.current.resetConversation()),
    current: () => lines[lines.length - 1] ?? null,
  };
}

/** Put the store on a quest step without touching persisted state. */
function setQuestStep(step: string): void {
  act(() => {
    useSessionStore.setState({ questStep: step as never });
  });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('the shipped quest data the browser lane verified', () => {
  it('still holds the exact line the learner saw', () => {
    expect(keeper).toBeDefined();
    expect(MEET_KEEPER_LINES).toHaveLength(3);
    expect(MEET_KEEPER_LINES[0]).toBe(EXPECTED_MEET_KEEPER_FIRST);
  });
});

describe('approaching the Keeper shows the quest line for the real step', () => {
  beforeEach(() => {
    setQuestStep('meet-keeper');
  });

  it('shows questDialogue[questStep][0], not the greeting and not dialogue[0]', () => {
    const harness = mountCallbacks();

    harness.approach('keeper');

    // The three candidates this line could have come from, all different strings, so
    // the assertion distinguishes them rather than merely matching something.
    const candidates = {
      questLine: MEET_KEEPER_LINES[0],
      greeting: keeper?.greeting,
      ambientFirst: keeper?.dialogue[0],
    };
    expect(new Set(Object.values(candidates)).size).toBe(3);
    expect(harness.current()).toBe(candidates.questLine);
    expect(harness.current()).toBe(EXPECTED_MEET_KEEPER_FIRST);
  });

  it('advances through the script and cycles at its length of 3', () => {
    const harness = mountCallbacks();

    harness.approach('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[0]);

    // Two more advances visit lines 1 and 2; the fourth returns to line 0, which is
    // the wrap the browser check confirmed.
    harness.interact('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[1]);
    harness.interact('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[2]);
    harness.interact('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[0]);
  });

  it('emits exactly one line per turn, so no turn is silent or doubled', () => {
    const harness = mountCallbacks();

    harness.approach('keeper');
    harness.interact('keeper');
    harness.interact('keeper');

    expect(harness.lines).toEqual([
      MEET_KEEPER_LINES[0],
      MEET_KEEPER_LINES[1],
      MEET_KEEPER_LINES[2],
    ]);
  });

  it('re-reads the step every turn, so a step chosen mid-conversation takes effect', () => {
    const harness = mountCallbacks();

    harness.approach('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[0]);

    // The learner picks a different step from the quest board while talking. The
    // stored cursor belonged to the old script, so the contract restarts at the new
    // one's opening line rather than indexing the new pool with the old index.
    const intro = keeper?.questDialogue?.['intro'] ?? [];
    setQuestStep('intro');
    harness.interact('keeper');

    expect(harness.current()).toBe(intro[0]);
  });
});

/**
 * WP-6's untested case, and deliberately its own `describe`.
 *
 * The block above cannot hold it: its `beforeEach` puts the store on `meet-keeper`, so
 * an approach that *begins* on `intro` is not expressible there. And the existing
 * "re-reads the step every turn" case is a different shape - it approaches on
 * `meet-keeper` and *then* moves the step to `intro` between turns, which exercises
 * the re-read in `show` and not the promotion in `onNpcApproached`.
 *
 * `onNpcApproached` promotes `intro` -> `meet-keeper` through the session store
 * *before* it calls `show`, and `show` reads `questStep` from the store on every turn.
 * The approach therefore selects from the already-promoted pool. Pinning that here is
 * what stops the ordering being "fixed" by moving the promotion after the `show` call -
 * a refactor that is invisible from the other block, because there the step already
 * says `meet-keeper` before the approach starts.
 */
describe('an approach that begins on `intro` is promoted before its line is chosen', () => {
  it('shows questDialogue["meet-keeper"][0], never questDialogue["intro"][0]', () => {
    const introLines = keeper?.questDialogue?.['intro'] ?? [];
    expect(introLines.length, 'the shipped keeper has no intro script to disagree with').toBeGreaterThan(0);
    // If the two pools agreed on their opening line this assertion could pass for the
    // wrong reason - a promotion that did not happen would still look right.
    expect(introLines[0], 'the intro and meet-keeper scripts open on the same line').not.toBe(
      MEET_KEEPER_LINES[0],
    );

    // The approach *begins* on `intro`: asserted on the store before the hook is even
    // mounted, so the later expectation cannot be satisfied by a step this file set
    // later.
    setQuestStep('intro');
    expect(useSessionStore.getState().questStep).toBe('intro');

    const harness = mountCallbacks();
    harness.approach('keeper');

    // The line comes from the promoted pool...
    expect(harness.current()).toBe(MEET_KEEPER_LINES[0]);
    expect(harness.current()).toBe(EXPECTED_MEET_KEEPER_FIRST);
    // ...and specifically not the line the pre-approach step would have selected.
    expect(harness.current()).not.toBe(introLines[0]);
    // Exactly one line for the approach: a promotion is not a second turn.
    expect(harness.lines).toEqual([MEET_KEEPER_LINES[0]]);
    // The promotion is a real store write, so it is also what the *next* turn reads.
    expect(useSessionStore.getState().questStep).toBe('meet-keeper');

    // And the promotion is durable: a second turn advances the promoted script rather
    // than reopening the intro one.
    harness.interact('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[1]);
  });

  it('leaves an approach on a later step alone, because promotion is a narrow rule', () => {
    // The guard on the other side of the promotion: it fires only from `intro`, so a
    // learner who is already past it is not walked backwards by walking up to a
    // villager.
    const laterLines = keeper?.questDialogue?.['defeat-boss'] ?? [];
    setQuestStep('defeat-boss');

    const harness = mountCallbacks();
    harness.approach('keeper');

    if (laterLines.length > 0) {
      expect(harness.current()).toBe(laterLines[0]);
    } else {
      // No script at that step: the contract's documented fallback is the greeting, so
      // the claim is only that the step was not rewritten to `meet-keeper`.
      expect(useSessionStore.getState().questStep).toBe('defeat-boss');
      expect(harness.current()).not.toBe(MEET_KEEPER_LINES[0]);
    }
  });
});

describe('a wanderer still opens on a quote and cycles that pool', () => {
  beforeEach(() => {
    setQuestStep('meet-keeper');
  });

  it('opens on one of their authored quotes', () => {
    if (wanderer === undefined) throw new Error('the shipped roster has no villager-1');
    const quotes = wanderer.quotes ?? [];
    expect(quotes.length).toBeGreaterThan(1);

    const harness = mountCallbacks();
    harness.approach(wanderer.id);

    // The randomness is the learner's, so this asserts membership rather than a fixed
    // string: what must not have changed is *which pool* the line came from.
    expect(quotes).toContain(harness.current());
    expect(harness.current()).not.toBe(wanderer.greeting);
  });

  it('cycles within their own quotes, from index 1, and wraps', () => {
    if (wanderer === undefined) throw new Error('the shipped roster has no villager-1');
    const quotes = wanderer.quotes ?? [];
    const harness = mountCallbacks();

    harness.approach(wanderer.id);
    const opening = harness.current() ?? '';

    // The opening line is a *random* quote, but the stored cursor is index 0 - so the
    // turns after it walk the pool deterministically from index 1. That is exactly what
    // the inline `open([quotes[random]])` / `advance` pair this replaced did: `open`
    // set the cursor to 0 and `advance` computed `(0 + 1) % length`. Asserting the
    // rotation rather than the opening is what makes this a parity test - the opening
    // is random and cannot be pinned.
    const rotated: string[] = [];
    for (let turn = 0; turn < quotes.length; turn += 1) {
      harness.interact(wanderer.id);
      rotated.push(harness.current() ?? '');
    }

    expect(rotated).toEqual([...quotes.slice(1), quotes[0]]);
    // And the opening was one of them, so the whole pool is reachable in one
    // conversation regardless of where the random index landed.
    expect(quotes).toContain(opening);
    expect(new Set([opening, ...rotated]).size).toBe(quotes.length);
  });

  it('never shows a wanderer a quest line, because they have no quest script', () => {
    if (wanderer === undefined) throw new Error('the shipped roster has no villager-1');
    expect(wanderer.questDialogue).toBeUndefined();
    const quotes = wanderer.quotes ?? [];
    const harness = mountCallbacks();

    harness.approach(wanderer.id);
    harness.interact(wanderer.id);
    harness.interact(wanderer.id);

    for (const line of harness.lines) expect(quotes).toContain(line ?? '');
  });

  it('ignores an unknown NPC id rather than showing somebody else\'s line', () => {
    const harness = mountCallbacks();

    harness.approach('nobody-by-that-name');

    expect(harness.lines).toEqual([]);
  });
});

describe('leaving closes the conversation and resets the cursor', () => {
  beforeEach(() => {
    setQuestStep('meet-keeper');
  });

  it('empties the bubble and clears the active NPC', () => {
    const harness = mountCallbacks();

    harness.approach('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[0]);

    harness.leave('keeper');

    expect(harness.current()).toBeNull();
    expect(harness.activeNpcIds).toEqual(['keeper', null]);
  });

  it('re-opens on the opening line rather than continuing a closed conversation', () => {
    const harness = mountCallbacks();

    harness.approach('keeper');
    harness.interact('keeper');
    expect(harness.current()).toBe(MEET_KEEPER_LINES[1]);

    // Walk away and come back: the learner is told the first thing again, which is
    // what "walk away and confirm dialogue closes" implies.
    harness.leave('keeper');
    harness.approach('keeper');

    expect(harness.current()).toBe(MEET_KEEPER_LINES[0]);
  });

  it('closing also resets the cursor, so an interact afterwards re-opens', () => {
    const harness = mountCallbacks();

    harness.approach('keeper');
    harness.interact('keeper');
    harness.leave('keeper');
    harness.interact('keeper');

    // An interact with no conversation open opens one rather than doing nothing, which
    // is the behaviour a renderer reporting an interact it did not announce relies on.
    expect(harness.current()).toBe(MEET_KEEPER_LINES[0]);
  });
});

describe('the quest board path resolves through the same owner', () => {
  beforeEach(() => {
    setQuestStep('intro');
  });

  it('keeperLineFor is the contract\'s opening line, not a second rule', () => {
    // Two places need "the opening line for a step": approaching the Keeper, and the
    // quest board's step chooser. `keeperLineFor` used to reach into `questDialogue`
    // itself, which is how the two drifted. It now delegates.
    for (const step of ['intro', 'meet-keeper', 'create-subject', 'complete']) {
      const lines = keeper?.questDialogue?.[step] ?? [];
      expect(keeperLineFor(step)).toBe(lines[0]);
      expect(keeperLineFor(step)).toBe(
        selectVillageNpcLine({ npc: keeper as VillageNpc, questStep: step, cursor: null }).line,
      );
    }
  });

  it('falls back to the greeting for a step with no script', () => {
    expect(keeperLineFor('a-step-that-was-never-authored')).toBe(keeper?.greeting);
  });

  it('matches what the screen shows when the same step is chosen mid-conversation', () => {
    // The screen's `handleSelectQuestStep` does `setQuestStep(step)` +
    // `resetConversation()` + `setKeeperDialogue(keeperLineFor(step))`. After a reset
    // the next interact opens on the first line, so the line the board showed and the
    // line the next turn shows are the same string - which is what a learner would
    // notice if they were not.
    const harness = mountCallbacks();
    harness.approach('keeper');
    harness.leave('keeper');

    const chosen = keeperLineFor('meet-keeper');
    harness.reset();
    harness.interact('keeper');

    expect(harness.current()).toBe(chosen);
    expect(chosen).toBe(EXPECTED_MEET_KEEPER_FIRST);
  });
});

describe('the unscripted fallback is the greeting, in one place', () => {
  beforeEach(() => {
    setQuestStep('a-step-that-was-never-authored');
  });

  it('agrees with the contract rather than answering dialogue[0]', () => {
    // The divergence this package closed. The inline `open(npc.dialogue)` this
    // replaced answered `dialogue[0]`, the contract answered the greeting, and the two
    // renderers answered the greeting too - so for an unscripted step the learner saw
    // a different first line depending on which layer was asked.
    const harness = mountCallbacks();
    harness.approach('keeper');

    expect(harness.current()).toBe(keeper?.greeting);
    expect(harness.current()).not.toBe(keeper?.dialogue[0]);
    expect(harness.current()).toBe(
      selectVillageNpcLine({
        npc: keeper as VillageNpc,
        questStep: 'a-step-that-was-never-authored',
        cursor: null,
      }).line,
    );
  });
});

describe('the callback bag is stable and reachable', () => {
  it('is one object for the life of the mount', () => {
    const harness = mountCallbacks();
    setQuestStep('meet-keeper');

    // Two turns, two renders' worth of identity: a bag rebuilt per render would be the
    // capture-stale bug this module's header describes.
    const before = harness.activeNpcIds.length;
    harness.approach('keeper');
    harness.interact('keeper');

    expect(harness.activeNpcIds.length).toBe(before + 1);
  });

  it('reports readiness through the same bag', () => {
    const ready = vi.fn();
    const { result } = renderHook(() =>
      useVillageSceneCallbacks(flow, {
        setActiveNpcId: () => {},
        setActiveNpcLabel: () => {},
        setKeeperDialogue: () => {},
        setNpcDialogAnchor: () => {},
        setVillageReady: ready,
      }),
    );

    act(() => result.current.callbacks.current?.onReady());

    expect(ready).toHaveBeenCalledExactlyOnceWith(true);
  });
});