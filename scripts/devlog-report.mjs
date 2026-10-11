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
import { PROCESSES, TRIGGERS, fromUnits, priceTokens, readConfig, toUnits } from '../.claude/hooks/devlog.mjs';
import { clean } from './devlog-flush.mjs';
import { secretHits } from './devlog-secrets.mjs';
import { throttleTable } from './devlog-throttle.mjs';

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
        // A Stop writes one AgentRun per helper agent, and verdicts can land in the same moment: each is its own line.
        const key = [e.ts, e.session, e.event, e.tool, e.target, e.id, e.action, e.rule, e.key, e.transcript, e.agentId, e.task, e.process, e.result, e.agent, e.shadowOf].join('|');
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

// ----------------------------------------------------------- audit integrity
const gitIn = (dir, args, input) => {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', input, maxBuffer: 64 << 20, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] }); } catch { return null; }
};

/**
 * The activity log is append-only: every file in devlog/activity must still hold exactly what it held in the commit
 * that added it, and none may be deleted. Compared blob by blob, so an edit made in a merge or not yet committed is
 * caught too. A file not committed yet is new, not a failure. When git cannot be read the result is "unavailable",
 * never a pass (lesson L-005).
 */
export function activityIntegrity(dir = root, accepted = {}, decisions = []) {
  const none = { state: 'unavailable', checked: 0, changed: [], deleted: [], accepted: [], pending: 0 };
  // -m: a file first added while resolving a merge shows only in the merge commit's own diff (review of DCT-11).
  const log = gitIn(dir, ['log', '-m', '--diff-filter=A', '--no-renames', '--raw', '--no-abbrev', '--format=', '--', 'devlog/activity']);
  if (log === null) return none;
  const added = new Map(); // path -> its blob when first added; the log runs newest first, so the oldest add is kept
  for (const line of log.split('\n')) {
    const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]{40,64}) A\t(devlog\/activity\/[^\t]+\.jsonl)$/.exec(line);
    if (m) added.set(m[2], m[1]);
  }
  const folder = path.join(dir, 'devlog', 'activity');
  const present = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith('.jsonl')).map((f) => `devlog/activity/${f}`) : [];
  const tracked = present.filter((f) => added.has(f));
  // A file git tracks but whose add cannot be found (a shallow clone, say) cannot be judged: never "new" (lesson L-005).
  const listed = gitIn(dir, ['ls-files', '--', 'devlog/activity']);
  if (listed === null) return none;
  const unknown = listed.split('\n').filter((f) => f.endsWith('.jsonl') && !added.has(f) && present.includes(f));
  if (unknown.length) return { ...none, unknown };
  const out = tracked.length ? gitIn(dir, ['hash-object', '--stdin-paths'], tracked.join('\n') + '\n') : '';
  if (out === null) return none;
  const now = out.split('\n').filter(Boolean);
  if (now.length !== tracked.length) return none;
  const current = new Map(tracked.map((f, i) => [f, now[i]]));
  const kept = new Set(present);
  // A change the owner accepted counts only while the file still holds exactly the content accepted (null: deleted),
  // and only with the decision that accepted it. Anything else stays a failure, and every accepted change stays listed.
  const byId = new Map(decisions.filter((d) => d?.event === 'Decision').map((d) => [d.id, d]));
  const ok = (f) => {
    const a = Object.hasOwn(accepted, f) ? accepted[f] : null;
    // The decision must be in the register, not merely shaped like an id (lesson L-024).
    return Boolean(a && typeof a.decision === 'string' && byId.has(a.decision) && (a.blob ?? null) === (current.get(f) ?? null));
  };
  const touched = [...tracked.filter((f) => current.get(f) !== added.get(f)), ...[...added.keys()].filter((f) => !kept.has(f))].sort();
  const changed = touched.filter((f) => kept.has(f) && !ok(f));
  const deleted = touched.filter((f) => !kept.has(f) && !ok(f));
  const acceptedList = touched.filter(ok).map((f) => {
    const d = byId.get(accepted[f].decision);
    return { file: f, decision: d.id, title: d.title, on: d.on, ref: d.ref ?? null, deleted: !kept.has(f) };
  });
  return { state: changed.length || deleted.length ? 'red' : 'green', checked: tracked.length, changed, deleted, accepted: acceptedList, pending: present.length - tracked.length };
}

