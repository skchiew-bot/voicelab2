#!/usr/bin/env node
// Dev Control Tower report, modelled on skchiew-bot/d3ngineering: the six control-tower areas
// (section 34: workload, agent operations, quality, performance, AI economics, governance), the
// development control board (44) with task progress (12), the incident register (45), the model
// performance registry (17), stop-loss and wasted-effort alerts (18, 19) and the learning loop
// (20: incident, lesson, guard). Built from git, devlog/ and the spool; no model is called.
//
//   node scripts/devlog-report.mjs [--prs prs.json] [--html out.html] [--json out.json]
//
// prs.json is a list of pull requests as GitHub returns them (number, title, state, html_url,
// created_at, merged_at, body). Review findings are read from the "Independent review" table in
// each body. Without --prs the report still covers everything that lives in the repository.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fromUnits, priceTokens, readConfig, toUnits } from '../.claude/hooks/devlog.mjs';
import { clean } from './devlog-flush.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const git = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
// Only claude.ai sessions have a link; a local CLI session's id does not.
const sessionUrl = (id) => (/^session_\w+$/.test(id) ? `https://claude.ai/code/${id}` : null);

// ----------------------------------------------------------------- commits
function commits() {
  const refs = ['HEAD', ...(git('rev-parse', '--verify', '--quiet', 'origin/main') ? ['origin/main'] : [])];
  const out = git('log', ...refs, '--format=%h%x1f%aI%x1f%s%x1f%(trailers:key=Claude-Session,valueonly,separator=%x2c)%x1f%P%x1e');
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, date, subject, trailer, parents] = r.split('\x1f');
    const session = /session_[\w]+/.exec(trailer ?? '')?.[0] ?? null;
    const pr = /\(#(\d+)\)$|pull request #(\d+)/.exec(subject ?? '');
    return { sha, date: new Date(date).toISOString(), subject, session, merge: (parents ?? '').trim().includes(' '), pr: pr ? Number(pr[1] ?? pr[2]) : null };
  });
}

