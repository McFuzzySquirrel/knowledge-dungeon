#!/usr/bin/env node
/**
 * Builds the flagged artifact with the Phase 5 owner flag enabled.
 *
 * ## Why this script exists
 *
 * `.env.storage-v2` is a Phase 4 committed file and carries exactly one thing:
 * `VITE_STORAGE_REPOSITORY=v2`. Phase 5 adds a second, independent build-time flag,
 * `VITE_DATA_PRODUCTS_V2`, and the fresh-profile restore lane needs an artifact with
 * **both** on. The obvious ways to get there are both wrong:
 *
 * - Editing `.env.storage-v2` would make the Phase 4 lane's artifact carry the data
 *   products too, so "the Phase 4 lane runs against a product-free build" would stop
 *   being true of `npm run test:e2e:storage`, and the two phases would no longer be
 *   independently verifiable.
 * - Adding a second Vite mode means a second `.env` file, and that file would have
 *   to repeat `VITE_STORAGE_REPOSITORY=v2`. Two files declaring one flag is a drift
 *   waiting to happen, and the existing lane gates assert which env file carries it.
 *
 * So this script sets **only** the owner flag in the environment and delegates to
 * the existing flagged build. Vite resolves `import.meta.env.VITE_*` with
 * `process.env` taking priority over `.env` files, and `vite.config.ts` builds its
 * flag-validation environment as `{ ...loadEnv(mode), ...process.env }`, so the
 * value reaches both the application and the config-time validation.
 *
 * ## Why it is a script and not an inline assignment
 *
 * `VITE_DATA_PRODUCTS_V2=true vite build --mode storage-v2` in an npm script is a
 * POSIX shell assignment. It silently does nothing on Windows `cmd.exe`, and the
 * repository's own README notes that `.env.storage-v2` exists precisely so "no
 * shell-specific environment assignment is needed". Spawning from Node keeps the one
 * shell-specific thing out of the package scripts.
 *
 * ## What it deliberately does not do
 *
 * It does not typecheck, build, record, or preview. It only sets the environment and
 * runs the normal typecheck-then-build pair, so the artifact is byte-for-byte what
 * `build:storage-v2-flagged` produces plus one flag value. Every other step of the
 * release path stays where the package scripts put it.
 */

import { spawnSync } from 'node:child_process';

const OWNER_FLAG_KEY = 'VITE_DATA_PRODUCTS_V2';
const OWNER_FLAG_VALUE = 'true';
const BUILD_MODE = 'storage-v2';

/** The steps, in order, that the flagged build runs. */
const STEPS = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  {
    name: 'vite build',
    command: 'npx',
    args: ['vite', 'build', '--mode', BUILD_MODE],
  },
];

const environment = { ...process.env, [OWNER_FLAG_KEY]: OWNER_FLAG_VALUE };

console.log(
  `[build-flagged-data-products] ${OWNER_FLAG_KEY}=${OWNER_FLAG_VALUE} for --mode ${BUILD_MODE}; ` +
    'VITE_STORAGE_REPOSITORY still comes from .env.storage-v2',
);

for (const step of STEPS) {
  const result = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    env: environment,
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined) {
    console.error(`[build-flagged-data-products] ${step.name} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[build-flagged-data-products] ${step.name} exited with status ${String(result.status)}.`,
    );
    process.exit(result.status ?? 1);
  }
}
