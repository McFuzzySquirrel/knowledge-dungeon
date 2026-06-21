---
name: add-data-persistence
description: >
  Adds new data fields or entities to Knowledge Dungeon's persistence layer,
  covering type definitions, store updates, save/load logic, backward
  compatibility, and test coverage.
---

# Skill: Add Data Persistence

Extends the persistence layer with new data fields or entities, ensuring they survive save/load cycles across both localStorage (web) and Electron filesystem (desktop) backends.

---

## Process

### Step 1: Define or Extend Types

Add the new fields to the appropriate type definition in `src/core/validation/persistence/types.ts`:

```typescript
export interface RoomMetadata {
  // ... existing fields
  /** New field — add JSDoc comment */
  readonly newField?: string; // Optional = backward compatible
}
```

Or create a new entity type if adding a completely new data category:

```typescript
export interface NewEntity {
  id: string;
  subjectId: string;
  // ... fields
}
```

**Important:** New fields should be optional (`?`) or have default values to maintain backward compatibility with existing saved data.

### Step 2: Update Defaults

Update the factory/defaults function that creates new instances so the field is initialized:

```typescript
export function createDefaultRoomMetadata(): RoomMetadata {
  return {
    // ... existing defaults
    newField: 'default-value',
  };
}
```

Look in the same types file or in the graph domain's factory functions.

### Step 3: Update the Zustand Store

Add the field to the relevant Zustand store in `src/store/`:

```typescript
// In subjectStore.ts — add action to set the new field
setNewField: (roomId: string, value: string) =>
  set((state) => ({
    rooms: {
      ...state.rooms,
      [roomId]: {
        ...state.rooms[roomId],
        newField: value,
      },
    },
  })),
```

For new entities, create a new slice in the store or a new sub-map.

### Step 4: Ensure Persistence Round-Trip

Verify that the new field survives save/load:

1. The field is included in the `SubjectSnapshot` (the JSON that gets serialized)
2. The `subjectStore` hydration logic restores the field on load
3. The `createDefault*` function provides a fallback if the field is missing from old data

```typescript
// In the hydration/reconstruction function:
const restored: RoomMetadata = {
  ...createDefaultRoomMetadata(),
  ...savedData,
  // Explicit restoration for complex fields:
  newField: savedData.newField ?? 'default-value',
};
```

### Step 5: Test the Persistence Round-Trip

Add or update tests in `tests/unit/subjectPersistence.test.ts`:

```typescript
it('persists and restores newField', () => {
  const subject = createTestSubject();
  subject.rooms['room-1'].newField = 'test-value';
  persistence.save(subject);
  const loaded = persistence.load(subject.id);
  expect(loaded.rooms['room-1'].newField).toBe('test-value');
});

it('defaults newField for legacy data', () => {
  const legacyData = { /* minimal subject without newField */ };
  persistence.import(legacyData);
  const loaded = persistence.load(legacyData.id);
  expect(loaded.rooms['room-1'].newField).toBe('default-value');
});
```

### Step 6: Update Data Integrity Checks

If the field has validation requirements, add checks to `src/core/validation/persistence/types.ts` or the state machine in `src/core/graph/graphDomain.ts`:

```typescript
if (room.newField !== undefined && room.newField.length > 100) {
  return { valid: false, error: 'newField exceeds maximum length' };
}
```

---

## Output Format

The persistence change should produce:
- Updated type definitions with backward-compatible new fields
- Updated Zustand store with setter actions
- Save/load round-trip that includes the new data
- Default value handling for legacy saved data
- Unit tests for persistence and backward compatibility

---

## Validation

- [ ] `npm run typecheck` — no type errors
- [ ] `npm run lint` — no lint errors
- [ ] `npm test -- --run` — existing tests pass + new tests pass
- [ ] Manual test: create subject → add data → refresh page → verify data restored
- [ ] Manual test: import legacy JSON (without new field) → verify default value applied
- [ ] If Electron: test save/load in desktop build

---

## Gotchas

- localStorage has a ~5–10MB limit — if the new field stores large data (e.g., base64 images), use the attachment system instead of inline storage
- The `SubjectSnapshot` JSON is the persistence contract — adding a field to `RoomMetadata` will automatically include it in the snapshot if the store is serialized correctly
- Legacy data WITHOUT the new field MUST still load without errors — always use `??` default or optional chaining
- If the new field needs to be indexed or searchable, add it to the subject index in `subjectPersistence.ts`
- The Electron filesystem backend saves the entire `SubjectSnapshot` as a single JSON file — no special handling needed for new fields

---

## Reference

See [docs/PRD.md](../../../docs/PRD.md) for the full specification:
- **Section 8.13** - Data persistence requirements (DP-01 through DP-07)
- **Section 10 - Data Integrity & Error Recovery** (DR-01 through DR-07)
- **Section 8.1** - Subject management (SM-01 through SM-07, import/export)
