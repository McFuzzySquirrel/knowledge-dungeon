# Product Requirements — Knowledge Dungeon

## Vision

A local-first **dungeon-crawler for studying**. Each subject (e.g. "Linear
Algebra") becomes a dungeon whose rooms are topic-nodes in a user-authored
mindmap. To "defeat" a room, the player writes structured notes that pass a
deterministic quality rubric (Summary / Key Points / Recall Question,
≥120 words, manual confirmation). Defeated rooms drop XP, loot, and a
generated artifact. Once every room is cleared, the **Archaeologist** phase
unlocks self-check prompts and review-streak tracking.

The game now begins in the **Dungeon Village** — a persistent hub world
where players create subjects, select their archetype, meet the guide NPC,
view their collection, and enter dungeon portals. The village replaces the
direct jump from welcome screen to dungeon with an explorable space that
provides context, guidance, and a sense of place.

## Three-phase loop

1. **Creator** — author the dungeon by adding topic-rooms and links.
2. **Scribe** — explore the dungeon and defeat each room by submitting notes.
3. **Archaeologist** — unlocked when all rooms are cleared; revisit rooms,
   answer self-check prompts, track review streaks.

## Village Hub

The Dungeon Village is the player's home base and the entry point for all
gameplay. It features:

- **Dungeon portals** — one per subject, rendered as animated vortex icons
  with spinning rings and pulsing glow. Enter by walking up and pressing E.
- **Keeper's Tower** — home of the Keeper of Knowledge guide NPC. Houses
  the **Quest Board** for tracking onboarding progress.
- **Guild Hall** — create new subjects by providing a name and root topic.
- **Training Grounds** — launches the 3-room tutorial dungeon.
- **Trophy Hall** — view your collection: badges, artifacts, journal entries,
  and dungeon count aggregated across all subjects.
- **Library of Knowledge** — in-game help panel with controls reference,
  gameplay loop explanation, and archetype summaries.
- **Wayfinding signposts** — multi-directional signs at crossroads showing
  directions to nearby buildings when approached.
- **Wandering NPCs** — five villagers with learning quotes who patrol the
  paths.
- **Decorative elements** — trees, bushes, rocks, ponds, flowers, torches,
  benches, flying birds, and a central fountain.
- **Compass** — React overlay at top center pointing toward the nearest
  portal or the Keeper.
- **Fixed sidebar HUD** — archetype selection with perk detail, clickable
  quest log, and theme picker. Collapsible drawer on mobile.

## Quest System

A 10-step onboarding quest guides new players:

1. Intro → Meet the Keeper → Create a Subject → Visit Training →
   Pick Archetype → Enter Dungeon → Clear a Room → Write a Note →
   Review Artifact → Complete

Steps 1–6 advance automatically when the player performs the action.
Steps 7–9 (which happen inside dungeons) require manual confirmation
on the quest board via a "Mark Complete" button.

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
- Tauri shell
