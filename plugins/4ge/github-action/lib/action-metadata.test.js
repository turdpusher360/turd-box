import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('action metadata', () => {
  const actionYml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const passes = readFileSync(new URL('../passes.json', import.meta.url), 'utf8');
  const entrypoint = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8');

  it('passes the pull request head SHA for inline review commit anchoring', () => {
    expect(actionYml).toContain('GITHUB_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
  });

  it('exposes a separate Opus model input defaulting to the current Opus ID', () => {
    expect(actionYml).toContain('opus_model:');
    expect(actionYml).toContain('default: "claude-opus-4-8"');
    expect(actionYml).toContain('DFE_OPUS_MODEL: ${{ inputs.opus_model }}');
    expect(actionYml).toContain('DFE_MODEL: ${{ inputs.model }}');
  });

  it('documents the pinned-stability Opus option without changing the Sonnet default', () => {
    expect(actionYml).toContain('default: "claude-sonnet-5"');
    expect(readme).toContain('`opus_model` | `claude-opus-4-8`');
    expect(readme).toContain('`claude-opus-4-7`');
    expect(readme).toContain('pinned-stability');
  });

  it('uses public verdict vocabulary by default', () => {
    // Dev jargon must never appear in any surface.
    for (const source of [actionYml, readme, passes, entrypoint]) {
      expect(source).toContain('CLEAN');
      expect(source).not.toMatch(/\bSMELLS\b/);
      expect(source).not.toMatch(/\bFUCKED\b/);
    }

    // Public-facing surfaces expose only CLEAN/RISK/BLOCKED. entrypoint.sh is
    // EXEMPT from the ERROR/UNKNOWN ban: its fail-closed logic (f2f04b40) uses
    // ERROR/UNKNOWN as internal "could-not-complete" states mapped to exit 2 —
    // never surfaced as a public verdict.
    for (const source of [actionYml, readme, passes]) {
      expect(source).not.toMatch(/\bUNKNOWN\b/);
      expect(source).not.toMatch(/\bERROR\b/);
    }

    expect(actionYml).toContain('Overall verdict: CLEAN, RISK, or BLOCKED');
    expect(passes).toContain('CLEAN|RISK|BLOCKED');
  });

  it('uses public v0 or staging placeholders instead of nonexistent v1 examples', () => {
    expect(readme).not.toContain('@v1');
    expect(readme).toContain('@v0');
  });

  it('does not publish unsupported benchmark or competitor claims', () => {
    expect(readme).not.toMatch(/CodeRabbit/i);
    expect(readme).not.toMatch(/false positive target/i);
    expect(readme).not.toMatch(/catches what .* misses/i);
    expect(passes).not.toMatch(/\b40-62% vulnerability rate\b/);
    expect(passes).not.toMatch(/False positive target is under 3%/i);
  });

  it('treats BLOCKED as a blocking verdict unless report-only mode is explicit', () => {
    expect(entrypoint).toContain('OVERALL_VERDICT="BLOCKED"');
    expect(entrypoint).toContain('if [ "${FAIL_ON_SEVERITY}" = "NONE" ]; then');
    expect(entrypoint).toContain('elif [ "${OVERALL_VERDICT}" = "BLOCKED" ]; then');
    expect(entrypoint).toContain('pass_errors');
    expect(readme).toContain('Report-only mode sets the GitHub review event to COMMENT');
  });
});
