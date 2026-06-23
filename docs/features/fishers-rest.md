# Feature: "Fisher's Rest" — Fishing Mini-Game

## 1. Feature Overview

**Feature Name:** Fisher's Rest — Fishing Mini-Game
**Parent Document:** [docs/PRD.md](../PRD.md)
**Status:** Draft
**Summary:** Adds a side-view fishing mini-game accessible from village ponds located near dungeon portals. Players cast a line into the water, wait for a bite, and reel in fish using a timed click. Each caught fish triggers a recall question pulled randomly from a cleared room in the nearest dungeon portal's subject. Answering correctly keeps the fish (added to collection) and awards XP; answering incorrectly lets the fish escape. A new **Fish Stand** building in the village displays the player's full fish collection across all subjects.

**Scope:**
- New Phaser fishing scene with side-view cast-and-wait gameplay
- 2–3 new interactive "fishing pond" structures placed near dungeon portal slots in the village
- Recall question pulling from cleared rooms in the nearest dungeon subject
- Fish rarity system (Common, Rare, Epic) with weighted random rolls
- Fish collection persisted per player alongside progression data
- Fish Stand building in the village with a gallery of collected fish
- XP awards for correctly answering recall questions during fishing
- Fishing-related badges in the progression system

**Out of scope:**
- Fishing in dungeon rooms or non-village scenes
- Bait/lure inventory system or consumable fishing items
- Fish trading or selling mechanics
- Multiplayer or competitive fishing
- Aquatic dungeon biomes or underwater exploration
- Fish-only subject linking (fish always tie back to the nearest dungeon's rooms)

**Dependencies:**
- Phase 2 complete (Village Hub with building interaction pattern, NPC system, portal slots)
- Phase 3c (Gameplay Depth — boss rooms, enhanced loot) not required; fishing is independent of boss/loot changes
- No other features depend on this one

---

## 2. Context: Existing System State

**Completed PRD Phases:**
- [x] Phase 0: Foundation
- [x] Phase 1: Core Game Loop
- [x] Phase 2: Village Hub & UX Polish
- [ ] Phase 3: Visual Unification & Gameplay Depth (in progress)
- [ ] Phase 4: Advanced Features
- [ ] Phase 5: Quality & Scale

**Relevant Existing Components:**

| Component | File | What Changes |
|-----------|------|-------------|
| Village scene | `src/game/scenes/VillageScene.ts` | Add fishing pond structure rendering + interaction routing |
| Village layout | `src/data/villageLayout.ts` | Add 2–3 fishing pond structures, Fish Stand building, portal-to-pond proximity mapping |
| Village screen | `src/ui/screens/VillageScreen.tsx` | Handle `fishing-pond` and `fish-stand` structure interactions; add recall question modal |
| Structure type union | `src/data/villageLayout.ts:30` | Add `'fishing-pond'` and `'fish-stand'` to `VillageStructure.type` |
| Review domain | `src/core/review/reviewDomain.ts` | Call `generateSelfCheckPrompts` for fishing recall questions (read-only — no modifications) |
| Progression types | `src/core/progression/types.ts` | Add fishing badge IDs and XP constants |
| Progression store | `src/store/progressionStore.ts` | Add `fishCollection: FishEntry[]` and fishing XP tracking |
| Persistence types | `src/core/validation/persistence/types.ts` | Add `FishCollection` to `ProgressionSnapshot` |
| Texture loading | `src/game/scenes/VillageScene.ts:177-210` | Add fishing pond SVG and Fish Stand SVG to preload |
| Sprite paths | `src/game/scenes/VillageScene.ts:21-51` | Add `fishingPond` and `fishStand` sprite entries |

**Existing Agents Involved:**

| Agent | Domain |
|-------|--------|
| `game-engineer` | FishingScene, fish animations, casting mechanics, bobber/bite timing, fishing pond rendering |
| `ui-engineer` | Fish Stand info panel, recall question overlay, fish collection gallery, VillageScreen integration |
| `core-logic-engineer` | Fish data types, fish store/persistence, recall question pulling, XP integration, fishing badges |
| `village-content-designer` | Fishing pond positions, Fish Stand building definition, fishing NPC dialogue, fish type catalog |
| `qa-engineer` | Component/integration tests for fishing scene, collection, persistence round-trips |

**Established Conventions:**
- Phaser scenes in `src/game/scenes/` extending `Phaser.Scene` with `preload()` / `create()` / `update()`
- SVG sprites loaded in `preload()`, referenced via `TEX` consts and `SPRITE_PATHS`
- Building interactions via `onStructureInteract(structureId)` callback → VillageScreen React handler
- Zustand stores with `create<T>()((set) => ({...}))` pattern
- All data local-first — no network calls
- Recall questions generated via `generateSelfCheckPrompts()` from `src/core/review/reviewDomain.ts`
- React overlays for modals (recall question, fish stand) positioned over the Phaser canvas

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals
- Provide a relaxing, skill-based side-view fishing mini-game accessible from village ponds
- Tie fishing to studying by requiring correct recall question answers to keep caught fish
- Add a collectible fish system with rarity tiers and a Fish Stand gallery
- Position fishing ponds near dungeon portals so each pond is associated with a specific subject
- Award XP and badges for fishing milestones to integrate with the progression system

### 3.2 Non-Goals
- No bait, lures, rods, or consumable fishing inventory
- No fish trading, selling, or crafting
- No dungeoneering or combat fishing mechanics
- No multiplayer or competitive fishing
- No changes to the existing decorative ponds (they remain non-interactive)
- No changes to dungeon scene navigation or room mechanics
- No breaking changes to existing village building interaction pattern

---

## 4. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| FSH-US-01 | Student | Approach a fishing pond near a dungeon portal and press E to start fishing | I can take a break from studying while still engaging with my subject material | Must |
| FSH-US-02 | Student | Cast a line, wait for a bite, and click to reel in a fish | I experience a satisfying skill-based mini-game | Must |
| FSH-US-03 | Student | Answer a recall question from the nearby dungeon's cleared rooms after catching a fish | The fish I keep reinforces what I've studied | Must |
| FSH-US-04 | Student | See my collected fish displayed at the Fish Stand building | I can admire my collection and feel a sense of accomplishment | Must |
| FSH-US-05 | Student | Earn XP for correctly answering fishing recall questions | My fishing time contributes to my overall progression | Should |
| FSH-US-06 | Lifelong Learner | Catch fish of different rarities (Common, Rare, Epic) | I'm motivated to keep fishing for rare catches | Should |
| FSH-US-07 | Power User | Earn badges for fishing milestones (first catch, 25 fish, full collection) | I have additional goals to work toward | Could |
| FSH-US-08 | Student | See which dungeon each fish came from in my collection | I can associate fish with specific subjects I'm studying | Should |

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

**Files modified:**

| File | Change |
|------|--------|
| `src/data/villageLayout.ts` | Add `'fishing-pond'` and `'fish-stand'` to `VillageStructure.type` union; add 2–3 `fishing-pond` structures and 1 `fish-stand` structure to `VILLAGE_MAP.structures`; add portal-proximity helper |
| `src/game/scenes/VillageScene.ts` | Add `fishingPond` and `fishStand` entries to `SPRITE_PATHS` and `TEX`; add `fishing-pond` and `fish-stand` rendering in `create()`; emit `onStructureInteract` for fishing ponds |
| `src/ui/screens/VillageScreen.tsx` | Add `'fishing-pond'` and `'fish-stand'` to `infoPanel.type` union; handle fishing pond interaction → launch FishingScene or transition to FishingScreen; handle fish stand → show collection gallery |
| `src/core/progression/types.ts` | Add `FSH_XP_PER_CORRECT_ANSWER = 5` constant; add fishing badge IDs |
| `src/store/progressionStore.ts` | Add `fishCollection: FishEntry[]` to state; add `addFish()`, `getFishCollection()` actions |
| `src/core/validation/persistence/types.ts` | Add `FishEntry` and `FishCollection` types to `ProgressionSnapshot` |

**No files removed.**

### 5.2 New Components

| File | Purpose |
|------|---------|
| `src/game/scenes/FishingScene.ts` | New Phaser scene: side-view fishing mini-game with casting, waiting, biting, reeling, catch animation |
| `src/game/systems/fishingTypes.ts` | Fish rarity enum, `FishEntry` type, `FishCatalog` (all catchable fish definitions with names, rarities, sprite references) |
| `src/game/systems/fishingMechanics.ts` | Pure logic: cast delay timer, bite window timing, rarity roll, recall question pulling |
| `src/core/fishing/fishCollectionService.ts` | Fish collection persistence layer (add/remove/query fish, serialize for localStorage/filesystem) |
| `src/ui/components/FishStandPanel.tsx` | React component: fish collection gallery grid with rarity badges, subject labels, empty state |
| `src/ui/components/FishingRecallModal.tsx` | React overlay: displays recall question after catch, text input for answer, feedback on correct/incorrect |
| `public/assets/sprites/village/fishing-pond.svg` | SVG sprite for interactive fishing pond (distinct from decorative pond) |
| `public/assets/sprites/village/fish-stand.svg` | SVG sprite for Fish Stand building |
| `public/assets/sprites/fishing/` | SVG sprites for fish silhouettes (3+ variants), bobber, fishing rod, water surface, pier |

### 5.3 Technology Additions

**No new npm dependencies required.** All visuals will be SVG sprites loaded via Phaser's existing `this.load.svg()` pipeline. The mini-game uses standard Phaser 3 features (tweens, timers, input, sprites).

---

## 6. Functional Requirements

| ID | Requirement | Affects Existing | Priority |
|----|-------------|-----------------|----------|
| FSH-FR-01 | 2–3 fishing pond structures are placed in the village map near dungeon portal slots | `villageLayout.ts` | Must |
| FSH-FR-02 | Fishing ponds are visually distinct from decorative ponds and marked as interactive | `VillageScene.ts` | Must |
| FSH-FR-03 | Player can press E (keyboard) or tap (touch) on a fishing pond to enter the fishing mini-game | `VillageScreen.tsx`, `VillageScene.ts` | Must |
| FSH-FR-04 | Fishing scene is a new side-view Phaser scene with water (bottom 60%), pier (top 40%), and player avatar on the pier | New (`FishingScene.ts`) | Must |
| FSH-FR-05 | Player clicks anywhere on the water to cast the line; casting animation plays (line extends, bobber lands on water) | New | Must |
| FSH-FR-06 | After casting, a random wait interval (3–15 seconds) begins; idle bobber bobs gently in the water | New | Must |
| FSH-FR-07 | During the wait, a fish silhouette swims toward the bobber from off-screen (side or depth) | New | Must |
| FSH-FR-08 | When the fish reaches the bobber, a bite indicator appears (bobber splash + visual/audio cue); player must click within a 2-second window to set the hook | New | Must |
| FSH-FR-09 | If the player clicks during the bite window, the fish is hooked (reeling animation, fish pulled up). If the player misses the window, the fish escapes and the line resets | New | Must |
| FSH-FR-10 | On successful hook, fish rarity is determined by weighted random roll: 65% Common, 28% Rare, 7% Epic | New | Must |
| FSH-FR-11 | A recall question is pulled from a random cleared room in the nearest dungeon portal's subject using the existing `generateSelfCheckPrompts` function | `reviewDomain.ts` (read-only call) | Must |
| FSH-FR-12 | Recall question is displayed as a React overlay in the Fishing scene; player types a free-text answer and submits | New | Should |
| FSH-FR-13 | Free-text answer is self-evaluated (player clicks "I got it right" or "I need to review") rather than auto-graded — consistent with Archaeologist self-check flow | New | Must |
| FSH-FR-14 | If player marks "I got it right": fish is added to collection, XP awarded (5 XP base, scaled by fish rarity: Common ×1, Rare ×1.5, Epic ×2) | New | Must |
| FSH-FR-15 | If player marks "I need to review": fish escapes, no XP, fishing line resets | New | Must |
| FSH-FR-16 | Fish Stand building is placed in the village map with its own SVG sprite and grid position | `villageLayout.ts` | Must |
| FSH-FR-17 | Approaching the Fish Stand and pressing E shows the player's fish collection gallery (React overlay) | `VillageScreen.tsx` | Must |
| FSH-FR-18 | Fish collection gallery shows each fish with its name, rarity badge, and the subject name it came from; empty state shows "No fish caught yet — visit a fishing pond!" | New | Must |
| FSH-FR-19 | Fish collection persists across sessions alongside existing progression data | `progressionStore.ts`, persistence layer | Must |
| FSH-FR-20 | Fishing-related badges awarded at milestones: "First Catch" (1 fish), "Angler" (10 fish), "Master Angler" (25 fish), "Full Creel" (catch one of every fish type) | `progression/types.ts` | Could |
| FSH-FR-21 | A "Return to Village" button (Escape key or UI button) exits the fishing scene and returns to the village at the pond's position | `FishingScene.ts` | Must |
| FSH-FR-22 | Fishing pond detects the nearest dungeon portal (by grid distance) to determine which subject's rooms to pull recall questions from | `villageLayout.ts` | Must |
| FSH-FR-23 | If the nearest dungeon portal's subject has no cleared rooms, fishing shows a message: "Defeat encounters in the nearby dungeon to unlock fish here!" | `FishingScene.ts` | Must |

---

## 7. Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FSH-NF-01 | Fishing scene loads in under 500ms on scene transition (sprites are lightweight SVGs, no large textures) | Must |
| FSH-NF-02 | All fishing mechanics are deterministic — same input yields same bite timing and rarity based on a seeded RNG from the current subject + fish count | Should |
| FSH-NF-03 | Fish collection data stays under 50KB even with 100+ fish entries (each entry is ~200 bytes) | Should |
| FSH-NF-04 | No network calls during fishing — all mechanics are local | Must |
| FSH-NF-05 | Fishing scene runs at 30+ FPS on mid-range hardware (simple sprite animations, no heavy particles) | Must |
| FSH-NF-06 | Touch controls: tap water to cast, tap bobber to reel, tap overlay to submit self-evaluation | Must |
| FSH-NF-07 | Keyboard controls: click water to cast, click bobber to reel, Tab/Enter to navigate recall modal | Should |
| FSH-NF-08 | Fishing scene gracefully handles subjects with zero cleared rooms (shows informative message rather than error) | Must |

---

## 8. Agent Impact Assessment

### 8.1 Existing Agents — Extended Responsibilities

| Agent | New Responsibilities | Modified Boundaries |
|-------|---------------------|-------------------|
| `game-engineer` | Implement `FishingScene.ts` (new Phaser scene with side-view layout, cast/wait/bite/reel mechanics, fish swimming animations, bobber physics, pier/water rendering). Add fishing pond and fish stand sprite rendering to `VillageScene.ts`. Create fish sprite assets. | Creates 2–3 new files in `src/game/`; modifies `VillageScene.ts` (~30 lines added for new structure types + sprite entries) |
| `ui-engineer` | Implement `FishStandPanel.tsx` (collection gallery with grid, rarity badges, empty state) and `FishingRecallModal.tsx` (recall question overlay with self-evaluation). Extend `VillageScreen.tsx` to handle `fishing-pond` and `fish-stand` info panel types and fishing scene transitions. | Creates 2 new React components; modifies `VillageScreen.tsx` (~50 lines: new info panel types, scene transition handler) |
| `core-logic-engineer` | Define `FishEntry`, `FishCollection`, and `FishCatalog` types. Add `fishCollection` state to `progressionStore` with add/query actions. Create `fishCollectionService.ts` for persistence. Add fishing badge definitions and XP constants. Add `FishCollection` to `ProgressionSnapshot` for save/load compatibility. | Creates 2 new files in `src/core/`; modifies `progressionStore.ts` (~30 lines), `progression/types.ts` (~15 lines), `persistence/types.ts` (~15 lines) |
| `village-content-designer` | Define 2–3 fishing pond positions (near portal slots) and 1 Fish Stand position in `VILLAGE_MAP`. Define the `FishCatalog` (fish names, rarities, flavor text). Design fish stand NPC dialogue (optional fishing-themed NPC). Write pond-to-portal proximity mapping. | Modifies `villageLayout.ts` (~50 lines: new structures, proximity helper); creates or contributes to `fishingTypes.ts` fish catalog data |
| `qa-engineer` | Unit tests for `fishingMechanics.ts` (bite timing, rarity roll, question pulling). Component tests for `FishStandPanel.tsx` and `FishingRecallModal.tsx`. Integration tests for fishing → catch → collection persistence round-trip. Regression tests verifying existing village buildings still work. | New test files matching new source files; extended progression store tests |

### 8.2 New Agents Required

None. All work falls within existing agent domains.

### 8.3 Existing Agents — No Changes

| Agent | Reason |
|-------|--------|
| `infrastructure-engineer` | No new npm dependencies, no Electron IPC changes, no Express server changes, no Vite config changes. Fishing is fully client-side with existing infrastructure. |
| `project-orchestrator` | Coordination role only; no code changes. |

---

## 9. Implementation Phases

### Phase F1: Foundation & Data Layer (~1–2 days)

- [ ] Define `FishEntry`, `FishCollection`, `FishCatalog`, and `FishRarity` types in `src/game/systems/fishingTypes.ts`
- [ ] Add `fishCollection: FishEntry[]` to `ProgressionSnapshot` in `src/core/validation/persistence/types.ts`
- [ ] Add `fishCollection` state + `addFish()` action to `src/store/progressionStore.ts`
- [ ] Create `src/core/fishing/fishCollectionService.ts` — persistence layer (serialize/deserialize fish collection)
- [ ] Add fishing XP constants (`FSH_XP_PER_CORRECT_ANSWER`) and badge IDs to `src/core/progression/types.ts`
- [ ] Add `'fishing-pond'` and `'fish-stand'` to `VillageStructure.type` union in `villageLayout.ts`
- [ ] Define 2–3 fishing pond structures near portal slots and 1 Fish Stand structure in `VILLAGE_MAP.structures`
- [ ] Create portal-to-pond proximity helper in `villageLayout.ts`
- [ ] Create `src/game/systems/fishingMechanics.ts` — bite timer logic, rarity roll, question pulling (calls `generateSelfCheckPrompts`)
- [ ] Create fish sprite SVGs in `public/assets/sprites/fishing/` (3+ fish silhouettes, bobber, rod, water surface, pier)

**Validation:**
- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] `FishCatalog` has at least 6 fish types across all 3 rarities
- [ ] Proximity helper correctly maps each fishing pond to its nearest portal slot

