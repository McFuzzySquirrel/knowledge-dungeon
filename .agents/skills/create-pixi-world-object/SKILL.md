---
name: create-pixi-world-object
description: Scaffolds a renderer-neutral PixiJS 8 world object for the Knowledge Dungeon village, dungeon, or fishing world with assets, interaction, animation, accessibility, and cleanup.
---

# Create a PixiJS World Object

Use this skill for NPCs, structures, decorations, portals, room markers, fishing elements, and other world presentation objects in the React and PixiJS rebuild.

## Process

### 1. Define the object contract

Identify the owning world, stable object ID, position, dimensions, visual layers, interaction event, and state source. Keep layout and content data separate from Pixi display objects.

### 2. Load approved assets

Use the Pixi asset bundle or `Assets.load` path defined by `game-engineer`. Every new media file must be CC0-approved and registered. Do not fetch unapproved media or remote fonts.

Prefer an `Assets` bundle for reusable objects. Unload bundles and revoke custom object URLs during teardown.

### 3. Build the display object

Use a `Container` for grouped objects and leaf types such as `Sprite`, `AnimatedSprite`, `Graphics`, `Text`, or `TilingSprite` for individual visuals. Set anchors, transforms, render layers, masks, and bounds deliberately.

Do not add children to leaf display objects. Use stable labels for debugging and renderer inspection.

### 4. Add interaction

Set `eventMode` explicitly for interactive objects. Use pointer events, hit areas, and renderer-neutral callbacks. Keep keyboard and DOM action mirrors in the application and React layers.

Do not mutate domain stores directly from a renderer. Emit an event or call an application command.

### 5. Add animation and feedback

Use ticker delta values, restrained easing, and reduced-motion checks. Animate only visual properties or delegate gameplay state to a pure controller. Never redraw complex Graphics every frame without a measured need.

### 6. Integrate lifecycle and cleanup

Add and remove the object through the world controller. Ensure route unmount, visibility pause, resize, and repeated mount/unmount cycles do not leak textures, listeners, or ticker callbacks.

### 7. Test

Verify keyboard, pointer, touch, resize, reduced motion, DOM fallback, and state visibility. Confirm the object uses approved assets and emits the expected renderer-neutral event.

## Output

The completed object should have:

- A stable data definition
- A Pixi display component
- An interaction event contract
- A DOM alternative when it represents a core action
- Cleanup and test coverage
