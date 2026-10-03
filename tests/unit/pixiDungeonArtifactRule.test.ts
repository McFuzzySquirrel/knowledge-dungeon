/**
 * The dungeon artifact rule, on its own: no canvas, no renderer, no phase.
 *
 * ## Why this file is separate from the scene test
 *
 * `tests/phase13/dungeon-scene.test.ts` proves the marker is drawn; this file proves *when*
 * it should be, which is the part that Phase 15 got wrong and the part that a scene graph
 * cannot show. A marker that is correctly absent and a marker that is wrongly absent draw
 * the same empty `Graphics`, so the decision has to be asserted where it is made - as a
 * pure function over three facts.
 *
 * ## The three facts, and the one thing this file refuses to accept
 *
 * `hasArtifact`, `collected`, and `pickupPermitted`. There is deliberately no fourth, and
 * the last test here is the gate for that: no module in `src/renderers/pixi/dungeon/` may
 * import the session store, a phase enum, or anything else that knows what phase the
 * session is in. The rule is that the host pushes the answer in as data; a renderer that
 * could compare a phase itself is the one place the two renderers would drift over the
 * study flow's vocabulary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DUNGEON_ARTIFACT_ACTION_ID,
  DUNGEON_ARTIFACT_ACTION_LABEL,
  IDLE_DUNGEON_ARTIFACT_SNAPSHOT,
  createDungeonArtifactSnapshot,
  describeDungeonArtifactMarkerSuffix,
  isDungeonArtifactMarkerDrawn,
  resolveDungeonArtifactMarker,
} from '../../src/renderers/pixi/dungeon/dungeonArtifact';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DUNGEON_TREE = path.join(REPO_ROOT, 'src/renderers/pixi/dungeon');

/**
 * Remove comments the way the repository's other source gates do.
 *
 * Needed because this file is allowed to *explain* the rules it checks - a docblock that
 * says "a renderer may not compare a phase" must not itself be the finding.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

/* ── The rule ──────────────────────────────────────────────────────────────── */

describe('the marker rule', () => {
  it('offers a pickup whenever an artifact exists and pickup is permitted', () => {
    expect(
      resolveDungeonArtifactMarker({
        pickupPermitted: true,
        hasArtifact: true,
        collected: false,
      }),
    ).toBe('collectible');
  });

  /**
   * The Phase 15 defect, stated as a rule.
   *
   * Generation happens in the Scribe phase - `encounter/note-submit` clears the room,
   * writes `artifactMarkdown`, and moves it to `ArtifactCollected` - so a learner who has
   * just written a note is standing in a room where an artifact exists and has not been
   * collected. The marker must be there, because pickup is a separate action that happens
   * *later*, and a world that hides the thing until a later phase has collapsed the two
   * actions into one gate.
   */
  it('offers the pickup in the phase the artifact is generated in', () => {
    // A note has just cleared the room: artifact generated, nothing collected yet.
    const afterGeneration = resolveDungeonArtifactMarker({
      pickupPermitted: true,
      hasArtifact: true,
      collected: false,
    });
    expect(afterGeneration).toBe('collectible');
    // The same room once picked up, and in a later phase where pickup is permitted again.
    expect(
      resolveDungeonArtifactMarker({
        pickupPermitted: true,
        hasArtifact: true,
        collected: true,
      }),
    ).toBe('collected');
  });

  it('never re-offers a collected artifact, whatever the pickup gate says', () => {
    for (const pickupPermitted of [true, false]) {
      for (const hasArtifact of [true, false]) {
        expect(
          resolveDungeonArtifactMarker({ pickupPermitted, hasArtifact, collected: true }),
          `pickupPermitted=${pickupPermitted} hasArtifact=${hasArtifact}`,
        ).toBe('collected');
      }
    }
  });

  it('offers nothing when there is no artifact, or when pickup is not permitted', () => {
    expect(
      resolveDungeonArtifactMarker({
        pickupPermitted: true,
        hasArtifact: false,
        collected: false,
      }),
    ).toBe('none');
    // An artifact exists, but the host has not permitted a pickup in this phase. That is
    // not the same as "collected", and it is not the same as "no artifact": the snapshot
    // keeps both facts so a surface can say which.
    expect(
      resolveDungeonArtifactMarker({
        pickupPermitted: false,
        hasArtifact: true,
        collected: false,
      }),
    ).toBe('none');
  });

  it('draws the marker for exactly one of its three states', () => {
    const drawn = (['none', 'collectible', 'collected'] as const).filter(
      isDungeonArtifactMarkerDrawn,
    );
    expect(drawn).toEqual(['collectible']);
  });
});

/* ── The words ─────────────────────────────────────────────────────────────── */

describe('the words', () => {
  it('names all three states, and stays silent when there is nothing to say', () => {
    expect(describeDungeonArtifactMarkerSuffix('collectible')).toBe(' · artifact ready to collect');
    expect(describeDungeonArtifactMarkerSuffix('collected')).toBe(' · artifact collected');
    expect(describeDungeonArtifactMarkerSuffix('none')).toBe('');
  });

  it('says something a screen reader can read for every state of a room with an artifact', () => {
    // A suffix of `''` for `none` is only acceptable because *nothing* is being offered:
    // the room has no artifact at all, so its label is exactly the topic it always had.
    for (const state of ['collectible', 'collected'] as const) {
      const suffix = describeDungeonArtifactMarkerSuffix(state);
      expect(suffix).not.toBe('');
      // Letters, not a glyph: `✓` is what this replaced, and it is invisible to a screen
      // reader and ambiguous to a learner who cannot separate the hues.
      expect(suffix).toMatch(/[A-Za-z]/);
    }
  });
});

