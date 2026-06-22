# Feature: "Make It Yours" — SVG Sprite Customization

## 1. Feature Overview

**Feature Name:** Make It Yours — SVG Sprite Customization
**Parent Document:** [docs/PRD.md](../PRD.md)
**Status:** Draft
**Summary:** A standalone capability that lets users browse, edit, and replace game sprites (SVGs) using an embedded WYSIWYG editor. Custom sprites persist across sessions and load automatically. Users can save collections of edits as shareable packs, import packs from others, and switch between collections. Newly added SVGs are discovered dynamically via a sprite manifest.

**Scope:**
- Browse ~60 bundled SVG sprites grouped by category with thumbnail previews
- WYSIWYG SVG editor embedded in-app (SVGEdit)
- Save individual sprite overrides to `public/assets/` (via copy) and backup to persistence
- Save, export, import, and share sprite collections as portable `.kdpack` files
- Dynamic sprite discovery so new SVGs appear in the editor automatically
- Scene reload (or restart) to apply custom sprites to the game

**Out of scope:**
- Visual editor for PNG/WebP raster assets
- Procedural texture customization (biome floors are generated via Canvas API, not SVG)
- Custom sprite per subject — overrides are global to the application
- Arbitrary file upload for new sprites (only editing existing manifests)
- CSS/HTML UI theming (the existing Themes tab covers that)

**Dependencies:**
- Phase 2 complete (SettingsModal, theme tab infrastructure, Electron IPC)
- Phase 3a visual unification foundation (shared palette/font already in `src/theme/`)
- Electron `knowledge:*` IPC channel pattern established
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
| Settings modal | `src/ui/components/SettingsModal.tsx` | Add "Make It Yours" tab |
| Preferences store | `src/store/preferencesStore.ts` | Add sprite pack preference |
| Dungeon sprite URLs | `src/game/scenes/DungeonScene.ts:77-101` | Migrate to `resolveSpriteUrl()` |
| Village sprite URLs | `src/game/scenes/VillageScene.ts:22-51` | Migrate to `resolveSpriteUrl()` |
| Dungeon preload | `src/game/scenes/DungeonScene.ts:248-315` | Use resolved URLs |
| Village preload | `src/game/scenes/VillageScene.ts:177-210` | Use resolved URLs |
| Electron main | `src/electron/main.ts` | New IPC handlers for sprite ops |
| Electron preload | `src/electron/preload.ts` | Expose new channels |
| Express server | `server/index.js` | New API endpoint for web manifest |
| Theme colors | `src/theme/colors.ts` | No change (reference only) |

**Existing Agents Involved:**

| Agent | Domain |
|-------|--------|
| `ui-engineer` | SettingsModal tab, asset browser, editor panel, collection UI |
| `game-engineer` | Migrate sprite URLs to resolution layer, scene reload |
| `infrastructure-engineer` | Electron IPC channels, Express endpoint, Vite config (manifest script) |
| `core-logic-engineer` | `customSprites` persistence service, preferencesStore update |
| `qa-engineer` | Component tests for browser/editor, integration tests for persistence round-trips |

**Established Conventions:**
- React components in `src/ui/components/` with PascalCase filenames
- CSS in `src/styles.css` using `--kd-*` custom properties
- Phaser textures loaded via `this.load.svg()` in `preload()`, rendered in `create()`
- Zustand stores with `create<T>()((set) => ({...}))` pattern
- Electron IPC via `ipcMain.handle('knowledge:*', ...)` and `contextBridge`
- All data local-first — no network calls

---

## 3. Feature Goals and Non-Goals

### 3.1 Goals
- Let users visually customize shipped SVG sprites using a WYSIWYG editor in-app
- Persist custom sprites so they load automatically on next app restart
- Enable collection management: save, export, import, switch between sprite packs
- Dynamically discover SVGs so newly added sprites appear in the editor automatically
- Support both web (localStorage + Express) and Electron (filesystem) platforms

