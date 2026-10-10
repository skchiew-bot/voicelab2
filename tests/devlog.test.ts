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

// ---------------------------------------------------------------------------------------------
// The d3ngineering-style Control Tower: usage and cost, stop-loss, the board, incidents, report.

/** A throwaway copy of the tooling in its own git repository, so reports run on known data. */
function makeRepo(config?: (c: Record<string, any>) => void) {
  const dir = freshDir('repo');
  for (const f of ['.claude/hooks/devlog.mjs', 'scripts/devlog-flush.mjs', 'scripts/devlog-report.mjs', 'scripts/devlog-task.mjs', 'devlog/lessons.md', 'devlog/dashboard.html']) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), read(f));
  }
  const cfg = JSON.parse(read('devlog/control-tower.json'));
  config?.(cfg);
  writeFileSync(path.join(dir, 'devlog/control-tower.json'), JSON.stringify(cfg));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  return { dir, git };
}
const run = (dir: string, script: string, args: string[], input?: string, env: Record<string, string | undefined> = {}) =>
  spawnSync('node', [path.join(dir, script), ...args], {
    input, encoding: 'utf8', cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_REMOTE_SESSION_ID: undefined, CLAUDE_CODE_SESSION_ID: 'cli-test', ...env },
  });
const spoolLines = (dir: string) => {
  const d = path.join(dir, 'devlog/.spool');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(path.join(d, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [];
};

/** A transcript in Claude Code's real shape: one line per content block, the same message id and usage on each. */
type Entry = { id: string; model: string; ts: string; usage: Record<string, unknown>; blocks?: number } | { checkpoint: number; models: Record<string, number> };
function transcript(dir: string, entries: Entry[], sub?: Entry[], opts: { folder?: string } = {}) {
  const lines = (list: Entry[]) => list.flatMap((e) => ('checkpoint' in e
    ? [JSON.stringify({ type: 'cost-state', totalCostUSD: e.checkpoint, modelUsage: Object.fromEntries(Object.entries(e.models).map(([m, c]) => [m, { inputTokens: 1, outputTokens: 1, costUSD: c }])) })]
    : Array.from({ length: e.blocks ?? 2 }, () => JSON.stringify({ type: 'assistant', timestamp: e.ts, requestId: `req_${e.id}`, message: { id: e.id, model: e.model, usage: e.usage } })))).join('\n') + '\n';
  // Claude Code's layout: <projects>/<project folder>/<session id>.jsonl, subagents beside it.
  const name = `t${dirs++}`;
  const folder = path.join(dir, 'projects', opts.folder ?? '-repo');
  mkdirSync(folder, { recursive: true });
  const tp = path.join(folder, `${name}.jsonl`);
  writeFileSync(tp, lines(entries));
  if (sub) { mkdirSync(path.join(folder, name, 'subagents'), { recursive: true }); writeFileSync(path.join(folder, name, 'subagents/agent-x.jsonl'), lines(sub)); }
  return tp;
}
const U = (input: number, output: number, read = 0, w5 = 0, w1 = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w5 + w1, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 } });

