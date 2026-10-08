#!/usr/bin/env node
/**
 * Builds the offline-shell flagged artifact (Phase 22).
 *
 * ## What it sets
 *
 * Exactly one Phase 22 flag: `VITE_OFFLINE_SHELL=true`. The storage flag comes from
 * `.env.storage-v2`, so the offline proof runs on a build whose learner data really
 * lives in the storage-v2 IndexedDB generation rather than in the legacy
 * `localStorage` mirror. `--mode storage-v2` is what loads that file.
 *
 * ## Why a script and not an inline assignment
 *
 * `VITE_OFFLINE_SHELL=true vite build --mode storage-v2` is a POSIX shell
 * assignment that silently does nothing on Windows `cmd.exe`. The repository's own
 * precedent (`scripts/build-flagged-data-products.mjs`) solves the same problem the
 * same way: spawn the real build from Node with an augmented environment, so the
 * one shell-specific thing stays out of the package scripts.
 *
 * ## Why it does not duplicate `VITE_STORAGE_REPOSITORY`
 *
 * Setting the storage flag here as well would put one flag in two files and give
 * the build and `.env.storage-v2` a chance to disagree. It stays in the env file
 * that already owns it.
 *
 * ## The version token
 *
 * With no `--build-version`, the generator derives the cache version from the
 * emitted `index.html`. Pass `--build-version=<token>` to force a deterministic
 * token, which is what the offline lane uses to stage a version bump without
 * changing any application source.
 *
 * ## What it deliberately does not do
 *
 * It does not record, verify, or preview. It only typechecks and builds, so the
 * artifact is what `build:web` produces plus one flag value, and every other step
 * stays where the package scripts put it.
 */

import { spawnSync } from 'node:child_process';

const OWNER_FLAG_KEY = 'VITE_OFFLINE_SHELL';
const OWNER_FLAG_VALUE = 'true';
const BUILD_MODE = 'storage-v2';

function argumentValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return undefined;
}

const buildVersion = argumentValue('build-version');

const STEPS = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'vite build', command: 'npx', args: ['vite', 'build', '--mode', BUILD_MODE] },
];

const environment = { ...process.env, [OWNER_FLAG_KEY]: OWNER_FLAG_VALUE };
if (buildVersion !== undefined) {
  environment.VITE_OFFLINE_SHELL_VERSION = buildVersion;
}

console.log(
  `[build-offline-shell] ${OWNER_FLAG_KEY}=${OWNER_FLAG_VALUE} for --mode ${BUILD_MODE}; ` +
    (buildVersion === undefined
      ? 'shell version derived from the emitted index.html.'
      : `shell version forced to ${buildVersion}.`),
);

for (const step of STEPS) {
  const result = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    env: environment,
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined) {
    console.error(`[build-offline-shell] ${step.name} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[build-offline-shell] ${step.name} exited with status ${String(result.status)}.`,
    );
    process.exit(result.status ?? 1);
  }
}