### Phase F2: Fishing Scene (~2–3 days)

- [ ] Create `src/game/scenes/FishingScene.ts` — Phaser scene with side-view layout
  - [ ] Preload: load fishing sprites (bobber, rod, fish silhouettes, water surface, pier)
  - [ ] Create: render pier/ground (upper portion), water surface with animated wave tiles (lower portion), player avatar at cast position, bobber (hidden initially)
  - [ ] Cast mechanic: click water → animate line extending from rod to click point, bobber appears at water surface
  - [ ] Wait mechanic: bobber idle bobbing tweens, random 3–15s timer, fish silhouette swims toward bobber
  - [ ] Bite mechanic: on timer end, bobber splash animation + visual cue; 2-second click window
  - [ ] Catch mechanic: on bite click → reeling animation, fish pulled up, fish name/rarity displayed on screen
  - [ ] Miss mechanic: on window expiry → fish silhouette swims away, bobber resets, player can cast again
- [ ] Add `fishing-pond` and `fish-stand` sprites to `VillageScene.ts` `SPRITE_PATHS` and `TEX`
- [ ] Add `fishing-pond` rendering in `VillageScene.create()` (same pattern as existing structures)
- [ ] Add `fish-stand` rendering in `VillageScene.create()` (same pattern as existing buildings)
- [ ] Emit `onStructureInteract` for fishing pond structures
- [ ] Add fishing pond interaction to `VillageScreen.tsx`: `fishing-pond` case in `infoPanel` type, scene transition to FishingScene with subject context
- [ ] Add scene registration in game creation (`src/game/createVillageGame.ts` or equivalent)

