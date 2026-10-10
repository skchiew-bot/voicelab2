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
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
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

/** What kind of shell command this was, from its text. Only the category is recorded. */
export function commandKind(command) {
  const c = String(command ?? '');
  if (/\b(vitest|jest|mocha|pytest|playwright test)\b|\bnpm (run )?test\b|\bnpx vitest\b/.test(c)) return 'test';
  if (/\b(typecheck|tsc\b)/.test(c)) return 'typecheck';
  if (/\b(build(:\w+)?|vite build)\b/.test(c)) return 'build';
  if (/\bgit push\b/.test(c)) return 'push';
  if (/\bgit commit\b/.test(c)) return 'commit';
  if (/\bgit (merge|rebase|pull)\b/.test(c)) return 'integrate';
  if (/\b(npm (ci|install)|pip install)\b/.test(c)) return 'install';
  return 'other';
}

export function readConfig(dir = root) {
  try { return JSON.parse(readFileSync(path.join(dir, 'devlog', 'control-tower.json'), 'utf8')); } catch { return {}; }
}

/** Exact comparison of two non-negative decimal strings (lesson L-004: no floats for money). */
export function decimalAtLeast(a, b) {
  const norm = (v) => { const [w = '0', f = ''] = String(v).split('.'); return [BigInt(w || '0'), f]; };
  const [aw, af] = norm(a); const [bw, bf] = norm(b);
  if (aw !== bw) return aw > bw;
  const n = Math.max(af.length, bf.length);
  return BigInt(af.padEnd(n, '0') || '0') >= BigInt(bf.padEnd(n, '0') || '0');
}

/**
 * Claude Code's own running totals for the session: the last "cost-state" record in the
 * transcript. It covers every model the session used, subagents included. Read from the end.
 */
export function latestCostState(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 2 << 20);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"cost-state"')) continue;
    try { const o = JSON.parse(lines[i]); if (o.type === 'cost-state') return o; } catch { /* partial line */ }
  }
  return null;
}

const emptyTokens = () => ({ messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

/**
 * Tokens per model for a session, from its transcript and its subagents' transcripts.
 * - Claude Code writes one line per content block, all with the same message id and usage, so
 *   each message is counted once.
 * - Background calls (such as the permission classifier) are not in the transcript. Claude Code's
 *   "cost-state" checkpoints do include them, so `since` holds only the messages after the last
 *   checkpoint; the session's spend is that checkpoint plus `since`.
 */
export function tokenUsage(transcriptPath) {
  const all = {}; const since = {};
  if (!transcriptPath) return { all, since, checkpointAt: null };
  const files = [transcriptPath];
  const subDir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  try { for (const f of readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f)); } catch { /* no subagents */ }

  const seen = new Set(); const messages = []; let checkpointAt = null;
  files.forEach((f, fileIndex) => {
    let text; try { text = readFileSync(f, 'utf8'); } catch { return; }
    let lastTs = null;
    for (const raw of text.split('\n')) {
      if (fileIndex === 0 && raw.includes('"cost-state"')) {
        try { if (JSON.parse(raw).type === 'cost-state') checkpointAt = lastTs ?? checkpointAt; } catch { /* partial */ }
        continue;
      }
      if (!raw.includes('"timestamp"') && !raw.includes('"usage"')) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      if (typeof e?.timestamp === 'string') lastTs = e.timestamp;
      const m = e?.message; const u = m?.usage;
      if (e?.type !== 'assistant' || !u || typeof m.model !== 'string' || !/^[\w.:-]{1,80}$/.test(m.model)) continue;
      const id = m.id ?? e.requestId ?? e.uuid;
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ model: m.model, u, ts: e.timestamp ?? '' });
    }
  });
  const add = (bucket, { model, u }) => {
    const t = bucket[model] ??= emptyTokens();
    const w1h = count(u.cache_creation?.ephemeral_1h_input_tokens);
    t.messages++;
    t.input += count(u.input_tokens);
    t.output += count(u.output_tokens);
    t.cacheRead += count(u.cache_read_input_tokens);
    t.cacheWrite1h += w1h;
    t.cacheWrite5m += Math.max(0, count(u.cache_creation_input_tokens) - w1h);
  };
  for (const msg of messages) {
    add(all, msg);
    if (checkpointAt && msg.ts > checkpointAt) add(since, msg);
  }
  return { all, since, checkpointAt };
}

// Exact money in 1e-8 USD units, as in src/money.ts (lesson L-004).
const SCALE = 100_000_000n;
export function toUnits(dec) {
  const m = /^(\d+)(?:\.(\d{0,8})\d*)?$/.exec(String(dec ?? '').trim());
  if (!m) throw new Error(`not a decimal: ${dec}`);
  return BigInt(m[1]) * SCALE + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
}
export function fromUnits(u) {
  const neg = u < 0n; const a = neg ? -u : u;
  return `${neg ? '-' : ''}${a / SCALE}.${String(a % SCALE).padStart(8, '0')}`;
}

