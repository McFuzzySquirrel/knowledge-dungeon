---
name: create-dungeon-from-text
description: 'Turn a document or plain text into an importable Knowledge Dungeon subject with topic rooms, edges, and notes that include Summary, Key Points, and Recall Question.'
argument-hint: '--name "Topic Name" --source "path/to/document.md" --depth balanced --entry-phase scribe'
user-invocable: true
---

# Create Dungeon From Text

Generate an importable Knowledge Dungeon subject from a document, transcript, article, notes, or pasted text.

## When To Use

- User wants a dungeon created from non-code content.
- User provides raw text and asks to break it into topics.
- User needs import-ready output for Knowledge Dungeon.

## Inputs

- `--source` (optional): file path or URL to parse.  
  If omitted, use the text provided in the conversation.
- `--name` (required): subject name.
- `--depth` (default `balanced`): `light`, `balanced`, `deep`.
- `--output` (default `maps/{subject-name}-dungeon`): destination folder.
- `--entry-phase` (default `scribe`): `creator`, `scribe`, `archaeologist`.

## Required Output (Importable)

```text
maps/{subject-name}-dungeon/
├── dungeon.json        ← full SubjectSnapshot (see schema below)
├── README.md
└── rooms/
    ├── room-*/
    │   ├── notes.txt
    │   └── artifact.md   # required for archaeologist output
    └── ...
```

The subject must be directly importable by Knowledge Dungeon — valid `dungeon.json`, room ids aligned with folders, no missing room note files.

## dungeon.json Schema

`dungeon.json` must be a **full `SubjectSnapshot`** object. See the exact JSON Schema in `dungeon-schema.json` (same directory as this file).

Key requirements:

- Top-level keys: `dungeon` **and** `rooms` — both are required.  
  Missing `rooms` causes **"Invalid subject snapshot format"** on web import.
- `dungeon.schemaVersion` must be exactly `"1.0.0"`.
- `dungeon.rooms` is an **array** of `{ roomId, topic, status }` summaries.
- `rooms` is a **map** of `roomId → RoomMetadata`. Every `roomId` in `dungeon.rooms` must have an entry here.
- Each `RoomMetadata` entry must include `noteText` (the full plain-text note), `validationState` (all fields present — use the zero-value object shown below), `artifactMarkdown` (null unless archaeologist phase), and `attachments: []`.

Minimal zero-value `validationState`:

```json
{
  "wordCount": 0,
  "requiredSectionsPresent": false,
  "manualConfirmed": false,
  "criterionScores": {
    "sectionCompleteness": 0,
    "conceptTermCoverage": 0,
    "linkReferences": 0,
    "recallQuestionQuality": 0,
    "clarityReadability": 0
  },
  "failedChecks": [],
  "qualityBonus": 0,
  "finalPass": false
}
```

Minimal `dungeon.json` skeleton (replace placeholders):

```json
{
  "dungeon": {
    "schemaVersion": "1.0.0",
    "dungeonId": "{subject-name}-dungeon",
    "subjectName": "{Subject Name}",
    "createdAt": "{ISO timestamp}",
    "updatedAt": "{ISO timestamp}",
    "phaseState": "SubjectCreated",
    "rootRoomId": "{root-room-id}",
    "rooms": [
      { "roomId": "{room-id}", "topic": "{Topic}", "status": "Created" }
    ],
    "edges": [
      {
        "fromRoomId": "{room-id-a}",
        "toRoomId": "{room-id-b}",
        "relationType": "subtopic",
        "createdAt": "{ISO timestamp}",
        "createdByPhase": "Creator"
      }
    ],
    "progression": { "xpTotal": 0, "rank": "Novice", "badges": [] }
  },
  "rooms": {
    "{room-id}": {
      "roomId": "{room-id}",
      "topic": "{Topic}",
      "createdAt": "{ISO timestamp}",
      "updatedAt": "{ISO timestamp}",
      "state": "Created",
      "notePath": "rooms/room-{room-id}/notes.txt",
      "artifactPath": "rooms/room-{room-id}/artifact.md",
      "noteText": "Summary\n...\n\nKey Points\n- ...\n\nRecall Question\n...",
      "artifactMarkdown": null,
      "validationState": {
        "wordCount": 0,
        "requiredSectionsPresent": false,
        "manualConfirmed": false,
        "criterionScores": {
          "sectionCompleteness": 0,
          "conceptTermCoverage": 0,
          "linkReferences": 0,
          "recallQuestionQuality": 0,
          "clarityReadability": 0
        },
        "failedChecks": [],
        "qualityBonus": 0,
        "finalPass": false
      },
      "reviewPassCount": 0,
      "attachments": []
    }
  }
}
```

## Procedure

1. Parse the source text and extract major topics, subtopics, and relationships.
2. Build a connected room graph:
   - 12-40 rooms based on source size.
   - Heuristic: target ~1 room per major concept (or about 1 room per 1-2 pages of source text).
   - no isolated rooms.
   - at least one root/introduction room.
3. Write `rooms/room-<room-id>/notes.txt` for each room using **all required sections exactly**:
   1. `Summary`
   2. `Key Points`
   3. `Recall Question`
4. Ensure each room note is grounded in source content (no invented claims).
5. Generate `dungeon.json` as a full **SubjectSnapshot** (see schema above):
   - Set `dungeon.schemaVersion` to `"1.0.0"`.
   - Populate `rooms` map with one entry per room, embedding the note text in `noteText`.
   - Use zero-value `validationState` for all rooms.
6. If `--entry-phase archaeologist`, mark rooms as artifact-ready and emit `artifact.md` for every room; set `artifactMarkdown` in each room entry.
7. Write `README.md` with concise import steps for web and desktop.

## Notes Rules

- `Summary`: concise explanation of the topic and context.
- `Key Points`: bullet list of concrete takeaways from source material.
- `Recall Question`: one question that checks understanding.
- Keep terminology consistent with the source text.

## Validation Checklist (Required)

Before returning completion:

1. `dungeon.json` parses as valid JSON.
2. `dungeon.json` top-level keys are exactly `dungeon` and `rooms` — **both present**.
3. `dungeon.schemaVersion` equals `"1.0.0"`.
4. Every `roomId` in `dungeon.rooms` (array) has a matching key in the top-level `rooms` map.
5. Every room in the `rooms` map has a `validationState` object with all required fields.
6. Every room `noteText` contains `Summary`, `Key Points`, and `Recall Question`.
7. A matching `rooms/room-<room-id>/notes.txt` exists for each room.
8. Graph is connected from the root.
9. Output is ready to import into Knowledge Dungeon via web JSON import or Electron folder import.

## Completion Response Template

```text
✅ Subject created: maps/{subject-name}-dungeon/

Generated:
- Rooms: <count>
- Edges: <count>
- Source type: <file|url|inline text>
- Phase profile: <creator|scribe|archaeologist>

Next steps:
1. Open Knowledge Dungeon
2. Refresh subjects (or copy/import folder into subject storage first)
3. Load the subject by name
```
