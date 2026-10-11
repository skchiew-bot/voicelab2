import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fmtDecimal } from '../admin/src/format.js';
// @ts-expect-error a plain ES module with no type declarations
import { secretFormats, secretHits } from '../scripts/devlog-secrets.mjs';

// The dev Control Tower: the lessons register must keep its guards, and the activity log must
// record what happened without recording anything private. Everything it records may reach git.
const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const HOOK = path.join(root, '.claude/hooks/devlog.mjs');
const scratch = mkdtempSync(path.join(tmpdir(), 'devlog-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (name = 'p') => { const d = path.join(scratch, `${name}${dirs++}`); mkdirSync(d, { recursive: true }); return d; };
// Git for the throwaway repositories, without the machine's own git config: a cloud container signs every
// commit through an outside program, which made one test take 7.8 s under load (lesson L-038).
// GIT_CONFIG_COUNT also drops config passed in the environment, which the other two do not cover.
const gitEnv = (extra: Record<string, string> = {}) => ({ ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra });
// Every git command the tests run goes through here, so the guard below covers them all.
const gitAt = (cwd: string, args: string[], extra: Record<string, string> = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: gitEnv(extra) });
// Tests that build repositories spawn dozens of processes, so their time follows the machine's load. They take about
// 1 s alone; 10 s allows for a loaded machine without hiding a real slowdown.
const REPO_TIMEOUT = 10_000;

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

  it('gives each lesson one Seen, one Rule and one Guards line, so a merge cannot leave a lesson written twice', () => {
    for (const l of lessons) {
      for (const label of ['Seen', 'Rule', 'Guards']) {
        expect(l.body.split(`**${label}:**`).length - 1, `${l.id} has ${label} more than once`).toBe(1);
      }
      const sentences = (/^- \*\*Seen:\*\* (.*)$/m.exec(l.body)?.[1] ?? '').split(/(?<=\.) (?=[A-Z])/).filter((x) => x.length > 40);
      expect(sentences.length, `${l.id} repeats a sentence in its Seen line`).toBe(new Set(sentences).size);
      // Where it happened belongs on the Seen line: a dated case on the Rule line is a merge that put it in the wrong place.
      expect(/^- \*\*Rule:\*\* .*\b20\d\d-\d\d-\d\d\b/m.test(l.body), `${l.id} dates a case on its Rule line`).toBe(false);
    }
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
    // The same scan the dev Control Tower's health check runs (scripts/devlog-secrets.mjs), so they cannot disagree.
    expect(secretFormats()).toHaveLength(5);
    expect(secretHits(root)).toEqual([]);
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

  // Helper agents in Claude Code's real shape: <session>/subagents/agent-<id>.jsonl and agent-<id>.meta.json beside it (lesson L-016).
  // Ids are built at run time: 'a' + 16 hex characters, which the scrubber reads as a long mixed run.
  const REAL_ID = fake('a', '00b3df238', 'a57b79d');
  const OTHER_ID = fake('a', '7c1e4409f', '2d6b83a');
  const agentLine = (id: string, msg: string, model: string, ts: string, usage: Record<string, unknown>) => JSON.stringify({ type: 'assistant', agentId: id, timestamp: ts, requestId: `req_${msg}`, message: { id: msg, model, usage } });
  const agentSession = (dir: string, agents: { id: string; lines?: string[]; meta?: unknown; rawMeta?: string }[]) => {
    const tp = transcript(dir, [{ id: 'main1', model: 'claude-opus-5-5', ts: '2026-10-10T00:00:00Z', usage: U(10, 20) }]);
    const sub = path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents');
    mkdirSync(sub, { recursive: true });
    for (const a of agents) {
      if (a.lines) writeFileSync(path.join(sub, `agent-${a.id}.jsonl`), a.lines.join('\n') + '\n');
      if (a.rawMeta !== undefined) writeFileSync(path.join(sub, `agent-${a.id}.meta.json`), a.rawMeta);
      else if (a.meta !== undefined) writeFileSync(path.join(sub, `agent-${a.id}.meta.json`), JSON.stringify(a.meta));
    }
    return { tp, sub };
  };
  const stop = (dir: string, tp: string, event = 'Stop') => run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: event, session_id: 'ag', transcript_path: tp }));
  const runsOf = (dir: string) => spoolLines(dir).filter((l) => l.event === 'AgentRun');

  it('records a helper agent\'s id in Claude Code\'s real shape, so its start and end pair up', async () => {
    const dir = freshDir();
    expect(REAL_ID).toMatch(/^a[0-9a-f]{16}$/);
    hook(dir, { hook_event_name: 'SubagentStart', session_id: 's1', agent_type: 'general-purpose', agent_id: REAL_ID });
    hook(dir, { hook_event_name: 'SubagentStop', session_id: 's1', agent_type: 'general-purpose', agent_id: REAL_ID });
    hook(dir, { hook_event_name: 'SubagentStart', session_id: 's1', agent_type: 'general-purpose', agent_id: 'bob@example.test' });
    hook(dir, { hook_event_name: 'SubagentStart', session_id: 's1', agent_type: 'general-purpose', agent_id: 'x'.repeat(41) });
    const [start, end, email, long] = lines(dir);
    expect(start).toMatchObject({ event: 'SubagentStart', agentId: REAL_ID });
    expect(end).toMatchObject({ event: 'SubagentStop', agentId: REAL_ID });
    expect('agentId' in email).toBe(false); // not plainly an id: left out, never a lookalike
    expect('agentId' in long).toBe(false);
    // And it survives the flush, which is what reaches git.
    const { clean } = await import(path.join(root, 'scripts/devlog-flush.mjs'));
    expect(clean(start)).toMatchObject({ event: 'SubagentStart', agentId: REAL_ID });
    expect(clean(end)).toMatchObject({ event: 'SubagentStop', agentId: REAL_ID });
  });

  it('records each helper agent\'s model and tokens from Claude Code\'s own transcripts, and its process only from a tag written when it started', () => {
    const { dir } = makeRepo();
    const description = 'Build the thing for bob@example.test with TWILIO_AUTH_TOKEN=abc';
    const { tp } = agentSession(dir, [
      {
        id: REAL_ID, meta: { agentType: 'general-purpose', description: `[build T-1 esc:suite_failed] ${description}`, model: 'opus', spawnDepth: 1 },
        lines: [
          agentLine(REAL_ID, 'am1', 'claude-sonnet-5-5', '2026-10-10T00:10:00Z', U(100, 200)),
          agentLine(REAL_ID, 'am1', 'claude-sonnet-5-5', '2026-10-10T00:10:00Z', U(100, 200)), // a second content block of the same message
          agentLine(REAL_ID, 'am2', 'claude-sonnet-5-5', '2026-10-10T00:20:00Z', U(50, 25, 1000)),
        ],
      },
      { id: OTHER_ID, lines: [agentLine(OTHER_ID, 'bm1', 'claude-haiku-5-5', '2026-10-10T00:30:00Z', U(7, 3))] }, // no metadata at all
    ]);
    expect(stop(dir, tp).status).toBe(0);
    const [a, b] = runsOf(dir);
    expect(a).toMatchObject({ event: 'AgentRun', agentId: REAL_ID, agentType: 'general-purpose', requested: 'opus', process: 'build', task: 'T-1', trigger: 'suite_failed', first: '2026-10-10T00:10:00.000Z', last: '2026-10-10T00:20:00.000Z' });
    // The model is the one that served the messages, never the one asked for; each message counted once.
    expect(Object.keys(a.tokens)).toEqual(['claude-sonnet-5-5']);
    expect(a.tokens['claude-sonnet-5-5']).toMatchObject({ messages: 2, input: 150, output: 225, cacheRead: 1000 });
    expect(b).toMatchObject({ agentId: OTHER_ID, requested: null });
    expect(b.process).toBeUndefined();
    expect(b.task).toBeUndefined();
    expect(Object.keys(b.tokens)).toEqual(['claude-haiku-5-5']);
    for (const s of ['bob', 'example', 'TWILIO', 'Build the thing']) expect(spooled(dir)).not.toContain(s); // the description is never stored
    // The session's own figures count each message once, helper agents' included.
    const usage = spoolLines(dir).find((l) => l.event === 'Usage');
    expect(usage.tokens['claude-sonnet-5-5']).toMatchObject({ messages: 2, input: 150, output: 225 });
    expect(usage.tokens['claude-haiku-5-5']).toMatchObject({ messages: 1, input: 7 });
    expect(usage.tokens['claude-opus-5-5']).toMatchObject({ messages: 1, input: 10, output: 20 });
  });

  it('never records a helper agent\'s description, only a tag in the exact form, and a malformed tag as no process', async () => {
    const mod = await import(HOOK);
    const mail = fake('ali', '@', 'example.test');
    const cases: [string, unknown][] = [
      ['[build T-1] do it', { process: 'build', task: 'T-1' }],
      ['[review T-1] check', { process: 'review', task: 'T-1' }],
      ['[security-review DCT-12.a] x', { process: 'security-review', task: 'DCT-12.a' }],
      ['[fix T-1 esc:review_failed]', { process: 'fix', task: 'T-1', trigger: 'review_failed' }],
      ['[fix T-1 esc:ci_red]', { process: 'fix', task: 'T-1', trigger: 'ci_red' }],
      ['[review T-1 shadow] second opinion', { process: 'review', task: 'T-1', shadow: true }],
      ['[Build T-1]', null], // case-sensitive
      ['[build]', null], // no task
      ['[deploy T-1]', null], // not a process
      ['[security-review T-1 shadow]', null], // shadow only with review
      ['[build T-1 esc:other]', null], // not a trigger
      ['[build T-1 shadow]', null],
      ['[build T-1x', null], // not a whole bracket
      ['[build T-1]x', null], // text running on from the bracket
      ['do [build T-1]', null], // only at the start
      [mail, null],
      ['Build the dialler for Ali bin Abu', null],
      // The task id is the one free-form part: an id scrubbing would change, or one with a number's worth of digits, is no tag.
      [`[fix ${fake('p', '60123456789')}] x`, null],
      [`[build ${fake('T-', '1234567')}]`, null],
      [`[build ${fake('a', 'b'.repeat(20), '1')}]`, null],
      [`[build ${fake('x'.repeat(40))}]`, null],
      [`[fix T-123456 esc:suite_failed]`, { process: 'fix', task: 'T-123456', trigger: 'suite_failed' }], // six digits stay
    ];
    for (const [text, want] of cases) expect(mod.parseTag(text), text).toEqual(want);
    expect(mod.parseTag(undefined)).toBeNull();
    expect(mod.parseTag({ toString: () => '[build T-1]' })).toBeNull();
    expect(mod.PROCESSES).toEqual(['plan', 'review', 'security-review', 'build', 'fix', 'check']);
    expect(mod.TRIGGERS).toEqual(['review_failed', 'suite_failed', 'builder_blocked', 'deny_path_touched', 'ci_red']);

    // End to end: a malformed tag leaves the agent with no process, and none of the description reaches the spool.
    const { dir } = makeRepo();
    const { tp } = agentSession(dir, [
      { id: REAL_ID, meta: { agentType: 'general-purpose', description: `[build T-1 esc:other] ${mail}` }, lines: [agentLine(REAL_ID, 'am1', 'claude-sonnet-5-5', '2026-10-10T00:10:00Z', U(1, 1))] },
      { id: OTHER_ID, meta: { agentType: 'general-purpose', description: `Mail ${mail} about Ali bin Abu` }, lines: [agentLine(OTHER_ID, 'bm1', 'claude-sonnet-5-5', '2026-10-10T00:11:00Z', U(1, 1))] },
    ]);
    stop(dir, tp);
    const runs = runsOf(dir);
    expect(runs).toHaveLength(2);
    for (const r of runs) { expect(r.process).toBeUndefined(); expect(r.task).toBeUndefined(); expect(r.trigger).toBeUndefined(); }
    for (const s of ['ali', 'Ali', 'example', 'Mail', 'esc:other']) expect(spooled(dir)).not.toContain(s);
  });

  it('writes a helper agent\'s record again only when it changed, so many stops do not grow the log', () => {
    const { dir } = makeRepo();
    const first = agentLine(REAL_ID, 'am1', 'claude-sonnet-5-5', '2026-10-10T00:10:00Z', U(5, 5));
    const { tp, sub } = agentSession(dir, [{ id: REAL_ID, meta: { description: '[check T-2]' }, lines: [first] }]);
    stop(dir, tp); stop(dir, tp); stop(dir, tp, 'SessionEnd');
    expect(runsOf(dir)).toHaveLength(1);
    // New work by the agent is a new record, and the one after that changes nothing again.
    writeFileSync(path.join(sub, `agent-${REAL_ID}.jsonl`), [first, agentLine(REAL_ID, 'am2', 'claude-sonnet-5-5', '2026-10-10T00:15:00Z', U(5, 5))].join('\n') + '\n');
    stop(dir, tp); stop(dir, tp);
    const runs = runsOf(dir);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.tokens['claude-sonnet-5-5'].messages)).toEqual([1, 2]);
    expect(runs[1]).toMatchObject({ process: 'check', task: 'T-2', last: '2026-10-10T00:15:00.000Z' });
    // The record follows the Usage line of its own stop.
    const order = spoolLines(dir).map((l) => l.event).filter((e) => e === 'Usage' || e === 'AgentRun');
    expect(order.slice(0, 2)).toEqual(['Usage', 'AgentRun']);
  });

  it('keeps a session\'s own totals as they were: helper agents\' tokens are a breakdown, not an addition', () => {
    const { dir } = makeRepo();
    const { tp } = agentSession(dir, [
      { id: REAL_ID, lines: [agentLine(REAL_ID, 'am1', 'claude-opus-5-5', '2026-10-10T00:10:00Z', U(100, 1000))] },
      { id: OTHER_ID, lines: [agentLine(OTHER_ID, 'bm1', 'claude-opus-5-5', '2026-10-10T00:20:00Z', U(200, 2000))] },
    ]);
    stop(dir, tp);
    const usage = spoolLines(dir).find((l) => l.event === 'Usage');
    // Worked out by hand: main 10 in / 20 out, agents 100/1000 and 200/2000 in the same model, each message once.
    expect(usage.tokens['claude-opus-5-5']).toMatchObject({ messages: 3, input: 310, output: 3020 });
    const parts = runsOf(dir).map((r) => r.tokens['claude-opus-5-5']);
    expect(parts.map((t) => [t.input, t.output])).toEqual([[100, 1000], [200, 2000]]);
    // No checkpoint, so the transcript prices it: 310 in at 4 and 3020 out at 20 per million.
    expect(usage.costBasis).toBe('transcript-only');
    expect(usage.costUSD).toBe('0.06164000');
  });

  it('records the rest when one helper agent\'s files cannot be read', () => {
    const { dir } = makeRepo();
    const THIRD = fake('a', '5d90c1e7b', '3f2a604');
    const { tp, sub } = agentSession(dir, [
      { id: REAL_ID, rawMeta: '{ not json', lines: [agentLine(REAL_ID, 'am1', 'claude-sonnet-5-5', '2026-10-10T00:10:00Z', U(1, 1))] }, // metadata unreadable
      { id: THIRD, meta: { description: '[fix T-3]' }, lines: [agentLine(THIRD, 'cm1', 'claude-sonnet-5-5', '2026-10-10T00:12:00Z', U(2, 2))] },
    ]);
    mkdirSync(path.join(sub, `agent-${OTHER_ID}.jsonl`)); // a transcript that cannot be read as a file
    mkdirSync(path.join(sub, `agent-${OTHER_ID}.meta.json`)); // and metadata that is not a file
    expect(stop(dir, tp).status).toBe(0);
    expect(spoolLines(dir).filter((l) => l.event === 'Usage')).toHaveLength(1);
    const runs = runsOf(dir);
    expect(runs.map((r) => r.agentId).sort()).toEqual([REAL_ID, THIRD].sort());
    expect(runs.find((r) => r.agentId === REAL_ID).process).toBeUndefined(); // no metadata, no process
    expect(runs.find((r) => r.agentId === THIRD)).toMatchObject({ process: 'fix', task: 'T-3' });
  });

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
    // The hook's own timestamps are left out: '345' can be the milliseconds of the moment it ran (lesson L-037).
    const recorded = spooled(dir).replace(/"ts":"[^"]*"/g, '"ts":""');
    for (const leak of leaks) expect(recorded, leak).not.toContain(leak);
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
    const git = (cwd: string, ...a: string[]) => gitAt(cwd, a);
    const origin = freshDir('origin');
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'one');
    const clone = path.join(freshDir(), 'clone');
    git(scratch, 'clone', '-q', origin, clone);
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'two');
    const r = hook(clone, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
    expect(r.stdout).toContain('1 commits behind origin/main');
    expect(lines(clone)[0]).toMatchObject({ event: 'SessionStart', behind_main: 1 });
  }, REPO_TIMEOUT);

  it('never blocks the session, whatever it is given', () => {
    const dir = freshDir();
    expect(hook(dir, 'not json').status).toBe(0);
    expect(hook(dir, '').status).toBe(0);
    expect(hook(dir, { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }).stdout).toContain('Dev Control Tower');
  });
});

