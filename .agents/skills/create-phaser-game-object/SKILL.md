---
name: create-phaser-game-object
description: Temporary compatibility guidance for legacy Phaser scenes during the React and PixiJS rebuild; new world objects use create-pixi-world-object.
---

# Create a Phaser Game Object

This skill is retained only for the temporary Phaser adapter and reference scenes. Do not add new Phaser-only world behavior after the renderer migration begins.

For new village, dungeon, fishing, or interactive world elements, use `create-pixi-world-object` and follow the renderer-neutral contracts in `docs/plans/001-cozy-pixi-rebuild.md`.

## Temporary use

When maintaining a legacy scene before cutover:

1. Read the current Phaser scene and the renderer-neutral event contract.
2. Make the smallest parity change possible.
3. Keep new logic in application or pure systems rather than in the scene.
4. Test the same behavior through the Phaser and Pixi adapters while both exist.
5. Record the temporary file and its removal phase.

## Constraints

- Phaser is not the target architecture.
- No new Phaser-only dependencies or scene patterns.
- No direct Phaser imports from core, persistence, or renderer-neutral application code.
- Do not remove the compatibility adapter before the plan's cutover and soak gates pass.
