import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

describe('github-client plumbing', () => {
  const packageRoot = new URL('.', import.meta.url);
  const modulePath = fileURLToPath(new URL('./github-client.js', packageRoot));
  const mockPath = fileURLToPath(new URL('./test-mocks/github-client-fetch-mock.mjs', packageRoot));
  const fixtureReportPath = fileURLToPath(new URL('./__fixtures__/dfe-smoke-report.json', packageRoot));
  const fixtureFilesPath = fileURLToPath(new URL('./__fixtures__/pr-files.json', packageRoot));

  const fixtureSha = '0123456789abcdef0123456789abcdef01234567';
  let traceDir;
  let traceFile;

  afterEach(() => {
    if (traceDir) {
      rmSync(traceDir, { recursive: true, force: true });
      traceDir = undefined;
      traceFile = undefined;
    }
  });

  function runClientWithReport(report) {
    traceDir = mkdtempSync(join(tmpdir(), 'dfe-action-smoke-'));
    traceFile = join(traceDir, 'github-client-trace.json');
    const reportPath = join(traceDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    const result = spawnSync(process.execPath, [
      '--import',
      mockPath,
      modulePath,
      reportPath,
    ], {
      env: {
        ...process.env,
        GITHUB_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'acme/widget',
        GITHUB_PR_NUMBER: '123',
        GITHUB_SHA: fixtureSha,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_CLIENT_TRACE_PATH: traceFile,
        GITHUB_CLIENT_PR_FILES_FIXTURE: fixtureFilesPath,
      },
      encoding: 'utf8',
    });

    const trace = JSON.parse(readFileSync(traceFile, 'utf8'));
    const reviewCalls = trace.filter((entry) => entry.url.includes('/reviews'));
    return { result, review: reviewCalls[0] };
  }

  it('uses PR head SHA for review anchoring without calling real GitHub endpoints', () => {
    traceDir = mkdtempSync(join(tmpdir(), 'dfe-action-smoke-'));
    traceFile = join(traceDir, 'github-client-trace.json');

    const result = spawnSync(process.execPath, [
      '--import',
      mockPath,
      modulePath,
      fixtureReportPath,
    ], {
      env: {
        ...process.env,
        GITHUB_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'acme/widget',
        GITHUB_PR_NUMBER: '123',
        GITHUB_SHA: fixtureSha,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_CLIENT_TRACE_PATH: traceFile,
        GITHUB_CLIENT_PR_FILES_FIXTURE: fixtureFilesPath,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const trace = JSON.parse(readFileSync(traceFile, 'utf8'));
    const reviewCalls = trace.filter((entry) => entry.url.includes('/reviews'));
    expect(reviewCalls.length).toBe(1);
    expect(reviewCalls[0].body.commit_id).toBe(fixtureSha);
    expect(reviewCalls[0].body.body).not.toMatch(/\b(SMELLS|FUCKED)\b/);
    expect(reviewCalls[0].body.body).toContain('4ge DFE Review — RISK');
    expect(reviewCalls[0].body.comments).toBeInstanceOf(Array);
    expect(reviewCalls[0].body.comments).toHaveLength(1);
  });

  it('requests changes instead of approving when the overall verdict is BLOCKED', () => {
    const { result, review } = runClientWithReport({
      verdict: 'BLOCKED',
      passes_run: 3,
      stats: { total: 0, critical: 0, high: 0 },
      findings: [],
      pass_errors: [
        { pass: 'P2', error: 'API call failed' },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(review.body.event).toBe('REQUEST_CHANGES');
    expect(review.body.body).toContain('4ge DFE Review — BLOCKED');
    expect(review.body.body).toContain('API call failed');
  });

  it('uses a comment review when fail_on_severity NONE makes the run report-only', () => {
    const { result, review } = runClientWithReport({
      verdict: 'BLOCKED',
      fail_on_severity: 'NONE',
      passes_run: 3,
      stats: { total: 1, critical: 0, high: 1 },
      findings: [
        {
          pass: 'P2',
          severity: 'HIGH',
          title: 'High finding',
          file: 'src/app.js',
          line: 3,
          evidence: 'bad()',
          reality: 'fixture',
          fix: 'fix it',
          confidence: 'TP',
        },
      ],
      pass_errors: [],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(review.body.event).toBe('COMMENT');
    expect(review.body.body).toContain('Report-only mode');
  });
});
