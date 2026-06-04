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
├── dungeon.json
├── README.md
└── rooms/
    ├── room-*/
    │   ├── notes.txt
    │   └── artifact.md   # required for archaeologist output
    └── ...
```

The subject must be directly importable by Knowledge Dungeon (valid `dungeon.json`, room ids aligned with folders, no missing room note files).

## Procedure

1. Parse the source text and extract major topics, subtopics, and relationships.
2. Build a connected room graph:
   - 12-40 rooms based on source size.
   - Heuristic: target ~1 room per major concept (or about 1 room per 1-2 pages of source text).
   - no isolated rooms.
   - at least one root/introduction room.
3. Write `rooms/<room-id>/notes.txt` for each room using **all required sections exactly**:
   1. `Summary`
   2. `Key Points`
   3. `Recall Question`
4. Ensure each room note is grounded in source content (no invented claims).
5. Generate `dungeon.json` with matching room metadata and edges.
6. If `--entry-phase archaeologist`, mark rooms as artifact-ready and emit `artifact.md` for every room.
7. Write `README.md` with concise import steps for web and desktop.

## Notes Rules

- `Summary`: concise explanation of the topic and context.
- `Key Points`: bullet list of concrete takeaways from source material.
- `Recall Question`: one question that checks understanding.
- Keep terminology consistent with the source text.

## Validation Checklist (Required)

Before returning completion:

1. `dungeon.json` parses successfully.
2. Every room in `dungeon.json` has a matching `rooms/<room-id>/notes.txt`.
3. Every note includes `Summary`, `Key Points`, and `Recall Question`.
4. Graph is connected from the root.
5. Output path is ready to import into Knowledge Dungeon.

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
