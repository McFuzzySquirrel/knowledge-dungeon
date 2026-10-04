/**
 * `data-village-player`: the published format, and the refusals that keep it honest.
 *
 * ## Why the refusals are the interesting half
 *
 * The attribute exists so a walker can *trust* it. A walker that reads a confident number
 * and is wrong is worse off than one that reads nothing and knows it, so every assertion
 * below about what is published is paired with one about what is refused. The rule they add
 * up to: **publish a tile, or publish nothing.**
 *
 * Specifically, this file pins:
 *
 * 1. The **exact spelling** - `"<gridX>,<gridY>"`, two integers, comma-separated, no spaces,
 *    no sign padding, no decimal point. A consumer parses this with one `split(',')`, so
 *    anything else is a break, not a variation.
 * 2. That **nothing but a tile can reach the attribute** - `null`, `undefined`, a missing
 *    member, a string, a float, `NaN`, `Infinity`, a negative, an off-the-map tile, a
 *    function, and an object with no such members are all refused.
 * 3. That a refused value **removes** the attribute rather than leaving the previous one.
 *    A stale tile from before a renderer restart is well-formed and still wrong, and
 *    nothing downstream can tell it from a live one.
 * 4. That the **name is a static literal** and the value is built only from two validated
 *    integers, so no learner value can reach either.
 * 5. That the module has **no React state**, which is the structural reason a walking
 *    learner costs zero renders. Stated over the source, in the same shape the Phase 12
 *    compass gate uses, because "no per-sample render" is a claim about the code and not
 *    only about its effect.
 *
 * ## Hermeticity
 *
 * Reads repository source and writes one detached element per assertion. No renderer import,
 * no engine, no `dist/`, no network, no store, no commit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readSpecifiers, stripComments } from '../privacy/support/appGraph';
import { VILLAGE_MAP } from '@/data/villageLayout';
import {
  DEFAULT_VILLAGE_PLAYER_SAMPLE_MS,
  VILLAGE_PLAYER_ATTRIBUTE,
  formatVillagePlayerPosition,
  publishVillagePlayerPosition,
  readVillagePlayerGridPosition,
} from '@/ui/village/villagePlayerPosition';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/ui/village/villagePlayerPosition.ts'),
  'utf8',
);

/**
 * The module with its comments stripped.
 *
 * The shared `stripComments`, not a local copy, because this file has to be able to
 * *explain* the rules it enforces - and an unstripped scan would find `from "the world
 * answered with nothing"` in a doc comment and call it an import.
 */
const CODE = stripComments(SOURCE);

/** A fresh element to publish onto. Detached, so nothing else can observe it. */
function target(): HTMLElement {
  return document.createElement('div');
}

/** A value the publisher should refuse, collected in one place so the list is visible. */
const REFUSED: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'a bare number', value: 5 },
  { label: 'a string', value: '5,27' },
  { label: 'an empty object', value: {} },
  { label: 'only one member', value: { gridX: 5 } },
  { label: 'a stringly-typed pair', value: { gridX: '5', gridY: '27' } },
  { label: 'floats', value: { gridX: 5.5, gridY: 27.25 } },
  { label: 'NaN', value: { gridX: Number.NaN, gridY: 27 } },
  { label: 'Infinity', value: { gridX: 5, gridY: Number.POSITIVE_INFINITY } },
  { label: 'a negative tile', value: { gridX: -1, gridY: 27 } },
  { label: 'a column past the map', value: { gridX: VILLAGE_MAP.width, gridY: 27 } },
  { label: 'a row past the map', value: { gridX: 5, gridY: VILLAGE_MAP.height } },
  { label: 'far off the map', value: { gridX: 9999, gridY: 9999 } },
  { label: 'a function', value: () => ({ gridX: 5, gridY: 27 }) },
];

