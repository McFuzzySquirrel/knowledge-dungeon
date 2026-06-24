# Troubleshooting: Adding Village Structures

Common failure modes when adding a new village structure and how to diagnose them.

---

## Sprite Does Not Appear

**Symptoms:** TypeScript compiles, village loads, but the new structure is invisible.

**Checklist:**
1. **Texture key collision.** Run `grep -r "TEX\." src/game/scenes/VillageScene.ts` to verify your texture key is unique. Phaser silently ignores duplicate keys.
2. **Load dimensions mismatch.** The `{ width, height }` passed to `this.load.svg()` must match the grid-displayed size. If `struct.width=2, struct.height=2` at 48px tiles, use `{ width: 96, height: 96 }`. Mismatched dimensions produce invisible or 0-size sprites.
3. **Preload order.** Verify `this.load.svg(TEX.YOUR_NEW_TYPE, ...)` appears in the `preload()` method before any code that references the texture. Check it's not inside a conditional that skips it.
4. **Conditional rendering.** In `create()`, verify your `} else if (struct.type === 'your-new-type')` block is reached. Add a temporary `console.log('rendering:', struct.type)` before the conditional to confirm.
5. **Depth clipping.** If the sprite has a very low depth value, it may be behind the background. Try `sprite.setDepth(10)` temporarily to test.

---

## E Key Does Not Trigger Interaction

**Symptoms:** Walking up to the structure works (info panel shows), but pressing E has no effect.

**Checklist:**
1. **Missing `setInteractive()`.** The sprite must call `.setInteractive()` after creation in `create()`. Without it, the Phaser input plugin ignores the sprite.
2. **Callback wiring.** In the structure interact handler (search for `this.callbacks?.onStructureInteract`), verify your structure type has a branch that emits the callback. If it's missing, the event never reaches VillageScreen.
3. **Info panel type not in union.** The `onStructureInteract` callback in VillageScreen maps structure types via `if (sType === '...')`. Verify your type is listed there. An unhandled type silently does nothing.
4. **Overlapping input.** If another interactive sprite (NPC, portal) overlaps your structure's hitbox, Phaser may route the click to the wrong object. Test by placing your structure in an isolated grid position.

---

## TypeScript Union Error After Adding Type

**Symptoms:** `npm run typecheck` fails with a union type error after adding your structure.

**Checklist:**
1. **Two separate unions.** `VillageStructure.type` in `src/data/villageLayout.ts` and `infoPanel.type` in `src/ui/screens/VillageScreen.tsx` are independent unions. You must add your type string to **both** if your structure has an info panel. Missing one produces a type error.
2. **String literal vs variable.** The type must be a string literal (`'your-new-type'`), not a variable or template string. If you use a const variable elsewhere to reference the type, ensure it's typed as `const` or `as const`.
3. **Stale typecheck cache.** Sometimes `tsc` caches stale types. Run `npx tsc --noEmit --force` to clear the cache and recheck.

---

## Info Panel Does Not Show

**Symptoms:** Walking up to the structure shows nothing. No error, just no panel.

**Checklist:**
1. **Missing `onStructureApproached` case.** The callback in VillageScreen maps structure types to info panel types. If your type is not listed in the `if/else if` chain, no info panel opens.
2. **Wrong type string.** The structure type in the `onStructureApproached` callback must exactly match the string in `VillageStructure.type`. A typo or mismatch silently skips the handler.
3. **Info panel JSX missing.** Even if `onStructureApproached` sets `infoPanel({ type: 'your-new-type', ... })`, you also need a JSX conditional block (`{infoPanel?.type === 'your-new-type' ? (...) : null}`) to render the panel. Without it, state updates but nothing displays.

---

## Existing Structures Stop Working (Regression)

**Symptoms:** After adding your structure, existing buildings (Keeper, Guild Hall, portals) no longer respond.

**Checklist:**
1. **Broken `if/else if` chain.** In VillageScreen callbacks (`onStructureApproached`, `onStructureInteract`), verify your new branch is properly chained with `} else if (sType === 'your-new-type') {`. A missing `else` or misplaced brace can break all subsequent branches.
2. **Union type narrowing.** Adding your type to `VillageStructure.type` union should not affect existing types. If you accidentally removed an existing member while editing, TypeScript will catch it — but only if you run typecheck.
3. **VILLAGE_MAP mutation.** Adding entries to `VILLAGE_MAP.structures` should be append-only. If you accidentally modified or removed existing entries, the rendering loop breaks for those structures.
