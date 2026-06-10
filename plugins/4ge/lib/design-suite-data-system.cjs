// plugins/4ge/lib/design-suite-data-system.cjs
'use strict';

// --- Data Mode ---

const SCHEMA_DESIGN_RULES = [
  { id: 'data-pk', rule: 'Every table has a primary key. Prefer UUID v7 or ULID for distributed systems', severity: 'error' },
  { id: 'data-timestamps', rule: 'Include created_at and updated_at on all tables. Use database-level defaults', severity: 'warning' },
  { id: 'data-soft-delete', rule: 'Prefer soft delete (deleted_at timestamp) over hard delete for audit trails', severity: 'warning' },
  { id: 'data-normalize', rule: 'Normalize to 3NF by default. Denormalize only with documented justification', severity: 'warning' },
  { id: 'data-naming', rule: 'Use snake_case for columns. Singular table names (user, not users). Avoid reserved words', severity: 'warning' },
];

const MIGRATION_SAFETY_RULES = [
  { id: 'mig-backward', rule: 'Migrations must be backward-compatible. Deploy schema first, then code', severity: 'error' },
  { id: 'mig-rollback', rule: 'Every migration has a corresponding down/rollback. Test both directions', severity: 'error' },
  { id: 'mig-no-lock', rule: 'Avoid ALTER TABLE on large tables during peak hours. Use online DDL or background migration', severity: 'warning' },
  { id: 'mig-data', rule: 'Separate schema migrations from data migrations. Data migrations are code, not SQL', severity: 'warning' },
];

const RELATIONSHIP_PATTERNS = {
  one_to_many: 'Foreign key on the "many" side. Index the FK column',
  many_to_many: 'Junction table with composite PK. Add created_at for audit',
  one_to_one: 'FK with UNIQUE constraint. Consider embedding if always fetched together',
  polymorphic: 'Prefer separate tables over type+id pattern. Type+id breaks FK constraints',
};

const INDEXING_PATTERNS = {
  primary: 'Clustered index on PK (automatic in most databases)',
  foreign_keys: 'Index all FK columns for JOIN performance',
  query_patterns: 'Create indexes based on actual query patterns (WHERE, ORDER BY, GROUP BY)',
  composite: 'Column order matters: put equality conditions first, range conditions last',
  partial: 'Use partial indexes for filtered queries (WHERE status = "active")',
};

const DATA_WORKFLOW = [
  { step: 1, name: 'Entities', description: 'Identify domain entities and their attributes' },
  { step: 2, name: 'Schema', description: 'Design table schemas with types, constraints, defaults' },
  { step: 3, name: 'Seed', description: 'Create seed data for development and testing' },
  { step: 4, name: 'Indexes', description: 'Add indexes based on query patterns' },
  { step: 5, name: 'Repository', description: 'Implement data access layer with typed queries' },
];

function assembleDataToolkit(config) {
  const detected = (config && config.detected) || {};
  const orm = detected.orm || detected.framework || 'generic';
  return {
    schema_design: SCHEMA_DESIGN_RULES,
    relationships: RELATIONSHIP_PATTERNS,
    indexing: INDEXING_PATTERNS,
    migration_safety: MIGRATION_SAFETY_RULES,
    audit_trail: {
      pattern: 'Append-only audit log table with actor, action, entity_type, entity_id, diff (JSONB)',
      trigger: 'Database trigger or application-level middleware',
    },
    workflow: DATA_WORKFLOW,
    orm_hint: orm,
  };
}

// --- System Mode ---

const SYSTEM_PATTERNS = {
  bounded_contexts: [
    'Define clear boundaries between subsystems',
    'Each context has its own models (no shared mutable state)',
    'Communication between contexts via events or APIs (not direct DB access)',
    'Context maps: upstream/downstream, conformist, anti-corruption layer',
  ],
  coupling_metrics: {
    afferent: 'Ca: Number of modules that depend on this module (fan-in)',
    efferent: 'Ce: Number of modules this module depends on (fan-out)',
    instability: 'I = Ce / (Ca + Ce) — closer to 0 = stable, closer to 1 = unstable',
    abstractness: 'A = abstract_classes / total_classes — closer to 1 = abstract',
  },
  dependency_direction: [
    'Dependencies flow inward: outer layers depend on inner layers, never reverse',
    'Domain layer has zero external dependencies',
    'Infrastructure layer depends on domain, not vice versa',
    'Use dependency injection for testability',
  ],
};

const TRADEOFF_TEMPLATE = {
  dimensions: ['Performance', 'Maintainability', 'Complexity', 'Time to implement', 'Risk'],
  scale: '1 (worst) to 5 (best)',
  format: '| Option | Perf | Maint | Complex | Time | Risk | Total |',
};

const SYSTEM_WORKFLOW = [
  { step: 1, name: 'Dependencies', description: 'Map module dependency graph, identify cycles' },
  { step: 2, name: 'Coupling', description: 'Measure coupling metrics, identify high-fan-out modules' },
  { step: 3, name: 'Boundaries', description: 'Define bounded contexts and communication patterns' },
  { step: 4, name: 'Trade-offs', description: 'Build trade-off matrix for architectural decisions' },
  { step: 5, name: 'ADR', description: 'Document decision as Architecture Decision Record' },
];

function assembleSystemToolkit(config) {
  const monorepo = (config.detected && config.detected.monorepo) || '';
  const monorepoPatterns = monorepo ? [
    `Package boundaries enforced by ${monorepo} task graph`,
    'Shared packages in packages/shared/ or libs/',
    'No circular dependencies between packages',
    'Internal packages use workspace protocol (workspace:*)',
  ] : [];

  return {
    dependency_analysis: SYSTEM_PATTERNS.dependency_direction,
    coupling: SYSTEM_PATTERNS.coupling_metrics,
    boundaries: {
      patterns: SYSTEM_PATTERNS.bounded_contexts,
      monorepo,
      monorepo_patterns: monorepoPatterns,
    },
    tradeoffs: {
      template: TRADEOFF_TEMPLATE,
    },
    workflow: SYSTEM_WORKFLOW,
  };
}

module.exports = {
  assembleDataToolkit,
  assembleSystemToolkit,
  SCHEMA_DESIGN_RULES,
  MIGRATION_SAFETY_RULES,
  RELATIONSHIP_PATTERNS,
  INDEXING_PATTERNS,
  SYSTEM_PATTERNS,
};