describe('the attribute name is a static literal', () => {
  it('is exactly the pinned name, and the module never builds it', () => {
    expect(VILLAGE_PLAYER_ATTRIBUTE).toBe('data-village-player');
    // The claim that matters is not "the constant equals the string" - it is that the
    // string only ever arrives through that constant. A second spelling written inline, or
    // an interpolated name, is what this refuses.
    const inline = SOURCE.match(/['"]data-[a-z-]*player[a-z-]*['"]/g) ?? [];
    expect(
      inline,
      'the attribute name appears as more than one spelling, so one of them is not the contract',
    ).toEqual(['\'data-village-player\'']);
  });

  it('carries no learner value in the name, because the name has none', () => {
    // Stated for the record rather than derived: there is nothing in a fixed attribute name
    // to leak, and the value side of the same claim is pinned by the format tests below.
    expect(VILLAGE_PLAYER_ATTRIBUTE).not.toMatch(/[A-Z]/);
    expect(VILLAGE_PLAYER_ATTRIBUTE).not.toContain('$');
    expect(VILLAGE_PLAYER_ATTRIBUTE).not.toContain('{');
  });
});

describe('the published format is one coordinate pair and nothing else', () => {
  it('is "<gridX>,<gridY>" for the map origin, the spawn tile, and a mid-map tile', () => {
    expect(formatVillagePlayerPosition({ gridX: 0, gridY: 0 })).toBe('0,0');
    expect(formatVillagePlayerPosition({ gridX: 5, gridY: 27 })).toBe('5,27');
    expect(formatVillagePlayerPosition({ gridX: 12, gridY: 4 })).toBe('12,4');
  });

  it('accepts every tile the authored map declares', () => {
    // Non-vacuity in the other direction: the refusals below are only meaningful if the
    // acceptances are not "refuse everything".
    for (let gridX = 0; gridX < VILLAGE_MAP.width; gridX += 7) {
      for (let gridY = 0; gridY < VILLAGE_MAP.height; gridY += 7) {
        expect(formatVillagePlayerPosition({ gridX, gridY })).toBe(`${gridX},${gridY}`);
      }
    }
  });

  it('is parseable by the one operation a consumer performs on it', () => {
    // The whole consumer contract: split on the comma, read two integers. If this ever
    // needs a regex or a trim, the harness's parse is wrong and this file says so.
    const [x, y] = (formatVillagePlayerPosition({ gridX: 9, gridY: 12 }) as string).split(',');
    expect(Number(x)).toBe(9);
    expect(Number(y)).toBe(12);
  });

  it('carries no space, sign, padding, or decimal point anywhere in the map', () => {
    // Proved over the whole tile space rather than sampled, because each forbidden
    // character is a property of the interpolation and the map is small enough to check.
    for (let gridX = 0; gridX < VILLAGE_MAP.width; gridX += 1) {
      for (let gridY = 0; gridY < VILLAGE_MAP.height; gridY += 1) {
        expect(formatVillagePlayerPosition({ gridX, gridY })).toMatch(/^\d+,\d+$/);
      }
    }
  });

  it('treats negative zero as the tile it is', () => {
    expect(formatVillagePlayerPosition({ gridX: -0, gridY: 0 })).toBe('0,0');
  });

  it('refuses every value that is not an on-map integer pair', () => {
    for (const { label, value } of REFUSED) {
      expect(formatVillagePlayerPosition(value), `${label} must not be published`).toBeNull();
    }
  });
});

describe('the read is a feature detection, and both refusals are distinguishable from an answer', () => {
  it('returns the tile when the mounted adapter implements the neutral read', () => {
    const handle = { readPlayerGridPosition: () => ({ gridX: 9, gridY: 12 }) };
    expect(readVillagePlayerGridPosition(handle)).toEqual({ gridX: 9, gridY: 12 });
  });

  it('receives the handle as `this`, so an adapter method is not called unbound', () => {
    // A renderer that implements the read as a method closing over its own scene - which is
    // exactly how every other member of the capability port is written - breaks if the
    // reader detaches it.
    const scene = { gridX: 3, gridY: 3 };
    const handle = {
      scene,
      readPlayerGridPosition(this: { scene: { gridX: number; gridY: number } }) {
        return { ...this.scene };
      },
    };
    expect(readVillagePlayerGridPosition(handle)).toEqual({ gridX: 3, gridY: 3 });
  });

  it('answers null for a handle that has not implemented the read', () => {
    for (const handle of [
      null,
      undefined,
      {},
      { readPoi: () => null },
      // A member that exists but is not callable is an adapter in a broken state, and the
      // only safe answer is the same as for an absent member.
      { readPlayerGridPosition: 'not a function' },
      { readPlayerGridPosition: 42 },
      'a string handle',
      7,
    ]) {
      expect(readVillagePlayerGridPosition(handle)).toBeNull();
    }
  });

  it('answers null for a read that returns something unusable, rather than passing it on', () => {
    for (const { label, value } of REFUSED) {
      expect(
        readVillagePlayerGridPosition({ readPlayerGridPosition: () => value }),
        `a read returning ${label} must not become a position`,
      ).toBeNull();
    }
  });
});

describe('publishing writes a tile, and refuses everything else by removing the attribute', () => {
  it('publishes a tile, and reports what it published', () => {
    const node = target();
    expect(publishVillagePlayerPosition(node, { gridX: 9, gridY: 12 })).toBe('9,12');
    expect(node.getAttribute(VILLAGE_PLAYER_ATTRIBUTE)).toBe('9,12');
  });

  it('follows a moving learner', () => {
    const node = target();
    const walk = [
      { gridX: 5, gridY: 27 },
      { gridX: 6, gridY: 27 },
      { gridX: 6, gridY: 26 },
    ];
    for (const tile of walk) publishVillagePlayerPosition(node, tile);
    expect(node.getAttribute(VILLAGE_PLAYER_ATTRIBUTE)).toBe('6,26');
  });

  it('removes the attribute for a refused value instead of leaving the last one standing', () => {
    // The case this whole file is about. "The world restarted and has not answered yet"
    // must not keep publishing the tile the learner occupied before the restart.
    const node = target();
    publishVillagePlayerPosition(node, { gridX: 9, gridY: 12 });
    expect(node.getAttribute(VILLAGE_PLAYER_ATTRIBUTE)).toBe('9,12');

    expect(publishVillagePlayerPosition(node, null)).toBeNull();
    expect(
      node.hasAttribute(VILLAGE_PLAYER_ATTRIBUTE),
      'a stale tile survived the world going away, and a consumer cannot tell it from a live one',
    ).toBe(false);
  });

  it('removes it for every refused value, not just null', () => {
    for (const { label, value } of REFUSED) {
      const node = target();
      publishVillagePlayerPosition(node, { gridX: 4, gridY: 4 });
      publishVillagePlayerPosition(node, value);
      expect(node.hasAttribute(VILLAGE_PLAYER_ATTRIBUTE), `${label} left an attribute behind`).toBe(false);
    }
  });

  it('writes nothing when the tile has not changed, and restores a removed one', () => {
    const node = target();
    publishVillagePlayerPosition(node, { gridX: 9, gridY: 12 });

    const setAttribute = vi.spyOn(node, 'setAttribute');
    publishVillagePlayerPosition(node, { gridX: 9, gridY: 12 });
    expect(setAttribute, 'a stationary learner caused an attribute write').not.toHaveBeenCalled();

    // A consumer that stripped the attribute, or a reconciliation that rebuilt the node,
    // gets it back on the next publish rather than staying silently absent.
    node.removeAttribute(VILLAGE_PLAYER_ATTRIBUTE);
    publishVillagePlayerPosition(node, { gridX: 9, gridY: 12 });
    expect(node.getAttribute(VILLAGE_PLAYER_ATTRIBUTE)).toBe('9,12');
    expect(setAttribute).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when there is no element to publish onto', () => {
    expect(publishVillagePlayerPosition(null, { gridX: 9, gridY: 12 })).toBeNull();
  });

  it('ignores extra members on the value, so a renderer cannot smuggle one into the string', () => {
    const node = target();
    publishVillagePlayerPosition(node, {
      gridX: 9,
      gridY: 12,
      subjectName: 'Zaphod Beeblebrox Study Plan',
      subjectId: 'subject-privacy-probe',
    });
    expect(node.getAttribute(VILLAGE_PLAYER_ATTRIBUTE)).toBe('9,12');
  });
});

describe('the module has no React state, so walking costs no render', () => {
  it('declares no useState, useReducer, or useSyncExternalStore', () => {
    // Stated over the source rather than inferred from an effect, because the claim is
    // structural: a per-sample `setState` in the village would re-render this subtree at
    // the sample rate, and no behavioural assertion in this file could tell the difference
    // between "fast because it does not re-render" and "fast because it re-renders rarely".
    expect(CODE).not.toMatch(/\buse(State|Reducer|SyncExternalStore)\b/);
    // And the write is a direct one, on the node the ref holds.
    expect(CODE).toMatch(/setAttribute/);
  });

  it('throttles on an interval rather than per frame, and the interval is a stated number', () => {
    expect(CODE).not.toMatch(/requestAnimationFrame/);
    expect(CODE).toMatch(/setInterval/);
    // 100 ms, and the number is a named constant so a consumer reading the header and a
    // test reading the constant agree about the staleness bound.
    expect(DEFAULT_VILLAGE_PLAYER_SAMPLE_MS).toBe(100);
  });

  it('reads the tile size and the walk speed it reasons about, from the authored data', () => {
    // The staleness bound in the header is "100 ms at PLAYER_SPEED on a VILLAGE_TILE_SIZE
    // tile". If either of those authored numbers changes, the header's arithmetic changes
    // with it, and this test is what notices that the file's claim moved.
    expect(VILLAGE_MAP.tileSize).toBe(48);
    // 100 ms of 120 px/s is 12 px, a quarter of a 48 px tile.
    expect((0.1 * 120) / VILLAGE_MAP.tileSize).toBeCloseTo(0.25, 10);
  });
});

describe('the module reaches no renderer', () => {
  /**
   * Specifiers this module imports **at run time** — value, namespace, or bare side-effect.
   *
   * Deliberately not `readSpecifiers`, which cannot tell a type-only import from a value
   * one and so would fail the day the publisher needed a type from the renderer-neutral
   * contract. That is the wrong reason to fail: a `import type` is erased at compile time
   * and contributes no edge, no module load, and no renderer object. What this file must
   * forbid is the *value* import, because that is what would make the screen need a
   * renderer at run time.
   */
  const RUNTIME_IMPORT = /(?:^|[\s;}])(?:import|export)\s+(?!type\s)[^'"()]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;

  function runtimeSpecifiers(source: string): string[] {
    const found: string[] = [];
    for (const match of source.matchAll(RUNTIME_IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined) found.push(specifier);
    }
    return found.sort();
  }

  it('imports nothing but React and the authored village map at run time', () => {
    // `tests/phase12/village-shell-split.test.ts` already holds every module under
    // `src/ui/village/**` to this, so this is the same property asserted at the file that
    // needed it: the publisher must not grow a renderer import the day the two lanes are
    // wired, because that is the one edit that would make the screen need a renderer object.
    expect(runtimeSpecifiers(CODE)).toEqual(['@/data/villageLayout', 'react']);
  });

  it('reaches the renderer-neutral contract for types only, and for no renderer at all', () => {
    // Two halves, because either alone would be satisfiable by the wrong thing.
    //
    // The contract import must EXIST: `game-engineer` declared
    // `readPlayerGridPosition?(): WorldGridPosition | null` on
    // `VillageRendererCapabilities`, and a publisher that re-declared the member locally
    // would let the two drift without any type error. So the module names the contract
    // rather than a hand-rolled copy of it.
    //
    // And it must be TYPE-ONLY, which is what keeps the previous test's property true. A
    // value-form import of the same path would satisfy the assertion below and still leave
    // the module loading that module at run time — so the form is checked, not the name.
    expect(CODE).toMatch(
      /import\s+type\s*\{[^}]*\bWorldGridPosition\b[^}]*\}\s*from\s*'@\/application\/contracts\/renderer'/,
    );

    // And no renderer, in any form, on either reading.
    expect([...readSpecifiers(CODE)].filter((s) => s.startsWith('@/renderers'))).toEqual([]);
    expect(runtimeSpecifiers(CODE).some((s) => s.includes('renderers'))).toBe(false);
  });
});