# Implementation Progress — Visual & Gameplay Overhaul

## Phase 1 — Village Hub ✅

### 1.1 — Village Scene & Rendering ✅
- [x] Created `villageLayout.ts` — Building/NPC definitions, portal slot system, map layout (36×30 tiles)
- [x] Created `VillageScene.ts` — Phaser scene with ground/path tiles, building placement, player movement (WASD/arrows), NPC pathing, building proximity detection, E key interact
- [x] Created `createVillageGame.ts` — Phaser.Game factory for village
- [x] Created `VillageScreen.tsx` — React wrapper with HUD sidebar, class picker, info panels, NPC dialogue, create-subject modal
- [x] Created village SVG sprites (11): keeper-tower, guild-hall, dungeon-portal, training-gate, fountain, tree, lamp, bench, village-gate, ground-tile, path-tile
- [x] Created `npc-keeper.svg` — Enhanced 128×128 guide NPC with breathing animation
- [x] Updated `sessionStore.ts` — Added `activeScreen` routing ('welcome'|'village'|'game') + `setActiveScreen`
- [x] Updated `App.tsx` — Three-state routing: Welcome → Village → Game
- [x] Updated `WelcomeScreen.tsx` — Routes to village after subject creation
- [x] Updated `GameScreen.tsx` — "Home" button returns to village instead of clearing everything
- [x] Added village CSS (HUD, info panels, NPC dialog, create modal, responsive mobile layout)
- [x] Fixed stale closure bug — Phaser callbacks use refs + store getters for fresh data

### New village files:
| File | Purpose |
|------|---------|
| `src/game/scenes/VillageScene.ts` | Phaser village rendering scene |
| `src/game/createVillageGame.ts` | Phaser game factory |
| `src/ui/screens/VillageScreen.tsx` | React village hub |
| `src/data/villageLayout.ts` | Village map data |
| `public/assets/sprites/npc-keeper.svg` | Guide NPC |
| `public/assets/sprites/village/*.svg` | 11 village sprites |

## Phase 2 — Guide NPC & Onboarding ✅

### 2.1 — Quest/Task System ✅
- [x] Added `QuestStep` type + `QUEST_ORDER` + `QUEST_LABELS` to session store
- [x] Added `questStep`, `setQuestStep`, `advanceQuestStep` to session store
- [x] Persists quest progress in localStorage
- [x] NPC dialogue adapts based on current quest step (10 dialogue stages: intro → complete)
- [x] Quest advancement on actions: approach keeper, create subject, pick archetype, start tutorial, enter dungeon
- [x] Quest log UI in village HUD with progress dots + current step label + hint text
- [x] Typewriter text animation for NPC dialogue
- [x] Quest CSS (progress dots, animations, pulse effects)

### Files modified:
| File | Changes |
|------|---------|
| `src/store/sessionStore.ts` | +QuestStep types, +QUEST_LABELS, +QUEST_ORDER, +questStep state + methods |
| `src/data/villageLayout.ts` | +questDialogue per-step dialogue, +VillageNpc.questDialogue field |
| `src/ui/screens/VillageScreen.tsx` | Quest-aware dialogue, quest log HUD, quest advancement triggers |
| `src/styles.css` | Quest log + typewriter CSS |

## Phase 3 — Sprite & Graphics Overhaul ✅

### 3.1 — Player Sprites (4) ✅
- [x] **Scholar** (`player-hero.svg`) — Already had walk animation, kept as-is
- [x] **Cartographer** (`player-explorer.svg`) — Added walk animation (legs, arms), cloak/hood, compass accessory
- [x] **Archivist** (`player-archivist.svg`) — Added walk animation, glasses, book + quill accessories
- [x] **Default** (`player.svg`) — Upgraded from simple circle to full character with walk animation

### 3.2 — NPC Sprites (4) ✅
- [x] All NPCs **upgraded from 24×24 to 64×80** with idle float animation
- [x] Scribe: Journal + quill, blue robes
- [x] Scout: Lantern + pouch, green tunic
- [x] Smith: Apron + hammer, brown worker clothes
- [x] Contributor: Book + star medal/contribution, purple robes

### 3.3 — Object Sprites ✅
- [x] **Brazier** — Animated flame flicker (3 CSS keyframes)
- [x] **Chest (closed)** — Subtle pulse animation
- [x] **Chest (open)** — Glow pulse + sparkle dots
- [x] **Door** — Enhanced detail with wood grain, iron bands
- [x] **Door (locked)** — Lock shake animation + keyhole detail
- [x] **Signpost** — Upgraded to detailed 128×160 with sway animation

