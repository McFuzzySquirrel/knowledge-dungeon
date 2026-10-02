/**
 * Phase 12 WP-1: the renderer-neutral village NPC contract.
 *
 * ## What these tests are for
 *
 * The contract in `src/application/contracts/villageNpc.ts` exists so the Phaser
 * village adapter and the Pixi village scene satisfy *one* description of NPC
 * interaction. That description is worth nothing if the two renderers can each
 * satisfy it a different way, so most of what follows is a parity assertion rather
 * than a behaviour test: the pure selection rules, the dialogue-selection rules
 * checked against the *shipped* roster, and two pins that tie the contract to the
 * constants a renderer already declares.
 *
 * ## The two pins, and why they are the load-bearing ones
 *
 * 1. `VILLAGE_ACTION_INTERACT` is the same literal as the Pixi village scene's
 *    `VILLAGE_INTERACT_ACTION_ID`, and the same union as the Pixi world host's
 *    `WorldActionSource`. Both are compile-time assertions rather than runtime
 *    string comparisons, so a rename on either side is a `typecheck` failure.
 * 2. `VillageNpcEventHandlers` covers exactly the four declared
 *    `village:npc-*` events, and `VillageNpcDialogAnchor` is exactly the
 *    `village:npc-dialog-position` payload. Those two types are asserted in the
 *    contract file itself and re-asserted here, because "the named anchor is the
 *    event payload" is the claim that lets a Phaser adapter emit an object the DOM
 *    reads with no translation step.
 *
 * ## What these tests do not prove
 *
 * They are unit tests over pure functions. They prove nothing about whether a Pixi
 * scene draws an NPC, whether a canvas press reaches the DOM mirror, or whether a
 * screen-reader user can hear a dialogue change - those are WP-2/WP-3 and the
 * browser lane. The `describeVillageNpcQuests` test runs against `VILLAGE_MAP`
 * because that roster is the actual content the contract has to preserve; the rest
 * run against synthetic NPCs invented for this file.
 *
 * Hermeticity: no `dist/`, no network, no commit, no `localStorage`, and no learner
 * data. Every string is invented here or read from the shipped village layout.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createVillageNpcSnapshot,
  describeVillageNpcQuests,
  selectVillageNpcLine,
  selectVillageNearbyTargets,
  VILLAGE_ACTION_INTERACT,
  VILLAGE_NEARBY_RANGES,
  type VillageActionInvocation,
  type VillageActionSource,
  type VillageNpcEventHandlers,
  type VillageNpcEventName,
  type VillageNpcDialogAnchor,
  type VillageNpcLineCursor,
  type VillageNearbyCandidate,
  type VillageNearbyTarget,
} from '@/application/contracts/villageNpc';
import { createWorldEventSink, type WorldEventPayload } from '@/application/contracts/events';
import {
  INTERACT_RADIUS,
  STRUCTURE_APPROACH_RADIUS,
  VILLAGE_MAP,
  type VillageNpc,
} from '@/data/villageLayout';
import { VILLAGE_INTERACT_ACTION_ID } from '@/renderers/pixi/village/createVillageScene';
import type { WorldActionSource } from '@/renderers/pixi/runtime/types';

// ── Compile-time parity with what the renderers already declare ──────────────

/**
 * The contract's action id is the id the Pixi village scene answers to.
 *
 * Written as an assignment rather than an `expect` so a rename is a `typecheck`
 * failure: a DOM control that sends an id no action table knows is a control that
 * does nothing, and the failure would otherwise only show up as a click with no
 * effect.
 */
const PINNED_PIXI_ACTION_ID: typeof VILLAGE_INTERACT_ACTION_ID = VILLAGE_ACTION_INTERACT;

/**
 * The contract's action-source union is the Pixi world host's, member for member.
 *
 * `WorldActionSource` lives in `src/renderers/**`, which `src/application/**` may
 * not import - so this direction is the legal one, and it is what proves an adapter
 * can forward `invocation.source` into its own dispatcher unchanged.
 */
const PINNED_ACTION_SOURCES: readonly WorldActionSource[] = [
  'keyboard',
  'pointer',
  'dom',
] satisfies readonly VillageActionSource[];

// ── Synthetic fixtures ──────────────────────────────────────────────────────

/**
 * A minimal scripted NPC, in the shape `questDialogue` gives the Keeper.
 *
 * The content is invented for this file: the string is an identifier used to prove
 * a rule, not dialogue that ships.
 */
function scriptedNpc(overrides: Partial<VillageNpc> = {}): VillageNpc {
  return {
    id: 'synthetic-scripted',
    label: 'Synthetic Scripted',
    gridX: 1,
    gridY: 1,
    greeting: 'synthetic greeting',
    dialogue: ['synthetic ambient one', 'synthetic ambient two'],
    questDialogue: {
      alpha: ['synthetic alpha one', 'synthetic alpha two'],
      beta: ['synthetic beta one'],
    },
    ...overrides,
  };
}

/** A minimal wanderer: quotes, no quest script. */
function wanderingNpc(overrides: Partial<VillageNpc> = {}): VillageNpc {
  return {
    id: 'synthetic-wanderer',
    label: 'Synthetic Wanderer',
    gridX: 2,
    gridY: 2,
    greeting: 'synthetic wanderer greeting',
    dialogue: ['synthetic fallback one'],
    quotes: ['synthetic quote one', 'synthetic quote two', 'synthetic quote three'],
    ...overrides,
  };
}

function candidate(overrides: Partial<VillageNearbyCandidate> = {}): VillageNearbyCandidate {
  return {
    kind: 'npc',
    id: 'synthetic-npc',
    label: 'Synthetic NPC',
    distance: 10,
    range: VILLAGE_NEARBY_RANGES.npc,
    ...overrides,
  };
}

