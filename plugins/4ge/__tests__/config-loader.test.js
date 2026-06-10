import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const fs = cjsRequire('fs');
const { loadConfig, detectRepoProfile, REPO_PROFILES } = cjsRequire('../lib/config-loader.cjs');

describe('config-loader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectRepoProfile', () => {
    it('detects example-monorepo when 3+ signals match AND marker file present', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return s.includes('lib/os/kernel') || s.includes('lib\\os\\kernel') ||
               s.includes('plugins/4ge') || s.includes('plugins\\4ge') ||
               s.includes('scripts/autoresearch') || s.includes('scripts\\autoresearch') ||
               (s.includes('.tier3-profile'));
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (String(p).includes('.tier3-profile')) return 'example-monorepo';
        return '';
      });
      const profile = detectRepoProfile('/fake/example-monorepo');
      expect(profile).toBe('example-monorepo');
    });

    it('returns generic when only 2 monorepo signals match (min_matches is 3)', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return s.includes('lib/os/kernel') || s.includes('lib\\os\\kernel') ||
               s.includes('plugins/4ge') || s.includes('plugins\\4ge') ||
               (s.includes('.tier3-profile'));
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => 'example-monorepo');
      const profile = detectRepoProfile('/fake/example-monorepo');
      expect(profile).toBe('generic');
    });

    it('detects example-webapp when 2+ signals match AND marker present', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return s.includes('packages/core') || s.includes('packages\\core') ||
               s.includes('packages/widget-sdk') || s.includes('packages\\widget-sdk') ||
               (s.includes('.tier3-profile'));
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (String(p).includes('.tier3-profile')) return 'example-webapp';
        return '';
      });
      const profile = detectRepoProfile('/fake/example-webapp');
      expect(profile).toBe('example-webapp');
    });

    it('detects example-api when 2+ signals match AND marker present', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return s.includes('packages/api') || s.includes('packages\\api') ||
               s.includes('apps/service') || s.includes('apps\\service') ||
               (s.includes('.tier3-profile'));
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (String(p).includes('.tier3-profile')) return 'example-api';
        return '';
      });
      const profile = detectRepoProfile('/fake/example-api');
      expect(profile).toBe('example-api');
    });

    it('returns generic when directory signals match but marker file is absent', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return (s.includes('lib/os/kernel') || s.includes('lib\\os\\kernel') ||
                s.includes('plugins/4ge') || s.includes('plugins\\4ge') ||
                s.includes('scripts/autoresearch') || s.includes('scripts\\autoresearch')) &&
               !s.includes('.tier3-profile');
      });
      const profile = detectRepoProfile('/fake/example-monorepo');
      expect(profile).toBe('generic');
    });

    it('returns generic when marker file present but profile name mismatches directory signals', () => {
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return s.includes('packages/core') || s.includes('packages\\core') ||
               s.includes('packages/widget-sdk') || s.includes('packages\\widget-sdk') ||
               s.includes('.tier3-profile');
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (String(p).includes('.tier3-profile')) return 'example-api';
        return '';
      });
      const profile = detectRepoProfile('/fake/example-webapp');
      expect(profile).toBe('generic');
    });

    it('returns generic for unknown repos', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const profile = detectRepoProfile('/fake/unknown');
      expect(profile).toBe('generic');
    });
  });

  describe('loadConfig', () => {
    it('loads .4ge/config.json when it exists', () => {
      const mockConfig = { version: '2.1.0', tier: 'full', profile: 'example-monorepo', hooks: {}, agents: {}, agent_routing: {} };
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(mockConfig));
      const result = loadConfig('/fake/project');
      expect(result.config.version).toBe('2.1.0');
      expect(result.loaded).toBe(true);
    });

    it('returns null config when file missing', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const result = loadConfig('/fake/project');
      expect(result.loaded).toBe(false);
      expect(result.config).toBeNull();
    });

    it('returns error on malformed JSON', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('{ broken json');
      const result = loadConfig('/fake/project');
      expect(result.loaded).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('REPO_PROFILES', () => {
    it('has all three repo profiles defined', () => {
      expect(REPO_PROFILES).toHaveProperty('example-monorepo');
      expect(REPO_PROFILES).toHaveProperty('example-webapp');
      expect(REPO_PROFILES).toHaveProperty('example-api');
    });

    it('example-monorepo has min_matches of 3', () => {
      expect(REPO_PROFILES['example-monorepo'].min_matches).toBe(3);
    });

    it('example-webapp and example-api have min_matches of 2', () => {
      expect(REPO_PROFILES['example-webapp'].min_matches).toBe(2);
      expect(REPO_PROFILES['example-api'].min_matches).toBe(2);
    });

    it('each profile has description and signals array', () => {
      for (const profile of Object.values(REPO_PROFILES)) {
        expect(profile.description).toBeDefined();
        expect(profile.signals.length).toBeGreaterThan(0);
      }
    });
  });
});
