# Portable Copilot Skill: Create Repo Mindmap

Use this page to copy the Knowledge Dungeon skill into any repository.

This document reflects the Copilot skill interface (`/skill create-repo-mindmap`).
If you also read `REPO_TO_MINDMAP_GUIDE.md`, treat that file as future CLI direction,
not the current command surface for this repository.

## What To Copy

Copy these two files into the target repository:

- .github/skills/create-repo-mindmap/SKILL.md
- .github/skills/create-repo-mindmap/references/dungeon-output-spec.md

## Quick Install (Copy/Paste)

Run this from the root of the target repository.

```bash
mkdir -p .github/skills/create-repo-mindmap/references

cat > .github/skills/create-repo-mindmap/SKILL.md <<'EOF'
---
name: create-repo-mindmap
description: 'Analyze a repository and generate a Knowledge Dungeon subject folder (dungeon.json + room notes/artifacts) for architecture, systems, features, and workflow learning. Use when user asks to build a playable repo mindmap, onboarding dungeon, architecture study map, or phase-ready creator/scribe/archaeologist subject from code.'
argument-hint: '--repo-path . --depth balanced --name "My Project" --entry-phase scribe'
user-invocable: true
---

# Create Repository Mindmap

Generate a complete Knowledge Dungeon subject from a repository so users can explore code architecture as a playable topic graph.

## When To Use

- User asks for a repo mindmap or architecture map from source code.
- User wants a Knowledge Dungeon import folder generated from a codebase.
- User wants phase-ready output (creator, scribe, or archaeologist).
- User wants onboarding/study content from a local repo or cloned project.

## Inputs

- --repo-path (default .): repository path to analyze.
- --depth (default balanced): light, balanced, deep.
- --name (optional): display name for subject.
- --output (default maps/{project-name}-mindmap): destination folder.
- --entry-phase (default scribe): creator, scribe, archaeologist (review alias maps to archaeologist).
- --review-ready (flag): alias for --entry-phase archaeologist.

## Required Output Structure

```text
maps/{project-name}-mindmap/
├── dungeon.json
├── README.md
└── rooms/
    ├── room-*/
    │   ├── notes.txt
    │   └── artifact.md   # required for archaeologist-ready output
    └── ...
```

## Procedure

1. Analyze repository structure and tech stack.
2. Identify core domains and user-facing systems.
3. Build a 30-40 room topic graph with meaningful edges.
4. Write validation-ready notes for each room.
5. Apply phase profile:
   - creator: structure-first rooms (Created state)
   - scribe: complete note content for study progression
   - archaeologist: review-ready artifacts + metadata
6. Emit dungeon.json, rooms/*/notes.txt, and README.md.
7. For archaeologist-ready output also emit rooms/*/artifact.md and set artifact/review metadata in dungeon.json.
8. Print concise load instructions for web and desktop usage.

## Accuracy Protocol (Required)

Follow this protocol every run to reduce hallucinations and improve map quality.

1. Inventory first, summarize second:
  - Enumerate top-level folders and key build/test/config files.
  - Identify primary entrypoints, main runtime modules, and persistence/state locations.
2. Extract evidence before writing topic claims:
  - Every room topic must be traceable to real files, symbols, or scripts.
  - Do not invent frameworks, services, or layers not present in repo evidence.
3. Prioritize high-signal modules:
  - Prefer directories with dense imports/usages, test coverage, and core app flow.
  - De-prioritize generated output, vendored files, and low-signal stubs.
4. Reconcile terminology:
  - Use the repository's actual naming conventions for topics (feature names, module names, domain terms).
5. Run a final consistency pass:
  - Ensure room notes, room relationships, and summary README all describe the same architecture model.

## Room Planning Rules

Target 30-40 rooms with this distribution (adjust +/- 2 per category based on repo size):

- Architecture/Core domains: 6-8
- Features/Product systems: 6-8
- Runtime/Game/App systems: 5-7
- Data/State/Persistence: 4-6
- Tooling/Build/Test/Workflow: 4-6
- Platform/Integration (desktop/web/api/external): 3-5

Root room requirements:

- Use project name as root topic.
- Root note should explain purpose, constraints, and major subsystems.

Room naming rules:

- Keep topics concrete and codebase-specific.
- Prefer Domain: Specific Topic for clarity when needed.
- Avoid vague names like Utilities, Misc, Core Stuff.

## Edge Construction Rules

Graph quality matters as much as note quality.

- Ensure full connectivity from root (no isolated rooms).
- Use hierarchical edges for ownership/decomposition.
- Add cross-links only when there is real runtime/data/test/build coupling.
- Avoid clique-like over-linking; prefer sparse, meaningful edges.
- Keep edge semantics explainable in one sentence.

Minimum edge targets:

- At least rooms - 1 structural edges (tree backbone).
- At least 20% additional cross-links for non-trivial repos.

## Notes Format (Strict)

Each rooms/<room-id>/notes.txt must include these sections exactly:

1. Summary
2. Key Points
3. Recall Question

Quality rules:

- 120+ words recommended for strong study value.
- Key Points should be bullet-style and specific.
- Recall Question should test architecture understanding, not trivia.
- Include concrete repository evidence in prose (paths, symbols, or scripts).

Suggested template:

```text
Summary
<1-2 paragraphs on purpose, role in architecture, and interactions>