### 3.2 Non-Goals
- No bitmap/raster image editing (PNG, WebP)
- No procedural texture customization (biome floors)
- No per-subject sprite overrides (global only)
- No arbitrary new sprite creation from scratch (edit existing only)
- No external editor launch (everything in-app)
- No breaking changes to the Phaser scene lifecycle or data model

---

## 4. User Stories

| ID | As a... | I want to... | So that... | Priority |
|----|---------|-------------|-----------|----------|
| MIY-US-01 | Power User | Browse all game sprites grouped by category with thumbnail previews | I can see what assets I can customize | Must |
| MIY-US-02 | Power User | Edit any sprite in a WYSIWYG SVG editor | I can personalize the game's look without knowing SVG code | Must |
| MIY-US-03 | Power User | See my edited sprites in the game after saving | My customizations take effect immediately | Must |
| MIY-US-04 | Lifelong Learner | Switch between saved sprite collections | I can change the game's visual style quickly | Should |
| MIY-US-05 | Power User | Export my custom sprite pack to share with others | I can share my visual theme with the community | Should |
| MIY-US-06 | Power User | Import a sprite pack from someone else | I can use community-created visual themes | Should |
| MIY-US-07 | Student | Reset any sprite back to its original | I can undo changes I don't like | Must |
| MIY-US-08 | Student | See which sprites I've modified at a glance | I can track my customizations | Should |

---

## 5. Technical Approach

### 5.1 Impact on Existing Architecture

**Files modified:**

| File | Change |
|------|--------|
| `src/ui/components/SettingsModal.tsx` | Add "Make It Yours" tab with tab navigation; tab enum gains `'make-it-yours'` |
| `src/store/preferencesStore.ts` | Add `activeSpritePack: string | null` field; persist via standard localStorage path |
| `src/game/scenes/DungeonScene.ts` | Replace hardcoded `SPRITE_PATHS` with `resolveSpriteUrl()` calls; add scene reload on sprite change signal |
| `src/game/scenes/VillageScene.ts` | Same as DungeonScene |
| `src/electron/main.ts` | Add IPC handlers: `knowledge:save-custom-sprite`, `knowledge:reset-custom-sprite`, `knowledge:export-sprite-pack`, `knowledge:import-sprite-pack`, `knowledge:get-sprite-manifest` |
| `src/electron/preload.ts` | Expose new IPC channels via `contextBridge` |
| `server/index.js` | Add `GET /api/sprite-manifest` endpoint; register MIME type for `.kdpack` |
| `package.json` | Add `manifest` script; add `@svgedit/svgcanvas` or self-host SVGEdit |
| `vite.config.ts` | Add Vite plugin for manifest auto-regeneration on SVG file changes (dev only) |

**No files removed.**

### 5.2 New Components

| File | Purpose |
|------|---------|
| `src/services/customSprites.ts` | Sprite URL resolution layer; persistence facade (localStorage + Electron IPC); pack CRUD |
| `src/services/spriteManifest.ts` | Manages and serves the sprite manifest (scan + serve) |
| `src/ui/components/SpriteBrowser.tsx` | Category-grouped sidebar listing all sprites with thumbnails and modified badges |
| `src/ui/components/SpriteEditor.tsx` | Wraps SVGEdit iframe with load/save/reset controls |
| `src/ui/components/MakeItYoursTab.tsx` | Composes SpriteBrowser + SpriteEditor; collection switcher, export/import buttons |
| `src/ui/components/CollectionSwitcher.tsx` | Dropdown to switch between saved sprite collections |
| `scripts/generate-sprite-manifest.mjs` | Node script scanning `public/assets/` for `*.svg`, extracting dimensions from viewBox |
| `public/assets/sprite-manifest.json` | Generated manifest consumed by editor and game |
| `public/editor/svg-edit/` | Self-hosted SVGEdit distribution (if not using npm package) |

### 5.3 Technology Additions

