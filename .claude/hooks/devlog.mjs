#!/usr/bin/env node
// Dev Control Tower: records what each Claude Code session does, one JSON line per event.
//
// Lines go to a spool that git ignores (devlog/.spool/), so the working tree stays clean and
// checkout, rebase and pull keep working. `node scripts/devlog-flush.mjs` moves new lines into a
// new file under devlog/activity/ just before a commit; each flush is its own file, so branches
// never conflict over it.
//
// Everything recorded may end up in git, so it records by allowlist: the tool name, a scrubbed
// file path or shell-command description, and for a failure only a fixed category. Never prompt
// text, command text, output or error text. It never blocks the session: every error is
// swallowed and it always exits 0.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** Remove anything that could be a credential, a phone number, an email or a long id. */
export function scrub(text, max = 200) {
  return String(text ?? '')
    .normalize('NFKC') // full-width digits and letters become plain ones first
    .replace(/\/\/[^/\s:@]+:[^@\s/]+@/g, '//[cred]@') // user:password@ in URLs
    .replace(/\b[\w.-]+:[^\s@/]+@(?=[\w-])/g, '[cred]@') // user:password@host without a scheme
    .replace(/\b([\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie|session)[\w.-]*)\s*([=:])\s*("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]')
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[redacted]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\beyJ[\w-]*\.[\w-]*\.?[\w-]*/g, '[redacted]') // JWTs
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA|ASIA|AC|SK|KEY)[-_]?[\w-]{6,}/g, '[redacted]')
    .replace(/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{16,}\b/g, '[redacted]') // long mixed letter-digit runs
    .replace(/\+?\d(?:[\s().\/-]*\d){6,}/g, '[number]') // 7+ digits, whatever the separators
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** A failure is recorded as a category only: error text can hold names, emails or secrets. */
export function failureKind(tool, error, interrupted) {
  if (interrupted) return 'interrupted';
  const first = String(error ?? '').split('\n')[0] ?? '';
  const exit = /^Exit code (\d+)$/.exec(first.trim());
  if (tool === 'Bash' && exit) return `exit ${exit[1]}`;
  if (/permission|denied|not allowed|forbidden|unauthori[sz]ed|\b40[13]\b/i.test(first)) return 'denied';
  if (/not found|no such file|does not exist|\b404\b|ENOENT/i.test(first)) return 'not found';
  if (/time[d ]?out|ETIMEDOUT/i.test(first)) return 'timeout';
  if (/invalid|validation|must be|required|malformed|parse/i.test(first)) return 'invalid input';
  if (/rate limit|too many|\b429\b/i.test(first)) return 'rate limited';
  return 'other';
}

/**
 * In a claude.ai cloud session the hook's session_id is local to the container. The id that
 * commit trailers and claude.ai links use comes from CLAUDE_CODE_REMOTE_SESSION_ID (cse_X is
 * session_X), so record that and keep the local one alongside.
 */
export function sessionIds(local, env = process.env) {
  const remote = /^cse_(\w+)$/.exec(env.CLAUDE_CODE_REMOTE_SESSION_ID ?? '')?.[1];
  const id = String(local ?? 'unknown');
  return remote ? { session: `session_${remote}`, local_session: id } : { session: id };
}

const git = (timeout, ...args) => {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never wait on a credential prompt
    }).trim();
  } catch { return ''; }
};

function target(tool, input = {}) {
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (file) {
    const rel = path.relative(root, path.resolve(root, String(file)));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '(outside project)';
    return scrub(rel || '.', 160);
  }
  if (tool === 'Bash') return scrub(input.description || 'shell command', 120);
  return '';
}

function main() {
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const event = ev.hook_event_name;
  const line = { ts: new Date().toISOString(), ...sessionIds(ev.session_id), event };
  let context = '';

  if (event === 'SessionStart') {
    line.source = ev.source;
    // Lesson L-013: never report on or build from a stale branch.
    if (ev.source !== 'compact') git(4000, 'fetch', '--quiet', 'origin', 'main');
    line.branch = git(2000, 'rev-parse', '--abbrev-ref', 'HEAD');
    line.head = git(2000, 'rev-parse', '--short', 'HEAD');
    const behind = Number(git(2000, 'rev-list', '--count', 'HEAD..origin/main') || 0);
    line.behind_main = behind;
    if (behind > 0) {
      context += `WARNING (dev Control Tower, lesson L-013): this branch is ${behind} commits behind origin/main. `
        + 'Bring main in before reporting on the project or building on it.\n';
    }
    context += 'Dev Control Tower: this session is logged to devlog/.spool/. Before each commit run '
      + '`node scripts/devlog-flush.mjs` and commit devlog/activity/ with the work. '
      + 'When you fix a bug, a review finding or a process mistake, record it in devlog/lessons.md with a guard.\n';
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    line.tool = scrub(ev.tool_name, 80);
    line.target = target(ev.tool_name, ev.tool_input);
    line.ok = event === 'PostToolUse';
    if (typeof ev.duration_ms === 'number') line.ms = ev.duration_ms;
    if (!line.ok) line.failure = failureKind(ev.tool_name, ev.error, ev.is_interrupt);
  } else if (event === 'SessionEnd') {
    line.reason = scrub(ev.reason, 40);
  } else if (event === 'UserPromptSubmit') {
    // Counts turns only. The prompt itself is not recorded: it can hold anything the owner pasted.
  } else {
    return;
  }

  const dir = path.join(root, 'devlog', '.spool');
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, `${line.session.replace(/[^\w-]/g, '').slice(-24)}.jsonl`), JSON.stringify(line) + '\n');
  if (context) process.stdout.write(context);
}

// Run as a script (not when imported). Compare real paths as URLs: a space, % or symlink in the
// path must not make the hook silently do nothing.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  try { main(); } catch { /* never block the session */ }
  process.exit(0);
}
