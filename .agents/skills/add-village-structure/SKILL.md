---
name: add-village-structure
description: >
  Adds a new interactive structure type (building, landmark, or interaction point) to the Knowledge
  Dungeon village hub. Use this skill when adding any new structure that players can approach and
  interact with - fishing ponds, new buildings, interactable decorations, or custom landmarks.
  Covers the full cross-agent pipeline: layout data, Phaser rendering, React info panel, and
  interaction routing.
---

# Skill: Add Village Structure

Adds a new interactive structure to the village hub that players can approach and interact with. This skill covers the full multi-agent pipeline from content data through rendering to UI handling.

---

## Process

### Step 1: Define the Structure in Layout Data

Work in `src/data/villageLayout.ts`. This step is owned by **village-content-designer**.

1. **Add the type to the union** at `VillageStructure.type` (line ~30). The union is a string literal union:
   ```typescript
   type: 'portal-icon' | 'keeper-tower' | 'guild-hall' | ... | 'your-new-type';
   ```
   Add your new type string here, keeping alphabetical order.

2. **Add structure entries** to `VILLAGE_MAP.structures` array. Each entry needs:
   ```typescript
   {
     id: 'unique-id',              // kebab-case, descriptive (e.g., 'fish-pond-north')
     type: 'your-new-type',        // matches the union value added above
     label: 'Display Name',        // shown in UI prompts
     gridX: number,                // 0-indexed grid column
     gridY: number,                // 0-indexed grid row
     width: number,                // grid cells wide (typically 1-3)
     height: number,               // grid cells tall (typically 1-3)
     // Optional: add any extra fields needed for game logic
     // subjectId?: string;
     // portalSlotId?: string;
   }
   ```
   Grid coordinates use 48px tiles (VILLAGE_TILE_SIZE = 48). The map is 36×30 tiles.

3. **If the structure needs proximity logic** (e.g., fishing ponds mapping to nearest portal), add a helper function:
   ```typescript
   export function getNearestPortalTo(structureId: string): VillageStructure | null {
     // Find the structure, then find the nearest portal-icon structure by grid distance
   }
   ```

4. **Run validation:**
   ```bash
   npm run typecheck  # Verify the union type compiles
   ```

### Step 2: Add Rendering in VillageScene

Work in `src/game/scenes/VillageScene.ts`. This step is owned by **game-engineer**.

1. **Add sprite path** to `SPRITE_PATHS` object (lines ~21-51):
   ```typescript
   const SPRITE_PATHS = {
     // ... existing entries
     yourNewType: 'assets/sprites/village/your-structure.svg',
   };
   ```

2. **Add texture key** to `TEX` constants:
   ```typescript
   const TEX = {
     // ... existing entries
     YOUR_NEW_TYPE: 'your-new-type-tex',
   };
   ```
   The texture key can be any unique string. Convention: match the key name in SCREAMING_SNAKE_CASE.

3. **Add to preload** if needed. For SVG sprites, add to the preload block:
   ```typescript
   this.load.svg(TEX.YOUR_NEW_TYPE, SPRITE_PATHS.yourNewType, { width: ..., height: ... });
   ```

4. **Add rendering in `create()`**. Find the structure rendering section (search for `VILLAGE_MAP.structures.forEach` in `create()`, typically ~lines 400-550). Add a conditional block for your new type following the existing pattern:
   ```typescript
   } else if (struct.type === 'your-new-type') {
     const sprite = this.add.sprite(wx, wy, TEX.YOUR_NEW_TYPE);
     sprite.setOrigin(0.5, 0.8);  // 0.8 = bottom-aligned for buildings
     sprite.setDisplaySize(struct.width * TILE, struct.height * TILE);
     // Optional: set depth, alpha, tint, or add tweens
     sprite.setInteractive();
   }
   ```

5. **Emit interaction events.** In the structure click/interact handler (search for `onStructureInteract`), add a case for your new type so it emits the callback:
   ```typescript
   if (struct.type === 'your-new-type') {
     this.callbacks?.onStructureInteract(struct.id);
   }
   ```

