# ADR 001: Village Hub, Guide NPC, and Visual Overhaul

**Status:** Accepted  
**Date:** 2026-06-16  
**Author:** AI-assisted development  
**Tags:** architecture, UX, graphics, game-design

---

## Context

The Knowledge Dungeon application launched directly from a tabbed WelcomeScreen into a Phaser-rendered dungeon crawl. There was no intermediate "hub" space, no persistent guide character, and the visual presentation — while functional — lacked the polish expected of a playable game. Users reported three main gaps:

1. **No sense of place** — the jump from a form-based welcome page into a dungeon was abrupt.
2. **No guidance for first-time users** — the tutorial existed but was a separate button, not woven into the experience.
3. **Flat visuals** — sprites were minimal (24×24 NPCs, basic tilesets), no ambient animation.

## Decision

We undertook a five-phase overhaul to address these gaps. The key architectural decisions are documented below.

---

## Decision 1: Phaser-Rendered Village as the Hub

**Option considered:** React/CSS-based hub page vs. Phaser-rendered top-down village.

**Chosen:** Phaser-rendered village scene.

**Rationale:**
- The dungeon crawl already uses Phaser — adding a village scene reuses the same engine, physics, input handling, and asset pipeline.
- A Phaser village creates visual continuity: the player walks between the same tile-based world, keeping the mental model consistent.
- React overlays (HUD, info panels, modals) sit on top of the Phaser canvas, so we get the best of both: a game-engine world + rich React UI.
- Works identically on web (Vite) and Electron.

**Tradeoffs:**
- + Immersive, consistent experience
- + Reuses existing Phaser code (movement, camera, tweening)
- − More code than a CSS-only hub
- − Phaser game instance must be managed (destroyed/recreated on route changes)

**Implementation:**
- `VillageScene` extends `Phaser.Scene`, reuses the WASD/arrow movement pattern from `DungeonScene`.
- `VillageScreen` is a React component that creates/destroys the Phaser game via `useEffect`.
- Communication between Phaser and React happens through a callback object passed to the scene's `init()`.

---

## Decision 2: Ref-Based Callback Pattern for Phaser↔React Communication

**Problem:** Phaser scenes are created once inside a React `useEffect(() => {...}, [])`. If the callback object captures React state (e.g., `subjects`, `selectedClass`), those closures become stale on re-render.

**Chosen:** Store dynamic callbacks in a React `useRef`, and have the Phaser scene invoke `ref.current.onX()`. The ref is kept current via `useEffect` or direct assignment.

```typescript
const callbacksRef = useRef<VillageSceneEvents>(initialCallbacks);

// Keep ref in sync with latest state
useEffect(() => {
  Object.assign(callbacksRef.current, freshCallbacks);
}, [deps]);

// Phaser game created once, reads from ref
useEffect(() => {
  const game = createVillageGame({
    callbacks: {
      onStructureApproached: (id) => callbacksRef.current.onStructureApproached(id),
      // ...
    },
  });
}, []);
```

**Tradeoffs:**
- + No stale closures — Phaser always reads the latest React state
- + Game instance is created/destroyed only once
- − Slightly more verbose than direct callback passing

---

## Decision 3: Quest/Tutorial Step System in Session Store

**Chosen:** Add a `questStep` field to the existing Zustand `sessionStore`, with a typed `QuestStep` union and a `QUEST_ORDER` array.

**Rationale:**
- The session store is already the place for transient UI state (active screen, phase, selected class).
- A separate quest store would add complexity with no benefit — quest state is simple (a single enum value).
- Persisted to `localStorage` under `kd-quest-step` so progress survives page reloads.

**Implementation:**
- `QuestStep` type: `'intro' | 'meet-keeper' | 'create-subject' | ... | 'complete'`
- `QUEST_LABELS` map provides display text per step.
- `advanceQuestStep()` reads the current step from `getState()` and increments.
- The NPC dialogue component reads the current step to select context-aware dialogue lines from `villageLayout.ts`.

---

## Decision 4: NPC Dialogue as Static Data + Quest Routing

