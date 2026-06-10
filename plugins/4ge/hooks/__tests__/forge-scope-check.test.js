import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// checkScope is a pure function (no I/O). The behavior under test is that it
// resolves RELATIVE teammate scopes ("src/components/**") and ABSOLUTE tool
// file_paths ("/proj/src/components/Foo.tsx") onto the same axis via
// process.cwd(), so we mock cwd to a fixed project root. See ADR-SEC-002.
import { checkScope } from '../forge-scope-check.cjs';

const ROOT = '/proj';

beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(ROOT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function session(teammates) {
  return { teammates };
}

describe('forge-scope-check checkScope — absolute file_path vs relative scope', () => {
  it('REGRESSION (ADR-SEC-002): absolute file_path inside a relative dir scope does NOT warn', () => {
    // Pre-fix this returned a warning because "/proj/src/..." never startsWith "src/".
    const s = session([{ status: 'active', scope: ['src/components/**'] }]);
    expect(checkScope(`${ROOT}/src/components/Button.tsx`, s)).toBeUndefined();
  });

  it('absolute file_path OUTSIDE all scopes warns', () => {
    const s = session([{ status: 'active', scope: ['src/components/**'] }]);
    const warn = checkScope(`${ROOT}/lib/os/kernel/boot.cjs`, s);
    expect(warn).toBeTypeOf('string');
    expect(warn).toContain('outside active teammate scopes');
  });

  it('exact-file scope matches the absolute path and rejects siblings', () => {
    const s = session([{ status: 'active', scope: ['src/App.tsx'] }]);
    expect(checkScope(`${ROOT}/src/App.tsx`, s)).toBeUndefined();
    expect(checkScope(`${ROOT}/src/Other.tsx`, s)).toBeTypeOf('string');
  });

  it('directory boundary is enforced (src/comp does not match src/completely)', () => {
    const s = session([{ status: 'active', scope: ['src/comp/**'] }]);
    expect(checkScope(`${ROOT}/src/completely/x.ts`, s)).toBeTypeOf('string');
    expect(checkScope(`${ROOT}/src/comp/x.ts`, s)).toBeUndefined();
  });

  it('relative file_path is normalized to the same axis', () => {
    const s = session([{ status: 'active', scope: ['src/components/**'] }]);
    expect(checkScope('src/components/Button.tsx', s)).toBeUndefined();
  });

  it('no active teammate with a scope → inert (no warning)', () => {
    expect(checkScope(`${ROOT}/anything.ts`, session([{ status: 'active', scope: [] }]))).toBeUndefined();
    expect(checkScope(`${ROOT}/anything.ts`, session([{ status: 'idle', scope: ['src/**'] }]))).toBeUndefined();
  });

  it('matches when ANY active teammate owns the path (multi-teammate)', () => {
    const s = session([
      { status: 'active', scope: ['src/ui/**'] },
      { status: 'active', scope: ['lib/os/**'] },
    ]);
    expect(checkScope(`${ROOT}/lib/os/kernel/x.cjs`, s)).toBeUndefined();
    expect(checkScope(`${ROOT}/docs/x.md`, s)).toBeTypeOf('string');
  });

  it('guards malformed input without throwing', () => {
    expect(checkScope('', session([{ status: 'active', scope: ['src/**'] }]))).toBeUndefined();
    expect(checkScope(`${ROOT}/x.ts`, null)).toBeUndefined();
    expect(checkScope(`${ROOT}/x.ts`, {})).toBeUndefined();
  });
});
