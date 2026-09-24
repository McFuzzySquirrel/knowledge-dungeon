---
name: add-village-structure
description: Adds a renderer-neutral village structure through content data, Pixi world presentation, React DOM interaction, and browser verification.
---

# Add a Village Structure

Use this skill for buildings, landmarks, ponds, portals, decorations, or other village structures in the React and PixiJS rebuild.

## Process

### 1. Define data

Have `village-content-designer` add a stable structure ID, type, label, bounds, position, and any portal or subject relationship to the renderer-neutral village layout. Keep content serializable and free of Phaser or Pixi types.

### 2. Add Pixi presentation

Have `game-engineer` load the approved CC0 asset through the Pixi asset bundle, place the object in the correct world layers, add visual state, proximity, and renderer-neutral interaction events, and provide cleanup.

### 3. Add React interaction

Have `ui-engineer` add the structure action to the DOM nearby-action list, panel, dialog, or bottom sheet. Every core action needs a keyboard and screen-reader route. Keep the visual world and the action control independent.

### 4. Add application routing

Have `core-logic-engineer` and the orchestrator define the command, persistence effect, subject context, and idempotency rules before wiring the action. Do not mutate domain state from the renderer.

### 5. Add tests

Have `qa-engineer` test layout bounds, approach and interaction, keyboard and touch routes, subject context, empty or locked states, and existing structure regression. Verify assets against the CC0 registry.

## Output

A completed structure includes:

- Renderer-neutral content data
- Pixi display and interaction event
- React DOM action and panel
- Application command or store integration
- Asset license record
- Unit, component, and browser verification

## Constraints

- Do not add Phaser-only rendering for new structures.
- Do not infer subject identity from visual proximity alone when a stable portal relationship exists.
- Do not use closures or functions in serializable quest or structure data.
- Keep interactive structure types synchronized across data, renderer, and UI unions.
