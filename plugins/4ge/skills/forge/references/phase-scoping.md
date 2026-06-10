# Phase Scoping

Scope gate logic for forge Phase 1. Determines whether a task is ready to proceed or needs exploration first.

## Scope Gate Decision Tree

```
Task description received
+-- Is the task description >50 words with clear boundaries?
|   +-- YES -> Proceed to Phase 2 (brainstorm)
+-- Does it reference existing code/files by name?
|   +-- YES -> Grep/Glob to verify they exist, then proceed
+-- Is it a known domain (matches an agent's description keywords)?
|   +-- YES -> Proceed with domain agent pre-assigned
+-- Is it ambiguous or exploratory?
|   +-- YES -> Invoke /autoresearch <topic> first
+-- Is it too large (>10 files estimated, >3 domains)?
    +-- YES -> Suggest breaking into sub-project specs
```

## Autoresearch Routing

When the scope gate result is "ambiguous" or "needs exploration":

1. Extract the core topic from the task description
2. Invoke `/autoresearch <topic>` to seed the memory hub
3. Autoresearch stores findings via memory_store
4. Forge recalls findings via memory_search in subsequent phases
5. Re-evaluate scope with enriched context

This replaces ad-hoc "dispatch 3 research agents and wait" with structured, memory-integrated research.

## Scope Estimation

For each task, estimate:
- Number of files to create/modify
- Number of domains touched (hooks, agents, skills, configs, etc.)
- Number of external dependencies

| Estimate | Classification | Action |
|----------|---------------|--------|
| 1-5 files, 1 domain | Small | Single teammate, no forge needed |
| 5-15 files, 1-2 domains | Medium | Forge with 2-3 teammates |
| 15+ files, 3+ domains | Large | Forge with 4 teammates, consider sub-projects |
