/**
 * QA's probe of the Phase 15 deliverable "Artifact collection event for Pixi Dungeon".
 *
 * ## The defect the orchestrator reports fixing
 *
 * `GameScreen` used to pass `phase === 'archaeologist'` as the second argument of
 * `renderer.setArtifactRooms(...)`. That argument is `pickupPermitted` - "may an artifact be
 * picked up right now" - and answering it from the phase meant the Scribe phase, which is
 * where an artifact is *generated*, refused the pickup. A learner who had just earned an
 * artifact had no way to take it.
 *
 * It is now a named `HOST_PERMITS_ARTIFACT_PICKUP` constant.
 *
 * ## What this file measures
 *
 * 1. **The rule itself, at the pure layer.** `resolveDungeonArtifactMarker` is the single
 *    decision, and the renderer's `visible` input is what it reads. The state matrix is
 *    asserted exhaustively - 8 combinations - because "it works in the one case we tried" is
 *    the usual way a three-state rule ships a hole.
 * 2. **The host's answer, in the Scribe phase.** With `pickupPermitted` true and an artifact
 *    present and uncollected, a room *in the Scribe phase* reports `collectible`, so the
 *    canvas marker is drawn and the pickup is offered. The phase is not an input to the
 *    rule, so this is measured by showing the rule has no phase term at all.
 * 3. **The host wiring.** `GameScreen` publishes the constant, not a phase comparison, and
 *    the already-collected room still reports `collected` regardless of permission, so a
 *    learner who picked an artifact up in Scribe is not re-offered it in Archaeologist.
 *
 * Hermeticity: no renderer, no canvas, no `dist/`, no clock. The pure rule is exercised
 * directly and the host wiring is read from source, because `GameScreen` builds its renderer
 * handle at module scope and cannot be mounted without a canvas.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DUNGEON_ARTIFACT_ACTION_ID,
  DUNGEON_ARTIFACT_ACTION_LABEL,
  IDLE_DUNGEON_ARTIFACT_SNAPSHOT,
  createDungeonArtifactSnapshot,
  describeDungeonArtifactMarkerSuffix,
  isDungeonArtifactMarkerDrawn,
  resolveDungeonArtifactMarker,
  type DungeonArtifactMarkerState,
} from '@/renderers/pixi/dungeon/dungeonArtifact';

const NOW = '2026-03-04T05:06:07.000Z';

function repoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('the artifact marker rule, exhaustively', () => {
  const STATES: DungeonArtifactMarkerState[] = ['none', 'collectible', 'collected'];

  it('assigns all eight combinations exactly one state, with the documented precedence', () => {
    const expected: Array<[boolean, boolean, boolean, DungeonArtifactMarkerState]> = [
      // pickupPermitted, hasArtifact, collected -> state
      [false, false, false, 'none'],
      [false, false, true, 'collected'],
      [false, true, false, 'none'],
      [false, true, true, 'collected'],
      [true, false, false, 'none'],
      [true, false, true, 'collected'],
      [true, true, false, 'collectible'],
      [true, true, true, 'collected'],
    ];
    expect(expected).toHaveLength(8);
    for (const [pickupPermitted, hasArtifact, collected, state] of expected) {
      expect(
        resolveDungeonArtifactMarker({ pickupPermitted, hasArtifact, collected }),
        `pickupPermitted=${pickupPermitted} hasArtifact=${hasArtifact} collected=${collected}`,
      ).toBe(state);
    }
  });

  it('draws the marker in exactly one of the three states', () => {
    expect(STATES.filter(isDungeonArtifactMarkerDrawn)).toEqual(['collectible']);
  });

  it('gives every state words, and no state a bare glyph', () => {
    const suffixes = STATES.map(describeDungeonArtifactMarkerSuffix);
    // 'none' says nothing, so a room with nothing to offer reads as its topic alone.
    expect(suffixes[0]).toBe('');
    expect(suffixes[1]).toMatch(/artifact ready to collect/i);
    expect(suffixes[2]).toMatch(/artifact collected/i);
    for (const suffix of suffixes) {
      expect(suffix).not.toMatch(/[✓✗✘✔]/);
    }
  });

  it('publishes one answer for state and canCollect, so a control cannot disagree with the canvas', () => {
    const snapshot = createDungeonArtifactSnapshot({
      roomId: 'r-target',
      topic: 'Linked Lists',
      pickupPermitted: true,
      hasArtifact: true,
      collected: false,
      withinPickupRange: true,
      rooms: [],
    });
    expect(snapshot.state).toBe('collectible');
    expect(snapshot.canCollect).toBe(true);
    expect(snapshot.markerVisible).toBe(true);
    // One sentence for a mirror to announce.
    expect(snapshot.sentence).toMatch(/artifact ready to collect in linked lists/i);
    expect(snapshot.label).toMatch(/linked lists · artifact ready to collect/i);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rooms)).toBe(true);
  });

  it('says an artifact exists even when the host forbids the pickup', () => {
    // "There is nothing here" and "there is something you cannot take" are different facts,
    // and a learner who has just cleared a room is told the second one.
    const snapshot = createDungeonArtifactSnapshot({
      roomId: 'r-target',
      topic: 'Linked Lists',
      pickupPermitted: false,
      hasArtifact: true,
      collected: false,
      withinPickupRange: false,
      rooms: [],
    });
    expect(snapshot.state).toBe('none');
    expect(snapshot.canCollect).toBe(false);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.sentence).toMatch(/an artifact waits in linked lists/i);
  });

  it('keeps a collected artifact collected even when pickup is later forbidden', () => {
    // The precedence that makes a learner who picked it up in Scribe not be re-offered it.
    const snapshot = createDungeonArtifactSnapshot({
      roomId: 'r-target',
      topic: 'Linked Lists',
      pickupPermitted: false,
      hasArtifact: true,
      collected: true,
      withinPickupRange: false,
      rooms: [],
    });
    expect(snapshot.state).toBe('collected');
    expect(snapshot.canCollect).toBe(false);
    expect(snapshot.sentence).toMatch(/artifact collected from linked lists/i);
  });

  it('has an idle snapshot with an answer for every field', () => {
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.state).toBe('none');
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.canCollect).toBe(false);
    expect(IDLE_DUNGEON_ARTIFACT_SNAPSHOT.sentence).toMatch(/no artifact to collect/i);
  });

  it('declares the pickup action id and its accessible name', () => {
    expect(DUNGEON_ARTIFACT_ACTION_ID).toBe('dungeon-collect-artifact');
    expect(DUNGEON_ARTIFACT_ACTION_LABEL).toBe('Collect artifact');
  });
});

describe('the host wiring, in the Scribe phase', () => {
  it('publishes a named constant rather than a phase comparison', () => {
    const source = repoFile('src/ui/screens/GameScreen.tsx');
    expect(source).toContain('const HOST_PERMITS_ARTIFACT_PICKUP = true;');
    expect(source).toContain('renderer.setArtifactRooms(artifactRoomIds, HOST_PERMITS_ARTIFACT_PICKUP)');
    // The old shape must be gone everywhere, not merely renamed in one call.
    expect(source).not.toMatch(/setArtifactRooms\([^)]*phase ===/);
  });

  it('no renderer module compares a phase to decide whether a pickup is permitted', () => {
    // `dungeonArtifact.ts` states this as a rule. A phase comparison anywhere under
    // `src/renderers/**` would reintroduce exactly the defect the constant replaced, in the
    // one place that must never know the vocabulary.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const text = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/phase\s*===\s*'(scribe|archaeologist|creator)'/.test(text)) offenders.push(full);
      }
    };
    walk(join(process.cwd(), 'src/renderers'));
    expect(offenders).toEqual([]);
  });

  it('a room the learner just cleared in Scribe is collectible, with no phase input at all', () => {
    // The whole point: the rule takes three booleans, so the Scribe phase cannot appear in it.
    // Comments are stripped first: the file's own header names `phase === 'scribe'` as the
    // thing it refuses to write, so a raw-text scan would report its documentation.
    const source = repoFile('src/renderers/pixi/dungeon/dungeonArtifact.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/\bphase\b\s*[:=]/);
    // ...and the prohibition is still written down, so the rule cannot be quietly deleted.
    expect(repoFile('src/renderers/pixi/dungeon/dungeonArtifact.ts')).toContain(
      'Why there is no phase in this file',
    );
    const snapshot = createDungeonArtifactSnapshot({
      roomId: 'r-target',
      topic: 'Linked Lists',
      pickupPermitted: true,
      hasArtifact: true,
      collected: false,
      withinPickupRange: false,
      rooms: [],
    });
    expect(snapshot.canCollect).toBe(true);
    void NOW;
  });
});