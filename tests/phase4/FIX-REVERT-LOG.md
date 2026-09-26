# Phase 4 fix-verification revert log

Produced by `node tests/phase4/revert-harness.mjs` on 2026-09-26, Node 22.22.2.

Each row: a production file was patched with a minimal revert that removes exactly
one reported fix, the test that is supposed to hold that fix open was run, and the
file was then restored from a backup and its sha256 re-checked. The harness exits
non-zero if any checksum fails to match, so a row cannot be reported without the
tree having been restored.

| Fix | File | Test | Outcome | Observed failure |
| --- | --- | --- | --- | --- |
| 1 - progression envelope version marker | `src/services/persistence/v2/appState.ts` | `fixVerification` → "emits the shared constant" | went red | the source no longer contains `version: CANONICAL_PROGRESSION_VERSION,` |
| 1b - same fix, behavioural | `src/services/persistence/v2/appState.ts` | `fixVerification` → "is a fixed point: reading and hydrating twice changes nothing" | went red | the hydrated map lost a subject (`{…(1)}` vs `{…(2)}`) |
| 2 - custom-sprite record id | `src/services/persistence/v2/repository.ts` | `fixVerification` → "three kinds for one path migrate, activate, and validate" | went red | `VALIDATION_FAILED` where `null` was expected - the original count-mismatch failure |
| 3 - preferences reach the generation | `src/store/preferencesStore.ts` | `fixVerification` → "survives a reload on the flagged build" | went red | timed out waiting for the preference to reach the generation |
| 4 - canonical shortcut order | `src/store/shortcutStore.ts` | `fixVerification` → "the flagged and legacy hydrations produce the identical order" | went red | the two orders differ at index 1 |
| 5 - unindexed payload preserved | `src/services/persistence/v2/migrations.ts` | `fixVerification` → "the bytes are preserved verbatim in a recovery record" | went red | the subject set differed: the unindexed payload reappeared as a subject |
| 6 - `hasNoLearnerContent` in the migration | `src/services/persistence/v2/migrations.ts` | `fixVerification` → "classifies a locale-only device as no-source-data" | went red | `expected 'migrated' to be 'no-source-data'` |

**7 of 7 reverts made the gate go red.** Every fix is therefore held open by at
least one test that fails without it.

## The one fix whose *write* half is not held open — escalated to a blocker

Fix 1 is confirmed for the **read** path. The **write** path carries the same
hazard and is not fixed: `progressionStore.savePersistedBySubject` passes
`{ bySubject, crossSubjectAchievements }` — no `version` — to
`publishProgressionToActiveGeneration`, so the normaliser files the whole map as
one `__legacy__` record.

**This is a blocker, not a should-fix, and the first pass understated it.** The
per-subject records keep the snapshot the *migration* staged, because the
post-action state never reaches a readable position in any record. Measured in
`tests/phase4/progressionWritePathDefect.test.ts`:

| where | the badge earned in the flagged build |
| --- | --- |
| in memory | present |
| generation, per-subject record | **absent** (pre-action snapshot) |
| generation, `__legacy__` record | zeroed v1 record, real map nested in `extraFields` |
| after a reload from the generation | **absent** |
| legacy mirror key | present |

So no progression earned after the migration is ever durable in the authoritative
store, and the two builds disagree about what the learner earned. That is the
exact failure the read-side fix documents ("silent, learner-visible loss on every
flagged-build reload"); the read path was repaired, and the write path still
manufactures the same corruption.

Five red tests hold this open, including the two learner-visible ones ("an earned
badge is not durable in the flagged build", "the two builds disagree about what
the learner earned"). Adding `version: CANONICAL_PROGRESSION_VERSION` to the
object `savePersistedBySubject` passes is the one-line fix, and it would turn all
five green.

Note on the first pass: it included a passing test titled "the learner data
itself is not lost", which read as reassurance. It was not — it inspected
*pre-action* values, so it was true whether or not the write was durable. That
test has been rewritten to state exactly what survives (the staged snapshot and
the legacy mirror) and what does not (the post-action state), so it can no longer
be misread.

## Re-run confirmation

The harness was re-run at the end of the verification pass, after all test
changes: **7 of 7 reverts still go red**, and every touched file was restored
byte-for-byte (checksums verified in the harness). No production file was left
modified by the harness.