describe('fallback hook for a session opened outside the repository (lesson L-020)', () => {
  // A copy of the hooks, their settings and the installer inside a user folder, as /home/user
  // holds the clone. The checkout's name is one a shell would misread unquoted (lesson L-018).
  const makeCheckout = (user = freshDir('user'), name = "voice lab's $HOME") => {
    const dir = path.join(user, name);
    for (const f of ['.claude/hooks/devlog.mjs', '.claude/hooks/devlog-fallback.mjs', '.claude/settings.json', 'scripts/install-devlog-fallback.mjs', 'devlog/control-tower.json']) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), read(f));
    }
    return dir;
  };
  const userSettings = (home: string) => path.join(home, '.claude/settings.json');
  const copyOf = (home: string) => path.join(home, '.claude/hooks/devlog-fallback.mjs');
  const install = (checkout: string, home: string, ...args: string[]) => spawnSync('node', [path.join(checkout, 'scripts/install-devlog-fallback.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: undefined },
  });
  const state = (checkout: string, home: string) => install(checkout, home, '--check').stdout.trim();
  const commandsFor = (file: string, event: string): string[] => {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')).hooks?.[event] ?? []).flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    } catch { return []; } // no file, or one Claude Code could not read either: no hooks from it
  };
  /**
   * One event as Claude Code delivers it: the handlers in the project folder's settings (shared and
   * local) and in the user's, a handler found twice run once, all given the same input. Only the
   * devlog hook and its fallback: the project's other hooks (such as its session setup) are not
   * what these tests are about.
   */
  const deliver = (home: string, projectDir: string, payload: Record<string, unknown>, env: Record<string, string | undefined> = {}) => {
    const event = String(payload.hook_event_name);
    const commands = new Set([
      ...commandsFor(path.join(projectDir, '.claude/settings.json'), event),
      ...commandsFor(path.join(projectDir, '.claude/settings.local.json'), event),
      ...commandsFor(userSettings(home), event),
    ].filter((c) => /\/devlog(-fallback)?\.mjs\b/.test(c)));
    return [...commands].map((c) => spawnSync('sh', ['-c', c], {
      input: JSON.stringify({ cwd: projectDir, ...payload }), encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_CODE_REMOTE_SESSION_ID: undefined, CLAUDE_CODE_REMOTE: undefined, DEVLOG_VIA: undefined, ...env },
    }));
  };
  type Handler = { command: string; timeout?: number };
  const fallbacksIn = (file: string) => {
    const s = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, { hooks: Handler[] }[]> };
    const out: Record<string, Handler[]> = {};
    for (const [event, entries] of Object.entries(s.hooks)) {
      const list = entries.flatMap((e) => e.hooks).filter((h) => h.command.includes('devlog-fallback.mjs'));
      if (list.length > 0) out[event] = list;
    }
    return out;
  };
  /** What an installed command runs, read back through the shell: the copy, and the checkout it is given. */
  const runs = (command: string) => ({
    copy: execFileSync('sh', ['-c', `${command.split('; [')[0]}; printf %s "$f"`], { encoding: 'utf8' }),
    checkout: execFileSync('sh', ['-c', `printf %s ${command.split('node "$f" ')[1]}`], { encoding: 'utf8' }),
  });

  it('installs a copy and registers it once for every event the repository logs, keeps what was there, and changes nothing when run again', () => {
    const checkout = makeCheckout(); const home = freshDir('home');
    const file = userSettings(home);
    mkdirSync(path.dirname(file), { recursive: true });
    const mine = {
      model: 'opus',
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo note' }] }],
        // An earlier install from a checkout somewhere else, sharing an entry with one of the owner's hooks.
        Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }, { type: 'command', command: "f='/old/place/.claude/hooks/devlog-fallback.mjs'; node \"$f\"" }] }],
      },
    };
    writeFileSync(file, JSON.stringify(mine));
    const first = install(checkout, home);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('Installed');
    const s = JSON.parse(readFileSync(file, 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.hooks.PostToolUse[0]).toEqual(mine.hooks.PostToolUse[0]);
    expect(s.hooks.Notification).toEqual(mine.hooks.Notification);
    expect(s.hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'echo stop' }] });
    // Once on each event the repository's own settings log, with the same time limit; nowhere else.
    const project = JSON.parse(read('.claude/settings.json')).hooks as Record<string, { hooks: { command: string; timeout: number }[] }[]>;
    const logged = Object.entries(project).map(([event, entries]) => [event, entries.flatMap((e) => e.hooks).filter((h) => h.command.endsWith('/.claude/hooks/devlog.mjs"')).map((h) => h.timeout)] as const).filter(([, t]) => t.length > 0);
    expect(logged.length).toBeGreaterThanOrEqual(8);
    const installed = fallbacksIn(file);
    expect(Object.fromEntries(Object.entries(installed).map(([e, list]) => [e, list.map((h) => h.timeout)]))).toEqual(Object.fromEntries(logged));
    // Every one runs the copy beside the user settings, given this checkout, each path one inert shell word.
    expect(new Set(Object.values(installed).flat().map((h) => JSON.stringify(runs(h.command))))).toEqual(new Set([JSON.stringify({ copy: copyOf(home), checkout })]));
    expect(readFileSync(copyOf(home), 'utf8')).toBe(read('.claude/hooks/devlog-fallback.mjs'));
    expect(state(checkout, home)).toBe('installed');

    const before = readFileSync(file, 'utf8');
    const second = install(checkout, home);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('creates the user settings when there are none, and leaves a settings file it cannot read as it is', () => {
    const checkout = makeCheckout();
    const fresh = freshDir('home');
    expect(state(checkout, fresh)).toBe('missing');
    expect(install(checkout, fresh).status).toBe(0);
    expect(Object.keys(fallbacksIn(userSettings(fresh))).length).toBeGreaterThanOrEqual(8);
    expect(state(checkout, fresh)).toBe('installed');
    for (const bad of ['{ "model": ', '[]', '{ "hooks": [] }', '{ "hooks": { "Stop": {} } }']) {
      const home = freshDir('home');
      mkdirSync(path.join(home, '.claude'));
      writeFileSync(userSettings(home), bad);
      const r = install(checkout, home);
      expect(r.status, bad).toBe(1);
      expect(r.stderr, bad).toContain('left as it is');
      expect(readFileSync(userSettings(home), 'utf8')).toBe(bad);
      expect(state(checkout, home), bad).toBe('unreadable');
    }
  });

  it('reports an install out of date when the fallback or the logged events change, and brings it up to date', () => {
    const checkout = makeCheckout(); const home = freshDir('home');
    expect(install(checkout, home).status).toBe(0);
    writeFileSync(copyOf(home), readFileSync(copyOf(home), 'utf8') + '// an older copy\n');
    expect(state(checkout, home)).toBe('outdated');
    expect(install(checkout, home).stdout).toContain('Installed');
    expect(readFileSync(copyOf(home), 'utf8')).toBe(read('.claude/hooks/devlog-fallback.mjs'));
    const projectFile = path.join(checkout, '.claude/settings.json');
    const project = JSON.parse(readFileSync(projectFile, 'utf8'));
    project.hooks.Stop[0].hooks[0].timeout = 16;
    writeFileSync(projectFile, JSON.stringify(project));
    expect(state(checkout, home)).toBe('outdated');
    install(checkout, home);
    expect(fallbacksIn(userSettings(home)).Stop!.map((h) => h.timeout)).toEqual([16]);
    // A hook the owner adds after the fallback is not a reason to call it out of date or rewrite the file.
    const s = JSON.parse(readFileSync(userSettings(home), 'utf8'));
    s.hooks.PostToolUse.push({ hooks: [{ type: 'command', command: 'echo later' }] });
    writeFileSync(userSettings(home), JSON.stringify(s));
    expect(state(checkout, home)).toBe('installed');
    expect(install(checkout, home).stdout).toContain('already installed');
    expect(readFileSync(userSettings(home), 'utf8')).toBe(JSON.stringify(s));
  });

  it('logs a session opened outside the repository to the repository, and tells Claude where its instructions are', () => {
    const user = freshDir('user'); const checkout = makeCheckout(user); const home = freshDir('home');
    expect(install(checkout, home).status).toBe(0);
    // Started in the folder that holds the clone, as after the restart in lesson L-020.
    const start = deliver(home, user, { hook_event_name: 'SessionStart', session_id: 's1', source: 'resume' });
    expect(start.map((r) => r.status)).toEqual([0]);
    expect(start[0]!.stdout).toContain('opened outside the repository');
    expect(start[0]!.stdout).toContain(path.join(checkout, 'CLAUDE.md'));
    expect(start[0]!.stdout).toContain(`run the devlog commands below from ${checkout}`);
    expect(start[0]!.stdout).toContain('Before each commit run');
    deliver(home, user, { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(checkout, 'src/x.ts') } });
    expect(spoolLines(checkout)).toEqual([
      expect.objectContaining({ event: 'SessionStart', session: 's1', via: 'fallback' }),
      expect.objectContaining({ event: 'PostToolUse', session: 's1', tool: 'Edit', target: 'src/x.ts' }),
    ]);
    expect(existsSync(path.join(user, 'devlog'))).toBe(false);
    // Started in a folder inside the repository, Claude Code reads that folder's settings, not the
    // repository's. Started in a home folder that holds the clone, the user settings are the project's too.
    const sub = path.join(checkout, 'admin');
    mkdirSync(sub);
    expect(deliver(home, sub, { hook_event_name: 'UserPromptSubmit', session_id: 's2' }).map((r) => r.status)).toEqual([0]);
    expect(install(checkout, user).status).toBe(0);
    expect(deliver(user, user, { hook_event_name: 'UserPromptSubmit', session_id: 's3' }).map((r) => r.status)).toEqual([0]);
    expect(spoolLines(checkout).slice(2).map((l) => l.session)).toEqual(['s2', 's3']);
  });

  it('leaves another project\'s session alone, and judges by the event\'s folder only when the project folder is unknown', () => {
    const user = freshDir('user'); const checkout = makeCheckout(user); const home = freshDir('home');
    expect(install(checkout, home).status).toBe(0);
    const beside = path.join(user, 'other-project'); // another clone in the same user folder, with hooks of its own
    mkdirSync(path.join(beside, '.claude'), { recursive: true });
    writeFileSync(path.join(beside, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
    for (const dir of [beside, freshDir('elsewhere')]) {
      const r = deliver(home, dir, { hook_event_name: 'SessionStart', session_id: 'other', source: 'startup' });
      expect(r.map((x) => ({ status: x.status, stdout: x.stdout }))).toEqual([{ status: 0, stdout: '' }]);
      expect(existsSync(path.join(dir, 'devlog'))).toBe(false);
    }
    expect(spoolLines(checkout)).toEqual([]);
    // Without CLAUDE_PROJECT_DIR the project's own hook cannot find itself, so the fallback logs a
    // session whose folder is in the repository, and still nothing else.
    const [command] = commandsFor(userSettings(home), 'UserPromptSubmit');
    const unset = (cwd: string) => spawnSync('sh', ['-c', command!], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'u1', cwd }), encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: undefined, CLAUDE_CODE_REMOTE_SESSION_ID: undefined },
    }).status;
    expect([unset(checkout), unset(beside)]).toEqual([0, 0]); // the event's folder is never taken as the project's
    expect(spoolLines(checkout)).toEqual([expect.objectContaining({ event: 'UserPromptSubmit', session: 'u1' })]);
  });

  it('steps aside when the session\'s own project runs the devlog hook, so each event is logged once', () => {
    const checkout = makeCheckout(); const home = freshDir('home');
    expect(install(checkout, home).status).toBe(0);
    const events = [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(checkout, 'a.ts') } },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' },
      { hook_event_name: 'SubagentStart', agent_type: 'Explore', agent_id: 'a1' },
      { hook_event_name: 'SubagentStop', agent_type: 'Explore', agent_id: 'a1' },
      { hook_event_name: 'Stop' },
      { hook_event_name: 'SessionEnd', reason: 'other' },
    ];
    for (const e of events) {
      const results = deliver(home, checkout, { session_id: 's1', ...e });
      expect(results.map((r) => r.status), e.hook_event_name).toEqual([0, 0]); // the project's hook and the fallback both ran
    }
    // Stop with no transcript yet records nothing; SessionEnd records the end and the session's usage.
    expect(spoolLines(checkout).map((l) => l.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'Usage']);
    expect(spoolLines(checkout).some((l) => 'via' in l)).toBe(false);

    // A worktree inside the repository with its own devlog hook logs its own sessions.
    const worktree = makeCheckout(path.join(checkout, '.claude/worktrees'), 'w1');
    expect(deliver(home, worktree, { hook_event_name: 'UserPromptSubmit', session_id: 's2' }).map((r) => r.status)).toEqual([0, 0]);
    expect(spoolLines(worktree)).toEqual([expect.objectContaining({ event: 'UserPromptSubmit', session: 's2' })]);
    expect(spoolLines(checkout).some((l) => l.session === 's2')).toBe(false);

    // The hook registered only in the local settings still counts; a hook file nobody registers does not.
    const local = makeCheckout(); const localHome = freshDir('home');
    expect(install(local, localHome).status).toBe(0);
    renameSync(path.join(local, '.claude/settings.json'), path.join(local, '.claude/settings.local.json'));
    expect(install(local, freshDir('home')).status).toBe(1); // nothing to install from shared settings that log no event
    expect(deliver(localHome, local, { hook_event_name: 'UserPromptSubmit', session_id: 's3' }).map((r) => r.status)).toEqual([0, 0]);
    expect(spoolLines(local)).toEqual([expect.objectContaining({ event: 'UserPromptSubmit', session: 's3' })]);
    expect(spoolLines(local)[0]).not.toHaveProperty('via');
    rmSync(path.join(local, '.claude/settings.local.json'));
    expect(deliver(localHome, local, { hook_event_name: 'UserPromptSubmit', session_id: 's4' }).map((r) => r.status)).toEqual([0]);
    expect(spoolLines(local).filter((l) => l.session === 's4')).toHaveLength(1);
  });

  it('passes a stop-loss on to Claude, keeps logging on a branch from before the fallback, and never blocks or errors when it cannot log', () => {
    const user = freshDir('user'); const checkout = makeCheckout(user); const home = freshDir('home');
    expect(install(checkout, home).status).toBe(0);
    // Five different test runs failing in a row (different, so the same-command rule stays out of it).
    const failedTest = (i: number) => ({ hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash', tool_input: { command: `npm test -- t${i}` }, error: 'Exit code 1' });
    const fails = Array.from({ length: 5 }, (_, i) => deliver(home, user, failedTest(i))[0]!);
    expect(fails.map((r) => r.status)).toEqual([0, 0, 0, 0, 2]);
    expect(fails[4]!.stderr).toContain('STOP-LOSS TRIGGERED');

    const [command] = commandsFor(userSettings(home), 'UserPromptSubmit');
    const raw = (input: string) => {
      const r = spawnSync('sh', ['-c', command!], { input, encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: user, CLAUDE_CODE_REMOTE_SESSION_ID: undefined } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });
    const quiet = { status: 0, stdout: '', stderr: '' };
    expect(raw('not json')).toEqual(quiet);
    const lines = spoolLines(checkout).length;
    rmSync(path.join(checkout, '.claude/hooks/devlog-fallback.mjs')); // a branch from before the fallback existed
    expect(raw(prompt)).toEqual(quiet);
    expect(spoolLines(checkout)).toHaveLength(lines + 1);
    rmSync(path.join(checkout, '.claude/hooks/devlog.mjs')); // a checkout with no devlog hook at all
    expect(raw(prompt)).toEqual(quiet);
    rmSync(copyOf(home));
    expect(raw(prompt)).toEqual(quiet);
    expect(spoolLines(checkout)).toHaveLength(lines + 1);
  });

  it('warns a cloud session that starts without the fallback in place, and records what it found', () => {
    const checkout = makeCheckout(); const home = freshDir('home');
    const start = (env: Record<string, string | undefined>) => {
      const before = spoolLines(checkout).length;
      const results = deliver(home, checkout, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }, env);
      return { stdout: results.map((r) => r.stdout).join(''), line: spoolLines(checkout)[before] };
    };
    const cloud = { CLAUDE_CODE_REMOTE: 'true' };
    const missing = start(cloud);
    expect(missing.stdout).toContain('the user-level fallback hook is not installed');
    expect(missing.stdout).toContain(`node ${path.join(checkout, 'scripts/install-devlog-fallback.mjs')} || true`);
    expect(missing.stdout).toContain("only with the owner's go-ahead"); // changing user-level settings is the owner's call
    expect(missing.line).toMatchObject({ event: 'SessionStart', fallback: 'missing' });
    // On the owner's own machine the user settings are theirs: nothing is checked.
    const local = start({});
    expect(local.stdout).not.toContain('fallback hook');
    expect(local.line).not.toHaveProperty('fallback');
    expect(install(checkout, home).status).toBe(0);
    const installed = start(cloud);
    expect(installed.stdout).not.toContain('fallback hook');
    expect(installed.line).toMatchObject({ event: 'SessionStart', fallback: 'installed' });
    // A copy from another branch, as for a while after a merge, still logs: recorded, not warned about.
    writeFileSync(copyOf(home), readFileSync(copyOf(home), 'utf8') + '// an older copy\n');
    const outdated = start(cloud);
    expect(outdated.stdout).not.toContain('fallback hook');
    expect(outdated.line).toMatchObject({ fallback: 'outdated' });
    writeFileSync(userSettings(home), '{ "hooks": ');
    const unreadable = start(cloud);
    expect(unreadable.stdout).toContain('the user settings file is not valid JSON');
    expect(unreadable.line).toMatchObject({ fallback: 'unreadable' });
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

  it('keeps only known fields of a helper agent\'s record and an outcome when flushing, and drops one with no id or required field', () => {
    const dir = freshDir();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const id = fake('a', '00b3df238', 'a57b79d');
    const base = { ts: '2026-10-10T00:00:00Z', session: 'session_01X' };
    const tokens = { 'claude-sonnet-5-5': { messages: 2, input: 5, output: 6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUSD: '0.00000100', extra: 1 } };
    const rows = [
      { ...base, event: 'AgentRun', agentId: id, agentType: 'general-purpose', requested: 'opus', process: 'build', task: 'T-1', trigger: 'suite_failed', shadow: true, first: '2026-10-10T00:01:00+08:00', last: '2026-10-10T00:02:00Z', tokens, sig: '2|x', description: 'free text' },
      { ...base, event: 'AgentRun', agentId: id, requested: 'gpt', process: 'deploy', task: 'not a task!', trigger: 'other', shadow: 'yes', first: 'soon', tokens: {} },
      { ...base, event: 'AgentRun', agentId: id, process: 'build', task: fake('p', '60123456789'), tokens: {} }, // a task id that is a phone number's worth of digits
      { ...base, event: 'Outcome', task: fake('p', '60123456789'), process: 'review', result: 'passed' },
      { ...base, event: 'Task', action: 'start', id: fake('p', '60123456789'), title: 'x' },
      { ...base, event: 'AgentRun', agentType: 'general-purpose', process: 'build' }, // no id
      { ...base, event: 'AgentRun', agentId: '[redacted]', process: 'build' }, // not an id
      { ...base, event: 'AgentRun', agentId: id, process: 'review', task: 'T-1', shadow: true, tokens: {} }, // a shadow review keeps its flag
      { ...base, event: 'Outcome', task: 'T-1', process: 'build', result: 'failed', agent: id, shadowOf: id }, // only a review shadows another
      { ...base, event: 'Outcome', task: 'T-1', process: 'review', result: 'failed', agent: id, shadowOf: id, round: 2, note: 'free text' },
      { ...base, event: 'Outcome', task: 'T-1', process: 'review', result: 'passed', round: 100 },
      { ...base, event: 'Outcome', task: 'T-1', process: 'deploy', result: 'passed' }, // not a process
      { ...base, event: 'Outcome', task: 'T-1', process: 'review', result: 'maybe' }, // not a result
      { ...base, event: 'Outcome', process: 'review', result: 'passed' }, // no task
    ];
    writeFileSync(path.join(dir, 'devlog/.spool/s1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(runFlush(dir).status).toBe(0);
    const out = readdirSync(path.join(dir, 'devlog/activity'));
    const got = readFileSync(path.join(dir, 'devlog/activity', out[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const t = { 'claude-sonnet-5-5': { messages: 2, input: 5, output: 6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUSD: '0.00000100' } };
    expect(got).toEqual([
      { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'AgentRun', agentId: id, agentType: 'general-purpose', requested: 'opus', process: 'build', task: 'T-1', trigger: 'suite_failed', first: '2026-10-09T16:01:00.000Z', last: '2026-10-10T00:02:00.000Z', tokens: t }, // shadow dropped: it is a build
      { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'AgentRun', agentId: id, tokens: {} },
      { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'AgentRun', agentId: id, process: 'build', tokens: {} }, // its task id was dropped, the record kept
      { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'AgentRun', agentId: id, process: 'review', task: 'T-1', shadow: true, tokens: {} },
      { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'Outcome', task: 'T-1', process: 'build', result: 'failed', agent: id },
      { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'Outcome', task: 'T-1', process: 'review', result: 'failed', agent: id, shadowOf: id, round: 2 },
      { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'Outcome', task: 'T-1', process: 'review', result: 'passed' },
    ]);
  });

  it('keeps a CI run only in its fixed form: a known task, a pull request, a hex commit, a result, and a run id of digits', () => {
    const dir = freshDir();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const base = { ts: '2026-10-10T00:00:00Z', session: 'session_01X' };
    const sha = 'abc1234def';
    const rows = [
      { ...base, event: 'CiRun', task: 'T-1', pr: 7, sha, result: 'failed', run: '12345678901', note: 'free text', log: 'https://example.test/x' },
      { ...base, event: 'CiRun', task: 'T-1', pr: 7, sha, result: 'passed', run: 'not digits' }, // the run id is dropped, the record kept
      { ...base, event: 'CiRun', task: 'T-1', pr: 7, sha, result: 'passed' },
      { ...base, event: 'CiRun', task: 'T-1', pr: 7, sha, result: 'maybe' }, // not a result
      { ...base, event: 'CiRun', task: 'T-1', pr: 0, sha, result: 'passed' }, // not a pull request
      { ...base, event: 'CiRun', task: 'T-1', pr: '7', sha, result: 'passed' },
      { ...base, event: 'CiRun', task: 'T-1', pr: 7, sha: 'ABC1234', result: 'passed' }, // not lowercase hex
      { ...base, event: 'CiRun', task: 'T-1', pr: 7, sha: 'abc12', result: 'passed' }, // too short
      { ...base, event: 'CiRun', task: 'not a task!', pr: 7, sha, result: 'passed' },
      { ...base, event: 'CiRun', pr: 7, sha, result: 'passed' }, // no task
    ];
    writeFileSync(path.join(dir, 'devlog/.spool/s1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(runFlush(dir).status).toBe(0);
    const out = readdirSync(path.join(dir, 'devlog/activity'));
    const got = readFileSync(path.join(dir, 'devlog/activity', out[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const at = { ts: '2026-10-10T00:00:00.000Z', session: 'session_01X', event: 'CiRun', task: 'T-1', pr: 7, sha };
    expect(got).toEqual([
      { ...at, result: 'failed', run: '12345678901' },
      { ...at, result: 'passed' },
      { ...at, result: 'passed' },
    ]);
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
  for (const f of ['.claude/hooks/devlog.mjs', 'scripts/devlog-flush.mjs', 'scripts/devlog-report.mjs', 'scripts/devlog-task.mjs', 'scripts/devlog-secrets.mjs', 'scripts/devlog-throttle.mjs', 'devlog/lessons.md', 'devlog/dashboard.html']) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), read(f));
  }
  const cfg = JSON.parse(read('devlog/control-tower.json'));
  config?.(cfg);
  writeFileSync(path.join(dir, 'devlog/control-tower.json'), JSON.stringify(cfg));
  const git = (...a: string[]) => gitAt(dir, a);
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
type Entry = { id: string; model: string; ts: string; usage: Record<string, unknown>; blocks?: number } | { checkpoint: number; models: Record<string, number>; start?: string };
function transcript(dir: string, entries: Entry[], sub?: Entry[], opts: { folder?: string } = {}) {
  const lines = (list: Entry[]) => list.flatMap((e) => ('checkpoint' in e
    ? [JSON.stringify({ type: 'cost-state', totalCostUSD: e.checkpoint, startTime: new Date(e.start ?? '2026-10-09T23:00:00Z').getTime(), modelUsage: Object.fromEntries(Object.entries(e.models).map(([m, c]) => [m, { inputTokens: 1, outputTokens: 1, costUSD: c }])) })]
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
    expect(u.checkpoint.costUSD).toBe('1.50000000');
  });

  it('counts a session resumed in another folder once: copied messages once, each run\'s checkpoint added, then what came after', () => {
    // Claude Code keeps one running total per run. A resume starts a new run from zero, in a new
    // transcript that copies the earlier messages. Checked against real transcripts (lesson L-016).
    const runTwo = (dir: string, secondRunTotal: number) => {
      const a = transcript(dir, [
        { id: 'm1', model: 'claude-opus-5-5', ts: '2026-10-10T00:00:00Z', usage: U(0, 1_000_000) },
        { checkpoint: 30, models: { 'claude-opus-5-5': 30 }, start: '2026-10-09T23:59:00Z' },
      ], undefined, { folder: '-repo' });
      const b = path.join(path.dirname(path.dirname(a)), '-home', path.basename(a));
      mkdirSync(path.dirname(b), { recursive: true });
      writeFileSync(b, readFileSync(a, 'utf8').split('\n').filter((l) => !l.includes('cost-state')).join('\n')
        + JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T00:30:00Z', message: { id: 'm0', model: 'claude-opus-5-5', usage: U(0, 0) } }) + '\n'
        + JSON.stringify({ type: 'cost-state', totalCostUSD: secondRunTotal, startTime: Date.parse('2026-10-10T00:20:00Z'), modelUsage: {} }) + '\n'
        + JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T01:00:00Z', message: { id: 'm2', model: 'claude-opus-5-5', usage: U(0, 1_000_000) } }) + '\n');
      return { a, b };
    };
    // A second run below the first, and one above it (the case that once dropped the first run).
    for (const [second, expected] of [[2, '52.00000000'], [40, '90.00000000']] as const) {
      const { dir } = makeRepo();
      const { a, b } = runTwo(dir, second);
      // The same answer whichever transcript the hook is given, so file order cannot decide it.
      for (const tp of [b, a]) run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: tp }));
      const usages = spoolLines(dir).filter((l) => l.event === 'Usage');
      expect(usages).toHaveLength(2);
      for (const u of usages) {
        expect(u.tokens['claude-opus-5-5'].messages).toBe(3);
        expect(u.runs).toBe(2);
        expect(u.costUSD, `second run ${second}`).toBe(expected); // $30 + the second run + m2's 1M output at $20
      }
    }
  });

  it('places every message in its own run and prices only what came after that run\'s last checkpoint', () => {
    // Worked out by hand. Opus output is $20 per million tokens.
    const { dir } = makeRepo();
    const at = (hhmm: string) => `2026-10-10T${hhmm}:00Z`;
    const msg = (id: string, ts: string | undefined) => JSON.stringify({ type: 'assistant', ...(ts ? { timestamp: ts } : {}), message: { id, model: 'claude-opus-5-5', usage: U(0, 1_000_000) } });
    const cp = (total: number, start: string, lines: number, ms: number) => JSON.stringify({ type: 'cost-state', totalCostUSD: total, startTime: Date.parse(start),
      totalDuration: ms, totalLinesAdded: lines, modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, costUSD: total } } });
    const folder = path.join(dir, 'projects', '-repo');
    mkdirSync(folder, { recursive: true });
    const tp = path.join(folder, 'runs.jsonl');
    writeFileSync(tp, [
      msg('pre', '2026-10-09T23:00:00Z'), // before any run started: priced ($20)
      msg('a1', at('00:01')), cp(5, at('00:00'), 1, 40),   // run A, first checkpoint
      msg('a2', at('00:02')), cp(10, at('00:00'), 3, 100), // run A, latest checkpoint covers a1 and a2
      msg('a3', at('00:03')), // run A, after its last checkpoint: priced ($20)
      msg('b1', at('00:20')), cp(7, at('00:10'), 4, 50),   // run B started 00:10 from zero; covers b1
      msg('b2', at('00:40')), // run B, after its checkpoint: priced ($20)
      msg('nots', undefined), // no timestamp: cannot be placed, not priced
    ].join('\n') + '\n');
    run(dir, '.claude/hooks/devlog.mjs', [], JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: tp }));
    const u = spoolLines(dir).find((l) => l.event === 'Usage');
    expect(u.tokens['claude-opus-5-5'].messages).toBe(7);
    expect(u.runs).toBe(2);
    expect(u.costUSD).toBe('77.00000000'); // 10 + 7 + 20 (pre) + 20 (a3) + 20 (b2)
    expect(u.checkpoint).toMatchObject({ costUSD: '17.00000000', linesAdded: 7, durationMs: 150 });
    expect(u.checkpoint.models['claude-opus-5-5'].costUSD).toBe('17.00000000');
    run(dir, 'scripts/devlog-flush.mjs', []);
    const flushed = readdirSync(path.join(dir, 'devlog/activity')).map((f) => readFileSync(path.join(dir, 'devlog/activity', f), 'utf8')).join('');
    expect(JSON.parse(flushed.trim().split('\n').find((l) => l.includes('"Usage"'))!)).toMatchObject({ runs: 2, costUSD: '77.00000000' });
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
      { ts: '2026-10-10T00:00:08Z', session: 's', event: 'SessionStart', via: 'fallback' },
      { ts: '2026-10-10T00:00:09Z', session: 's', event: 'SessionStart', via: 'leak', fallback: 'leak' },
      { ts: '2026-10-10T00:00:10Z', session: 's', event: 'SessionStart', fallback: 'outdated' },
    ];
    writeFileSync(path.join(dir, 'devlog/.spool/s.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(run(dir, 'scripts/devlog-flush.mjs', []).status).toBe(0);
    const out = readdirSync(path.join(dir, 'devlog/activity')).map((f) => readFileSync(path.join(dir, 'devlog/activity', f), 'utf8')).join('');
    const parsed = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.event)).toEqual(['Task', 'Incident', 'Usage', 'Alert', 'SessionStart', 'SessionStart', 'PostToolUse', 'SessionStart', 'SessionStart', 'SessionStart']);
    expect(out).not.toMatch(/secret|dropped|leak|not-an-id|0412345678|abcdef0123456789/);
    expect(parsed[3].key).toBe('2026-10-10T00:00:01.000Z');
    expect(parsed[5].branch).toBe('claude/dev-control-tower-v2');
    expect(parsed[6]).not.toHaveProperty('ms');
    expect(parsed[7].via).toBe('fallback'); // logged by the fallback hook (lesson L-020)
    expect(parsed[8]).not.toHaveProperty('via');
    expect(parsed[8]).not.toHaveProperty('fallback');
    expect(parsed[9].fallback).toBe('outdated');
  });
});

describe('control tower report', () => {
  it('folds the board, splits a session\'s cost between its tasks exactly, links incidents to guarded lessons, and finds logging gaps', () => {
    const { dir, git } = makeRepo();
    const commit = (date: string, session: string, msg: string) => {
      writeFileSync(path.join(dir, `f${date}`), date);
      git('add', '-A');
      gitAt(dir, ['commit', '-q', '-m', `${msg}\n\nClaude-Session: https://claude.ai/code/${session}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    };
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const ev = (o: object) => JSON.stringify({ session: 'session_01A', ...o });
    writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), [
      ev({ ts: '2026-10-10T00:00:00Z', event: 'SessionStart', source: 'startup', via: 'fallback' }),
      ev({ ts: '2026-10-10T00:00:30Z', event: 'SessionStart', source: 'resume', via: 'fallback' }), // the same session again: shown once
      ev({ ts: '2026-10-10T00:00:40Z', event: 'SessionStart', source: 'startup', session: 'session_01D', fallback: 'installed' }),
      ev({ ts: '2026-10-10T00:00:50Z', event: 'SessionStart', source: 'startup', session: 'session_01C', fallback: 'missing' }), // the latest check
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
    expect(r.attention.filter((a: { text: string }) => a.text.includes('was opened outside the repository'))).toEqual([{ level: 'info', text: 'Session sion_01A was opened outside the repository on 2026-10-10; the fallback hook logged it (lesson L-020).' }]);
    expect(r.attention.filter((a: { text: string }) => a.text.includes('found the fallback hook'))).toEqual([expect.objectContaining({ level: 'warning', text: expect.stringContaining('(sion_01C, 2026-10-10) found the fallback hook missing') })]);
    // A later start that found an install from another branch: still logging, so information, not a warning.
    writeFileSync(path.join(dir, 'devlog/.spool/b.jsonl'), JSON.stringify({ ts: '2026-10-10T00:01:10Z', session: 'session_01E', event: 'SessionStart', fallback: 'outdated' }) + '\n');
    run(dir, 'scripts/devlog-report.mjs', ['--json', out]);
    const later = JSON.parse(readFileSync(out, 'utf8')).attention.filter((a: { text: string }) => a.text.includes('latest cloud session'));
    expect(later).toEqual([expect.objectContaining({ level: 'info', text: expect.stringContaining('(sion_01E, 2026-10-10) found the installed fallback hook differs') })]);
  }, REPO_TIMEOUT);

  it('flags a task id started for two pieces of work, and refuses to start a known id for something else', () => {
    const { dir } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    // Two sessions on separate branches each took the next free id; merging brought both together.
    writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), [
      { ts: '2026-10-10T00:01:00Z', session: 'session_01A', event: 'Task', action: 'start', id: 'T-9', title: 'Client portal' },
      { ts: '2026-10-10T00:02:00Z', session: 'session_01B', event: 'Task', action: 'start', id: 'T-9', title: 'Fresh container' },
      // Finishing either piece of work does not hide that the record mixes them.
      { ts: '2026-10-10T00:03:00Z', session: 'session_01A', event: 'Task', action: 'start', id: 'T-7', title: 'Portal' },
      { ts: '2026-10-10T00:04:00Z', session: 'session_01B', event: 'Task', action: 'start', id: 'T-7', title: 'Setup' },
      { ts: '2026-10-10T00:05:00Z', session: 'session_01B', event: 'Task', action: 'done', id: 'T-7', status: 'done' },
      // Normal work: the same work started again, differing only in case and spacing, or after a rename.
      { ts: '2026-10-10T00:06:00Z', session: 'session_01A', event: 'Task', action: 'start', id: 'T-8', title: 'Same work' },
      { ts: '2026-10-10T00:07:00Z', session: 'session_01B', event: 'Task', action: 'start', id: 'T-8', title: 'same  Work ' },
      { ts: '2026-10-10T00:08:00Z', session: 'session_01A', event: 'Task', action: 'start', id: 'T-6', title: 'First name' },
      { ts: '2026-10-10T00:09:00Z', session: 'session_01A', event: 'Task', action: 'update', id: 'T-6', title: 'Better name' },
      { ts: '2026-10-10T00:10:00Z', session: 'session_01B', event: 'Task', action: 'start', id: 'T-6', title: 'Better name' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const out = path.join(dir, 'r.json');
    expect(run(dir, 'scripts/devlog-report.mjs', ['--json', out]).status).toBe(0);
    const attention = JSON.parse(readFileSync(out, 'utf8')).attention.filter((a: { text: string }) => a.text.includes('different pieces of work'));
    expect(attention).toEqual([
      { level: 'warning', text: 'T-9 was started for 2 different pieces of work (Client portal; Fresh container): its record mixes them. Give each its own id.' },
      { level: 'info', text: 'T-7 was started for 2 different pieces of work (Portal; Setup): its record mixes them. Give each its own id.' },
    ]);
    const spool = () => readdirSync(path.join(dir, 'devlog/.spool')).map((f) => readFileSync(path.join(dir, 'devlog/.spool', f), 'utf8')).join('');
    const before = spool();
    const refused = run(dir, 'scripts/devlog-task.mjs', ['start', 'T-9', '--title', 'Something else']);
    expect([refused.status, refused.stderr.trim()]).toEqual([1, 'T-9 is already "Fresh container". Choose a new id.']);
    const reused = run(dir, 'scripts/devlog-task.mjs', ['start', 'T-7', '--title', 'Another thing']); // done, but still its own work
    expect([reused.status, reused.stderr.trim()]).toEqual([1, 'T-7 is already "Setup". Choose a new id.']);
    expect(spool()).toBe(before); // a refused start records nothing
    expect(run(dir, 'scripts/devlog-task.mjs', ['start', 'T-8', '--title', 'SAME WORK']).status).toBe(0);
    expect(run(dir, 'scripts/devlog-task.mjs', ['start', 'T-6', '--title', 'Better name']).status).toBe(0);
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

describe('branch and fork audit', () => {
  /** A throwaway repo with an origin, where each branch is one of the cases the audit must tell apart. */
  function branchRepo() {
    const { dir, git } = makeRepo();
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/progress.ts'), read('src/progress.ts'));
    // Few processes: a branch is one commit-tree and one ref, and every branch goes to origin in one push.
    const commit = (msg: string, date = '2026-10-10T00:00:00Z') => gitAt(dir, ['commit', '-q', '--allow-empty', '-m', msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    commit('base'); git('add', '-A'); commit('tooling');
    const origin = freshDir('origin-bare');
    gitAt(dir, ['init', '-q', '--bare', origin]);
    git('remote', 'add', 'origin', origin);
    const onMain = (msg: string, date = '2026-10-10T00:00:00Z') => gitAt(dir, ['commit-tree', 'main^{tree}', '-p', 'main', '-m', msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }).trim();
    const branch = (name: string, msg?: string, date?: string) => git('branch', name, msg ? onMain(msg, date) : 'main');
    branch('claude/phase-2-workflow', 'phase 2 work');
    branch('claude/old-default', 'old default');
    git('merge', '-q', '--no-edit', 'claude/phase-2-workflow', 'claude/old-default');
    branch('claude/phase-9-mystery', 'phase 9?');
    branch('feature/side-project', 'unplanned', '2026-09-01T00:00:00Z');
    branch('claude/session-abc', 'task work');
    branch('claude/by-title', 'titled work');        // plan only through its PR title
    branch('claude/mentions-phase', 'regression fix'); // PR title only mentions a phase
    branch('claude/closed-pr', 'abandoned');          // PR titled with a phase but closed unmerged
    branch('claude/task-pr', 'task via pr');          // linked to a task through the task's PR
    branch('claude/open-pr', 'in review');            // unmerged, with an open PR
    branch('claude/squashed', 'squash-merged');       // its PR was squash-merged: not an ancestor of main
    branch('claude/fresh');                           // just created: no commits of its own
    branch('claude/phase-CT-console', 'control tower'); // plan id CT, upper case in the name
    git('push', '-q', 'origin', '--all');
    const localSha = onMain('never pushed'); git('branch', 'local-only', localSha);
    git('fetch', '-q', '--prune', 'origin');
    const sha = (b: string) => git('rev-parse', `origin/${b}`).trim();
    const pr = (number: number, head: string, title: string, state: string, merged = false) => ({ number, head, title, state, html_url: `https://github.com/o/r/pull/${number}`, created_at: '2026-10-10T00:00:00Z', merged_at: merged ? '2026-10-10T00:00:00Z' : null, head_sha: sha(head), findings: [] });
    writeFileSync(path.join(dir, 'prs.json'), JSON.stringify([
      pr(1, 'claude/by-title', 'Phase 3: Stitching', 'open'),
      pr(2, 'claude/mentions-phase', 'Fix regression from Phase 2', 'open'),
      pr(3, 'claude/closed-pr', 'Phase 1: abandoned attempt', 'closed'),
      pr(4, 'claude/task-pr', 'Board tooling', 'open'),
      pr(5, 'claude/open-pr', 'Phase 4: resilience', 'open'),
      pr(6, 'claude/squashed', 'Phase 5: journey', 'closed', true),
    ]));
    writeFileSync(path.join(dir, 'devlog/repo.json'), JSON.stringify({ fullName: 'o/r', defaultBranch: 'claude/old-default', forksCount: 2, checkedAt: '2026-10-10T00:00:00Z',
      forks: [{ fullName: 'someone/r', url: 'https://github.com/someone/r', branches: [{ name: 'main', sha: sha('main') }, { name: 'hack', sha: 'f'.repeat(40) }, { name: 'odd', sha: 'HEAD' }, { name: 'local', sha: localSha }] }] }));
    run(dir, 'scripts/devlog-task.mjs', ['start', 'T-9', '--title', 'Session task', '--branch', 'claude/session-abc']);
    run(dir, 'scripts/devlog-task.mjs', ['start', 'T-10', '--title', 'Tooling', '--pr', '4']);
    const report = () => {
      const out = path.join(dir, 'r.json');
      expect(run(dir, 'scripts/devlog-report.mjs', ['--prs', path.join(dir, 'prs.json'), '--json', out]).status).toBe(0);
      return JSON.parse(readFileSync(out, 'utf8'));
    };
    return { dir, report };
  }

  it('classes every branch as the trunk, part of the plan, task-only or a fork, and flags merged, stale and default-branch problems', () => {
    const { report } = branchRepo();
    const r = report();
    const by = (n: string) => r.branches.branches.find((b: { name: string }) => b.name === n);
    expect(by('main')).toMatchObject({ cls: 'trunk', merged: false, flags: [] });
    expect(by('claude/phase-2-workflow')).toMatchObject({ cls: 'plan', merged: true, plan: 'Phase 2: Workflow Skeleton', flags: ['merged: can be deleted'] });
    expect(by('claude/phase-9-mystery')).toMatchObject({ cls: 'fork' });
    expect(by('claude/phase-9-mystery').reasons.join(' ')).toContain('not in the plan');
    expect(by('feature/side-project')).toMatchObject({ cls: 'fork', ahead: 1 });
    expect(by('feature/side-project').flags.join(' ')).toMatch(/unmerged, no open PR.*no commit for \d+ days/);
    expect(by('claude/session-abc')).toMatchObject({ cls: 'task', plan: 'Task T-9' });
    expect(by('claude/by-title')).toMatchObject({ cls: 'plan', plan: 'Phase 3: Stitching And Outbound Deliverability (#1)' });
    expect(by('claude/mentions-phase')).toMatchObject({ cls: 'fork' });
    expect(by('claude/closed-pr')).toMatchObject({ cls: 'fork' });
    expect(by('claude/task-pr')).toMatchObject({ cls: 'task', plan: 'Task T-10' });
    expect(by('claude/open-pr').flags).toEqual([]);
    expect(by('claude/squashed')).toMatchObject({ merged: true, flags: ['merged: can be deleted'] });
    expect(by('claude/fresh')).toMatchObject({ merged: false, flags: ['no new commits'] });
    expect(by('claude/phase-CT-console')).toMatchObject({ cls: 'plan', plan: 'Phase CT: Control Tower' });
    expect(by('claude/old-default')).toMatchObject({ merged: true, flags: ['default branch is not the trunk', 'merged: change the default branch first, then it can be deleted'] });
    const fork = Object.fromEntries(r.branches.forks[0].branches.map((b: { name: string; inSync: boolean }) => [b.name, b.inSync]));
    expect(fork).toEqual({ main: true, hack: false, odd: false, local: false }); // a commit only in a local clone is not on any branch here
    expect(r.branches.uninspectedForks).toBe(1);
    const text = r.attention.map((a: { text: string }) => a.text).join('\n');
    for (const want of ['default branch on GitHub is claude/old-default', 'branch(es) are not part of the plan', 'claude/phase-9-mystery (', 'feature/side-project (', 'claude/mentions-phase (', 'claude/closed-pr (', 'justified only by a board task', 'claude/old-default only after the default branch is changed', 'someone/r:hack', '1 GitHub fork(s) of the repository have not been inspected']) {
      expect(text).toContain(want);
    }
    expect(text).not.toMatch(/can be deleted by the owner: [^;]*claude\/old-default/); // never listed for deletion before the default changes
  }, REPO_TIMEOUT);

  it('runs no audit and flags nothing when the trunk cannot be found', () => {
    const { dir, report } = branchRepo();
    const cfg = JSON.parse(readFileSync(path.join(dir, 'devlog/control-tower.json'), 'utf8'));
    cfg.branches.trunk = 'master';
    writeFileSync(path.join(dir, 'devlog/control-tower.json'), JSON.stringify(cfg));
    const r = report();
    expect(r.branches.error).toContain('origin/master is missing');
    expect(r.branches.branches).toEqual([]);
    expect(r.attention.map((a: { text: string }) => a.text).join('\n')).not.toContain('can be deleted');
  }, REPO_TIMEOUT);

  it('builds its repositories without the machine\'s git config, so no commit waits on a signing program', () => {
    // Config like a cloud container's, with a signer that fails, both in a global file and passed in the
    // environment: a commit that read either would fail outright.
    const cfg = path.join(freshDir('gitconfig'), 'config');
    writeFileSync(cfg, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n');
    const hostile: Record<string, string> = { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: 'false' };
    const was = Object.fromEntries(Object.keys(hostile).map((k) => [k, process.env[k]]));
    const signFails = (env: Record<string, string | undefined>) => {
      const r = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: makeRepo().dir, encoding: 'utf8', env: { ...process.env, ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      return r.status !== 0 && r.stderr.includes('gpg failed to sign');
    };
    Object.assign(process.env, hostile);
    try {
      // Each source bites on its own, without the tests' own git environment.
      expect(signFails({ GIT_CONFIG_COUNT: '0' })).toBe(true);
      expect(signFails({ GIT_CONFIG_GLOBAL: devNull })).toBe(true);
      const dir = makeRepo().dir;
      gitAt(dir, ['commit', '-q', '--allow-empty', '-m', 'x']); // the path every other test commits through
      expect(gitAt(dir, ['log', '--format=%G?']).trim()).toBe('N'); // not signed
      const { report } = branchRepo();
      expect(report().branches.branches).toHaveLength(14);
    } finally {
      for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, REPO_TIMEOUT);

  it('keeps a branch name out of git when it holds a long number', () => {
    const { dir } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    writeFileSync(path.join(dir, 'devlog/.spool/s.jsonl'), JSON.stringify({ ts: '2026-10-10T00:00:00Z', session: 's', event: 'SessionStart', branch: 'claude/call-60123456789' }) + '\n');
    run(dir, 'scripts/devlog-flush.mjs', []);
    const out = readdirSync(path.join(dir, 'devlog/activity')).map((f) => readFileSync(path.join(dir, 'devlog/activity', f), 'utf8')).join('');
    expect(out).not.toContain('60123456789');
  });
});

// ---------------------------------------------------------------------------------------------
// Audit and playback (the D3ngineering blueprint applied here): a decisions register, a tamper-evident activity log,
// health that never reads green on what it cannot see, and a playback of every recorded step.
describe('audit and playback', () => {
  const report = (dir: string) => {
    const out = path.join(dir, 'r.json');
    expect(run(dir, 'scripts/devlog-report.mjs', ['--json', out]).status).toBe(0);
    return JSON.parse(readFileSync(out, 'utf8'));
  };

  it('records an owner decision in an append-only register, with the day it was made, and refuses a day that is not real or still to come', () => {
    const { dir } = makeRepo();
    const ok = run(dir, 'scripts/devlog-task.mjs', ['decision', '--title', 'Keep #46 and close #47', '--on', '2026-10-11', '--ref', '#46']);
    expect(ok.stdout).toMatch(/Recorded DEC-\d{8}-[0-9a-f]{4}\./);
    // Up to a day ahead of UTC is today somewhere (Kuala Lumpur, before 08:00); later than that is refused.
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    expect(run(dir, 'scripts/devlog-task.mjs', ['decision', '--title', 'Made this morning in Kuala Lumpur', '--on', tomorrow]).status).toBe(0);
    expect(run(dir, 'scripts/devlog-task.mjs', ['decision', '--title', 'Not yet made', '--on', later]).status).toBe(1);
    for (const bad of [['decision', '--on', '2026-10-11'], ['decision', '--title', 'x', '--on', '2026-02-30'], ['decision', '--title', 'x', '--on', '2999-01-01'], ['decision', '--title', 'x', '--colour', 'red']]) {
      expect(run(dir, 'scripts/devlog-task.mjs', bad).status, bad.join(' ')).toBe(1);
    }
    expect(run(dir, 'scripts/devlog-flush.mjs', []).status).toBe(0);
    const r = report(dir);
    const kept = r.decisions.find((x: { title: string }) => x.title === 'Keep #46 and close #47');
    expect(kept).toMatchObject({ on: '2026-10-11', by: 'owner', ref: '#46' });
    expect(kept.id).toMatch(/^DEC-\d{8}-[0-9a-f]{4}$/);
    expect(r.decisions).toHaveLength(2);
    expect(r.timeline.filter((x: { k: string }) => x.k === 'decision')).toHaveLength(2);
  });

  it('keeps only known fields of a decision when flushing, and drops one with no title or a malformed id', () => {
    const { dir } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const lines = [
      { ts: '2026-10-10T00:00:00Z', session: 's', event: 'Decision', id: 'DEC-20261010-abcd', on: '2026-10-09', title: 'Agent leg skips the gate', by: 'owner', note: 'dropped' },
      { ts: '2026-10-10T00:00:01Z', session: 's', event: 'Decision', id: 'DEC-1', on: '2026-10-09', title: 'Bad id' },
      { ts: '2026-10-10T00:00:02Z', session: 's', event: 'Decision', id: 'DEC-20261010-abce', on: '2026-10-09' },
    ];
    writeFileSync(path.join(dir, 'devlog/.spool/s.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(run(dir, 'scripts/devlog-flush.mjs', []).status).toBe(0);
    const out = readdirSync(path.join(dir, 'devlog/activity')).map((f) => readFileSync(path.join(dir, 'devlog/activity', f), 'utf8')).join('');
    expect(out.trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ ts: '2026-10-10T00:00:00.000Z', session: 's', event: 'Decision', id: 'DEC-20261010-abcd', on: '2026-10-09', title: 'Agent leg skips the gate', by: 'owner' }]);
  });

  it('flags an activity file changed or deleted after it was committed, accepts a change only at the exact content a recorded decision accepted, and is unavailable without git', () => {
    const { dir, git } = makeRepo();
    const act = (name: string, body: string) => { mkdirSync(path.join(dir, 'devlog/activity'), { recursive: true }); writeFileSync(path.join(dir, 'devlog/activity', name), body); };
    act('a.jsonl', '{"x":1}\n'); act('b.jsonl', '{"x":2}\n');
    git('add', '-A'); git('commit', '-q', '-m', 'log');
    act('c.jsonl', '{"x":3}\n'); // not committed yet: new, not a failure
    let r = report(dir);
    expect(r.health.integrity).toMatchObject({ state: 'green', checked: 2, changed: [], deleted: [], pending: 1 });
    act('a.jsonl', '{"x":"edited"}\n'); // an edit, even uncommitted, is caught
    git('add', '-A'); git('commit', '-q', '-m', 'edit the log'); // and committing it does not hide it
    rmSync(path.join(dir, 'devlog/activity/b.jsonl'));
    r = report(dir);
    expect(r.health.integrity).toMatchObject({ state: 'red', changed: ['devlog/activity/a.jsonl'], deleted: ['devlog/activity/b.jsonl'] });
    expect(r.health.checks.find((c: { name: string }) => c.name === 'Activity log integrity').state).toBe('red');
    expect(r.health.overall).toBe('red');
    // Accepted by a decision, at the exact content now there: listed as accepted, no longer a failure.
    const blob = gitAt(dir, ['hash-object', 'devlog/activity/a.jsonl']).trim();
    const accept = (a: Record<string, unknown>) => {
      const cfg = JSON.parse(readFileSync(path.join(dir, 'devlog/control-tower.json'), 'utf8'));
      cfg.integrity = { acceptedChanges: a };
      writeFileSync(path.join(dir, 'devlog/control-tower.json'), JSON.stringify(cfg));
    };
    // An id shaped like a decision is not enough: it must be in the register (lesson L-024).
    accept({ 'devlog/activity/a.jsonl': { blob, decision: 'DEC-20261011-0a0a' }, 'devlog/activity/b.jsonl': { blob: null, decision: 'DEC-20261011-0a0b' } });
    expect(report(dir).health.integrity).toMatchObject({ state: 'red', changed: ['devlog/activity/a.jsonl'], deleted: ['devlog/activity/b.jsonl'] });
    const decide = (title: string) => /Recorded (DEC-\d{8}-[0-9a-f]{4})\./.exec(run(dir, 'scripts/devlog-task.mjs', ['decision', '--title', title, '--on', '2026-10-11', '--ref', 'audit']).stdout)![1]!;
    const d1 = decide('Accept the edit to a.jsonl'); const d2 = decide('Accept the removal of b.jsonl');
    accept({ 'devlog/activity/a.jsonl': { blob, decision: d1 }, 'devlog/activity/b.jsonl': { blob: null, decision: d2 } });
    r = report(dir);
    expect(r.health.integrity).toMatchObject({ state: 'green', changed: [], deleted: [] });
    expect(r.health.integrity.accepted).toEqual([
      { file: 'devlog/activity/a.jsonl', decision: d1, title: 'Accept the edit to a.jsonl', on: '2026-10-11', ref: 'audit', deleted: false },
      { file: 'devlog/activity/b.jsonl', decision: d2, title: 'Accept the removal of b.jsonl', on: '2026-10-11', ref: 'audit', deleted: true },
    ]);
    act('a.jsonl', '{"x":"edited again"}\n'); // a later edit is not covered by the earlier acceptance
    expect(report(dir).health.integrity.changed).toEqual(['devlog/activity/a.jsonl']);
    accept({ 'devlog/activity/a.jsonl': { blob: gitAt(dir, ['hash-object', 'devlog/activity/a.jsonl']).trim() } }); // no decision cited
    expect(report(dir).health.integrity.changed).toEqual(['devlog/activity/a.jsonl']);
    rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    expect(report(dir).health.integrity.state).toBe('unavailable');
  }, REPO_TIMEOUT);

  it('checks a file first committed while resolving a merge, like any other', () => {
    const { dir, git } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/activity'), { recursive: true });
    writeFileSync(path.join(dir, 'base'), '1'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'side'); writeFileSync(path.join(dir, 'side'), '1'); git('add', '-A'); git('commit', '-q', '-m', 'side');
    git('checkout', '-q', 'main'); writeFileSync(path.join(dir, 'main'), '1'); git('add', '-A'); git('commit', '-q', '-m', 'main');
    git('merge', '-q', '--no-commit', 'side');
    writeFileSync(path.join(dir, 'devlog/activity/m.jsonl'), '{"x":1}\n'); // added in the merge itself
    git('add', '-A'); git('commit', '-q', '-m', 'merge side');
    expect(report(dir).health.integrity).toMatchObject({ state: 'green', checked: 1, pending: 0 });
    writeFileSync(path.join(dir, 'devlog/activity/m.jsonl'), '{"x":"edited"}\n');
    git('add', '-A'); git('commit', '-q', '-m', 'edit');
    expect(report(dir).health.integrity).toMatchObject({ state: 'red', changed: ['devlog/activity/m.jsonl'] });
  }, REPO_TIMEOUT);

  it('finds every real key format in a file, and cannot scan without git', () => {
    const dir = freshDir();
    gitAt(dir, ['init', '-q', '-b', 'main']);
    // One planted key per format, each built at run time from fake parts (lesson L-015).
    const keys = [fake('sk', '_live_', 'A'.repeat(12)), fake('xox', 'b-', '1234567-'), fake('A', 'C', 'a'.repeat(32)), fake('gh', 'p_', 'B'.repeat(32)), fake('AK', 'IA', 'C'.repeat(16))];
    keys.forEach((k, i) => writeFileSync(path.join(dir, `k${i}.txt`), `x ${k} x\n`));
    expect(secretHits(dir).map((h: string) => h.split(':')[0]).sort()).toEqual(keys.map((_, i) => `k${i}.txt`));
    expect(secretHits(freshDir())).toBeNull();
  });

  it('judges the tests only by a run from the last day, says it may be of any scope, and calls a helper agent of a quiet session unknown, not stalled', () => {
    const { dir } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const ago = (h: number) => new Date(Date.now() - h * 36e5).toISOString();
    const write = (lines: object[]) => writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), lines.map((l) => JSON.stringify({ session: 'session_01A', ...l })).join('\n') + '\n');
    const check = (name: string) => report(dir).health.checks.find((c: { name: string }) => c.name === name);
    write([{ ts: ago(30), event: 'PostToolUse', tool: 'Bash', target: 'Run tests', kind: 'test' }]);
    expect(check('Tests')).toMatchObject({ state: 'unavailable' }); // passed, but more than a day ago
    write([{ ts: ago(1), event: 'PostToolUseFailure', tool: 'Bash', target: 'Run tests', kind: 'test', failure: 'exit 1' }]);
    expect(check('Tests')).toMatchObject({ state: 'amber' });
    expect(check('Tests').detail).toContain('of any scope');
    // A helper agent started 8 hours ago with no end: stalled while its session is active, unknown once it went quiet.
    const agent = [{ ts: ago(8), event: 'SubagentStart', agentId: 'agent1', agentType: 'review' }];
    write([...agent, { ts: ago(0.1), event: 'PostToolUse', tool: 'Read', target: 'x' }]);
    expect(check('Stalled agents').state).toBe('amber');
    write([...agent, { ts: ago(7), event: 'PostToolUse', tool: 'Read', target: 'x' }]);
    expect(check('Stalled agents')).toMatchObject({ state: 'green' });
    expect(check('Stalled agents').detail).toContain('cannot be judged');
  }, REPO_TIMEOUT);

  it('never calls health green while a check is unavailable, and leaves checks for what is not built out of it', async () => {
    // @ts-expect-error a plain ES module with no type declarations
    const { overallHealth } = await import('../scripts/devlog-report.mjs');
    const c = (state: string) => ({ name: state, state, detail: '' });
    expect(overallHealth([c('green'), c('green')])).toBe('green');
    expect(overallHealth([c('green'), c('unavailable')])).toBe('amber');
    expect(overallHealth([c('green'), c('amber'), c('red')])).toBe('red');
    expect(overallHealth([c('green'), c('off')])).toBe('green');
    expect(overallHealth([c('off')])).toBe('unavailable');
    expect(overallHealth([c('green'), c('something new')])).toBe('amber');
  });

  it('counts each phase\'s exit criteria and open items as written in progress.ts, brackets and quotes inside the text included', async () => {
    // @ts-expect-error a plain ES module with no type declarations
    const { planProgress } = await import('../scripts/devlog-report.mjs');
    const dir = freshDir();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/progress.ts'), `export const PHASES = [
  {
    id: '1', name: 'Journey, QA And Audit', status: 'in_progress',
    criteria: [
      { text: 'A [bracket] and a \\'quote\\'', state: 'met', proof: 'fakes' },
      { text: "It's partly", state: 'partly', proof: 'tests' },
      notMet('Not yet'),
    ], open: ['One with ] inside', "Two's", \`Three\`],
  },
  {
    id: 'CT', name: 'Control Tower', status: 'in_progress',
    criteria: [],
    open: [],
  },
];
export const QUESTIONS = ['Not an open item', 'Nor this'];
`);
    expect(planProgress(dir)).toEqual([
      { id: '1', name: 'Journey, QA and audit', status: 'in_progress', met: 1, partly: 1, notMet: 1, fakes: 1, open: 3 },
      { id: 'CT', name: 'Control Tower', status: 'in_progress', met: 0, partly: 0, notMet: 0, fakes: 0, open: 0 },
    ]);
    expect(planProgress(freshDir())).toEqual([]);
  });

  it('plays back every recorded step in order, never its content: owner messages, actions and how they ended, commits, merges, tasks, incidents and decisions', () => {
    const { dir, git } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    const ev = (o: object) => JSON.stringify({ session: 'session_01A', ...o });
    writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), [
      ev({ ts: '2026-10-10T00:00:00Z', event: 'SessionStart', source: 'startup', branch: 'claude/phase-1-x' }),
      ev({ ts: '2026-10-10T00:00:01Z', event: 'UserPromptSubmit', prompt: 'PRIVATE owner words' }),
      ev({ ts: '2026-10-10T00:00:02Z', event: 'PostToolUse', tool: 'Bash', target: 'Run the tests', kind: 'test' }),
      ev({ ts: '2026-10-10T00:00:03Z', event: 'PostToolUseFailure', tool: 'Edit', target: 'src/a.ts', failure: 'exit 1', error: 'PRIVATE error text' }),
      ev({ ts: '2026-10-10T00:00:04Z', event: 'Task', action: 'start', id: 'T-1', title: 'Build it', status: 'in_progress' }),
      ev({ ts: '2026-10-10T00:00:05Z', event: 'Incident', id: 'INC-20261010-0001', type: 'process', severity: 'low', title: 'Stale', task: 'T-1' }),
      ev({ ts: '2026-10-10T00:00:06Z', event: 'Decision', id: 'DEC-20261010-0001', on: '2026-10-10', title: 'Owner merges', task: 'T-1' }),
    ].join('\n') + '\n');
    writeFileSync(path.join(dir, 'f'), 'x'); git('add', '-A');
    gitAt(dir, ['commit', '-q', '-m', 'Do the work\n\nClaude-Session: https://claude.ai/code/session_01A'], { GIT_AUTHOR_DATE: '2026-10-10T00:00:07Z', GIT_COMMITTER_DATE: '2026-10-10T00:00:07Z' });
    writeFileSync(path.join(dir, 'prs.json'), JSON.stringify([
      { number: 7, title: 'Phase 1: x', state: 'closed', html_url: 'https://github.com/o/r/pull/7', created_at: '2026-10-10T00:00:00Z', merged_at: '2026-10-10T00:00:08Z', findings: [] },
      { number: 8, title: 'Phase 1: y', state: 'closed', html_url: 'https://github.com/o/r/pull/8', created_at: '2026-10-10T00:00:00Z', merged_at: 'not a date', findings: [] }, // left out, never fatal (L-006)
    ]));
    const out = path.join(dir, 'r.json');
    expect(run(dir, 'scripts/devlog-report.mjs', ['--prs', path.join(dir, 'prs.json'), '--json', out]).status).toBe(0);
    const r = JSON.parse(readFileSync(out, 'utf8'));
    const s = r.timelineSessions.findIndex((x: { id: string }) => x.id === 'session_01A');
    expect(r.timeline.map((x: { k: string; s: number; ok?: boolean }) => [x.k, x.s, x.ok])).toEqual([
      ['start', s, undefined], ['prompt', s, undefined], ['test', s, true], ['tool', s, false], ['task', s, undefined],
      ['incident', s, undefined], ['decision', s, undefined], ['commit', s, undefined], ['merge', -1, undefined],
    ]);
    expect(r.timeline[3]).toMatchObject({ d: 'Edit src/a.ts', f: 'exit 1' });
    expect(r.timeline.filter((x: { t?: string }) => x.t === 'T-1').map((x: { k: string }) => x.k)).toEqual(['task', 'incident', 'decision']);
    expect(JSON.stringify(r.timeline)).not.toContain('PRIVATE');
  }, REPO_TIMEOUT);

  it('estimates the saving from model routing exactly, against the baseline model, and gives none when a model has no price', () => {
    const tokens = { 'claude-sonnet-5-5': { messages: 1, input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
    const setup = (dir: string, t: object) => {
      mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
      writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), JSON.stringify({ ts: '2026-10-10T00:00:00Z', session: 'session_01A', event: 'Usage', costUSD: '12.00000000', costBasis: 'checkpoint+since', tokens: t }) + '\n');
    };
    const priced = makeRepo((c) => { c.pricing.perMTokUSD = { 'claude-opus-5-5': { input: '4', output: '20', cacheRead: '0.2', cacheWrite5m: '5', cacheWrite1h: '8' }, 'claude-sonnet-5-5': { input: '2', output: '10', cacheRead: '0.2', cacheWrite5m: '2.5', cacheWrite1h: '4' } }; c.costEstimate = { baselineModel: 'claude-opus-5-5' }; });
    setup(priced.dir, tokens);
    // Worked by hand: Sonnet 1M in x $2 + 1M out x $10 = $12; at Opus prices $4 + $20 = $24; saving $12, half.
    expect(report(priced.dir).economics.routingSaving).toEqual({ baseline: 'claude-opus-5-5', allBaseline: { usd: '24.00000000' }, actual: { usd: '12.00000000' }, saving: { usd: '12.00000000' }, share: 50 });
    const unpriced = makeRepo((c) => { c.costEstimate = { baselineModel: 'claude-opus-5-5' }; });
    setup(unpriced.dir, { 'claude-unknown-9': tokens['claude-sonnet-5-5'] });
    expect(report(unpriced.dir).economics.routingSaving).toBeNull();
  }, REPO_TIMEOUT);

  it('builds the dashboard with the Daythree tokens and every element through the DOM, never from markup', () => {
    const template = read('devlog/dashboard.html');
    expect(template).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    for (const token of ['--d3-purple: #5D3FD3', '--d3-red: #C8102E', '--ink-muted: #6B6C70', '"Source Sans 3"']) expect(template).toContain(token);
    expect(template).not.toMatch(/text-transform:\s*(uppercase|capitalize)/); // sentence case only
  });
});

// ---------------------------------------------------------------------------------------------
// Model routing by process (ADR-0014): what Claude Code recorded about each helper agent, what the session declared, and
// the owner's escalation threshold. Timestamps are fixed, so nothing here depends on when the suite runs (lesson L-037).
describe('routing and escalation', () => {
  type Line = Record<string, unknown>;
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const OPUS = 'claude-opus-5-5';
  const SONNET = 'claude-sonnet-5-5';
  const HAIKU = 'claude-haiku-5-5';
  const tok = (output: number, input = 0, extra: Record<string, number> = {}) => ({ messages: 1, input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...extra });
  const task = (id: string, start: number, done?: number): Line[] => [
    { ts: iso(start), event: 'Task', action: 'start', id, title: `Work ${id}`, status: 'in_progress' },
    ...(done === undefined ? [] : [{ ts: iso(done), event: 'Task', action: 'done', id, status: 'done', progress: 100 }]),
  ];
  const agent = (agentId: string, process: string, taskId: string, model: string, min: number, extra: Line = {}): Line => ({
    ts: iso(min + 2), event: 'AgentRun', agentId, agentType: 'general-purpose', requested: 'sonnet', process, task: taskId,
    first: iso(min), last: iso(min + 1), tokens: { [model]: tok(1000) }, ...extra,
  });
  const outcome = (min: number, o: Line): Line => ({ ts: iso(min), event: 'Outcome', ...o });
  const tool = (min: number, o: Line): Line => ({ ts: iso(min), event: 'PostToolUse', tool: 'Bash', target: 'Run tests', ...o });
  const testRun = (min: number, ok: boolean, extra: Line = {}): Line => tool(min, { event: ok ? 'PostToolUse' : 'PostToolUseFailure', kind: 'test', ...(ok ? {} : { failure: 'exit 1' }), ...extra });
  const seed = (dir: string, lines: Line[]) => {
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    writeFileSync(path.join(dir, 'devlog/.spool/a.jsonl'), lines.map((l) => JSON.stringify({ session: 'session_01A', ...l })).join('\n') + '\n');
  };
  const reportOf = (dir: string) => {
    const out = path.join(dir, 'r.json');
    const r = run(dir, 'scripts/devlog-report.mjs', ['--json', out]);
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(readFileSync(out, 'utf8'));
  };
  const row = (r: any, process: string) => r.routing.processes.find((p: { process: string }) => p.process === process);
  const check = (r: any) => r.health.checks.find((c: { name: string }) => c.name === 'Routing');
  const attention = (r: any) => r.attention.map((a: { text: string }) => a.text).join('\n');

  it('counts an item as escalated only when a later agent of the same process ran above the floor it started at, by the model Claude Code recorded', () => {
    const { dir } = makeRepo();
    seed(dir, [
      ...task('T-A', 0, 100), agent('a1', 'build', 'T-A', SONNET, 1), agent('a2', 'build', 'T-A', OPUS, 10, { trigger: 'suite_failed' }), testRun(5, false),
      ...task('T-B', 0, 110), agent('b1', 'build', 'T-B', SONNET, 2),
      // Started above the floor: counted apart, never as an escalation.
      ...task('T-C', 0, 120), agent('c1', 'build', 'T-C', OPUS, 3, { requested: 'opus' }), agent('c2', 'build', 'T-C', OPUS, 12),
      // Asked for opus the second time and was served sonnet: the record is the served model.
      ...task('T-E', 0, 130), agent('e1', 'build', 'T-E', SONNET, 4), agent('e2', 'build', 'T-E', SONNET, 14, { requested: 'opus' }),
    ]);
    const r = reportOf(dir);
    expect(row(r, 'build')).toMatchObject({
      items: 4, startedAtFloor: 3, startedAbove: 1, startedBelow: 0, escalatedItems: 1, finishedAtFloor: { n: 2, of: 4 },
      escalation: { state: 'collecting', escalated: 1, window: 3, need: 20 },
    });
    expect(r.routing.log).toEqual([expect.objectContaining({ task: 'T-A', round: 2, fromModel: SONNET, toModel: OPUS, fromTier: 'mid', toTier: 'high', trigger: 'suite_failed' })]);
    expect(r.routing.log).toHaveLength(1);
  }, REPO_TIMEOUT);

  it('turns amber only past the owner\'s threshold over 20 finished items, and is collecting before that', () => {
    // N finished items that started on Sonnet (the build floor); the listed ones then went to Opus.
    const scenario = (total: number, climbed: number[]) => {
      const { dir } = makeRepo();
      seed(dir, Array.from({ length: total }, (_, i) => [
        ...task(`T-${i}`, 0, 1000 + i), agent(`s${i}`, 'build', `T-${i}`, SONNET, 1 + i * 10),
        ...(climbed.includes(i) ? [agent(`o${i}`, 'build', `T-${i}`, OPUS, 5 + i * 10, { trigger: 'suite_failed' })] : []),
      ]).flat());
      return reportOf(dir);
    };
    const six = scenario(20, [0, 1, 2, 3, 4, 5]); // 600 is not over 30% of 20 (600)
    expect(row(six, 'build').escalation).toMatchObject({ state: 'green', escalated: 6, window: 20, need: 20, overPercent: 30 });
    expect(check(six)).toMatchObject({ state: 'green' });
    const seven = scenario(20, [0, 1, 2, 3, 4, 5, 6]); // 700 is over 600
    expect(row(seven, 'build').escalation).toMatchObject({ state: 'amber', escalated: 7, window: 20 });
    expect(check(seven)).toMatchObject({ state: 'amber' });
    expect(seven.routing.state).toBe('amber');
    expect(attention(seven)).toContain('Build: 7 of the last 20 items that started at or escalated from the floor climbed above it, over 30%: the floor may be too low; routing changes only on your decision.');
    const few = scenario(19, [0, 1, 2, 3, 4, 5, 6]); // seven of 19 would be 36%, but 19 items is too few to judge
    expect(row(few, 'build').escalation).toMatchObject({ state: 'collecting', escalated: 7, window: 19, need: 20 });
    expect(check(few)).toMatchObject({ state: 'green' });
    expect(check(few).detail).toContain('collecting 19 of 20');
    expect(attention(few)).not.toContain('climbed above it');
    // Only the last 20 finished items count: the oldest climbed, so the window holds six.
    const older = scenario(21, [0, 1, 2, 3, 4, 5, 6]);
    expect(row(older, 'build').escalation).toMatchObject({ state: 'green', escalated: 6, window: 20 });
  }, 30_000);

  it('shows a trigger as the session declared it, and says whether a record supports it', () => {
    const { dir } = makeRepo();
    // Each task has a window of its own, so one task's tool records never support another's trigger.
    const climb = (id: string, base: number, trigger?: string) => [
      ...task(id, base, base + 90), agent(`${id}-1`, 'build', id, SONNET, base + 1), agent(`${id}-2`, 'build', id, OPUS, base + 20, trigger ? { trigger } : {}),
    ];
    seed(dir, [
      ...climb('T-S1', 0, 'suite_failed'), testRun(10, false),
      ...climb('T-S2', 100, 'suite_failed'), testRun(110, false, { expectRed: true }), testRun(111, true), // a run expected to fail, and one that passed
      ...climb('T-D1', 200, 'deny_path_touched'), tool(210, { tool: 'Edit', target: 'src/money.ts' }),
      ...climb('T-D2', 300, 'deny_path_touched'), tool(310, { tool: 'Edit', target: 'src/other.ts' }),
      ...climb('T-R', 400, 'review_failed'), outcome(410, { task: 'T-R', process: 'review', result: 'failed', round: 1 }),
      ...climb('T-B', 500, 'builder_blocked'), outcome(510, { task: 'T-B', process: 'review', result: 'failed', round: 1 }), // a review does not block a builder
      ...climb('T-N', 600),
      ...task('T-X', 700, 790), agent('X-1', 'build', 'T-X', SONNET, 701), agent('X-2', 'build', 'T-X', SONNET, 720, { trigger: 'builder_blocked' }),
    ]);
    const r = reportOf(dir);
    const log = new Map<string, any>(r.routing.log.map((c: { task: string }) => [c.task, c]));
    expect([...log.keys()].sort()).toEqual(['T-B', 'T-D1', 'T-D2', 'T-N', 'T-R', 'T-S1', 'T-S2']);
    expect(Object.fromEntries([...log].map(([t, c]) => [t, [c.trigger, c.support]]))).toEqual({
      'T-S1': ['suite_failed', 'recorded'], 'T-S2': ['suite_failed', 'none'],
      'T-D1': ['deny_path_touched', 'recorded'], 'T-D2': ['deny_path_touched', 'none'],
      'T-R': ['review_failed', 'declared'], 'T-B': ['builder_blocked', 'none'], 'T-N': [null, 'none'],
    });
    expect(r.routing.consistency).toMatchObject({ climbsWithoutTrigger: 1, triggersWithoutClimb: 1, unsupported: 3, unknownTasks: 0, tagged: 16, untagged: 0 });
    expect(row(r, 'build').topTriggers.find((t: { trigger: string }) => t.trigger === 'not declared')).toEqual({ trigger: 'not declared', n: 1 });
  }, REPO_TIMEOUT);

  it('says unavailable, not zero, for a process no helper agent has recorded, and counts helper agents from before recording began', () => {
    const { dir } = makeRepo();
    const start = (min: number, agentId: string): Line => ({ ts: iso(min), event: 'SubagentStart', agentType: 'general-purpose', agentId });
    seed(dir, [start(0, 'p1'), start(1, 'p2'), start(2, 'p3'), ...task('T-A', 5), agent('a1', 'build', 'T-A', SONNET, 10), start(15, 'p4')]);
    const r = reportOf(dir);
    // p4 started after the first record but has none of its own, and p1 to p3 started before: all four are unrecorded.
    expect(r.routing).toMatchObject({ since: iso(12), agentsBefore: 4, state: 'green' });
    expect(row(r, 'build')).toMatchObject({ recorded: true, items: 1 });
    expect(row(r, 'fix')).toMatchObject({
      recorded: false, items: null, startedAtFloor: null, startedAbove: null, finishedAtFloor: null, tokensByTier: null, topTriggers: null, cost: null,
      escalation: { state: 'unavailable', reason: 'not_recorded' },
    });
    expect(row(r, 'plan')).toMatchObject({ items: null, escalation: { state: 'not_laddered' } });
    // Before any agent was recorded: everything is unknown and the view is off, never green.
    const empty = makeRepo();
    seed(empty.dir, [start(0, 'p1'), start(1, 'p2')]);
    const e = reportOf(empty.dir);
    expect(e.routing).toMatchObject({ since: null, agentsBefore: 2, state: 'off' });
    expect(e.routing.processes.every((p: { items: unknown }) => p.items === null)).toBe(true);
    expect(check(e)).toMatchObject({ state: 'off' });
  }, REPO_TIMEOUT);

  it('prices each process\'s tokens exactly and never adds them to the session\'s spend', () => {
    const { dir } = makeRepo();
    // Worked by hand at the configured prices (USD per million tokens). Sonnet: input 2, output 10, cache read 0.20,
    // cache write 2.50 (5 minutes) and 4 (1 hour). Opus: input 4, output 20.
    // Build agent 1 on Sonnet: 123,456 in = 0.246912; 654,321 out = 6.54321; 1,000,000 read = 0.20; 400,000 w5m = 1.00;
    // 250,000 w1h = 1.00; total 8.990122. Build agent 2: 1,000,000 in + 1,000,000 out = 2 + 10 = 12.
    // Both: 20.990122. Median of their token totals (2,427,777 and 2,000,000), the lower middle: 2,000,000.
    // Review on Opus: 1,000,000 in + 100,000 out = 4 + 2 = 6.00. Untagged on Opus: 50,000 out = 1.00.
    // The session also holds 1,000,000 Sonnet input (2.00) and 1,000,000 Opus output (20.00) of its own.
    seed(dir, [
      ...task('T-A', 0),
      agent('b1', 'build', 'T-A', SONNET, 1, { tokens: { [SONNET]: tok(654321, 123456, { cacheRead: 1_000_000, cacheWrite5m: 400_000, cacheWrite1h: 250_000 }) } }),
      agent('b2', 'build', 'T-A', SONNET, 5, { tokens: { [SONNET]: tok(1_000_000, 1_000_000) } }),
      agent('r1', 'review', 'T-A', OPUS, 9, { tokens: { [OPUS]: tok(100_000, 1_000_000) } }),
      agent('u1', 'build', 'T-A', OPUS, 12, { process: undefined, task: undefined, tokens: { [OPUS]: tok(50_000) } }),
      agent('c1', 'check', 'T-A', 'claude-unknown-9', 15),
      agent('c2', 'check', 'T-A', HAIKU, 17),
      { ts: iso(30), event: 'Usage', at: 'Stop', costUSD: '50.00000000', costBasis: 'checkpoint+since', tokens: {
        [SONNET]: tok(1_654_321, 2_123_456, { messages: 3, cacheRead: 1_000_000, cacheWrite5m: 400_000, cacheWrite1h: 250_000 }),
        [OPUS]: tok(1_150_000, 1_000_000, { messages: 3 }),
      } },
    ]);
    const r = reportOf(dir);
    const rows = Object.fromEntries(r.processCost.map((x: { process: string; model: string }) => [`${x.process}|${x.model}`, x]));
    expect(rows[`build|${SONNET}`]).toEqual({ process: 'build', model: SONNET, agents: 2, tokens: 4_427_777, medianTokens: 2_000_000, cost: { usd: '20.99012200' } });
    expect(rows[`review|${OPUS}`]).toEqual({ process: 'review', model: OPUS, agents: 1, tokens: 1_100_000, medianTokens: 1_100_000, cost: { usd: '6.00000000' } });
    expect(rows[`not recorded|${OPUS}`]).toEqual({ process: 'not recorded', model: OPUS, agents: 1, tokens: 50_000, medianTokens: 50_000, cost: { usd: '1.00000000' } });
    // A model with no price is unavailable, not free.
    expect(rows['check|claude-unknown-9']).toMatchObject({ cost: null });
    // The main session is what the session totals hold beyond its helper agents; the exact remainders are priced.
    expect(rows[`main session|${SONNET}`]).toMatchObject({ tokens: 1_000_000, cost: { usd: '2.00000000' } });
    expect(rows[`main session|${OPUS}`]).toMatchObject({ tokens: 1_000_000, cost: { usd: '20.00000000' } });
    // Helper agents with more tokens than their session recorded (Haiku, unknown model): unavailable, never clamped to zero.
    expect(rows[`main session|${HAIKU}`]).toMatchObject({ tokens: null, cost: null });
    expect(row(r, 'build').cost).toEqual({ usd: '20.99012200' });
    expect(row(r, 'check').cost).toBeNull();
    expect(r.economics.spend.usd).toBe('50.00000000'); // Claude Code's own figure for the session, unchanged by the breakdown
  }, REPO_TIMEOUT);

  it('keeps every helper agent\'s record from one stop, not just the first', () => {
    const { dir } = makeRepo();
    // One Stop writes one record per helper agent, all at the same moment.
    seed(dir, [
      ...task('T-A', 0),
      agent('a1', 'build', 'T-A', SONNET, 1, { ts: iso(5) }), agent('a2', 'build', 'T-A', SONNET, 2, { ts: iso(5) }), agent('a3', 'fix', 'T-A', SONNET, 3, { ts: iso(5) }),
      outcome(6, { task: 'T-A', process: 'review', result: 'passed', agent: 'a1', round: 1 }), outcome(6, { task: 'T-A', process: 'review', result: 'failed', agent: 'a2', round: 1 }),
    ]);
    const r = reportOf(dir);
    expect(r.routing.agents.map((a: { agentId: string }) => a.agentId).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(row(r, 'build')).toMatchObject({ agents: 2 });
    expect(row(r, 'review').firstPass).toEqual({ n: 1, of: 2 });
  }, REPO_TIMEOUT);

  it('records a review outcome only for a known task, process and result, and refuses anything else', () => {
    const { dir } = makeRepo();
    const task = (...a: string[]) => run(dir, 'scripts/devlog-task.mjs', a);
    const outcomes = () => spoolLines(dir).filter((l) => l.event === 'Outcome');
    const refused = (args: string[], message: string) => {
      const r = task(...args);
      expect([r.status, r.stderr]).toEqual([1, expect.stringContaining(message)]);
    };
    refused(['start', fake('p', '60123456789'), '--title', 'x'], 'Give a task id');
    refused(['outcome', 'T-1', '--process', 'review', '--result', 'passed'], "T-1 is not on this branch's board. Start it first");
    expect(task('start', 'T-1', '--title', 'Routing work').status).toBe(0);
    refused(['outcome', 'T-1', '--process', 'deploy', '--result', 'passed'], '--process must be one of: plan, review, security-review, build, fix, check.');
    refused(['outcome', 'T-1', '--process', 'review', '--result', 'ok'], '--result must be one of: passed, failed.');
    refused(['outcome', 'T-1', '--process', 'review'], 'outcome needs --result.');
    refused(['outcome', 'T-1', '--result', 'passed'], 'outcome needs --process.');
    refused(['outcome', 'T-1', '--process', 'review', '--result', 'passed', '--agent', 'not an id'], '--agent must be a helper agent\'s id');
    refused(['outcome', 'T-1', '--process', 'review', '--result', 'passed', '--agent', 'x'.repeat(41)], '--agent must be a helper agent\'s id');
    refused(['outcome', 'T-1', '--process', 'build', '--result', 'passed', '--agent', 's1', '--shadow-of', 'a1'], '--shadow-of needs --process review and --agent.');
    refused(['outcome', 'T-1', '--process', 'review', '--result', 'passed', '--shadow-of', 'a1'], '--shadow-of needs --process review and --agent.');
    refused(['outcome', 'T-1', '--process', 'review', '--result', 'passed', '--round', '0'], '--round must be a whole number from 1 to 99.');
    refused(['outcome', 'T-1', '--process', 'review', '--result', 'passed', '--escalate', 'yes'], 'Unknown option: --escalate.');
    expect(outcomes()).toEqual([]); // every refusal recorded nothing
    expect(task('outcome', 'T-1', '--process', 'review', '--result', 'passed', '--agent', 'a1', '--round', '1').status).toBe(0);
    expect(task('outcome', 'T-1', '--process', 'review', '--result', 'failed', '--agent', 's1', '--shadow-of', 'a1').status).toBe(0);
    expect(outcomes()).toEqual([
      expect.objectContaining({ task: 'T-1', process: 'review', result: 'passed', agent: 'a1', round: 1 }),
      expect.objectContaining({ task: 'T-1', process: 'review', result: 'failed', agent: 's1', shadowOf: 'a1' }),
    ]);
  }, 30_000);

  it('records a CI run only for a known task, a pull request, a commit and a result, and refuses anything else', () => {
    const { dir } = makeRepo();
    const task = (...a: string[]) => run(dir, 'scripts/devlog-task.mjs', a);
    const ci = () => spoolLines(dir).filter((l) => l.event === 'CiRun');
    const refused = (args: string[], message: string) => {
      const r = task(...args);
      expect([r.status, r.stderr]).toEqual([1, expect.stringContaining(message)]);
    };
    const ok = ['--pr', '7', '--sha', 'abc1234', '--result', 'failed'];
    refused(['ci', 'T-1', ...ok], "T-1 is not on this branch's board. Start it first");
    expect(task('start', 'T-1', '--title', 'CI work').status).toBe(0);
    refused(['ci', ...ok], 'Give a task id');
    refused(['ci', 'T-1', '--sha', 'abc1234', '--result', 'failed'], 'ci needs --pr.');
    refused(['ci', 'T-1', '--pr', '7', '--result', 'failed'], 'ci needs --sha.');
    refused(['ci', 'T-1', '--pr', '7', '--sha', 'abc1234'], 'ci needs --result.');
    refused(['ci', 'T-1', '--pr', '0', '--sha', 'abc1234', '--result', 'failed'], '--pr must be a whole number from 1 to 1000000.');
    refused(['ci', 'T-1', '--pr', 'seven', '--sha', 'abc1234', '--result', 'failed'], '--pr must be a whole number');
    refused(['ci', 'T-1', '--pr', '7', '--sha', 'ABC1234', '--result', 'failed'], '--sha must be 7 to 40 lowercase hex characters.');
    refused(['ci', 'T-1', '--pr', '7', '--sha', 'abc12', '--result', 'failed'], '--sha must be 7 to 40 lowercase hex characters.');
    refused(['ci', 'T-1', '--pr', '7', '--sha', 'a'.repeat(41), '--result', 'failed'], '--sha must be 7 to 40 lowercase hex characters.');
    refused(['ci', 'T-1', '--pr', '7', '--sha', 'abc1234', '--result', 'green'], '--result must be one of: passed, failed.');
    refused(['ci', 'T-1', ...ok, '--run', '12ab'], '--run must be a GitHub run id');
    refused(['ci', 'T-1', ...ok, '--run', '1'.repeat(21)], '--run must be a GitHub run id');
    refused(['ci', 'T-1', ...ok, '--url', 'https://example.test'], 'Unknown option: --url.');
    expect(ci()).toEqual([]); // every refusal recorded nothing
    const first = task('ci', 'T-1', ...ok, '--run', '98765432100');
    expect([first.status, first.stdout]).toEqual([0, expect.stringContaining('CI run for T-1 (PR #7: failed) recorded.')]);
    expect(task('ci', 'T-1', '--pr', '7', '--sha', 'abc1234def5678', '--result', 'passed').status).toBe(0);
    expect(ci()).toEqual([
      expect.objectContaining({ task: 'T-1', pr: 7, sha: 'abc1234', result: 'failed', run: '98765432100' }),
      expect.objectContaining({ task: 'T-1', pr: 7, sha: 'abc1234def5678', result: 'passed' }),
    ]);
    expect(ci()[1]).not.toHaveProperty('run');
  }, 30_000);

  it('supports an esc:ci_red agent by a failed CI run declared before it started, and not without one', () => {
    const { dir } = makeRepo();
    const climb = (id: string, base: number, trigger: string) => [
      ...task(id, base, base + 90), agent(`${id}-1`, 'build', id, SONNET, base + 1), agent(`${id}-2`, 'fix', id, OPUS, base + 20, { trigger }),
    ];
    const ci = (min: number, id: string, result: string): Line => ({ ts: iso(min), event: 'CiRun', task: id, pr: 1, sha: 'abc1234', result });
    seed(dir, [
      ...climb('T-F', 0, 'ci_red'), ci(10, 'T-F', 'failed'), // failed before the fix started
      ...climb('T-P', 100, 'ci_red'), ci(110, 'T-P', 'passed'), // a passing run is no red
      ...climb('T-L', 200, 'ci_red'), ci(260, 'T-L', 'failed'), // failed only after the fix started (min 220)
      ...climb('T-O', 300, 'ci_red'), ci(310, 'T-F', 'failed'), // another task's red
      ...climb('T-N', 400, 'ci_red'),
    ]);
    const r = reportOf(dir);
    expect(Object.fromEntries(r.routing.log.map((c: any) => [c.task, [c.trigger, c.support]]))).toEqual({
      'T-F': ['ci_red', 'declared'], 'T-P': ['ci_red', 'none'], 'T-L': ['ci_red', 'none'], 'T-O': ['ci_red', 'none'], 'T-N': ['ci_red', 'none'],
    });
    expect(r.routing.consistency).toMatchObject({ unsupported: 4 });
  }, REPO_TIMEOUT);

  it('works the CI first-pass rate out from each pull request\'s earliest recorded run, and says not recorded, not 0, with none', () => {
    const { dir } = makeRepo();
    const ci = (min: number, id: string, pr: number, result: string): Line => ({ ts: iso(min), event: 'CiRun', task: id, pr, sha: 'abc1234', result });
    expect(reportOf(dir).areas.quality).toMatchObject({ ciFirstPassRate: null, ciRuns: 0 });
    seed(dir, [testRun(1, true)]); // the Tests line names the CI run only when a test run is recorded
    expect(reportOf(dir).health.checks.find((c: any) => c.name === 'Tests').detail).toContain('No CI run recorded yet.');
    // PR 1 passed first, then failed and passed again; PR 2 passed; PR 3 of another task passed, then failed;
    // PR 4 failed. A later failure does not undo a first pass: 3 of 4 first runs passed.
    seed(dir, [
      ...task('T-A', 0), testRun(1, true), ci(5, 'T-A', 1, 'failed'), ci(8, 'T-A', 1, 'passed'),
      ci(10, 'T-A', 2, 'passed'), ci(12, 'T-B', 3, 'passed'), ci(14, 'T-B', 3, 'failed'), ci(16, 'T-B', 4, 'failed'),
      ci(3, 'T-A', 1, 'passed'), // out of order in the file: the earliest by time still decides, so PR 1 first passed
    ]);
    expect(reportOf(dir).areas.quality).toMatchObject({ ciFirstPassRate: 75, ciRuns: 7 });
    const detail = reportOf(dir).health.checks.find((c: any) => c.name === 'Tests').detail;
    expect(detail).toContain('Last recorded CI run: PR #4 failed at');
    expect(detail).not.toContain('No CI run recorded yet.');
  }, REPO_TIMEOUT);

  it('reads the ladder and thresholds from control-tower.json, every process and trigger in the code\'s lists, and calls a malformed threshold unavailable', async () => {
    // @ts-expect-error a plain ES module with no type declarations
    const { PROCESSES, TRIGGERS } = await import('../.claude/hooks/devlog.mjs');
    const cfg = JSON.parse(read('devlog/control-tower.json'));
    expect(Object.keys(cfg.routing.processes).sort()).toEqual([...PROCESSES].sort());
    expect(Object.keys(cfg.routing.triggers).sort()).toEqual([...TRIGGERS].sort());
    expect(cfg.routing.escalationAlert).toMatchObject({ overPercent: 30, items: 20 });
    // Four finished items, two of them climbed: 2 of 4 is 50%.
    const lines = Array.from({ length: 4 }, (_, i) => [
      ...task(`T-${i}`, 0, 100 + i), agent(`s${i}`, 'build', `T-${i}`, SONNET, 1 + i * 10),
      ...(i < 2 ? [agent(`o${i}`, 'build', `T-${i}`, OPUS, 5 + i * 10)] : []),
    ]).flat();
    const withAlert = (alert: unknown) => { const r = makeRepo((c) => { c.routing.escalationAlert = alert; }); seed(r.dir, lines); return reportOf(r.dir); };
    // The threshold in the file decides: the same four items are green at 50% and amber at 40%, and 3 items are too few for 4.
    expect(row(withAlert({ overPercent: 50, items: 4 }), 'build').escalation).toMatchObject({ state: 'green', escalated: 2, need: 4, overPercent: 50 });
    expect(row(withAlert({ overPercent: 40, items: 4 }), 'build').escalation).toMatchObject({ state: 'amber', escalated: 2, need: 4, overPercent: 40 });
    expect(row(withAlert({ overPercent: 40, items: 5 }), 'build').escalation).toMatchObject({ state: 'collecting', window: 4, need: 5 });
    // A threshold that does not parse is unavailable, never 30 and 20 (lesson L-034).
    for (const bad of [{ overPercent: '30', items: 20 }, { overPercent: 30.5, items: 20 }, { overPercent: 0, items: 20 }, { overPercent: 30, items: 0 }, { overPercent: 130, items: 20 }, { items: 20 }, null]) {
      const r = withAlert(bad);
      expect(r.routing.state, JSON.stringify(bad)).toBe('unavailable');
      expect(row(r, 'build').escalation).toMatchObject({ state: 'unavailable', reason: 'config' });
      expect(check(r)).toMatchObject({ state: 'unavailable' });
      expect(attention(r)).toContain('The routing view is unavailable');
    }
    // A process missing from the file, or a floor above its ceiling, is unavailable too.
    for (const edit of [(c: any) => { delete c.routing.processes.fix; }, (c: any) => { c.routing.processes.build.floor = 'high'; c.routing.processes.build.ceiling = 'low'; }, (c: any) => { delete c.routing.triggers.suite_failed; }]) {
      const r = makeRepo(edit); seed(r.dir, lines);
      const out = reportOf(r.dir);
      expect(out.routing).toMatchObject({ state: 'unavailable', processes: [] });
      expect(out.routing.error).toEqual(expect.any(String));
    }
  }, 60_000);

  it('counts shadow reviews against the review they shadow: agreement, misses and false alarms', () => {
    const { dir } = makeRepo((c) => { c.routing.shadowReview = { enabled: true, every: 2, excludes: ['security-review'] }; });
    const primary = (id: string, taskId: string, min: number) => agent(id, 'review', taskId, OPUS, min, { requested: 'opus' });
    const shadow = (id: string, taskId: string, min: number) => agent(id, 'review', taskId, SONNET, min, { shadow: true, tokens: { [SONNET]: tok(500, 100) } });
    seed(dir, [
      ...['T-1', 'T-2', 'T-3', 'T-4', 'T-5'].flatMap((t, i) => [...task(t, 0, 500), primary(`r${i + 1}`, t, 1 + i * 10), shadow(`s${i + 1}`, t, 5 + i * 10)]),
      agent('x1', 'security-review', 'T-1', OPUS, 60), // excluded from the sample by the owner's setting
      // Primary verdicts: passed, failed, passed, failed, failed. Shadow verdicts: passed, passed, failed, failed, passed.
      ...['passed', 'failed', 'passed', 'failed', 'failed'].map((v, i) => outcome(100 + i, { task: `T-${i + 1}`, process: 'review', result: v, agent: `r${i + 1}`, round: 1 })),
      ...['passed', 'passed', 'failed', 'failed', 'passed'].map((v, i) => outcome(110 + i, { task: `T-${i + 1}`, process: 'review', result: v, agent: `s${i + 1}`, shadowOf: `r${i + 1}` })),
    ]);
    const r = reportOf(dir);
    // Agree on tasks 1 and 4; misses on tasks 2 and 5 (the primary failed them, the cheaper tier passed them); a false
    // alarm on task 3 (the primary passed it, the cheaper tier failed it). Five primary reviews at one in 2 make 2 due.
    expect(r.routing.shadow).toEqual({ enabled: true, every: 2, error: null, sample: 5, agree: 2, misses: 2, falseAlarms: 1, due: 2, done: 5, tokens: 3000 });
    // The shadow agents are not primary reviews: they do not count as items or as first-pass reviews.
    expect(row(r, 'review')).toMatchObject({ items: 5, firstPass: { n: 2, of: 5 } });
  }, REPO_TIMEOUT);

  // The audit on its own, at a clock the test controls (lesson L-037): the lines as the report would read them.
  const auditOf = async (lines: Line[], now = '2026-10-21T12:00:00Z', edit?: (c: any) => void) => {
    // @ts-expect-error a plain ES module with no type declarations
    const mod = await import('../scripts/devlog-report.mjs');
    const cfg = JSON.parse(read('devlog/control-tower.json'));
    edit?.(cfg);
    const events = lines.map((l) => ({ session: 'session_01A', ...l })) as any[];
    return mod.routingAudit({
      runs: mod.agentRuns(events, cfg), outcomes: events.filter((e) => e.event === 'Outcome'), toolEvents: events.filter((e) => e.tool),
      subagentStarts: events.filter((e) => e.event === 'SubagentStart'), board: mod.buildBoard(events, new Date(now)), cfg, now: new Date(now),
    });
  };
  const auditRow = (a: any, process: string) => a.processes.find((p: { process: string }) => p.process === process);

  it('counts an honest escalation from one stage into the next as a climb, not as a start above the floor or a trigger with no climb', () => {
    const { dir } = makeRepo();
    seed(dir, [
      // ADR-0014's own case: built on Sonnet, the review failed, the fix runs on Opus and says why.
      ...task('T-1', 0, 200), agent('b1', 'build', 'T-1', SONNET, 1), outcome(10, { task: 'T-1', process: 'review', result: 'failed', round: 1 }),
      agent('rv1', 'review', 'T-1', OPUS, 12), // the Opus review in between never climbs, so the fix reads from the Sonnet build
      agent('f1', 'fix', 'T-1', OPUS, 20, { trigger: 'review_failed' }),
      // The same, with a failed test run between the build and the fix (recorded), and with nothing to support it.
      ...task('T-3', 0, 210), agent('b3', 'build', 'T-3', SONNET, 31), testRun(35, false), agent('f3', 'fix', 'T-3', OPUS, 40, { trigger: 'suite_failed' }),
      ...task('T-4', 0, 220), agent('b4', 'build', 'T-4', SONNET, 51), agent('f4', 'fix', 'T-4', OPUS, 60, { trigger: 'suite_failed' }),
      // No trigger declared: still a start above the floor, counted apart.
      ...task('T-2', 0, 230), agent('f2', 'fix', 'T-2', OPUS, 70),
    ]);
    const r = reportOf(dir);
    expect(row(r, 'fix')).toMatchObject({ items: 4, startedAtFloor: 0, startedAbove: 1, enteredByEscalation: 3, escalatedItems: 3, aboveCeiling: 0 });
    expect(row(r, 'fix').escalation).toMatchObject({ state: 'collecting', escalated: 3, window: 3, need: 20 });
    expect(r.routing.log.map((c: any) => [c.task, c.process, c.fromModel, c.toModel, c.trigger, c.support]).sort()).toEqual([
      ['T-1', 'fix', SONNET, OPUS, 'review_failed', 'declared'], // from the build (mid to high), not from the review (high to high)
      ['T-3', 'fix', SONNET, OPUS, 'suite_failed', 'recorded'],
      ['T-4', 'fix', SONNET, OPUS, 'suite_failed', 'none'],
    ]);
    expect(r.routing.log.find((c: any) => c.task === 'T-1')).toMatchObject({ fromTier: 'mid', toTier: 'high' });
    expect(r.routing.consistency).toMatchObject({ climbsWithoutTrigger: 0, triggersWithoutClimb: 0, unsupported: 1 });
    expect(attention(r)).toContain('1 fix item(s) started above their floor tier');
    expect(attention(r)).not.toContain('3 fix item(s)');
  }, REPO_TIMEOUT);

  it('never counts a declared trigger alone as a climb: the agent before it must have run on a lower tier', () => {
    const { dir } = makeRepo();
    seed(dir, [
      // (a) built on Opus with no trigger, then fixed on Opus with a trigger: nothing climbed.
      ...task('T-A', 0, 100), agent('a1', 'build', 'T-A', OPUS, 1), agent('a2', 'fix', 'T-A', OPUS, 10, { trigger: 'review_failed' }),
      // (b) the item's very first agent is on Opus and claims an escalation: there was nothing to climb from.
      ...task('T-B', 0, 110), agent('b1', 'build', 'T-B', OPUS, 20, { trigger: 'review_failed' }),
    ]);
    const r = reportOf(dir);
    // (a) is carried: the item had already reached Opus, so the fix holds that tier. (b) is a plain start above the floor.
    expect(row(r, 'fix')).toMatchObject({ items: 1, startedAbove: 0, carried: 1, enteredByEscalation: 0, escalatedItems: 0 });
    expect(row(r, 'build')).toMatchObject({ items: 2, startedAbove: 2, carried: 0, enteredByEscalation: 0, escalatedItems: 0 });
    expect(row(r, 'fix').escalation).toMatchObject({ escalated: 0, window: 0 });
    expect(r.routing.log).toEqual([]);
    expect(r.routing.consistency).toMatchObject({ climbsWithoutTrigger: 0, triggersWithoutClimb: 1 }); // only (b): (a) carries its trigger
  }, REPO_TIMEOUT);

  it('keeps an item that already climbed on the tier it reached, without calling it an odd start or a trigger with no climb', () => {
    const { dir } = makeRepo();
    seed(dir, [
      // Built on Sonnet, climbed to Opus (suite failed), the Opus review failed, and the fix runs on Opus (review failed).
      ...task('T-1', 0, 200), agent('b1', 'build', 'T-1', SONNET, 1), testRun(3, false), agent('b2', 'build', 'T-1', OPUS, 5, { trigger: 'suite_failed' }),
      agent('rv', 'review', 'T-1', OPUS, 10), outcome(12, { task: 'T-1', process: 'review', result: 'failed', round: 1 }),
      agent('f1', 'fix', 'T-1', OPUS, 20, { trigger: 'review_failed' }),
    ]);
    const r = reportOf(dir);
    expect(row(r, 'fix')).toMatchObject({ items: 1, startedAbove: 0, carried: 1, enteredByEscalation: 0, escalatedItems: 0 });
    expect(row(r, 'build')).toMatchObject({ items: 1, escalatedItems: 1, carried: 0 }); // the one real climb
    expect(r.routing.consistency).toMatchObject({ climbsWithoutTrigger: 0, triggersWithoutClimb: 0, unsupported: 0 });
    expect(r.routing.log.map((c: any) => [c.process, c.fromTier, c.toTier])).toEqual([['build', 'mid', 'high']]);
    expect(r.routing.agents.find((a: any) => a.agentId === 'f1').reason).toBe('carried'); // the same word in both views
    expect(attention(r)).not.toContain('started above their floor tier');
  }, REPO_TIMEOUT);

  it('keeps a weekly trend from the week recording began, and counts items below the floor, above the ceiling and unrated apart', async () => {
    const day = 1440;
    // Now is Wed 2026-10-21 (ISO week 43). Recording began Tue 10-06 (week 41); earlier weeks are unknown, not empty.
    const a = await auditOf([
      ...task('T-W1', 1 * day, 3 * day), agent('w1a', 'build', 'T-W1', SONNET, 1 * day, { ts: iso(1 * day) }), agent('w1b', 'build', 'T-W1', OPUS, 1 * day + 30, { trigger: 'suite_failed' }),
      ...task('T-W2', 10 * day, 11 * day), agent('w2', 'build', 'T-W2', SONNET, 10 * day),
      ...task('T-W3', 15 * day, 16 * day), agent('w3', 'build', 'T-W3', SONNET, 15 * day),
      // Below the floor (Haiku on the build floor of Sonnet), and a check agent above its ceiling (Opus over Sonnet).
      ...task('T-LOW', 15 * day), agent('low', 'build', 'T-LOW', HAIKU, 15 * day + 5),
      ...task('T-HIGH', 15 * day), agent('high', 'check', 'T-HIGH', OPUS, 15 * day + 5),
    ]);
    expect(auditRow(a, 'build').weeks).toEqual([
      { week: '2026-W41', items: 1, escalated: 1 }, { week: '2026-W42', items: 1, escalated: 0 }, { week: '2026-W43', items: 1, escalated: 0 },
    ]);
    expect(auditRow(a, 'build')).toMatchObject({ startedBelow: 1, aboveCeiling: 0, startedAtFloor: 3, escalatedItems: 1 });
    expect(auditRow(a, 'check')).toMatchObject({ aboveCeiling: 1, startedAbove: 1, startedBelow: 0 });
    const reason = Object.fromEntries(a.agents.map((x: any) => [x.agentId, x.reason]));
    expect(reason).toMatchObject({ w1a: 'floor', w1b: 'escalation:suite_failed', low: 'below_floor', high: 'undeclared' });
    // A model the tiers do not name is unrated: the item is left out of the window and the finished-at-floor figure.
    const u = await auditOf([
      ...task('T-F', 0, 100), agent('f', 'build', 'T-F', SONNET, 1),
      ...task('T-U', 0, 200), agent('u1', 'build', 'T-U', SONNET, 11), agent('u2', 'build', 'T-U', 'claude-unknown-9', 15),
    ], '2026-10-21T12:00:00Z', (c) => { c.routing.escalationAlert = { overPercent: 30, items: 2 }; });
    expect(auditRow(u, 'build').escalation).toMatchObject({ state: 'collecting', window: 1, need: 2 });
    expect(auditRow(u, 'build').finishedAtFloor).toEqual({ n: 1, of: 1 });
    expect(u.unrated).toBe(1);
    expect(u.agents.find((x: any) => x.agentId === 'u2')).toMatchObject({ reason: null, tier: 'other' });
  });

  it('starts the weekly trend at the earliest agent, not at the first Stop that wrote a record, and counts an item that entered by escalation', async () => {
    const day = 1440;
    // Both agents began Tue 2026-10-06 (week 41), but the Stop that recorded them came on Tue 10-20 (week 43).
    const a = await auditOf([
      ...task('T-1', 1 * day, 16 * day),
      agent('b1', 'build', 'T-1', SONNET, 1 * day, { ts: iso(15 * day) }), agent('f1', 'fix', 'T-1', OPUS, 1 * day + 30, { ts: iso(15 * day), trigger: 'suite_failed' }),
    ]);
    expect(auditRow(a, 'build').weeks).toEqual([{ week: '2026-W41', items: 1, escalated: 0 }, { week: '2026-W42', items: 0, escalated: 0 }, { week: '2026-W43', items: 0, escalated: 0 }]);
    // The fix entered by escalation from the build (mid to high): it is an item from the floor, escalated, in its week.
    expect(auditRow(a, 'fix').weeks[0]).toEqual({ week: '2026-W41', items: 1, escalated: 1 });
    expect(a.since).toBe(iso(15 * day)); // for display only
  });

  it('keeps the last 50 climbs in the log, the newest, and the last 100 helper agents', async () => {
    const lines = Array.from({ length: 55 }, (_, i) => [
      ...task(`T-${i}`, 0, 99_999), agent(`s${i}`, 'build', `T-${i}`, SONNET, 10 * i + 1), agent(`o${i}`, 'build', `T-${i}`, OPUS, 10 * i + 5, { trigger: 'suite_failed' }),
    ]).flat();
    const a = await auditOf(lines);
    expect(a.log).toHaveLength(50);
    expect(a.log[0].task).toBe('T-54');
    expect(a.log.at(-1).task).toBe('T-5'); // T-0 to T-4 are the oldest five and fall away
    expect(a.agents).toHaveLength(100);
    expect(a.agents[0].agentId).toBe('o54');
    expect(auditRow(a, 'build').escalatedItems).toBe(55); // the cap is on the list, not on the count
  });

  it('warns of a climb above the ceiling apart from a start above the floor, and of three agents in a day with no metadata', () => {
    const { dir } = makeRepo();
    const bare = (id: string, minAgo: number): Line => ({ ts: new Date(Date.now() - minAgo * 60_000).toISOString(), event: 'AgentRun', agentId: id, tokens: { [SONNET]: tok(10) } });
    seed(dir, [...task('T-H', 0), agent('h1', 'check', 'T-H', OPUS, 5), bare('n1', 30), bare('n2', 60)]);
    const two = reportOf(dir);
    expect(attention(two)).toContain("1 check item(s) ran an agent above the process's ceiling tier: a breach of the routing policy");
    expect(attention(two)).toContain('1 check item(s) started above their floor tier');
    expect(attention(two)).not.toContain('have no Claude Code metadata');
    const three = makeRepo();
    seed(three.dir, [bare('n1', 30), bare('n2', 60), bare('n3', 90), { ...bare('old', 3 * 24 * 60), tokens: {} }]);
    const r = reportOf(three.dir);
    expect(attention(r)).toContain('3 helper agents in the last day have no Claude Code metadata');
    expect(r.routing.consistency).toMatchObject({ noMetadata: 4, untagged: 4, tagged: 0 });
  }, REPO_TIMEOUT);

  it('counts a helper agent from before recording once, and works out each session\'s main-session figure on its own', () => {
    const { dir } = makeRepo();
    const start = (min: number, agentId?: string, session = 'session_01A'): Line => ({ ts: iso(min), session, event: 'SubagentStart', agentType: 'general-purpose', ...(agentId ? { agentId } : {}) });
    const usage = (session: string, tokens: Record<string, unknown>): Line => ({ ts: iso(2000), session, event: 'Usage', at: 'Stop', costUSD: '1.00000000', costBasis: 'checkpoint+since', tokens });
    seed(dir, [
      // Session A: its agent started before the first Stop that wrote any record (that Stop is what `since` shows).
      start(0, 'a1'), { ...agent('a1', 'build', 'T-A', SONNET, 1), ts: iso(1500) }, start(5, 'gone'), start(6),
      usage('session_01A', { [SONNET]: tok(5000) }),
      // Session B has no helper agent at all: its whole total is the main session.
      { ts: iso(10), session: 'session_01B', event: 'UserPromptSubmit' }, usage('session_01B', { [OPUS]: tok(2000) }),
      // Session F started one agent that has no record, and nothing else.
      start(11, 'lost', 'session_01F'), usage('session_01F', { [OPUS]: tok(300) }),
      // Sessions C and D both have agents. C's agent used more Haiku than C's whole total; D has plenty over.
      { ...agent('c1', 'check', 'T-C', HAIKU, 20), session: 'session_01C', tokens: { [HAIKU]: tok(1000) } }, usage('session_01C', { [HAIKU]: tok(100) }),
      { ...agent('d1', 'check', 'T-D', HAIKU, 30), session: 'session_01D', tokens: { [HAIKU]: tok(100) } }, usage('session_01D', { [HAIKU]: tok(5000) }),
      // Session E has one agent, recorded, and no other start: its remainder is the main session.
      { ...agent('e1', 'build', 'T-E', SONNET, 40), session: 'session_01E', tokens: { [SONNET]: tok(1000) } }, usage('session_01E', { [SONNET]: tok(5000) }),
    ]);
    const r = reportOf(dir);
    // a1 has its record, so it is not "before recording"; the agent with no record and the start with no id are.
    expect(r.routing).toMatchObject({ since: iso(22), agentsBefore: 3 }); // a1 started before `since` and is still not "before recording"
    expect(r.routing.consistency.startedNoRecord).toBe(2); // gone and lost
    const rows = Object.fromEntries(r.processCost.map((x: { process: string; model: string }) => [`${x.process}|${x.model}`, x]));
    expect(rows[`build|${SONNET}`]).toMatchObject({ agents: 2, tokens: 2000 }); // a1 and e1
    expect(rows[`not recorded|${SONNET}`]).toBeUndefined(); // an agent that began before the first Stop is not "not recorded"
    // Nothing is counted twice: per model, the process rows, the main session and the not-split rows add up to the
    // sessions' totals exactly, worked by hand. Sonnet: session A 5000 + session E 5000 = 10,000 = the build agents a1
    // and e1 (1000 + 1000) + A's remainder of 4000 (A started two agents with no record, so its remainder is not split)
    // + E's remainder of 4000 (every agent E started has a record, so its remainder is the main session).
    // Opus: session B 2000 (no agent at all: all main session) + session F 300 (one unrecorded start: not split) = 2300.
    const label = 'not split: main session and unrecorded helper agents together';
    const sum = (model: string) => r.processCost.filter((x: { model: string }) => x.model === model).reduce((n: number, x: { tokens: number | null }) => n + (x.tokens ?? 0), 0);
    expect(rows[`build|${SONNET}`]).toMatchObject({ agents: 2, tokens: 2000 });
    expect(rows[`main session|${SONNET}`]).toEqual({ process: 'main session', model: SONNET, agents: null, tokens: 4000, medianTokens: null, cost: { usd: '0.04000000' } });
    expect(rows[`${label}|${SONNET}`]).toEqual({ process: label, model: SONNET, agents: null, tokens: 4000, medianTokens: null, cost: { usd: '0.04000000' }, unsplit: true });
    expect(sum(SONNET)).toBe(10_000);
    expect(rows[`main session|${OPUS}`]).toEqual({ process: 'main session', model: OPUS, agents: null, tokens: 2000, medianTokens: null, cost: { usd: '0.04000000' } });
    expect(rows[`${label}|${OPUS}`]).toEqual({ process: label, model: OPUS, agents: null, tokens: 300, medianTokens: null, cost: { usd: '0.00600000' }, unsplit: true });
    expect(sum(OPUS)).toBe(2300);
    // C is negative for Haiku (1000 used, 100 held): unavailable for the model, though C and D together come to a positive 4000.
    expect(rows[`main session|${HAIKU}`]).toMatchObject({ tokens: null, cost: null });
  }, REPO_TIMEOUT);

  it('computes the helper-agent saving from the agents\' own records, worked by hand', () => {
    const { dir } = makeRepo();
    // Sessions: 3,000,000 Sonnet and 500,000 Opus output tokens. At the Opus baseline ($20 per million):
    // all-Opus 70.00, actual 30.00 + 10.00 = 40.00, saving 30.00 (4285 of 10000, 42.85%).
    // Helper agents: 1,000,000 Sonnet output and 100,000 Opus output. All-Opus 22.00, actual 10.00 + 2.00 = 12.00, saving 10.00, 45.45%.
    seed(dir, [
      ...task('T-A', 0),
      agent('s1', 'build', 'T-A', SONNET, 1, { tokens: { [SONNET]: tok(1_000_000) } }), agent('o1', 'review', 'T-A', OPUS, 5, { tokens: { [OPUS]: tok(100_000) } }),
      { ts: iso(30), event: 'Usage', at: 'Stop', costUSD: '40.00000000', costBasis: 'checkpoint+since', tokens: { [SONNET]: tok(3_000_000), [OPUS]: tok(500_000) } },
    ]);
    const s = reportOf(dir).economics.routingSaving;
    expect(s).toMatchObject({ allBaseline: { usd: '70.00000000' }, actual: { usd: '40.00000000' }, saving: { usd: '30.00000000' }, share: 42.85 });
    expect(s.agents).toEqual({
      baseline: 'claude-opus-5-5', allBaseline: { usd: '22.00000000' }, actual: { usd: '12.00000000' }, saving: { usd: '10.00000000' }, share: 45.45, scope: 'helper agents only',
    });
  }, REPO_TIMEOUT);

  it('does not let a verdict recorded later move when a session was last active', () => {
    const { dir } = makeRepo();
    seed(dir, [tool(5, {}), ...task('T-1', 6), outcome(500, { task: 'T-1', process: 'review', result: 'passed', round: 1 })]);
    expect(reportOf(dir).sessions.find((s: { id: string }) => s.id === 'session_01A').last).toBe(iso(5));
  }, REPO_TIMEOUT);

  it('counts a helper agent that started with an id and left no record, and warns once its session is quiet', () => {
    const { dir } = makeRepo();
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    seed(dir, [
      // A quiet session: its agent started two hours ago and nothing was recorded for it since.
      { ts: ago(120), event: 'SubagentStart', agentType: 'general-purpose', agentId: 'q1' },
      // A session still active (it did something a minute ago): its agent may simply still be running.
      { ts: ago(10), session: 'session_01B', event: 'SubagentStart', agentType: 'general-purpose', agentId: 'live1' }, { ts: ago(1), session: 'session_01B', event: 'UserPromptSubmit' },
      // Older than a day: counted, but not worth a warning now.
      { ts: ago(3 * 24 * 60), session: 'session_01C', event: 'SubagentStart', agentType: 'general-purpose', agentId: 'old1' },
    ]);
    const r = reportOf(dir);
    expect(r.routing.consistency).toMatchObject({ startedNoRecord: 3, startedNoRecordStale: 1 });
    expect(attention(r)).toContain('1 helper agent(s) started in the last day have no Claude Code record, and their session is no longer active');
  }, REPO_TIMEOUT);

  it('shows throttle bands as not in use, with the configured thresholds and no reading', async () => {
    // @ts-expect-error a plain ES module with no type declarations
    const { throttleTable } = await import('../scripts/devlog-throttle.mjs');
    const cfg = JSON.parse(read('devlog/control-tower.json'));
    const r = reportOf(makeRepo().dir);
    expect(r.throttle).toEqual({
      state: 'off', reason: 'No runner: nothing reads usage or starts items', bands: throttleTable(cfg.throttle).bands, error: null,
      thresholds: { fiveHour: { low: 70, crawl: 85, stop: 95 }, weeklyStop: 80, todayLow: 40 },
    });
    expect(r.throttle.bands.map((b: { band: string }) => b.band)).toEqual(['Full', 'Normal', 'Low', 'Crawl', 'Stopped']);
    expect(r.throttle.bands.find((b: { band: string }) => b.band === 'Low').when).toContain('70% to 84%');
    expect(r.utilisation).toEqual({ state: 'off', reason: expect.stringContaining('No runner') });
    // Thresholds that make no sense give no table and say why; there is still no reading.
    const bad = reportOf(makeRepo((c) => { c.throttle.fiveHour = { low: 90, crawl: 85, stop: 95 }; }).dir);
    expect(bad.throttle).toMatchObject({ state: 'off', bands: null, thresholds: null, error: expect.stringContaining('low < crawl < stop') });
    expect(Object.keys(bad.throttle).sort()).toEqual(['bands', 'error', 'reason', 'state', 'thresholds']);
  }, REPO_TIMEOUT);
});