**Validation:**
- [ ] Player can approach fishing pond → press E → FishingScene loads
- [ ] Cast → wait → bite → reel flow works visually and mechanically
- [ ] Missed bite window correctly resets
- [ ] "Return to Village" exits scene cleanly
- [ ] Existing decorative ponds remain non-interactive (regression check)

### Phase F3: Recall Question + Collection UI (~1–2 days)

- [ ] Create `src/ui/components/FishingRecallModal.tsx`
  - [ ] Displays recall question text (pulled from `generateSelfCheckPrompts`)
  - [ ] "I got it right" / "I need to review" self-evaluation buttons
  - [ ] Shows fish name and rarity as header
  - [ ] On "I got it right": fish added to collection, XP awarded, success animation
  - [ ] On "I need to review": "The fish wriggles free..." message, fish not added
- [ ] Wire FishingScene → RecallModal communication (Phaser emits event → React displays modal)
- [ ] Create `src/ui/components/FishStandPanel.tsx`
  - [ ] Gallery grid of collected fish with name, rarity badge (color-coded: gray/green, blue, purple/gold), subject label
  - [ ] Sort by most recent catch
  - [ ] Empty state: "No fish caught yet — visit a fishing pond near a dungeon portal!"
  - [ ] Counts per rarity displayed in header
