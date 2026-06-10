import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAttributionMap, formatAttribution } = require('../lib/causal-map.cjs');

describe('causal-map', () => {
  const session = {
    teammates: [
      { name: 'impl-1', scope: ['src/components/', 'src/hooks/'] },
      { name: 'impl-2', scope: ['lib/os/', 'lib/__tests__/'] },
      { name: 'reviewer', scope: [] },
    ],
  };

  it('attributes files to teammates by scope', () => {
    const changes = ['src/components/Button.tsx', 'lib/os/kernel.cjs', 'README.md'];
    const map = buildAttributionMap(session, changes);
    expect(map['impl-1']).toContain('src/components/Button.tsx');
    expect(map['impl-2']).toContain('lib/os/kernel.cjs');
  });

  it('puts unscoped files in unattributed bucket', () => {
    const changes = ['README.md', 'package.json'];
    const map = buildAttributionMap(session, changes);
    expect(map['unattributed']).toContain('README.md');
    expect(map['unattributed']).toContain('package.json');
  });

  it('handles empty changes list', () => {
    const map = buildAttributionMap(session, []);
    expect(Object.keys(map)).toEqual([]);
  });

  it('handles session with no teammates', () => {
    const map = buildAttributionMap({ teammates: [] }, ['file.ts']);
    expect(map['unattributed']).toContain('file.ts');
  });

  it('formats attribution as human-readable text', () => {
    const changes = ['src/components/Button.tsx', 'lib/os/kernel.cjs'];
    const map = buildAttributionMap(session, changes);
    const text = formatAttribution(map);
    expect(text).toContain('impl-1');
    expect(text).toContain('impl-2');
  });
});
