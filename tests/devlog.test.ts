import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fmtDecimal } from '../admin/src/format.js';

// The dev Control Tower: the lessons register must keep its guards, and the activity log must
// record what happened without recording anything private. Everything it records may reach git.
const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const HOOK = path.join(root, '.claude/hooks/devlog.mjs');
const scratch = mkdtempSync(path.join(tmpdir(), 'devlog-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (name = 'p') => { const d = path.join(scratch, `${name}${dirs++}`); mkdirSync(d, { recursive: true }); return d; };

// Tokens are assembled at run time from obviously fake parts, so no file holds one (lesson L-015).
const fake = (...parts: string[]) => parts.join('');

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

  it('guards a code lesson with a test title, not a comment', () => {
    for (const l of lessons) {
      for (const g of l.guards.filter((x) => x.file.startsWith('tests/'))) {
        const titles = [...read(g.file).matchAll(/\b(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)]
          .map((m) => m[2]!.replace(/\\(.)/g, '$1'));
        expect(titles.some((t) => t.includes(g.text)), `${l.id}: "${g.text}" is not part of a test title in ${g.file}`).toBe(true);
      }
    }
  });
});

describe('secrets in the repository (lesson L-015)', () => {
  it("no tracked file holds a token in a real provider's key format", () => {
    const formats = [
      new RegExp(fake('sk', '_(?:live|test)_', '[A-Za-z0-9]{10,}')),
      new RegExp(fake('xox', '[abprs]-', '[0-9]{6,}-')),
      new RegExp(fake('\\bA', 'C', '[0-9a-f]{32}\\b')),
      new RegExp(fake('gh', 'p_', '[A-Za-z0-9]{30,}')),
      new RegExp(fake('AK', 'IA', '[0-9A-Z]{16}')),
    ];
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter((f) => f && !f.startsWith('node_modules/') && existsSync(path.join(root, f)) && !/\.(png|jpe?g|gif|wav|mp3|ico)$/i.test(f));
    const hits = files.flatMap((f) => formats.filter((re) => re.test(readFileSync(path.join(root, f), 'utf8'))).map((re) => `${f}: ${re.source}`));
    expect(hits).toEqual([]);
  });
});

describe('money in the console (lesson L-004)', () => {
  // A heuristic: it catches the usual ways a decimal string becomes a float on one line.
  it('keeps money out of floating point in the console', () => {
    const money = /usd|myr|credit|balance|amount|rate|margin|cost|price|below/i;
    const offences: string[] = [];
    for (const f of readdirSync(path.join(root, 'admin/src')).filter((n) => /\.tsx?$/.test(n))) {
      read(`admin/src/${f}`).split('\n').forEach((line, i) => {
        for (const call of line.matchAll(/(?:Number(?:\.parse(?:Float|Int))?|parseFloat|parseInt)\(([^)]*)\)/g)) {
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
  const hook = (dir: string, payload: unknown, env: Record<string, string | undefined> = {}) => spawnSync('node', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_REMOTE_SESSION_ID: undefined, ...env },
  });
  const spooled = (dir: string) => {
    const d = path.join(dir, 'devlog/.spool');
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => readFileSync(path.join(d, f), 'utf8')).join('') : '';
  };
  const lines = (dir: string) => spooled(dir).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  it('writes to the spool, which git ignores, so the working tree stays clean', () => {
    const dir = freshDir();
    hook(dir, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { description: 'Run tests' } });
    expect(lines(dir)).toHaveLength(1);
    expect(existsSync(path.join(dir, 'devlog/activity'))).toBe(false);
    expect(read('.gitignore')).toMatch(/^devlog\/\.spool\/$/m);
  });

  it('records a failed command as its exit code only, with no command or error text', () => {
    const dir = freshDir();
    const token = fake('FAKE', '_TOKEN_', 'abcdefghijklmnopqrstuvwxyz');
    hook(dir, {
      hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash',
      tool_input: { command: `curl -H "Authorization: Bearer ${token}" https://x.test`, description: 'Dial +60 12-345 6789' },
      error: `Exit code 7\ncurl: (7) Failed to connect to +60123456789 with key ${token}`,
    });
    expect(lines(dir)[0]).toMatchObject({ event: 'PostToolUseFailure', tool: 'Bash', ok: false, failure: 'exit 7', target: 'Dial [number]' });
    for (const s of [token, 'FAKE', 'curl', '6789', 'Failed to connect']) expect(spooled(dir)).not.toContain(s);
  });

  it('records another tool\'s failure as a category, never its error text', () => {
    const dir = freshDir();
    hook(dir, {
      hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'mcp__Gmail__send_message', tool_input: {},
      error: 'Invalid recipient ali.customer@example.test (Ali bin Abu)',
    });
    expect(lines(dir)[0]).toMatchObject({ failure: 'invalid input' });
    for (const s of ['Ali', 'customer', 'example']) expect(spooled(dir)).not.toContain(s);
  });

  it('scrubs credentials, emails and phone numbers from what it does record', () => {
    const dir = freshDir();
    const shapes = [
      `TWILIO_AUTH_TOKEN=${fake('0123456789', 'abcdef', '0123')}`,
      fake('gh', 'p_abcDEF', '123456789012'),
      fake('xo', 'xb-12345-67890-', 'abcdefABCDEF'),
      `postgres://voicelab:${fake('s3cr3t', 'pass')}@localhost:5432/db`,
      `psql as voicelab:${fake('s3', 'cr3t')}@db`,
      `secret=${fake('hunter2', 'hunter2')}`,
      fake('sk', '-ant-api03-', 'abcdEFGH'),
      fake('1a2b3c4d5e', '6f7g8h9i0j'),
      fake('eyJhbGciOi', '.eyJzdWIi', '.sig'),
      'ops@example.test',
      '5551234', '012/345/6789', '０１２３４５６７８９',
    ];
    const leaks = ['0123456789abcdef', 'abcDEF1', 'abcdefABCDEF', 's3cr3t', 'hunter2', 'abcdEFGH', '1a2b3c', 'eyJ', 'ops@', '5551234', '345', '０１２'];
    for (const s of shapes) hook(dir, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { description: `Use ${s}` } });
    expect(lines(dir)).toHaveLength(shapes.length);
    for (const leak of leaks) expect(spooled(dir), leak).not.toContain(leak);
    hook(dir, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { description: 'Run the billing tests' } });
    expect(lines(dir).at(-1)!.target).toBe('Run the billing tests');
  });

  it('records a file by its scrubbed path in the project, and nothing about files outside it', () => {
    const dir = freshDir();
    hook(dir, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/x.ts'), content: 'SECRET-CONTENT' } });
    hook(dir, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'fixtures/+60123456789.json') } });
    hook(dir, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/root/.config/twilio/auth_token.txt' } });
    expect(lines(dir).map((l) => l.target)).toEqual(['src/x.ts', 'fixtures/[number].json', '(outside project)']);
    expect(spooled(dir)).not.toContain('SECRET-CONTENT');
  });

  it('records the claude.ai session id in a cloud session, and the local id elsewhere', () => {
    const dir = freshDir();
    hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'local-1' }, { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01CloudTest' });
    hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'local-2' });
    expect(lines(dir)).toContainEqual(expect.objectContaining({ session: 'session_01CloudTest', local_session: 'local-1' }));
    const plain = lines(dir).find((l) => l.session === 'local-2');
    expect(plain).toBeDefined();
    expect(plain.local_session).toBeUndefined();
  });

  it('still works when the project path has a space in it', () => {
    const dir = freshDir('with space ');
    expect(hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 's1' }).status).toBe(0);
    expect(lines(dir)).toHaveLength(1);
  });

  it('warns at session start when the branch is behind origin/main', () => {
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' });
    const origin = freshDir('origin');
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
    const clone = path.join(freshDir(), 'clone');
    git(scratch, 'clone', '-q', origin, clone);
    git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two');
    const r = hook(clone, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
    expect(r.stdout).toContain('1 commits behind origin/main');
    expect(lines(clone)[0]).toMatchObject({ event: 'SessionStart', behind_main: 1 });
  });

  it('never blocks the session, whatever it is given', () => {
    const dir = freshDir();
    expect(hook(dir, 'not json').status).toBe(0);
    expect(hook(dir, '').status).toBe(0);
    expect(hook(dir, { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }).stdout).toContain('Dev Control Tower');
  });
});

