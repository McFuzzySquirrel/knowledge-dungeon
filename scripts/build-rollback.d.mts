/**
 * Type declarations for `scripts/build-rollback.mjs`.
 *
 * The Phase 23 full-rollback build script is plain ESM run by `node`, like every
 * other script in `scripts/`. It exports its flag table and its runner so
 * `tests/e2e/rollback-lane.test.ts` can assert the table equals
 * `CUTOVER_FLAG_ROLLBACKS` rather than mirroring it, and those exports have no
 * declarations unless this file provides them. Mirrors the `check-memory.d.mts`
 * pattern: the declarations are the module's real exports and nothing else, so a
 * new export fails the build here until it is declared.
 *
 * This file has no runtime content and is not part of any bundle.
 */

/** Every cutover flag's environment variable, mapped to its pre-cutover value. */
export const ROLLBACK_FLAGS: Readonly<Record<string, string>>;

/** Run the flag-augmented typecheck-then-build. Called only when the script is the entry point. */
export function runRollbackBuild(): void;