- [ ] Add `fish-stand` interaction to `VillageScreen.tsx`: `fish-stand` case in `infoPanel.type`, opens `FishStandPanel`
- [ ] Implement fishing badge checks in progression engine (first catch, 10, 25, full collection)

**Validation:**
- [ ] Catch fish → recall modal appears → "I got it right" → fish saved, XP earned
- [ ] Catch fish → recall modal appears → "I need to review" → fish not saved, line resets
- [ ] Fish Stand shows all collected fish with correct rarity and subject labels
- [ ] Empty Fish Stand shows appropriate message
- [ ] Fishing badges unlock at correct thresholds

### Phase F4: Polish & Edge Cases (~1 day)

- [ ] Subject with zero cleared rooms: show "Defeat encounters in the nearby dungeon to unlock fish here!" message instead of allowing fishing
- [ ] Subject deleted after fish caught: fish remains in collection but shows "(Deleted Subject)" label
- [ ] All fish types caught from a pond: "You've caught every fish this pond has to offer!" message
- [ ] Seeded RNG for bite timing and rarity (based on `subjectId + fishCount`) for deterministic replay
- [ ] Sound effects (if audio system available): splash on bite, reel sound on catch, bloop on miss
- [ ] Fishing tutorial hint added to quest/onboarding system (optional step after completing a dungeon)

