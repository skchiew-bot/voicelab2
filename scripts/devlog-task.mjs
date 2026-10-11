#!/usr/bin/env node
// Dev Control Tower: the development control board (d3ngineering section 44), task progress
// (section 12) and the development incident register (section 45).
//
//   node scripts/devlog-task.mjs start  <id> --title "…" [--epic …] [--workstream …] [--phase …] [--owner …] [--pr N] [--branch …]
//   node scripts/devlog-task.mjs update <id> [--status …] [--progress 0-100] [--attempt N] [--tests 87/93]
//                                            [--blocker "…"|--blocker none] [--next "…"] [--phase …] [--pr N]
//   node scripts/devlog-task.mjs done   <id> [--pr N]
//   node scripts/devlog-task.mjs incident --type … --title "…" [--severity high|medium|low] [--impact "…"]
//                                         [--detected-by "…"] [--action "…"] [--lesson L-NNN] [--policy-updated yes|no] [--task <id>]
//   node scripts/devlog-task.mjs decision --title "…" [--on YYYY-MM-DD] [--by owner] [--ref "#46"] [--task <id>]
//                                         (an owner decision, kept in an append-only register beside the incidents)
//   node scripts/devlog-task.mjs outcome <task> --process plan|review|security-review|build|fix|check --result passed|failed
//                                         [--agent <agentId>] [--shadow-of <agentId>] [--round N]
//                                         (a verdict the session declares for a helper agent's work on a task, for the routing view;
//                                          the task must already be on this branch's board; --shadow-of needs --process review and --agent)
//   node scripts/devlog-task.mjs ci <task> --pr N --sha <40 lowercase hex> --result passed|failed
//                                         (a CI run on the task's pull request, declared by the session, for the routing view's
//                                          ci_red trigger and CI first-pass rate; the task must already be on this branch's board)
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
import { PROCESSES, isAgentId, isTaskId, readConfig, scrub, sessionIds, spoolFile } from '../.claude/hooks/devlog.mjs';