// ----------------------------------------------------------------- lessons
export function parseLessons(md) {
  return md.split(/^### /m).slice(1).map((chunk) => {
    const [heading = '', ...rest] = chunk.split('\n');
    const body = rest.join('\n');
    const m = /^(L-\d{3}): (.+)$/.exec(heading.trim());
    const field = (name) => new RegExp(`^- \\*\\*${name}:\\*\\* (.+)$`, 'm').exec(body)?.[1] ?? '';
    const seen = field('Seen');
    const guards = [...body.matchAll(/^\s+- `([^`]+)` › "([^"]+)"\s*$/gm)].map((g) => {
      const file = path.join(root, g[1]);
      const ok = existsSync(file) && readFileSync(file, 'utf8').replace(/\\'/g, "'").includes(g[2]);
      return { file: g[1], text: g[2], ok };
    });
    const prs = [...new Set([...seen.matchAll(/\[#(\d+)\]/g)].map((x) => Number(x[1])))];
    return {
      id: m?.[1] ?? heading, title: m?.[2] ?? '', rule: field('Rule'),
      seen: seen.replace(/\[(#\d+)\]\([^)]*\)/g, '$1'), times: Number(/^(\d+) times/.exec(seen)?.[1] ?? 1), prs, guards,
    };
  });
}

// ---------------------------------------------------------------- activity
// Committed lines (devlog/activity) plus this machine's unflushed spool, each line counted once.
// Every line goes through the flush allowlist: the dashboard is published too (lesson L-017).
export function activity(dir = root) {
  const seen = new Set();
  return [path.join(dir, 'devlog', 'activity'), path.join(dir, 'devlog', '.spool')].flatMap((d) =>
    existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) =>
      readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        let e; try { e = clean(JSON.parse(l)); } catch { return []; }
        if (!e) return [];
        const key = [e.ts, e.session, e.event, e.tool, e.target, e.id, e.action, e.rule, e.key, e.transcript].join('|');
        if (seen.has(key)) return [];
        seen.add(key);
        return [e];
      })) : []).sort((a, b) => a.ts.localeCompare(b.ts));
}

// --------------------------------------------------------------- PR reviews
export function reviewFindings(body = '') {
  const section = /##[^\n]*review[^\n]*\n([\s\S]*?)(?=\n## |$)/i.exec(body)?.[1] ?? '';
  const rows = section.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  return rows.map((cells) => {
    const hasSeverity = cells.length >= 4;
    const severity = hasSeverity ? cells[1] : (/\*\*(High|Medium|Low)[^*]*\*\*/i.exec(cells[1] ?? '')?.[1] ?? 'Unrated');
    const finding = (hasSeverity ? cells[2] : cells[1]).replace(/\*\*[^*]+:\*\*\s*/, '').replace(/\*\*/g, '');
    const outcome = cells.at(-1) ?? '';
    return { severity, finding, fixed: /\bfixed\b/i.test(outcome) && !/^\**left|not changed/i.test(outcome) };
  });
}

// ------------------------------------------------------------ branches
/** Plan phases (id and name) from src/progress.ts, which a test ties to BUILD_PLAN.md. */
export function planPhases(dir = root) {
  try {
    const src = readFileSync(path.join(dir, 'src', 'progress.ts'), 'utf8');
    return [...src.matchAll(/^\s*id: '([^']+)', name: '([^']+)'/gm)].map((m) => ({ id: m[1], name: m[2] }));
  } catch { return []; }
}

/**
 * Every branch on origin, classed as:
 * - trunk: `main`;
 * - plan: named for a plan phase (`claude/phase-<id>-`, ids from src/progress.ts), or carrying a PR
 *   whose title starts with a plan phase (closed-unmerged PRs do not count);
 * - task: justified only by a board task (linked with --branch, or through the task's PR). Not a
 *   fork, but listed for the owner to confirm, since any session can create a task;
 * - fork: none of the above.
 * GitHub forks (from devlog/repo.json) are compared by commit only: a fork branch whose commit is
 * on no branch here has diverged. Reads local remote-tracking refs: run `git fetch --prune origin`
 * first; the report shows when that fetch happened.
 */
export function branchAudit({ prs, board, phases, repo, cfg, now }) {
  const bc = cfg.branches ?? {};
  const trunk = bc.trunk ?? 'main';
  const phaseRe = new RegExp(bc.phasePattern ?? '^claude/phase-([0-9a-z]+)-', 'i');
  const stale = (bc.staleDays ?? 7) * 864e5;
  const phaseById = new Map(phases.map((p) => [p.id.toLowerCase(), p]));
  // A title that starts with a plan phase ("Phase 3: …", "Phase CT …"), not one that mentions one.
  const phaseInTitle = (title) => { const m = /^Phase ([0-9a-z]+)(?![.\w-])/i.exec(String(title ?? '').trim()); return m ? phaseById.get(m[1].toLowerCase()) : null; };
  let fetchedAt = null;
  try { fetchedAt = statSync(path.join(root, '.git', 'FETCH_HEAD')).mtime.toISOString(); } catch { /* never fetched */ }
  const base = { trunk, defaultBranch: repo?.defaultBranch ?? null, forksCount: repo?.forksCount ?? null, checkedAt: repo?.checkedAt ?? null, fetchedAt };

  // Without the trunk there is nothing to measure against: say so, and flag nothing (lessons L-005, L-020).
  if (!git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`).trim()) {
    return { ...base, error: `origin/${trunk} is missing, so the branch audit did not run. Fetch it (git fetch --prune origin) or check branches.trunk.`, branches: [], forks: [], uninspectedForks: 0 };
  }

  const classify = (name, sha) => {
    const reasons = []; let plan = null; let cls = 'fork';
    if (name === trunk) return { cls: 'trunk', plan: null, reasons: ['trunk'], prs: [] };
    const branchPrs = prs.filter((p) => p.head === name);
    const m = phaseRe.exec(name);
    if (m) {
      const p = phaseById.get(m[1].toLowerCase());
      if (p) { plan = `Phase ${p.id}: ${p.name}`; cls = 'plan'; reasons.push('named for a plan phase'); }
      else reasons.push(`names phase "${m[1]}", which is not in the plan`);
    }
    for (const p of branchPrs.filter((x) => x.state !== 'closed')) { // merged or open; closed unmerged does not count
      const ph = phaseInTitle(p.title);
      if (ph && cls !== 'plan') { plan = `Phase ${ph.id}: ${ph.name} (#${p.number})`; cls = 'plan'; reasons.push(`PR #${p.number} is plan work`); }
    }
    if (cls !== 'plan') {
      const tasks = board.filter((t) => t.status !== 'abandoned' && (t.branch === name || (t.pr && branchPrs.some((p) => p.number === t.pr))));
      if (tasks.length) { plan = `Task ${tasks.map((t) => t.id).join(', ')}`; cls = 'task'; reasons.push('justified only by a board task: the owner should confirm it'); }
    }
    if (cls === 'fork' && !reasons.length) reasons.push('no plan phase, PR or board task');
    return { cls, plan, reasons, prs: branchPrs.map((p) => ({ number: p.number, state: p.state, headSha: p.headSha ?? null })) };
  };

  // One call for every branch: name, commit, date, and commits behind/ahead of the trunk.
  const rows = git('for-each-ref', 'refs/remotes/origin', `--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(ahead-behind:refs/remotes/origin/${trunk})`)
    .split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([r]) => r !== 'origin/HEAD' && r !== 'origin');
  const branches = rows.map(([ref, sha, date, ab]) => {
    const name = ref.replace(/^origin\//, '');
    const [ahead, behind] = /^\d+ \d+$/.test(ab ?? '') ? ab.split(' ').map(Number) : [null, null]; // unknown, never guessed as 0
    const c = classify(name, sha);
    const last = new Date(date).toISOString();
    const openPr = c.prs.some((p) => p.state === 'open');
    const mergedPr = c.prs.find((p) => p.state === 'merged' && p.headSha && p.headSha === sha); // squash or rebase merges too
    const isDefault = repo?.defaultBranch === name;
    const flags = [];
    let merged = false;
    if (name !== trunk) {
      if (isDefault) flags.push('default branch is not the trunk');
      if (ahead === null) flags.push('could not compare with the trunk');
      else if ((ahead === 0 && behind > 0 && !openPr) || mergedPr) {
        merged = true;
        flags.push(isDefault ? 'merged: change the default branch first, then it can be deleted' : 'merged: can be deleted');
      } else if (ahead === 0) flags.push('no new commits');
      else {
        if (!openPr) flags.push('unmerged, no open PR');
        if (now - new Date(last) > stale) flags.push(`no commit for ${Math.floor((now - new Date(last)) / 864e5)} days`);
      }
    }
    return { repo: repo?.fullName ?? 'origin', name, sha: sha.slice(0, 7), last, ahead, behind, merged, isDefault, ...c, flags };
  }).sort((a, b) => (a.name === trunk ? -1 : b.name === trunk ? 1 : b.last.localeCompare(a.last)));

  // Fork branches are judged by their commit only, never by name.
  const forks = (Array.isArray(repo?.forks) ? repo.forks : []).map((f) => ({
    fullName: String(f?.fullName ?? ''), url: f?.url, pushedAt: f?.pushedAt ?? null,
    branches: (Array.isArray(f?.branches) ? f.branches : []).map((b) => {
      const sha = String(b?.sha ?? '');
      const inSync = /^[0-9a-f]{7,40}$/.test(sha) && git('branch', '-r', '--contains', sha).trim() !== '';
      return { name: String(b?.name ?? ''), sha: sha.slice(0, 7), inSync, flags: inSync ? [] : ['has commits on no branch of this repository'] };
    }),
  }));
  return { ...base, branches, forks, uninspectedForks: Math.max(0, (repo?.forksCount ?? 0) - forks.length) };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null); // a ratio of counts, for display only