| Technology | Version | Purpose | Size Impact |
|-----------|---------|---------|-------------|
| SVGEdit (self-hosted iframe) | Latest release (v7.x) | WYSIWYG SVG editor | ~1.5MB (lazy-loaded, code-split) |
| OR `@svgedit/svgcanvas` (npm) | Latest | Programmatic SVG editor API | ~500KB gzipped (treeshakeable) |

**Recommendation:** Start with self-hosted SVGEdit in an iframe for velocity. It ships a standalone `svg-editor.html` that bundles everything. Communicate via `postMessage`. Code-split via Vite dynamic import so the ~2MB payload only loads when the user opens the editor tab.

**Compatibility:** SVGEdit is vanilla JS, no framework dependencies. Works in all modern browsers. No conflicts with React 19, Phaser 3, or TypeScript.

---

## 6. Functional Requirements

| ID | Requirement | Affects Existing | Priority |
|----|-------------|-----------------|----------|
| MIY-FR-01 | "Make It Yours" tab appears in Settings modal with asset browser and editor panels | SettingsModal.tsx (modified) | Must |
| MIY-FR-02 | Asset browser lists all SVGs from the sprite manifest grouped by category with rendered thumbnails | New | Must |
| MIY-FR-03 | Clicking a sprite in the browser loads it into the WYSIWYG SVG editor | New | Must |
| MIY-FR-04 | SVG editor locks canvas dimensions to the original sprite's `width`/`height` from the manifest | New | Must |
| MIY-FR-05 | Save button writes edited SVG to persistence (localStorage web, userData Electron) and copies to `public/assets/` | New | Must |
| MIY-FR-06 | Reset button restores a sprite to its original bundled version | New | Must |
| MIY-FR-07 | "Reset All" restores all custom sprites to originals in one action | New | Should |
| MIY-FR-08 | Modified sprites show a badge/indicator in the asset browser | New | Should |
| MIY-FR-09 | Sprite manifest regenerates dynamically: on dev SVG changes via Vite plugin, on server startup via filesystem scan, on Electron launch via IPC | New | Must |
| MIY-FR-10 | Phaser scenes resolve sprite URLs through `resolveSpriteUrl()` which checks for custom overrides before falling back to bundled assets | DungeonScene.ts, VillageScene.ts (modified) | Must |
| MIY-FR-11 | After saving a sprite, the user can restart the current scene to see changes (Restart Scene button) | DungeonScene.ts, VillageScene.ts | Must |
| MIY-FR-12 | User can save the current set of overrides as a named collection (sprite pack) | New | Should |
| MIY-FR-13 | User can export a sprite pack as a `.kdpack` file (JSON with embedded SVGs + metadata) | New | Should |
| MIY-FR-14 | User can import a `.kdpack` file with preview showing which sprites will change | New | Should |
| MIY-FR-15 | Collection switcher dropdown lets user activate a saved pack (applies all its overrides) | New | Should |
| MIY-FR-16 | Active collection persists across sessions via `preferencesStore` | preferencesStore.ts (modified) | Should |
| MIY-FR-17 | Original SVG files are backed up to `public/assets/.originals/` on first edit | New | Should |
| MIY-FR-18 | Electron native file dialogs used for `.kdpack` import/export | Electron main.ts | Should |

---

## 7. Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| MIY-NF-01 | SVG editor payload lazy-loads only when "Make It Yours" tab is opened; no impact on app startup time | Must |
| MIY-NF-02 | Saving a sprite takes < 500ms (SVG string write + copy to public/) | Must |
| MIY-NF-03 | Custom sprite count × average file size stays under localStorage quota (~60 SVGs × 3KB = ~180KB, well under 5MB) | Should |
| MIY-NF-04 | Corrupted/empty SVG on save is rejected with a validation error; does not break the game | Must |
| MIY-NF-05 | Original bundled assets are never permanently lost (`.originals/` backup, reset available) | Must |
| MIY-NF-06 | Web and Electron platforms share the same React UI components; platform divergence is in the persistence layer only | Must |
| MIY-NF-07 | No network calls in any sprite operation (even SVGEdit is self-hosted) | Must |
| MIY-NF-08 | Keyboard accessibility: Tab through sprites in browser, Enter to select, Escape to close editor | Should |

