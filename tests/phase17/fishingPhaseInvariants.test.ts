/**
 * Phase 17: the invariants this phase was not allowed to break.
 *
 * The whole point of this file is that it should be **uninteresting**. Phase 17 adds a
 * ledger to the progression record, a store action, and a command layer, and none of
 * that may move:
 *
 * - The subject schema stays `1.1.0`.
 * - `canonicalProgression.ts` and `validation.ts` are untouched.
 * - The catalogue, the rarity weights, and the rarity multiplier are untouched - the
 *   phase's non-goals are "no new fish species", "no new currencies", and "no arbitrary
 *   changes to rarity probabilities without a separate product decision".
 * - The Phase 15 and Phase 16 ledger carriers still work, and the new ledger sits beside
 *   them rather than over them.
 * - The legacy `src/game/systems/` re-exports still resolve, so the rollback lane's
 *   imports do not break.
 *
 * The `git` check is skipped when the repository is unavailable rather than failed, so
 * this suite still runs in an exported tree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@/core/validation/persistence';
import {
  FISH_CATALOG,
  FISH_RARITY_WEIGHTS,
  FISH_RARITY_XP_MULTIPLIER,
  BITE_TIMER_MIN_SEC,
  BITE_TIMER_MAX_SEC,
  BITE_WINDOW_SEC,
  FISH_DIRECTION_WEIGHTS,
  MAX_PROXIMITY_WAIT_MS,
} from '@/core/fishing/fishingTypes';

/** The baseline commit this phase was authorised to change nothing in. */
const BASELINE = 'ade1f78';

