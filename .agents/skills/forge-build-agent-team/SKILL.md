---
name: forge-build-agent-team
description: Build or update a focused OpenCode agent team from a PRD, feature document, or implementation plan while preserving unaffected specialists and using .opencode/agents/<name>.md.
---

# Build or Update an OpenCode Agent Team

Use this skill when the user asks to create, extend, or restructure the Knowledge Dungeon development team.

## Canonical locations

- Agents: `.opencode/agents/<agent-name>.md`
- Existing project skills: `.agents/skills/`
- Plans: `docs/plans/`

Agent filenames are lowercase hyphenated and do not use the old `.agent.md` suffix. Frontmatter must include a matching `name`, useful `description`, and `mode: subagent` unless the agent is intentionally primary. Do not leave duplicate agent definitions under `.agents/agents/` or `.agents/`.

## Mode detection

- **Full build:** A PRD or plan defines the complete architecture and phases.
- **Feature increment:** A feature document or plan changes selected responsibilities while existing agents remain valid.
- **Plan increment:** `docs/plans/*.md` defines an implementation sequence and cross-cutting gates. Preserve healthy agents and update only affected ownership.
- **Vision and features:** A product vision and feature documents define the dependency graph.

## Process

1. Read the complete source and all affected current agents.
2. Map each responsibility to one primary owner and define handoffs.
3. Compare existing agents before editing; preserve unaffected ownership.
4. Add only the expertise and procedures required by the new architecture.
5. Update supporting skills when they contain obsolete paths, renderer assumptions, storage rules, or verification gates.
6. Create or update `.opencode/agents/<name>.md` files.
7. Remove stale duplicate agent files after the canonical files are verified.
8. Validate frontmatter, references, ownership boundaries, and collaboration sections.
9. Report changed agents, changed skills, preserved agents, and unresolved gaps.

## Knowledge Dungeon architecture

The current plan establishes:

- React DOM owns application UI, forms, dialogs, maps, settings, Data Center, statistics, sharing, and accessible controls.
- PixiJS 8 owns Village, Dungeon, and Fishing world presentation.
- Core and application modules are renderer-neutral.
- Storage-v2 uses IndexedDB generations, staged writes, migration receipts, and rollback.
- Fishing, statistics, private share cards, and three data products remain in scope.
- New media is CC0-only and web release is local-first with no automatic upload or analytics.
- One phase is implemented and accepted at a time.

## Boundaries

- Do not regenerate the entire team for an incremental plan.
- Do not put one responsibility in multiple agents without a documented handoff.
- Do not add a new specialist unless an existing role cannot coherently own the responsibility.
- Do not leave agents pointing to missing PRDs, stale progress files, or obsolete `.agent.md` locations.
- Keep phase-specific tests and evidence requirements with the owning specialist and `qa-engineer`.

## Validation

- Every agent filename matches its frontmatter `name`.
- Every plan concern has one primary owner and a verifier.
- Every agent has expertise, workflow, validation, constraints, output standards, and collaboration sections.
- No agent requires obsolete Phaser-only or localStorage-only procedures.
- No stale duplicate agent definitions remain.
- Team-builder and orchestrator prompts recognize plan mode and explicit acceptance gates.
