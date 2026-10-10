#!/usr/bin/env node
// Dev Control Tower report: gathers how Voice Lab is being built (commits, sessions, PRs and
// their review findings, lessons and their guards, failed tool calls) and renders the dashboard.
//
//   node scripts/devlog-report.mjs [--prs prs.json] [--html out.html] [--json out.json]
//
// prs.json is a list of pull requests as GitHub returns them (number, title, state, html_url,
// created_at, merged_at, body). Review findings are read from the "Independent review" table in
// each body. Without --prs the report still covers everything that lives in the repository.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const git = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; } };
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
    return { sha, date, subject, session, merge: (parents ?? '').trim().includes(' '), pr: pr ? Number(pr[1] ?? pr[2]) : null };
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
function activity() {
  const seen = new Set();
  return [path.join(root, 'devlog', 'activity'), path.join(root, 'devlog', '.spool')].flatMap((dir) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        let e; try { e = JSON.parse(l); } catch { return []; }
        const key = [e.ts, e.session, e.event, e.tool, e.target].join('|');
        if (seen.has(key)) return [];
        seen.add(key);
        return [e];
      })) : []);
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

function build() {
  const all = commits();
  const lessons = parseLessons(readFileSync(path.join(root, 'devlog', 'lessons.md'), 'utf8'));
  const events = activity();
  const prsFile = arg('--prs');
  const prs = (prsFile ? JSON.parse(readFileSync(prsFile, 'utf8')) : []).map((p) => {
    const findings = p.findings ?? reviewFindings(p.body);
    return {
      number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'merged' : p.state,
      created: p.created_at, merged: p.merged_at ?? null, findings,
      lessons: lessons.filter((l) => l.prs.includes(p.number)).map((l) => l.id),
    };
  }).sort((a, b) => a.number - b.number);

  const sessions = new Map();
  const touch = (id) => {
    if (!sessions.has(id)) sessions.set(id, { id, url: sessionUrl(id), first: null, last: null, commits: 0, prompts: 0, tools: 0, failures: 0, files: new Set() });
    return sessions.get(id);
  };
  const stamp = (s, t) => { if (!s.first || t < s.first) s.first = t; if (!s.last || t > s.last) s.last = t; };
  for (const c of all) if (c.session && !c.merge) { const s = touch(c.session); s.commits++; stamp(s, c.date); }
  for (const e of events) {
    const s = touch(e.session);
    stamp(s, e.ts);
    if (e.event === 'UserPromptSubmit') s.prompts++;
    if (e.tool) { s.tools++; if (!e.ok) s.failures++; if (/^(Edit|Write|NotebookEdit)$/.test(e.tool) && e.target) s.files.add(e.target); }
  }

  const failures = events.filter((e) => e.event === 'PostToolUseFailure').sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 50);
  const starts = events.filter((e) => e.event === 'SessionStart').sort((a, b) => b.ts.localeCompare(a.ts));
  const behind = Number(git('rev-list', '--count', 'HEAD..origin/main').trim() || 0);

  const attention = [];
  for (const l of lessons) for (const g of l.guards) if (!g.ok) attention.push({ level: 'critical', text: `${l.id} lost its guard: "${g.text}" is no longer in ${g.file}.` });
  for (const l of lessons.filter((x) => x.times >= 2)) attention.push({ level: 'warning', text: `${l.id} has happened ${l.times} times: ${l.title}.` });
  if (behind > 0) attention.push({ level: 'warning', text: `This branch is ${behind} commits behind main (lesson L-013).` });
  for (const p of prs.filter((x) => x.state === 'open')) attention.push({ level: 'info', text: `PR #${p.number} is open: ${p.title}.` });
  for (const s of starts.filter((x) => x.behind_main > 0).slice(0, 5)) attention.push({ level: 'info', text: `A session started ${s.behind_main} commits behind main on ${s.ts.slice(0, 10)}.` });

  const findings = prs.flatMap((p) => p.findings);
  return {
    generatedAt: new Date().toISOString(),
    repo: 'skchiew-bot/voicelab2',
    head: git('rev-parse', '--short', 'HEAD').trim(),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD').trim(),
    totals: {
      commits: all.filter((c) => !c.merge).length,
      prsMerged: prs.filter((p) => p.state === 'merged').length,
      findings: findings.length,
      findingsFixed: findings.filter((f) => f.fixed).length,
      highFindings: findings.filter((f) => /^high/i.test(f.severity)).length,
      lessons: lessons.length,
      guards: lessons.reduce((n, l) => n + l.guards.length, 0),
      guardsOk: lessons.reduce((n, l) => n + l.guards.filter((g) => g.ok).length, 0),
      repeats: lessons.filter((l) => l.times >= 2).length,
      sessions: sessions.size,
      toolCalls: events.filter((e) => e.tool).length,
      failures: events.filter((e) => e.event === 'PostToolUseFailure').length,
    },
    attention,
    prs,
    lessons,
    sessions: [...sessions.values()].map((s) => ({ ...s, files: s.files.size })).sort((a, b) => (b.last ?? '').localeCompare(a.last ?? '')),
    commits: all.filter((c) => !c.merge).slice(0, 60),
    failures,
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
  const json = JSON.stringify(report, null, 2);
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