6. **Run validation:**
   ```bash
   npm run typecheck && npm run lint
   npm run dev  # Visual check: structure appears at correct position
   ```

### Step 3: Add Info Panel Handling in VillageScreen

Work in `src/ui/screens/VillageScreen.tsx`. This step is owned by **ui-engineer**.

1. **Add to `infoPanel` type union** (line ~56):
   ```typescript
   const [infoPanel, setInfoPanel] = useState<{
     type: 'dungeon' | 'keeper' | ... | 'your-new-type';
     structureId: string;
     // Add any extra fields needed for the info panel
   } | null>(null);
   ```

2. **Add to `onStructureApproached` callback** (line ~185). Map the village layout structure type to your info panel type:
   ```typescript
   } else if (sType === 'your-new-type') {
     setInfoPanel({ type: 'your-new-type', structureId });
   }
   ```

3. **Add to `onStructureInteract` callback** (line ~220). Choose the interaction pattern based on your use case:

   | Interaction goal | Pattern |
   |------------------|---------|
   | Full-screen activity (fishing, crafting) | Scene transition via `setActiveScreen('game')` or custom screen |
   | Information display (gallery, stats) | Set `infoPanel` to open a side-panel component |
   | Simple toggle or data action | Store action via `useXStore.getState().doSomething()` |

   Then handle the E-key / tap interaction:
   ```typescript
   } else if (sType === 'your-new-type') {
     // Use the appropriate pattern from the table above.
     // For scene transitions: setActiveScreen(...)
     // For info panels: setInfoPanel({ type: 'your-new-type', structureId })
     // For store actions: useXStore.getState().someAction(...)
     // Pass subject context via struct.subjectId or dynamic data if needed.
   }
   ```

4. **Add JSX rendering block.** Find the block of conditional info panel renders (lines ~535-893). Add your panel:
   ```tsx
   {infoPanel?.type === 'your-new-type' ? (
     <YourNewPanel
       structureId={infoPanel.structureId}
       colorTheme={colorTheme}
       onClose={() => setInfoPanel(null)}
     />
   ) : null}
   ```
   The info panel renders as an overlay on the right side of the screen.

5. **If your structure needs a new React component** (e.g., `FishStandPanel`), create it in `src/ui/components/YourNewPanel.tsx` with PascalCase filename. Follow existing panel patterns:
   - Accept `colorTheme` prop for theming
   - Accept `onClose` for dismiss
   - Use `--kd-*` CSS custom properties
   - Support both desktop and mobile breakpoints

6. **Run validation:**
   ```bash
   npm run typecheck && npm run lint
   npm run dev  # Walk up to structure: info panel appears. Press E: interaction works.
   ```

### Step 4: Add Sprite Asset

1. **Create the SVG sprite** at `public/assets/sprites/village/your-structure.svg`.
2. **Keep SVGs small** - target under 5KB per sprite. Use simple shapes and fills.
3. **Use viewBox** for proper scaling:
   ```svg
   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
     <!-- your paths, shapes here -->
   </svg>
   ```
4. **Match load dimensions to grid size.** The `width`/`height` in `this.load.svg(key, path, { width, height })` controls the loaded texture size. Set it to `struct.width * VILLAGE_TILE_SIZE` × `struct.height * VILLAGE_TILE_SIZE` to avoid stretched or invisible sprites. Mismatched dimensions are the most common cause of sprites not appearing.
5. **Visually verify:** the sprite renders correctly in the village scene at the specified grid position.

### Step 5: Write Tests

Work in test files. This step is owned by **qa-engineer**.

1. **Unit test layout data:** verify the new structure type validates, structure entries have correct grid bounds.
2. **Component test info panel:** verify the new info panel type renders with correct content (use the `write-component-tests` skill).
3. **Integration test:** verify structure interaction flow - approach → info panel appears → interact → action triggers.
4. **Regression test:** verify all existing village structures still work (approached + interact).

---

## Output Format

After completing all steps, the following files should be modified or created:

