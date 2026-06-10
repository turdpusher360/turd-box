// plugins/4ge/lib/design-suite-api.cjs
'use strict';

const VALIDATION_RULES = [
  { id: 'val-input', rule: 'Validate all request inputs at the handler boundary using Zod or equivalent', severity: 'error' },
  { id: 'val-output', rule: 'Type response bodies. Never return raw database objects', severity: 'error' },
  { id: 'val-params', rule: 'Validate path/query params. Reject unknown params (strict mode)', severity: 'warning' },
  { id: 'val-content-type', rule: 'Check Content-Type header. Reject non-JSON for JSON endpoints', severity: 'error' },
  { id: 'val-size', rule: 'Enforce request body size limits. Default: 1MB for JSON, 10MB for uploads', severity: 'warning' },
];

const ERROR_SCHEMA = {
  status: { type: 'number', description: 'HTTP status code' },
  code: { type: 'string', description: 'Machine-readable error code (e.g., VALIDATION_ERROR)' },
  message: { type: 'string', description: 'Human-readable error message' },
  details: { type: 'array', description: 'Array of field-level error details (optional)', optional: true },
  request_id: { type: 'string', description: 'Request correlation ID for debugging', optional: true },
};

const OPENAPI_PATTERNS = {
  structure: 'Define OpenAPI 3.1 spec with paths, components/schemas, and security schemes',
  versioning: 'Use URL path versioning (/v1/, /v2/) for breaking changes',
  pagination: 'cursor-based pagination with { data: T[], cursor: string | null, has_more: boolean }',
  filtering: 'Query params for filtering: ?status=active&created_after=2026-01-01',
  rate_limiting: 'Return X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers',
};

const ROUTER_PATTERNS = {
  hono: [
    'Use app.route() for modular route grouping',
    'Use c.json() for typed responses, c.text() for plain text',
    'Middleware via app.use() — auth, cors, logging',
    'Use Hono context (c.env) for Cloudflare bindings',
    'Error handling: app.onError() for global, try/catch for local',
  ],
  express: [
    'Use express.Router() for modular route grouping',
    'Use res.json() for responses, res.status().json() for errors',
    'Middleware chain: auth, cors, body-parser, error handler',
    'Use express.json({ limit: "1mb" }) for body parsing',
    'Error middleware: (err, req, res, next) => { ... }',
  ],
  fastify: [
    'Use fastify.register() for plugin-based route grouping',
    'Use reply.send() with JSON schema validation',
    'Use preHandler hooks for auth middleware',
    'Schema-based serialization for automatic response validation',
    'Error handling: setErrorHandler() for global errors',
  ],
};

const API_WORKFLOW = [
  { step: 1, name: 'OpenAPI', description: 'Define the API contract (paths, schemas, security)' },
  { step: 2, name: 'Stubs', description: 'Generate handler stubs from the spec' },
  { step: 3, name: 'Validation', description: 'Add input/output validation at handler boundaries' },
  { step: 4, name: 'Errors', description: 'Implement error handling with consistent error schema' },
  { step: 5, name: 'Tests', description: 'Write integration tests for each endpoint' },
];

/**
 * Assembles the API mode toolkit based on project config.
 *
 * @param {object} config - Runtime config
 * @returns {object} Toolkit with openapi, validation, error_handling, framework_refs, workflow
 */
function assembleApiToolkit(config) {
  const cloud = (config.detected && config.detected.cloud) || '';
  const framework = (config.detected && config.detected.framework) || '';

  let router = 'express';
  if (cloud === 'cloudflare') router = 'hono';
  else if (framework === 'fastify') router = 'fastify';

  return {
    openapi: OPENAPI_PATTERNS,
    validation: VALIDATION_RULES,
    error_handling: ERROR_SCHEMA,
    framework_refs: {
      router,
      patterns: ROUTER_PATTERNS[router] || ROUTER_PATTERNS.express,
    },
    workflow: API_WORKFLOW,
  };
}

module.exports = { assembleApiToolkit, VALIDATION_RULES, ERROR_SCHEMA, OPENAPI_PATTERNS, ROUTER_PATTERNS };