const tierOf = (model, tiers = {}) => Object.entries(tiers).find(([k, v]) => !k.startsWith('_') && Array.isArray(v) && v.some((w) => model.includes(w)))?.[0] ?? 'other';
const minutesBetween = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);

/** Money as exact decimal strings, with RM when a rate is configured. */
function money(units, cfg) {
  const out = { usd: fromUnits(units) };
  const rate = cfg.currency?.myrPerUsd;
  if (rate) out.myr = fromUnits((units * toUnits(rate) + 50_000_000n) / 100_000_000n);
  return out;
}

/** Fold Task events into the board, newest values winning. Exported for the task CLI. */
export function buildBoard(events = activity(), now = new Date()) {
  const tasks = new Map();
  for (const e of events.filter((x) => x.event === 'Task')) {
    const t = tasks.get(e.id) ?? { id: e.id, status: 'planned', sessions: [], events: 0, started: e.ts, attempt: 1 };
    for (const k of ['title', 'epic', 'workstream', 'phase', 'owner', 'status', 'progress', 'attempt', 'tests', 'blocker', 'next', 'pr', 'branch']) {
      if (e[k] !== undefined) t[k] = e[k];
    }
    if (e.action === 'done') { t.finished = e.ts; t.blocker = ''; }
    else if (e.status && !['done', 'abandoned'].includes(e.status)) delete t.finished; // reopened
    if (!t.sessions.includes(e.session)) t.sessions.push(e.session);
    t.events++; t.updated = e.ts;
    tasks.set(e.id, t);
  }
  return [...tasks.values()].map((t) => ({
    ...t, blocker: t.blocker || undefined,
    elapsedMinutes: minutesBetween(t.started, t.finished ?? now.toISOString()),
  })).sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.updated.localeCompare(a.updated));
}