```
Modified:
  src/data/villageLayout.ts          # New type in union + structure entries
  src/game/scenes/VillageScene.ts    # SPRITE_PATHS + TEX + preload + create() render + interact emit
  src/ui/screens/VillageScreen.tsx   # infoPanel type union + approached + interact + JSX render

Created (if new panel component needed):
  src/ui/components/YourNewPanel.tsx # React component for the info panel

Created (if new sprite needed):
  public/assets/sprites/village/your-structure.svg

Modified (tests):
  src/data/__tests__/villageLayout.test.ts  # Or new test file
  src/ui/__tests__/VillageScreen.test.tsx   # Or new test file
```

---

## Validation

After completing all steps:
- [ ] `npm run typecheck` passes - zero errors across all modified files
- [ ] `npm run lint` passes - zero errors
- [ ] `npm test -- --run` passes - no regressions in existing tests
- [ ] Visual check via `npm run dev`: new structure appears at correct grid position
- [ ] Walk up to structure: info panel appears with correct content
- [ ] Press E / tap on structure: interaction handler fires correctly
- [ ] Walk away: info panel dismisses
- [ ] Existing village interactions (Keeper, Guild Hall, portals, etc.) still work

If validation fails, fix the failing step and re-validate before committing.

If a check fails and the cause is unclear, load `references/troubleshooting.md` for diagnostic guidance organized by symptom (sprite not appearing, E key not triggering, TypeScript errors, info panel not showing, regressions).

---

## Gotchas

- **`VillageStructure.type` is a string literal union** - adding a new type requires updating this union. If you forget, TypeScript will error. If game-engineer or ui-engineer references the type before it's added, their code won't compile.
- **Grid coordinates are 0-indexed** - `gridX: 0, gridY: 0` is the top-left tile. Off-by-one errors are common. Verify visually after placement.
- **Sprite origin** - use `setOrigin(0.5, 0.8)` for bottom-aligned buildings so they sit on the ground plane. For flat sprites (signs, ponds), use `setOrigin(0.5, 0.5)`.
- **Info panel type union** is in TWO places - `VillageStructure.type` in `villageLayout.ts` AND `infoPanel.type` in `VillageScreen.tsx`. They are separate unions with different members (not all structure types have info panels). Make sure you add to BOTH if your structure needs an info panel.
- **Dynamic structures** - if your structure depends on runtime data (like portal slots depend on subjects), you may need to add it to `dynamicStructures` in VillageScreen rather than static `VILLAGE_MAP.structures`. The merge happens in the callback: `[...VILLAGE_MAP.structures, ...dynamicStructuresRef.current]`.
- **SVG sprites in Phaser** - use `this.load.svg()` not `this.load.image()`. The texture key must be unique. SVG sprites can't be tinted like bitmap sprites; use separate SVG files for color variants.
- **Scene coordinates** - Phaser world coordinates = grid × TILE_SIZE. The Y-axis increases downward. Building sprites may need `setOrigin(0.5, 0.8)` to sit correctly on the ground.
- **Interaction emits must happen AFTER rendering** - the structure sprite must be created and made interactive in `create()` before the click handler can detect it. Don't split these between `preload()` and `create()`.

Load `references/troubleshooting.md` if the structure sprite does not appear, if pressing E does not trigger the interaction, if TypeScript reports union type errors, if the info panel does not show, or if existing structures stop working after your addition.

---

## Reference

See [docs/PRD.md](../../docs/PRD.md) for the full specification:
- **Section 8.8** - Village Hub functional requirements (VH-01 through VH-13)
- **Section 8.10** - NPC System for interaction patterns (NPC-09: E key, NPC-10: proximity)

For feature-specific structure additions:
- [docs/features/fishers-rest.md](../../docs/features/fishers-rest.md) **Section 6** - fishing pond and Fish Stand requirements (FSH-FR-01, FSH-FR-02, FSH-FR-16, FSH-FR-17)

For the existing structure patterns to reference when implementing:
- Load `src/data/villageLayout.ts` to see the full structure type union and example entries
- Load `src/game/scenes/VillageScene.ts` to see rendering patterns (~lines 177-210 for preload, ~create() for rendering)
- Load `src/ui/screens/VillageScreen.tsx` to see info panel patterns (~line 55 for type union, ~line 185 for callbacks, ~line 535 for JSX renders)
