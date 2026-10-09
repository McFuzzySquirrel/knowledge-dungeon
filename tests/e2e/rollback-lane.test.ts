/**
 * The Phase 23 rollback artifact: one build script, one flag table, and the lanes that use it.
 *
 * ## Why this file exists
 *
 * Before the cutover the *default* build was the rollback artifact, so a rollback lane could
 * preview `npm run build:web` and record `artifacts/web-artifact-manifest.json`. After the
 * cutover the default build is the cutover artifact, and a rollback claim verified against it
 * would be vacuous. `scripts/build-rollback.mjs` reproduces the previous release by flag, and
 * this gate is what keeps its flag table equal to `CUTOVER_FLAG_ROLLBACKS` - so a flag added
 * or a value changed in the contract without a matching change here is red, not silently
 * rolled back.
 *
 * ## What it does and does not prove
 *
 * It proves the *declaration* is consistent: every cutover flag is forced to its reviewed
 * pre-cutover value, the kill switch (`audioEnabled`) is deliberately not forced, the two
 * rollback lanes build and record this artifact, and the rollback manifest is not the
 * production one. It does not run a browser; the lanes themselves do. It reads the script as
 * source and the package scripts as JSON, and names no learner data.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ROLLBACK_FLAGS } from '../../scripts/build-rollback.mjs';
import {
  CUTOVER_FLAG_ROLLBACKS,
  CUTOVER_FLAG_KEYS,
  NON_CUTOVER_FLAG_KEYS,
} from '@/config/featureFlags';
import { RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const rollbackScriptSource = readFileSync(
  path.join(REPO_ROOT, 'scripts', 'build-rollback.mjs'),
  'utf8',
);

/** `CUTOVER_FLAG_ROLLBACKS`, expressed as the environment variables a build reads. */
const EXPECTED_ROLLBACK_FLAGS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    CUTOVER_FLAG_KEYS.map((key) => [
      RUNTIME_FLAG_ENV_KEYS[key],
      String(CUTOVER_FLAG_ROLLBACKS[key]),
    ]),
  ),
);

describe('the Phase 23 full-rollback build', () => {
  it('forces every cutover flag to its reviewed pre-cutover value, and no other flag', () => {
    expect({ ...ROLLBACK_FLAGS }).toEqual(EXPECTED_ROLLBACK_FLAGS);
    // The set of keys is exactly the reviewed cutover set: a flag added to the contract
    // without a rollback value here fails above, and one removed leaves an extra key.
    expect(new Set(Object.keys(ROLLBACK_FLAGS))).toEqual(
      new Set(CUTOVER_FLAG_KEYS.map((key) => RUNTIME_FLAG_ENV_KEYS[key])),
    );
    // `audioEnabled` is the one reviewed flag that is a kill switch rather than a cutover
    // rollback, so it must NOT be forced off by the rollback build.
    expect(NON_CUTOVER_FLAG_KEYS).toEqual(['audioEnabled']);
    expect(ROLLBACK_FLAGS).not.toHaveProperty(RUNTIME_FLAG_ENV_KEYS.audioEnabled);
  });

  it('writes the reviewed enum value and every boolean, and leaves the retained host switch unset', () => {
    expect(ROLLBACK_FLAGS.VITE_STORAGE_REPOSITORY).toBe('legacy');
    for (const key of CUTOVER_FLAG_KEYS) {
      if (key === 'storageRepository') continue;
      expect(
        ROLLBACK_FLAGS[RUNTIME_FLAG_ENV_KEYS[key]],
        `${RUNTIME_FLAG_ENV_KEYS[key]} must roll back to "false"`,
      ).toBe('false');
    }
    // `worldRenderer` is a retained host switch (`RETAINED_HOST_FLAG_KEYS`), not a
    // cutover: its default does not move at Phase 23, so the rollback build must not force
    // it, and the application host (`phaser`) is what an unset environment resolves to.
    expect(RUNTIME_FLAG_ENV_KEYS.worldRenderer).toBe('VITE_WORLD_RENDERER');
    expect(ROLLBACK_FLAGS).not.toHaveProperty(RUNTIME_FLAG_ENV_KEYS.worldRenderer);
  });

  it('is wired as its own package scripts, and does not touch the cutover default', () => {
    expect(packageJson.scripts['build:web:rollback']).toBe('node scripts/build-rollback.mjs');
    expect(packageJson.scripts['record:web-artifact:rollback']).toContain(
      'artifacts/web-artifact-manifest-rollback.json',
    );
    expect(packageJson.scripts['verify:web-artifact:rollback']).toContain(
      'artifacts/web-artifact-manifest-rollback.json',
    );
    // The default build must not force any flag: it is the cutover artifact.
    const defaultBuild = packageJson.scripts['build:web'];
    for (const envKey of Object.values(RUNTIME_FLAG_ENV_KEYS)) {
      expect(defaultBuild, `build:web must not set ${envKey}`).not.toContain(envKey);
    }
    // The rollback script spawns typecheck then vite build, like every other build script.
    expect(rollbackScriptSource).toContain("'typecheck'");
    expect(rollbackScriptSource).toContain("'vite', 'build'");
  });

  it('is the artifact both rollback lanes preview and record', () => {
    const assistanceFull = packageJson.scripts['test:e2e:assistance:default:full'];
    expect(assistanceFull).toContain('npm run build:web:rollback');
    expect(assistanceFull).toContain('npm run record:web-artifact:rollback');

    const fishingFull = packageJson.scripts['test:e2e:fishing:rollback:full'];
    expect(fishingFull).toContain('npm run build:web:rollback');
    expect(fishingFull).toContain('npm run record:web-artifact:rollback');

    // The rollback manifest is its own file, never the cutover production manifest.
    expect(packageJson.scripts['record:web-artifact:rollback']).not.toBe(
      packageJson.scripts['record:web-artifact'],
    );
  });

  it('names no learner data, request data, credential, or private URL', () => {
    // Only flag keys and the four enum/value literals may appear.
    const learnerDataPatterns = [
      /@[a-z0-9.-]+\.[a-z]{2,}/i,
      /https?:\/\/(?!127\.0\.0\.1|localhost)/i,
      /bearer|token|secret|password/i,
    ];
    for (const pattern of learnerDataPatterns) {
      expect(rollbackScriptSource).not.toMatch(pattern);
    }
  });
});