// ------------------------------------------------------------- plan progress
/** How many string literals a list holds, from just after its "[" to its own "]", brackets inside quotes skipped. */
export function stringsInList(src, from) {
  let n = 0; let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; n++; } else if (c === ']') return n;
  }
  return n;
}
// Daythree pages use sentence case: a capitalised word after the first is lowered, an acronym (QA) and the named
// product "Control Tower" stay as they are.
export const sentenceCase = (title) => String(title).split(' ').map((w, i) => (i > 0 && /^[A-Z][a-z]+[,:]?$/.test(w) ? w.toLowerCase() : w.replace(/-([A-Z][a-z]+)/g, (x) => x.toLowerCase()))).join(' ').replace(/\bcontrol tower\b/gi, 'Control Tower');
/** Each phase of src/progress.ts with its exit criteria counted by state, for the phase track. Read as text: no build step. */
export function planProgress(dir = root) {
  let src;
  try { src = readFileSync(path.join(dir, 'src', 'progress.ts'), 'utf8'); } catch { return []; }
  const starts = [...src.matchAll(/^\s*id: '([^']+)', name: '([^']+)', status: '([a-z_]+)'/gm)];
  return starts.map((m, i) => {
    const block = src.slice(m.index, starts[i + 1]?.index ?? src.length);
    const openAt = block.search(/\bopen: \[/);
    const criteria = block.slice(block.search(/\bcriteria: \[/), openAt >= 0 ? openAt : undefined);
    const count = (re) => (criteria.match(re) ?? []).length;
    return {
      id: m[1], name: sentenceCase(m[2]), status: m[3],
      met: count(/state: 'met'/g), partly: count(/state: 'partly'/g), notMet: count(/state: 'not_met'/g) + count(/\bnotMet\(/g),
      fakes: count(/proof: 'fakes'/g), open: openAt >= 0 ? stringsInList(block, block.indexOf('[', openAt) + 1) : 0,
    };
  });
}

// ------------------------------------------------------------------- health
// The worst check sets the overall state. "Unavailable" (an input that could not be read) ranks with amber and is never
// green. "Off" is a check for something not built yet (the runner); it is shown but does not count.
const RANK = { green: 0, amber: 1, unavailable: 1, red: 2 };
export function overallHealth(checks) {
  const counted = checks.filter((c) => c.state !== 'off');
  if (!counted.length) return 'unavailable';
  const worst = Math.max(...counted.map((c) => RANK[c.state] ?? 1));
  return worst === 2 ? 'red' : worst === 1 ? 'amber' : 'green';
}

// Events a person or Claude records by hand, which say nothing about when a session was active.
const BY_HAND = new Set(['Task', 'Incident', 'Decision', 'Outcome']);
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

/** Whether two task titles name the same work: case and spacing aside. */
export const sameWork = (a = '', b = '') => a.toLowerCase().replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/\s+/g, ' ').trim();

/** Fold Task events into the board, newest values winning. Exported for the task CLI. */
export function buildBoard(events = activity(), now = new Date()) {
  const tasks = new Map();
  for (const e of events.filter((x) => x.event === 'Task')) {
    const t = tasks.get(e.id) ?? { id: e.id, status: 'planned', sessions: [], events: 0, started: e.ts, attempt: 1 };
    for (const k of ['title', 'epic', 'workstream', 'phase', 'owner', 'status', 'progress', 'attempt', 'tests', 'blocker', 'next', 'pr', 'branch']) {
      if (e[k] !== undefined) t[k] = e[k];
    }
    // An id started again for different work: sessions on separate branches cannot see each other's ids. A rename is
    // the same work, and so is a title that differs only in case or spacing.
    if (e.title && e.action === 'start') t.starts = [...(t.starts ?? []), e.title];
    else if (e.title && t.starts?.length) t.starts = [...t.starts.slice(0, -1), e.title];
    if (t.starts) t.starts = t.starts.filter((x, i, all) => all.findIndex((y) => sameWork(x, y)) === i);
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

// ------------------------------------------------------------------ routing
// Model routing by process (blueprint ADR-0014). Recorded by Claude Code: the model each helper agent was served and its
// tokens. Declared by the session: its process, task, escalation trigger and review verdicts. The two are kept apart and
// the declared parts are checked against the record wherever a record exists.
const TIER_ORDER = ['low', 'mid', 'high'];
const rankOf = (tier) => { const i = TIER_ORDER.indexOf(tier); return i < 0 ? null : i; };
const whole = (n) => typeof n === 'number' && Number.isInteger(n) && n > 0;
const at = (iso) => new Date(iso).getTime();
const tokenTotal = (t) => (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0);
const bucket = (t = {}) => ({ messages: t.messages ?? 0, input: t.input ?? 0, output: t.output ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite5m: t.cacheWrite5m ?? 0, cacheWrite1h: t.cacheWrite1h ?? 0 });
const sameList = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const startOf = (r) => r.first ?? r.ts;
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7)).padStart(2, '0')}`;
};

/** The model that wrote the most output among the models of a set of tokens: the one that led the work. */
export const leadModel = (models) => Object.entries(models ?? {}).sort((a, b) => b[1].output - a[1].output)[0]?.[0];

/** The latest AgentRun of each helper agent, with the tier of the model Claude Code served (never the one requested). */
export function agentRuns(events, cfg) {
  const latest = new Map();
  for (const e of events.filter((x) => x.event === 'AgentRun')) {
    const key = `${e.session}|${e.agentId}`;
    const had = latest.get(key);
    if (!had || at(e.ts) >= at(had.ts)) latest.set(key, e);
  }
  return [...latest.values()].map((e) => {
    const model = leadModel(e.tokens);
    return {
      session: e.session, agentId: e.agentId, ts: e.ts, agentType: e.agentType ?? null, requested: e.requested ?? null,
      process: e.process ?? null, task: e.task ?? null, trigger: e.trigger ?? null, shadow: e.shadow === true,
      first: e.first ?? null, last: e.last ?? null, tokens: e.tokens ?? {}, model: model ?? null, tier: model ? tierOf(model, cfg.modelTiers) : null,
    };
  });
}

/** The row label for sessions that have no helper-agent record: their totals hold the main session and any helper agents together. */
export const BEFORE_RECORDING = 'not split: main session and unrecorded helper agents together';

/** The helper-agent starts with no AgentRun of their own (by session and agent id); a start with no id never has one. */
export const unrecordedStarts = (subagentStarts, runs) => {
  const have = new Set(runs.map((r) => `${r.session}|${r.agentId}`));
  return subagentStarts.filter((s) => !s.agentId || !have.has(`${s.session}|${s.agentId}`));
};

/** The routing settings from the config, or the first thing wrong with them. Never a default (lesson L-034). */
function routingConfig(cfg) {
  const r = cfg.routing;
  if (!r || typeof r !== 'object') return { error: 'routing is missing from devlog/control-tower.json' };
  if (!r.processes || typeof r.processes !== 'object' || !sameList(Object.keys(r.processes), PROCESSES)) return { error: `routing.processes must hold exactly: ${PROCESSES.join(', ')}` };
  if (!r.triggers || typeof r.triggers !== 'object' || !sameList(Object.keys(r.triggers), TRIGGERS)) return { error: `routing.triggers must hold exactly: ${TRIGGERS.join(', ')}` };
  const tiers = Object.keys(cfg.modelTiers ?? {}).filter((k) => !k.startsWith('_'));
  for (const p of PROCESSES) {
    const c = r.processes[p];
    const f = rankOf(c?.floor); const t = rankOf(c?.ceiling);
    if (!c || f === null || t === null || !tiers.includes(c.floor) || !tiers.includes(c.ceiling) || f > t) return { error: `routing.processes.${p} needs a floor and a ceiling tier from modelTiers, the floor not above the ceiling` };
    if (c.neverLaddered !== undefined && typeof c.neverLaddered !== 'boolean') return { error: `routing.processes.${p}.neverLaddered must be true or false` };
  }
  const a = r.escalationAlert;
  const alertError = a && whole(a.overPercent) && a.overPercent <= 100 && whole(a.items) ? null : 'routing.escalationAlert needs overPercent (1 to 100) and items as whole numbers above zero';
  const s = r.shadowReview;
  const shadowError = s && typeof s.enabled === 'boolean' && whole(s.every) && Array.isArray(s.excludes) && s.excludes.every((x) => PROCESSES.includes(x)) ? null : 'routing.shadowReview needs enabled, every (a whole number above zero) and excludes (process names)';
  return { error: null, processes: r.processes, triggers: r.triggers, alert: alertError ? null : a, alertError, shadow: shadowError ? null : s, shadowError };
}

/**
 * Cost and tokens per process and model, from the helper agents' own records, and the main session as the remainder of
 * the session totals. Money is exact (lesson L-004); a model with no price, or a remainder that comes out negative, is
 * unavailable, never zero or clamped (lesson L-005). Never added to the session's spend: this is a breakdown of it.
 */
export function processCost(runs, sessionRows, cfg, unrecordedSessions = new Set()) {
  const groups = new Map();
  for (const r of runs) {
    const process = r.process ?? 'not recorded';
    for (const [model, raw] of Object.entries(r.tokens ?? {})) {
      const g = groups.get(`${process}|${model}`) ?? { process, model, agents: new Set(), t: bucket(), perAgent: [] };
      groups.set(`${process}|${model}`, g);
      const b = bucket(raw);
      g.agents.add(`${r.session}|${r.agentId}`);
      for (const k of Object.keys(g.t)) g.t[k] += b[k];
      g.perAgent.push(tokenTotal(b));
    }
  }
  const price = (model, t) => priceTokens(model, t, cfg.pricing);
  const order = (p) => (PROCESSES.includes(p) ? PROCESSES.indexOf(p) : p === 'not recorded' ? 100 : 101);
  const rows = [...groups.values()].map((g) => {
    const sorted = [...g.perAgent].sort((a, b) => a - b);
    const cost = price(g.model, g.t);
    return {
      process: g.process, model: g.model, agents: g.agents.size, tokens: tokenTotal(g.t), medianTokens: sorted[Math.floor((sorted.length - 1) / 2)],
      cost: cost === null ? null : money(cost, cfg), costUnits: cost,
    };
  });
  // What each session's total holds beyond its recorded helper agents (their AgentRuns, counted once in their process
  // rows above), per session and model. When every helper agent the session started has a record, that remainder is
  // the main session. When any has none, the remainder holds the main session and those agents together, so it goes
  // to the "not split" rows. A negative remainder makes that model's row unavailable, never clamped to zero.
  const parts = { main: { rest: {}, bad: new Set() }, unsplit: { rest: {}, bad: new Set() } };
  for (const s of sessionRows) {
    const into = parts[unrecordedSessions.has(s.id) ? 'unsplit' : 'main'];
    const used = {};
    for (const r of runs.filter((x) => x.session === s.id)) for (const [m, raw] of Object.entries(r.tokens ?? {})) { const acc = used[m] ??= bucket(); const b = bucket(raw); for (const k of Object.keys(acc)) acc[k] += b[k]; }
    for (const model of new Set([...Object.keys(s.models), ...Object.keys(used)])) {
      const have = bucket(s.models[model]); const gone = used[model] ?? bucket();
      const rest = into.rest[model] ??= bucket();
      for (const k of Object.keys(rest)) { const d = have[k] - gone[k]; if (d < 0) into.bad.add(model); else rest[k] += d; }
    }
  }
  const remainderRows = (kind, label, extra) => Object.keys(parts[kind].rest).sort().map((model) => {
    if (parts[kind].bad.has(model)) return { process: label, model, agents: null, tokens: null, medianTokens: null, cost: null, costUnits: null, ...extra };
    const cost = price(model, parts[kind].rest[model]);
    return { process: label, model, agents: null, tokens: tokenTotal(parts[kind].rest[model]), medianTokens: null, cost: cost === null ? null : money(cost, cfg), costUnits: cost, ...extra };
  });
  const main = remainderRows('main', 'main session', {});
  const beforeRows = remainderRows('unsplit', BEFORE_RECORDING, { unsplit: true });
  return [...rows.sort((a, b) => order(a.process) - order(b.process) || a.model.localeCompare(b.model)), ...main, ...beforeRows];
}

/**
 * The routing and escalation view, from the helper agents' records and the review verdicts the session declared.
 * Escalation: an item (a board task) that started at its process's floor tier and was later worked on, in the same
 * process, by an agent above the floor, judged by the model Claude Code served. Items that started above or below the
 * floor are counted apart, never as escalations. The amber rule is the owner's, read from the config.
 */
export function routingAudit({ runs, outcomes, toolEvents, subagentStarts, board, cfg, now, isActive = () => false }) {
  const conf = routingConfig(cfg);
  // `since` is for display only: the time of the first AgentRun, which is when a Stop wrote it, not when its agents
  // began. A helper agent is "unrecorded" only when it has no AgentRun of its own, whatever the dates say.
  const since = runs.reduce((m, r) => (m === null || at(r.ts) < at(m) ? r.ts : m), null);
  const unrecorded = unrecordedStarts(subagentStarts, runs);
  const agentsBefore = unrecorded.length;
  // A start with a real id and no record, from the last day, in a session that is no longer active: its Stop never
  // came or never wrote a record, so Claude Code's record of it is missing and nobody was told.
  const dayAgo = at(now) - 864e5;
  const noRecord = unrecorded.filter((s) => s.agentId);
  const noRecordStale = noRecord.filter((s) => at(s.ts) >= dayAgo && !isActive(s.session)).length;
  const head = { since, agentsBefore, error: conf.error };
  if (conf.error) return { ...head, state: 'unavailable', processes: [], triggers: [], log: [], consistency: null, shadow: null, agents: [], unrated: null };

  const boardById = new Map(board.map((t) => [t.id, t]));
  const highRisk = (cfg.highRiskPaths?.patterns ?? []).map((x) => new RegExp(x));
  const tagged = runs.filter((r) => r.process && r.task);
  const primary = tagged.filter((r) => !r.shadow);
  const byStart = (a, b) => at(startOf(a)) - at(startOf(b)) || a.agentId.localeCompare(b.agentId);
  const spanHas = (a, prev, test) => prev && toolEvents.some((e) => e.session === a.session && at(e.ts) >= at(startOf(prev)) && at(e.ts) <= at(startOf(a)) && test(e));
  const failedBefore = (a, processes) => outcomes.some((o) => o.task === a.task && !o.shadowOf && processes.includes(o.process) && o.result === 'failed' && at(o.ts) <= at(startOf(a)));
  // Whether a record supports the trigger the session declared: a tool record of this session (recorded), a verdict the
  // session declared with the task command (declared), or nothing.
  const support = (a, prev) => {
    switch (a.trigger) {
      case 'suite_failed': return spanHas(a, prev, (e) => e.kind === 'test' && e.ok === false && !e.expectRed) ? 'recorded' : 'none';
      case 'deny_path_touched': return spanHas(a, prev, (e) => /^(Edit|Write|NotebookEdit)$/.test(e.tool) && highRisk.some((r) => r.test(e.target ?? ''))) ? 'recorded' : 'none';
      case 'review_failed': return failedBefore(a, ['review', 'security-review']) ? 'declared' : 'none';
      case 'builder_blocked': return failedBefore(a, ['build', 'fix']) ? 'declared' : 'none';
      default: return 'none';
    }
  };

  const climbs = []; const rows = []; const agentLog = [];
  const consistency = { climbsWithoutTrigger: 0, triggersWithoutClimb: 0, unsupported: 0, startedNoRecord: noRecord.length, startedNoRecordStale: noRecordStale, unknownTasks: new Set(), untagged: runs.length - tagged.length, tagged: tagged.length, noMetadata: runs.filter((r) => !r.agentType && !r.requested && !r.process).length };
  for (const p of PROCESSES) {
    const pc = conf.processes[p];
    const floor = rankOf(pc.floor); const ceiling = rankOf(pc.ceiling);
    const laddered = !pc.neverLaddered && floor !== ceiling;
    const mine = primary.filter((r) => r.process === p);
    const outs = outcomes.filter((o) => o.process === p && !o.shadowOf && o.round === 1);
    const firstPass = outs.length ? { n: outs.filter((o) => o.result === 'passed').length, of: outs.length } : null;
    const row = { process: p, label: pc.label ?? p, work: pc.work ?? null, floor: pc.floor, ceiling: pc.ceiling, laddered, firstPass };
    const byTask = new Map();
    for (const r of mine) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
    const items = [...byTask].map(([task, list]) => {
      const agents = list.sort(byStart).map((a, i) => {
        const rank = rankOf(a.tier);
        const reason = rank === null ? null : rank > floor ? (a.trigger ? `escalation:${a.trigger}` : 'undeclared') : rank === floor ? 'floor' : 'below_floor';
        return { ...a, rank, round: i + 1, reason };
      });
      const first = agents[0].rank;
      const above = (a) => a.rank !== null && a.rank > floor;
      // Escalation across stages. A process's first agent for an item is an escalation INTO that process only when
      // something climbed: this agent is above the floor, carries a declared trigger, and the item's previous agent in
      // a laddered process (build, fix, check: not plan or the reviews, which never climb) ran on a lower tier. (The
      // build ran on Sonnet, its review on Opus, and the fix runs on Opus with esc:review_failed: Sonnet to Opus.) It
      // counts as escalated for this process, is logged from that agent, and is not "started above floor". A trigger
      // alone is never a climb, so a self-declared tag cannot raise the rate (lesson L-024): any other first agent above
      // the floor stays a start above the floor, and its trigger, if any, is a trigger with no climb.
      const ladderedProcess = (q) => !conf.processes[q].neverLaddered && rankOf(conf.processes[q].floor) !== rankOf(conf.processes[q].ceiling);
      const priorLaddered = (a) => primary.filter((x) => x.task === task && ladderedProcess(x.process) && byStart(x, a) < 0).sort(byStart).pop() ?? null;
      const entryFrom = laddered && first !== null && first > floor && agents[0].trigger ? priorLaddered(agents[0]) : null;
      const entered = entryFrom !== null && rankOf(entryFrom.tier) !== null && rankOf(entryFrom.tier) < first;
      const started = first === null ? 'unknown' : entered ? 'entered' : first === floor ? 'floor' : first > floor ? 'above' : 'below';
      const t = boardById.get(task);
      if (!t) consistency.unknownTasks.add(task);
      agents.forEach((a, i) => {
        agentLog.push({ agentId: a.agentId, session: a.session, process: p, task, round: a.round, model: a.model, tier: a.tier, reason: a.reason, trigger: a.trigger, first: startOf(a) });
        const prev = i === 0 ? entryFrom : agents[i - 1];
        const climbed = i > 0 && a.rank !== null && prev.rank !== null && a.rank > prev.rank;
        if (climbed || (i === 0 && entered)) {
          const sup = support(a, prev);
          climbs.push({ ts: startOf(a), task, process: p, round: a.round, fromModel: prev?.model ?? null, toModel: a.model, fromTier: prev?.tier ?? null, toTier: a.tier, trigger: a.trigger, support: sup, session: a.session });
          if (!a.trigger) consistency.climbsWithoutTrigger++;
          else if (sup === 'none') consistency.unsupported++;
        } else if (a.trigger) consistency.triggersWithoutClimb++;
      });
      return {
        task, agents, started, unrated: agents.some((a) => a.rank === null), aboveCeiling: agents.some((a) => a.rank !== null && a.rank > ceiling),
        escalated: entered || (started === 'floor' && agents.slice(1).some(above)),
        finished: t?.status === 'done' && t.finished && !Number.isNaN(at(t.finished)) ? t.finished : null,
      };
    });
    const doneItems = items.filter((i) => i.finished && !i.unrated);
    Object.assign(row, mine.length ? {
      recorded: true, agents: mine.length, items: items.length,
      startedAtFloor: items.filter((i) => i.started === 'floor').length, startedAbove: items.filter((i) => i.started === 'above').length,
      startedBelow: items.filter((i) => i.started === 'below').length, enteredByEscalation: items.filter((i) => i.started === 'entered').length, aboveCeiling: items.filter((i) => i.aboveCeiling).length,
      escalatedItems: items.filter((i) => i.escalated).length,
      finishedAtFloor: doneItems.length ? { n: doneItems.filter((i) => i.agents.every((a) => a.rank === floor)).length, of: doneItems.length } : null,
    } : { recorded: false, agents: null, items: null, startedAtFloor: null, startedAbove: null, startedBelow: null, enteredByEscalation: null, aboveCeiling: null, escalatedItems: null, finishedAtFloor: null });
    // Escalation rate over the last N finished items that started at the floor; amber only past the owner's threshold.
    if (!laddered) row.escalation = { state: 'not_laddered', escalated: null, window: null, need: null, overPercent: null };
    else if (conf.alertError) row.escalation = { state: 'unavailable', reason: 'config', error: conf.alertError, escalated: null, window: null, need: null, overPercent: null };
    else if (!mine.length) row.escalation = { state: 'unavailable', reason: 'not_recorded', escalated: null, window: null, need: conf.alert.items, overPercent: conf.alert.overPercent };
    else {
      const { items: need, overPercent } = conf.alert;
      const win = doneItems.filter((i) => i.started === 'floor' || i.started === 'entered').sort((a, b) => at(b.finished) - at(a.finished)).slice(0, need);
      const escalated = win.filter((i) => i.escalated).length;
      // Whole numbers: more than overPercent of the window, so 7 of 20 is amber at 30% and 6 of 20 is not.
      const state = win.length < need ? 'collecting' : escalated * 100 > overPercent * need ? 'amber' : 'green';
      row.escalation = { state, escalated, window: win.length, need, overPercent };
    }
    if (mine.length) {
      const counts = {};
      for (const c of climbs.filter((x) => x.process === p)) { const k = c.trigger ?? 'not declared'; counts[k] = (counts[k] ?? 0) + 1; }
      row.topTriggers = Object.entries(counts).map(([trigger, n]) => ({ trigger, n })).sort((a, b) => b.n - a.n || a.trigger.localeCompare(b.trigger));
      row.tokensByTier = {};
      for (const r of mine) row.tokensByTier[r.tier ?? 'unknown'] = (row.tokensByTier[r.tier ?? 'unknown'] ?? 0) + Object.values(r.tokens).reduce((n, t) => n + tokenTotal(t), 0);
      // The last 8 ISO weeks, from the week of the earliest recorded agent (earlier weeks are unknown, not empty).
      const atFloor = items.filter((i) => i.started === 'floor' || i.started === 'entered');
      const sinceWeek = isoWeek(new Date(Math.min(...runs.map((r) => at(startOf(r)))))); // the earliest agent, not the first Stop that wrote a record
      row.weeks = [];
      for (let k = 7; k >= 0; k--) {
        const w = isoWeek(new Date(now - k * 7 * 864e5));
        if (w < sinceWeek) continue;
        const inWeek = atFloor.filter((i) => isoWeek(new Date(startOf(i.agents[0]))) === w);
        row.weeks.push({ week: w, items: inWeek.length, escalated: inWeek.filter((i) => i.escalated).length });
      }
    } else Object.assign(row, { topTriggers: null, tokensByTier: null, weeks: null });
    rows.push(row);
  }

  // Shadow review: a cheaper tier's verdict on a review the primary agent also judged.
  const verdictOf = new Map();
  for (const o of outcomes.filter((x) => !x.shadowOf && x.agent).sort((a, b) => at(a.ts) - at(b.ts))) verdictOf.set(o.agent, o.result);
  const shadowVerdict = new Map();
  for (const o of outcomes.filter((x) => x.shadowOf).sort((a, b) => at(a.ts) - at(b.ts))) shadowVerdict.set(o.shadowOf, o.result);
  const pairs = [...shadowVerdict].filter(([id]) => verdictOf.has(id)).map(([id, shadowResult]) => ({ primary: verdictOf.get(id), shadow: shadowResult }));
  const shadowRuns = tagged.filter((r) => r.shadow);
  const eligible = primary.filter((r) => ['review', 'security-review'].includes(r.process) && !(conf.shadow?.excludes ?? []).includes(r.process)).length;
  const shadow = {
    enabled: conf.shadow ? conf.shadow.enabled : null, every: conf.shadow ? conf.shadow.every : null, error: conf.shadowError,
    sample: pairs.length, agree: pairs.filter((x) => x.primary === x.shadow).length,
    misses: pairs.filter((x) => x.primary === 'failed' && x.shadow === 'passed').length,
    falseAlarms: pairs.filter((x) => x.primary === 'passed' && x.shadow === 'failed').length,
    due: conf.shadow ? Math.floor(eligible / conf.shadow.every) : null, done: shadowRuns.length,
    tokens: shadowRuns.reduce((n, r) => n + Object.values(r.tokens).reduce((m, t) => m + tokenTotal(t), 0), 0),
  };

  const state = conf.alertError ? 'unavailable'
    : !tagged.length ? 'off' : rows.some((r) => r.escalation.state === 'amber') ? 'amber' : 'green';
  return {
    ...head, state, processes: rows, triggers: Object.entries(conf.triggers).map(([id, t]) => ({ id, label: t?.label ?? id, when: t?.when ?? null })),
    log: climbs.sort((a, b) => at(b.ts) - at(a.ts)).slice(0, 50),
    consistency: { ...consistency, unknownTasks: consistency.unknownTasks.size },
    shadow, agents: agentLog.sort((a, b) => at(b.first) - at(a.first)).slice(0, 100),
    unrated: tagged.filter((r) => rankOf(r.tier) === null).length,
  };
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
    if (!BY_HAND.has(e.event)) stamp(s, e.ts);
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
    // A start without an id cannot be paired with its stop, so whether it is still running is unknown (lesson L-005).
    if (e.event === 'SubagentStart') s.subagents[e.agentId ?? e.ts] = { type: e.agentType, started: e.ts, active: true, paired: Boolean(e.agentId) };
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
  const decisions = events.filter((e) => e.event === 'Decision').sort((a, b) => b.on.localeCompare(a.on) || b.ts.localeCompare(a.ts));

  // ------------------------------------------------------------ AI economics
  const runs = agentRuns(events, cfg);
  const byModel = {};
  for (const s of sessionRows) {
    for (const [m, t] of Object.entries(s.models)) {
      const acc = byModel[m] ??= { model: m, tier: tierOf(m, cfg.modelTiers), sessions: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, tools: 0, failures: 0, tests: 0, testsFailed: 0 };
      acc.sessions++;
      for (const k of ['messages', 'input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) acc[k] += t[k];
      // Tool calls and test runs belong to the model that led the session (the most output), not to
      // a subagent's model that happened to be used alongside it.
      const lead = leadModel(s.models);
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
  // What the same tokens would have cost on the baseline model (ADR-0013 section 4.4). An estimate by design: it assumes
  // the baseline would use the same tokens, and any model with no price makes it unavailable, never a guess.
  const baseline = cfg.costEstimate?.baselineModel;
  // The same figure for any list of {model, ...tokens}: the sessions' models, and the helper agents' own (ADR-0013 4.4).
  const savingFor = (list) => {
    if (!baseline || !cfg.pricing?.perMTokUSD?.[baseline] || !list.length) return null;
    let all = 0n; let actual = 0n;
    for (const m of list) {
      const b = priceTokens(baseline, m, cfg.pricing); const a = priceTokens(m.model, m, cfg.pricing);
      if (b === null || a === null) return null;
      all += b; actual += a;
    }
    return { baseline, allBaseline: money(all, cfg), actual: money(actual, cfg), saving: money(all - actual, cfg), share: all > 0n ? Number(((all - actual) * 10000n) / all) / 100 : null };
  };
  const routingSaving = savingFor(registry);
  // Helper agents alone, from their own records: the figure ADR-0013 section 4.4 is about. Unavailable when there are none.
  const agentModels = {};
  for (const r of runs) for (const [m, t] of Object.entries(r.tokens)) { const acc = agentModels[m] ??= { model: m, ...bucket() }; for (const k of Object.keys(bucket())) acc[k] += t[k] ?? 0; }
  const agentSaving = savingFor(Object.values(agentModels));
  if (routingSaving && agentSaving) routingSaving.agents = { ...agentSaving, scope: 'helper agents only' }; // absent, not zero, when no helper agent was recorded
  // Which model led each metered session (the most output), against the routing policy.
  const ledBy = {};
  for (const s of sessionRows.filter((x) => x.metered)) {
    const lead = leadModel(s.models);
    if (lead) ledBy[lead] = (ledBy[lead] ?? 0) + 1;
  }
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
    unattributed: money(spend - pricedTotal, cfg), // session cost that no model's priced tokens account for
    routingSaving, ledBy,
    pricing: { source: cfg.pricing?.source ?? null, asOf: cfg.pricing?.asOf ?? null },
    currency: cfg.currency?.myrPerUsd ? { myrPerUsd: cfg.currency.myrPerUsd, asOf: cfg.currency.asOf, source: cfg.currency.source } : null,
  };

  // ------------------------------------------------------- routing and escalation
  const routing = routingAudit({
    runs, outcomes: events.filter((e) => e.event === 'Outcome'), toolEvents: events.filter((e) => e.tool),
    subagentStarts: events.filter((e) => e.event === 'SubagentStart'), board, cfg, now,
    isActive: (id) => sessionRows.find((x) => x.id === id)?.active ?? false,
  });
  const pcRows = processCost(runs, sessionRows, cfg, new Set(unrecordedStarts(events.filter((e) => e.event === 'SubagentStart'), runs).map((x) => x.session)));
  // A process's cost is the sum of its rows: one definition (lesson L-033). Unavailable when any model has no price.
  for (const row of routing.processes) {
    const mine = pcRows.filter((r) => r.process === row.process);
    row.cost = mine.length && mine.every((r) => r.costUnits !== null) ? money(sum(mine.map((r) => r.costUnits)), cfg) : null;
  }
  const processCostRows = pcRows.map(({ costUnits, ...r }) => r);
  // Nothing reads usage or starts items: the bands are proposed, shown as a table with no reading (ADR-0014 section 2).
  const table = throttleTable(cfg.throttle);
  const throttle = { state: 'off', reason: 'No runner: nothing reads usage or starts items', bands: table.bands, error: table.error, thresholds: table.error ? null : { fiveHour: cfg.throttle.fiveHour, weeklyStop: cfg.throttle.weeklyStop, todayLow: cfg.throttle.todayLow } };
  const utilisation = { state: 'off', reason: 'No runner: no run has been started, so there is nothing to measure' };

  // ------------------------------------------------------- the six areas (34)
  const since = (days) => new Date(now - days * 864e5).toISOString();
  const findings = prs.flatMap((p) => p.findings);
  const closedUnmerged = prs.filter((p) => p.state === 'closed' && !p.merged).length;
  const reverts = all.filter((c) => !c.merge && /^Revert\b/.test(c.subject)).length;
  const realCommits = all.filter((c) => !c.merge);
  const commitSessions = new Set(realCommits.map((c) => c.session).filter(Boolean));
  const loggedSessions = new Set(events.map((e) => e.session));
  const activitySince = events.find((e) => !BY_HAND.has(e.event))?.ts ?? null;
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
  // Still shown once done: the record mixes the two pieces of work whatever its status.
  for (const t of board.filter((x) => (x.starts?.length ?? 0) > 1)) attention.push({ level: t.status === 'done' ? 'info' : 'warning', text: `${t.id} was started for ${t.starts.length} different pieces of work (${t.starts.join('; ')}): its record mixes them. Give each its own id.` });
  for (const t of board.filter((x) => (x.attempt ?? 1) > (cfg.stopLoss?.maxTaskAttempts ?? 99) && x.status !== 'done')) attention.push({ level: 'warning', text: `${t.id} is on attempt ${t.attempt}.` });
  for (const l of lessons.filter((x) => x.times >= 2)) attention.push({ level: 'warning', text: `${l.id} has happened ${l.times} times: ${l.title}.` });
  if (behind > 0) attention.push({ level: 'warning', text: `This branch is ${behind} commits behind main (lesson L-013).` });
  for (const n of areas.governance.unreviewedMerged) attention.push({ level: 'info', text: `PR #${n} was merged with no independent review recorded.` });
  for (const p of prs.filter((x) => x.state === 'open')) attention.push({ level: 'info', text: `PR #${p.number} is open: ${p.title}.` });
  for (const s of starts.filter((x) => x.behind_main > 0).slice(0, 5)) attention.push({ level: 'info', text: `A session started ${s.behind_main} commits behind main on ${s.ts.slice(0, 10)}.` });
  // Lesson L-020: sessions opened outside the repository (once each), and whether the latest cloud
  // session start found the fallback hook that logs them in place.
  const outside = new Map();
  for (const s of starts.filter((x) => x.via === 'fallback')) if (!outside.has(s.session)) outside.set(s.session, s);
  for (const s of [...outside.values()].slice(0, 5)) attention.push({ level: 'info', text: `Session ${s.session.slice(-8)} was opened outside the repository on ${s.ts.slice(0, 10)}; the fallback hook logged it (lesson L-020).` });
  const checked = starts.find((x) => x.fallback);
  const when = checked ? `(${checked.session.slice(-8)}, ${checked.ts.slice(0, 10)})` : '';
  if (checked?.fallback === 'missing') attention.push({ level: 'warning', text: `The latest cloud session ${when} found the fallback hook missing, so a session opened outside the repository would not be logged. Add \`node /home/user/voicelab2/scripts/install-devlog-fallback.mjs || true\` to the cloud environment's setup script (lesson L-020).` });
  if (checked?.fallback === 'unreadable') attention.push({ level: 'warning', text: `The latest cloud session ${when} could not read the user settings file, so the fallback hook could not be checked (lesson L-020).` });
  if (checked?.fallback === 'outdated') attention.push({ level: 'info', text: `The latest cloud session ${when} found the installed fallback hook differs from its branch's. It still logs, and is refreshed when the environment's setup script next runs (lesson L-020).` });
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
  // Routing: the owner's threshold decides amber; the owner decides any change of floor (ADR-0014).
  if (routing.state === 'unavailable') attention.push({ level: 'warning', text: `The routing view is unavailable: ${routing.error ?? 'the escalation threshold in devlog/control-tower.json is not usable'}.` });
  for (const r of routing.processes) {
    if (r.escalation.state === 'amber') attention.push({ level: 'warning', text: `${r.label}: ${r.escalation.escalated} of the last ${r.escalation.need} items that started at or escalated from the floor climbed above it, over ${r.escalation.overPercent}%: the floor may be too low; routing changes only on your decision.` });
    if (r.aboveCeiling > 0) attention.push({ level: 'warning', text: `${r.aboveCeiling} ${r.label.toLowerCase()} item(s) ran an agent above the process's ceiling tier: a breach of the routing policy, for you to look at.` });
    if (r.startedAbove > 0) attention.push({ level: 'info', text: `${r.startedAbove} ${r.label.toLowerCase()} item(s) started above their floor tier; they are counted apart, not as escalations.` });
  }
  const dayAgo = new Date(now - 864e5);
  const noMeta = runs.filter((r) => !r.agentType && !r.requested && !r.process && new Date(r.ts) >= dayAgo).length;
  if (routing.consistency?.startedNoRecordStale > 0) attention.push({ level: 'warning', text: `${routing.consistency.startedNoRecordStale} helper agent(s) started in the last day have no Claude Code record, and their session is no longer active: their model and tokens are unknown (lesson L-020).` });
  if (noMeta >= 3) attention.push({ level: 'warning', text: `${noMeta} helper agents in the last day have no Claude Code metadata, so their process and requested model are unknown (lesson L-020).` });
  if (economics.unpriced.length) attention.push({ level: 'warning', text: `No price configured for ${economics.unpriced.join(', ')}; its cost is not counted.` });
  for (const a of alerts.filter((x) => x.kind === 'waste' && x.ts >= since(2))) attention.push({ level: 'info', text: `Wasted effort in ${a.session.slice(-8)}: ${a.rule} (${a.key}).` });

  // ------------------------------------------------------------------ health
  const integrity = activityIntegrity(root, cfg.integrity?.acceptedChanges ?? {}, decisions);
  const secrets = secretHits(root);
  const lastTest = [...events].reverse().find((e) => e.kind === 'test' && !e.expectRed);
  const testFresh = lastTest && now - new Date(lastTest.ts) <= 24 * 36e5; // an old run says nothing about today's code (lesson L-011)
  // A helper agent is stalled only while its session is still active; one whose session went quiet (a restart, a killed
  // session) never logged its end, so whether it still runs is unknown, not a failure (lessons L-005, L-021).
  const long = (a) => a.paired && a.active && a.started && now - new Date(a.started) > 6 * 36e5;
  const stalled = sessionRows.filter((s) => s.active).flatMap((s) => s.subagents.filter(long));
  const unpaired = sessionRows.reduce((n, s) => n + s.subagents.filter((a) => !a.paired || (long(a) && !s.active)).length, 0);
  const recentStop = alerts.filter((a) => a.kind === 'stop-loss' && a.ts >= since(1));
  const guardsTotal = lessons.reduce((n, l) => n + l.guards.length, 0);
  const guardsBroken = lessons.reduce((n, l) => n + l.guards.filter((g) => !g.ok).length, 0);
  const checks = [
    { name: 'Lesson guards', state: guardsBroken ? 'red' : 'green', detail: guardsBroken ? `${guardsBroken} of ${guardsTotal} guards are missing` : `${guardsTotal} of ${guardsTotal} guards in place` },
    { name: 'Activity log integrity', state: integrity.state, detail: integrity.state === 'unavailable' ? (integrity.unknown?.length ? `${integrity.unknown.length} committed file(s) whose first commit cannot be found (a shallow clone?)` : 'Git history could not be read') : integrity.state === 'red' ? `${integrity.changed.length} changed and ${integrity.deleted.length} deleted after being committed, not accepted` : `${integrity.checked} files as committed${integrity.accepted.length ? `, ${integrity.accepted.length} earlier change(s) accepted by the owner` : ''}${integrity.pending ? `, ${integrity.pending} not committed yet` : ''}` },
    { name: 'Secret scan', state: secrets === null ? 'unavailable' : secrets.length ? 'red' : 'green', detail: secrets === null ? 'Files could not be listed' : secrets.length ? `${secrets.length} file(s) hold a real provider's key format` : "No file holds a real provider's key format (L-015)" },
    { name: 'Tests', state: !testFresh ? 'unavailable' : lastTest.ok ? 'green' : 'amber', detail: !lastTest ? 'No test run recorded' : `Last recorded test run, of any scope, ${lastTest.ok ? 'passed' : 'failed'} at ${lastTest.ts.slice(0, 16).replace('T', ' ')} UTC${testFresh ? '' : ', more than a day ago'}. No CI runs the suite.` },
    { name: 'Stalled agents', state: stalled.length ? 'amber' : 'green', detail: `${stalled.length ? `${stalled.length} helper agent(s) active for more than 6 hours` : 'None active for more than 6 hours'}${unpaired ? `; ${unpaired} older start(s) cannot be judged (no id, or their session went quiet)` : ''}` },
    { name: 'Stop-loss', state: recentStop.length ? 'amber' : 'green', detail: recentStop.length ? `${recentStop.length} in the last 24 hours` : `None in the last 24 hours (${alerts.filter((a) => a.kind === 'stop-loss').length} on record)` },
    { name: 'Logging', state: gaps.length || checked?.fallback === 'missing' ? 'amber' : 'green', detail: [gaps.length ? `${gaps.length} session(s) committed while not logged` : '', checked?.fallback === 'missing' ? 'fallback hook not installed' : ''].filter(Boolean).join('; ') || 'Every committing session was logged' },
    { name: 'Routing', state: routing.state, detail: routing.state === 'off' ? 'No tagged helper agent recorded yet' : routing.state === 'unavailable' ? (routing.error ?? 'The escalation threshold is not usable') : routing.processes.filter((r) => r.recorded).map((r) => `${r.label.toLowerCase()} ${r.escalation.state === 'collecting' ? `collecting ${r.escalation.window} of ${r.escalation.need}` : r.escalation.state === 'not_laddered' ? 'not laddered' : `${r.escalation.state} (${r.escalation.escalated} of ${r.escalation.window})`}`).join('; ') },
    { name: 'Runner heartbeat', state: 'off', detail: 'No runner is built yet' },
    { name: 'Usage windows', state: 'off', detail: 'Not read: no runner yet' },
  ];
  const health = { overall: overallHealth(checks), checks, integrity };

  // ---------------------------------------------------------------- playback
  // Every recorded step in order, compact: what was done and how it ended, never content (lesson L-017).
  const sessionIndex = new Map(sessionRows.map((s, i) => [s.id, i]));
  const sid = (id) => sessionIndex.get(id) ?? -1;
  const step = (e) => {
    switch (e.event) {
      case 'SessionStart': return { k: 'start', d: `Session started${e.branch ? ` on ${e.branch}` : ''}${e.via === 'fallback' ? ' (outside the repository)' : ''}` };
      case 'SessionEnd': return { k: 'end', d: 'Session ended' };
      case 'UserPromptSubmit': return { k: 'prompt', d: 'Message received' };
      case 'PostToolUse': case 'PostToolUseFailure': return { k: e.kind && e.kind !== 'other' ? e.kind : 'tool', d: `${e.tool}${e.target ? ` ${e.target}` : ''}`, ok: e.ok, f: e.failure };
      case 'SubagentStart': return { k: 'agent', d: `Helper agent started${e.agentType ? `: ${e.agentType}` : ''}` };
      case 'SubagentStop': return { k: 'agent', d: 'Helper agent finished' };
      case 'Task': return { k: 'task', d: `${e.id} ${e.action}${e.status ? `, ${e.status.replace('_', ' ')}` : ''}${e.progress !== undefined ? `, ${e.progress}%` : ''}${e.title ? `: ${e.title}` : e.next ? `: next ${e.next}` : ''}`, t: e.id };
      case 'Incident': return { k: 'incident', d: `${e.id} (${e.severity}): ${e.title ?? ''}${e.lesson ? ` [${e.lesson}]` : ''}`, t: e.task };
      case 'Decision': return { k: 'decision', d: `${e.id}: ${e.title}`, t: e.task };
      case 'Alert': return { k: 'alert', d: `${e.kind === 'stop-loss' ? 'Stop-loss' : 'Wasted effort'}: ${e.rule}` };
      case 'Usage': return e.costUSD ? { k: 'usage', d: `Cost checkpoint $${e.costUSD}` } : null;
      default: return null;
    }
  };
  const timeline = [
    ...events.map((e) => { const x = step(e); return x ? { ts: e.ts, s: sid(e.session), ...x } : null; }).filter(Boolean),
    ...realCommits.map((c) => ({ ts: c.date, s: c.session ? sid(c.session) : -1, k: 'commit', d: `Commit ${c.sha}: ${c.subject}` })),
    // A merge time that does not parse is left out, never a reason for the whole report to fail (lesson L-006).
    ...prs.filter((p) => p.merged && !Number.isNaN(new Date(p.merged).getTime())).map((p) => ({ ts: new Date(p.merged).toISOString(), s: -1, k: 'merge', d: `PR #${p.number} merged: ${p.title}` })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

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
    attention, areas, economics, board, incidents, decisions, branches, alerts: alerts.slice(0, 50), registry: registry.map(({ costUnits, ...r }) => r),
    routing, processCost: processCostRows, throttle, utilisation,
    health, plan: planProgress(), timeline, timelineSessions: sessionRows.map((s) => ({ id: s.id, url: s.url, first: s.first, last: s.last })),
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
