# Dungeon Output Spec

Use this reference when generating files for the `create-repo-mindmap` skill.

## Minimal `dungeon.json` Shape

This is a practical mini-schema, not a strict JSON Schema file.

```json
{
  "version": 1,
  "dungeon": {
    "dungeonId": "my-project-mindmap",
    "subjectName": "My Project",
    "rootRoomId": "room-root-my-project",
    "phaseState": "ScribeActive",
    "rooms": [
      {
        "roomId": "room-root-my-project",
        "topic": "My Project",
        "status": "Created",
        "isRoot": true,
        "childRoomIds": [
          "room-arch-core-domains"
        ],
        "crossLinkRoomIds": [],
        "notesPath": "rooms/room-root-my-project/notes.txt",
        "artifactPath": null,
        "metadata": {
          "validationState": {
            "finalPass": false
          },
          "reviewPassCount": 0,
          "artifactMarkdown": ""
        }
      }
    ]
  }
}
```

## Required Invariants

1. `rootRoomId` exists in `rooms` and has `isRoot: true`.
2. Every `roomId` is unique.
3. Every id in `childRoomIds` and `crossLinkRoomIds` exists in `rooms`.
4. `notesPath` points to an existing `rooms/<room-id>/notes.txt` file.
5. Archaeologist-ready output must include non-empty artifact markdown and artifact files.

## Phase Profile Values

Use one of these phase states for generated output:

- Creator-ready: `CreatorActive` (or repository-equivalent creator state)
- Scribe-ready: `ScribeActive`
- Archaeologist-ready: `ArchaeologistUnlocked` or `ArchaeologistActive`

If exact enum names vary in target repo, use the canonical names used by that repository's persisted subjects.

## Room Note Template

Each `notes.txt` must include these section headers exactly:

```text
Summary
<content>

Key Points
- <point>
- <point>
- <point>

Recall Question
<question>
```

## Worked Example

### Example Room Metadata Block (`dungeon.json`)

```json
{
  "roomId": "room-arch-core-domains",
  "topic": "Architecture: Core Domains",
  "status": "ArtifactCollected",
  "isRoot": false,
  "childRoomIds": [
    "room-arch-graph-module",
    "room-arch-persistence"
  ],
  "crossLinkRoomIds": [
    "room-feat-review",
    "room-dev-testing"
  ],
  "notesPath": "rooms/room-arch-core-domains/notes.txt",
  "artifactPath": "rooms/room-arch-core-domains/artifact.md",
  "metadata": {
    "validationState": {
      "finalPass": true
    },
    "reviewPassCount": 0,
    "artifactMarkdown": "# Architecture: Core Domains\n\nThe project centers on graph, progression, review, and validation domains..."
  }
}
```

### Example `rooms/room-arch-core-domains/notes.txt`

```text
Summary
The architecture is organized around a small number of domain-focused modules. The graph domain defines topic relationships and traversal behaviors, while validation enforces note quality and completion gates. Progression tracks XP, rank, and rewards, and the review domain enables post-completion recall workflows. This separation keeps gameplay orchestration thin and pushes rules into testable domain code.

Key Points
- Domain modules are split by responsibility (graph, validation, progression, review) rather than by UI screen.
- Persistence and state adapters bridge runtime stores and durable subject data.
- Feature flows compose these domains instead of duplicating business rules in UI components.

Recall Question
How would a change to note-completion policy propagate from validation to progression and review behavior without coupling UI components to domain internals?
```

### Example `rooms/room-arch-core-domains/artifact.md`

```markdown
# Architecture: Core Domains

## Snapshot
The project favors domain-centric modules to keep core rules deterministic and testable.

## Why It Matters
This structure reduces regressions when feature behavior changes, because policy updates are centralized.

## Cross-References
- Graph Module
- Validation Rules
- Progression Engine
```

## Final Output Checklist

Before returning generated output, verify:

1. Folder tree matches required structure.
2. Every room in `dungeon.json` has corresponding files.
3. All references between rooms resolve.
4. Notes use required headings.
5. Requested phase profile is reflected consistently in metadata.
