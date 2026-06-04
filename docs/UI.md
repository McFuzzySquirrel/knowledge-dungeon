# UI Walkthrough

This document captures key UI surfaces in Knowledge Dungeon and explains what each screen is for.

## 1) Welcome screen (phase/class/subject setup)

![Welcome screen](./assets/ui/welcome-screen.png)

Use this screen to:

- Choose the current phase (Create, Scribe, Review/Archaeologist), which controls the active gameplay loop.
- Pick a study archetype (Scholar, Cartographer, Archivist), which applies your class/perk identity.
- Create a new subject from a root topic.
- Browse previously created subjects by **subject name** instead of raw id, with room counts visible from home.
- Refresh the saved subject list if you want to rescan local data before loading one.
- Access the **Data** tab, which exposes import/export tools. In desktop mode you also get folder-level helpers.

> 🔒 **Privacy**: all data is stored **locally on your device only**. In the web version this means
> your browser's `localStorage`; in the desktop app it is written to your user-data folder.
> Nothing is ever sent to a server. Use the **Export** tools in the **Data** tab to back up
> subjects before clearing browser storage.

This is the entry point for every session and determines how the rest of the UI behaves.

### 1a) Selection readiness state

![Welcome screen with readiness summary](./assets/ui/welcome-selections-ready.png)

The **Current selections** card echoes the active phase and archetype, and
shows a readiness line that turns green once an archetype is selected.

## 2) Main game shell (HUD + minimap + room panel)

![Main game shell](./assets/ui/game-screen.png)

The game shell combines several persistent UI regions, all rendered as
**floating overlays** above a full-canvas Phaser scene so the dungeon map
gets the maximum amount of screen space:

- **Top HUD (floating):** subject, room count, XP/rank, active phase, plus
  **Map**, **Teleport**, **Home**, and **Help** buttons. `Map` opens the full
  topic-graph view, `Teleport` opens a floor/room jump flow with a cooldown,
  `Home` returns to subject selection, `?` opens the help overlay.