**Validation:**
- [ ] Zero-room subject shows informative message, no error
- [ ] Deleted subject's fish still display with graceful label
- [ ] Full pond catch state shows appropriate feedback
- [ ] Regression: all existing village interactions still work

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | `fishingMechanics.ts` — bite timer generation, rarity roll distribution, question pulling logic | Vitest — pure function tests with mocked inputs |
| Unit Tests | `fishCollectionService.ts` — add/remove/serialize/deserialize fish entries | Vitest — mock localStorage |
| Unit Tests | Portal-to-pond proximity helper | Vitest — test with village layout fixtures |
| Component Tests | `FishStandPanel.tsx` — render collection, empty state, rarity badges, deleted subject label | Vitest + Testing Library |
| Component Tests | `FishingRecallModal.tsx` — correct/incorrect flows, XP display, fish name/rarity display | Vitest + Testing Library |
| Integration Tests | Full fishing flow: pond interaction → catch → recall answer → fish persisted → visible in Fish Stand | Vitest with mock stores |
| Integration Tests | Fish collection persistence round-trip: save → reload → verify fish intact | Vitest with mock localStorage |
| Regression Tests | Existing village buildings still interact correctly after adding new structure types | Manual playtest via `npm run dev` |
| Regression Tests | Existing progression store operations unaffected by `fishCollection` field | Vitest — existing progression tests must still pass |