---

## 8. Agent Impact Assessment

### 8.1 Existing Agents — Extended Responsibilities

| Agent | New Responsibilities | Modified Boundaries |
|-------|---------------------|-------------------|
| `ui-engineer` | Implement `MakeItYoursTab`, `SpriteBrowser`, `SpriteEditor` components; extend `SettingsModal` with new tab | Adds 3 new React components; modifies 1 existing component |
| `game-engineer` | Migrate `DungeonScene.ts` and `VillageScene.ts` sprite URLs to `resolveSpriteUrl()`; add `reloadScene()` method for restart-on-save; coordinate manifest consumption | Modifies 2 scene files (~80 lines changed); no new files in `game/` |
| `infrastructure-engineer` | Add 5 IPC handlers in `main.ts`; add 1 Express endpoint in `server/index.js`; add Vite manifest plugin; add `manifest` npm script; self-host SVGEdit | Modifies 2 existing files; adds 1 new script file; adds 1 static asset dir |
| `core-logic-engineer` | Create `customSprites` persistence service; add `activeSpritePack` to `preferencesStore`; implement pack JSON schema and validation | Creates 1 new service file; modifies 1 existing store |
| `qa-engineer` | Component tests for `SpriteBrowser`, `SpriteEditor`, `MakeItYoursTab`; integration tests for sprite resolution layer; persistence round-trip tests for packs | New test files for new components; extended persistence tests |

### 8.2 New Agents Required

None. All work falls within existing agent domains.

### 8.3 Existing Agents — No Changes

| Agent | Reason |
|-------|--------|
| `village-content-designer` | NPC dialogue, quest data, and village layout are unaffected by sprite customization |
| `project-orchestrator` | Coordination role only; no code changes |

---

## 9. Implementation Phases

### Phase F1: Foundation (~2–3 days)

- [ ] Create `scripts/generate-sprite-manifest.mjs` — scans `public/assets/**/*.svg`, reads `viewBox` dimensions, outputs `public/assets/sprite-manifest.json`
- [ ] Create `src/services/spriteManifest.ts` — fetches and validates the manifest
- [ ] Create `src/services/customSprites.ts` — URL resolution layer with `resolveSpriteUrl(path)`, localStorage read/write for web, Electron IPC integration, pack CRUD
- [ ] Add `activeSpritePack` field to `src/store/preferencesStore.ts`
- [ ] Add Electron IPC handlers: `knowledge:save-custom-sprite`, `knowledge:reset-custom-sprite`, `knowledge:get-sprite-manifest`, `knowledge:export-sprite-pack`, `knowledge:import-sprite-pack`
- [ ] Update `src/electron/preload.ts` to expose new channels
- [ ] Add Express endpoint: `GET /api/sprite-manifest`
- [ ] Add Vite plugin to regenerate manifest on SVG file changes (dev only)
- [ ] Migrate sprite URLs in `DungeonScene.ts` and `VillageScene.ts` to use `resolveSpriteUrl()`
- [ ] Add scene reload method to both scenes

**Validation:**
- [ ] `npm run manifest` generates valid manifest JSON
- [ ] `resolveSpriteUrl('sprites/player-hero.svg')` returns the correct URL
- [ ] Existing game renders identically with no custom sprites (regression check)
- [ ] `npm run typecheck` and `npm run lint` pass

### Phase F2: Editor Integration (~2–3 days)