**Chosen:** Dialogue text lives in `villageLayout.ts` as a `questDialogue` map on the NPC definition. The `VillageScreen` reads the current quest step and selects the appropriate dialogue array.

**Alternative considered:** Dialogue JSON files loaded at runtime, or a dialogue graph with branching.

**Why not:** For the initial guide NPC, linear dialogue per quest step is sufficient. A full dialogue engine would be premature.

```typescript
// villageLayout.ts
{
  id: 'keeper',
  questDialogue: {
    'intro': ['Welcome...', 'Your first step...'],
    'meet-keeper': ['You found me!', 'Now create a subject...'],
    // ...
  }
}
```

---

## Decision 5: SVG + CSS Animations for Sprites (Not GIF/Spritesheet)

**Chosen:** All sprite animations use inline SVG `<style>` with CSS `@keyframes`. No external spritesheets or animated GIFs.

**Rationale:**
- SVGs are already the project's sprite format — no new asset pipeline needed.
- CSS animations in SVG work identically in all browsers and Electron.
- Animations are declarative, resolution-independent, and tiny (bytes vs. kilobytes for GIFs).
- Phaser's SVG loader rasterizes the SVG once, capturing the animated state at the loaded frame — so idle animations (breathing, floating) work in Phaser, while more complex multi-frame animations could use Phaser tweens on top.

**Examples:**
- Player walk: leg/arm rotation keyframes
- NPC float: `translateY` oscillation
- Brazier flame: multi-flame flicker with `scaleY` + `translateX` at different durations

---

## Decision 6: Enhanced Vector Style (Not Pixel Art)

**Chosen:** Keep the existing vector-art direction but add significantly more detail, better proportions, class-specific accessories, and richer color palettes.

**Rationale:**
- The project already uses SVG vectors throughout — a pixel-art conversion would require a completely new asset set and toolchain.
- Vector art scales cleanly across device pixel ratios and zoom levels.
- Matches the "scholarly/ethereal" tone of the Knowledge Dungeon theme better than retro pixel art.

**Tradeoffs:**
- + Matches existing art direction, no tooling change
- + Scales perfectly on retina/high-DPI displays
- − Less "retro game" nostalgia than pixel art
- − SVG rendering in Phaser rasterizes to fixed dimensions

---

## Decision 7: RPG-Style UI Components in Plain CSS

**Chosen:** All RPG-style UI (stat bars, rank badges, ornate panels) implemented with pure CSS custom properties, pseudo-elements, and keyframe animations. No UI library or game-engine UI.

**Rationale:**
- The project already has 2800+ lines of hand-written CSS with a well-established theming system (`--bg-panel`, `--accent`, etc.).
- Adding a UI library (e.g., a game UI framework) would be heavy and redundant.
- CSS `@keyframes` handle stat-bar shimmer, glow pulses, screen shake, and modal transitions without JavaScript cost.

---

## Decision 8: Scene State Sync via sceneRef + villageReady

**Problem:** Dynamic structures (dungeon portals) disappeared when returning from GameScreen to VillageScreen because the Phaser scene's `create()` and React's async data loading had a race condition.

**Chosen:** Use a dedicated `sceneRef` (set in `onReady` callback) plus a `villageReady` boolean state. The sync effect depends on `[villageReady, dynamicStructures, selectedClass]`, ensuring it fires both when the scene becomes ready AND when data arrives later.

```typescript
game.events.once('ready', () => {
  sceneRef.current = game.scene.getScene('VillageScene');
  setVillageReady(true);
});

useEffect(() => {
  const scene = sceneRef.current;
  if (!scene) return;
  scene.setDynamicStructures(dynamicStructures);
  scene.setPlayerClass(selectedClass ?? 'scholar');
}, [villageReady, dynamicStructures, selectedClass]);
```

**Tradeoffs:**
- + Eliminates the race between scene initialization and async data loading
- + Works on re-mount (returning from dungeon) as well as initial mount
- − Requires the `villageReady` state pillar

---

## Decision 9: Mobile Village Controls (Touch + HUD Drawer)

