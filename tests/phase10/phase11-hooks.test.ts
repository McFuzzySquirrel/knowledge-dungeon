/**
 * The Phase 11 hooks: exported now, called by nobody yet.
 *
 * ## Why this file exists
 *
 * Phase 10 exported `retainCustomSpriteUrl` from `src/services/customSprites.ts` and
 * documented it as the seam a Phase 11 Pixi world will use. It has no caller. That
 * is a deliberate, correct state — the Pixi consumer is a world scene that does not
 * exist yet — and it is also the state most likely to rot quietly:
 *
 * - an exported function with no caller looks *live* to a reader skimming the file,
 *   and gets deleted as dead code by the next tidy-up;
 * - or it gets wired up by a change that never reads the contract, and the lease
 *   semantics are discovered by a texture that loses its source in Phase 12.
 *
 * So the marker is a gate. This file asserts that the seam is exported, that its
 * contract is covered (by pointer, to the tests that actually exercise it), that it
 * still has **no** production caller, and that the source says in as many words
 * that it is pending. When Phase 11 wires it, the "no caller" assertion fails, and
 * whoever wires it has to look at the contract first.
 *
 * The contract itself — idempotent release, refusal on a retired URL, deferral past
 * a reset — is pinned by `tests/phase10/custom-sprite-overrides.test.ts`, which is
 * where the behaviour belongs. This file does not restate it; it asserts that the
 * behaviour has a gate, so the two cannot drift apart silently.
 *
 * ## Hermeticity
 *
 * Reads two committed source files and spawns nothing. No network, no `dist/`, no
 * git, no clock.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const CUSTOM_SPRITES_PATH = path.join(REPO_ROOT, 'src/services/customSprites.ts');
const SOURCE_ROOT = path.join(REPO_ROOT, 'src');

const source = readFileSync(CUSTOM_SPRITES_PATH, 'utf8');

/** Every committed module under `src/`, so a caller cannot hide in a new file. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...sourceFiles(absolute));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) found.push(absolute);
  }
  return found;
}

describe('retainCustomSpriteUrl is a documented Phase 11 hook, not live code', () => {
  it('is exported, with the reason it exists written next to it', () => {
    expect(source, 'the seam is exported').toContain('export function retainCustomSpriteUrl');
    // The documentation has to name the phase it is waiting for, or a reader cannot
    // tell a pending hook from a forgotten export.
    expect(
      source,
      'and says which phase consumes it',
    ).toMatch(/Phase 1\d/);
    expect(source, 'and says the Phaser path cannot express a lease').toMatch(/Phaser/);
  });

  it('still has no production caller, so the marker cannot rot into a live-looking export', () => {
    const callers = sourceFiles(SOURCE_ROOT)
      .filter((file) => file !== CUSTOM_SPRITES_PATH)
      .filter((file) => readFileSync(file, 'utf8').includes('retainCustomSpriteUrl'));

    expect(
      callers.map((file) => path.relative(REPO_ROOT, file)),
      'Phase 11 wires this. Until then it has no production caller, and the test that says so is the one that will be read when it does.',
    ).toEqual([]);
  });

  it('has a gate for its contract, and that gate is not this file', () => {
    // The behaviour is pinned elsewhere; this asserts the *pointer* exists so a
    // reader arriving at the marker can find it in one hop.
    const contract = readFileSync(
      path.join(REPO_ROOT, 'tests/phase10/custom-sprite-overrides.test.ts'),
      'utf8',
    );
    expect(contract, 'the lease contract is covered').toContain('retainCustomSpriteUrl');
    for (const behaviour of [
      'a release is idempotent, so a double release cannot double-revoke',
      'a lease on a retired URL is refused rather than resurrecting it',
      'a reset with a lease outstanding defers the revocation to the release',
      'a sprite with no override has nothing to lease',
    ]) {
      expect(contract, `the contract covers: ${behaviour}`).toContain(behaviour);
    }
  });
});
