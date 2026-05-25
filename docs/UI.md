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

- **Top HUD (floating):** subject, room count, XP/rank, active phase, plus
  **Map**, **Home**, and **Help** buttons. `Map` opens the full mindmap
  view, `Home` returns to subject selection, `?` opens the help overlay.
- **Center gameplay canvas:** Phaser dungeon movement and interactions. The
  camera automatically zooms **in** when the player is standing inside a
  room (so the active room feels focused) and **out** when traveling along
  a corridor between rooms (so more of the map is visible — see
  [§3 Auto-zoom](#3-auto-zoom-roomcorridor) below). The player is drawn
  with a class-themed SVG sprite (Scholar / Cartographer / Archivist) and
  the spawn room is marked with a signpost.
- **Minimap (bottom-left, floating):** quick room-location awareness. The
  current room and any rooms **directly connected** to it are highlighted
  in the accent color (see [§5 Minimap child highlighting](#5-minimap-child-highlighting)).
- **Right room panel (floating):** topic metadata, child-room creation,
  topic deletion (Creator phase), and encounter access.
- **Touch controls (bottom-right, floating):** mobile-friendly directional
  / interact buttons.

See [`CUSTOMIZATION.md`](./CUSTOMIZATION.md) for how to swap in your own
sprites and tilesets.

## 3) Auto-zoom (room ↔ corridor)

![Player on a corridor between rooms — camera zoomed out](./assets/ui/auto-zoom-corridor.png)

When the player steps out of a room onto a corridor, the camera smoothly
tweens to a wider zoom so more of the dungeon is visible at once. Stepping
back into a room tweens the camera back in to a tighter zoom. Compare this
screenshot (player on the corridor between Eigenvalues and Vector Spaces —
all 7 rooms visible) against [§2](#2-main-game-shell-hud--minimap--room-panel)
where the player is inside a room and only the immediate neighborhood fits
on screen.

## 4) Full map view

![Full pannable / zoomable mindmap](./assets/ui/full-map-view.png)

Opened from the HUD `Map` button or by pressing <kbd>M</kbd>. The full map
view renders the entire dungeon mindmap with **drag-to-pan** and
**scroll-to-zoom**, plus `+` / `−` / `Reset` controls. It's intended for
inspecting the broader topic graph without leaving the dungeon. Rooms
directly connected to your currently focused room (and the edges to them)
are tinted in the accent color so children/related topics stand out.

## 5) Minimap child highlighting

![Minimap highlights the focused room and its direct neighbors](./assets/ui/minimap-highlight.png)

The minimap in the bottom-left of the game shell tints the currently
focused room in the strong accent color, and any rooms **directly
connected** to it in a softer accent — so the children/connected topics of
the room you're standing in are immediately visible at a glance.

## 6) Creator-phase topic management (add / delete)

![Topic tab with add-child and delete-topic actions](./assets/ui/delete-topic.png)

During the **Create** phase the Topic tab exposes:

- An **Add child topic** form that grows the mindmap from the currently
  focused room.
- A **Delete topic** action (only on non-root rooms) that removes the
  focused room and any descendants that would become disconnected from the
  root once it's gone. Descendants still reachable via a cross-link are
  preserved.

The root topic cannot be deleted; the panel replaces the button with a
short explanatory note in that case.

## 7) Help overlay

![Help overlay](./assets/ui/help-overlay.png)

The help dialog is opened from the `?` button (or keyboard `?`) and summarizes:

- Movement and interaction controls.
- What changes in each phase (Create, Scribe, Review).
- How encounters and review passes work.
- The <kbd>M</kbd> shortcut for the full mindmap view.

It is meant to be a quick in-context rules reference while playing.

## 8) Note editor modal (encounter resolution)

![Note editor modal](./assets/ui/note-editor-modal.png)

This modal appears when opening a room encounter. It provides:

- A structured notes input area.
- Manual confirmation checkbox.
- Deterministic validation checklist (word count + required sections).
- Quality bonus preview and submit/defeat action state.

This is the core learning loop UI where players convert study notes into room completion progress.