describe('flushing the log for a commit', () => {
  const runFlush = (dir: string) => {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.claude/hooks'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts/devlog-flush.mjs'), read('scripts/devlog-flush.mjs'));
    writeFileSync(path.join(dir, '.claude/hooks/devlog.mjs'), read('.claude/hooks/devlog.mjs'));
    return spawnSync('node', [path.join(dir, 'scripts/devlog-flush.mjs')], { encoding: 'utf8' });
  };

  it('moves only new lines into new files, rebuilt from known fields with no error text', () => {
    const dir = freshDir();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const spool = path.join(dir, 'devlog/.spool/s1.jsonl');
    const old = { ts: '2026-10-10T00:00:00Z', session: 'session_01X', event: 'PostToolUseFailure', tool: 'Read', target: 'a.ts', ok: false, error: 'Invalid recipient ali@example.test', extra: 'dropped' };
    writeFileSync(spool, JSON.stringify(old) + '\n' + JSON.stringify({ ts: '2026-10-10T00:00:01Z', session: 'session_01X', event: 'Unknown' }) + '\n');
    expect(runFlush(dir).status).toBe(0);
    const out = () => readdirSync(path.join(dir, 'devlog/activity'));
    expect(out()).toHaveLength(1);
    const first = readFileSync(path.join(dir, 'devlog/activity', out()[0]!), 'utf8');
    expect(JSON.parse(first)).toEqual({ ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'PostToolUseFailure', tool: 'Read', target: 'a.ts', ok: false, failure: 'invalid input' });

    expect(runFlush(dir).stdout).toContain('Nothing new');
    writeFileSync(spool, readFileSync(spool, 'utf8') + JSON.stringify({ ts: '2026-10-10T00:00:02Z', session: 'session_01X', event: 'UserPromptSubmit' }) + '\n');
    runFlush(dir);
    expect(out()).toHaveLength(2); // a new file, so two branches never edit the same one
  });
});