describe('usage and cost', () => {
  it('counts each message once, prices tokens exactly, and adds them to Claude Code\'s own checkpoint', () => {
    const { dir } = makeRepo();
    const tp = transcript(dir, [
      { id: 'm1', model: 'claude-opus-5-5', ts: '2026-10-10T00:00:00Z', usage: U(100, 1000), blocks: 4 },
      { checkpoint: 1.5, models: { 'claude-opus-5-5': 1.5 } },
      { id: 'm2', model: 'claude-opus-5-5', ts: '2026-10-10T00:05:00Z', usage: U(0, 1_000_000, 1_000_000, 1_000_000, 1_000_000) },
    ], [{ id: 's1', model: 'claude-haiku-5-5', ts: '2026-10-10T00:06:00Z', usage: U(1_000_000, 0) }]);
    expect(run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: tp })).status).toBe(0);
    const u = spoolLines(dir).find((l) => l.event === 'Usage');
    expect(u.tokens['claude-opus-5-5']).toMatchObject({ messages: 2, input: 100, output: 1_001_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 });
    expect(u.tokens['claude-haiku-5-5']).toMatchObject({ messages: 1, input: 1_000_000 });
    // After the checkpoint: Opus 1M output $20 + 1M cache read $0.20 + 1M 5m write $5 + 1M 1h write $8; Haiku 1M input $0.10.
    expect(u.costBasis).toBe('checkpoint+since');
    expect(u.costUSD).toBe('34.80000000'); // 1.5 + 33.20 + 0.10
    expect(u.checkpoint.costUSD).toBe('1.500000');
  });

  it('counts a session resumed in another folder once: copied messages once, the largest checkpoint, then what came after', () => {
    const { dir } = makeRepo();
    const first: Entry[] = [
      { id: 'm1', model: 'claude-opus-5-5', ts: '2026-10-10T00:00:00Z', usage: U(0, 1_000_000) },
      { checkpoint: 30, models: { 'claude-opus-5-5': 30 } },
    ];
    const a = transcript(dir, first, undefined, { folder: '-repo' });
    // The resumed transcript has the same name in another folder, copies m1, and has no checkpoint.
    const b = path.join(path.dirname(path.dirname(a)), '-home', path.basename(a));
    mkdirSync(path.dirname(b), { recursive: true });
    // Its own later checkpoint restarted from a smaller figure: the larger, earlier one is used.
    writeFileSync(b, readFileSync(a, 'utf8').split('\n').filter((l) => !l.includes('cost-state')).join('\n')
      + JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T00:30:00Z', message: { id: 'm0', model: 'claude-opus-5-5', usage: U(0, 0) } }) + '\n'
      + JSON.stringify({ type: 'cost-state', totalCostUSD: 2, modelUsage: {} }) + '\n'
      + JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T01:00:00Z', message: { id: 'm2', model: 'claude-opus-5-5', usage: U(0, 1_000_000) } }) + '\n');
    // The same answer whichever transcript the hook is given, so file order cannot decide it.
    for (const tp of [b, a]) run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: tp }));
    const usages = spoolLines(dir).filter((l) => l.event === 'Usage');
    expect(usages).toHaveLength(2);
    for (const u of usages) {
      expect(u.tokens['claude-opus-5-5'].messages).toBe(3);
      expect(u.costUSD).toBe('50.00000000'); // $30 checkpoint + m2's 1M output at $20; m1 is inside the checkpoint
    }
  });

  it('prices the whole transcript when there is no checkpoint yet, and says so, and never guesses a price', () => {
    const { dir } = makeRepo();
    const tp = transcript(dir, [
      { id: 'a', model: 'claude-sonnet-5-5', ts: '2026-10-10T00:00:00Z', usage: U(1_000_000, 100_000) },
      { id: 'b', model: 'claude-unknown-9', ts: '2026-10-10T00:01:00Z', usage: U(1_000_000, 0) },
    ]);
    run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: tp }));
    const u = spoolLines(dir).find((l) => l.event === 'Usage');
    expect(u).toMatchObject({ costBasis: 'transcript-only', costUSD: '3.00000000', unpriced: ['claude-unknown-9'] }); // $2 + $1
    // A malformed price is reported as missing, never guessed, and the record is still written.
    const { dir: d2 } = makeRepo((c) => { c.pricing.perMTokUSD['claude-sonnet-5-5'].input = '2e0'; });
    run(d2, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: transcript(d2, [{ id: 'a', model: 'claude-sonnet-5-5', ts: '2026-10-10T00:00:00Z', usage: U(1, 1) }]) }));
    expect(spoolLines(d2).find((l) => l.event === 'Usage')).toMatchObject({ costUSD: '0.00000000', unpriced: ['claude-sonnet-5-5'] });
    expect(u.tokens['claude-unknown-9'].costUSD).toBeUndefined();
  });

  it('records the kind of command, never the command itself', () => {
    const { dir } = makeRepo();
    run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npx vitest run tests/secret-name.test.ts', description: 'Run tests' } }));
    expect(spoolLines(dir)[0]).toMatchObject({ kind: 'test', target: 'Run tests' });
    expect(JSON.stringify(spoolLines(dir))).not.toContain('secret-name');
  });
});