Key Points
- <key mechanism>
- <important dependency or integration>
- <tradeoff, constraint, or failure mode>

Recall Question
<question that requires reasoning about this room's relationships>
```

## Evidence Requirements

For each room, capture at least two evidence anchors from the repo:

- File paths
- Important symbols (functions/classes/types)
- Commands/scripts/config entries

If evidence is weak, either:

- merge the topic into a stronger adjacent room, or
- mark it as low-confidence and reduce room count instead of inventing detail.

## Depth Behavior

- light: concise notes, fewer cross-links, broader conceptual coverage.
- balanced: default depth with concrete evidence and moderate cross-links.
- deep: denser notes, implementation details, stronger coupling explanations, more recall-oriented questions.

## Determinism And IDs

- Use stable room ids derived from normalized topic names (slug + stable suffix).
- Keep output deterministic for same input/depth when possible.
- Preserve room ordering by domain buckets, then topic name.

## Validation Checklist (Before Final Output)

Must pass all checks:

1. dungeon.json parses and includes all referenced room ids.
2. Every room has notes.txt and required section headers.
3. Graph has no isolated nodes and has root reachability.
4. Room count matches requested depth/scope (target 30-40 unless explicitly reduced).
5. Topic claims are backed by real repository evidence.
6. README instructions match current Knowledge Dungeon load flow:
  - web: refresh subjects, then load by subject name
  - desktop: refresh subjects, then load from list or import folder via Admin tools
7. Phase profile metadata is internally consistent (creator vs scribe vs archaeologist).

## Reference

- Detailed output contract, mini-schema, and worked examples:
  [Dungeon Output Spec](./references/dungeon-output-spec.md)

## Content Expectations

- Cover architecture, technology, features, systems, workflow, and state/persistence.
- Connect related rooms with graph edges (cross-links where useful).
- Keep notes educational and specific to analyzed code (not generic filler).
- Ensure notes are compatible with Knowledge Dungeon validation expectations.

## Archaeologist-Ready Rules

When --entry-phase archaeologist (or --review-ready) is requested, ensure:

- dungeon.phaseState is ArchaeologistUnlocked or ArchaeologistActive.
- Room summary status is ArtifactCollected.
- Room metadata includes:
  - validationState.finalPass: true
  - non-empty artifactMarkdown
  - initialized reviewPassCount (typically 0)

## Response Template

Use this summary format at completion:

```text
✅ Subject created: maps/{project-name}-mindmap/

Generated:
- Rooms: <count>
- Edges: <count>
- Phase profile: <creator|scribe|archaeologist>

Next steps:
1. Open Knowledge Dungeon
2. Refresh subjects / load by subject name (or copy into local subject storage first)
3. Explore
```

## Notes

- Prefer deterministic, analysis-driven room naming and grouping.
- If repository is very large, focus on highest-signal modules first.
- If requested scope is a monorepo subproject, honor --repo-path exactly.
EOF

cat > .github/skills/create-repo-mindmap/references/dungeon-output-spec.md <<'EOF'
# Dungeon Output Spec

Use this reference when generating files for the create-repo-mindmap skill.

## Minimal dungeon.json Shape

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

1. rootRoomId exists in rooms and has isRoot: true.
2. Every roomId is unique.
3. Every id in childRoomIds and crossLinkRoomIds exists in rooms.
4. notesPath points to an existing rooms/<room-id>/notes.txt file.
5. Archaeologist-ready output must include non-empty artifact markdown and artifact files.

## Phase Profile Values

Use one of these phase states for generated output:

- Creator-ready: CreatorActive (or repository-equivalent creator state)
- Scribe-ready: ScribeActive
- Archaeologist-ready: ArchaeologistUnlocked or ArchaeologistActive

If exact enum names vary in target repo, use the canonical names used by that repository's persisted subjects.

## Room Note Template

Each notes.txt must include these section headers exactly:

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

### Example Room Metadata Block (dungeon.json)

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
    "artifactMarkdown": "# Architecture: Core Domains\\n\\nThe project centers on graph, progression, review, and validation domains..."
  }
}
```

### Example rooms/room-arch-core-domains/notes.txt

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

### Example rooms/room-arch-core-domains/artifact.md

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
2. Every room in dungeon.json has corresponding files.
3. All references between rooms resolve.
4. Notes use required headings.
5. Requested phase profile is reflected consistently in metadata.
EOF

echo "Installed create-repo-mindmap skill into .github/skills/create-repo-mindmap"
```

## Run It

In Copilot Chat inside that repository, invoke:

```text
/skill create-repo-mindmap --repo-path . --depth balanced --name "My Project"
```

Optional archaeologist-ready shortcut:

```text
/skill create-repo-mindmap --repo-path . --review-ready
```
