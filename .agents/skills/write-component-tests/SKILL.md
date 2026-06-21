---
name: write-component-tests
description: >
  Writes Vitest + React Testing Library tests for a Knowledge Dungeon React
  UI component, covering render, user interaction, state integration, and
  edge cases.
---

# Skill: Write Component Tests

Creates comprehensive tests for a Knowledge Dungeon React UI component using Vitest and React Testing Library.

---

## Process

### Step 1: Locate the Component

Find the component file in `src/ui/components/`. Determine:
- What Zustand stores it reads from (sessionStore, subjectStore, etc.)
- What user interactions it supports (clicks, key presses, drags)
- What conditional rendering it does (phase-based tabs, loading states, error states)

### Step 2: Create the Test File

Create `tests/unit/{ComponentName}.test.tsx`. Follow the existing test patterns:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComponentName } from '../../src/ui/components/ComponentName';
```

### Step 3: Set Up Store Mocks

Mock the Zustand stores that the component depends on. Use `useXxxStore.setState()` to set up the desired state before each test:

```typescript
import { useSessionStore } from '../../src/store/sessionStore';

beforeEach(() => {
  // Reset stores to default state
  useSessionStore.setState({
    phase: 'scribe',
    activeScreen: 'game',
  });
});
```

Do NOT mock the entire store — just set the initial state. This keeps tests realistic and catches store integration issues.

### Step 4: Write Test Cases

Cover these categories:

**Render tests:**
```typescript
it('renders the subject name', () => {
  useSubjectStore.setState({ subjects: { 'test-id': { name: 'Linear Algebra' } } });
  render(<SubjectList />);
  expect(screen.getByText('Linear Algebra')).toBeDefined();
});
```

**Interaction tests:**
```typescript
it('opens the note editor on click', async () => {
  const user = userEvent.setup();
  render(<RoomPanel roomId="room-1" />);
  await user.click(screen.getByText('Open encounter'));
  expect(screen.getByRole('dialog')).toBeDefined();
});
```

**Conditional rendering tests:**
```typescript
it('shows Archaeologist tab only when phase allows', () => {
  useSessionStore.setState({ phase: 'scribe' });
  render(<RoomPanel roomId="room-1" />);
  expect(screen.queryByText('Self-Check')).toBeNull();
});
```

**Edge case tests:**
```typescript
it('handles empty subject list gracefully', () => {
  useSubjectStore.setState({ subjects: {} });
  render(<SubjectList />);
  expect(screen.getByText('No subjects yet')).toBeDefined();
});
```

### Step 5: Run and Verify

```bash
npx vitest run tests/unit/ComponentName.test.tsx
```

---

## Output Format

The test file should follow this structure:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Store imports as needed

describe('ComponentName', () => {
  beforeEach(() => {
    // Reset all relevant stores to defaults
  });

  describe('rendering', () => {
    it('renders primary content');
    it('renders empty/loading state');
    it('renders error state');
  });

  describe('interactions', () => {
    it('responds to click');
    it('responds to keyboard');
  });

  describe('conditional behavior', () => {
    it('adapts to phase');
    it('adapts to room state');
    it('adapts to mobile viewport');
  });
});
```

---

## Validation

- [ ] `npm run typecheck` — no type errors in test files
- [ ] `npm run lint` — no lint errors
- [ ] All tests pass: `npm test -- --run`
- [ ] Tests cover: render, primary interaction, empty state, error state
- [ ] No Phaser imports in test files (cannot run in jsdom)
- [ ] No real localStorage or fetch calls (use mocks)

---

## Gotchas

- Phaser CANNOT run in jsdom — test files must never import Phaser. If a component depends on Phaser data, receive it through Zustand stores, not directly from Phaser
- `localStorage` is not native in jsdom — the vitest setup file provides a mock; if you need a clean slate, use `localStorage.clear()` in `beforeEach`
- `useUserEvent` setup is async — always `await user.click()` not `fireEvent.click()`
- For components that use `window.matchMedia` (mobile drawer), the vitest setup file provides a polyfill. If testing mobile-specific behavior, set the matchMedia mock before rendering
- Component tests should NOT test the underlying domain logic — mock the store state and test the UI behavior
- Use `screen.getByRole()` and `screen.getByText()` over `screen.getByTestId()` — prefer accessible queries
- For time-based features (toast auto-dismiss, cooldown timers), use `vi.useFakeTimers()` and `vi.advanceTimersByTime()`

---

## Reference

See [docs/PRD.md](../../../docs/PRD.md):
- **Section 15** - Testing strategy and key test scenarios

For existing test examples:
- `tests/unit/Hud.test.tsx` — HUD component tests
- `tests/unit/RoomPanel.test.tsx` — Room panel tests
- `tests/unit/NoteEditorModal.test.tsx` — Note editor tests
