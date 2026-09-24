---
name: forge-orchestrate-build
description: Coordinate specialist agents through a rebuild plan or requirements document one phase at a time, with bounded scope, evidence gates, rollback, and explicit acceptance.
---

# Orchestrate a Project Build

Use this skill when `project-orchestrator` needs to execute `docs/plans/*.md`, a PRD, or a feature document. The active source of truth determines the mode. Never use a missing or stale document as a substitute.

## Plan mode

When `docs/plans/001-cozy-pixi-rebuild.md` is active:

1. Read the complete plan and the requested phase.
2. Read `.opencode/agents/*.md` for ownership and handoffs.
3. Confirm the phase status and prerequisites.
4. Restate objective, scope, non-goals, owners, files, tests, and rollback.
5. Create a task list for only the active phase.
6. Delegate to the primary specialist and required supporting specialists.
7. Review the actual diff and outputs.
8. Run phase-specific verification and the common gate.
9. Record evidence and set the phase to `verified` only when exit criteria pass.
10. Stop and request explicit acceptance before the next phase.

Use only `not-started`, `in-progress`, `blocked`, `verified`, and `complete` for plan status. Parallel delegation is allowed only for independent work inside the active phase. Do not combine renderer migration with unrelated data-format work unless the phase explicitly requires it.

The plan's common gate is:

```bash
npm run lint
npm run typecheck
npm test
npm run build:web
npm run check:bundle-size
```

Do not automatically commit, push, deploy, or advance phases. Record evidence instead:

- Files changed
- Commands and results
- Device and browser checks
- Migration and data result
- Accessibility, performance, privacy, and license result
- Known limitations
- Rollback procedure

## Requirements-document modes

For a PRD or feature document, first identify whether it is a full build, a feature increment, or a decomposed feature set. Read the complete source, map requirements to one primary agent, preserve unaffected agents, and verify dependencies before execution.

Use the same phase protocol: announce the phase, delegate bounded work, verify deliverables, record evidence, and pause for acceptance.

## Ownership

- `core-logic-engineer`: domain, application commands, storage, migrations, backups, statistics, assistance, and idempotency.
- `game-engineer`: Pixi worlds, renderer-neutral world contracts, input, camera, and temporary Phaser compatibility.
- `ui-engineer`: React DOM shell, Cozy UI, accessibility, Data Center, statistics, assistance, and sharing.
- `infrastructure-engineer`: flags, build, CI, privacy, offline shell, performance, and CC0 enforcement.
- `qa-engineer`: unit, browser, migration, data, accessibility, privacy, performance, memory, and license verification.
- `village-content-designer`: renderer-neutral village, NPC, quest, tutorial, and fish content.
- `forge-team-builder`: agent-team maintenance.

## Handoffs

- Core contracts precede UI and renderer consumers.
- Infrastructure flags and asset contracts precede integration phases.
- UI and renderer agree on world events and DOM action mirrors.
- QA defines or executes verification for every phase.
- Content changes remain data-driven and renderer-neutral.

## Safety

- No learner data in logs, URLs, flags, filenames, or error reports.
- No automatic uploads, analytics, telemetry, accounts, cloud sync, or public profiles.
- No renderer imports in core or renderer-neutral application modules.
- No unapproved media in the default bundle.
- No commits, pushes, deployments, or destructive migrations without explicit user authorization.

## Output

Use `references/output-templates.md`. Always report the active phase, owners, evidence, limitations, rollback, and the explicit acceptance question. Load the output template only after the execution mode and phase are known.