- **Center gameplay canvas:** Phaser dungeon movement and interactions. The
  camera automatically zooms **in** when the player is standing inside a
  room (so the active room feels focused) and **out** when traveling along
  a corridor between rooms (so more of the map is visible — see
  [§3 Auto-zoom](#3-auto-zoom-roomcorridor) below). The player is drawn
  with a class-themed SVG sprite (Scholar / Cartographer / Archivist) and
  the spawn room is marked with a signpost, accompanied by a friendly
  **guide NPC** with a hint speech bubble that points first-time players
  at the WASD/E controls. In RPG mode, corridors between rooms are
  decorated with a stone pathway tile texture so the dungeon reads as
  connected chambers rather than a graph.
- **Minimap (bottom-left, floating):** quick room-location awareness. The
  current room and any rooms **directly connected** to it are highlighted
  in the accent color (see [§5 Minimap child highlighting](#5-minimap-child-highlighting)).
- **Right room panel (floating):** a quick-access **Collections** row for
  **Inventory**, **Badges**, and **Diary** keeps progression actions visible
  without crowding the HUD. The panel also includes topic metadata,
  breadcrumbs, and travel
  shortcuts split into two sections — **Connected topics on this floor**
  (siblings/neighbors on the same floor) and **Travel to related floors**
  (a `← Back to <parent>` shortcut plus jumps to topics that live on other
  floors). The panel also exposes portal shortcuts into deeper floors,
  child-room creation, reparenting, topic deletion (Creator phase), and
  encounter access. A tab-row **Expand / Collapse** control widens the panel
  for note and image-heavy study sessions.
- **Touch controls (bottom-right, floating):** mobile-friendly directional
  / interact buttons.

See [`CUSTOMIZATION.md`](./CUSTOMIZATION.md) for how to swap in your own
sprites and tilesets, and for where desktop subject exports are written from.

![Room panel collections shortcuts](./assets/ui/room-panel-collections.png)

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

![Full pannable / zoomable topic graph with per-floor filter](./assets/ui/full-map-view.png)

Opened from the HUD `Map` button or by pressing <kbd>M</kbd>. The full map
view renders the dungeon topic graph with **drag-to-pan** and
**scroll-to-zoom**, plus `+` / `−` / `Reset` controls. You can also drag
individual room nodes to reposition the layout while keeping each
connection anchored to the moved node. It's intended for inspecting the
broader topic graph without leaving the dungeon. Rooms
directly connected to your currently focused room (and the edges to them)
are tinted in the accent color so children/related topics stand out.

A **Show current floor only** toggle (top of the dialog, on by default)
narrows the view to the floor you're currently on so deep subjects stay
readable. When the filter is on, the entry room from the parent floor is
drawn as a **dashed blue portal** with a dashed edge so you can still
navigate back up the hierarchy. Turn the toggle off to inspect the whole
graph at once.

In Creator phase, switch from **Navigate** to **Graph edit** mode to
rename, add, delete, or reparent topics directly from the map so the
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
for these same authoring actions so the graph stays the source of truth and
the dungeon layout remains a generated view over that graph (see
[§4](#4-full-map-view)).

## 7) Help overlay

![Help overlay](./assets/ui/help-overlay.png)

The help dialog is opened from the `?` button (or keyboard `?`) and summarizes:

- Movement and interaction controls.
- The full map controls, including drag-to-pan, zoom, and moving room nodes.
- The room panel collections shortcuts for Inventory, Badges, and Diary.
- Teleport usage and its cooldown.
- What changes in each phase: Creator, Scribe, and Archaeologist.

It is meant to be a quick in-context rules reference while playing.

### 7a) In-game floor isolation and stairs portals

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
- A **Save draft** path when notes are not yet at final pass quality, so
  partial progress is preserved while learners iterate.
- In Scribe phase, image cards in the Notes tab include an **Insert in note**
  action so learners can place images without manually writing token syntax;
  Archaeologist mode remains view-only for images.
- Lightweight Markdown support — `**bold**`, `*italic*`, `` `code` ``,
  `-` bullet lists, and `[label](https://example.com)` links — rendered
  live in the Preview tab and persisted on submit.
- A manual confirmation checkbox.
- Deterministic validation checklist (word count + required sections).
- Quality bonus preview and submit/defeat action state.

This is the core learning loop UI where players convert study notes into
room completion progress. Saved notes are re-rendered as rich text in the
room panel's Notes tab so links, images, and formatting stay live after the
encounter is defeated. Image add/remove/edit controls are restricted to the
Scribe phase so Archaeologist mode stays review-focused.

## 9) Archaeologist phase loot icons

During the **Archaeologist** phase, every room that has produced an
artifact (i.e. its encounter has been defeated) is decorated with a
glowing, pulsing loot-chest sprite in the dungeon view — two stacked
additive halos pulse around the chest so collectables are immediately
visible as you scan the map. The icons make it easy to find rooms whose
artifacts and self-check prompts are ready to revisit; they disappear
automatically when you switch back to the Create or Scribe phase so they
don't clutter authoring/exploration.

## 10) Inventory, badges, and diary panel

## 11) Mobile-responsive layout

Knowledge Dungeon adapts to three distinct viewport tiers. Electron and standard desktop
browsers (≥ 960 px wide) are completely unaffected — the sidebar HUD, minimap, and all
stats remain identical.

### 11a) Desktop game screen (≥ 960 px) — no regression

![Desktop game screen — sidebar HUD and minimap intact](./assets/ui/desktop-game-screen.png)

The full desktop layout: left sidebar with subject label, room/XP/phase stats, collection
icons, phase-switcher, and action row. Minimap in the bottom-right corner.

### 11b) Welcome screen — mobile (≤ 480 px)

![Welcome screen at 390px mobile viewport](./assets/ui/mobile-welcome-screen.png)

At ≤ 480 px the welcome screen gets tighter margins and padding so it fits comfortably
on a phone screen without horizontal scrolling.

### 11c) Player Setup tab — single-column phase and archetype grids (≤ 600 px)

![Player Setup tab with single-column phase and class grids on mobile](./assets/ui/mobile-setup-screen.png)

Below 600 px the phase grid and archetype grid each collapse to a single column so every
card is full-width and tap targets remain comfortable.

### 11d) Tablet HUD (≤ 900 px) — compact top rail

![Game HUD at 768px tablet viewport](./assets/ui/tablet-game-hud.png)

Between 768–900 px (e.g. a landscape phone or portrait tablet) the HUD rearranges into
a horizontal top rail: subject stats flow inline across the top, with the info button,
phase switcher, and action row beneath. The minimap stays visible.

### 11e) Mobile game HUD (≤ 480 px) — stripped top rail

![Game HUD at 390px mobile viewport](./assets/ui/mobile-game-hud.png)

On phones (≤ 480 px) the verbose stat labels are hidden, the minimap is hidden to
maximise canvas space, and all HUD action buttons have a minimum 44 × 44 px touch
target. The subject label is truncated with an ellipsis. The phase controls and
action row remain fully accessible.

### 11f) Room panel — mobile (≤ 480 px)

![Room panel open at 390px mobile viewport](./assets/ui/mobile-room-panel.png)

The room info panel slides up from the bottom at mobile sizes and stretches to the full
viewport width. Tabs (Topic / Notes / Images / Artifact / Self-check) remain accessible
via a horizontal scroll row, and the panel itself scrolls vertically for long content.



![Inventory, badges, and diary modal opened from the room panel](./assets/ui/inventory-badges.png)

The room panel **Collections** buttons (**🎒 Inventory**, **🏅 Badges**,
**📚 Diary**) open a shared tabbed modal
that surfaces the player's progression rewards:

- **Inventory** lists collected loot artifacts, each rendered as a card
  showing its name, rarity (common/rare/epic, color-coded), and flavour
  description.
- **Badges** lists earned milestone badges as compact pill chips.
- **Diary / Collected Notes** lists archaeologist pickups and lets you click
  an entry to open its full collected note for recall.
- The header also shows the player's current XP total and rank tier so
  progression context is always one click away.
