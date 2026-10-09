#!/usr/bin/env node
// Dev Control Tower: records what each Claude Code session does, one JSON line per event,
// in devlog/activity/<date>-<session>.jsonl. The file is committed with the session's work.
//
// It records what was done, never the content: for a shell command, its description and not
// the command; for an edit, the file path only; for a failure, the first line of the error,
// with anything shaped like a phone number or a token removed. It never blocks the session:
// every error is swallowed and it always exits 0.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** Remove anything that could be a phone number, a credential or a long id. */
export function scrub(text, max = 200) {
  return String(text ?? '')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
};

function target(tool, input = {}) {
  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (file) return path.relative(root, path.resolve(root, String(file))) || '.';
  if (tool === 'Bash') return scrub(input.description || 'shell command', 120);
  return '';
}

function main() {
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const event = ev.hook_event_name;
  const session = String(ev.session_id ?? 'unknown');
  const line = { ts: new Date().toISOString(), session, event };
  let context = '';

  if (event === 'SessionStart') {
    line.source = ev.source;
    // Lesson L-013: never report on or build from a stale branch.
    git('fetch', '--quiet', 'origin', 'main');
    line.branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    line.head = git('rev-parse', '--short', 'HEAD');
    const behind = Number(git('rev-list', '--count', 'HEAD..origin/main') || 0);
    line.behind_main = behind;
    if (behind > 0) {
      context += `WARNING (dev Control Tower, lesson L-013): this branch is ${behind} commits behind origin/main. `
        + 'Bring main in before reporting on the project or building on it.\n';
    }
    context += 'Dev Control Tower: this session is logged to devlog/activity/. '
      + 'When you fix a bug, a review finding or a process mistake, record it in devlog/lessons.md with a guard.\n';
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    line.tool = ev.tool_name;
    line.target = target(ev.tool_name, ev.tool_input);
    line.ok = event === 'PostToolUse';
    if (ev.duration_ms !== undefined) line.ms = ev.duration_ms;
    if (!line.ok) {
      const first = String(ev.error ?? '').split('\n')[0];
      const exit = /^Exit code (\d+)/.exec(first);
      if (exit) line.exit = Number(exit[1]);
      line.error = scrub(first);
      if (ev.is_interrupt) line.interrupted = true;
    }
  } else if (event === 'SessionEnd') {
    line.reason = ev.reason;
  } else if (event === 'UserPromptSubmit') {
    // Counts turns only. The prompt itself is not recorded: it can hold anything the owner pasted.
  } else {
    return;
  }

  const day = line.ts.slice(0, 10);
  const dir = path.join(root, 'devlog', 'activity');
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, `${day}-${session.replace(/[^\w-]/g, '').slice(-12)}.jsonl`), JSON.stringify(line) + '\n');
  if (context) process.stdout.write(context);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch { /* never block the session */ }
  process.exit(0);
}