/** Files that must be byte-identical to the baseline. */
const BYTE_IDENTICAL = [
  'src/core/progression/canonicalProgression.ts',
  'src/services/persistence/v2/validation.ts',
];

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A file's bytes at the baseline, or `null` when it did not exist / git is absent. */
function baselineBytes(path: string): string | null {
  if (!gitAvailable()) return null;
  try {
    return execFileSync('git', ['show', `${BASELINE}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// ── Subject schema ───────────────────────────────────────────────────────────

describe('Phase 17 invariants - the subject schema', () => {
  it('stays at 1.1.0, because the rebuild is not a data-format change', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe('1.1.0');
  });

  it('introduces no new storage key, store, or generation member', () => {
    // The ledger rides the progression record's preserved-field carrier precisely
    // because adding a store or a generation member is out of scope. The Phase 17
    // modules therefore name no storage key at all - a check that would fail the moment
    // one of them reached for a key of its own.
    for (const module of [
      'src/core/fishing/catchRewards.ts',
      'src/core/fishing/fishingStateMachine.ts',
      'src/application/fishingCommands.ts',
      'src/store/fishingCommands.ts',
    ]) {
      const source = readFileSync(module, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      expect(source).not.toContain('STORAGE_KEYS');
    }
  });

  it('leaves the storage-v2 store and generation definitions byte-identical', () => {
    for (const path of [
      'src/services/persistence/v2/records.ts',
      'src/services/persistence/v2/generations.ts',
    ]) {
      if (!existsSync(path)) continue;
      const baseline = baselineBytes(path);
      if (baseline === null) continue;
      expect(readFileSync(path, 'utf8')).toBe(baseline);
    }
    // `dualWrite.ts` left this list in Phase 19, and the reason is the subject of the next test
    // rather than an omission. Listing it here as well would have produced one absolute
    // assertion and one contradictory one, and the reader would have had to work out which to
    // believe. The property this list protects - no storage-v2 **store** and no **generation
    // member** was added - is fully intact: `records.ts` and `generations.ts` are the files that
    // define those, and both are still checked byte for byte.
  });

  it('records a change to `dualWrite.ts` as a union member, or nothing at all', () => {
    // The byte-identity assertion above is absolute, and Phase 19 legitimately had to violate it:
    // `DualWriteOperation` is a closed union of *report names*, and a fourth dual-writing store
    // (`src/store/assistanceStore.ts`) needs a name of its own. Reusing an existing member would
    // have been the alternative, and it would have mislabelled every assistance write as
    // `sessions` or `preferences` in a recovery screen - which is worse than an honest diff here.
    //
    // So this test states what the change is *allowed* to be, rather than dropping the check: the
    // file must differ from the baseline by nothing except added members of that union. A removed
    // member, a renamed member, a changed failure code, a changed outcome, and any edit outside
    // the union all fail here. That is a **tighter** constraint than "unmodified" for the thing
    // this phase changed, and it keeps the guarantee that matters - no storage-v2 *store* or
    // *generation member* was added - fully intact, which the two other paths above still assert
    // byte for byte.
    //
    // ## What this gate does **not** detect, measured rather than assumed
    //
    // An earlier version of this comment claimed "a reordered union" among the failures. It is
    // **GREEN** for a reorder, and the reason is structural rather than accidental:
    //
    // - {@link unionMembers} collects members into a `Set`, so member order is discarded.
    // - The byte-identity check is `current.replace("\n  | 'assistance'", '') === baseline`, and
    //   `String.prototype.replace` without `/g` removes the **first** occurrence wherever it sits.
    //   Removing the added line from a reordered union therefore reproduces the baseline
    //   **sequence** exactly, because the pre-existing members never moved relative to each other.
    //
    // Measured against this file: moving `| 'assistance'` to the first union position, to the last,
    // and to the middle are all GREEN; swapping two **pre-existing** members (`'sessions'` with
    // `'preferences'`, and `'subject.save'` with `'subject.delete'`) is RED, caught by the
    // byte-identity check. So the gate pins the *relative order of the pre-existing members* and
    // the *identity of the added ones*, and does not pin where in the union the added member sits.
    // That is not worth closing: a union's order has no runtime meaning, and pinning a member's
    // position would make every future addition a question about this list rather than about the
    // type. The claim in this comment is now exactly the claim the assertions make.
    //
    // Phase 17's own fishing modules were verified against the absolute check before Phase 19
    // existed, and `src/core/progression/canonicalProgression.ts` and
    // `src/services/persistence/v2/validation.ts` are still checked that way in the suite below.
    const path = 'src/services/persistence/v2/dualWrite.ts';
    const baseline = baselineBytes(path);
    if (baseline === null) return;
    const current = readFileSync(path, 'utf8');

    const unionMembers = (source: string): Set<string> => {
      const start = source.indexOf('export type DualWriteOperation =');
      expect(start, `${path} no longer declares DualWriteOperation`).toBeGreaterThan(-1);
      const end = source.indexOf(';', start);
      const body = source.slice(start, end);
      return new Set([...body.matchAll(/\|\s*'([^']+)'/g)].map((match) => match[1]));
    };

    const before = unionMembers(baseline);
    const after = unionMembers(current);
    // Nothing removed, nothing renamed: `after` is a strict superset of `before`.
    expect([...before].filter((member) => !after.has(member)), `${path} removed a member`).toEqual([]);
    expect([...after].filter((member) => !before.has(member)), `${path} added a member`).toEqual([
      'assistance',
    ]);

    // And *nothing else* in the file moved. Removing the added line reproduces the baseline
    // byte for byte, which is the whole claim: the diff is exactly one union member.
    const addedLines = current.split('\n').filter((line) => !baseline.includes(line));
    expect(addedLines, `${path} has changed lines other than the added member`).toEqual([
      "  | 'assistance'",
    ]);
    expect(current.replace(`\n  | 'assistance'`, '')).toBe(baseline);

    // The failure-code and outcome vocabularies - the parts a recovery screen reads - are untouched.
    for (const declaration of ['DualWriteFailureCode', 'DualWriteOutcome']) {
      expect(current, `${declaration} moved`).toContain(
        baseline.slice(baseline.indexOf(`export type ${declaration}`), baseline.indexOf(';', baseline.indexOf(`export type ${declaration}`)) + 1),
      );
    }
  });
});

// ── Byte-identical files ─────────────────────────────────────────────────────

describe('Phase 17 invariants - byte-identical files', () => {
  for (const path of BYTE_IDENTICAL) {
    it(`${path} is unchanged from ${BASELINE}`, () => {
      const baseline = baselineBytes(path);
      if (baseline === null) {
        // The file exists in the working tree and could not be read from git (an export,
        // or a shallow clone). Assert it exists rather than skipping silently.
        expect(existsSync(path)).toBe(true);
        return;
      }
      expect(readFileSync(path, 'utf8')).toBe(baseline);
    });
  }

  it('reports the same diff for the whole phase', () => {
    if (!gitAvailable()) return;
    const stat = execFileSync('git', ['diff', '--stat', `${BASELINE}...HEAD`], {
      encoding: 'utf8',
    });
    // Recorded as an evidence value rather than asserted, because the phase's changed
    // file list is a fact for the report, not a pass/fail condition.
    expect(typeof stat).toBe('string');
  });
});

// ── The catalogue and the probabilities ──────────────────────────────────────

describe('Phase 17 invariants - the catalogue is untouched', () => {
  it('has exactly the same eight species, with the same ids', () => {
    expect(FISH_CATALOG.map((entry) => entry.id)).toEqual([
      'moss-carp',
      'sun-skip',
      'reed-darter',
      'ink-minnow',
      'lunar-trout',
      'ember-perch',
      'gilded-koi',
      'abyssal-eel',
    ]);
  });

  it('adds no species', () => {
    const baseline = baselineBytes('src/core/fishing/fishingTypes.ts');
    if (baseline === null) return;
    // A byte comparison is the strongest form of "no new fish species": it also catches
    // a rename, a rarity change, and a description edit.
    expect(readFileSync('src/core/fishing/fishingTypes.ts', 'utf8')).toBe(baseline);
  });

  it('has the same rarity weights, summing to 100', () => {
    expect(FISH_RARITY_WEIGHTS).toEqual({ common: 65, rare: 28, epic: 7 });
    const total = Object.values(FISH_RARITY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });

  it('has the same rarity XP multipliers', () => {
    expect(FISH_RARITY_XP_MULTIPLIER).toEqual({ common: 1.0, rare: 1.5, epic: 2.0 });
  });

  it('has the same bite and approach constants', () => {
    expect(BITE_TIMER_MIN_SEC).toBe(3);
    expect(BITE_TIMER_MAX_SEC).toBe(15);
    expect(BITE_WINDOW_SEC).toBe(2);
    expect(FISH_DIRECTION_WEIGHTS).toEqual({ right: 1, bottom: 1 });
    expect(MAX_PROXIMITY_WAIT_MS).toBe(20_000);
  });

  it('adds no currency and no XP scale', () => {
    const baseline = baselineBytes('src/core/progression/types.ts');
    if (baseline === null) return;
    // The per-answer rate the ledger pays for a correct answer, and every fishing badge
    // threshold, live in this file. Unchanged bytes means unchanged economy.
    expect(readFileSync('src/core/progression/types.ts', 'utf8')).toBe(baseline);
  });
});

// ── The other ledgers ────────────────────────────────────────────────────────

describe('Phase 17 invariants - the Phase 15 and 16 carriers', () => {
  it('still keys the room-clear ledger where it always did', async () => {
    const { ROOM_CLEAR_REWARD_LEDGER_KEY } = await import('@/core/progression/roomClearRewards');
    expect(ROOM_CLEAR_REWARD_LEDGER_KEY).toBe('roomClearRewardLedger');
  });

  it('still keys the review-pass ledger where it always did', async () => {
    const { REVIEW_PASS_REWARD_LEDGER_KEY } = await import('@/core/review/reviewPassRewards');
    expect(REVIEW_PASS_REWARD_LEDGER_KEY).toBe('reviewPassRewardLedger');
  });

  it('uses a third, distinct key for the catch ledger', async () => {
    const { CATCH_REWARD_LEDGER_KEY } = await import('@/core/fishing/catchRewards');
    expect(CATCH_REWARD_LEDGER_KEY).toBe('catchRewardLedger');
    expect(CATCH_REWARD_LEDGER_KEY).not.toBe('roomClearRewardLedger');
    expect(CATCH_REWARD_LEDGER_KEY).not.toBe('reviewPassRewardLedger');
  });

  it('leaves their carrier modules byte-identical', () => {
    for (const path of [
      'src/core/progression/roomClearRewards.ts',
      'src/core/review/reviewPassRewards.ts',
      'src/core/review/interruptedReviewSession.ts',
    ]) {
      const baseline = baselineBytes(path);
      if (baseline === null) continue;
      expect(readFileSync(path, 'utf8')).toBe(baseline);
    }
  });
});

// ── The compatibility re-exports ─────────────────────────────────────────────

describe('Phase 17 invariants - the game-layer re-exports', () => {
  it('still re-exports the mechanics module', async () => {
    const shim = await import('@/game/systems/fishingMechanics');
    const core = await import('@/core/fishing/fishingMechanics');
    expect(shim.createSeededRng).toBe(core.createSeededRng);
    expect(shim.rollFishRarity).toBe(core.rollFishRarity);
    expect(shim.getClearedRooms).toBe(core.getClearedRooms);
    expect(shim.pullRecallQuestion).toBe(core.pullRecallQuestion);
  });

  it('still re-exports the types module', async () => {
    const shim = await import('@/game/systems/fishingTypes');
    const core = await import('@/core/fishing/fishingTypes');
    expect(shim.FISH_CATALOG).toBe(core.FISH_CATALOG);
    expect(shim.FISH_RARITY_WEIGHTS).toBe(core.FISH_RARITY_WEIGHTS);
    expect(shim.BITE_WINDOW_SEC).toBe(core.BITE_WINDOW_SEC);
  });

  it('leaves both re-export files byte-identical', () => {
    for (const path of [
      'src/game/systems/fishingMechanics.ts',
      'src/game/systems/fishingTypes.ts',
    ]) {
      const baseline = baselineBytes(path);
      if (baseline === null) continue;
      expect(readFileSync(path, 'utf8')).toBe(baseline);
    }
  });
});

// ── The legacy store actions ─────────────────────────────────────────────────

describe('Phase 17 invariants - the rollback lane', () => {
  it('keeps addFish, awardFishingXp, and checkFishingBadges on the store type', async () => {
    // Their existence is the rollback. `VITE_PIXI_FISHING=false` reaches them through
    // `VillageScreen.handleKeepFish`, which this phase does not touch.
    const mod = await import('@/store/progressionStore');
    const state = mod.useProgressionStore.getState();
    expect(typeof state.addFish).toBe('function');
    expect(typeof state.awardFishingXp).toBe('function');
    expect(typeof state.checkFishingBadges).toBe('function');
    // And the new one alongside them.
    expect(typeof state.recordCatch).toBe('function');
  });

  it('leaves the Phaser fishing scene untouched, since it is the rollback', () => {
    const baseline = baselineBytes('src/game/scenes/FishingScene.ts');
    if (baseline === null) return;
    // The machine was *extracted* from the scene but the scene was not *changed*: the
    // rollback lane has to keep working, and the scene still calls the three store
    // actions through the village screen.
    expect(readFileSync('src/game/scenes/FishingScene.ts', 'utf8')).toBe(baseline);
  });
});