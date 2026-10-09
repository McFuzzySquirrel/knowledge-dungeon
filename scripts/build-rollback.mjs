#!/usr/bin/env node
/**
 * Builds the Phase 23 full-rollback artifact.
 *
 * ## What it sets
 *
 * Every cutover flag forced to its pre-cutover value, declared in
 * `CUTOVER_FLAG_ROLLBACKS` in `src/config/featureFlags.ts`:
 *
 *   VITE_STORAGE_REPOSITORY=legacy
 *   VITE_PIXI_VILLAGE=false
 *   VITE_PIXI_DUNGEON=false
 *   VITE_PIXI_FISHING=false
 *   VITE_COZY_VISUALS=false
 *   VITE_ADAPTIVE_ASSISTANCE=false
 *   VITE_DATA_PRODUCTS_V2=false
 *   VITE_WEB_SHARE=false
 *   VITE_CREATOR_WORKSPACE=false
 *   VITE_SCRIBE_ENCOUNTER_WORKSPACE=false
 *   VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=false
 *   VITE_OFFLINE_SHELL=false
 *
 * `VITE_AUDIO_ENABLED` is deliberately not set. It is a kill switch rather than a
 * cutover rollback (`NON_CUTOVER_FLAG_KEYS`), so the rollback artifact keeps the
 * audio service at its default and rolls back only the behaviour the cutover changed.
 *
 * `VITE_WORLD_RENDERER` is deliberately not set either. It is a retained host switch
 * (`RETAINED_HOST_FLAG_KEYS`), not a cutover: its default does not move at Phase 23, so
 * leaving it unset keeps the application host (`phaser`) exactly as the previous
 * release shipped it.
 *
 * ## Why this exists now
 *
 * Before the Phase 23 cutover the *default* build was the rollback artifact, so a
 * rollback lane could preview `npm run build:web`. After the cutover the default
 * build is the cutover artifact, and a rollback claim verified against it would be
 * vacuous. This script is the artifact the rollback lanes preview: the same build
 * the previous release shipped, reproduced by flag rather than by reverting source.
 *
 * ## Why a script and not an inline assignment
 *
 * A dozen POSIX `VAR=value` assignments in an npm script silently do nothing on
 * Windows `cmd.exe`. `scripts/build-flagged-data-products.mjs` and
 * `scripts/build-offline-shell.mjs` solve the same problem the same way: spawn the
 * real build from Node with an augmented environment, `process.env` taking priority
 * over `.env` files in `vite.config.ts`'s merged flag environment.
 *
 * ## What it deliberately does not do
 *
 * It does not record, verify, or preview. It only typechecks and builds, so the
 * artifact is what `build:web` would produce with the pre-cutover flags, and every
 * other step stays where the package scripts put it.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Every cutover flag and its pre-cutover value.
 *
 * Kept as a literal table rather than imported from `src/config/featureFlags.ts`
 * because this file is plain ESM run by `node`, which does not load a TypeScript
 * module. `tests/e2e/rollback-lane.test.ts` asserts this table equals
 * `CUTOVER_FLAG_ROLLBACKS`, key for key and value for value, so the two cannot
 * drift without a red test naming the difference.
 */
export const ROLLBACK_FLAGS = Object.freeze({
  VITE_STORAGE_REPOSITORY: 'legacy',
  VITE_PIXI_VILLAGE: 'false',
  VITE_PIXI_DUNGEON: 'false',
  VITE_PIXI_FISHING: 'false',
  VITE_COZY_VISUALS: 'false',
  VITE_ADAPTIVE_ASSISTANCE: 'false',
  VITE_DATA_PRODUCTS_V2: 'false',
  VITE_WEB_SHARE: 'false',
  VITE_CREATOR_WORKSPACE: 'false',
  VITE_SCRIBE_ENCOUNTER_WORKSPACE: 'false',
  VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE: 'false',
  VITE_OFFLINE_SHELL: 'false',
});

const STEPS = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'vite build', command: 'npx', args: ['vite', 'build'] },
];

/**
 * Run the flag-augmented build. Only called when this file is the entry point.
 *
 * Guarded so `tests/e2e/rollback-lane.test.ts` can import {@link ROLLBACK_FLAGS}
 * without spawning a build during test collection.
 */
export function runRollbackBuild() {
  const environment = { ...process.env, ...ROLLBACK_FLAGS };

  console.log(
    `[build-rollback] forcing ${Object.keys(ROLLBACK_FLAGS).length} cutover flag(s) to their ` +
      'pre-cutover values; VITE_AUDIO_ENABLED is left at its default because it is a kill switch.',
  );

  for (const step of STEPS) {
    const result = spawnSync(step.command, step.args, {
      stdio: 'inherit',
      env: environment,
      shell: process.platform === 'win32',
    });
    if (result.error !== undefined) {
      console.error(`[build-rollback] ${step.name} could not start: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`[build-rollback] ${step.name} exited with status ${String(result.status)}.`);
      process.exit(result.status ?? 1);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runRollbackBuild();
}
