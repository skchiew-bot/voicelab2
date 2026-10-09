import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fmtDecimal } from '../admin/src/format.js';

// The dev Control Tower: the lessons register must keep its guards, and the activity hook
// must record what happened without recording anything private.
const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

interface Lesson { id: string; title: string; body: string; guards: { file: string; text: string }[] }

function parseLessons(md: string): Lesson[] {
  return md.split(/^### /m).slice(1).map((chunk) => {
    const [heading = '', ...rest] = chunk.split('\n');
    const m = /^(L-\d{3}): (.+)$/.exec(heading.trim());
    const body = rest.join('\n');
    const guards = [...body.matchAll(/^\s+- `([^`]+)` › "([^"]+)"\s*$/gm)].map((g) => ({ file: g[1]!, text: g[2]! }));
    return { id: m?.[1] ?? `bad heading: ${heading}`, title: m?.[2] ?? '', body, guards };
  });
}

describe('lessons register', () => {
  const lessons = parseLessons(read('devlog/lessons.md'));

  it('is loaded by every session through CLAUDE.md', () => {
    expect(read('CLAUDE.md')).toMatch(/^@devlog\/lessons\.md$/m);
  });

  it('numbers its lessons in order, each with a rule, where it was seen and at least one guard', () => {
    expect(lessons.length).toBeGreaterThan(0);
    lessons.forEach((l, i) => {
      expect(l.id).toBe(`L-${String(i + 1).padStart(3, '0')}`);
      expect(l.body, l.id).toMatch(/^- \*\*Seen:\*\* \S/m);
      expect(l.body, l.id).toMatch(/^- \*\*Rule:\*\* \S/m);
      expect(l.guards.length, `${l.id} has no guard`).toBeGreaterThan(0);
    });
  });

  it('keeps every guard in place: each named file exists and still contains the text', () => {
    for (const l of lessons) {
      for (const g of l.guards) {
        expect(existsSync(path.join(root, g.file)), `${l.id}: ${g.file} is missing`).toBe(true);
        // Test titles are written with escaped quotes in the source (plan\'s), so compare unescaped.
        const text = read(g.file).replace(/\\'/g, "'");
        expect(text.includes(g.text), `${l.id}: "${g.text}" is no longer in ${g.file}`).toBe(true);
      }
    }
  });
});

describe('money in the console (lesson L-004)', () => {
  it('keeps money out of floating point in the console', () => {
    const money = /usd|myr|credit|balance|amount|rate|margin|cost|price|below/i;
    const offences: string[] = [];
    for (const f of readdirSync(path.join(root, 'admin/src')).filter((n) => /\.tsx?$/.test(n))) {
      read(`admin/src/${f}`).split('\n').forEach((line, i) => {
        for (const call of line.matchAll(/(?:Number|parseFloat)\(([^)]*)\)/g)) {
          if (money.test(call[1]!)) offences.push(`admin/src/${f}:${i + 1}: ${call[0]}`);
        }
        if (/toLocaleString\(\)/.test(line) && /Number\(/.test(line)) offences.push(`admin/src/${f}:${i + 1}: Number(…).toLocaleString()`);
      });
    }
    expect(offences).toEqual([]);
  });

  it('formats decimals from their text, exactly', () => {
    expect(fmtDecimal('1000.0000')).toBe('1,000');
    expect(fmtDecimal('12345678901234567.12345678')).toBe('12,345,678,901,234,567.12345678');
    expect(fmtDecimal('-0.01540000')).toBe('-0.0154');
    expect(fmtDecimal('-0.00')).toBe('0');
    expect(fmtDecimal('0.10000000')).toBe('0.1');
    expect(fmtDecimal('007')).toBe('7');
    expect(fmtDecimal('not a number')).toBe('not a number');
  });
});

describe('activity hook', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'devlog-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const hook = (input: string) => spawnSync('node', [path.join(root, '.claude/hooks/devlog.mjs')], {
    input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  const logged = () => readdirSync(path.join(dir, 'devlog/activity'))
    .map((f) => readFileSync(path.join(dir, 'devlog/activity', f), 'utf8')).join('');

  it('records a failed command with its exit code, but no number, token or command text', () => {
    // Built at run time so it matches no real provider's key format.
    const token = ['FAKE', 'TOKEN', 'abcdefghijklmnopqrstuvwxyz'].join('_');
    const r = hook(JSON.stringify({
      hook_event_name: 'PostToolUseFailure', session_id: 'session_abc', tool_name: 'Bash',
      tool_input: { command: `curl -H "Authorization: Bearer ${token}" https://x.test`, description: 'Dial +60 12-345 6789' },
      error: `Exit code 7\ncurl: (7) Failed to connect to +60123456789 with key ${token}`,
    }));
    expect(r.status).toBe(0);
    const line = JSON.parse(logged().trim().split('\n').at(-1)!);
    expect(line).toMatchObject({ event: 'PostToolUseFailure', tool: 'Bash', ok: false, exit: 7, target: 'Dial [number]' });
    const all = logged();
    for (const secret of [token, 'FAKE_TOKEN', 'curl -H', '6789', '60123456789']) expect(all).not.toContain(secret);
  });

  it('records an edit by its path relative to the project only', () => {
    hook(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session_abc', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/x.ts'), content: 'SECRET-CONTENT' } }));
    expect(logged()).toContain('"target":"src/x.ts"');
    expect(logged()).not.toContain('SECRET-CONTENT');
  });

  it('never blocks the session, whatever it is given', () => {
    expect(hook('not json').status).toBe(0);
    expect(hook('').status).toBe(0);
    expect(hook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' })).stdout).toContain('Dev Control Tower');
  });
});
