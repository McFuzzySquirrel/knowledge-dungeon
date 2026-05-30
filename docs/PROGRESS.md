# Progress

## Initial scaffold

- [x] Root configs (package.json, vite, tsconfig, eslint, electron-builder, CI)
- [x] Phaser + React + Zustand shell
- [x] Ported mindmap-dungeon core (graph, note validation, progression,
      artifacts, review) under `src/core/`
- [x] Welcome screen with phase + class selector
- [x] Game shell with HUD, minimap, room panel (Topic/Notes/Artifact/Self-check),
      note editor modal, touch controls, help overlay
- [x] Local persistence (localStorage + Electron preload bridge)
- [x] Vitest unit tests for note validation, graph, progression, artifact,
      review, dungeon generation, HUD
- [x] CI workflow (lint, typecheck, test, build, bundle-size)
- [x] Release-desktop workflow (electron-builder mac/win/linux)

## Manual test checklist

1. `npm install`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run test -- --run`
5. `npm run build:web && npm run check:bundle-size`
6. `npm run electron` and:
   - Welcome → pick **Creator**, pick a class, type a subject name + root topic
   - Walk into the root room with `WASD`, press `E` → encounter modal opens
   - Add a child topic from the Topic tab; minimap shows the new room
  - Submit notes with required sections/manual confirmation → XP/loot fires
  - Optional: submit a 120+ word note and verify the bonus badge is awarded
   - Once every room is cleared, switch to **Archaeologist** and confirm
     self-check prompts render
