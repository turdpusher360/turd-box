import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const _require = createRequire(import.meta.url);
const {
  buildProjectSlug,
  findProjectDir,
  findTranscriptPath,
  parseTranscript,
  loadTranscriptActivity,
  shortInput,
  stripAnsiControl,
} = _require('../hud-transcript-source.cjs');

// Hidden-channel building blocks (built from codepoints, not literal invisible
// bytes in source — same discipline the sanitizer module uses).
const CMB_C = String.fromCodePoint(0x0368); // combining Latin small letter c (palimpsest overlay)
const ZWJ = String.fromCodePoint(0x200D);   // zero-width joiner
const TAG_A = String.fromCodePoint(0xE0041); // Plane-14 Tag "A" (ASCII smuggling)
const RLO = String.fromCodePoint(0x202E);   // right-to-left override (Trojan Source)
const ESC = String.fromCharCode(0x1b);

describe('buildProjectSlug', () => {
  it('replaces backslashes and colons with dashes', () => {
    expect(buildProjectSlug('O:\\Example_Workspace')).toBe('O--Example-Workspace');
  });

  it('replaces forward slashes with dashes', () => {
    expect(buildProjectSlug('/home/user/project')).toBe('-home-user-project');
  });

  it('preserves alphanumeric characters', () => {
    expect(buildProjectSlug('MyProject123')).toBe('MyProject123');
  });

  it('replaces spaces and underscores', () => {
    expect(buildProjectSlug('My Project_Name')).toBe('My-Project-Name');
  });

  it('handles empty string', () => {
    expect(buildProjectSlug('')).toBe('');
  });
});

describe('shortInput', () => {
  it('returns truncated string for long input', () => {
    const long = 'a'.repeat(200);
    const result = shortInput(long, 'Write');
    expect(result.length).toBeLessThan(200);
  });

  it('returns string for short input', () => {
    const result = shortInput('hello', 'Bash');
    expect(typeof result).toBe('string');
  });

  it('handles null/undefined gracefully', () => {
    const result = shortInput(null, 'Read');
    expect(typeof result).toBe('string');
  });
});

describe('stripAnsiControl', () => {
  it('removes a full ANSI CSI (SGR) sequence, keeping the visible text', () => {
    const out = stripAnsiControl(ESC + '[38;5;196m' + 'red' + ESC + '[0m');
    expect(out).toBe('red');
  });

  it('leaves no visible parameter tail (ESC + params stripped as one unit)', () => {
    const out = stripAnsiControl(ESC + '[1;31mX');
    expect(out).toBe('X');
    expect(out).not.toContain('[38');
    expect(out).not.toContain('[1;31m');
  });

  it('removes an OSC hyperlink sequence', () => {
    const bel = String.fromCharCode(0x07);
    const out = stripAnsiControl(ESC + ']8;;http://evil' + bel + 'click' + ESC + ']8;;' + bel);
    expect(out).toBe('click');
  });

  it('removes bare C0 control chars but preserves tab and newline', () => {
    const out = stripAnsiControl('a' + String.fromCharCode(0x07) + 'b\tc\nd');
    expect(out).toBe('ab\tc\nd');
  });

  it('is a no-op on clean ASCII', () => {
    expect(stripAnsiControl('npm run build')).toBe('npm run build');
  });
});

