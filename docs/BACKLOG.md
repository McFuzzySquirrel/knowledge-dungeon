# Gameplay UI Flow Backlog

Date: 2026-06-01  
Source: Gameplay tester review of current UI flow

## Critical

- [ ] **Promote primary encounter action in Room Panel** (`src/ui/components/RoomPanel.tsx`)  
  Move “Open encounter”/“Mark reviewed” to the top of the Topic tab so players can immediately find the core action.

## High

- [ ] **Gate dungeon entry until archetype is selected** (`src/ui/screens/WelcomeScreen.tsx`)  
  Disable create/load entry actions until archetype is chosen and add clear inline guidance.

- [ ] **Require explicit “Enter Dungeon” after selecting existing subject** (`src/ui/screens/WelcomeScreen.tsx`)  
  Loading a subject should not instantly navigate; show a confirmation card with phase summary and explicit enter CTA.

- [ ] **Reduce accidental phase switching in HUD** (`src/ui/components/Hud.tsx`)  
  Move phase controls away from primary nav buttons and add confirmation when switching mid-progress.

- [ ] **Improve note submission guidance** (`src/ui/components/NoteEditorModal.tsx`)  
  Keep “Save draft/Defeat encounter” states, but show explicit missing requirements next to CTA.

- [ ] **Add first-run onboarding for gameplay loop** (`src/ui/screens/WelcomeScreen.tsx`, `src/ui/screens/GameScreen.tsx`)  
  Explain Creator → Scribe → Archaeologist flow and provide one-time in-game guidance for first subject setup.

## Medium

- [ ] **Show per-subject progress in welcome list** (`src/ui/screens/WelcomeScreen.tsx`)  
  Display cleared rooms and phase cue for each existing subject.

- [ ] **Explain locked Artifact/Self-check tabs** (`src/ui/components/RoomPanel.tsx`)  
  Replace silent disabled behavior with lock state messaging/tooltips.

- [ ] **Surface Archaeologist unlock progress prominently** (`src/ui/components/RoomPanel.tsx`)  
  Elevate “X/Y rooms cleared” into a visible progress card near top of panel.

- [ ] **Clarify note template intent** (`src/ui/components/NoteEditorModal.tsx`)  
  Add helper copy indicating template must be replaced and which sections are required.

- [ ] **Delay harsh validation state on first modal open** (`src/ui/components/NoteEditorModal.tsx`)  
  Show neutral checklist until user edits notes.

- [ ] **Guide teleport two-step flow** (`src/ui/components/Hud.tsx`, `src/ui/components/FullMapView.tsx`)  
  Auto-open map when teleport mode is armed and show “select destination” guidance.

- [ ] **Add welcome-back progress context on subject load** (`src/ui/screens/GameScreen.tsx`)  
  Show summary toast (rooms cleared, active phase, suggested next action).

- [ ] **Nudge phase transition after map creation** (`src/ui/components/Hud.tsx`, `src/ui/components/RoomPanel.tsx`)  
  Prompt switching to Scribe when enough Creator content exists.

## Low

- [ ] **Collapse/de-emphasize Admin section for first-time users** (`src/ui/screens/WelcomeScreen.tsx`)  
  Keep import available, defer advanced admin controls.

- [ ] **Improve Help button affordance** (`src/ui/components/Hud.tsx`)  
  Replace plain “?” with icon+label/tooltip for discoverability.

- [ ] **Hide raw Room ID from player UI** (`src/ui/components/RoomPanel.tsx`)  
  Keep IDs for dev/admin-only contexts.

- [ ] **Add minimap legend** (`src/ui/components/Minimap.tsx`)  
  Explain color and marker meaning.