/* ── The snapshot a DOM surface renders ────────────────────────────────────── */

describe('the snapshot', () => {
  function snapshotFor(
    overrides: Partial<Parameters<typeof createDungeonArtifactSnapshot>[0]> = {},
  ) {
    return createDungeonArtifactSnapshot({
      roomId: 'child-1',
      topic: 'Child Topic 1',
      pickupPermitted: true,
      hasArtifact: true,
      collected: false,
      withinPickupRange: false,
      rooms: [],
      ...overrides,
    });
  }

  it('agrees with the rule on what may be collected, in one place', () => {
    const collectible = snapshotFor();
    expect(collectible.state).toBe('collectible');
    expect(collectible.canCollect).toBe(true);
    expect(collectible.markerVisible).toBe(true);
    expect(collectible.label).toBe('Child Topic 1 · artifact ready to collect');
    expect(collectible.sentence).toBe('Artifact ready to collect in Child Topic 1.');

    const collected = snapshotFor({ collected: true });
    expect(collected.state).toBe('collected');
    expect(collected.canCollect).toBe(false);
    expect(collected.markerVisible).toBe(false);
    expect(collected.sentence).toBe('Artifact collected from Child Topic 1.');
  });

  it('distinguishes "no artifact" from "an artifact you cannot collect here"', () => {
    // The two are different facts, and collapsing them would tell a learner who has just
    // written a note that there is nothing there.
    expect(snapshotFor({ hasArtifact: false }).sentence).toBe('No artifact to collect in Child Topic 1.');
    expect(snapshotFor({ pickupPermitted: false }).sentence).toBe(
      'An artifact waits in Child Topic 1. Collecting is not available in this view.',
    );
  });

  it('is total before there is a world, rather than undefined', () => {
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.roomId).toBeNull();
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.state).toBe('none');
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.canCollect).toBe(false);
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.rooms).toEqual([]);
    // Every field is an answer, so a control that mounts before the scene is built needs
    // no `undefined` branch three property reads later.
    for (const [key, value] of Object.entries(IDLE_DUNGEON_ARTIFACT_SNAPSHOT)) {
      expect(value, key).not.toBeUndefined();
    }
  });

  it('freezes itself and its room list', () => {
    const snapshot = snapshotFor({
      rooms: [{ roomId: 'child-1', topic: 'Child Topic 1', state: 'collectible', label: 'Child Topic 1 · artifact ready to collect' }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rooms)).toBe(true);
  });

  it('names the action a DOM control dispatches, and it is not a world phase', () => {
    expect(DUNGEON_ARTIFACT_ACTION_ID).toBe('dungeon-collect-artifact');
    expect(DUNGEON_ARTIFACT_ACTION_LABEL).toBe('Collect artifact');
  });
});

/* ── The boundary this rule depends on ─────────────────────────────────────── */

describe('the renderer holds no phase of its own', () => {
  function sourceFilesIn(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...sourceFilesIn(full));
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
    return found.sort();
  }

  /**
   * Specifiers that would let a dungeon module answer "is pickup permitted right now?"
   * by itself. The store and the session config hold the phase; the UI tree holds the
   * surfaces that render it. None of them may be reachable from here.
   */
  const PHASE_BEARING_SPECIFIERS: readonly RegExp[] = [
    /^@\/store(\/|$)/,
    /^@\/config(\/|$)/,
    /^@\/ui(\/|$)/,
    /^@\/game(\/|$)/,
    // A relative reach into those trees, which the alias rule does not catch.
    /(^|\/)\.\.\/(store|config|ui|game)(\/|$)/,
  ];

  const specifiersIn = (source: string): string[] => {
    const found: string[] = [];
    for (const pattern of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g]) {
      for (const match of stripComments(source).matchAll(pattern)) found.push(match[1]);
    }
    return found;
  };

  it('reaches neither the session store nor a phase vocabulary from the dungeon tree', () => {
    const files = sourceFilesIn(DUNGEON_TREE);
    expect(files.length).toBeGreaterThan(4);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of specifiersIn(source)) {
        if (PHASE_BEARING_SPECIFIERS.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders, 'a dungeon module may not know what phase the session is in').toEqual([]);
  });

  it('has no phase literal in the rule at all', () => {
    // Comments are stripped because this file is allowed to *explain* the rule it checks:
    // the module's docblock names the Scribe and Archaeologist phases at length, and a
    // comment that says "no phase here" must not itself be the finding.
    //
    // Scanned as *quoted literals*, not as substrings. `describeDungeonArtifact…` contains
    // the letters `scribe`, so a substring scan would fail on this repository's own naming
    // and the gate would be theatre. What must not appear is the value - `'scribe'` - which
    // is the only form a phase comparison could take.
    const code = stripComments(readFileSync(path.join(DUNGEON_TREE, 'dungeonArtifact.ts'), 'utf8'));
    for (const phase of ['scribe', 'archaeologist', 'creator']) {
      expect(code, `dungeonArtifact.ts compares against the ${phase} phase`).not.toMatch(
        new RegExp(`['"\`]${phase}['"\`]`),
      );
    }
  });
});