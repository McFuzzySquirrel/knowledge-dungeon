# Implementation Progress

## Phase 0 — Quick Wins ✅

### 0.1 — Start Tutorial button on WelcomeScreen ✅
- [x] Create walkthrough data (`src/data/tutorialSubject.ts`) — 3 rooms: "The Note", "Tools of the Trade", "The Map & Beyond"
- [x] Add "Start Tutorial" button to WelcomeScreen with styled card
- [x] Auto-sets Scribe phase for tutorial

### 0.2 — Inline validation feedback ✅
- [x] Added `CRITERION_LABELS` and `getCriterionHint()` helpers
- [x] Enhanced Checks panel in `NoteEditorModal` to show rubric criteria (score/2 + colored dot + fix hints)

### 0.3 — Tooltips for hidden features ✅
- [x] Created `Tooltip` component with localStorage seen-state tracking
- [x] Added tooltips to Hud: Map, Teleport, Info buttons

### 0.4 — Export reminder for web version ✅
- [x] Created `useExportReminder` hook (30-min interval, web-only)
- [x] Added `action` button support to `ToastStack` + `useToasts`
- [x] Integrated into `GameScreen`

## Phase 1 — Onboarding & Polish ✅

### 1.2 — Visual dungeon theming ✅
- [x] Created SVGs: chest-open, chest-closed, door-locked, icon-book, icon-gear, icon-question
- [x] Added texture keys + preload entries in `DungeonScene`
- [x] Added `refreshRoomOverlays()` showing chests for cleared rooms, locked doors for unvisited

### 1.3 — Better mobile layout ✅
- [x] Larger touch-interact-btn (64px) at 480px breakpoint
- [x] Larger HUD button touch targets (48×48)
- [x] Larger phase buttons, collection buttons
- [x] Existing responsive layout (900px column mode + 480px polish) already in place

## Files Created/Modified

### New files (10):
| File | For |
|------|-----|
| `src/data/tutorialSubject.ts` | 0.1 — Walkthrough subject data |
| `src/ui/components/Tooltip.tsx` | 0.3 — Reusable tooltip |
| `src/ui/utils/tooltips.ts` | 0.3 — Tooltip seen-state |
| `src/ui/hooks/useExportReminder.ts` | 0.4 — Export nudge |
| `public/assets/sprites/objects/chest-open.svg` | 1.2 — Cleared room |
| `public/assets/sprites/objects/chest-closed.svg` | 1.2 — Unvisited room loot |
| `public/assets/sprites/objects/door-locked.svg` | 1.2 — Locked door |
| `public/assets/sprites/icon-book.svg` | 1.2 — Room type icon |
| `public/assets/sprites/icon-gear.svg` | 1.2 — Room type icon |
| `public/assets/sprites/icon-question.svg` | 1.2 — Room type icon |

### Modified files (9):
| File | Changes |
|------|---------|
| `src/ui/screens/WelcomeScreen.tsx` | +Tutorial button + importSnapshot |
| `src/ui/components/NoteEditorModal.tsx` | +Rubric feedback in Checks panel |
| `src/ui/components/Hud.tsx` | +Tooltips on info/map/teleport |
| `src/ui/components/ToastStack.tsx` | +Action buttons + dismiss |
| `src/ui/utils/useToasts.ts` | +Action param + dismissToast |
| `src/ui/screens/GameScreen.tsx` | +Export reminder + ToastStack dismiss |
| `src/game/scenes/DungeonScene.ts` | +Sprite preloads + room overlays |
| `src/styles.css` | +480px touch target sizes |
| `progress.md` | This file |