**Chosen:** Replicate the DungeonScene's touch-control pattern in VillageScene: single-finger drag for movement, tap for interact, two-finger pinch for zoom. The village HUD collapses into a bottom drawer on mobile with a toggle button.

**Implementation:**
- Touch handlers (`handleTouchDown/Move/Up`) produce `touchMoveVx/Vy` merged into the velocity vector each frame, matching DungeonScene's pattern.
- Pinch-to-zoom adjusts camera zoom between 0.6x and 2.4x.
- `isMobile` is reactive via `window.matchMedia('change')` listener.
- The `village-hud--mobile` class uses fixed positioning + CSS transitions for the drawer slide.

---

## Decision 10: Ambient World Elements (NPCs, Birds, Ponds, Signposts)

**Chosen:** Add decorative and ambient elements to make the village feel alive:
- **5 wandering NPCs** with patrol paths and learning quotes, rendered with distinct SVG sprites (Scholar, Wanderer, Sage).
- **6 flying birds** that sweep between waypoints with Phaser tweens.
- **3 ponds** with animated ripple SVGs.
- **Flowers** at the entrance for a welcoming feel.
- **5 directional signposts** at crossroads showing building directions on approach.

All decorative elements use the existing structure rendering pipeline with higher depth (11, above player depth 10) so the player walks behind them.

---

## Decision 11: Mixed-Model Quest Completion

**Chosen:** Steps 1–6 (village-detectable) advance automatically. Steps 7–9 (dungeon-only actions: clear room, write note, review artifact) require manual confirmation via a "Mark Complete" button on the quest board.

**Implementation:**
- `MANUAL_QUESTS` set in `sessionStore.ts` identifies manual steps.
- Quest board shows a "✓ Mark Complete" button beneath manual steps.
- `advanceQuestStep()` is called on button click.

---

## Decision 12: Data Management in the Village

**Chosen:** Add a "🛡 Data" modal to the village HUD with per-subject export and import capabilities, replacing the WelcomeScreen's Data tab for in-game use.

**Implementation:**
- `setDataOpen` state + modal with `exportSubjectToJson`, `importSubjectFromJson`, and `saveSubjectSnapshot` from the persistence service.
- Each subject has an Export button (downloads JSON file).
- File input for importing `.json` backups with automatic reload.

---

## Consequences

### Positive
- The village hub gives the game a persistent sense of place and a natural home for navigation.
- The quest system provides clear guardrails for new users without being mandatory.
- Animated sprites, birds, NPCs, and particles make the world feel alive at near-zero runtime cost.
- Touch controls + pinch-to-zoom make the village fully playable on mobile devices.
- Scene state sync eliminates the portal-disappearing bug on return from dungeons.
- All changes work on both web and Electron with no platform-specific code.
- Clean TypeScript compilation across the entire codebase.

### Negative
- The village Phaser instance adds ~2–3 MB to the initial bundle (Phaser itself is the bulk — already loaded for dungeons).
- The `activeScreen` routing adds a new dimension of state that must be kept consistent across stores.
- Quest step persistence in localStorage means clearing browser data resets quest progress.
- 5 wandering NPCs + 6 birds + particle effects add rendering overhead on low-end mobile devices.

### Mitigations
- Phaser is already a dependency (loaded for dungeons), so the village does not increase the bundle uniquely.
- Active screen transitions are linear and well-defined (Welcome → Village → Game), reducing state explosion risk.
- Quest step is a single localStorage key — easy to reset, easy to debug.
- NPCs use simple tweens (no per-frame pathfinding); birds use single tweens with `hold` pauses for efficiency.

---

## Related Documents

- `progress.md` — Detailed implementation checklist
- `src/data/villageLayout.ts` — Village map data, NPC definitions, signpost info
- `src/store/sessionStore.ts` — Quest step types, advancement logic, MANUAL_QUESTS
- `src/game/scenes/VillageScene.ts` — Phaser scene implementation, touch controls, birds
- `src/ui/screens/VillageScreen.tsx` — React wrapper, quest-aware dialogue, data modal