**Key Test Scenarios:**
1. Cast → wait → bite → click within window → fish caught → recall question displayed
2. Cast → wait → bite → miss window → fish escapes → line resets
3. Catch fish → answer correctly → fish in collection, XP incremented
4. Catch fish → answer incorrectly → fish NOT in collection, XP unchanged
5. Fish Stand renders all collected fish with correct names, rarities, subjects
6. Fish Stand empty state renders when no fish caught
7. Fishing pond with zero cleared rooms shows "unlock" message
8. Deleted subject's fish shows "(Deleted Subject)" in collection
9. Multiple catches from same pond → different recall questions (different rooms pulled)
10. Persistence round-trip: catch 3 fish → reload → all 3 still in collection

---

## 11. Rollback Considerations

If this feature needs to be reverted:

**Modified files to revert:**
- `src/data/villageLayout.ts` — remove `'fishing-pond'` and `'fish-stand'` from type union; remove fishing pond/Fish Stand structures from `VILLAGE_MAP`; remove proximity helper
- `src/game/scenes/VillageScene.ts` — remove fishing pond/fish stand sprite entries, rendering code, and interaction emission
- `src/ui/screens/VillageScreen.tsx` — remove `'fishing-pond'` and `'fish-stand'` from `infoPanel.type` union and associated handlers
- `src/core/progression/types.ts` — remove fishing badge IDs and XP constants
- `src/store/progressionStore.ts` — remove `fishCollection` state and `addFish()` action
- `src/core/validation/persistence/types.ts` — remove `FishCollection` from `ProgressionSnapshot`; remove `FishEntry` type

