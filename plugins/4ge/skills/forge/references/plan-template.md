# Plan Template

Plans consumed by forge extend the standard writing-plans format with DAG metadata.

## Task Metadata Format

Each task in a forge plan includes a JSON metadata block immediately after the task heading:

```markdown
### Task N: [Component Name]

<!-- forge-meta
{
  "id": "TN",
  "title": "Component Name",
  "depends_on": ["T1", "T2"],
  "owner": null,
  "scope": ["path/to/files/**"],
  "agent": "sonnet-execute",
  "context_budget_override": null
}
-->

**Files:**
- Create: ...
- Modify: ...
- Test: ...

Steps...
```

## Metadata Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | -- | Unique ID matching `TN` pattern |
| `title` | Yes | -- | Matches task heading |
| `depends_on` | Yes | `[]` | IDs of prerequisite tasks |
| `owner` | No | `null` | Teammate name (assigned at runtime) |
| `scope` | Yes | -- | File globs this task owns |
| `agent` | No | `null` | Preferred agent type |
| `context_budget_override` | No | `null` | Override default 65% compact threshold |

## Scope Rules

- Every file created or modified must appear in exactly one task's `scope`
- Overlapping scopes between tasks are a plan error
- If two tasks must touch the same file, one depends on the other (sequential)