### 3.4 — Tilesets (8) ✅
- [x] All 8 biome tilesets enhanced with more detail layers and CSS animations:
  - Lost Archive: Rune glow, stone texture
  - Garden Ruins: Moss growth animation, organic shapes
  - Deep Dungeon: Crystal pulse, vertical lines
  - Iron Forge: Forge glow, grid pattern
  - Wind Temple: Wind flow lines, ethereal feel
  - Neon Circuit City: Circuit trace animations
  - Ancient Library: Floating dust, book spine details
  - Utility Vault: Flicker light, panel lines

## Phase 4 — Animation Overhaul ✅

### 4.1 — CSS Animations ✅
- [x] `screen-fade-in` — 400ms opacity fade on screen mount
- [x] `modalSlideUp` — 250ms scale + translate for modal open
- [x] `backdropFade` — 200ms backdrop fade
- [x] `panelSlideIn` — 250ms slide-in for room panel
- [x] `toastSlideIn` — 300ms slide-in from right
- [x] `typewriterReveal` — Clip-path typewriter effect for NPC text
- [x] `statBarShimmer` — Animated gradient shimmer on progress bars
- [x] `rankGlow` — Pulsing glow on rank badge
- [x] `enterBtnPulse` — Pulsing glow on "Enter Dungeon" button
- [x] Card hover lift, tab fade transitions

### 4.2 — Phaser Particles ✅
- [x] `createAmbientParticles()` — Floating dust motes throughout dungeon
- [x] Particle texture generated procedurally via `createParticleDotTexture()`
- [x] Particles recreated on floor change

### 4.3 — Screen Transitions ✅
- [x] Fade-in on GameScreen mount
- [x] Fade-in on VillageScreen mount
- [x] Camera shake (200ms) on artifact collection

## Phase 5 — UI Polish ✅

### 5.1 — RPG Stat Bars ✅
- [x] `rpg-stat-bar` component with animated gradient fill
- [x] `rpg-stat-bar-fill` with shimmer animation + color variants (good/warning/danger)
- [x] Integrated into Hud review progress bar

### 5.2 — Rank Badge ✅
- [x] `hud-rank-badge` with pulsing glow, pill shape
- [x] Replaces plain text rank display

### 5.3 — Ornate Panel Decorations ✅
- [x] `ornate-panel` class with corner accent pseudo-elements
- [x] Gold corner flourishes on panels and modals

### 5.4 — Screen Shake ✅
- [x] Phaser camera shake on artifact collection (`cameras.main.shake(200, 0.005)`)
- [x] CSS `screen-shake` keyframe animation utility

### 5.5 — XP Popup Component ✅
- [x] Created `XpPopup.tsx` — Floating "+XP" text with float-up + fade animation

## Files Created (37 total):

### New game files:
| File | For |
|------|-----|
| `src/game/scenes/VillageScene.ts` | Village Phaser scene |
| `src/game/createVillageGame.ts` | Village game factory |
| `src/ui/screens/VillageScreen.tsx` | Village React screen |
| `src/data/villageLayout.ts` | Village map data |
| `src/ui/components/XpPopup.tsx` | Floating XP text |

### New sprite files (23):
| Directory | Files |
|-----------|-------|
| `public/assets/sprites/village/` | 11 building/decor SVGs |
| `public/assets/sprites/` | npc-keeper.svg, player.svg, signpost.svg |
| `public/assets/sprites/objects/` | brazier.svg, chest-closed.svg, chest-open.svg, door.svg, door-locked.svg |
| `public/assets/tilesets/` | 8 biome tilesets |
| `public/assets/sprites/` | npc-scribe.svg, npc-scout.svg, npc-smith.svg, npc-contributor.svg, player-explorer.svg, player-archivist.svg |

### Modified files (7):
| File | Changes |
|------|---------|
| `src/store/sessionStore.ts` | +activeScreen, +QuestStep system, +localStorage persistence |
| `src/ui/App.tsx` | Three-screen routing (Welcome/Village/Game) |
| `src/ui/screens/WelcomeScreen.tsx` | Routes to village after subject creation |
| `src/ui/screens/GameScreen.tsx` | handleHome returns to village, screen-fade-in |
| `src/ui/components/Hud.tsx` | RPG stat bar + rank badge + shimmer |
| `src/game/scenes/DungeonScene.ts` | Ambient particles, camera shake on artifact |
| `src/styles.css` | +300+ lines: village CSS, quest log, animations, RPG bars, ornate panels |

### Key Architecture Decisions:
- **Phaser for village rendering** — matches dungeon aesthetic, same engine, immersive
- **Ref-based callbacks** — avoids stale closures between React state and Phaser events
- **Store getters in Phaser callbacks** — ensures latest state without re-creating game
- **Quest system in session store** — simple, persists to localStorage, no new store needed
- **SVG CSS animations** — all sprite animations done via SVG inline `<style>`, works everywhere