export const STATUSES = ['planned', 'in_progress', 'testing', 'review', 'blocked', 'done', 'abandoned'];
export const INCIDENT_TYPES = ['agent_regression', 'test_failure', 'review_finding', 'process', 'scope', 'security', 'stop_loss', 'other'];

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
    if (!id || !isTaskId(id)) throw new UsageError('Give a task id: letters, digits, "-", "_" or ".", starting with a letter, fewer than 7 digits (e.g. DCT-2).');
    known(command === 'start' ? ['title', 'epic', 'workstream', 'phase', 'owner', 'pr', 'status', 'branch']
      : command === 'update' ? ['status', 'progress', 'attempt', 'tests', 'blocker', 'next', 'phase', 'pr', 'title', 'branch']
        : ['pr', 'next']);
    if (command === 'start' && !opts.title) throw new UsageError('start needs --title.');
    if (opts.tests !== undefined && !/^\d{1,6}\/\d{1,6}$/.test(opts.tests)) throw new UsageError('--tests must look like 87/93 (passed/total).');
    if (opts.branch !== undefined && !/^[\w.-]+(\/[\w.-]+)*$/.test(opts.branch)) throw new UsageError('--branch must be a branch name, such as claude/phase-5-journey.');
    return strip({
      ...base, event: 'Task', action: command, id,
      title: text(opts.title, 120), epic: text(opts.epic, 80), workstream: text(opts.workstream, 80),
      phase: text(opts.phase, 60), owner: text(opts.owner, 60),
      status: command === 'done' ? 'done' : oneOf('status', opts.status ?? (command === 'start' ? 'in_progress' : undefined), STATUSES),
      progress: command === 'done' ? 100 : int('progress', opts.progress, 0, 100),
      attempt: int('attempt', opts.attempt, 1, 99), tests: opts.tests,
      blocker: opts.blocker === 'none' ? '' : text(opts.blocker), next: text(opts.next), pr: int('pr', opts.pr, 1, 1_000_000),
      branch: opts.branch,
    });
  }
  if (command === 'incident') {
    known(['type', 'title', 'severity', 'impact', 'detected-by', 'action', 'lesson', 'policy-updated', 'task']);
    if (!opts.title) throw new UsageError('incident needs --title.');
    if (opts.lesson !== undefined && !/^L-\d{3}$/.test(opts.lesson)) throw new UsageError('--lesson must look like L-016.');
    if (opts.task !== undefined && !isTaskId(opts.task)) throw new UsageError('--task is not a valid task id.');
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
  if (command === 'decision') {
    known(['title', 'on', 'by', 'ref', 'task']);
    if (!opts.title) throw new UsageError('decision needs --title.');
    if (opts.task !== undefined && !isTaskId(opts.task)) throw new UsageError('--task is not a valid task id.');
    // The day the decision was made, which can be earlier than the day it is recorded; never in the future.
    const on = opts.on ?? base.ts.slice(0, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(on) || Number.isNaN(new Date(`${on}T00:00:00Z`).getTime()) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on) throw new UsageError('--on must be a real date, like 2026-10-11.');
    // Today anywhere: the owner works in Kuala Lumpur, a day ahead of UTC until 08:00 (lesson L-022).
    if (on > new Date(now.getTime() + 864e5).toISOString().slice(0, 10)) throw new UsageError('--on cannot be after today.');
    const day = base.ts.slice(0, 10).replace(/-/g, '');
    return strip({
      ...base, event: 'Decision', id: `DEC-${day}-${randomBytes(2).toString('hex')}`,
      title: text(opts.title, 200), on, by: text(opts.by ?? 'owner', 60), ref: text(opts.ref, 80), task: opts.task,
    });
  }
  if (command === 'outcome') {
    known(['process', 'result', 'agent', 'shadow-of', 'round']);
    const task = pos[0];
    if (!task || !isTaskId(task)) throw new UsageError('Give a task id: letters, digits, "-", "_" or ".", starting with a letter, fewer than 7 digits (e.g. DCT-2).');
    if (!opts.process) throw new UsageError('outcome needs --process.');
    if (!opts.result) throw new UsageError('outcome needs --result.');
    for (const k of ['agent', 'shadow-of']) {
      if (opts[k] !== undefined && !isAgentId(opts[k])) throw new UsageError(`--${k} must be a helper agent's id: letters, digits, "-" or "_", up to 40.`);
    }
    // A shadow review is a second opinion on one primary review: it must say which, and be a review (lesson L-034).
    if (opts['shadow-of'] !== undefined && (opts.process !== 'review' || opts.agent === undefined)) throw new UsageError('--shadow-of needs --process review and --agent.');
    return strip({
      ...base, event: 'Outcome', task, process: oneOf('process', opts.process, PROCESSES),
      result: oneOf('result', opts.result, ['passed', 'failed']), agent: opts.agent, shadowOf: opts['shadow-of'], round: int('round', opts.round, 1, 99),
    });
  }
  if (command === 'ci') {
    known(['pr', 'sha', 'result']);
    const task = pos[0];
    if (!task || !isTaskId(task)) throw new UsageError('Give a task id: letters, digits, "-", "_" or ".", starting with a letter, fewer than 7 digits (e.g. DCT-2).');
    if (!opts.pr) throw new UsageError('ci needs --pr.');
    if (!opts.sha) throw new UsageError('ci needs --sha.');
    if (!opts.result) throw new UsageError('ci needs --result.');
    if (!/^[0-9a-f]{40}$/.test(opts.sha)) throw new UsageError('--sha must be the full 40-character commit id in lowercase hex.');
    return strip({
      ...base, event: 'CiRun', task, pr: int('pr', opts.pr, 1, 1_000_000), sha: opts.sha,
      result: oneOf('result', opts.result, ['passed', 'failed']),
    });
  }
  throw new UsageError('Commands: start, update, done, incident, decision, outcome, ci, board.');
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
      if (event.action === 'start') {
        // One id, one piece of work, even once that work is done: refuse an id this branch already has for something
        // else. Ids on other unmerged branches cannot be seen from here; the report flags those once they meet.
        const { buildBoard, sameWork } = await import('./devlog-report.mjs');
        const had = buildBoard().find((t) => t.id === event.id);
        if (had?.title && !sameWork(had.title, event.title)) throw new UsageError(`${event.id} is already "${had.title}". Choose a new id.`);
      }
      if (event.event === 'Outcome' || event.event === 'CiRun') {
        // A verdict for a task nobody started would fill the routing view with work the board does not know.
        const { buildBoard } = await import('./devlog-report.mjs');
        if (!buildBoard().some((t) => t.id === event.task)) throw new UsageError(`${event.task} is not on this branch's board. Start it first (start ${event.task} --title …).`);
      }
      append(event);
      console.log(event.event === 'Task' ? `Task ${event.id}: ${event.action} recorded.` : event.event === 'Outcome' ? `Outcome for ${event.task} (${event.process}: ${event.result}) recorded.` : event.event === 'CiRun' ? `CI run for ${event.task} (PR #${event.pr}: ${event.result}) recorded.` : `Recorded ${event.id}.`);
      const max = readConfig().stopLoss?.maxTaskAttempts;
      if (event.event === 'Task' && max && event.attempt > max) {
        // One alert per task and attempt, however often the attempt is updated.
        const { activity } = await import('./devlog-report.mjs');
        const key = `${event.id}#${event.attempt}`;
        if (!activity().some((e) => e.event === 'Alert' && e.rule === 'task-attempts' && e.key === key)) {
          append({ ts: event.ts, session: event.session, event: 'Alert', kind: 'stop-loss', rule: 'task-attempts', key });
        }
        console.log(`STOP-LOSS TRIGGERED (dev Control Tower): task ${event.id} is on attempt ${event.attempt}, over the budget of ${max}. Stop repeating this approach, record the evidence, tell the owner, and continue only with a different approach.`);
      }
    }
  } catch (e) {
    console.error(e instanceof UsageError ? e.message : `devlog-task failed: ${e.message}`);
    process.exit(1);
  }
}