describe('shortInput — hidden-channel + ANSI hardening', () => {
  it('strips a combining-mark palimpsest overlay from a Bash command', () => {
    const cmd = 'f' + CMB_C + 'orge --run';
    const out = shortInput({ command: cmd }, 'Bash');
    expect(out).not.toContain(CMB_C);
    expect(out).toContain('forge --run');
  });

  it('strips ANSI + Plane-14 tag smuggling from a Bash command', () => {
    const out = shortInput({ command: ESC + '[31m' + 'ls' + TAG_A + ' -la' }, 'Bash');
    expect(out).not.toContain(TAG_A);
    expect(out).not.toContain(ESC);
    expect(out).toContain('ls -la');
  });

  it('sanitizes BEFORE the 60-char cap (payload cannot occupy the slice)', () => {
    // 58 visible chars + a tag payload; after strip the payload is gone and
    // the visible text survives within the cap.
    const raw = 'a'.repeat(58) + TAG_A + TAG_A;
    const out = shortInput({ command: raw }, 'Bash');
    expect(out).not.toContain(TAG_A);
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it('strips hidden channels from a full file_path (no cap) unchanged otherwise', () => {
    const out = shortInput({ file_path: '/repo/src' + ZWJ + '/app.ts' }, 'Read');
    expect(out).not.toContain(ZWJ);
    expect(out).toBe('/repo/src/app.ts');
  });
});

describe('parseTranscript — activity summaries come out clean', () => {
  function writeTranscript(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-sanitize-'));
    const file = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n'));
    return { dir, file };
  }

  it('scrubs palimpsest, tag, ZWJ, and ANSI from tool_use and tool_result summaries', () => {
    const { dir, file } = writeTranscript([
      {
        type: 'assistant',
        timestamp: '2026-07-03T00:00:00Z',
        message: { content: [
          { type: 'tool_use', id: 't1', name: 'Bash',
            input: { command: 'run' + CMB_C + TAG_A + RLO + ' now' } },
        ] },
      },
      {
        type: 'user',
        timestamp: '2026-07-03T00:00:01Z',
        message: { content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: false,
            content: ESC + '[31m' + 'fetched' + ZWJ + TAG_A + ' body' },
        ] },
      },
    ]);
    try {
      const parsed = parseTranscript(file);
      const use = parsed.events.find((e) => e.kind === 'tool_use');
      const res = parsed.events.find((e) => e.kind === 'tool_result');
      for (const bad of [CMB_C, TAG_A, RLO, ZWJ, ESC]) {
        expect(use.summary).not.toContain(bad);
        expect(res.summary).not.toContain(bad);
      }
      expect(use.summary).toContain('run');
      expect(res.summary).toContain('fetched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findProjectDir', () => {
  it('returns a string or null', () => {
    // This calls the real filesystem — just check the type contract
    const result = findProjectDir(process.cwd());
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('finds a matching project directory under the Claude projects root', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-projects-'));
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    try {
      const cwd = '/tmp/Example_Workspace';
      const projectsRoot = path.join(tempHome, '.claude', 'projects');
      const expected = path.join(projectsRoot, buildProjectSlug(cwd));
      fs.mkdirSync(expected, { recursive: true });

      expect(findProjectDir(cwd)).toBe(expected);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('findTranscriptPath', () => {
  it('returns a string or null', () => {
    const result = findTranscriptPath(process.cwd(), null);
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('falls back to recent transcript for unknown session id', () => {
    // The module falls back to the most recent .jsonl when the specific session isn't found
    const result = findTranscriptPath(process.cwd(), 'nonexistent-session-id-12345');
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('loadTranscriptActivity', () => {
  it('returns null or an activity object', () => {
    const result = loadTranscriptActivity({ cwd: process.cwd() });
    if (result !== null) {
      expect(result).toHaveProperty('source', 'transcript-tail');
      expect(result).toHaveProperty('transcriptPath');
      expect(result).toHaveProperty('toolCallsTotal');
      expect(result).toHaveProperty('recentEvents');
      expect(Array.isArray(result.recentEvents)).toBe(true);
    }
  });

  it('falls back to recent transcript for unknown session', () => {
    // The module falls back to the most recent .jsonl when session ID doesn't match
    const result = loadTranscriptActivity({
      cwd: process.cwd(),
      sessionId: 'fake-session-id-that-does-not-exist',
    });
    // May return activity from the fallback transcript, or null if no transcripts exist
    if (result !== null) {
      expect(result).toHaveProperty('source', 'transcript-tail');
    }
  });

  it('respects tailCount option', () => {
    const result = loadTranscriptActivity({ cwd: process.cwd(), tailCount: 3 });
    if (result !== null) {
      expect(result.recentEvents.length).toBeLessThanOrEqual(3);
    }
  });

  it('returns numeric counts', () => {
    const result = loadTranscriptActivity({ cwd: process.cwd() });
    if (result !== null) {
      expect(typeof result.toolCallsTotal).toBe('number');
      expect(typeof result.toolResultsTotal).toBe('number');
      expect(typeof result.toolErrorsTotal).toBe('number');
      expect(typeof result.textMessagesTotal).toBe('number');
      expect(typeof result.totalLines).toBe('number');
      expect(typeof result.fileSize).toBe('number');
    }
  });
});