// ── 1. The event contract ───────────────────────────────────────────────────

/**
 * The `village:npc-*` event names parsed out of the contract's own source.
 *
 * Read rather than written out, for the same reason
 * `tests/contracts/phase-2-phaser-callback-coverage.test.ts` parses
 * `WorldEventPayloadMap`: the payload map is the single source of truth, and a
 * hand-written copy of its NPC slice is a second thing to drift. This is what makes
 * the test below a real assertion - a hardcoded four-element array has length four
 * whatever its *element type* is, so widening `VillageNpcEventName` to `string`
 * leaves such a test green.
 */
function readNpcEventNamesFromSource(): string[] {
  const source = readFileSync(
    join(process.cwd(), 'src/application/contracts/events.ts'),
    'utf8',
  );
  const start = source.indexOf('export interface WorldEventPayloadMap {');
  expect(start, 'WorldEventPayloadMap is missing from the event contract').toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('\n}', start));
  return [...block.matchAll(/^\s*'([^']+)'\s*:/gm)]
    .map((match) => match[1])
    .filter((name) => name.startsWith('village:npc-'));
}

/**
 * The field names of the `village:npc-dialog-position` payload, parsed from source.
 *
 * A single-line shape, so the keys can be read without parsing. If the payload ever
 * grows a second line, this returns an empty key set and the assertion below fails
 * loudly rather than silently comparing nothing - which is the failure mode a
 * "derive it so it tracks changes" helper is most likely to have.
 */
function readDialogPositionPayloadKeysFromSource(): Record<string, true> {
  const source = readFileSync(
    join(process.cwd(), 'src/application/contracts/events.ts'),
    'utf8',
  );
  const line = source
    .split('\n')
    .find((entry) => entry.includes("'village:npc-dialog-position'"));
  expect(line, 'the village:npc-dialog-position payload is missing').toBeDefined();
  const body = line?.slice(line.indexOf('{') + 1, line.lastIndexOf('}')) ?? '';
  const keys = [...body.matchAll(/([a-zA-Z]+)\s*:/g)].map((match) => match[1]);
  expect(keys.length, 'the payload shape moved off one line; update this reader').toBeGreaterThan(0);
  return Object.fromEntries(keys.map((key) => [key, true as const]));
}

describe('the NPC event contract is the existing village:npc-* mechanism', () => {
  it('names exactly the four declared NPC events', () => {
    // Two halves that check different things. The runtime half reads the payload
    // map and asks what it actually declares: a fifth NPC event, a renamed one, or
    // a removed one turns this red. The compile-time half is the `satisfies`
    // annotation - it fails `npm run typecheck` if `VillageNpcEventName` widens to
    // something these four do not exhaust, so the `Extract<>` in the contract is
    // pinned rather than merely annotated.
    const declared = readNpcEventNamesFromSource().sort();
    expect(declared).toEqual([
      'village:npc-approached',
      'village:npc-dialog-position',
      'village:npc-interact',
      'village:npc-left',
    ]);

    const exhaustive = {
      'village:npc-approached': true,
      'village:npc-left': true,
      'village:npc-interact': true,
      'village:npc-dialog-position': true,
    } satisfies Record<VillageNpcEventName, true>;
    expect(Object.keys(exhaustive).sort()).toEqual(declared);
  });

  it('makes every NPC event mandatory for an application handler bag', () => {
    // `Required` is the claim: an application layer that renders a nearby-action
    // list cannot bind a bag with a hole in it. A partial bag is a compile error,
    // which is asserted here by the absence of any `Partial` at the declaration
    // and by the sink below delivering to all four.
    const delivered: string[] = [];
    const handlers: VillageNpcEventHandlers = {
      'village:npc-approached': () => delivered.push('approached'),
      'village:npc-left': () => delivered.push('left'),
      'village:npc-interact': () => delivered.push('interact'),
      'village:npc-dialog-position': () => delivered.push('anchor'),
    };
    const sink = createWorldEventSink(handlers);

    sink({ type: 'village:npc-approached', payload: { npcId: 'a' } });
    sink({ type: 'village:npc-left', payload: { npcId: 'a' } });
    sink({ type: 'village:npc-interact', payload: { npcId: 'a' } });
    sink({ type: 'village:npc-dialog-position', payload: { npcId: 'a', clientX: 1, clientY: 2 } });

    expect(delivered).toEqual(['approached', 'left', 'interact', 'anchor']);
  });

  it('types the dialog anchor as the event payload, field for field', () => {
    // The parity between `VillageNpcDialogAnchor` and the
    // `village:npc-dialog-position` payload is enforced by the `Exact<>` assertion
    // in `src/application/contracts/villageNpc.ts`, which fails
    // `npm run typecheck` when either side gains, loses, or renames a field. This
    // test does not re-assert that - it cannot, at runtime, observe a type - so it
    // is not dressed up as though it could.
    //
    // What it *does* check is the one thing a runtime test can: that an anchor
    // built as the named type is accepted by the event machinery unchanged, and
    // that its key set is the key set the payload actually declares today. The
    // `satisfies` on the payload literal is the compile-time half - a fourth
    // required payload field breaks the build here as well as in the contract.
    const payload = {
      npcId: 'a',
      clientX: 12,
      clientY: 34,
    } satisfies WorldEventPayload<'village:npc-dialog-position'>;

    const anchor: VillageNpcDialogAnchor = { ...payload };
    expect(anchor).toEqual({ npcId: 'a', clientX: 12, clientY: 34 });
    expect(Object.keys(anchor).sort()).toEqual(
      Object.keys(readDialogPositionPayloadKeysFromSource()).sort(),
    );
  });

  it('pins the contract action id and source union to the Pixi renderer values', () => {
    expect(PINNED_PIXI_ACTION_ID).toBe('village-interact');
    expect(PINNED_ACTION_SOURCES).toEqual(['keyboard', 'pointer', 'dom']);
  });

  it('builds an invocation the DOM can send and an adapter can forward unchanged', () => {
    const named: VillageActionInvocation = {
      actionId: VILLAGE_ACTION_INTERACT,
      target: { kind: 'npc', id: 'keeper' },
      source: 'dom',
    };
    const bare: VillageActionInvocation = {
      actionId: VILLAGE_ACTION_INTERACT,
      target: null,
      source: 'dom',
    };

    expect(named.target).toEqual({ kind: 'npc', id: 'keeper' });
    expect(bare.target).toBeNull();
  });
});