describe('stop-loss and wasted effort', () => {
  const fail = (dir: string, description = 'Run tests', command = 'npm test') => run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({
    hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command, description }, error: 'Exit code 1',
  }));

  it('tells Claude to stop repeating after the budgeted failed test runs in a row, once', () => {
    const { dir } = makeRepo((c) => { c.stopLoss.maxSameCommandFailures = 99; });
    for (let i = 1; i < 5; i++) expect(fail(dir, `Run tests ${i}`, `npx vitest run t${i}`).status).toBe(0);
    const fifth = fail(dir, 'Run tests 5', 'npx vitest run t5');
    expect(fifth.status).toBe(2); // shown to Claude; the tool already ran
    expect(fifth.stderr).toContain('STOP-LOSS TRIGGERED');
    expect(fifth.stderr).toContain('5 test runs in a row have failed');
    fail(dir, 'Run tests 6', 'npx vitest run t6');
    expect(spoolLines(dir).filter((l) => l.event === 'Alert' && l.rule === 'failed-test-runs')).toHaveLength(1);
  });

  it('does not count test runs expected to fail, or commands that only mention a test runner', () => {
    const { dir } = makeRepo();
    for (let i = 0; i < 6; i++) expect(fail(dir, `Prove the test can fail ${i}`, `DEVLOG_EXPECT_RED=1 npx vitest run t${i}`).status).toBe(0);
    for (let i = 0; i < 6; i++) expect(fail(dir, `Search ${i}`, `grep -rn vitest src/f${i}`).status).toBe(0);
    for (let i = 0; i < 4; i++) expect(fail(dir, `Real failure ${i}`, `npx vitest run r${i}`).status).toBe(0); // 4 real, under the budget of 5
    expect(spoolLines(dir).filter((l) => l.event === 'Alert')).toEqual([]);
  });

  it('counts the same command failing, not different commands that share a description', () => {
    const { dir } = makeRepo();
    for (const c of ['ls nope', 'grep -q x y', 'false', 'test -f z']) expect(fail(dir, 'shell command', c).status).toBe(0);
    expect(fail(dir, 'Check a file', 'cat missing').status).toBe(0);
    expect(fail(dir, 'Check a file', 'cat missing').status).toBe(0);
    const third = fail(dir, 'Check a file', 'cat missing');
    expect(third.status).toBe(2);
    expect(third.stderr).toContain('has failed 3 times in a row');
  });

  it('a passing run resets the streak', () => {
    const { dir } = makeRepo((c) => { c.stopLoss.maxSameCommandFailures = 99; });
    for (let i = 0; i < 4; i++) fail(dir, `r${i}`, `npx vitest run a${i}`);
    run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'c' } }));
    expect(fail(dir, 'd', 'npx vitest run b').status).toBe(0);
  });

  it('counts only successful edits since the last passing check', () => {
    const { dir } = makeRepo((c) => { c.stopLoss.maxEditsToOneFile = 3; });
    const edit = (ok = true) => run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', session_id: 's', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') }, error: 'String not found' }));
    edit(); edit(false); edit(false); edit();
    run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm run -s typecheck', description: 'Typecheck' } }));
    expect(edit().status).toBe(0);
    expect(edit().status).toBe(0);
    expect(edit().stderr).toContain('edited 3 times with no passing test or typecheck run');
  });

  it('warns about reading one file again and again without changing it, but not about reading it in chunks', () => {
    const { dir } = makeRepo();
    const readFile = (offset?: number) => run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/a.ts'), offset, limit: offset ? 2000 : undefined } }));
    for (const offset of [1, 2001, 4001, 6001, 8001]) expect(readFile(offset).status).toBe(0);
    for (let i = 0; i < 3; i++) expect(readFile().status).toBe(0);
    const fourth = readFile();
    expect(fourth.status).toBe(2);
    expect(fourth.stderr).toContain('WASTED EFFORT');
  });

  it('tells the owner when a session goes over its cost budget, comparing amounts exactly', () => {
    const { dir } = makeRepo((c) => { c.stopLoss.maxSessionCostUSD = '1.00000001'; });
    const at = (cost: number) => transcript(dir, [{ id: `x${cost}`, model: 'claude-opus-5-5', ts: '2026-10-10T00:00:00Z', usage: U(cost, 0) }], undefined, { folder: `f${cost}` });
    expect(run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: at(250_000) })).stdout).toBe(''); // exactly $1.00
    const over = run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: at(250_001) }));
    expect(JSON.parse(over.stdout).systemMessage).toContain('STOP-LOSS'); // the owner sees it now
    const next = run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's' }));
    expect(next.stdout).toContain('STOP-LOSS'); // and Claude at the next prompt, once
    expect(run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's' })).stdout).not.toContain('STOP-LOSS');
  });
});