/** Cost of a model's tokens at the configured prices, or null when the model has no price. */
export function priceTokens(model, t, pricing) {
  const p = pricing?.perMTokUSD?.[model];
  if (!p || !t) return null;
  const part = (tokens, rate) => (BigInt(tokens) * toUnits(rate) + 500_000n) / 1_000_000n; // per million, rounded half up
  return part(t.input, p.input) + part(t.output, p.output) + part(t.cacheRead, p.cacheRead)
    + part(t.cacheWrite5m, p.cacheWrite5m) + part(t.cacheWrite1h, p.cacheWrite1h);
}

const usd = (v) => (Number.isFinite(v) && v >= 0 ? v.toFixed(6) : '0.000000'); // Claude Code reports a float; fix it once, here
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** The usage fields worth keeping, as counts and fixed-point USD strings. */
export function usageFrom(cs) {
  const models = {};
  for (const [model, u] of Object.entries(cs?.modelUsage ?? {})) {
    if (!/^[\w.:-]{1,80}$/.test(model) || !u || typeof u !== 'object') continue;
    models[model] = {
      input: count(u.inputTokens), output: count(u.outputTokens), thinking: count(u.thinkingTokens),
      cacheRead: count(u.cacheReadInputTokens), cacheWrite: count(u.cacheCreationInputTokens), costUSD: usd(u.costUSD),
    };
  }
  return {
    costUSD: usd(cs?.totalCostUSD), models,
    durationMs: count(Math.round(cs?.totalDuration ?? 0)), apiMs: count(Math.round(cs?.totalAPIDuration ?? 0)),
    linesAdded: count(cs?.totalLinesAdded), linesRemoved: count(cs?.totalLinesRemoved),
  };
}

const spoolDir = (dir = root) => path.join(dir, 'devlog', '.spool');
export const spoolFile = (session, dir = root) => path.join(spoolDir(dir), `${String(session).replace(/[^\w-]/g, '').slice(-24)}.jsonl`);

