# Config Schema Reference

Schema for `.4ge-wizard.json` project configuration and `wizard-defaults.json` plugin defaults.

## Top-Level Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string | "1.0.0" | Config version (checked at load, warns on mismatch) |
| `categories` | object | (see below) | Per-category configuration |
| `research` | object | (see below) | Research depth and source settings |
| `suppress` | array | [] | Suppress entries for hiding known false positives |
| `inbox` | object | (see below) | Issue collector configuration |
| `custom_categories` | array | [] | Additional categories beyond the 9 built-ins |
| `verification` | object | (see below) | Verification commands |
| `ship` | object | (see below) | Commit and report settings |
| `security_floors` | object | (see below) | Non-overridable security minimums enforced at config load |
| `context_budget` | object | (see below) | Token budget warning thresholds |
| `ci` | object | (see below) | CI mode score threshold and output format |

## Category Config

Each of the 9 built-in categories supports:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Enable/disable this category |
| `pass_threshold` | number | 80 | Percentage threshold for PASS grade |
| `deep_dive_threshold` | number | 50 | Percentage threshold for mandatory deep dive |
| `weight` | number | 1.0 | Scoring weight (security default: 1.5) |

Additional per-category fields vary (e.g., `stale_days` for branches, `perf_budget_ms` for hooks).

## Security Floors (Non-Overridable)

These floors are enforced at config load time. Project config cannot override them:

| Setting | Floor | Enforcement |
|---------|-------|-------------|
| `security.enabled` | `true` | Silently reset to true if false |
| `security.pass_threshold` | 30 | Lower values silently raised to 30 |
| suppress category "security" with pattern ".*" | Rejected | Entry removed from suppress array |
| `auto_promote_max_tier` | `"suggested"` | Hard-coded, not configurable |

## Suppress Entry Schema

```json
{
  "category": "string (required)",
  "pattern": "string (required, regex)",
  "reason": "string (required, human-readable)",
  "expires_at": "string (ISO date) or null (required)"
}
```

- `expires_at` is required. Use `null` for permanent (explicit opt-in).
- Expired entries (past `expires_at` date) are auto-removed at config load.
- Critical-severity security findings are silently unsuppressed regardless of rules.

## Research Config

Plugin defaults use `["memory", "codebase"]` only. The example below shows a project-level override that adds web sources. Web requires explicit opt-in via project config or mode frontmatter.

```json
{
  "depth": "standard",
  "confidence_threshold": 0.80,
  "sources": ["memory", "codebase", "web"],
  "max_results_per_category": 5,
  "overrides": {
    "dependencies": { "depth": "deep", "sources": ["memory", "codebase", "web", "osv"] }
  }
}
```

## Inbox Config

```json
{
  "auto_capture": false,
  "sources": ["hook-failure", "verify-failure", "session-audit"],
  "max_age_days": 30,
  "auto_promote_threshold": 3
}
```

Plugin default for `auto_capture` is `false`. Auto-captured error descriptions are truncated to 200 characters.

## Deep Merge Rules

1. Objects merge recursively (project overrides at leaf level)
2. Arrays replace (not append) -- ESLint flat config convention
3. `null` in project config removes the field
4. Missing fields inherit from plugin defaults
5. `custom_categories` are additive (never remove built-ins)
6. `version` mismatch: warn and proceed with best-effort merge

## Thresholds Config

Per-category deduction rules are defined in `references/threshold-defaults.json` as the canonical plugin defaults. Projects can override individual threshold entries in `.4ge-wizard.json` under `categories.<name>.thresholds`.

### ThresholdEntry Shape

```typescript
interface ThresholdEntry {
  points: number;      // Deduction per finding (negative integer or zero)
  max: number;         // Maximum total deduction (negative integer, floor)
  per?: number;        // If present, deduction applies per N occurrences (positive integer)
  stale_days?: number; // If present, configures the staleness window (positive integer)
  description?: string; // Human-readable label (informational, not used in scoring)
}
```

### Field Validation

| Field | Rule | Rejection Behavior |
|-------|------|-------------------|
| `points` | Negative integer or zero | Config load error |
| `max` | `abs(max) >= abs(points)` (cap at least as large as one deduction) | Config load error |
| `per` | Positive integer if present | Config load error |
| `stale_days` | Positive integer if present | Config load error |
| Unknown keys | No matching threshold id in defaults | Warning to stderr, not an error |

### Config Resolution Order

1. **Plugin defaults** — `references/threshold-defaults.json` (canonical values shipped with the plugin)
2. **Project overrides** — `.4ge-wizard.json` `categories.<name>.thresholds.<id>` deep-merged over defaults at the entry level
3. **Security floors** — enforced post-merge (see Security Floors section)

Deep merge is at the ThresholdEntry level: overriding `critical_vuln` replaces only that entry; all other entries in the category remain at plugin defaults.

### Example Override

```json
{
  "categories": {
    "security": {
      "thresholds": {
        "env_tracked": { "points": -10, "max": -10 }
      }
    },
    "agents": {
      "thresholds": {
        "stale_verified": { "points": -2, "max": -10, "stale_days": 30 }
      }
    }
  }
}
```

Only the specified entries are overridden. All other category thresholds inherit plugin defaults.

### Security Floor Enforcement

The following limits apply to the `security` category and cannot be overridden by project config:

| Setting | Floor | Enforcement |
|---------|-------|-------------|
| `security.enabled` | `true` | Silently reset to true if false |
| `security.pass_threshold` | 30 | Lower values silently raised to 30 |
| `security` category suppressed wholesale | Rejected | Entry removed from suppress array |
| Any `security.thresholds.<id>.points` | No weaker than `-1` | Values closer to 0 than -1 (i.e., 0) are rejected; prevents gaming the security score |

The intent: security threshold points must represent a real penalty. A points value of 0 or positive would mean a security finding has no scoring impact, which is rejected.

## Gitignore Requirements

These wizard runtime files should be in `.gitignore`:
- `.4ge-wizard-inbox.jsonl`
- `.outhouse-session.json`
- `.outhouse-baseline.json`
