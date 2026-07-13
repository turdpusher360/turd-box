import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const VENDOR_ROOT = path.resolve(__dirname, '..', '..', 'vendor');
const OS_LIB = path.join(VENDOR_ROOT, 'lib', 'os');

let tmpDir;
let savedCwd;

beforeAll(() => {
  savedCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-boot-vendored-'));
  fs.mkdirSync(path.join(tmpDir, '_runs', 'os'), { recursive: true });
  // Stranger-project shape: no lib/os, no .claude/agents, no scripts/.
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(savedCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('vendored kernel boot (stranger-project shape)', () => {
  it('boot-sequence runs with no memory hub and empty agents dir', () => {
    const boot = require(path.join(OS_LIB, 'kernel', 'boot-sequence.cjs'));
    const report = boot.run({
      agentsDir: path.join(tmpDir, '.claude', 'agents'),
      stateDir: path.join(tmpDir, '_runs', 'os'),
      memoryHubUrl: null, // plugin default: no hardcoded hub
    });
    expect(report.osEnabled).toBe(true);
    expect(Array.isArray(report.steps)).toBe(true);
    // health:memory must be ok (skipped), not degraded, when no hub is configured.
    const memStep = report.steps.find(s => s.name === 'health:memory');
    expect(memStep && memStep.status).toBe('ok');
  });
});

describe('vendored capability discovery', () => {
  it('discovers every capability shipped in the vendored tree', () => {
    const osApi = require(path.join(OS_LIB, 'index.cjs'));
    const registry = osApi.createCapabilityRegistry(osApi, {
      stateDir: path.join(tmpDir, '_runs', 'os'),
    });
    const result = registry.discover(path.join(OS_LIB, 'capabilities'));
    expect(result.invalid).toEqual([]);
    // Relational, not pinned (S533): the fleet is DESIGNED to grow. The real
    // invariant is discovery == what the vendored tree ships (minus the
    // registry helper itself), with the S404 nine as the floor.
    const shipped = fs.readdirSync(path.join(OS_LIB, 'capabilities'))
      .filter((f) => f.endsWith('.cjs') && f !== 'capability-registry.cjs')
      .map((f) => f.replace(/\.cjs$/, ''))
      .sort();
    expect(result.found.sort()).toEqual(shipped);
    expect(result.found.length).toBeGreaterThanOrEqual(9);
  });
});

describe('vendored sub-boot writes HUD state (safe capability subset)', () => {
  it('boots a capability subset in a temp project and writes boot-status.json', () => {
    // Copy side-effect-light capabilities into an isolated capDir: full
    // 9-cap boot is exercised in the live session, not in unit tests
    // (aisle writes ~/.claude/projects state; infra probes docker).
    const subsetDir = path.join(tmpDir, 'cap-subset');
    fs.mkdirSync(subsetDir, { recursive: true });
    for (const cap of ['forge.cjs', 'forge-session.cjs', 'process-health.cjs']) {
      fs.copyFileSync(
        path.join(OS_LIB, 'capabilities', cap),
        path.join(subsetDir, cap)
      );
    }
    const osApi = require(path.join(OS_LIB, 'index.cjs'));
    const stateDir = path.join(tmpDir, '_runs', 'os');
    const registry = osApi.createCapabilityRegistry(osApi, { stateDir });
    const discovered = registry.discover(subsetDir);
    expect(discovered.invalid).toEqual([]);
    registry.resolveDeps();
    const status = registry.boot();

    expect(status.capabilities).toBeTruthy();
    expect(Object.keys(status.capabilities).sort()).toEqual(
      ['forge', 'forge-session', 'process-health']
    );

    const bootStatusPath = path.join(stateDir, 'boot-status.json');
    expect(fs.existsSync(bootStatusPath)).toBe(true);
    const bootStatus = JSON.parse(fs.readFileSync(bootStatusPath, 'utf8'));
    expect(bootStatus.capabilities).toBeTruthy();
    expect(fs.existsSync(path.join(stateDir, 'health.json'))).toBe(true);
  });
});

describe('plugin boot hook source contract', () => {
  it('os-boot.cjs defers to project-managed OS before reading stdin', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'os-boot.cjs'), 'utf8');
    const guardIdx = src.indexOf("isProjectManaged(cwd, 'os-boot')");
    const stdinIdx = src.indexOf('await readStdinJson()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stdinIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(stdinIdx);
  });

  it('os-boot.cjs has no hardcoded memory hub URL', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'os-boot.cjs'), 'utf8');
    expect(src).not.toContain('localhost:8091');
  });

  it('os-accounting.cjs carries the collision guard', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'os-accounting.cjs'), 'utf8');
    expect(src).toContain("isProjectManaged(process.cwd(), 'os-accounting')");
  });
});