function history(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

/**
 * Stop-loss (d3ngineering section 18) and wasted-effort (section 19) checks over this session's
 * log, including the line just recorded. Each alert fires once per session per rule and key.
 */
export function checks(past, line, cfg) {
  const stop = cfg.stopLoss ?? {}; const waste = cfg.waste ?? {};
  const all = [...past, line];
  const fired = new Set(past.filter((e) => e.event === 'Alert').map((e) => `${e.rule}|${e.key}`));
  const out = [];
  const add = (kind, rule, key, message) => { if (!fired.has(`${rule}|${key}`)) { fired.add(`${rule}|${key}`); out.push({ kind, rule, key, message }); } };
  const tools = all.filter((e) => e.event === 'PostToolUse' || e.event === 'PostToolUseFailure');

  if (line.kind === 'test' && line.ok === false && stop.maxFailedTestRunsInARow) {
    const tests = tools.filter((e) => e.kind === 'test');
    let streak = 0; let first = line.ts;
    for (let i = tests.length - 1; i >= 0 && tests[i].ok === false; i--) { streak++; first = tests[i].ts; }
    if (streak >= stop.maxFailedTestRunsInARow) {
      add('stop-loss', 'failed-test-runs', first, `${streak} test runs in a row have failed.`);
    }
  }
  if (line.tool === 'Bash' && line.ok === false && line.target && stop.maxSameCommandFailures) {
    const n = tools.filter((e) => e.tool === 'Bash' && e.ok === false && e.target === line.target).length;
    if (n >= stop.maxSameCommandFailures) add('stop-loss', 'same-command-failures', line.target, `"${line.target}" has failed ${n} times.`);
  }
  const edits = (f) => tools.filter((e) => /^(Edit|Write|NotebookEdit)$/.test(e.tool) && e.target === f);
  if (/^(Edit|Write|NotebookEdit)$/.test(line.tool) && line.target && stop.maxEditsToOneFile) {
    const n = edits(line.target).length;
    if (n >= stop.maxEditsToOneFile) add('stop-loss', 'edits-to-one-file', line.target, `${line.target} has been edited ${n} times this session.`);
  }
  if (line.tool === 'Read' && line.target && waste.maxReadsOfOneFileWithoutEdit) {
    const lastEdit = edits(line.target).at(-1)?.ts ?? '';
    const reads = tools.filter((e) => e.tool === 'Read' && e.target === line.target && e.ts > lastEdit).length;
    if (reads >= waste.maxReadsOfOneFileWithoutEdit) add('waste', 'rereads', line.target, `${line.target} has been read ${reads} times without a change in between.`);
  }
  if (line.event === 'Usage' && stop.maxSessionCostUSD && decimalAtLeast(line.costUSD, stop.maxSessionCostUSD)) {
    add('stop-loss', 'session-cost', String(stop.maxSessionCostUSD), `This session has cost ${line.costUSD} USD, at or over the ${stop.maxSessionCostUSD} USD budget.`);
  }
  return out;
}

export function alertText(a) {
  return a.kind === 'stop-loss'
    ? `STOP-LOSS TRIGGERED (dev Control Tower): ${a.message} Stop autonomous work on this, summarise the evidence, and escalate to the owner before trying again. If the owner already approved going on, record that with \`node scripts/devlog-task.mjs incident\`.`
    : `WASTED EFFORT (dev Control Tower): ${a.message} Change approach: summarise what you know, then act on it or ask.`;
}

function main() {
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
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
      + 'Track the task you work on with `node scripts/devlog-task.mjs` (start, update at each milestone, done). '
      + 'When you fix a bug, a review finding or a process mistake, record it in devlog/lessons.md with a guard.\n';
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    line.tool = scrub(ev.tool_name, 80);
    line.target = target(ev.tool_name, ev.tool_input);
    line.ok = event === 'PostToolUse';
    if (ev.tool_name === 'Bash') line.kind = commandKind(ev.tool_input?.command);
    if (typeof ev.duration_ms === 'number') line.ms = ev.duration_ms;
    if (!line.ok) line.failure = failureKind(ev.tool_name, ev.error, ev.is_interrupt);
  } else if (event === 'Stop' || event === 'SessionEnd') {
    if (event === 'SessionEnd') line.reason = scrub(ev.reason, 40);
    const { all, since, checkpointAt } = tokenUsage(ev.transcript_path);
    const cs = latestCostState(ev.transcript_path);
    if (Object.keys(all).length === 0 && !cs && event === 'Stop') return 0; // nothing to record yet
    if (event === 'SessionEnd') appendLine({ ts: line.ts, session: line.session, event: 'SessionEnd', reason: line.reason });
    const pricing = readConfig().pricing;
    const unpriced = new Set();
    const priceAll = (bucket) => {
      let total = 0n;
      for (const [model, t] of Object.entries(bucket)) {
        const c = priceTokens(model, t, pricing);
        if (c === null) unpriced.add(model); else { t.costUSD = fromUnits(c); total += c; }
      }
      return total;
    };
    const visible = priceAll(all);
    const after = priceAll(since);
    // A session can span several transcripts (a resume in another directory starts a new one); the
    // report adds up the latest record for each. A hash names the transcript without its local path.
    line.transcript = createHash('sha256').update(String(ev.transcript_path)).digest('hex').slice(0, 12);
    Object.assign(line, { event: 'Usage', at: event, tokens: all });
    if (cs) {
      // Claude Code's own figure (complete, background calls included) plus what came after it.
      line.checkpoint = usageFrom(cs);
      line.checkpointAt = checkpointAt;
      line.costUSD = fromUnits(toUnits(line.checkpoint.costUSD) + after);
      line.costBasis = 'checkpoint+since';
    } else {
      line.costUSD = fromUnits(visible);
      line.costBasis = 'transcript-only'; // background calls not included
    }
    if (unpriced.size) line.unpriced = [...unpriced]; // shown on the dashboard instead of a guessed price
  } else if (event === 'SubagentStart' || event === 'SubagentStop') {
    line.agentType = scrub(ev.agent_type ?? 'unknown', 60);
    line.agentId = scrub(ev.agent_id ?? '', 40);
  } else if (event === 'UserPromptSubmit') {
    // Counts turns only. The prompt itself is not recorded: it can hold anything the owner pasted.
  } else {
    return 0;
  }

  const file = spoolFile(line.session);
  const past = history(file);
  appendLine(line);
  const alerts = checks(past, line, readConfig());
  for (const a of alerts) appendLine({ ts: line.ts, session: line.session, event: 'Alert', kind: a.kind, rule: a.rule, key: a.key });
  if (context) process.stdout.write(context);
  if (alerts.length === 0) return 0;
  const text = alerts.map(alertText).join('\n');
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') { process.stderr.write(text + '\n'); return 2; } // shown to Claude; the tool has already run
  process.stdout.write(JSON.stringify({ systemMessage: text })); // shown to the owner
  return 0;
}

function appendLine(l) {
  mkdirSync(spoolDir(), { recursive: true });
  appendFileSync(spoolFile(l.session), JSON.stringify(l) + '\n');
}

// Run as a script (not when imported). Compare real paths as URLs: a space, % or symlink in the
// path must not make the hook silently do nothing.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  let code = 0;
  try { code = main(); } catch { /* never block the session */ }
  process.exit(code === 2 ? 2 : 0);
}
