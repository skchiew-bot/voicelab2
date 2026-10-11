import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';

// Drives the dev Control Tower page in a real browser, from a fixed hand-written report.
// Skipped where no Chromium is available (set CHROMIUM_PATH to point at one), like tests/admin-ui.test.ts.
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const run = existsSync(CHROMIUM);
const root = path.resolve(__dirname, '..');
const UNREC = 'Unavailable (not recorded)';

let browser: Browser; let dir: string; let fixedPage: string;

const money = (usd: string) => ({ usd });
const proc = (process: string, label: string, floor: string, ceiling: string, laddered: boolean, extra: Record<string, unknown> = {}) => ({
  process, label, work: label, floor, ceiling, laddered, firstPass: null, recorded: false,
  escalation: laddered ? { state: 'unavailable', reason: 'not_recorded', escalated: null, window: null, need: 20, overPercent: 30 } : { state: 'not_laddered', escalated: null, window: null, need: null, overPercent: null },
  cost: null, agents: null, items: null, startedAtFloor: null, startedAbove: null, startedBelow: null, enteredByEscalation: null, aboveCeiling: null, escalatedItems: null,
  finishedAtFloor: null, topTriggers: null, tokensByTier: null, weeks: null, ...extra,
});

/** A small fixed report with every key the page reads. Times are fixed text, never the clock (L-037). */
function fixedReport() {
  const checks = [{ name: 'Routing', state: 'amber', detail: 'build amber (7 of 20)' }, { name: 'Tests', state: 'green', detail: 'Passing' }];
  return {
    generatedAt: '2026-10-11T12:00:00.000Z', branch: 'claude/phase-CT-dev-tower-v2', head: 'abc1234', repo: 'skchiew-bot/voicelab2',
    totals: { prsMerged: 1, findingsFixed: 1, findings: 1, highFindings: 0, lessons: 1, guards: 1, guardsOk: 1, repeats: 0, sessions: 1, toolCalls: 1, failures: 0, incidents: 0, openTasks: 0 },
    attention: [], plan: [], timeline: [], timelineSessions: [], prs: [], decisions: [], alerts: [], commits: [], failures: [], budgets: {},
    board: [], incidents: [], sessions: [], lessons: [{ id: 'L-001', title: 'A lesson', times: 1, rule: 'A rule', seen: 'Seen once', guards: [{ file: 'a', text: 'b', ok: true }] }],
    registry: [{ model: 'claude-sonnet-5-5', tier: 'mid', sessions: 1, output: 10, cacheRead: 0, cost: money('1.00'), costPerSession: money('1.00'), toolFailureRate: 0, testPassRate: 100 }],
    areas: {
      agents: [], workload: { openPrs: 0 },
      governance: { approvals: 1, unreviewedMerged: [], auditCompleteness: 100, policyViolations: 0 },
      quality: { testPassRate: 100, testRuns: 1, findingsPerPr: 1, repeatedLessons: 0 },
    },
    economics: {
      spend: money('1.00'), perDoneTask: null, cacheSaved: money('0'), cacheReadShare: 0, meteredSessions: 1, unattributed: money('0'),
      pricing: { source: 'test', asOf: '2026-10-11' }, stopLossAlerts: 0, wasteAlerts: 0, ledBy: { 'claude-sonnet-5-5': 1 },
      routingSaving: { baseline: 'claude-opus-5-5', allBaseline: money('2.00'), actual: money('1.00'), saving: money('1.00'), share: 50, agents: { baseline: 'claude-opus-5-5', allBaseline: money('0.50'), actual: money('0.25'), saving: money('0.25'), share: 50, scope: 'helper agents only' } },
    },
    health: { overall: 'amber', checks, integrity: { state: 'green', checked: 0, pending: 0, changed: [], deleted: [], accepted: [] } },
    branches: { branches: [], error: null, defaultBranch: 'main', forksCount: 0, fetchedAt: null },
    routing: {
      since: '2026-10-09T08:00:00.000Z', agentsBefore: 51, error: null, state: 'amber', triggers: [], unrated: 0,
      agents: Array.from({ length: 25 }, (_, i) => ({ agentId: `a${i}`, session: 's1', process: 'build', task: `P3-${i}`, round: 1, model: 'claude-sonnet-5-5', tier: 'mid', reason: i === 0 ? 'escalation:suite_failed' : i === 1 ? 'undeclared' : i === 2 ? 'below_floor' : 'floor', trigger: null, first: `2026-10-10T${String(i % 24).padStart(2, '0')}:00:00.000Z` })),
      processes: [
        proc('plan', 'Plan', 'high', 'high', false),
        proc('build', 'Build', 'mid', 'high', true, { recorded: true, items: 25, agents: 30, startedAtFloor: 20, startedAbove: 2, startedBelow: 1, enteredByEscalation: 1, aboveCeiling: 2, escalatedItems: 7, firstPass: { n: 8, of: 10 }, cost: money('0.50'), weeks: [{ week: '2026-W41', items: 4, escalated: 1 }, { week: '2026-W42', items: 6, escalated: 2 }], escalation: { state: 'amber', escalated: 7, window: 20, need: 20, overPercent: 30 }, finishedAtFloor: { n: 13, of: 20 }, topTriggers: [{ trigger: 'suite_failed', n: 4 }], tokensByTier: { high: 100, mid: 900, low: 0, other: 0, unknown: 0 } }),
        // Recorded, but nothing has finished yet: "None finished yet", not the words for not recorded.
        proc('fix', 'Fix', 'mid', 'high', true, { recorded: true, items: 1, agents: 1, finishedAtFloor: null, topTriggers: [], tokensByTier: { high: 0, mid: 10, low: 0, other: 0, unknown: 0 }, escalation: { state: 'collecting', escalated: 0, window: 0, need: 20, overPercent: 30 } }),
        // Nothing recorded yet: every figure null, which the page must not turn into 0.
        proc('check', 'Check', 'low', 'mid', true),
      ],
      log: [{ ts: '2026-10-10T09:30:00.000Z', task: 'P3-B', process: 'build', round: 2, fromModel: 'claude-sonnet-5-5', toModel: 'claude-opus-5-5', fromTier: 'mid', toTier: 'high', trigger: 'suite_failed', support: 'recorded', session: 's1' },
        { ts: '2026-10-10T10:30:00.000Z', task: 'P3-C', process: 'build', round: 2, fromModel: 'claude-sonnet-5-5', toModel: 'claude-opus-5-5', fromTier: 'mid', toTier: 'high', trigger: null, support: 'none', session: 's1' }],
      consistency: { climbsWithoutTrigger: 1, triggersWithoutClimb: 0, unsupported: 0, startedNoRecord: 3, startedNoRecordStale: 1, unknownTasks: 0, untagged: 2, tagged: 25, noMetadata: 0 },
      shadow: { enabled: false, every: 5, error: null, sample: 0, agree: 0, misses: 0, falseAlarms: 0, due: 0, done: 0, tokens: 0 },
    },
    processCost: [
      { process: 'build', model: 'claude-sonnet-5-5', agents: 3, tokens: 1000, medianTokens: 300, cost: money('0.50') },
      { process: 'check', model: 'claude-haiku-5-5', agents: null, tokens: null, medianTokens: null, cost: null },
      { process: 'main session', model: 'claude-opus-5-5', agents: null, tokens: 5000, medianTokens: null, cost: money('2.00') },
      { process: 'main session', model: 'claude-haiku-5-5', agents: null, tokens: null, medianTokens: null, cost: null },
      { process: 'sessions before recording: main session and helper agents together', model: 'claude-opus-5-5', agents: null, tokens: 7000, medianTokens: null, cost: money('3.00') },
    ],
    throttle: {
      state: 'off', reason: 'No runner: nothing reads usage or starts items', error: null, thresholds: null,
      bands: [{ band: 'Full', when: 'Every condition for accelerating is met' }, { band: 'Normal', when: 'Otherwise' }, { band: 'Low', when: '5-hour window 70% to 84%' }, { band: 'Crawl', when: '5-hour window 85% to 94%' }, { band: 'Stopped', when: '5-hour window 95% or more' }],
    },
    utilisation: { state: 'off', reason: 'No runner: no run has been started, so there is nothing to measure' },
  };
}

