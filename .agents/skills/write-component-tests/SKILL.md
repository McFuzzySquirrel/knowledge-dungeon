---
name: write-component-tests
description: Writes Vitest and React Testing Library tests for Knowledge Dungeon DOM components, with store isolation, accessibility semantics, and browser follow-up for Pixi behavior.
---

# Write Component Tests

Use this skill for React DOM components and application-facing controls. Test renderer-neutral behavior here and use browser tests for actual Pixi canvas behavior.

## Process

1. Read the component, its selectors, store dependencies, and accessible contract.
2. Create or update a focused test under `tests/unit/` or the established component-test location.
3. Set only the relevant store state before each test and reset it afterward.
4. Cover render, primary interaction, keyboard interaction, conditional phase/state, empty, loading, error, recovery, and conflict cases.
5. Prefer `screen.getByRole`, `getByLabelText`, and other accessible queries.
6. Test Data Center conflict and restore states, statistics empty/restored states, assistance explanation, share preview, Web Share cancellation, and local attachment states where relevant.
7. Use fake timers for cooldowns, toasts, and session timing.
8. Run the focused test and then the phase gate.

## Rules

- Do not import Phaser or Pixi into jsdom component tests.
- Do not make real network, IndexedDB filesystem, or upload calls in unit tests unless the test is explicitly an integration test with controlled adapters.
- Mock the world through renderer-neutral events or a world handle.
- Test the DOM alternative for every core Pixi interaction.
- Test focus trapping, restoration, Escape, live status, and error recovery for dialogs.
- Keep tests behavior-focused and accessible-query-first.

## Validation

```bash
npm test -- tests/unit/ComponentName.test.tsx
npm run lint
npm run typecheck
```

For Pixi lifecycle, pointer, camera, resize, and teardown behavior, add a Playwright browser test instead of trying to test canvas internals in jsdom.
