import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EJECT_CLI = path.resolve(__dirname, '..', 'eject-cli.cjs');
const ADOPT_CLI = path.resolve(__dirname, '..', 'adopt-cli.cjs');

describe('eject-cli', () => {
  it('exits 1 with usage when no args', () => {
    try {
      execFileSync('node', [EJECT_CLI], { encoding: 'utf8' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stderr).toMatch(/usage/i);
    }
  });

  it('exits 1 for path traversal name', () => {
    try {
      execFileSync('node', [EJECT_CLI, 'hook', '../../etc/passwd'], { encoding: 'utf8' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      const output = JSON.parse(err.stdout);
      expect(output.ok).toBe(false);
      expect(output.message).toMatch(/invalid/i);
    }
  });

  it('exits 1 for protected hook', () => {
    try {
      execFileSync('node', [EJECT_CLI, 'hook', 'guard-git-scope'], { encoding: 'utf8' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      const output = JSON.parse(err.stdout);
      expect(output.ok).toBe(false);
      expect(output.message).toMatch(/protected/i);
    }
  });

  it('exits 1 for unknown component type', () => {
    try {
      execFileSync('node', [EJECT_CLI, 'agent', 'some-agent'], { encoding: 'utf8' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      const output = JSON.parse(err.stdout);
      expect(output.ok).toBe(false);
      expect(output.message).toMatch(/unknown/i);
    }
  });
});

describe('adopt-cli', () => {
  it('exits 1 with usage when no args', () => {
    try {
      execFileSync('node', [ADOPT_CLI], { encoding: 'utf8' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stderr).toMatch(/usage/i);
    }
  });

  it('exits 1 for non-ejected component', () => {
    try {
      execFileSync('node', [ADOPT_CLI, 'hook', 'nonexistent'], { encoding: 'utf8' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      const output = JSON.parse(err.stdout);
      expect(output.ok).toBe(false);
    }
  });

  it('exits 1 with usage when only one arg supplied', () => {
    try {
      execFileSync('node', [ADOPT_CLI, 'hook'], { encoding: 'utf8' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stderr).toMatch(/usage/i);
    }
  });
});