- [ ] Self-host SVGEdit distribution in `public/editor/svg-edit/`
- [ ] Create `src/ui/components/SpriteEditor.tsx` — iframe wrapper with `postMessage` bridge for load/save
- [ ] Create `src/ui/components/SpriteBrowser.tsx` — category-grouped list with thumbnail images from SVG content
- [ ] Create `src/ui/components/MakeItYoursTab.tsx` — composes browser + editor; save/reset/reset-all buttons
- [ ] Add "Make It Yours" tab to `SettingsModal.tsx` (tab enum, tab panel)
- [ ] Implement save-to-collection flow with name input
- [ ] Implement reset-to-original flow (per sprite and reset all)
- [ ] Add modified badge indicator to sprite browser entries
- [ ] Add scene restart button ("Apply Changes" → restarts current scene)
- [ ] Validate SVG content before save (must be valid XML, must have `<svg>` root)

**Validation:**
- [ ] Editor loads and displays a selected sprite
- [ ] User can draw, modify, and save a sprite; changes persist on page reload
- [ ] "Reset" restores the original sprite
- [ ] "Apply Changes" causes the in-game sprite to update on scene restart
- [ ] Component tests pass for all new components

### Phase F3: Collections & Sharing (~1–2 days)

- [ ] Create `src/ui/components/CollectionSwitcher.tsx` — dropdown to switch active pack
- [ ] Implement pack save: name + description + serialize all current overrides
- [ ] Implement pack export: download `.kdpack` JSON file (Electron: native save dialog; web: `<a download>`)
- [ ] Implement pack import: FileReader → parse JSON → preview changed sprites → confirm → apply
- [ ] Implement pack switching: activate pack → apply all its overrides → persist active pack ID
- [ ] Original backup: on first edit of any sprite, copy original to `public/assets/.originals/`
- [ ] Add i18n keys for all new UI strings (English default)

**Validation:**
- [ ] Save pack → switch to default → re-activate pack → sprites match saved state
- [ ] Export `.kdpack` → import on different environment → sprites match
- [ ] Pack JSON schema rejects invalid data
- [ ] `.originals/` contains backups after first edit

---

## 10. Testing Strategy

| Level | Scope | Approach |
|-------|-------|----------|
| Unit Tests | `customSprites.ts` resolution logic, manifest parsing, pack JSON schema validation | Vitest — pure function tests, no mocking needed |
| Unit Tests | `preferencesStore` — `activeSpritePack` field persistence | Vitest with localStorage mock |
| Component Tests | `SpriteBrowser` — renders categories, thumbnails, modified badges | Vitest + Testing Library — mock manifest data |
| Component Tests | `MakeItYoursTab` — tab navigation, editor load, save flow | Vitest + Testing Library — mock iframe postMessage |
| Integration Tests | Persistence round-trip: save sprite → reload → verify override intact | Vitest — mock localStorage or temp fs |
| Integration Tests | Pack round-trip: save pack → export → import → verify | Vitest |
| Regression Tests | DungeonScene and VillageScene render correctly with and without custom sprites | Manual playtesting via `npm run dev` |
| Regression Tests | SettingsModal tabs all still work | Existing SettingsModal component tests |

**Key Test Scenarios:**
1. Load manifest → all categories have correct sprite counts
2. Edit sprite → save → read from persistence → SVG matches saved content
3. Edit sprite → reset → sprite matches original bundled SVG
4. Save pack → switch to default → switch back → all sprites restored
5. Invalid SVG save → rejected with error message
6. Missing sprite in manifest → not shown in browser
7. Empty manifest → browser shows "No sprites available" state
8. Electron: save sprite → copy exists in both userData and public/assets/

---

## 11. Rollback Considerations

If this feature needs to be reverted:

**Modified files to revert:**
- `src/ui/components/SettingsModal.tsx` — remove "Make It Yours" tab; restore original tab enum
- `src/store/preferencesStore.ts` — remove `activeSpritePack` field
- `src/game/scenes/DungeonScene.ts` — restore hardcoded `SPRITE_PATHS`
- `src/game/scenes/VillageScene.ts` — restore hardcoded `SPRITE_PATHS`
- `src/electron/main.ts` — remove 5 new IPC handlers
- `src/electron/preload.ts` — remove 5 new channel exposures
- `server/index.js` — remove `GET /api/sprite-manifest`
- `vite.config.ts` — remove manifest plugin
- `package.json` — remove `manifest` script

**New files to remove:**
- `src/services/customSprites.ts`
- `src/services/spriteManifest.ts`
- `src/ui/components/SpriteBrowser.tsx`
- `src/ui/components/SpriteEditor.tsx`
- `src/ui/components/MakeItYoursTab.tsx`
- `src/ui/components/CollectionSwitcher.tsx`
- `scripts/generate-sprite-manifest.mjs`
- `public/assets/sprite-manifest.json`
- `public/editor/` (SVGEdit distribution)

**Data changes to handle:**
- `localStorage` keys with `knowledge-dungeon:custom-sprites:*` — user can ignore (harmless orphan keys)
- `{userData}/custom-sprites/` directory — user can delete manually
- `public/assets/.originals/` — delete and restore original SVGs from git
- Modified `public/assets/` SVGs — `git checkout public/assets/` restores originals

**Existing tests that verify original behavior:**
- Phaser scene rendering tests (manual playtest)
- SettingsModal component tests (theme, language, shortcuts tabs)

---

## 12. Acceptance Criteria

1. [ ] User opens Settings → "Make It Yours" tab and sees a categorized list of all sprites with thumbnails
2. [ ] User clicks a sprite → SVG editor opens with the sprite loaded, locked to original dimensions
3. [ ] User edits the sprite (draws, changes colors, etc.) and clicks Save
4. [ ] User clicks "Apply Changes" → scene restarts → edited sprite appears in-game
5. [ ] User refreshes the app → edited sprite persists and loads in-game
6. [ ] User clicks "Reset" on a modified sprite → original sprite restores
7. [ ] User clicks "Reset All" → all sprites restore to originals
8. [ ] User saves a collection ("My Dark Theme") → all current edits bundled into named pack
9. [ ] User exports collection as `.kdpack` file
10. [ ] User imports a `.kdpack` file → preview shows changes → confirms → sprites update
11. [ ] User switches between collections via dropdown → sprites change accordingly
12. [ ] Adding a new SVG to `public/assets/sprites/` → regenerating manifest → new sprite appears in browser
13. [ ] Saving an invalid SVG shows an error; game does not break
14. [ ] Original SVGs are backed up; deleting `.originals/` and running `git checkout public/assets/` fully restores
15. [ ] All existing Settings tabs (Theme, Language, Shortcuts) still work identically
16. [ ] `npm run typecheck`, `npm run lint`, `npm test -- --run` pass

---

## 13. Open Questions

| # | Question | Default Assumption |
|---|----------|--------------------|
| 1 | Should sprite packs be shareable via a community gallery (upload/download from a server)? | No — packs are shareable as files only (user-driven, not hosted). Consistent with local-first principle. |
| 2 | Should the editor support "undo" for sprite edits within a session? | Yes — SVGEdit provides built-in undo/redo. |
| 3 | Should there be a "preview in game" button that shows the sprite at game scale without restarting? | Phase F2 ships with "Apply Changes" (restart scene). Live preview without restart can be a Phase F3 enhancement. |
| 4 | Should custom sprites persist across app updates (new Vite build)? | Yes — `public/assets/` copy persists. Electron userData backup persists. Web: localStorage persists across builds on same domain. |
| 5 | Should the editor support adding new blank SVGs (not just editing existing)? | No — out of scope for v1. Users can drop new SVGs into `public/assets/` and regenerate the manifest manually. |
| 6 | How should sprite conflicts be handled when importing a pack that the user has already customized? | Show a diff preview: "5 of 12 sprites in this pack will overwrite your existing customizations." Confirm before applying. |