async function buildPage(report: unknown, name: string): Promise<string> {
  const { renderHtml } = (await import(path.join(root, 'scripts', 'devlog-report.mjs'))) as { renderHtml: (t: string, r: unknown) => string };
  const file = path.join(dir, name);
  writeFileSync(file, renderHtml(readFileSync(path.join(root, 'devlog', 'dashboard.html'), 'utf8'), report));
  return file;
}

async function open(file: string, width = 1280, hash = ''): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`file://${file}${hash}`);
  return { page, errors };
}

beforeAll(async () => {
  if (!run) return;
  dir = mkdtempSync(path.join(tmpdir(), 'devlog-dashboard-'));
  fixedPage = await buildPage(fixedReport(), 'fixed.html');
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
}, 60_000);
afterAll(async () => { await browser?.close(); });

describe.skipIf(!run)('dev Control Tower page', () => {
  it('shows a process no helper agent has recorded as unavailable (not recorded), never as 0', async () => {
    const { page, errors } = await open(fixedPage, 1280, '#cost');
    const row = page.locator('#proc-cost tbody tr', { hasText: 'check' });
    expect(await row.locator('td').allTextContents()).toEqual(['check', 'haiku-5-5', UNREC, UNREC, UNREC, UNREC]);
    // The main session's remainder keeps its tokens; its absent agent figures are unavailable, not 0.
    expect(await page.locator('#proc-cost tbody tr', { hasText: /^main sessionopus/ }).locator('td').allTextContents()).toEqual(['main session', 'opus-5-5', 'Not applicable', '5,000', 'Not applicable', '$2.00']);
    // A main session whose remainder came out negative is unavailable (its tokens), though it has no agents to count.
    expect(await page.locator('#proc-cost tbody tr', { hasText: /^main sessionhaiku/ }).locator('td').allTextContents()).toEqual(['main session', 'haiku-5-5', 'Not applicable', UNREC, 'Not applicable', UNREC]);
    expect(await page.locator('#proc-cost tbody tr', { hasText: 'sessions before recording' }).locator('td').allTextContents()).toEqual(['sessions before recording: main session and helper agents together', 'opus-5-5', 'Not applicable', '7,000', 'Not applicable', '$3.00']);
    expect(await page.locator('#pc-note').textContent()).toBe(`Helper-agent records begin 2026-10-09; 51 helper agents have no record of their own (model and tokens unavailable, not recorded). These rows are priced from the transcripts, so they can differ from Spend, which uses Claude Code's own checkpoints.`);
    // On the routing view, a process with nothing recorded shows the same words in its items and finished-at-floor cells.
    await page.goto(`file://${fixedPage}#routing`);
    const check = await page.locator('#ladder tbody tr', { hasText: 'Check' }).locator('td').allTextContents();
    expect(check.slice(3, 5)).toEqual([UNREC, UNREC]);
    // Recorded but nothing finished: its own words, not the words for not recorded.
    expect((await page.locator('#ladder tbody tr', { hasText: 'Fix' }).locator('td').allTextContents()).slice(3, 5)).toEqual(['1', 'None finished yet']);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('labels every declared figure as declared by the session, apart from what Claude Code recorded', async () => {
    const { page, errors } = await open(fixedPage, 1280, '#routing');
    expect(await page.locator('#rt-legend').textContent()).toBe('Recorded by Claude Code: model, tokens, times, test runs. Declared by the session: process, task, trigger, review verdict, for you to confirm.');
    const heads = (sel: string) => page.locator(`${sel} thead th`).allTextContents();
    expect(await heads('#ladder')).toEqual(['Process', 'Floor', 'Ceiling', 'ItemsDeclared', 'Finished at floorDeclared', 'Escalation from floorDeclared', 'Top triggersDeclared', 'Tokens by tier']);
    expect(await heads('#esc-log')).toEqual(['When', 'TaskDeclared', 'ProcessDeclared', 'Round', 'From', 'To', 'TriggerDeclared', 'Support']);
    // The columns Claude Code recorded carry no such tag.
    expect(await page.locator('#ladder thead th', { hasText: 'Tokens by tier' }).locator('.tag').count()).toBe(0);
    expect(await page.locator('#esc-log thead th', { hasText: 'From' }).locator('.tag').count()).toBe(0);
    // Escalation states are an icon plus a word; support is one of the three words.
    expect(await page.locator('#ladder tbody tr', { hasText: 'Build' }).locator('.pill').textContent()).toBe('Amber');
    expect(await page.locator('#ladder tbody tr', { hasText: 'Plan' }).locator('.pill').textContent()).toBe('Not laddered');
    expect(await page.locator('#ladder tbody tr', { hasText: 'Check' }).locator('.pill').textContent()).toBe('Unavailable');
    expect(await page.locator('#ladder .pill svg').count()).toBe(4);
    expect(await page.locator('#esc-log tbody tr .pill').allTextContents()).toEqual(['Recorded', 'No record']);
    expect(await page.locator('#esc-log tbody tr').nth(1).locator('td').nth(6).textContent()).toBe('Not declared');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows the routing notes and the recent helper agents with why each ran on its tier', async () => {
    const { page, errors } = await open(fixedPage, 1280, '#routing');
    expect(await page.locator('#rt-notes thead th').allTextContents()).toEqual(['Process', 'Above ceiling', 'Below floor', 'Started above floor', 'Entered by escalation', 'First-pass reviewDeclared', 'Cost', 'Weekly escalations (of items from the floor)']);
    expect(await page.locator('#rt-notes tbody tr', { hasText: 'Build' }).locator('td').allTextContents()).toEqual(['Build', '2', '1', '2', '1', '8 of 10', '$0.50', '2026-W41: 1 of 4; 2026-W42: 2 of 6']);
    // A process with nothing recorded has no counts: the words, never 0.
    expect((await page.locator('#rt-notes tbody tr', { hasText: 'Check' }).locator('td').allTextContents()).slice(1, 6)).toEqual([UNREC, UNREC, UNREC, UNREC, UNREC]);
    // The last 20 of the 25 agents, newest first, each with its reason.
    const rows = await page.locator('#rt-agents tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual(['2026-10-10 00:00 UTC', 'build', 'P3-0', '1', 'sonnet-5-5 (mid)', 'Escalation: suite failed']);
    expect(rows[1]?.[5]).toBe('Above the floor, no trigger declared');
    expect(rows[2]?.[5]).toBe('Below the floor');
    expect(rows[3]?.[5]).toBe('At the floor');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows the counts that need no tag even while no agent is tagged, and a dash only for those that do', async () => {
    const off = fixedReport();
    off.routing.state = 'off';
    off.routing.consistency = { climbsWithoutTrigger: 0, triggersWithoutClimb: 0, unsupported: 0, startedNoRecord: 3, startedNoRecordStale: 0, unknownTasks: 0, untagged: 4, tagged: 0, noMetadata: 2 };
    const file = await buildPage(off, 'off.html');
    const { page, errors } = await open(file, 1280, '#routing');
    const lines = Object.fromEntries((await page.locator('#consistency .check').allTextContents()).map((t) => [t.replace(/[\d—]+$/, ''), t.match(/[\d—]+$/)?.[0]]));
    expect(lines).toEqual({
      'Agents tagged': '—', 'Agents without a tag': '4', 'Climbs with no trigger declared': '—', 'Triggers declared with no climb': '—', 'Triggers the record does not support': '—',
      'Tags naming a task not on the board': '—', 'Agents with no Claude Code metadata': '2', 'Started with no Claude Code record': '3',
    });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('writes the ladder\'s headers in one font, and the words in a number column in the normal font on one line at 375 pixels', async () => {
    const { page, errors } = await open(fixedPage, 375, '#routing');
    const fonts = await page.locator('#ladder thead th').evaluateAll((ths) => ths.map((t) => getComputedStyle(t).fontFamily));
    expect(new Set(fonts).size).toBe(1);
    const words = page.locator('#ladder td.num .na').first();
    expect(await words.textContent()).toBe(UNREC);
    expect(await words.evaluate((e) => getComputedStyle(e).fontFamily)).toContain('Source Sans');
    expect(await words.evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(24); // one line
    const num = page.locator('#ladder td.num:not(:has(.na))').first();
    expect(await num.evaluate((e) => getComputedStyle(e).fontFamily)).toContain('IBM Plex Mono');
    await page.goto(`file://${fixedPage}#cost`);
    const cost = page.locator('#proc-cost td.num .na').first();
    expect(await cost.evaluate((e) => getComputedStyle(e).fontFamily)).toContain('Source Sans');
    expect(await cost.evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(24);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows throttle bands and utilisation as not in use, with no reading', async () => {
    const { page, errors } = await open(fixedPage, 1280, '#runner');
    const view = page.locator('#v-runner');
    expect(await view.locator('.pill', { hasText: 'Not in use' }).count()).toBe(2);
    expect(await view.locator('h2', { hasText: 'Throttle bands (proposed)' }).count()).toBe(1);
    expect(await page.locator('#bands tbody tr').allTextContents()).toEqual(['FullEvery condition for accelerating is met', 'NormalOtherwise', 'Low5-hour window 70% to 84%', 'Crawl5-hour window 85% to 94%', 'Stopped5-hour window 95% or more']);
    expect(await page.locator('#bands thead th').allTextContents()).toEqual(['Band', 'When']);
    expect(await view.textContent()).toContain('No runner reads usage; interactive sessions are not bound.');
    expect(await page.locator('#ut-reason').textContent()).toBe('No runner: no run has been started, so there is nothing to measure');
    // No band is marked as the current one, and nothing says one is.
    expect(await view.locator('[aria-current]').count()).toBe(0);
    expect(await view.textContent()).not.toMatch(/current/i);
    expect(await view.textContent()).toContain('ADR-0014 proposes slowing down in bands, Full, Normal, Low, Crawl and Stopped, instead of stopping');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('fits a phone: nothing on the routing view is wider than 375 pixels', async () => {
    const { page, errors } = await open(fixedPage, 375, '#routing');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Every table sits inside a .tbox, which scrolls on its own, and no box is wider than the screen.
    const tables = await page.locator('#v-routing table').evaluateAll((ts) => ts.map((t) => !!t.closest('.tbox')));
    expect(tables.length).toBe(4); // the ladder, the routing notes, the escalation log and the recent helper agents
    expect(tables.every(Boolean)).toBe(true);
    const widest = await page.locator('#v-routing .tbox, #v-routing .card, #v-routing section').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
    expect(widest).toBeLessThanOrEqual(375);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('loads with no script error on the real report', async () => {
    const out = path.join(dir, 'real.html');
    execFileSync('node', ['scripts/devlog-report.mjs', '--prs', 'devlog/prs.json', '--html', out], { cwd: root, stdio: 'pipe', timeout: 120_000 });
    const { page, errors } = await open(out);
    const views = await page.locator('#nav a').evaluateAll((as) => as.map((a) => (a as HTMLElement).dataset.view));
    expect(views).toEqual(['overview', 'playback', 'board', 'cost', 'routing', 'quality', 'governance', 'runner']);
    for (const v of views) {
      await page.locator(`#nav a[data-view="${v}"]`).click();
      await expect(page.locator(`#v-${v}`)).toBeVisible();
      expect((await page.locator(`#v-${v}`).innerText()).trim().length).toBeGreaterThan(40);
    }
    expect(await page.locator('#checks').textContent()).toContain('Routing');
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
});