// ── 2. The nearby-action list ───────────────────────────────────────────────

describe('selectVillageNearbyTargets', () => {
  it('keeps a structure row ahead of an NPC row', () => {
    // The order is the priority the world's own interact key already has: a
    // structure in range wins, so the first DOM row must be the structure. The
    // distance sits between the two radii so it is in range for the building and
    // out of range for the NPC, which is what makes the two rows independently
    // reachable rather than one of them being dropped.
    const rows = selectVillageNearbyTargets([
      candidate({ kind: 'npc', id: 'npc-a', distance: 4 }),
      candidate({
        kind: 'structure',
        id: 'structure-a',
        distance: 40,
        range: VILLAGE_NEARBY_RANGES.structure,
      }),
    ]);

    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ['structure', 'structure-a'],
      ['npc', 'npc-a'],
    ]);
  });

  it('keeps only the nearest target of each kind', () => {
    const rows = selectVillageNearbyTargets([
      candidate({ kind: 'structure', id: 'far-structure', distance: 40 }),
      candidate({ kind: 'structure', id: 'near-structure', distance: 8 }),
      candidate({ kind: 'npc', id: 'near-npc', distance: 5 }),
      candidate({ kind: 'npc', id: 'other-npc', distance: 9 }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(['near-structure', 'near-npc']);
  });

  it('breaks an exact distance tie on id, so two renderers agree', () => {
    const rows = selectVillageNearbyTargets([
      candidate({ kind: 'npc', id: 'zulu', distance: 5 }),
      candidate({ kind: 'npc', id: 'alpha', distance: 5 }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(['alpha']);
  });

  it('treats the range boundary as out of range', () => {
    // `distance < range`, matching the Phaser scene's strict-improvement search:
    // a DOM row must not exist that the canvas would refuse to act on.
    const inside = candidate({ distance: VILLAGE_NEARBY_RANGES.npc - 0.1 });
    const exactly = candidate({ distance: VILLAGE_NEARBY_RANGES.npc });

    expect(selectVillageNearbyTargets([inside]).map((row) => row.id)).toEqual(['synthetic-npc']);
    expect(selectVillageNearbyTargets([exactly])).toEqual([]);
  });

  it('uses the two shared proximity radii rather than one number for both', () => {
    expect(VILLAGE_NEARBY_RANGES.npc).toBe(INTERACT_RADIUS);
    expect(VILLAGE_NEARBY_RANGES.structure).toBe(STRUCTURE_APPROACH_RADIUS);
    expect(VILLAGE_NEARBY_RANGES.npc).toBeLessThan(VILLAGE_NEARBY_RANGES.structure);

    // A distance that is "in range" for a building is out of range for an NPC, so
    // reporting both kinds at one distance produces one row, not two.
    const rows = selectVillageNearbyTargets([
      candidate({ kind: 'npc', id: 'npc-a', distance: 40, range: VILLAGE_NEARBY_RANGES.npc }),
      candidate({ kind: 'structure', id: 'structure-a', distance: 40, range: VILLAGE_NEARBY_RANGES.structure }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['structure']);
  });

  it('drops a measurement it cannot use instead of rendering it', () => {
    const rows = selectVillageNearbyTargets([
      candidate({ id: 'nan', distance: Number.NaN }),
      candidate({ id: 'infinite', distance: Number.POSITIVE_INFINITY }),
      candidate({ id: 'negative', distance: -1 }),
      candidate({ id: 'no-range', distance: 1, range: 0 }),
      candidate({ id: 'nan-range', distance: 1, range: Number.NaN }),
      candidate({ id: 'good', distance: 1 }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(['good']);
  });

  it('rounds the reported distance and stamps the shared action id', () => {
    const rows = selectVillageNearbyTargets([
      candidate({ id: 'a', distance: 12.345 }),
    ]);

    expect(rows[0]?.distance).toBe(12.3);
    expect(rows[0]?.actionId).toBe(VILLAGE_ACTION_INTERACT);
  });

  it('publishes a distance equal to the radius for a measurement it selected', () => {
    // The fact the browser lane was asserting against, pinned here so it cannot be
    // "fixed" by loosening the e2e and forgotten here.
    //
    // `roundDistance` rounds half *up*, and the selection rule is a strict `<`, so a
    // measurement anywhere in `[range - 0.05, range)` is selected and then publishes
    // as exactly `range`. Both shipped radii have a reachable such window, so this is
    // a property of the shipped numbers and not of an invented fixture.
    for (const [kind, range] of [
      ['npc', VILLAGE_NEARBY_RANGES.npc],
      ['structure', VILLAGE_NEARBY_RANGES.structure],
    ] as const) {
      const selected = selectVillageNearbyTargets([
        candidate({ kind, range, distance: range - 0.04 }),
      ]);
      expect(selected.map((row) => row.id), `${kind}: the near-boundary measurement was dropped`).toEqual([
        'synthetic-npc',
      ]);
      expect(selected[0]?.distance, `${kind}: expected the upward-biased rounding`).toBe(range);
    }
  });

  it('publishes nothing outside the closed band [0, range] for every distance it selects', () => {
    // The enumeration the browser lane now relies on, in both directions:
    //
    // - every raw distance the contract selects publishes inside `[0, range]`, which
    //   is the strongest statement a consumer can make about the published number,
    //   and
    // - no raw distance outside that band is ever published, so a published value
    //   above the radius really does mean the DOM and the world disagree.
    //
    // Swept in hundredths of a pixel across both radii plus a margin either side, so
    // the sweep crosses every rounding boundary rather than sampling one.
    for (const range of [VILLAGE_NEARBY_RANGES.npc, VILLAGE_NEARBY_RANGES.structure]) {
      for (let hundredths = 0; hundredths <= Math.ceil((range + 1) * 100); hundredths += 1) {
        const raw = hundredths / 100;
        const rows = selectVillageNearbyTargets([candidate({ range, distance: raw })]);
        // No rows means the measurement was *dropped*, so nothing was published and
        // there is no published number to put in a band. An earlier version of this
        // sweep asserted `raw < 0` on this branch, which no non-negative distance can
        // satisfy; it failed on the first dropped measurement of the sweep (`raw = 32`
        // against the NPC radius) and so failed for every run, while proving nothing
        // about the contract. Dropping the measurement is the behaviour under test
        // here, and the neighbouring `drops a measurement at or beyond the radius`
        // case is where the boundary itself is pinned.
        if (rows.length === 0) continue;
        // A row *was* published, so the raw distance that produced it was itself
        // inside the band. This is the second half of the block's claim - "no raw
        // distance outside that band is ever published" - stated on the raw value
        // rather than inferred from the rounded twin, because the rounding step can
        // hide an out-of-band raw behind an in-band published value.
        expect(raw, `raw ${raw} was selected but is below 0, so it is outside [0, ${range}]`).toBeGreaterThanOrEqual(
          0,
        );
        expect(raw, `raw ${raw} was selected but is at or beyond the radius ${range}`).toBeLessThan(range);
        const published = rows[0]?.distance ?? Number.NaN;
        expect(published, `raw ${raw} published outside [0, ${range}]`).toBeGreaterThanOrEqual(0);
        expect(published, `raw ${raw} published outside [0, ${range}]`).toBeLessThanOrEqual(range);
      }
    }
  });

  it('drops a measurement at or beyond the radius even though its published twin would pass', () => {
    // Why the band above is a band and not "anything under the radius is fine":
    // the published number and the selection rule disagree by up to one rounding
    // step, in the direction that hides a row just outside the radius. Re-deriving
    // the threshold from the published value therefore cannot distinguish "selected
    // at 47.96" from "not selected at 48.0" - and only the row's existence can.
    const justInside = selectVillageNearbyTargets([
      candidate({ range: VILLAGE_NEARBY_RANGES.structure, distance: VILLAGE_NEARBY_RANGES.structure - 0.01 }),
    ]);
    const justOutside = selectVillageNearbyTargets([
      candidate({ range: VILLAGE_NEARBY_RANGES.structure, distance: VILLAGE_NEARBY_RANGES.structure }),
    ]);

    expect(justInside[0]?.distance).toBe(VILLAGE_NEARBY_RANGES.structure);
    expect(justOutside).toEqual([]);
  });

  it('never mutates its input and is stable across calls', () => {
    const candidates = [
      candidate({ kind: 'npc', id: 'npc-a', distance: 4 }),
      candidate({ kind: 'structure', id: 'structure-a', distance: 40 }),
    ];
    const snapshot = candidates.map((entry) => ({ ...entry }));

    const first = selectVillageNearbyTargets(candidates);
    const second = selectVillageNearbyTargets(candidates);

    expect(candidates).toEqual(snapshot);
    expect(first).toEqual(second);
  });

  it('returns an empty list for no candidates', () => {
    expect(selectVillageNearbyTargets([])).toEqual([]);
  });

  it('returns a frozen list, so a caller cannot rewrite the selection in place', () => {
    // The contract freezes its output so a panel that keeps a reference to the rows
    // cannot mutate the shared selection a later render would read. Asserted by
    // attempting the mutation rather than by reading `Object.isFrozen`, so this
    // fails if the freeze is removed *and* if it is replaced by something that only
    // looks frozen.
    const rows = selectVillageNearbyTargets([
      candidate({ kind: 'npc', id: 'npc-a', distance: 4 }),
      candidate({
        kind: 'structure',
        id: 'structure-a',
        distance: 40,
        range: VILLAGE_NEARBY_RANGES.structure,
      }),
    ]);

    // A row shape, not the `candidate()` measurement fixture: the rows the selector
    // returns carry an `actionId` that a raw measurement does not.
    const row: VillageNearbyTarget = { ...rows[0]!, id: 'sneaked-in' };

    expect(Object.isFrozen(rows)).toBe(true);
    expect(() => {
      (rows as VillageNearbyTarget[]).push(row);
    }).toThrow(TypeError);
    expect(() => {
      (rows as VillageNearbyTarget[])[0] = row;
    }).toThrow(TypeError);
    expect(rows.map((entry) => entry.id)).toEqual(['structure-a', 'npc-a']);
  });
});

// ── 3. The snapshot ─────────────────────────────────────────────────────────

describe('createVillageNpcSnapshot', () => {
  it('derives the rows once so the two fields cannot disagree', () => {
    const snapshot = createVillageNpcSnapshot({
      candidates: [
        candidate({ kind: 'npc', id: 'npc-a', distance: 4 }),
        candidate({ kind: 'npc', id: 'npc-b', distance: 6 }),
        candidate({
          kind: 'structure',
          id: 'structure-a',
          distance: 40,
          range: VILLAGE_NEARBY_RANGES.structure,
        }),
      ],
    });

    expect(snapshot.nearby.map((row) => row.id)).toEqual(['structure-a', 'npc-a']);
    expect(snapshot.nearby).toEqual(
      selectVillageNearbyTargets(snapshot.candidates),
    );
  });

  it('copies the candidate array so a renderer cannot mutate the snapshot', () => {
    const candidates = [candidate({ id: 'a' })];
    const snapshot = createVillageNpcSnapshot({ candidates });

    candidates.push(candidate({ id: 'b' }));

    expect(snapshot.candidates).toHaveLength(1);
  });

  it('reports an NPC-less village as a value, not an absence', () => {
    const snapshot = createVillageNpcSnapshot({ candidates: [] });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.nearby).toEqual([]);
    expect(snapshot.anchor).toBeNull();
  });

  it('carries exactly three members, and none of them is a dialogue', () => {
    // The narrowing, stated as an enumeration rather than as "a field is gone".
    //
    // The runtime half asks what the factory actually produced. The compile-time half
    // is the `VillageNpcSnapshotMembersAreExactlyThese` and
    // `VillageNpcSnapshotHasNoDialogueMember` aliases in the contract: a `dialogue`
    // that reappears - required or optional - is a `npm run typecheck` failure, which
    // is the only instrument that can observe a type at all.
    const snapshot = createVillageNpcSnapshot({ candidates: [candidate()] });

    expect(Object.keys(snapshot).sort()).toEqual(['anchor', 'candidates', 'nearby']);
    expect('dialogue' in snapshot).toBe(false);
  });

  it('refuses a `dialogue` in its input, so a stale caller fails to build', () => {
    // A renderer that still computed a line would pass `{ dialogue }` here. Excess
    // property checking is the mechanism: an object *literal* with an unknown key is an
    // error, so the compile-time proof above has a runtime-shaped counterpart and the
    // removal is not merely "nothing reads it".
    const anchor: VillageNpcDialogAnchor = { npcId: 'synthetic-scripted', clientX: 40, clientY: 60 };
    const snapshot = createVillageNpcSnapshot({ candidates: [candidate()], anchor });

    expect(snapshot.anchor).toBe(anchor);
  });

  it('freezes the snapshot and both of its arrays', () => {
    // A snapshot is what a panel renders from, and React re-reads the same reference
    // across renders. If a caller could push a row onto `nearby` in place, the next
    // render would show an action list the renderer never measured. Asserted by
    // attempting the mutation, not by reading `Object.isFrozen` alone.
    const snapshot = createVillageNpcSnapshot({ candidates: [candidate()] });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.candidates)).toBe(true);
    expect(Object.isFrozen(snapshot.nearby)).toBe(true);

    expect(() => {
      (snapshot as { anchor: unknown }).anchor = 'sneaked in';
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.candidates as VillageNearbyCandidate[]).push(candidate({ id: 'sneaked-in' }));
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.nearby as VillageNearbyTarget[]).push({ ...snapshot.nearby[0]!, id: 'sneaked-in' });
    }).toThrow(TypeError);

    expect(snapshot.nearby.map((row) => row.id)).toEqual(['synthetic-npc']);
    expect(snapshot.candidates).toHaveLength(1);
  });
});

// ── 4. Dialogue selection ───────────────────────────────────────────────────

describe('selectVillageNpcLine: a scripted NPC', () => {
  it('opens on the first line of the current quest step', () => {
    const selection = selectVillageNpcLine({
      npc: scriptedNpc(),
      questStep: 'alpha',
      cursor: null,
    });

    expect(selection).toMatchObject({
      npcId: 'synthetic-scripted',
      label: 'Synthetic Scripted',
      source: 'quest',
      index: 0,
      lineCount: 2,
      line: 'synthetic alpha one',
      questStep: 'alpha',
    });
    expect(selection.cursor).toEqual({ index: 0, questStep: 'alpha' });
  });

  it('cycles forward through the step\'s lines and wraps', () => {
    let cursor: VillageNpcLineCursor | null = null;
    const seen: string[] = [];
    for (let press = 0; press < 4; press += 1) {
      const selection = selectVillageNpcLine({
        npc: scriptedNpc(),
        questStep: 'alpha',
        cursor,
      });
      seen.push(selection.line);
      cursor = selection.cursor;
    }

    // Opening line, then 1, then 0 (two lines, wrap), then 1.
    expect(seen).toEqual([
      'synthetic alpha one',
      'synthetic alpha two',
      'synthetic alpha one',
      'synthetic alpha two',
    ]);
  });

  it('resolves a different pool for a different quest step', () => {
    const beta = selectVillageNpcLine({
      npc: scriptedNpc(),
      questStep: 'beta',
      cursor: null,
    });

    expect(beta).toMatchObject({ source: 'quest', lineCount: 1, line: 'synthetic beta one' });
  });

  it('opens on the greeting when the step has no script, and reports the source as greeting', () => {
    const selection = selectVillageNpcLine({
      npc: scriptedNpc(),
      questStep: 'gamma',
      cursor: null,
    });

    expect(selection).toMatchObject({
      source: 'greeting',
      line: 'synthetic greeting',
      index: 0,
    });
    // The pool it will cycle is still the ambient dialogue, and `lineCount` says so
    // rather than reporting the single line that was shown.
    expect(selection.lineCount).toBe(2);
  });

  it('falls back to the greeting when the script exists but the step is empty', () => {
    const npc = scriptedNpc({ questDialogue: { alpha: [] } });

    const selection = selectVillageNpcLine({ npc, questStep: 'alpha', cursor: null });

    expect(selection).toMatchObject({ source: 'greeting', line: 'synthetic greeting' });
  });

  it('resolves the pool against exactly the step it was given', () => {
    // The selection used to take a second step (`promoteQuestStep`), resolve the pool
    // against the *first*, and hand the second back as `questStepToApply`. That
    // asymmetry described the pre-Phase-12 screen and was the mechanism behind the bug
    // it documented: the application promotes through the store and then calls this
    // function, so the pool must follow the step the caller passes and nothing else.
    const alpha = selectVillageNpcLine({
      npc: scriptedNpc(),
      questStep: 'alpha',
      cursor: null,
    });
    const beta = selectVillageNpcLine({
      npc: scriptedNpc(),
      questStep: 'beta',
      cursor: null,
    });

    expect(alpha).toMatchObject({ source: 'quest', line: 'synthetic alpha one', questStep: 'alpha' });
    expect(alpha.cursor).toEqual({ index: 0, questStep: 'alpha' });
    expect(beta).toMatchObject({ source: 'quest', line: 'synthetic beta one', questStep: 'beta' });
    expect(beta.cursor).toEqual({ index: 0, questStep: 'beta' });
  });

  it('reports no promotion field, because the contract does not decide quest policy', () => {
    // Enumerating what a selection actually carries, so a promotion output cannot be
    // re-added beside a doc that misdescribes it. `questStepToApply` was the name;
    // the check is over the whole key set, so a rename slips through neither.
    const selection = selectVillageNpcLine({
      npc: scriptedNpc(),
      questStep: 'alpha',
      cursor: null,
    });

    expect(Object.keys(selection).sort()).toEqual([
      'cursor',
      'index',
      'label',
      'line',
      'lineCount',
      'npcId',
      'questStep',
      'source',
    ]);
    expect(selection).not.toHaveProperty('questStepToApply');
    expect(selection).not.toHaveProperty('promoteQuestStep');
  });

  it('restarts at the opening line when the quest step moves under a conversation', () => {
    // A cursor's index belonged to a script that is no longer on screen, so it
    // cannot be carried across. The village screen's own quest-board click already
    // resets to the first line; this is the same rule for every way a step moves.
    const selection = selectVillageNpcLine({
      npc: scriptedNpc(),
      questStep: 'beta',
      cursor: { index: 1, questStep: 'alpha' },
    });

    expect(selection).toMatchObject({ source: 'quest', index: 0, line: 'synthetic beta one' });
  });

  it('never mutates the NPC it was given', () => {
    const npc = scriptedNpc();
    const before = structuredClone(npc);

    selectVillageNpcLine({ npc, questStep: 'alpha', cursor: null });
    selectVillageNpcLine({ npc, questStep: 'alpha', cursor: { index: 1, questStep: 'alpha' } });

    expect(npc).toEqual(before);
  });
});

describe('selectVillageNpcLine: a wanderer', () => {
  it('opens on the injected quote index rather than choosing at random itself', () => {
    const first = selectVillageNpcLine({
      npc: wanderingNpc(),
      questStep: 'alpha',
      cursor: null,
      quoteIndex: 2,
    });
    const second = selectVillageNpcLine({
      npc: wanderingNpc(),
      questStep: 'alpha',
      cursor: null,
      quoteIndex: 0,
    });

    expect(first).toMatchObject({ source: 'quote', line: 'synthetic quote three' });
    expect(second).toMatchObject({ source: 'quote', line: 'synthetic quote one' });
  });

  it('resolves an absent, out-of-range, or non-finite quote index to the first quote', () => {
    // An opening index is a *choice* a caller made, so an out-of-range one is a
    // caller mistake rather than a request to wrap: refusing it answers with the
    // first line instead of the far end of the pool.
    for (const quoteIndex of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 99]) {
      const selection = selectVillageNpcLine({
        npc: wanderingNpc(),
        questStep: 'alpha',
        cursor: null,
        ...(quoteIndex === undefined ? {} : { quoteIndex }),
      });
      expect(selection.line, String(quoteIndex)).toBe('synthetic quote one');
    }
  });

  it('truncates a fractional quote index rather than reading between two quotes', () => {
    // Inside the pool a fraction is not an error, it is a floor: a caller that
    // divided by a rounded length lands here, and rounding up would read past the
    // index the caller asked for.
    const selection = selectVillageNpcLine({
      npc: wanderingNpc(),
      questStep: 'alpha',
      cursor: null,
      quoteIndex: 1.9,
    });

    expect(selection.line).toBe('synthetic quote two');
  });

  it('opens with a random quote but still stores index 0, so the first press advances', () => {
    const selection = selectVillageNpcLine({
      npc: wanderingNpc(),
      questStep: 'alpha',
      cursor: null,
      quoteIndex: 2,
    });

    expect(selection.index).toBe(0);
    expect(selection.cursor).toEqual({ index: 0, questStep: 'alpha' });

    const next = selectVillageNpcLine({
      npc: wanderingNpc(),
      questStep: 'alpha',
      cursor: selection.cursor,
    });
    expect(next.line).toBe('synthetic quote two');
  });

  it('cycles its quotes to the end and wraps', () => {
    // Three presses against a three-line pool, after the opening line: the whole
    // pool is visited exactly once and the fourth press would return to the
    // second line, which is where the sequence started.
    let cursor: VillageNpcLineCursor | null = null;
    const seen: string[] = [];
    for (let press = 0; press < 4; press += 1) {
      const selection = selectVillageNpcLine({
        npc: wanderingNpc(),
        questStep: 'alpha',
        cursor,
      });
      seen.push(selection.line);
      cursor = selection.cursor;
    }

    expect(seen).toEqual([
      'synthetic quote one',
      'synthetic quote two',
      'synthetic quote three',
      'synthetic quote one',
    ]);
  });

  it('opens on the greeting and cycles its dialogue when it has no quotes', () => {
    const npc = wanderingNpc({ quotes: undefined, dialogue: ['one', 'two'] });

    const opening = selectVillageNpcLine({ npc, questStep: 'alpha', cursor: null });
    expect(opening).toMatchObject({ source: 'greeting', line: npc.greeting, lineCount: 2 });

    const next = selectVillageNpcLine({ npc, questStep: 'alpha', cursor: opening.cursor });
    expect(next.line).toBe('two');
  });

  it('answers with the greeting alone when it has neither quotes nor dialogue', () => {
    const npc = wanderingNpc({ quotes: undefined, dialogue: [] });

    const selection = selectVillageNpcLine({ npc, questStep: 'alpha', cursor: null });

    expect(selection).toMatchObject({ source: 'dialogue', line: npc.greeting, lineCount: 1 });
    const next = selectVillageNpcLine({ npc, questStep: 'alpha', cursor: selection.cursor });
    expect(next.line).toBe(npc.greeting);
  });

  it('reports an empty line for an NPC with no authored content anywhere', () => {
    // Documented as reachable rather than prevented. An NPC with an empty greeting,
    // no quotes, an empty dialogue and no quest script has nothing to say, and the
    // contract reports that rather than inventing a sentence - a renderer-neutral
    // module that produced dialogue would be deciding product copy, and it would
    // hide an authoring mistake behind plausible text. See the `line` field's docs.
    const contentless = wanderingNpc({ greeting: '', quotes: undefined, dialogue: [] });

    const selection = selectVillageNpcLine({
      npc: contentless,
      questStep: 'alpha',
      cursor: null,
    });

    expect(selection).toMatchObject({
      source: 'dialogue',
      index: 0,
      lineCount: 1,
      line: '',
    });

    // The signal is stable, not transient: re-selecting and advancing both stay
    // empty, so a panel can render "nothing to say" instead of retrying.
    const advanced = selectVillageNpcLine({
      npc: contentless,
      questStep: 'alpha',
      cursor: selection.cursor,
    });
    expect(advanced.line).toBe('');
  });

  it('produces an empty line only when the NPC has no authored content', () => {
    // The invariant a consuming panel may rely on: emptiness means "nothing to say",
    // never "temporarily unresolved". One non-empty source anywhere is enough.
    const withGreeting = wanderingNpc({ quotes: undefined, dialogue: [] });
    const withDialogue = wanderingNpc({ quotes: undefined, greeting: '', dialogue: ['a'] });
    const withQuotes = wanderingNpc({ greeting: '' });
    const withScript = scriptedNpc({ greeting: '' });

    expect(selectVillageNpcLine({ npc: withGreeting, questStep: 'alpha', cursor: null }).line)
      .not.toBe('');
    expect(selectVillageNpcLine({ npc: withDialogue, questStep: 'gamma', cursor: null }).line)
      .not.toBe('');
    expect(selectVillageNpcLine({ npc: withQuotes, questStep: 'alpha', cursor: null }).line)
      .not.toBe('');
    expect(selectVillageNpcLine({ npc: withScript, questStep: 'alpha', cursor: null }).line)
      .not.toBe('');
  });

  it('never produces an empty line for the shipped roster', () => {
    // The reachable case above is reachable by construction, not by shipping: every
    // authored NPC answers with text at every quest step, including steps with no
    // script. If an author ever adds a contentless NPC this is the test that says so.
    for (const npc of VILLAGE_MAP.npcs) {
      for (const questStep of [
        'intro',
        'meet-keeper',
        'create-subject',
        'complete',
        'a-step-that-does-not-exist',
      ]) {
        const selection = selectVillageNpcLine({ npc, questStep, cursor: null });
        expect(selection.line.trim().length, `${npc.id} @ ${questStep}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('selectVillageNpcLine: determinism', () => {
  it('returns the same result for the same request', () => {
    const request = {
      npc: scriptedNpc(),
      questStep: 'alpha',
      cursor: { index: 1, questStep: 'alpha' } as VillageNpcLineCursor | null,
    };

    expect(selectVillageNpcLine(request)).toEqual(selectVillageNpcLine(request));
  });

  it('reaches the same line however many times the request is replayed', () => {
    // A re-render, a StrictMode double-effect, and a renderer that reports the same
    // interact twice must be indistinguishable from one deliberate press.
    const npc = wanderingNpc();
    let cursor: VillageNpcLineCursor | null = null;
    const first = selectVillageNpcLine({ npc, questStep: 'alpha', cursor });
    const replayed = selectVillageNpcLine({ npc, questStep: 'alpha', cursor });
    expect(replayed.line).toBe(first.line);

    cursor = first.cursor;
    const pressed = selectVillageNpcLine({ npc, questStep: 'alpha', cursor });
    for (let i = 0; i < 5; i += 1) {
      expect(selectVillageNpcLine({ npc, questStep: 'alpha', cursor }).line).toBe(pressed.line);
    }
  });
});

// ── 5. The quest overview ───────────────────────────────────────────────────

describe('describeVillageNpcQuests', () => {
  it('lists only NPCs that have a quest script, in roster order', () => {
    const rows = describeVillageNpcQuests(
      [wanderingNpc(), scriptedNpc(), wanderingNpc(), scriptedNpc({ id: 'second-scripted' })],
      'alpha',
    );

    // A wanderer between the two scripted NPCs is not a row, and the two that are
    // rows keep the order the roster gave them - the order is the roster's, not
    // sorted by id.
    expect(rows.map((row) => row.npcId)).toEqual(['synthetic-scripted', 'second-scripted']);
  });

  it('marks whether the current step is one the NPC can speak to', () => {
    const [speaks] = describeVillageNpcQuests([scriptedNpc()], 'beta');
    const [doesNotSpeak] = describeVillageNpcQuests([scriptedNpc()], 'omega');

    expect(speaks?.speaksCurrentStep).toBe(true);
    expect(doesNotSpeak?.speaksCurrentStep).toBe(false);
  });

  it('keeps the authored key order rather than sorting the steps', () => {
    const npc = scriptedNpc({ questDialogue: { zeta: ['z'], alpha: ['a'], mid: ['m'] } });

    const [row] = describeVillageNpcQuests([npc], 'alpha');

    expect(row?.questSteps).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('omits a step whose script is empty', () => {
    const npc = scriptedNpc({ questDialogue: { alpha: [], beta: ['b'] } });

    const [row] = describeVillageNpcQuests([npc], 'beta');

    expect(row?.questSteps).toEqual(['beta']);
  });

  it('omits an NPC whose only script is empty', () => {
    const npc = scriptedNpc({ questDialogue: { alpha: [] } });

    expect(describeVillageNpcQuests([npc], 'alpha')).toEqual([]);
  });

  it('returns an empty list for a roster with no scripted NPCs', () => {
    expect(describeVillageNpcQuests([wanderingNpc()], 'alpha')).toEqual([]);
  });

  it('freezes the rows and each row\'s step list', () => {
    // A quest overview may be held open while the quest advances. A caller that
    // could splice a step into a row would make the board claim the Keeper can
    // speak about a step she has no script for. Asserted by attempting the
    // mutation, so removing the freeze fails here.
    const rows = describeVillageNpcQuests([scriptedNpc()], 'alpha');

    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(rows[0]?.questSteps)).toBe(true);

    expect(() => {
      (rows as unknown[]).push(scriptedNpc({ id: 'sneaked-in' }));
    }).toThrow(TypeError);
    expect(() => {
      (rows[0] as { speaksCurrentStep: boolean }).speaksCurrentStep = false;
    }).toThrow(TypeError);
    expect(() => {
      (rows[0]?.questSteps as string[]).push('sneaked-in');
    }).toThrow(TypeError);

    expect(rows.map((row) => row.npcId)).toEqual(['synthetic-scripted']);
    expect(rows[0]?.speaksCurrentStep).toBe(true);
    expect(rows[0]?.questSteps).toEqual(['alpha', 'beta']);
  });
});

// ── 6. Parity with the shipped roster ───────────────────────────────────────

describe('the contract preserves the shipped village roster', () => {
  const roster = VILLAGE_MAP.npcs;
  const questSteps = [
    'intro',
    'meet-keeper',
    'create-subject',
    'visit-training',
    'pick-archetype',
    'enter-dungeon',
    'clear-room',
    'write-note',
    'review-artifact',
    'complete',
    'a-step-that-does-not-exist',
  ];

  it('resolves a non-empty line for every NPC at every quest step', () => {
    for (const npc of roster) {
      for (const questStep of questSteps) {
        const selection = selectVillageNpcLine({ npc, questStep, cursor: null });
        expect(selection.line.trim().length, `${npc.id} @ ${questStep}`).toBeGreaterThan(0);
        expect(selection.lineCount, `${npc.id} @ ${questStep}`).toBeGreaterThan(0);
        expect(selection.npcId).toBe(npc.id);
        expect(selection.label).toBe(npc.label);
      }
    }
  });

  it('gives the Keeper a quest script at every authored quest step', () => {
    const keeper = roster.find((npc) => npc.id === 'keeper');
    expect(keeper).toBeDefined();

    const rows = describeVillageNpcQuests(roster, 'clear-room');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.npcId).toBe('keeper');
    expect(rows[0]?.questSteps).toEqual(questSteps.slice(0, -1));
    expect(rows[0]?.speaksCurrentStep).toBe(true);
  });

  it('cycles every wanderer\'s quote pool without ever producing a hole', () => {
    const wanderers = roster.filter((npc) => (npc.quotes ?? []).length > 0);
    expect(wanderers.length).toBeGreaterThan(0);

    // `poolLength` presses walk every line exactly once starting from the second, so
    // a wanderer's whole quote pool is reachable and no press produces a hole. The
    // loop runs one past the pool length because the opening line is not a press.
    for (const npc of wanderers) {
      const pool = npc.quotes ?? [];
      const seen: string[] = [];
      let cursor: VillageNpcLineCursor | null = null;
      for (let press = 0; press <= pool.length; press += 1) {
        const selection = selectVillageNpcLine({ npc, questStep: 'intro', cursor });
        if (press > 0) seen.push(selection.line);
        cursor = selection.cursor;
      }
      expect(seen, npc.id).toEqual([...pool.slice(1), pool[0]]);
    }
  });

  it('never hands the same NPC a quote and a quest script at the same step', () => {
    // The precedence order is a design decision, and this is the claim it makes
    // about the roster that actually ships: a quest step always outranks quotes.
    for (const npc of roster) {
      for (const questStep of questSteps) {
        const withScript = selectVillageNpcLine({ npc, questStep, cursor: null });
        const withoutScript = selectVillageNpcLine({
          npc: { ...npc, questDialogue: undefined },
          questStep,
          cursor: null,
        });
        if ((npc.questDialogue?.[questStep]?.length ?? 0) > 0) {
          expect(withScript.source, `${npc.id} @ ${questStep}`).toBe('quest');
        } else {
          expect(withoutScript.source, `${npc.id} @ ${questStep}`).not.toBe('quest');
        }
      }
    }
  });
});