export function build(opts = {}) {
  const cfg = readConfig(root);
  const now = opts.now ?? new Date();
  const all = commits();
  const lessons = parseLessons(readFileSync(path.join(root, 'devlog', 'lessons.md'), 'utf8'));
  const events = activity();
  const prsFile = opts.prs ?? arg('--prs');
  const prs = (prsFile ? JSON.parse(readFileSync(prsFile, 'utf8')) : []).map((p) => {
    const findings = p.findings ?? reviewFindings(p.body);
    return {
      number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'merged' : p.state, head: p.head ?? null, headSha: p.head_sha ?? null,
      created: p.created_at, merged: p.merged_at ?? null, findings, reviewed: findings.length > 0,
      lessons: lessons.filter((l) => l.prs.includes(p.number)).map((l) => l.id),
    };
  }).sort((a, b) => a.number - b.number);
  const highRisk = (cfg.highRiskPaths?.patterns ?? []).map((r) => new RegExp(r));

  // ---------------------------------------------------------------- sessions
  const sessions = new Map();
  const touch = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        id, url: sessionUrl(id), first: null, last: null, commits: 0, prompts: 0, tools: 0, failures: 0,
        tests: 0, testsFailed: 0, edits: {}, highRiskFiles: new Set(), subagents: {}, usage: new Map(), alerts: 0, tasks: new Set(),
      });
    }
    return sessions.get(id);
  };
  const stamp = (s, t) => { if (!s.first || t < s.first) s.first = t; if (!s.last || t > s.last) s.last = t; };
  for (const c of all) if (c.session && !c.merge) { const s = touch(c.session); s.commits++; stamp(s, c.date); }
  for (const e of events) {
    const s = touch(e.session);
    if (e.event !== 'Task' && e.event !== 'Incident') stamp(s, e.ts);
    if (e.event === 'UserPromptSubmit') s.prompts++;
    if (e.tool) {
      s.tools++;
      if (!e.ok) s.failures++;
      if (e.kind === 'test') { s.tests++; if (!e.ok) s.testsFailed++; }
      if (/^(Edit|Write|NotebookEdit)$/.test(e.tool) && e.target && e.target !== '(outside project)') {
        s.edits[e.target] = (s.edits[e.target] ?? 0) + 1;
        if (highRisk.some((r) => r.test(e.target))) s.highRiskFiles.add(e.target);
      }
    }
    if (e.event === 'SubagentStart') s.subagents[e.agentId ?? e.ts] = { type: e.agentType, started: e.ts, active: true };
    if (e.event === 'SubagentStop' && s.subagents[e.agentId]) s.subagents[e.agentId].active = false;
    if (e.event === 'Usage') s.usage.set('session', e); // each record covers the whole session; keep the latest
    if (e.event === 'Alert') s.alerts++;
    if (e.event === 'Task') s.tasks.add(e.id);
  }
  const sessionRows = [...sessions.values()].map((s) => {
    const usages = [...s.usage.values()];
    const cost = sum(usages.map((u) => (u.costUSD ? toUnits(u.costUSD) : 0n)));
    const models = {};
    for (const u of usages) {
      for (const [m, t] of Object.entries(u.tokens ?? {})) {
        const acc = models[m] ??= { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
        for (const k of Object.keys(acc)) acc[k] += t[k] ?? 0;
      }
    }
    const reworked = Object.entries(s.edits).filter(([, n]) => n >= 3).length;
    const last = s.last;
    return {
      id: s.id, url: s.url, first: s.first, last, commits: s.commits, prompts: s.prompts, tools: s.tools, failures: s.failures,
      tests: s.tests, testsFailed: s.testsFailed, filesEdited: Object.keys(s.edits).length, reworkedFiles: reworked,
      highRisk: [...s.highRiskFiles], alerts: s.alerts, tasks: [...s.tasks],
      subagents: Object.values(s.subagents), activeSubagents: Object.values(s.subagents).filter((a) => a.active).length,
      models, costUnits: cost, cost: money(cost, cfg), metered: usages.length > 0,
      costBasis: usages.some((u) => u.costBasis === 'transcript-only') ? 'partial' : usages.length ? 'checkpoint' : 'none',
      touchMinutes: minutesBetween(s.first, last),
      active: last ? (now - new Date(last)) / 60000 <= (cfg.activeWithinMinutes ?? 30) : false,
    };
  }).sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));

  // -------------------------------------------------------------- the board
  const board = buildBoard(events, now);
  // A session's spend is shared evenly between the tasks it worked on.
  const taskCost = new Map();
  for (const s of sessionRows) {
    if (!s.tasks.length) continue;
    const n = BigInt(s.tasks.length);
    const share = s.costUnits / n;
    s.tasks.forEach((id, i) => taskCost.set(id, (taskCost.get(id) ?? 0n) + share + (i === 0 ? s.costUnits - share * n : 0n))); // the remainder goes to the first task, so nothing is lost
  }
  const sessionsById = new Map(sessionRows.map((s) => [s.id, s]));
  for (const t of board) {
    t.cost = money(taskCost.get(t.id) ?? 0n, cfg);
    t.models = [...new Set(t.sessions.flatMap((id) => Object.keys(sessionsById.get(id)?.models ?? {})))];
    t.tokens = t.sessions.reduce((n, id) => n + Object.values(sessionsById.get(id)?.models ?? {}).reduce((a, m) => a + m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h, 0), 0);
  }

  // ----------------------------------------------------- incidents and alerts
  const lessonById = new Map(lessons.map((l) => [l.id, l]));
  const incidents = events.filter((e) => e.event === 'Incident').map((i) => {
    const l = i.lesson ? lessonById.get(i.lesson) : null;
    return { ...i, lessonTitle: l?.title ?? null, guarded: l ? l.guards.length > 0 && l.guards.every((g) => g.ok) : null };
  }).sort((a, b) => b.ts.localeCompare(a.ts));
  const alerts = events.filter((e) => e.event === 'Alert').sort((a, b) => b.ts.localeCompare(a.ts));

  // ------------------------------------------------------------ AI economics
  const byModel = {};
  for (const s of sessionRows) {
    for (const [m, t] of Object.entries(s.models)) {
      const acc = byModel[m] ??= { model: m, tier: tierOf(m, cfg.modelTiers), sessions: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, tools: 0, failures: 0, tests: 0, testsFailed: 0 };
      acc.sessions++;
      for (const k of ['messages', 'input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) acc[k] += t[k];
      // Tool calls and test runs belong to the model that led the session (the most output), not to
      // a subagent's model that happened to be used alongside it.
      const lead = Object.entries(s.models).sort((a, b) => b[1].output - a[1].output)[0]?.[0];
      if (m === lead) { acc.ledSessions = (acc.ledSessions ?? 0) + 1; acc.tools += s.tools; acc.failures += s.failures; acc.tests += s.tests; acc.testsFailed += s.testsFailed; }
    }
  }
  let cacheSaved = 0n;
  const registry = Object.values(byModel).map((m) => {
    const cost = priceTokens(m.model, m, cfg.pricing);
    const p = cfg.pricing?.perMTokUSD?.[m.model];
    if (p) cacheSaved += (BigInt(m.cacheRead) * (toUnits(p.input) - toUnits(p.cacheRead)) + 500_000n) / 1_000_000n;
    return {
      ...m, priced: cost !== null, costUnits: cost ?? 0n, cost: money(cost ?? 0n, cfg),
      costPerSession: money(cost !== null && m.sessions ? cost / BigInt(m.sessions) : 0n, cfg),
      toolFailureRate: pct(m.failures, m.tools), testPassRate: m.tests ? pct(m.tests - m.testsFailed, m.tests) : null,
    };
  }).sort((a, b) => (b.costUnits > a.costUnits ? 1 : b.costUnits < a.costUnits ? -1 : 0));
  const spend = sum(sessionRows.map((s) => s.costUnits));
  const tierSpend = {};
  for (const m of registry) tierSpend[m.tier] = (tierSpend[m.tier] ?? 0n) + m.costUnits;
  const pricedTotal = sum(registry.map((m) => m.costUnits));
  const merged = prs.filter((p) => p.state === 'merged');
  const done = board.filter((t) => t.status === 'done');
  const metered = sessionRows.filter((s) => s.metered);
  const economics = {
    spend: money(spend, cfg),
    byTier: Object.fromEntries(Object.entries(tierSpend).map(([k, v]) => [k, { ...money(v, cfg), share: pricedTotal > 0n ? Number((v * 10000n) / pricedTotal) / 100 : null }])),
    premiumSessions: metered.filter((s) => Object.keys(s.models).some((m) => tierOf(m, cfg.modelTiers) === 'high')).length,
    meteredSessions: metered.length,
    cacheSaved: money(cacheSaved, cfg),
    cacheReadShare: (() => { const t = registry.reduce((a, m) => ({ r: a.r + m.cacheRead, all: a.all + m.input + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h }), { r: 0, all: 0 }); return pct(t.r, t.all); })(),
    perDoneTask: done.length ? money(sum(done.map((t) => taskCost.get(t.id) ?? 0n)) / BigInt(done.length), cfg) : null,
    wasteAlerts: alerts.filter((a) => a.kind === 'waste').length,
    stopLossAlerts: alerts.filter((a) => a.kind === 'stop-loss').length,
    failedTestRuns: sessionRows.reduce((n, s) => n + s.testsFailed, 0),
    unpriced: [...new Set(events.filter((e) => e.event === 'Usage').flatMap((e) => e.unpriced ?? []))],
    partial: sessionRows.some((s) => s.costBasis === 'partial'),
    unmetered: sessionRows.filter((s) => !s.metered && s.tools > 0).length, // logged activity but no usage record
    unassignedSpend: money(spend - sum([...taskCost.values()]), cfg), // spend in sessions that recorded no task
    pricing: { source: cfg.pricing?.source ?? null, asOf: cfg.pricing?.asOf ?? null },
    currency: cfg.currency?.myrPerUsd ? { myrPerUsd: cfg.currency.myrPerUsd, asOf: cfg.currency.asOf, source: cfg.currency.source } : null,
  };

  // ------------------------------------------------------- the six areas (34)
  const since = (days) => new Date(now - days * 864e5).toISOString();
  const findings = prs.flatMap((p) => p.findings);
  const closedUnmerged = prs.filter((p) => p.state === 'closed' && !p.merged).length;
  const reverts = all.filter((c) => !c.merge && /^Revert\b/.test(c.subject)).length;
  const realCommits = all.filter((c) => !c.merge);
  const commitSessions = new Set(realCommits.map((c) => c.session).filter(Boolean));
  const loggedSessions = new Set(events.map((e) => e.session));
  const activitySince = events.find((e) => e.event !== 'Task' && e.event !== 'Incident')?.ts ?? null;
  const loggableCommitSessions = [...commitSessions].filter((id) => (sessionsById.get(id)?.last ?? '') >= (activitySince ?? '~'));
  // Logging gaps: a session that committed well after its last logged event was not being
  // logged (for example, Claude Code opened it outside the repository, so the hooks never loaded).
  const lastLogged = new Map();
  // Only what the hooks record on their own counts; usage, tasks or incidents recorded by hand do not.
  for (const e of events) if (['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure'].includes(e.event)) lastLogged.set(e.session, e.ts);
  const gaps = [];
  for (const id of commitSessions) {
    const logged = lastLogged.get(id);
    const late = realCommits.filter((c) => c.session === id && activitySince && c.date >= activitySince
      && (!logged || new Date(c.date) - new Date(logged) > 30 * 60000));
    if (late.length) gaps.push({ session: id, url: sessionUrl(id), commits: late.length, lastLogged: logged ?? null });
  }
  const tests = sessionRows.reduce((a, s) => ({ runs: a.runs + s.tests, failed: a.failed + s.testsFailed }), { runs: 0, failed: 0 });

  const areas = {
    workload: {
      openPrs: prs.filter((p) => p.state === 'open').length,
      openTasks: board.filter((t) => !['done', 'abandoned'].includes(t.status)).length,
      blockedTasks: board.filter((t) => !['done', 'abandoned'].includes(t.status) && (t.status === 'blocked' || t.blocker)).length,
      incidents7d: incidents.filter((i) => i.ts >= since(7)).length,
      securityIncidents: incidents.filter((i) => i.type === 'security').length,
      failedTestRuns7d: events.filter((e) => e.kind === 'test' && e.ok === false && e.ts >= since(7)).length,
    },
    agents: sessionRows.filter((s) => s.active).map((s) => {
      const task = board.find((t) => t.sessions.includes(s.id) && t.status !== 'done');
      return { session: s.id, url: s.url, task: task?.id ?? null, title: task?.title ?? null, phase: task?.phase ?? null, progress: task?.progress ?? null,
        models: Object.keys(s.models), tokens: Object.values(s.models).reduce((n, m) => n + m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h, 0),
        cost: s.cost, errors: s.failures, subagents: s.activeSubagents, last: s.last };
    }),
    quality: {
      firstPassRate: pct(done.filter((t) => (t.attempt ?? 1) === 1).length, done.length),
      testPassRate: tests.runs ? pct(tests.runs - tests.failed, tests.runs) : null,
      testRuns: tests.runs,
      repeatedLessons: lessons.filter((l) => l.times >= 2).length,
      regressions: incidents.filter((i) => i.type === 'agent_regression').length,
      rollbackRate: pct(reverts, realCommits.length),
      rejectionRate: pct(closedUnmerged, prs.filter((p) => p.state !== 'open').length),
      findingsPerPr: merged.filter((p) => p.reviewed).length ? Math.round((findings.length / merged.filter((p) => p.reviewed).length) * 10) / 10 : null,
      overEngineering: null, // not measurable from these sources yet
    },
    performance: sessionRows.filter((s) => s.commits || s.tools).slice(0, 25).map((s) => ({
      session: s.id, url: s.url, last: s.last, outcomes: s.commits, tasksDone: board.filter((t) => t.status === 'done' && t.sessions.includes(s.id)).length,
      touchMinutes: s.touchMinutes, rework: s.reworkedFiles, failures: s.failures, tests: s.tests, testsFailed: s.testsFailed, cost: s.cost,
    })),
    aiShare: pct(realCommits.filter((c) => c.session).length, realCommits.length),
    governance: {
      approvals: merged.length,
      unreviewedMerged: merged.filter((p) => !p.reviewed).map((p) => p.number),
      stopLossTriggers: alerts.filter((a) => a.kind === 'stop-loss').length,
      policyUpdates: incidents.filter((i) => i.policyUpdated).length,
      policyViolations: lessons.reduce((n, l) => n + l.guards.filter((g) => !g.ok).length, 0),
      highRiskSessions: sessionRows.filter((s) => s.highRisk.length).map((s) => ({ session: s.id, url: s.url, files: s.highRisk })),
      auditCompleteness: pct(loggableCommitSessions.filter((id) => loggedSessions.has(id) && !gaps.some((g) => g.session === id)).length, loggableCommitSessions.length),
      loggingGaps: gaps,
      loggingSince: activitySince,
    },
  };

  // -------------------------------------------------------------- branches
  let repoFacts = null;
  try { repoFacts = JSON.parse(readFileSync(path.join(root, 'devlog', 'repo.json'), 'utf8')); } catch { /* not recorded yet */ }
  let branches;
  try { branches = branchAudit({ prs, board, phases: planPhases(), repo: repoFacts, cfg, now }); }
  catch (err) { branches = { trunk: cfg.branches?.trunk ?? 'main', error: `The branch audit failed: ${String(err?.message ?? err).slice(0, 200)}`, branches: [], forks: [], uninspectedForks: 0 }; } // one bad record must not take the report down (L-006)

  // ------------------------------------------------------------- attention
  const behind = Number(git('rev-list', '--count', 'HEAD..origin/main').trim() || 0);
  const starts = events.filter((e) => e.event === 'SessionStart').sort((a, b) => b.ts.localeCompare(a.ts));
  const attention = [];
  for (const l of lessons) for (const g of l.guards) if (!g.ok) attention.push({ level: 'critical', text: `${l.id} lost its guard: "${g.text}" is no longer in ${g.file}.` });
  for (const a of alerts.filter((x) => x.kind === 'stop-loss' && x.ts >= since(2))) attention.push({ level: 'critical', text: `Stop-loss in ${a.session.slice(-8)}: ${a.rule} (${a.key}).` });
  for (const t of board.filter((x) => x.blocker && x.status !== 'done')) attention.push({ level: 'warning', text: `${t.id} is blocked: ${t.blocker}` });
  for (const t of board.filter((x) => (x.attempt ?? 1) > (cfg.stopLoss?.maxTaskAttempts ?? 99) && x.status !== 'done')) attention.push({ level: 'warning', text: `${t.id} is on attempt ${t.attempt}.` });
  for (const l of lessons.filter((x) => x.times >= 2)) attention.push({ level: 'warning', text: `${l.id} has happened ${l.times} times: ${l.title}.` });
  if (behind > 0) attention.push({ level: 'warning', text: `This branch is ${behind} commits behind main (lesson L-013).` });
  for (const n of areas.governance.unreviewedMerged) attention.push({ level: 'info', text: `PR #${n} was merged with no independent review recorded.` });
  for (const p of prs.filter((x) => x.state === 'open')) attention.push({ level: 'info', text: `PR #${p.number} is open: ${p.title}.` });
  for (const s of starts.filter((x) => x.behind_main > 0).slice(0, 5)) attention.push({ level: 'info', text: `A session started ${s.behind_main} commits behind main on ${s.ts.slice(0, 10)}.` });
  for (const g of areas.governance.loggingGaps) attention.push({ level: 'warning', text: `Session ${g.session.slice(-8)} made ${g.commits} commit(s) while not being logged${g.lastLogged ? ` (last logged ${g.lastLogged.slice(0, 16).replace('T', ' ')} UTC)` : ''}. Its hooks were not running.` });
  // Branch findings, summarised so a repository with many branches stays readable.
  const capped = (list, max = 8) => (list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', '));
  if (branches.error) attention.push({ level: 'warning', text: branches.error });
  if (branches.defaultBranch && branches.defaultBranch !== branches.trunk) attention.push({ level: 'warning', text: `The repository's default branch on GitHub is ${branches.defaultBranch}, not ${branches.trunk}: clones and the GitHub page show it. The owner can change it in the repository settings.` });
  const forkBranches = branches.branches.filter((x) => x.cls === 'fork');
  if (forkBranches.length) attention.push({ level: 'warning', text: `${forkBranches.length} branch(es) are not part of the plan: ${capped(forkBranches.map((b) => `${b.name} (${b.reasons.join('; ')})`))}. Ask the owner whether to link each to a task or retire it.` });
  const taskOnly = branches.branches.filter((x) => x.cls === 'task' && !x.merged);
  if (taskOnly.length) attention.push({ level: 'info', text: `Branch(es) justified only by a board task, for the owner to confirm: ${capped(taskOnly.map((b) => `${b.name} (${b.plan})`))}.` });
  const staleOnes = branches.branches.filter((x) => x.flags.some((f) => f.startsWith('no commit')));
  if (staleOnes.length) attention.push({ level: 'warning', text: `Unmerged work has gone quiet on: ${capped(staleOnes.map((b) => `${b.name} (${b.flags.find((f) => f.startsWith('no commit'))})`))}.` });
  const mergedLeft = branches.branches.filter((x) => x.merged);
  if (mergedLeft.length) attention.push({ level: 'info', text: `${mergedLeft.length} merged branch(es) are still on GitHub and can be deleted by the owner: ${capped(mergedLeft.filter((b) => !b.isDefault).map((b) => b.name))}${mergedLeft.some((b) => b.isDefault) ? `; ${mergedLeft.find((b) => b.isDefault).name} only after the default branch is changed` : ''}.` });
  const diverged = branches.forks.flatMap((f) => f.branches.filter((b) => !b.inSync).map((b) => `${f.fullName}:${b.name}`));
  if (diverged.length) attention.push({ level: 'warning', text: `GitHub fork branch(es) with commits on no branch of this repository: ${capped(diverged)}.` });
  if (branches.uninspectedForks) attention.push({ level: 'warning', text: `${branches.uninspectedForks} GitHub fork(s) of the repository have not been inspected. Ask the owner whether to add them to a session so their branches can be read.` });
  if (economics.unpriced.length) attention.push({ level: 'warning', text: `No price configured for ${economics.unpriced.join(', ')}; its cost is not counted.` });
  for (const a of alerts.filter((x) => x.kind === 'waste' && x.ts >= since(2))) attention.push({ level: 'info', text: `Wasted effort in ${a.session.slice(-8)}: ${a.rule} (${a.key}).` });

  return {
    generatedAt: now.toISOString(),
    repo: 'skchiew-bot/voicelab2',
    head: git('rev-parse', '--short', 'HEAD').trim(),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(),
    totals: {
      commits: realCommits.length, prsMerged: merged.length, findings: findings.length,
      findingsFixed: findings.filter((f) => f.fixed).length, highFindings: findings.filter((f) => /^high/i.test(f.severity)).length,
      lessons: lessons.length, guards: lessons.reduce((n, l) => n + l.guards.length, 0),
      guardsOk: lessons.reduce((n, l) => n + l.guards.filter((g) => g.ok).length, 0), repeats: lessons.filter((l) => l.times >= 2).length,
      sessions: sessionRows.length, toolCalls: events.filter((e) => e.tool).length, failures: events.filter((e) => e.event === 'PostToolUseFailure').length,
      incidents: incidents.length, openTasks: areas.workload.openTasks,
    },
    attention, areas, economics, board, incidents, branches, alerts: alerts.slice(0, 50), registry: registry.map(({ costUnits, ...r }) => r),
    prs, lessons,
    sessions: sessionRows.map(({ costUnits, ...s }) => s),
    commits: realCommits.slice(0, 60),
    failures: events.filter((e) => e.event === 'PostToolUseFailure').sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 50),
    budgets: cfg.stopLoss ?? {},
  };
}

/** Put the report into the dashboard template. A function replacement, so "$'" in a title is just text. */
export function renderHtml(template, report) {
  // Escape "<" so no value can close the script tag it is embedded in.
  const payload = JSON.stringify(report).replace(/</g, '\\u003c');
  return template.replace('/*REPORT*/null', () => payload);
}

// Run as a script (not when imported); compare real paths as URLs so spaces or symlinks work.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  const report = build();
  const json = JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  if (arg('--json')) writeFileSync(arg('--json'), json);
  if (arg('--html')) {
    const templatePath = path.join(root, 'devlog', 'dashboard.html');
    if (path.resolve(arg('--html')) === templatePath) {
      console.error('Refusing to overwrite the template devlog/dashboard.html; write the dashboard somewhere else.');
      process.exit(1);
    }
    writeFileSync(arg('--html'), renderHtml(readFileSync(templatePath, 'utf8'), report));
  }
  if (!arg('--json') && !arg('--html')) process.stdout.write(json + '\n');
}