describe('control board and incident register', () => {
  it('records task events and incidents, scrubbed, and refuses bad input', () => {
    const { dir } = makeRepo();
    expect(run(dir, 'scripts/devlog-task.mjs', ['start', 'T-1', '--title', 'Build the board', '--phase', 'build']).status).toBe(0);
    expect(run(dir, 'scripts/devlog-task.mjs', ['update', 'T-1', '--progress', '60', '--blocker', 'Waiting on ops@example.test']).status).toBe(0);
    expect(run(dir, 'scripts/devlog-task.mjs', ['incident', '--type', 'process', '--title', 'Stale branch', '--lesson', 'L-013']).stdout).toMatch(/Recorded INC-\d{8}-[0-9a-f]{4}\./);
    for (const bad of [['update', 'T-1', '--status', 'finished'], ['update', 'T-1', '--progress', '101'], ['start', 'bad id', '--title', 'x'], ['incident', '--title', 'x', '--lesson', 'L13'], ['update', 'T-1', '--colour', 'red']]) {
      expect(run(dir, 'scripts/devlog-task.mjs', bad).status, bad.join(' ')).toBe(1);
    }
    const events = spoolLines(dir);
    expect(events.filter((e) => e.event === 'Task')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('ops@example');
  });

  it('calls a stop when a task goes over its attempt budget', () => {
    const { dir } = makeRepo();
    run(dir, 'scripts/devlog-task.mjs', ['start', 'T-2', '--title', 'Flaky fix']);
    const r = run(dir, 'scripts/devlog-task.mjs', ['update', 'T-2', '--attempt', '4']);
    expect(r.stdout).toContain('STOP-LOSS TRIGGERED');
    run(dir, 'scripts/devlog-task.mjs', ['update', 'T-2', '--attempt', '4', '--next', 'Try another way']);
    expect(spoolLines(dir).filter((e) => e.event === 'Alert' && e.rule === 'task-attempts')).toEqual([expect.objectContaining({ key: 'T-2#4' })]);
  });

  it('keeps only known fields of board, incident, usage and alert events when flushing', () => {
    const { dir } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const lines = [
      { ts: '2026-10-10T00:00:00Z', session: 's', event: 'Task', action: 'start', id: 'T-1', title: 'A', status: 'in_progress', secret: 'x' },
      { ts: '2026-10-10T00:00:01Z', session: 's', event: 'Incident', id: 'INC-20261010-abcd', type: 'process', title: 'B', lesson: 'L-001', note: 'dropped' },
      { ts: '2026-10-10T00:00:02Z', session: 's', event: 'Incident', id: 'not-an-id', title: 'C' },
      { ts: '2026-10-10T00:00:03Z', session: 's', event: 'Usage', costUSD: '1.00000000', tokens: { 'claude-opus-5-5': { input: 1, prompt: 'leak' } }, raw: 'leak' },
      { ts: '2026-10-10T00:00:04Z', session: 's', event: 'Alert', kind: 'stop-loss', rule: 'failed-test-runs', key: '2026-10-10T00:00:01.000Z', message: 'leak' },
      { ts: '2026-10-10T00:00:05Z', session: 's', event: 'SessionStart', branch: 'fix/call-0412345678-refund' },
      { ts: '2026-10-10T00:00:06Z', session: 's', event: 'SessionStart', branch: 'claude/dev-control-tower-v2' },
      { ts: '2026-10-10T00:00:07Z', session: 's', event: 'PostToolUse', tool: 'Bash', target: 'x', cmd: 'abcdef0123456789', range: '1:2', ms: -5 },
    ];
    writeFileSync(path.join(dir, 'devlog/.spool/s.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(run(dir, 'scripts/devlog-flush.mjs', []).status).toBe(0);
    const out = readdirSync(path.join(dir, 'devlog/activity')).map((f) => readFileSync(path.join(dir, 'devlog/activity', f), 'utf8')).join('');
    const parsed = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.event)).toEqual(['Task', 'Incident', 'Usage', 'Alert', 'SessionStart', 'SessionStart', 'PostToolUse']);
    expect(out).not.toMatch(/secret|dropped|leak|not-an-id|0412345678|abcdef0123456789/);
    expect(parsed[3].key).toBe('2026-10-10T00:00:01.000Z');
    expect(parsed[5].branch).toBe('claude/dev-control-tower-v2');
    expect(parsed[6]).not.toHaveProperty('ms');
  });
});

describe('control tower report', () => {
  it('folds the board, splits a session\'s cost between its tasks exactly, links incidents to guarded lessons, and finds logging gaps', () => {
    const { dir, git } = makeRepo();
    const commit = (date: string, session: string, msg: string) => {
      writeFileSync(path.join(dir, `f${date}`), date);
      git('add', '-A');
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `${msg}\n\nClaude-Session: https://claude.ai/code/${session}`], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    };
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const ev = (o: object) => JSON.stringify({ session: 'session_01A', ...o });
    writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), [
      ev({ ts: '2026-10-10T00:00:00Z', event: 'SessionStart', source: 'startup' }),
      ev({ ts: '2026-10-10T00:01:00Z', event: 'Task', action: 'start', id: 'T-1', title: 'Old title', status: 'in_progress' }),
      ev({ ts: '2026-10-10T00:02:00Z', event: 'Task', action: 'update', id: 'T-1', title: 'New title', progress: 50 }),
      ev({ ts: '2026-10-10T00:03:00Z', event: 'Task', action: 'start', id: 'T-2', title: 'Second' }),
      ev({ ts: '2026-10-10T00:04:00Z', event: 'Task', action: 'done', id: 'T-2', status: 'done', progress: 100 }),
      ev({ ts: '2026-10-10T00:05:00Z', event: 'Usage', costUSD: '0.10000001', costBasis: 'checkpoint+since' }),
      ev({ ts: '2026-10-10T00:07:00Z', event: 'Usage', costUSD: '0.30000001', costBasis: 'checkpoint+since' }), // each record covers the whole session
      ev({ ts: '2026-10-10T00:08:00Z', event: 'Incident', id: 'INC-20261010-0001', type: 'process', severity: 'medium', title: 'Stale', lesson: 'L-013' }),
      ev({ ts: '2026-10-10T01:59:00Z', event: 'Usage', costUSD: '0.30000001', costBasis: 'checkpoint+since' }), // recorded by hand: hides no gap
    ].join('\n') + '\n');
    commit('2026-10-10T07:30:00+08:00', 'session_01B', 'Before logging began'); // 23:30 UTC the day before: not a gap
    commit('2026-10-10T08:09:00+08:00', 'session_01A', 'Logged work'); // 00:09 UTC, written in Malaysian time
    commit('2026-10-10T10:00:00+08:00', 'session_01A', 'Work after the hooks stopped'); // 02:00 UTC
    const out = path.join(dir, 'r.json');
    expect(run(dir, 'scripts/devlog-report.mjs', ['--json', out]).status).toBe(0);
    const r = JSON.parse(readFileSync(out, 'utf8'));
    const t1 = r.board.find((t: { id: string }) => t.id === 'T-1');
    expect(t1).toMatchObject({ title: 'New title', progress: 50, status: 'in_progress' });
    expect(r.economics.spend.usd).toBe('0.30000001'); // the latest record, not a sum of records
    const t2 = r.board.find((t: { id: string }) => t.id === 'T-2');
    expect([t1.cost.usd, t2.cost.usd]).toEqual(['0.15000001', '0.15000000']); // split between the tasks, no unit lost
    // L-013's guard lives in tests/devlog.test.ts, which this copy lacks: the loop is shown as broken.
    expect(r.incidents[0]).toMatchObject({ lesson: 'L-013', guarded: false });
    mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(path.join(dir, 'tests/devlog.test.ts'), read('tests/devlog.test.ts'));
    run(dir, 'scripts/devlog-report.mjs', ['--json', out]);
    expect(JSON.parse(readFileSync(out, 'utf8')).incidents[0]).toMatchObject({ lesson: 'L-013', guarded: true });
    expect(r.areas.governance.loggingGaps).toEqual([expect.objectContaining({ session: 'session_01A', commits: 1 })]);
    expect(r.attention.map((a: { text: string }) => a.text).join(' ')).toContain('while not being logged');
  });

  it('shows RM only from a configured rate, computed exactly', () => {
    const { dir } = makeRepo((c) => { c.currency.myrPerUsd = '4.5'; c.currency.asOf = '2026-10-10'; });
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), JSON.stringify({ ts: '2026-10-10T00:00:00Z', session: 'session_01B', event: 'Usage', transcript: 'cccccccccccc', costUSD: '0.10000000', costBasis: 'checkpoint+since' }) + '\n');
    const out = path.join(dir, 'r.json');
    run(dir, 'scripts/devlog-report.mjs', ['--json', out]);
    expect(JSON.parse(readFileSync(out, 'utf8')).economics.spend).toEqual({ usd: '0.10000000', myr: '0.45000000' });
  });
});
