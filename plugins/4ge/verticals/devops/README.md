# DevOps Vertical

Domain-specific configuration for DevOps and infrastructure projects.

## What it does

The DevOps vertical adjusts wizard scoring weights and thresholds for repositories that manage infrastructure, CI/CD pipelines, containerized deployments, and supply chain security.

### Weight adjustments

| Category | Base weight | DevOps weight | Rationale |
|----------|-------------|---------------|-----------|
| dependencies | 1.2 | 2.0 | Supply chain is a primary attack surface |
| security | 1.5 | 2.0 | Infra misconfig = production exposure |
| config | 1.0 | 1.5 | Config drift causes outages |
| dead_code | 0.8 | 0.5 | Less relevant in infra repos |
| docs | 0.6 | 0.4 | Runbooks matter, but weight is secondary |

### New thresholds

| ID | Points | Max | Description |
|----|--------|-----|-------------|
| dockerfile_unpinned | -3 | -9 | FROM without pinned digest or exact tag |
| terraform_drift | -4 | -12 | State drift between plan and apply |
| secret_in_env_file | -5 | -5 | Secret in .env or docker-compose env_file |

### Research depth

Dependencies and security categories default to `deep` research (includes OSV database).

## Activation

### Option A: Project config key

Add to `.4ge-wizard.json`:

```json
{
  "vertical": "devops"
}
```

### Option B: CLI flag

```
/outhouse --vertical devops
```

### Option C: Auto-detect

The dialect detector suggests `devops` when it finds Dockerfile, docker-compose, Terraform, or Kubernetes manifests in the project root.

## Customization

Copy this directory to `.4ge-verticals/devops/` to customize for your project:

```
.4ge-verticals/
  devops/
    defaults.json   # your overrides (project-level takes precedence)
```

Project-level overrides in `.4ge-wizard.json` always win over vertical defaults.
