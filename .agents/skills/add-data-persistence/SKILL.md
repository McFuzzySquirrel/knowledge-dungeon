---
name: add-data-persistence
description: Adds or migrates Knowledge Dungeon data across storage-v2 generations, IndexedDB repositories, local attachments, backup products, statistics, and backward-compatible subject schemas.
---

# Add Data Persistence

Use this skill for any new persisted field, entity, migration, attachment, backup, statistics record, or assistance record.

## Process

### 1. Define the contract

Identify whether the data belongs in the subject snapshot, progression, sessions, preferences, shortcuts, assistance, attachments, custom sprites, recovery, or a product archive. Add a canonical type with a stable version and explicit ownership.

Keep subject schema `1.1.0` compatibility separate from storage-generation and backup-product versions.

### 2. Choose the repository boundary

Use the storage-v2 repository for the redesigned application. It must support:

- IndexedDB generations
- An active-generation pointer
- Explicit asynchronous hydration
- Transactional writes
- Checksums and validation
- Migration receipts
- Rollback generations
- Legacy reads during the compatibility window

Do not add a renderer import to persistence or domain code.

### 3. Preserve compatibility

Every migration must be:

- Versioned
- Idempotent
- Validated before activation
- Non-destructive until an explicit cleanup phase
- Covered by legacy fixtures
- Safe to retry after interruption

Subject schema `1.0.0` data must migrate to `1.1.0`. Progression versions 1, 2, and 3 must normalize to one canonical representation. Preserve unknown app-owned fields and recovery records.

### 4. Handle local attachments

Store web image bytes in IndexedDB with checksums. Do not upload redesigned-app attachments to `/api/upload`. Preserve external URLs as external content and disclose when their bytes are not available for a lossless backup.

### 5. Keep writes idempotent

Use stable event or entity IDs for rewards, fish catches, review passes, and statistics events. A retry, React StrictMode run, reload, or interrupted transaction must not duplicate progression.

### 6. Support data products

When the active phase requires them, implement:

- Full-device `.kdbak` backup with all available app-owned state and attachments
- Subject `.kdsubject` backup with associated learner state
- Blank `.kdtemplate` with graph structure only and fresh IDs

Imports stage a new generation, validate completely, and never partially overwrite the active generation. Require an explicit copy or replace policy for collisions.

### 7. Test the lifecycle

Add tests for:

- Save and reload
- Legacy defaulting
- Migration success and failure
- Transaction rollback
- Attachment checksum and external-only handling
- Full, subject, and template round trips
- Corrupt archive rejection
- Copy and replace ID behavior
- Statistics and assistance restoration
- Browser and legacy compatibility paths

## Validation

Run the active phase's migration and data tests plus:

```bash
npm run lint
npm run typecheck
npm test
npm run build:web
npm run check:bundle-size
```

Verify no automatic upload, analytics, telemetry, or remote configuration is introduced.
