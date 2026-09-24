# Orchestration Output Templates

Load this file after selecting the execution mode and active phase.

## Plan Phase Output

```markdown
## Phase {N}: {Phase Name}

**Status:** {not-started|in-progress|blocked|verified|complete}
**Plan:** docs/plans/{plan-file}
**Primary owner:** {agent}
**Supporting agents:** {agents}

### Scope
- {allowed work}
- {allowed work}

### Non-goals
- {explicit exclusion}
- {explicit exclusion}

### Evidence
- Files: {paths}
- Commands: {commands and results}
- Device checks: {browser, viewport, input, or manual checks}
- Migration/data: {result or not applicable}
- Accessibility/performance/privacy/license: {result or not applicable}
- Known limitations: {limitations or none}
- Rollback: {procedure}

### Acceptance
Continue to Phase {N+1}?
```

## Requirements Phase Output

```markdown
## Starting Phase {N}: {Phase Name}

**Source:** {PRD or feature document}
**Primary owner:** {agent}
**Supporting agents:** {agents}

### Deliverables
- [ ] {deliverable}
- [ ] {deliverable}

### Evidence
- Files: {paths}
- Commands: {commands and results}
- Limitations: {limitations or none}
- Rollback: {procedure}

### Acceptance
Continue to the next phase?
```

## Handoff Output

```markdown
## Handoff: {from-agent} to {to-agent}

**Completed:** {summary}
**Contracts:** {types, events, commands, or files}
**Verification:** {evidence}
**Known limitations:** {limitations or none}
**Next owner action:** {action}
```