**New files to remove:**
- `src/game/scenes/FishingScene.ts`
- `src/game/systems/fishingTypes.ts`
- `src/game/systems/fishingMechanics.ts`
- `src/core/fishing/fishCollectionService.ts`
- `src/ui/components/FishStandPanel.tsx`
- `src/ui/components/FishingRecallModal.tsx`
- `public/assets/sprites/village/fishing-pond.svg`
- `public/assets/sprites/village/fish-stand.svg`
- `public/assets/sprites/fishing/` (entire directory)

**Data changes to handle:**
- `fishCollection` array in saved progression data — harmless orphan field; can be ignored on load
- Missing badge definitions in `ProgressionSnapshot` — badge validation already handles unknown badge IDs gracefully
- SVG sprite references from removed files — no effect since Phaser preload targets are also removed

**Existing tests that verify original behavior:**
- VillageScene interaction tests (existing building interactions unchanged)
- Progression store tests (existing XP/badge operations)
- VillageScreen info panel routing tests

---

## 12. Acceptance Criteria

1. [ ] 2–3 fishing pond structures render in the village near dungeon portal slots with interactive indicators
2. [ ] Pressing E on a fishing pond transitions to the FishingScene (side-view Phaser scene)
3. [ ] Player can click water to cast, bobber lands, and a random 3–15 second wait begins
4. [ ] Fish silhouette swims toward bobber; bite indicator appears with a 2-second click window
5. [ ] Clicking during bite window catches the fish; missing the window causes the fish to escape
6. [ ] Caught fish triggers a recall question pulled from a random cleared room in the nearest dungeon
7. [ ] Player can self-evaluate recall answer ("I got it right" / "I need to review")
8. [ ] "I got it right": fish added to collection, XP awarded (scaled by rarity); "I need to review": fish escapes
9. [ ] Escape key or Return button exits FishingScene back to village at the pond's position
10. [ ] Fish Stand building renders in village; pressing E opens the fish collection gallery
11. [ ] Fish collection shows all caught fish with name, rarity badge, and source subject
12. [ ] Empty Fish Stand shows appropriate message guiding player to fish
13. [ ] Fish collection persists across page reloads
14. [ ] Fishing pond with zero cleared rooms shows informative message instead of allowing fishing
15. [ ] Fish from deleted subjects display with "(Deleted Subject)" label
16. [ ] Existing village buildings (Keeper's Tower, Guild Hall, etc.) still function identically
17. [ ] `npm run typecheck`, `npm run lint`, `npm test -- --run` pass

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should fishing consume anything (stamina, turns, or a daily limit)? | No — fishing is unlimited. Players can fish as much as they want. |
| 2 | Should fish types be pond-specific or global? | Global catalog — any fish can be caught from any pond, but the recall questions are pond/subject-specific. |
| 3 | Should there be a "perfect catch" bonus for clicking very fast during the bite window? | Not in v1. Keep it binary: clicked or missed. Can add timing tiers later. |
| 4 | Should the fishing scene use the player's current archetype sprite? | Yes — same player sprite as the village scene. |
| 5 | Should fish from the same room yield the same recall question on repeat catches? | No — `generateSelfCheckPrompts` can generate multiple prompts per room, so a new prompt is pulled each time. |
| 6 | Should there be a fishing NPC (a "Fisher" villager) with dialogue near the ponds? | Optional stretch — add a "Humble Fisher" NPC near one pond with fishing tips as a Could-have. |
