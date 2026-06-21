---
name: create-phaser-game-object
description: >
  Scaffolds a new Phaser game object (NPC, decoration, portal, item, or
  interactive element) in a Knowledge Dungeon scene, following the project's
  patterns for texture loading, positioning, animation, and state integration.
---

# Skill: Create a Phaser Game Object

Adds a new renderable element to either the DungeonScene or VillageScene, including texture/sprite setup, positioning, animations, and Zustand store integration where needed.

---

## Process

### Step 1: Determine the Scene and Object Type

Identify which scene the object belongs to:

| Scene | File | Object Types |
|-------|------|-------------|
| DungeonScene | `src/game/scenes/DungeonScene.ts` | Room decorations, NPCs, chests, portals, stairs, items, environmental effects |
| VillageScene | `src/game/scenes/VillageScene.ts` | Buildings, NPCs, signposts, decorations (trees, bushes, ponds, etc.), portal vortexes, birds |

### Step 2: Load the Texture

In the scene's `preload()` method, add a texture load:

```typescript
// For SVG (scalable, good for simple shapes)
this.load.svg('texture-key', '/assets/sprites/my-object.svg', { width: 32, height: 32 });

// For raster images
this.load.image('texture-key', '/assets/sprites/my-object.png');
```

- SVG assets go in `public/assets/sprites/`
- If the object has multiple frames, use a sprite sheet with `this.load.spritesheet()`
- For procedural textures, call the relevant generator from `proceduralTextures.ts`

### Step 3: Create the Game Object

In the scene's `create()` or the relevant generation function, instantiate the object:

```typescript
// Simple image
const obj = this.add.image(x, y, 'texture-key');

// With physics body (if interactive)
this.physics.add.existing(obj);

// Text object (for signs, labels)
const label = this.add.text(x, y, 'Label', {
  fontFamily: '"Press Start 2P", monospace',
  fontSize: '12px',
  color: '#ffffff',
}).setOrigin(0.5);
```

### Step 4: Add Animation

For animated objects (portals, NPCs, floating items), add a tween in `create()`:

```typescript
// Floating idle animation
this.tweens.add({
  targets: obj,
  y: obj.y - 4,
  duration: 1500,
  yoyo: true,
  repeat: -1,
  ease: 'Sine.easeInOut',
});

// Spinning/pulsing (for portal vortexes)
this.tweens.add({
  targets: obj,
  scaleX: 1.1,
  scaleY: 1.1,
  alpha: 0.8,
  duration: 2000,
  yoyo: true,
  repeat: -1,
  ease: 'Sine.easeInOut',
});
```

### Step 5: Add Interactivity

If the object is interactive (NPC, portal, chest):

```typescript
obj.setInteractive({ pixelPerfect: true });

obj.on('pointerdown', () => {
  // Emit event or update store
  useSessionStore.getState().setInteractTarget(objectId);
});

// Highlight on hover
obj.on('pointerover', () => obj.setTint(0xaaaaaa));
obj.on('pointerout', () => obj.clearTint());
```

### Step 6: Integrate with Room/Village State

Connect the object to game state:

```typescript
// For room-specific objects (decorations, chests based on room state)
const roomState = subjectStore.getState().getRoom(roomId);
if (roomState.encounterState === 'ArtifactCollected') {
  obj.setVisible(false); // Hide chest after opened
}

// Read room state from subjectStore, write interactions to sessionStore
```

### Step 7: Add to Procedural Generation (if applicable)

For dungeon decorations, add the object to the decor placement in `DungeonScene.ts`'s `buildDecorForRoom()` function, using the deterministic PRNG:

```typescript
const decorType = seededRandom(roomIndex * 7 + floor);
if (decorType < 0.3) {
  // Place this object
}
```

---

## Output Format

The new object should be:
- Rendered in the correct scene (DungeonScene or VillageScene)
- Positioned at integer tile coordinates (48px grid)
- Animated appropriately (idle float, pulse, spin, or static)
- Connected to Zustand state if interactive
- Visible/hidden based on game state (room cleared, phase active, etc.)

---

## Validation

- [ ] `npm run typecheck` — no type errors
- [ ] `npm run lint` — no lint errors
- [ ] Object renders at correct position in the scene
- [ ] Animation plays correctly (no jitter, correct easing)
- [ ] Interactive objects respond to clicks/taps and E key
- [ ] Object visibility updates correctly with game state changes
- [ ] No performance regression (check FPS in browser DevTools)

---

## Gotchas

- Phaser texture keys must be unique across the entire game — use namespaced keys like `village-tree-1`, `dungeon-chest-open`
- Do NOT load textures in `create()` — always use `preload()` to ensure textures are ready before rendering
- The village uses a 48px tile grid — positions should be `tileX * 48 + offset` to align with the tilemap
- NPC dialog bubbles must emit world coordinates for the React overlay — use `scene.cameras.main.getWorldPoint()` for conversion
- For objects that need to persist state (opened chests, collected items), update `RoomMetadata` via `subjectStore` rather than Phaser data manager
- Interactive objects must register in the scene's input handler list for E key support — add to `interactiveObjects` array in DungeonScene

---

## Reference

See [docs/PRD.md](../../../docs/PRD.md) for the full specification:
- **Section 8.2** - Dungeon generation and room decoration
- **Section 8.3** - Interactive navigation objects (stairs, portals)
- **Section 8.8** - Village decorative elements and buildings
- **Section 8.10** - NPC rendering and animation
- **Section 14 - Phase 3c** - Boss rooms, biome decorations
