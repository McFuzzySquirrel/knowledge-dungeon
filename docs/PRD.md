# Product Requirements — Knowledge Dungeon

## Vision

A local-first **dungeon-crawler for studying**. Each subject (e.g. "Linear
Algebra") becomes a dungeon whose rooms are topic-nodes in a user-authored
mindmap. To "defeat" a room, the player writes structured notes that pass a
deterministic quality rubric (Summary / Key Points / Recall Question,
≥120 words, manual confirmation). Defeated rooms drop XP, loot, and a
generated artifact. Once every room is cleared, the **Archaeologist** phase
unlocks self-check prompts and review-streak tracking.

## Three-phase loop

1. **Creator** — author the dungeon by adding topic-rooms and links.
2. **Scribe** — explore the dungeon and defeat each room by submitting notes.
3. **Archaeologist** — unlocked when all rooms are cleared; revisit rooms,
   answer self-check prompts, track review streaks.

## Non-negotiables

- **Local-first**. Desktop builds persist to `<userData>/dungeon-data/`;
  web builds fall back to `localStorage`. No network calls required.
- **Deterministic note validation**. No AI grading; every quality bonus and
  XP delta is reproducible and auditable.
- **Same UI/UX as `repo-dungeon`**: HUD rail, minimap, class selection,
  room-info panel, mobile touch controls, help overlay.
- **Same tech stack as `repo-dungeon`**: React 19, Phaser 3, Zustand,
  Vite 8, TypeScript 5, Electron 42.

## Out of scope (for now)

- Multi-user / cloud sync
- Server-side AI assistance
- Tauri shell (Mindmap Dungeon's choice; intentionally replaced with
  Electron to match the maintainer's tech-stack preference).
