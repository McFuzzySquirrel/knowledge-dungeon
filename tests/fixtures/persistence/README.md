# Phase 0 persistence fixtures

These fixtures freeze the **current** Knowledge Dungeon persistence behavior for
Phase 0. They are hand-authored compatibility inputs derived from the source
snapshot on 2026-09-24. They are not storage-v2 manifests, migration receipts,
backup archives, or proof that a later rebuild phase is implemented.

## Provenance and privacy

- Every subject, room, note, badge, fish, progression record, and date is
  synthetic. Most IDs and names use a `phase0`/`Synthetic` marker so a fixture
  cannot be mistaken for learner data; the malformed-room-summary fixture
  intentionally uses a numeric `roomId` to exercise importer rejection.
- There are no learner or private URLs. The only URL in the fixtures is the
  reserved `https://example.invalid/phase0-synthetic-image.png`; tests never
  fetch it and no fixture represents bytes available from a server.
- Valid fixture inputs are JSON. The two `*-invalid-syntax.txt` files are
  intentionally malformed text so the JSON parse-failure paths can be tested.
- Fixture filenames, assertions, and documentation contain no learner names,
  notes, identifiers, or other private records.
- No production data was copied into this directory.

## Layout

### Subject schema fixtures

`subject/` contains current importer inputs:

| File | Purpose |
| --- | --- |
| `subject-1.0.0-minimal.json` | Smallest current importer boundary that the 1.0.0 path accepts; it is not a complete domain snapshot. |
| `subject-1.0.0-migration-defaults.json` | 1.0.0 rooms with missing and already-populated SM-2/tag values, for current migration defaults. |
| `subject-1.0.0-full-unknown-fields.json` | Full legacy-shaped subject plus synthetic unknown fields at several levels. |
| `subject-1.1.0-minimal.json` | Smallest current 1.1.0 importer boundary. |
| `subject-1.1.0-full-unknown-fields.json` | Current schema fields, SM-2, tags, biome, attachments, fish, and unknown fields. |
| `subject-invalid-*.json` | Parseable payloads rejected by the current importer (unsupported version, missing schema, malformed room summary, or missing room payload). |
| `subject-invalid-parseable-missing-room-v1.0.json` | Parseable 1.0.0 data with a missing room payload; the raw loader returns it unchanged while the file importer rejects it. |
| `subject-invalid-syntax.txt` | Syntactically invalid JSON input for the JSON parse failure path. |

The current `importSubjectFromJson` function accepts a top-level `dungeon` and
`rooms` object and supports only subject schema `1.0.0` and `1.1.0`. Its
validation is intentionally shallow. The minimal fixtures therefore document an
import-boundary behavior, not a guarantee that every downstream consumer can
render the returned object.

For a 1.0.0 import, current `migrateToV11` sets the schema to `1.1.0`, adds the
SM-2 defaults (`3`, `2.5`, `1`, current clock, and `0`), adds room tags, and adds
`tagIndex`/the biome property. Supplied values are retained. The current
migration reconstructs the top-level object, so a top-level legacy envelope is
not preserved; dungeon- and room-level unknown fields are retained. The
characterization tests make both sides of that current behavior explicit.

The raw-loader characterization intentionally includes parseable but
structurally invalid `1.0.0` data. The current `loadSubjectSnapshot` path only
parses JSON: it returns that payload unchanged, performs no schema migration,
and does not quarantine it. The current file importer rejects the same payload
because its room-mapping validation fails. This is a frozen compatibility gap,
not an endorsement of accepting invalid subject data.

### Progression fixtures

`progression/` contains inputs for the current localStorage key
`knowledge-dungeon:v1:progression`:

| File | Purpose |
| --- | --- |
| `progression-v1-flat.json` | Historical unversioned flat progression shape. |
| `progression-v1-flat-malformed.json` | Historical shape with wrong types, invalid entries, and missing identifiers. |
| `progression-v2-by-subject.json` | `{ "version": 2, "bySubject": ... }` with two synthetic subjects. |
| `progression-v2-malformed-by-subject.json` | Version 2 with `bySubject: null`, which currently falls back to flat normalization. |
| `progression-v3-current-full.json` | Current version 3 shape with full per-subject fields and cross-subject achievements. |
| `progression-v3-malformed-values.json` | Version 3 with malformed field types and a non-array achievement list. |
| `progression-invalid-syntax.txt` | Invalid JSON for the loader's safe-empty fallback. |

The current store chooses the active subject for a v1 flat record from
`knowledge-dungeon:v1:activeSubjectId`, falling back to `__legacy__`. The v1
fixture intentionally carries a stale `rank`; the current normalizer derives the
rank from `xpTotal` rather than trusting that field. Version 2 and version 3
records are normalized by subject. Unknown progression fields are not retained
by the current normalized in-memory shape.

## Determinism requirements

Characterization tests must control every current source of nondeterminism:

- The system clock is fixed to `2026-09-24T12:34:56.789Z` with Vitest fake
  timers. This makes the current 1.0.0 migration's `sm2NextReviewDate` exact.
- `Math.random()` is mocked to `0.123456789` whenever a current normalizer can
  manufacture an inventory or gear identifier.
- Tests reset localStorage, clear the optional Electron bridge, and reset
  modules before loading the progression store. Subject tests use the same
  isolated storage setup.
- Fixture dates are literal ISO strings. No test should use the real clock,
  network, filesystem learner data, or random values.

If a future test needs a different deterministic clock or random stream, it must
state that choice locally rather than changing these characterization fixtures.

## Characterization versus target contracts

These files describe what the **existing importer, raw loader, and progression
store do now**. They are not assertions that the target IndexedDB generation,
atomic migration, `.kdbak`, `.kdsubject`, or `.kdtemplate` formats exist.
Those target contracts belong to later phases and should be added as separate
contract tests after their production codecs are implemented. In particular,
these fixtures must not be used to claim that unknown fields, rollback,
attachments, or authoritative cross-product state are already preserved by
storage-v2.
