# UI Walkthrough

This document captures key UI surfaces in Knowledge Dungeon and explains what each screen is for.

## 1) Welcome screen (phase/class/subject setup)

![Welcome screen](./assets/ui/welcome-screen.png)

Use this screen to:

- Choose the current phase (Create, Scribe, Review), which controls the active gameplay loop.
- Pick a study archetype (Scholar, Cartographer, Archivist), which applies your class/perk identity.
- Create a new subject from a root topic.
- Browse previously created subjects by **subject name** instead of raw id, with room counts visible from home.
- Refresh the saved subject list if you want to rescan local data before loading one.
- Access the **Admin** section, which in desktop mode exposes local subject export/open-folder tools.

This is the entry point for every session and determines how the rest of the UI behaves.

## 2) Main game shell (HUD + minimap + room panel)

![Main game shell](./assets/ui/game-screen.png)

The game shell combines several persistent UI regions, all rendered as
**floating overlays** above a full-canvas Phaser scene so the dungeon map
gets the maximum amount of screen space:

- **Top HUD (floating):** subject, room count, XP/rank, active phase, plus
  **Map**, **Teleport**, **Home**, and **Help** buttons. `Map` opens the full
  mindmap view, `Teleport` opens a floor/room jump flow with a cooldown,
  `Home` returns to subject selection, `?` opens the help overlay.
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
- **Right room panel (floating):** topic metadata, breadcrumbs, and travel
  shortcuts split into two sections — **Connected topics on this floor**
  (siblings/neighbors on the same floor) and **Travel to related floors**
  (a `← Back to <parent>` shortcut plus jumps to topics that live on other
  floors). The panel also exposes portal shortcuts into deeper floors,
  child-room creation, reparenting, topic deletion (Creator phase), and
  encounter access.
- **Touch controls (bottom-right, floating):** mobile-friendly directional
  / interact buttons.

See [`CUSTOMIZATION.md`](./CUSTOMIZATION.md) for how to swap in your own
sprites and tilesets, and for where desktop subject exports are written from.

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

![Full pannable / zoomable mindmap with per-floor filter](./assets/ui/full-map-view.png)

Opened from the HUD `Map` button or by pressing <kbd>M</kbd>. The full map
view renders the dungeon mindmap with **drag-to-pan** and
**scroll-to-zoom**, plus `+` / `−` / `Reset` controls. It's intended for
inspecting the broader topic graph without leaving the dungeon. Rooms
directly connected to your currently focused room (and the edges to them)
are tinted in the accent color so children/related topics stand out.

A **Show current floor only** toggle (top of the dialog, on by default)
narrows the view to the floor you're currently on so deep subjects stay
readable. When the filter is on, the entry room from the parent floor is
drawn as a **dashed blue portal** with a dashed edge so you can still
navigate back up the hierarchy. Turn the toggle off to inspect the whole
graph at once.

In Creator phase, switch from **Navigate** to **Graph edit** mode to
rename, add, delete, or reparent topics directly from the mindmap so the
graph stays the source of truth and the dungeon layout remains a
generated view over it.

## 5) Minimap child highlighting

![Minimap highlights the focused room and its direct neighbors](./assets/ui/minimap-highlight.png)

The minimap in the bottom-left of the game shell tints the currently
focused room in the strong accent color, and any rooms **directly
connected** to it in a softer accent — so the children/connected topics of
the room you're standing in are immediately visible at a glance.

## 6) Creator-phase topic management (add / delete)

![Topic tab with add-child and delete-topic actions](./assets/ui/delete-topic.png)

During the **Create** phase the Topic tab exposes:

- A **bulk Add child topics** form that grows the mindmap from the currently
  focused room using either newline-separated or comma-separated topic lists.
- A **Change parent** control for safely moving a topic under a different
  parent without creating cycles.
- A **Delete topic** action (only on non-root rooms) that removes the
  focused room and any descendants that would become disconnected from the
  root once it's gone. Descendants still reachable via a cross-link are
  preserved.

The root topic cannot be deleted; the panel replaces the button with a
short explanatory note in that case.

The **Full Map** overlay now also includes a lightweight **Graph edit** mode
for these same authoring actions so the mindmap stays the source of truth and
the dungeon layout remains a generated view over that graph (see
[§4](#4-full-map-view)).

## 7) Help overlay

![Help overlay](./assets/ui/help-overlay.png)

The help dialog is opened from the `?` button (or keyboard `?`) and summarizes:

- Movement and interaction controls.
- What changes in each phase (Create, Scribe, Review).
- How encounters and review passes work.
- The <kbd>M</kbd> shortcut for the full mindmap view.

It also hosts the **Graphics style** toggle (see
[§7a Graphics style toggle](#7a-graphics-style-toggle)) so players can
switch the dungeon look without leaving a session.

It is meant to be a quick in-context rules reference while playing.

### 7a) Graphics style toggle

A persistent **Mind map / RPG** segmented control is available from both
the Welcome screen (top-right header) and the Help overlay. It switches
the visual treatment of the dungeon, the full map, and the minimap:

- **Mind map** — graph-style nodes (ellipses) connected by thin edges; the
  HUD/panels use the default cool palette.
- **RPG** — rectangular dungeon chambers connected by thick passageways,
  with a parchment-toned HUD/panel skin. In RPG mode the in-game scene
  also paints a tiled floor texture per floor (cycling between the three
  bundled tilesets so each floor reads as a distinct location — Ancient
  Library, Lost Archive, Deep Dungeon) and sprinkles decor (bookshelves,
  braziers, scroll piles) deterministically into each room.

Saved subjects are untouched — only the renderer changes. New users
default to RPG; existing installs are preserved on the mind-map look they
already know until they opt in.

### 7b) In-game floor isolation and stairs portals

The in-game dungeon scene now mirrors the **Full Map**'s per-floor view:
only rooms on the player's current floor are rendered, and the minimap
filters to match. On non-root floors the parent room is drawn with a
**stairs-up (↑)** portal marker; on the root floor each top-level
subtopic is drawn with a **stairs-down (↓)** marker so you can descend
into its sub-floor. Stand inside a portal room and press <kbd>E</kbd>
(or tap the on-screen interact button) to traverse — non-portal rooms
keep their existing interact behavior (open the note editor / record a
review pass). Travelling and teleporting from the room panel / map keep
the in-game floor in sync automatically.

## 8) Note editor modal (encounter resolution)

![Note editor modal in rich-text preview mode](./assets/ui/note-editor-modal.png)

This modal appears when opening a room encounter. It provides:

- A structured notes input area with an **Edit / Preview** toggle.
- Lightweight Markdown support — `**bold**`, `*italic*`, `` `code` ``,
  `-` bullet lists, and `[label](https://example.com)` links — rendered
  live in the Preview tab and persisted on submit.
- A manual confirmation checkbox.
- Deterministic validation checklist (word count + required sections).
- Quality bonus preview and submit/defeat action state.

This is the core learning loop UI where players convert study notes into
room completion progress. Saved notes are re-rendered as rich text in the
room panel's Notes tab so links and formatting stay live after the
encounter is defeated.

## 9) Archaeologist phase loot icons

During the **Archaeologist** phase, every room that has produced an
artifact (i.e. its encounter has been defeated) is decorated with a small
loot-chest sprite in the dungeon view. The icons make it easy to scan the
map for rooms whose artifacts and self-check prompts are ready to revisit;
they disappear automatically when you switch back to the Create or Scribe
phase so they don't clutter authoring/exploration.
