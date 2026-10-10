import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `${msg}\n\nClaude-Session: https://claude.ai/code/${session}`], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
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
    const commit = (msg: string, date = '2026-10-10T00:00:00Z') => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    commit('base'); git('add', '-A'); commit('tooling');
    const origin = freshDir('origin-bare');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    git('remote', 'add', 'origin', origin);
    git('push', '-q', 'origin', 'main');
    const branch = (name: string, msg?: string, date?: string) => { git('switch', '-q', '-c', name, 'main'); if (msg) commit(msg, date); git('push', '-q', 'origin', name); git('switch', '-q', 'main'); };
    branch('claude/phase-2-workflow', 'phase 2 work');
    branch('claude/old-default', 'old default');
    git('merge', '-q', '--no-edit', 'claude/phase-2-workflow', 'claude/old-default'); git('push', '-q', 'origin', 'main');
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
    git('switch', '-q', '-c', 'local-only', 'main'); commit('never pushed'); const localSha = git('rev-parse', 'HEAD').trim(); git('switch', '-q', 'main');
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
  });

  it('runs no audit and flags nothing when the trunk cannot be found', () => {
    const { dir, report } = branchRepo();
    const cfg = JSON.parse(readFileSync(path.join(dir, 'devlog/control-tower.json'), 'utf8'));
    cfg.branches.trunk = 'master';
    writeFileSync(path.join(dir, 'devlog/control-tower.json'), JSON.stringify(cfg));
    const r = report();
    expect(r.branches.error).toContain('origin/master is missing');
    expect(r.branches.branches).toEqual([]);
    expect(r.attention.map((a: { text: string }) => a.text).join('\n')).not.toContain('can be deleted');
  });

  it('keeps a branch name out of git when it holds a long number', () => {
    const { dir } = makeRepo();
    mkdirSync(path.join(dir, 'devlog/.spool'), { recursive: true });
    writeFileSync(path.join(dir, 'devlog/.spool/s.jsonl'), JSON.stringify({ ts: '2026-10-10T00:00:00Z', session: 's', event: 'SessionStart', branch: 'claude/call-60123456789' }) + '\n');
    run(dir, 'scripts/devlog-flush.mjs', []);
    const out = readdirSync(path.join(dir, 'devlog/activity')).map((f) => readFileSync(path.join(dir, 'devlog/activity', f), 'utf8')).join('');
    expect(out).not.toContain('60123456789');
  });
});
