# UI Walkthrough

This document captures key UI surfaces in Knowledge Dungeon and explains what each screen is for.

## 1) Welcome screen (phase/class/subject setup)

![Welcome screen](./assets/ui/welcome-screen.png)

Use this screen to:

- Choose the current phase (Create, Scribe, Review), which controls the active gameplay loop.
- Pick a study archetype (Scholar, Cartographer, Archivist), which applies your class/perk identity.
- Create a new subject or load a previously saved subject.

This is the entry point for every session and determines how the rest of the UI behaves.

## 2) Main game shell (HUD + minimap + room panel)

![Main game shell](./assets/ui/game-screen.png)

The game shell combines several persistent UI regions, all rendered as
**floating overlays** above a full-canvas Phaser scene so the dungeon map
gets the maximum amount of screen space:

- **Top HUD (floating):** subject, room count, XP/rank, active phase, help button.
- **Center gameplay canvas:** Phaser dungeon movement and interactions. The
  player is drawn with a class-themed SVG sprite (Scholar / Cartographer /
  Archivist) and the spawn room is marked with a signpost.
- **Minimap (bottom-left, floating):** quick room-location awareness.
- **Right room panel (floating):** topic metadata, child-room creation, and
  encounter access.
- **Touch controls (bottom-right, floating):** mobile-friendly directional /
  interact buttons.

See [`CUSTOMIZATION.md`](./CUSTOMIZATION.md) for how to swap in your own
sprites and tilesets.

## 3) Help overlay

![Help overlay](./assets/ui/help-overlay.png)

The help dialog is opened from the `?` button (or keyboard `?`) and summarizes:

- Movement and interaction controls.
- What changes in each phase (Create, Scribe, Review).
- How encounters and review passes work.

It is meant to be a quick in-context rules reference while playing.

## 4) Note editor modal (encounter resolution)

![Note editor modal](./assets/ui/note-editor-modal.png)

This modal appears when opening a room encounter. It provides:

- A structured notes input area.
- Manual confirmation checkbox.
- Deterministic validation checklist (word count + required sections).
- Quality bonus preview and submit/defeat action state.

This is the core learning loop UI where players convert study notes into room completion progress.
