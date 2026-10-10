#!/usr/bin/env node
// Dev Control Tower: the development control board (d3ngineering section 44), task progress
// (section 12) and the development incident register (section 45).
//
//   node scripts/devlog-task.mjs start  <id> --title "…" [--epic …] [--workstream …] [--phase …] [--owner …] [--pr N]
//   node scripts/devlog-task.mjs update <id> [--status …] [--progress 0-100] [--attempt N] [--tests 87/93]
//                                            [--blocker "…"|--blocker none] [--next "…"] [--phase …] [--pr N]
//   node scripts/devlog-task.mjs done   <id> [--pr N]
//   node scripts/devlog-task.mjs incident --type … --title "…" [--severity high|medium|low] [--impact "…"]
//                                         [--detected-by "…"] [--action "…"] [--lesson L-NNN] [--policy-updated yes|no] [--task <id>]
//   node scripts/devlog-task.mjs board     (prints the current board)
//
// Each command appends an event to this session's spool, like the activity hook, so the board
// is rebuilt from events and two branches never edit the same file (lesson L-019). Free text is
// scrubbed and kept short (lesson L-017). Model, tokens and cost per task come from the sessions
// that worked on it, so they are never typed in.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig, scrub, sessionIds, spoolFile } from '../.claude/hooks/devlog.mjs';

export const STATUSES = ['planned', 'in_progress', 'testing', 'review', 'blocked', 'done', 'abandoned'];
export const INCIDENT_TYPES = ['agent_regression', 'test_failure', 'review_finding', 'process', 'scope', 'security', 'stop_loss', 'other'];
const ID = /^[A-Za-z][\w.-]{0,39}$/;

export class UsageError extends Error {}

function parseArgs(argv) {
  const pos = []; const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value.`);
      opts[a.slice(2)] = v; i++;
    } else pos.push(a);
  }
  return { pos, opts };
}

const text = (v, max = 160) => (v === undefined ? undefined : scrub(v, max));
const int = (name, v, min, max) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
};
const oneOf = (name, v, list) => {
  if (v === undefined) return undefined;
  if (!list.includes(v)) throw new UsageError(`--${name} must be one of: ${list.join(', ')}.`);
  return v;
};
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Build the event for a command, or throw UsageError. Pure, so it can be tested. */
export function eventFor(argv, now = new Date(), env = process.env) {
  const [command, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const { session } = sessionIds(env.CLAUDE_CODE_SESSION_ID ?? 'cli', env);
  const base = { ts: now.toISOString(), session };
  const known = (allowed) => {
    const extra = Object.keys(opts).filter((k) => !allowed.includes(k));
    if (extra.length) throw new UsageError(`Unknown option: --${extra[0]}.`);
  };

  if (command === 'start' || command === 'update' || command === 'done') {
    const id = pos[0];
    if (!id || !ID.test(id)) throw new UsageError('Give a task id: letters, digits, "-", "_" or ".", starting with a letter (e.g. DCT-2).');
    known(command === 'start' ? ['title', 'epic', 'workstream', 'phase', 'owner', 'pr', 'status']
      : command === 'update' ? ['status', 'progress', 'attempt', 'tests', 'blocker', 'next', 'phase', 'pr', 'title']
        : ['pr', 'next']);
    if (command === 'start' && !opts.title) throw new UsageError('start needs --title.');
    if (opts.tests !== undefined && !/^\d{1,6}\/\d{1,6}$/.test(opts.tests)) throw new UsageError('--tests must look like 87/93 (passed/total).');
    return strip({
      ...base, event: 'Task', action: command, id,
      title: text(opts.title, 120), epic: text(opts.epic, 80), workstream: text(opts.workstream, 80),
      phase: text(opts.phase, 60), owner: text(opts.owner, 60),
      status: command === 'done' ? 'done' : oneOf('status', opts.status ?? (command === 'start' ? 'in_progress' : undefined), STATUSES),
      progress: command === 'done' ? 100 : int('progress', opts.progress, 0, 100),
      attempt: int('attempt', opts.attempt, 1, 99), tests: opts.tests,
      blocker: opts.blocker === 'none' ? '' : text(opts.blocker), next: text(opts.next), pr: int('pr', opts.pr, 1, 1_000_000),
    });
  }
  if (command === 'incident') {
    known(['type', 'title', 'severity', 'impact', 'detected-by', 'action', 'lesson', 'policy-updated', 'task']);
    if (!opts.title) throw new UsageError('incident needs --title.');
    if (opts.lesson !== undefined && !/^L-\d{3}$/.test(opts.lesson)) throw new UsageError('--lesson must look like L-016.');
    if (opts.task !== undefined && !ID.test(opts.task)) throw new UsageError('--task is not a valid task id.');
    const day = base.ts.slice(0, 10).replace(/-/g, '');
    return strip({
      ...base, event: 'Incident', id: `INC-${day}-${randomBytes(2).toString('hex')}`,
      type: oneOf('type', opts.type ?? 'other', INCIDENT_TYPES), title: text(opts.title, 160),
      severity: oneOf('severity', opts.severity ?? 'medium', ['high', 'medium', 'low']),
      impact: text(opts.impact), detectedBy: text(opts['detected-by'], 80), action: text(opts.action),
      lesson: opts.lesson, policyUpdated: opts['policy-updated'] === undefined ? undefined : oneOf('policy-updated', opts['policy-updated'], ['yes', 'no']) === 'yes',
      task: opts.task,
    });
  }
  throw new UsageError('Commands: start, update, done, incident, board.');
}

function append(event) {
  const file = spoolFile(event.session);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(event) + '\n');
}

const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === 'board') {
      const { buildBoard } = await import('./devlog-report.mjs');
      for (const t of buildBoard()) {
        console.log(`${t.id}  ${t.status.padEnd(11)} ${String(t.progress ?? 0).padStart(3)}%  attempt ${t.attempt ?? 1}  ${t.title ?? ''}${t.blocker ? `  BLOCKED: ${t.blocker}` : ''}${t.next ? `  next: ${t.next}` : ''}`);
      }
    } else {
      const event = eventFor(argv);
      append(event);
      console.log(event.event === 'Incident' ? `Recorded ${event.id}.` : `Task ${event.id}: ${event.action} recorded.`);
      const max = readConfig().stopLoss?.maxTaskAttempts;
      if (event.event === 'Task' && max && event.attempt > max) {
        append({ ts: event.ts, session: event.session, event: 'Alert', kind: 'stop-loss', rule: 'task-attempts', key: event.id });
        console.log(`STOP-LOSS TRIGGERED (dev Control Tower): task ${event.id} is on attempt ${event.attempt}, over the budget of ${max}. Stop, summarise the evidence, and escalate to the owner.`);
      }
    }
  } catch (e) {
    console.error(e instanceof UsageError ? e.message : `devlog-task failed: ${e.message}`);
    process.exit(1);
  }
}