describe('dashboard report', () => {
  const report = (args: string[]) => spawnSync('node', [path.join(root, 'scripts/devlog-report.mjs'), ...args], { encoding: 'utf8', cwd: root });

  it('embeds hostile titles as inert text and reads review findings from a PR body', () => {
    const dir = freshDir();
    const title = "Fix price $' bug $& $` </script><script>alert(1)</script>";
    const body = '## Independent review\n\n| # | Severity | Finding | Outcome |\n|---|---|---|---|\n| 1 | High | A race | **Fixed** |\n| 2 | Low | Wording | Left as is |\n';
    writeFileSync(path.join(dir, 'prs.json'), JSON.stringify([{ number: 99, title, state: 'open', html_url: 'javascript:alert(1)', created_at: '2026-10-10T00:00:00Z', merged_at: null, body }]));
    const out = path.join(dir, 'out.html');
    expect(report(['--prs', path.join(dir, 'prs.json'), '--html', out]).status).toBe(0);
    const html = readFileSync(out, 'utf8');
    const template = read('devlog/dashboard.html');
    expect(html.split('</script>').length).toBe(template.split('</script>').length);
    const json = /const REPORT = (.*);\nconst \$/.exec(html)?.[1];
    const data = JSON.parse(json!);
    expect(data.prs[0].title).toBe(title);
    expect(data.prs[0].findings).toEqual([{ severity: 'High', finding: 'A race', fixed: true }, { severity: 'Low', finding: 'Wording', fixed: false }]);
    expect(template).not.toMatch(/href="\$\{esc\(/); // every link goes through safeUrl
  });

  it('refuses to overwrite its own template', () => {
    const before = read('devlog/dashboard.html');
    expect(report(['--html', path.join(root, 'devlog/dashboard.html')]).status).toBe(1);
    expect(read('devlog/dashboard.html')).toBe(before);
  });
});
