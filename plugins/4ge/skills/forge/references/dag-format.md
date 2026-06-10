# Dependency DAG Format

Tasks in forge plans declare dependencies via `depends_on`. Forge parses this to determine execution order.

## Task JSON Schema

Each task in the plan has a JSON metadata block:

```json
{
  "id": "T3",
  "title": "Wire IPC handlers",
  "depends_on": ["T1", "T2"],
  "owner": null,
  "scope": ["src/main/ipc/**"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique task ID (T1, T2, ...) |
| `title` | string | Yes | Short task description |
| `depends_on` | string[] | Yes | Task IDs that must complete first (empty = no deps) |
| `owner` | string\|null | No | Assigned teammate name (null = unassigned) |
| `scope` | string[] | Yes | File/directory globs this task owns |

## Topo-Sort Rules

1. Parse all task metadata blocks from the plan markdown
2. Build adjacency list from `depends_on` fields
3. Detect cycles — if found, reject the plan with specific cycle path
4. Tasks with empty `depends_on` form the initial ready set
5. When a task completes, check dependents — if all deps satisfied, add to ready set
6. Launch ready tasks in parallel up to max teammates (default 4)

## Cycle Detection

Use Kahn's algorithm (BFS-based topo-sort). If the sorted result has fewer nodes than the graph, a cycle exists. Report the cycle by tracing back through the remaining nodes.

## Examples

### Independent Tasks (full parallelism)
```
T1 (depends_on: []) --+
T2 (depends_on: []) --+-- all launch immediately
T3 (depends_on: []) --+
```

### Sequential Chain
```
T1 (depends_on: []) -> T2 (depends_on: ["T1"]) -> T3 (depends_on: ["T2"])
```

### Diamond Dependency
```
     T1 (depends_on: [])
    /  \
  T2    T3  (both depend on T1)
    \  /
     T4     (depends on T2 AND T3)
```
T1 launches first. When T1 completes, T2 and T3 launch in parallel. T4 waits for both.

### Mixed Graph
```
T1 [] --- T3 ["T1"] --- T5 ["T3", "T4"]
T2 [] --- T4 ["T2"] --+
```
T1 and T2 launch in parallel. T3 waits for T1. T4 waits for T2. T5 waits for both T3 and T4.
