import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
// Playwright's expect gives the web-first locator assertions (auto-waiting); it also does plain values.
import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';

// Drives the real admin UI in a real browser against a throwaway database.
// Skipped where no Chromium is available (set CHROMIUM_PATH to point at one).
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const run = existsSync(CHROMIUM);

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let browser: Browser; let base: string;

beforeAll(async () => {
  if (!run) return;
  // The API serves admin/dist only if it exists when the app is built.
  execSync('npm run -s build:admin', { stdio: 'pipe' });
  const { setupDb } = await import('./helpers.js');
  env = await setupDb();
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.app.server.address() as { port: number }).port}/admin/`;
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await env?.teardown();
});

// Match on the label text only (not the help text underneath it), anchored at the start.
const field = (scope: Page | Locator, label: string) => {
  const page = 'goto' in scope ? scope : scope.page(); // `has` is matched relative to each label, so build it from the page
  return scope.locator('label.field')
    .filter({ has: page.locator('span.label').filter({ hasText: new RegExp(`^${label}`) }) })
    .locator('input, select, textarea').first();
};

const goProviders = (page: Page) => page.getByRole('link', { name: 'Providers', exact: true }).click();

async function signIn(page: Page, token: string) {
  await page.goto(base);
  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

describe.skipIf(!run)('admin UI', () => {
  it('opens on the Control Tower: what needs attention, honest project progress, and the live panels', async () => {
    const page = await browser.newPage();
    await signIn(page, env.staffToken);
    await expect(page.getByRole('heading', { name: 'Control Tower', level: 1 })).toBeVisible();

    // A fresh installation: the two gaps every one has, each a link to where it is fixed.
    const attention = page.getByLabel('Needs attention');
    await expect(attention.getByRole('link', { name: /No MYR exchange rate/ })).toBeVisible();
    await expect(attention).toContainText('no client rate card');
    await attention.getByRole('link', { name: /No MYR exchange rate/ }).click();
    await expect(page.getByRole('heading', { name: 'Rates', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Control Tower', exact: true }).click();

    // Progress: counts come from the data, and nothing is called done that is not.
    const progress = page.getByLabel('Project progress');
    await expect(progress).toContainText('0 of 9 done');
    await expect(progress).toContainText('Nothing has yet been proven against the real Twilio');
    const p0 = page.getByLabel('Phase 0');
    await expect(p0).toContainText('In progress');
    await expect(p0).toContainText('3 of 3 exit criteria met');
    const p1 = page.getByLabel('Phase 1');
    await expect(p1).toContainText('1 of 3 exit criteria met, 1 partly');
    await p1.getByText('Details').click();
    await expect(p1.getByText('Inbound and outbound test calls work on both Twilio and Telnyx.')).toBeVisible();
    await expect(p1).toContainText('tested against fakes, not the real provider');
    await expect(p1).toContainText('Still open');
    await expect(page.getByLabel('Phase 7')).toContainText('In progress');
    await expect(page.getByLabel('Control Tower', { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel('Applies to every phase')).toContainText('configured model tier');
    await progress.getByText('10 open decisions').click();
    await expect(progress.getByText('Hosting region')).toBeVisible();

    // Live panels, empty on a fresh installation, and plain about what they cannot show yet.
    await expect(page.getByLabel('Live calls')).toContainText('No calls in progress');
    await expect(page.getByLabel('Provider health')).toContainText('No providers yet');
    await expect(page.getByLabel('Funding')).toContainText('No funding recorded yet');
    await expect(page.getByLabel('Cost and margin')).toContainText('Last 24 hours');
    await page.close();
  }, 60_000);

  it('updates as the platform is set up, and the alerts link to the fix', async () => {
    const st = env.staffToken;
    const prov = (await env.call(st, 'POST', '/internal/providers', {
      adapterKey: 'telnyx', name: 'tx tower', params: { apiKey: 'k', webhookUrl: 'https://x.example/h' },
    })).json().id;
    const page = await browser.newPage();
    await signIn(page, st);
    const attention = page.getByLabel('Needs attention');
    const link = attention.getByRole('link', { name: /tx tower: no webhook signing public key/ });
    await expect(link).toBeVisible();
    await expect(page.getByLabel('Provider health').getByRole('row', { name: /tx tower/ })).toContainText('none'); // no rates yet
    await link.click();
    await expect(page.getByRole('heading', { name: 'tx tower' })).toBeVisible();
    expect(page.url()).toContain(prov);
    await page.close();
  });

  it('says so when a refresh fails, instead of showing old numbers as current', async () => {
    const page = await browser.newPage();
    await signIn(page, env.staffToken);
    await expect(page.getByLabel('Needs attention')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.route('**/internal/control-tower', (route) => route.abort());
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByRole('alert')).toContainText('may be out of date');
    await expect(page.getByLabel('Needs attention')).toBeVisible(); // what was shown stays, but is no longer presented as current
    await page.unroute('**/internal/control-tower');
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.close();
  });

  it('says when it is showing only the newest of many live calls', async () => {
    const st = env.staffToken;
    const t = (await env.call(st, 'POST', '/internal/tenants', { name: 'Busy Co' })).json().id;
    const prov = (await env.call(st, 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw busy', params: { accountSid: 'ACb', authToken: 'x', twimlAppVoiceUrl: 'https://x.example/v' } })).json().id;
    const { randomUUID } = await import('node:crypto');
    for (let i = 0; i < 25; i++) {
      await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status) VALUES ($1,$2,$3,'inbound','in_progress')`, [randomUUID(), t, prov]);
    }
    const page = await browser.newPage();
    await signIn(page, st);
    await expect(page.getByLabel('Live calls')).toContainText('Showing the newest 20 of 25 calls in progress');
    await env.pool.query(`DELETE FROM calls WHERE tenant_id = $1`, [t]);
    await page.close();
  });

  it('rejects a bad token and a client token', async () => {
    const page = await browser.newPage();
    await signIn(page, 'not-a-token');
    await expect(page.getByRole('alert')).toContainText('Invalid token');

    const t = (await env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'UI Reject Co' })).json();
    const u = (await env.call(env.staffToken, 'POST', `/internal/tenants/${t.id}/users`, { email: 'c@c.test', role: 'tenant_admin' })).json();
    let dialog = '';
    page.once('dialog', (d) => { dialog = d.message(); void d.dismiss(); });
    await page.getByLabel('API token').fill(u.token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => dialog).toContain('Daythree staff');
    await expect(page.getByRole('heading', { name: 'Control Tower', level: 1 })).toHaveCount(0);
    await page.close();
  });

  it('lets an operator add a provider, set rates and funding, and manage a client, all from forms', async () => {
    const page = await browser.newPage();
    await signIn(page, env.staffToken);

    // Providers: the form is built from the adapter declaration.
    await goProviders(page);
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
    await page.getByLabel('Provider type').selectOption('twilio');
    await expect(page.locator('label.field', { hasText: 'Auth Token' })).toBeVisible();

    // A mistake comes back as a readable message, not a crash.
    const form = page.getByRole('form', { name: 'Add provider' });
    await field(form, 'Name').fill('twilio ui');
    await field(form, 'Account SID').fill('AC123');
    await field(form, 'TwiML App Voice URL').fill('https://example.com/voice');
    await form.getByRole('button', { name: 'Add provider' }).click();
    await expect(page.getByRole('alert')).toContainText('Auth Token');

    // Fixed and saved; lands on the provider page.
    await field(form, 'Auth Token').fill('ui-secret-token');
    await form.getByRole('button', { name: 'Add provider' }).click();
    await expect(page.getByRole('heading', { name: 'twilio ui' })).toBeVisible();
    await expect(page.getByText('credentials stored (encrypted)')).toBeVisible();
    await expect(page.getByText('Credentials checked', { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain('ui-secret-token');

    // Credentials can be re-checked on demand, and a rejection is shown plainly.
    await page.getByRole('button', { name: 'Check credentials now' }).click();
    await expect(page.getByRole('status')).toContainText('accepted by the provider');
    env.provider.state.respond = () => new Response('{}', { status: 401 });
    await page.getByRole('button', { name: 'Check credentials now' }).click();
    await expect(page.getByRole('alert')).toContainText('rejected these credentials');
    env.provider.state.respond = () => new Response(JSON.stringify({ status: 'active' }), { status: 200 });

    // Capabilities are editable.
    await page.getByLabel('stt support').selectOption('composable');
    await expect(page.getByLabel('stt support')).toHaveValue('composable');
    await page.reload();
    await expect(page.getByLabel('stt support')).toHaveValue('composable');

    // Charging: a rate, then a rate change as a new version.
    const addVersion = async (from: string, rate: string) => {
      const f = page.getByRole('form', { name: 'Add charging version' });
      await field(f, 'Effective from').fill(from);
      await field(f, 'Rate').fill(rate);
      await f.getByRole('button', { name: 'Save new version' }).click();
    };
    await addVersion('2026-01-01T00:00', '0.0140');
    await expect(page.getByRole('heading', { name: /Version 1/ })).toContainText('Unconfirmed');
    await addVersion('2026-07-01T00:00', '0.0120');
    await expect(page.getByRole('heading', { name: /Version 2/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Version 1/ })).toBeVisible();
    await expect(page.getByText('0.014 USD')).toBeVisible();
    await expect(page.getByText('0.012 USD')).toBeVisible();

    const v1 = page.locator('.version', { has: page.getByRole('heading', { name: /Version 1/ }) });
    await field(v1, 'Mark as checked').fill('https://www.twilio.com/en-us/voice/pricing');
    await v1.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: /Version 1/ })).toContainText('Confirmed');

    // Funding ledger.
    const funding = page.getByRole('form', { name: 'Add funding entry' });
    await field(funding, 'Amount').fill('500');
    await funding.getByRole('button', { name: 'Record' }).click();
    await expect(page.locator('section', { hasText: 'Funding' }).getByText('500')).toBeVisible();

    // The list shows the provider.
    await page.getByRole('link', { name: '← All providers' }).click();
    await expect(page.getByRole('link', { name: 'twilio ui' })).toBeVisible();

    // Clients: add, grant credits, create a project and a user whose token is shown once.
    await page.getByRole('link', { name: 'Clients' }).click();
    await field(page.getByRole('form', { name: 'Add client' }), 'New client').fill('Acme Collections');
    await page.getByRole('button', { name: 'Add client' }).click();
    await expect(page.getByRole('heading', { name: 'Acme Collections' })).toBeVisible();
    await field(page.getByRole('form', { name: 'Credits for Acme Collections' }), 'Credits').fill('1000');
    await page.getByRole('form', { name: 'Credits for Acme Collections' }).getByRole('button', { name: 'Record' }).click();
    await expect(page.getByText('1,000')).toBeVisible();
    await field(page.getByRole('form', { name: 'Add project to Acme Collections' }), 'New project').fill('Collections MY');
    await page.getByRole('form', { name: 'Add project to Acme Collections' }).getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('Collections MY')).toBeVisible();
    const userForm = page.getByRole('form', { name: 'Add user to Acme Collections' });
    await field(userForm, 'Email').fill('ops@acme.test');
    await userForm.getByRole('button', { name: 'Create user' }).click();
    const issued = await page.getByRole('status').locator('code').innerText();
    expect(issued.length).toBeGreaterThan(20);

    // The token it issued works for that client and only sees that client's credits.
    const mine = await env.call(issued, 'GET', '/client/credits');
    expect(mine.json().balance).toBe('1000.0000');

    // Signing out returns to the login screen and drops access.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.close();
  }, 60_000);

  it('shows a provider outage clearly and lets the operator save without checking', async () => {
    const page = await browser.newPage();
    await signIn(page, env.staffToken);
    await goProviders(page);
    env.provider.state.respond = () => { throw new Error('getaddrinfo ENOTFOUND api.telnyx.com'); };
    await page.getByLabel('Provider type').selectOption('telnyx');
    const form = page.getByRole('form', { name: 'Add provider' });
    await field(form, 'Name').fill('telnyx offline');
    await field(form, 'API key').fill('KEY-OFFLINE');
    await field(form, 'Webhook URL').fill('https://example.com/hook');
    await form.getByRole('button', { name: 'Add provider' }).click();
    await expect(page.getByRole('alert')).toContainText('Could not reach Telnyx');

    await form.getByLabel('Save without checking').check();
    await form.getByRole('button', { name: 'Add provider' }).click();
    await expect(page.getByRole('heading', { name: 'telnyx offline' })).toBeVisible();
    await expect(page.getByText('Credentials not checked')).toBeVisible();

    env.provider.state.respond = () => new Response(JSON.stringify({ data: { balance: '9.99', currency: 'USD' } }), { status: 200 });
    await page.getByRole('button', { name: 'Check credentials now' }).click();
    await expect(page.getByRole('status')).toContainText('balance: 9.99 USD');
    await expect(page.getByText('Credentials checked', { exact: true })).toBeVisible();
    await page.close();
  });

  it('manages rates, numbers and do-not-call lists from forms, and says plainly what is missing', async () => {
    const st = env.staffToken;
    const t = (await env.call(st, 'POST', '/internal/tenants', { name: 'Screens Co' })).json().id;
    const prov = (await env.call(st, 'POST', '/internal/providers', {
      adapterKey: 'twilio', name: 'tw screens', params: { accountSid: 'AC7', authToken: 'tok', twimlAppVoiceUrl: 'https://x.example/v' },
    })).json().id;
    const page = await browser.newPage();
    await signIn(page, st);

    // Rates: warns until MYR and a rate card exist, then the warnings go away.
    await page.getByRole('link', { name: 'Rates' }).click();
    await expect(page.getByText('No MYR rate yet')).toBeVisible();
    await expect(page.getByText('No rate card yet')).toBeVisible();
    const fx = page.getByRole('form', { name: 'Add FX rate' });
    await field(fx, 'Per 1 USD').fill('4.5');
    await field(fx, 'Effective from').fill('2026-01-01T00:00');
    await fx.getByRole('button', { name: 'Add rate' }).click();
    await expect(page.getByText('No MYR rate yet')).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'MYR' })).toBeVisible();
    const card = page.getByRole('form', { name: 'Add rate card' });
    await field(card, 'Inbound credits').fill('1');
    await field(card, 'Outbound credits').fill('2');
    await field(card, 'Value of one credit').fill('0.01');
    await field(card, 'Effective from').fill('2026-01-01T00:00');
    await card.getByRole('button', { name: 'Add rate card' }).click();
    await expect(page.getByText('No rate card yet')).toHaveCount(0);

    // Reference rates on a provider page: saved unconfirmed, with direction-specific lines.
    await page.goto(`${base}#/providers/${prov}`);
    const ref = page.getByRole('form', { name: 'Use reference rates' });
    await expect(ref).toContainText('$0.014 per outbound minute');
    await field(ref, 'Billing increment').fill('60');
    await field(ref, 'Effective from').fill('2026-01-01T00:00');
    await ref.getByRole('button', { name: 'Add reference rates' }).click();
    await expect(page.getByRole('heading', { name: /Version 1/ })).toContainText('Unconfirmed');
    await expect(page.getByRole('cell', { name: 'inbound only' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'outbound only' })).toBeVisible();

    // Numbers.
    await page.getByRole('link', { name: 'Numbers' }).click();
    const num = page.getByRole('form', { name: 'Add number' });
    await num.getByLabel('Provider').selectOption({ label: 'tw screens' });
    await field(num, 'Number').fill('+60312340000');
    await num.getByLabel('Client').selectOption({ label: 'Screens Co' });
    await num.getByRole('button', { name: 'Register number' }).click();
    await expect(page.getByRole('cell', { name: '+60312340000' })).toBeVisible();

    // Do not call: nothing is allowed until a country is declared.
    await page.getByRole('link', { name: 'Do not call' }).click();
    const chk = page.getByRole('form', { name: 'Check number' });
    const runCheck = async (n: string) => {
      await chk.getByLabel('Client').selectOption({ label: 'Screens Co' });
      await field(chk, 'Country').fill('MY');
      await field(chk, 'Number').fill(n);
      await chk.getByRole('button', { name: 'Check' }).click();
    };
    await runCheck('+60187654321');
    await expect(page.getByRole('alert')).toContainText('no do-not-call position has been declared');

    const decl = page.getByRole('form', { name: 'Declare country' });
    await field(decl, 'Country').fill('MY');
    await field(decl, 'Source or note').fill('Registry file Oct 2026');
    await decl.getByRole('button', { name: 'Declare' }).click();
    await expect(page.getByRole('cell', { name: 'Registry in force' })).toBeVisible();

    const load = page.getByRole('form', { name: 'Load numbers' });
    await field(load, 'Country').fill('MY');
    await load.getByLabel('Numbers').fill('+60187654321\nnot a number');
    await load.getByRole('button', { name: 'Load numbers' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Added 1' })).toContainText('not valid 1');

    await runCheck('+60 18-765 4321');
    await expect(page.getByRole('alert')).toContainText('on the national registry');
    await runCheck('+60111111111');
    await expect(page.getByRole('status').filter({ hasText: 'Allowed' })).toBeVisible();
    expect(await page.content()).not.toContain('87654321'); // the registry numbers are never shown back
    await page.close();
  }, 60_000);

  it('shows calls with their costs, and lets an operator reconcile one or re-price a failed one', async () => {
    const st = env.staffToken;
    const t = (await env.call(st, 'POST', '/internal/tenants', { name: 'Calls Co' })).json().id;
    const pj = (await env.call(st, 'POST', `/internal/tenants/${t}/projects`, { name: 'Autumn push' })).json().id;
    const prov = (await env.call(st, 'POST', '/internal/providers', {
      adapterKey: 'twilio', name: 'tw calls', params: { accountSid: 'AC8', authToken: 'tok', twimlAppVoiceUrl: 'https://x.example/v' },
    })).json().id;
    await env.call(st, 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2025-01-01T00:00:00Z' }).catch(() => undefined);
    const mk = async (sid: string, status: string, priced: boolean) => {
      const id = (await import('node:crypto')).randomUUID();
      await env.pool.query(
        `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, started_at, answered_at, ended_at, duration_seconds, end_reason, cost_status)
         VALUES ($1,$2,$3,$4,$5,'outbound',$6,'MY', now() - interval '3 hours', now() - interval '3 hours', now() - interval '2 hours', 61, 'completed', 'pending')`,
        [id, t, pj, prov, sid, status]);
      if (priced) {
        await env.call(st, 'POST', `/internal/calls/${id}/cost`, { tenantId: t, projectId: pj, direction: 'outbound', occurredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), usage: [{ providerId: prov, usage: { seconds: 61 } }] });
        await env.pool.query(`UPDATE calls SET cost_status = 'recorded' WHERE id = $1`, [id]);
      } else {
        await env.pool.query(`UPDATE calls SET cost_status = 'failed', cost_error = 'no charging version' WHERE id = $1`, [id]);
      }
      return id;
    };
    // The provider needs rates for the priced call.
    await env.call(st, 'POST', `/internal/providers/${prov}/charging`, {
      effectiveFrom: '2025-06-01T00:00:00Z', billingIncrementSeconds: 60,
      components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.0140', currency: 'USD' }],
    });
    const good = await mk('CA_ui_good', 'completed', true);
    await mk('CA_ui_failed', 'completed', false);

    const page = await browser.newPage();
    await signIn(page, st);
    await page.getByRole('link', { name: 'Calls', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Autumn push' })).toBeVisible();
    await expect(page.getByText('Could not price')).toBeVisible();

    // A call that was priced but not yet checked against the provider.
    const row = page.locator('tr', { has: page.getByText('Estimated') }).first();
    await row.getByRole('button', { name: 'Details' }).click();
    const detail = page.getByLabel('Call detail');
    await expect(detail).toContainText('0.028 USD'); // 61s billed as 2 minutes at 0.014
    await expect(detail.getByText('telephony_leg')).toBeVisible();

    env.provider.state.respond = () => new Response(JSON.stringify({ duration: '61', price: '-0.0500', price_unit: 'USD' }), { status: 200 });
    await detail.getByRole('button', { name: /Check against the provider/ }).click();
    await expect(detail.getByRole('status')).toContainText('variance');
    await expect(detail.getByText('Differs from provider').first()).toBeVisible();

    // The operator enters the provider's corrected figures by hand.
    const manual = detail.getByRole('form', { name: "Enter the provider's figures" });
    await field(manual, "Provider's cost").fill('0.028');
    await manual.getByRole('button', { name: 'Compare my figures' }).click();
    await expect(detail.getByRole('status')).toContainText('matched');
    await expect(detail.getByText('Reconciled', { exact: true }).first()).toBeVisible();
    expect((await env.call(st, 'GET', `/internal/calls/${good}`)).json().cost_status).toBe('reconciled');

    // A call that could not be priced offers a re-price, which works once the cause is fixed.
    await page.getByRole('row', { name: /Could not price/ }).getByRole('button', { name: 'Details' }).click();
    const failed = page.getByLabel('Call detail');
    await expect(failed.getByRole('alert')).toContainText('could not be priced');
    await failed.getByRole('button', { name: 'Re-price' }).click();
    await expect(page.getByText('Could not price')).toHaveCount(0);
    await page.close();
  }, 60_000);

  it('fits a phone screen on every page, with no sideways scrolling of the page', async () => {
    const provider = (await env.pool.query('SELECT id FROM providers ORDER BY created_at LIMIT 1')).rows[0].id;
    const tenant = (await env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'Phone Width Co' })).json().id;
    const workflow = (await env.call(env.staffToken, 'POST', `/internal/tenants/${tenant}/workflows`, {
      name: 'phone_width', definition: { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'Hello', transitions: [{ to: 'b' }] }, b: { type: 'end', outcome: 'x' } } } })).json().workflow.id;
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await signIn(page, env.staffToken);
    await expect(page.getByRole('heading', { name: 'Control Tower', level: 1 })).toBeVisible();
    for (const route of ['tower', 'providers', `providers/${provider}`, 'tenants', 'rates', 'numbers', 'compliance', 'calls', 'workflows', `workflows/${workflow}`, 'recordings', 'outbound', 'resilience', 'tickets', 'qa', 'changes', 'learning', 'cases', 'appointments', 'knowledge', 'change-log']) {
      await page.goto(`${base}#/${route}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `#/${route} is ${width}px wide on a 390px screen`).toBeLessThanOrEqual(390);
    }
    await page.close();
  }, 60_000);

  it('creates the debt-collection template for a client from a form', async () => {
    const t = (await env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'UI Template Co' })).json().id;
    const page = await browser.newPage();
    await signIn(page, env.staffToken);
    await page.getByRole('link', { name: 'Workflows', exact: true }).click();
    const form = page.getByRole('form', { name: 'Start from a template' });
    await field(form, 'Client').selectOption({ label: 'UI Template Co' });
    await field(form, 'Template').selectOption({ label: 'Debt collection (Malaysia)' });
    await expect(form).toContainText('Bahasa Malaysia');
    await expect(form).toContainText('Creates: collections, verify_identity, partial_payment, human_transfer');
    await form.getByRole('button', { name: 'Create from template' }).click();
    await expect(form.getByRole('status')).toContainText('Created collections, verify_identity, partial_payment, human_transfer');
    for (const name of ['collections', 'verify_identity', 'partial_payment', 'human_transfer']) {
      await expect(page.getByRole('row', { name: new RegExp(`^${name} UI Template Co 1\\.0`) })).toBeVisible();
    }
    void t;
    await page.close();
  });

  it('takes a workflow through editing, the publishing gates, a rollback and a test call, all from the console', async () => {
    const st = env.staffToken;
    const tenant = (await env.call(st, 'POST', '/internal/tenants', { name: 'UI Flow Co' })).json().id;
    const def = (wording: string) => ({
      start: 'ask', nodes: {
        ask: { type: 'speak', speech: 'fixed', text: wording, listen: { captureAs: 'who' }, transitions: [{ to: 'meet' }] },
        meet: { type: 'speak', speech: 'hybrid', text: 'Nice to meet you, {{who}}.', transitions: [{ to: 'end' }] },
        end: { type: 'end', outcome: 'met' },
      },
    });
    const wfId = (await env.call(st, 'POST', `/internal/tenants/${tenant}/workflows`, { name: 'greeter', definition: def('What is your name?') })).json().workflow.id;

    const page = await browser.newPage();
    await signIn(page, st);
    await page.goto(`${base}#/workflows/${wfId}`);
    await expect(page.getByRole('heading', { name: 'greeter', level: 1 })).toBeVisible();
    const versions = page.getByLabel('Versions');
    await expect(versions.getByRole('row', { name: /^1\.0 initial ready/ })).toBeVisible();
    await expect(page.getByLabel('Outline')).toContainText('“What is your name?”');

    // the gates, in order: production is refused before staging; then staging works
    await versions.getByRole('button', { name: 'Put 1.0 in production' }).click();
    await expect(versions.getByRole('alert')).toContainText('not live in staging');
    await versions.getByRole('button', { name: 'Put 1.0 in staging' }).click();
    await expect(versions.getByRole('status')).toContainText('Version 1.0 is now live in staging');
    await versions.getByRole('button', { name: 'Put 1.0 in production' }).click();
    await expect(versions.getByRole('alert')).toContainText('no clean simulation');

    // a simulation: a failing script first, then a passing one
    const sim = page.getByLabel('Simulation');
    const runSim = async (scenarios: unknown) => { await field(sim, 'Scenarios').fill(JSON.stringify(scenarios)); await sim.getByRole('button', { name: 'Run simulation' }).click(); };
    await runSim([{ name: 'wrong hope', variables: {}, replies: ['Wei'], expect: { outcome: 'refused' } }]);
    await expect(sim.getByRole('alert')).toContainText('0 of 1 passed');
    await expect(sim).toContainText('Expected the outcome "refused" but got "met"');
    await runSim([{ name: 'meets', variables: {}, replies: ['Wei'], expect: { outcome: 'met', says: ['Nice to meet you, Wei'] } }]);
    await expect(sim.getByRole('status')).toContainText('1 of 1 passed. This version can now go to production');
    await versions.getByRole('button', { name: 'Put 1.0 in production' }).click();
    await expect(versions.getByRole('status')).toContainText('live in production');

    // a wording change is a minor version, and goes live the same way
    const edit = page.locator('section[aria-label="Edit"]');
    await field(edit, 'Definition').fill(JSON.stringify(def('Hello! What should I call you?'), null, 2));
    await edit.getByRole('button', { name: 'Save as a new version' }).click();
    await expect(edit.getByRole('status').filter({ hasText: 'Saved as version' })).toContainText('Saved as version 1.1 (minor change)');
    await versions.getByRole('button', { name: 'Put 1.1 in staging' }).click();
    await runSim([{ name: 'meets', variables: {}, replies: ['Wei'], expect: { outcome: 'met' } }]);
    await expect(sim.getByRole('status')).toContainText('1 of 1 passed');
    await versions.getByRole('button', { name: 'Put 1.1 in production' }).click();
    await expect(versions.getByRole('status')).toContainText('Version 1.1 is now live in production');

    // and can be rolled back
    await versions.getByRole('button', { name: 'Roll production back to 1.0' }).click();
    await expect(versions.getByRole('status')).toContainText('Production is back on version 1.0');
    await expect(page.getByText('Live in production: 1.0')).toBeVisible();

    // a dangling path is caught when checking, can be saved as work in progress, and cannot be published
    const broken = def('What is your name?'); (broken.nodes.ask.transitions as { to: string }[])[0]!.to = 'nowhere';
    await field(edit, 'Definition').fill(JSON.stringify(broken, null, 2));
    await edit.getByRole('button', { name: 'Check for problems' }).click();
    await expect(edit.getByRole('alert')).toContainText('3 problems to fix before this can be published');
    await expect(edit.getByRole('alert')).toContainText('"nowhere", which does not exist');
    await expect(edit.getByRole('alert')).toContainText('Nothing leads to "meet"'); // cutting the path also strands what came after it
    await edit.getByRole('button', { name: 'Save as a new version' }).click();
    await expect(edit.getByRole('status').filter({ hasText: 'Saved as version' })).toContainText('cannot be published yet');
    await expect(versions.getByRole('row', { name: /^2\.0 major 3 problems/ })).toBeVisible();
    await versions.getByRole('button', { name: 'Put 2.0 in staging' }).click();
    await expect(versions.getByRole('alert')).toContainText('cannot be published');
    await expect(versions.getByRole('alert')).toContainText('"nowhere", which does not exist');
    await expect(page.getByText('Live in staging: 1.1')).toBeVisible(); // unchanged

    // invalid JSON is said plainly
    await field(edit, 'Definition').fill('{ not json');
    await edit.getByRole('button', { name: 'Save as a new version' }).click();
    await expect(edit.getByRole('alert')).toContainText('not valid JSON');

    // a test call against what is live in staging
    const call = page.getByLabel('Test call');
    await call.getByRole('button', { name: 'Start the call' }).click();
    await expect(call.getByLabel('Transcript')).toContainText('Hello! What should I call you?');
    await field(call.getByRole('form', { name: 'Reply' }), 'What the caller says').fill('Aisha');
    await call.getByRole('button', { name: 'Send' }).click();
    await expect(call.getByLabel('Transcript')).toContainText('Nice to meet you, Aisha.');
    await expect(call.getByLabel('Transcript')).toContainText('The call ended: met');
    await page.close();
  }, 90_000);

  it('records fixed words, shows what is still worth recording, and reads outbound results', async () => {
    const st = env.staffToken;
    const tenant = (await env.call(st, 'POST', '/internal/tenants', { name: 'Stitch UI Co' })).json().id;
    const wf = (await env.call(st, 'POST', `/internal/tenants/${tenant}/workflows`, { name: 'stitch_ui', definition: {
      start: 'a', variables: ['name'], nodes: { a: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, welcome.', transitions: [{ to: 'z' }] }, z: { type: 'end', outcome: 'ok' } } } })).json().workflow.id;
    const page = await browser.newPage();
    await signIn(page, st);

    // what is still worth recording
    await page.goto(`${base}#/workflows/${wf}`);
    const stitching = page.getByLabel('Stitching');
    await expect(stitching).toContainText('0 recorded, 2 still to record');
    await expect(stitching.getByRole('row', { name: /^, welcome\. en a$/ })).toBeVisible();

    // record it from a file
    await page.goto(`${base}#/recordings`);
    await field(page, 'Client').selectOption({ label: 'Stitch UI Co' });
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64, 1)]);
    await field(page, 'Words spoken').fill(', welcome.');
    await page.getByLabel(/^Audio file/).setInputFiles({ name: 'welcome.wav', mimeType: 'audio/wav', buffer: wav });
    await field(page, 'Length \\(seconds\\)').fill('1.8');
    await page.getByRole('button', { name: 'Save recording' }).click();
    await expect(page.getByRole('row', { name: /^, welcome\. en 1 1\.8 s/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

    // a file that is not audio is refused with a plain message
    await field(page, 'Words spoken').fill('Not audio');
    await page.getByLabel(/^Audio file/).setInputFiles({ name: 'x.wav', mimeType: 'audio/wav', buffer: Buffer.from('#!/bin/sh') });
    await field(page, 'Length \\(seconds\\)').fill('1');
    await page.getByRole('button', { name: 'Save recording' }).click();
    await expect(page.getByRole('alert')).toContainText('does not look like audio/wav');

    await page.goto(`${base}#/workflows/${wf}`);
    await expect(page.getByLabel('Stitching')).toContainText('1 recorded, 1 still to record');

    // outbound results, with nothing dialled yet
    await page.goto(`${base}#/outbound`);
    await field(page, 'Client').selectOption({ label: 'Stitch UI Co' });
    await expect(page.getByLabel('Rates')).toContainText('no attempts yet');
    await expect(page.getByLabel('Best times to call back')).toContainText('No callback times captured');
    await page.close();
  }, 60_000);

  it('shows which providers have failed over and why, funding levels, and saves alert levels and failover rules', async () => {
    const st = env.staffToken;
    const pid = (await env.call(st, 'POST', '/internal/providers', { adapterKey: 'elevenlabs', name: 'ui-voice', params: { apiKey: 'k' } })).json().id;
    for (let i = 0; i < 3; i++) expect((await env.call(st, 'POST', `/internal/providers/${pid}/samples`, { kind: 'error' })).statusCode).toBe(201);
    expect((await env.call(st, 'POST', `/internal/providers/${pid}/funding`, { kind: 'topup', amount: '40', currency: 'USD' })).statusCode).toBe(201);

    const page = await browser.newPage();
    await signIn(page, st);
    await page.goto(`${base}#/resilience`);
    await expect(page.getByRole('heading', { name: 'Resilience', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Provider health').getByRole('row', { name: /^ui-voice Failed over Repeated errors\./ })).toBeVisible();
    await expect(page.getByLabel('Recent failovers')).toContainText('hard errors');
    await expect(page.getByLabel('Funding').getByRole('row', { name: /^ui-voice 40 USD OK not set not set$/ })).toBeVisible();

    const levels = page.getByLabel('Funding alert levels');
    await field(levels, 'Provider').selectOption({ label: 'ui-voice' });
    await field(levels, 'Warn below').fill('50');
    await field(levels, 'Critical below').fill('10');
    await levels.getByRole('button', { name: 'Save levels' }).click();
    await expect(page.getByLabel('Funding').getByRole('row', { name: /^ui-voice 40 USD Running low 50 10$/ })).toBeVisible();

    await field(levels, 'Warn below').fill('50');                           // a critical level above the warning level is refused
    await field(levels, 'Critical below').fill('60');
    await levels.getByRole('button', { name: 'Save levels' }).click();
    await expect(levels.getByRole('alert')).toContainText('critical level must not be above');

    const rules = page.getByLabel('Failover rules');
    await field(rules, 'Errors before failing over').fill('5');
    await rules.getByRole('button', { name: 'Save rules' }).click();
    await expect(field(rules, 'Errors before failing over')).toHaveAttribute('placeholder', '5');
    await page.close();
  }, 60_000);

  it('replays a call, works a ticket, clears a dropped call, scores calls and takes a change through approval, all from the console', async () => {
    const { parseKey } = await import('../src/secrets.js');
    const { loadProvider, processWebhook } = await import('../src/store/calls.js');
    const { dncKeyFrom } = await import('../src/store/dnc.js');
    const { withActor } = await import('../src/db.js');
    const { createUser } = await import('../src/store/tenants.js');
    const { randomUUID } = await import('node:crypto');
    const st = env.staffToken;
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => env.call(st, method, url, body);
    const ok = async <T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> => { const r = await p; if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`); return r; };

    const tenant = (await ok(call('POST', '/internal/tenants', { name: 'Journey UI Co' }))).json().id;
    const OUR = '+60300000777';
    const tx = (await ok(call('POST', '/internal/providers', { adapterKey: 'telnyx', name: 'ui-tx', params: { apiKey: 'K', webhookUrl: 'https://voicelab.test/h', connectionId: 'c', webhookPublicKey: 'AAAA' } }))).json().id;
    await ok(call('POST', '/internal/numbers', { providerId: tx, e164: OUR, tenantId: tenant, country: 'MY' }));
    const flow = { start: 'ask', variables: ['name'], nodes: {
      ask: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } }, transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { to: 'ask' }] },
      thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'paid_promise' } } };
    const failing = { start: 'look', nodes: { look: { type: 'api', integration: 'nothing', path: '/x', transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'ok' } } };
    const mk = async (name: string, def: unknown) => { const c = (await ok(call('POST', `/internal/tenants/${tenant}/workflows`, { name, definition: def }))).json(); await ok(call('POST', `/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' })); return c; };
    const wf = await mk('ui_journey', flow); const bad = await mk('ui_failing', failing);

    const key = parseKey(env.config.VOICELAB_SECRET_KEY);
    const deps = { pool: env.pool, key, dncKey: dncKeyFrom(key), http: env.provider.fetch, baseUrl: 'https://voicelab.test' };
    const provider = await withActor(env.pool, { kind: 'internal' }, (c) => loadProvider(c, tx));
    const ev = (kind: 'initiated' | 'answered' | 'ended', pcid: string, extra: object = {}) => ({ key: randomUUID(), providerCallId: pcid, kind, direction: 'inbound' as const, occurredAt: new Date(), transient: { to: OUR, from: '+60129990000' }, ...extra });
    const live = async (pcid: string, workflowId: string, vars: object) => {
      await processWebhook(deps, provider!, ev('initiated', pcid)); await processWebhook(deps, provider!, ev('answered', pcid));
      const callId = (await env.pool.query('SELECT id FROM calls WHERE provider_call_id = $1', [pcid])).rows[0].id as string;
      const run = (await ok(call('POST', `/internal/workflows/${workflowId}/runs`, { environment: 'staging', kind: 'test', variables: vars, callId }))).json();
      return { callId, runId: run.id as string, pcid };
    };
    const hot = await live('ui1', wf.workflow.id, { name: 'Aisha' });
    await ok(call('POST', `/internal/workflow-runs/${hot.runId}/reply`, { text: 'no, that is bad' }));
    await ok(call('POST', `/internal/workflow-runs/${hot.runId}/reply`, { text: 'I will call my lawyer' }));      // passed to a person
    await processWebhook(deps, provider!, ev('ended', 'ui1', { durationSeconds: 40, endReason: 'completed' }));
    const calm = await live('ui2', wf.workflow.id, { name: 'Ben' });
    await ok(call('POST', `/internal/workflow-runs/${calm.runId}/reply`, { text: 'great thank you but no' }));
    await ok(call('POST', `/internal/workflow-runs/${calm.runId}/reply`, { text: 'yes thanks' }));
    await processWebhook(deps, provider!, ev('ended', 'ui2', { durationSeconds: 30, endReason: 'completed' }));
    const drop = await live('ui3', bad.workflow.id, {});
    await processWebhook(deps, provider!, ev('ended', 'ui3', { durationSeconds: 5, endReason: 'completed' }));

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await signIn(page, st);

    // the Control Tower says a call was dropped, and leads to it
    await expect(page.getByLabel('Needs attention').getByRole('link', { name: /dropped by the system/ })).toBeVisible();
    await page.getByLabel('Needs attention').getByRole('link', { name: /dropped by the system/ }).click();
    await expect(page.getByRole('heading', { name: 'Tickets', level: 1 })).toBeVisible();
    const dropped = page.getByLabel('Dropped calls');
    await expect(dropped).toContainText('The workflow failed');
    await dropped.getByRole('link', { name: 'Replay' }).click();
    await expect(page.getByRole('heading', { name: 'Replay', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Summary')).toContainText('The system dropped this call');
    await page.goBack();
    await dropped.getByRole('button', { name: "I've seen it" }).click();
    await expect(dropped).toContainText('No dropped calls waiting');

    // replay a call that went well: the mood line leads to the transcript and the step
    await page.goto(`${base}#/replay/call/${calm.callId}`);
    await expect(page.getByLabel('Summary')).toContainText('Ended paid_promise');
    await expect(page.getByLabel('Summary')).toContainText('The system ended the call at done, as the workflow intended');
    await expect(page.getByLabel('Summary')).toContainText('Kept to the workflow: 100%');
    const mood = page.getByLabel('Mood over the call');
    await expect(mood.getByRole('button')).toHaveCount(2);
    await mood.getByRole('button', { name: /^Turn 2:/ }).click();
    await expect(page.getByLabel('Mood').getByRole('status')).toContainText('Turn 2');
    await expect(page.getByLabel('Transcript').locator('li[aria-current="true"]')).toContainText('yes thanks');
    const steps = page.getByLabel('Every step');
    await expect(steps.getByRole('row', { name: /heard · ask/ }).first()).toBeVisible();
    await steps.getByRole('row', { name: /Reached the end/ }).waitFor();
    // picking the mood point opened the reasoning of the step it belongs to; another step's can be opened too
    await expect(steps).toContainText('"matchedWords"');
    await steps.getByRole('row', { name: /Went from ask to thanks/ }).getByRole('button', { name: 'Why' }).click();
    await expect(steps).toContainText('transition 1 (condition held)');

    // the escalated call has a ticket, which can be worked
    await page.goto(`${base}#/tickets`);
    await page.getByRole('row', { name: /Escalation/ }).getByRole('button', { name: 'Open' }).click();
    const ticket = page.getByRole('region', { name: 'Ticket', exact: true });
    await expect(ticket).toContainText("The customer's view");
    await expect(ticket).toContainText('I will call my lawyer');
    await expect(ticket).toContainText('Council notes');
    await ticket.getByRole('button', { name: 'Mark in review' }).click();
    await expect(ticket.getByRole('heading', { name: /Escalation/ })).toContainText('In review');
    await field(ticket, 'Add a note').fill('Called the customer back.');
    await ticket.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(ticket).toContainText('note: Called the customer back.');

    // quality: criteria, then a batch
    await page.goto(`${base}#/qa`);
    await field(page, 'Client').selectOption({ label: 'Journey UI Co' });
    await page.getByRole('button', { name: 'Save criteria' }).click();
    await expect(page.getByRole('region', { name: 'Criteria', exact: true })).toContainText('Every workflow · version 1');
    await page.getByRole('button', { name: 'Score finished calls' }).click();
    await expect(page.getByRole('status')).toContainText('No model is set up, so only the rules were applied');
    await expect(page.getByRole('region', { name: 'Recent scores', exact: true }).getByRole('row', { name: /ui_journey/ }).first()).toBeVisible();

    // a change, approved by someone else and put live
    const second = (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email: 'second@daythree.test', role: 'internal_admin' }))).token;
    const v2 = (await ok(call('POST', `/internal/workflows/${wf.workflow.id}/versions`, { definition: { ...flow, nodes: { ...flow.nodes, thanks: { type: 'speak', speech: 'fixed', text: 'Thank you very much, we appreciate it.', transitions: [{ to: 'done' }] } } } }))).json();
    await page.goto(`${base}#/changes`);
    const form = page.getByLabel('Propose a change');
    await field(form, 'Workflow').selectOption({ label: 'ui_journey' });
    await field(form, 'Version').selectOption({ value: v2.id });
    await field(form, 'Why is this wanted').fill('The thank-you felt curt.');
    await field(form, 'Scripted callers').fill(JSON.stringify([{ name: 'pays', variables: { name: 'A' }, replies: ['yes'], expect: { outcome: 'paid_promise' } }]));
    await form.getByRole('button', { name: 'Propose this change' }).click();
    const detail = page.getByRole('region', { name: 'Change', exact: true });
    await expect(detail).toContainText('Waiting for approval');
    await expect(detail.getByRole('list', { name: 'Changes' })).toContainText('thanks: wording: Thank you. → Thank you very much, we appreciate it.');
    await expect(detail).toContainText('Speech spoken live');
    const changeId = (await env.pool.query('SELECT id FROM change_requests ORDER BY created_at DESC LIMIT 1')).rows[0].id as string;
    expect((await env.call(st, 'POST', `/internal/changes/${changeId}/decision`, { decision: 'approved' })).statusCode).toBe(403);   // not by the person who proposed it
    expect((await env.call(second, 'POST', `/internal/changes/${changeId}/decision`, { decision: 'approved', note: 'Fine.' })).statusCode).toBe(200);
    await page.reload();
    await page.getByRole('row', { name: /ui_journey/ }).first().getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('region', { name: 'Change', exact: true })).toContainText('Approved');
    await page.getByRole('region', { name: 'Change', exact: true }).getByRole('button', { name: 'Show the client' }).click();
    await expect(page.getByLabel('Showcase')).toContainText('What we saw in the flow today');
    await expect(page.getByLabel('Showcase')).toContainText('The thank-you felt curt.');
    await page.getByRole('region', { name: 'Change', exact: true }).getByRole('button', { name: 'Put it live' }).click();
    await expect(page.getByRole('region', { name: 'Change', exact: true }).getByRole('heading', { level: 2 }).first()).toContainText('Live');

    // the replay fits a phone
    const phone = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await signIn(phone, st);
    await phone.goto(`${base}#/replay/call/${calm.callId}`);
    await expect(phone.getByRole('heading', { name: 'Replay', level: 1 })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await phone.close();
    void hot; void drop;
    await page.close();
  }, 120_000);

  it('shows what the learning loop is doing, and lets a person approve, turn down and demote scripts', async () => {
    const tenant = (await env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'Loop UI Co' })).json().id as string;
    const mk = async (node: string, script: string, kinds: string[]) => {
      const id = (await env.pool.query(
        `INSERT INTO promotions (tenant_id, workflow, node, language, context_kind, script, slots, support, variants, avg_synth_chars, avg_slot_chars, node_hash, distilled_by)
         VALUES ($1,'ui_flow',$2,'en','start',$3,'{name}',12,2,48,8,'h','rules') RETURNING id`, [tenant, node, script])).rows[0].id as string;
      for (const k of kinds) await env.pool.query(`INSERT INTO promotion_events (promotion_id, kind, reason) VALUES ($1,$2,$3)`, [id, k, `${k} for the test`]);
      return id;
    };
    await mk('wait_node', 'Please hold while I check {{name}}.', ['distilled']);
    await mk('pay_node', 'Hello {{name}}, can you pay this week?', ['distilled', 'approved', 'promoted']);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await signIn(page, env.staffToken);
    await page.goto(`${base}#/learning`);
    await page.getByLabel('Client').selectOption({ label: 'Loop UI Co' });
    await expect(page.getByLabel('Loop status')).toContainText('1 promoted · 1 waiting for review');
    const waiting = page.getByLabel('Script for wait_node');
    await expect(waiting).toContainText('Waiting for review');
    await expect(waiting.getByRole('button', { name: 'Turn down' })).toBeDisabled();           // a refusal needs a reason
    const live = page.getByLabel('Script for pay_node');
    await expect(live).toContainText('Promoted (pre-recorded)');
    await live.getByRole('button', { name: 'History and cost' }).click();
    await expect(live).toContainText('What happened');
    await expect(live).toContainText('approved for the test');
    await page.getByLabel('Note').fill('Callers were upset by the wording.');
    await live.getByRole('button', { name: 'Demote' }).click();
    await expect(live).toContainText('Demoted (live again)');
    await waiting.getByRole('button', { name: 'Turn down' }).click();
    await expect(waiting).toContainText('Turned down');
    await page.close();
  }, 60_000);

  it('opens a case, records a promise, locks a callback and decides on an aged case, from the console', async () => {
    const tenant = (await env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'Cases UI Co' })).json().id as string;
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await signIn(page, env.staffToken);
    await page.goto(`${base}#/cases`);
    await page.getByLabel('Client').selectOption({ label: 'Cases UI Co' });
    const form = page.getByLabel('Open a case');
    await form.getByLabel(/^Case reference/).fill('UI-1');
    await form.getByLabel(/^Phone number/).fill('+60123450999');
    await form.getByLabel(/^Opening balance/).fill('250.50');
    await form.getByRole('button', { name: 'Open case' }).click();
    const list = page.getByLabel('Cases list');
    await expect(list).toContainText('UI-1');
    await expect(list).toContainText('250.5');
    await list.getByRole('button', { name: 'Open' }).click();
    const detail = page.getByRole('region', { name: 'Case', exact: true });
    await expect(detail).toContainText('The balance now is 250.50 MYR.');
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await detail.getByLabel(/^Promise amount/).fill('100');
    await detail.getByLabel(/^Due on/).fill(due);
    await detail.getByRole('button', { name: 'Record promise' }).click();
    await expect(detail).toContainText(`100 MYR by ${due}`);
    await expect(detail).toContainText('promise recorded');
    await detail.getByLabel(/^Promise amount/).fill('50');
    await detail.getByRole('button', { name: 'Record promise' }).click();
    await expect(detail).toContainText('open promise');            // a second promise is refused, and the page says why
    // an aged case waits for a decision
    await env.pool.query(`UPDATE cases SET status = 'decision_required' WHERE case_ref = 'UI-1'`);
    await detail.getByRole('button', { name: 'Hide' }).isVisible().catch(() => undefined);
    await page.reload();
    await page.getByLabel('Client').selectOption({ label: 'Cases UI Co' });
    await page.getByLabel('Cases list').getByRole('button', { name: 'Open' }).click();
    const aged = page.getByRole('region', { name: 'Case', exact: true });
    await expect(aged).toContainText('Needs a decision');
    await expect(aged.getByRole('button', { name: 'Carry on' })).toBeDisabled();      // a reason is needed
    await aged.getByLabel(/^Why/).fill('Customer asked for time.');
    await aged.getByRole('button', { name: 'Carry on' }).click();
    await expect(aged).toContainText('decision');
    await expect(page.getByLabel('Cases list')).toContainText('Open');
    void tenant;
    await page.close();
  }, 60_000);

  it('shows a diary\'s day, reports a delay that moves the next visit, and marks a message delivered, from the console', async () => {
    const { localToInstant } = await import('../src/cases/policy.js');
    const call = (m: 'POST' | 'PUT', u: string, b: unknown) => env.call(env.staffToken, m, u, b);
    const tenant = (await call('POST', '/internal/tenants', { name: 'Diary UI Co' })).json().id as string;
    const diary = (await call('POST', `/internal/tenants/${tenant}/diaries`, { name: 'Aminah', kind: 'individual', officerRef: 'officer-aminah', timeZone: 'Asia/Kuala_Lumpur' })).json().id as string;
    await call('PUT', `/internal/diaries/${diary}/hours`, { hours: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, starts: '09:00', ends: '17:00' })) });
    const date = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    const book = async (hhmm: string, ref: string) => (await call('POST', `/internal/tenants/${tenant}/appointments`, { diaryId: diary, contactRef: ref, kind: 'field_visit', visitAddress: '12 Jalan Ampang', travelMinutes: 15, startsAt: localToInstant(date, hhmm, 'Asia/Kuala_Lumpur').toISOString(), durationMinutes: 45 })).json();
    await book('09:00', 'cust-first'); await book('10:00', 'cust-second');
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await signIn(page, env.staffToken);
    await page.goto(`${base}#/appointments`);
    await page.getByLabel('Client').selectOption({ label: 'Diary UI Co' });
    await page.getByLabel('Diaries').getByRole('button', { name: 'Aminah' }).click();
    await page.getByLabel(/^Day/).fill(date);
    const agenda = page.getByLabel('Agenda');
    await expect(agenda).toContainText('cust-first'); await expect(agenda).toContainText('cust-second');
    await page.getByLabel(/^Delay in minutes/).fill('20');
    await agenda.getByRole('row', { name: /cust-first/ }).getByRole('button', { name: 'Running late' }).click();
    await expect(agenda.getByRole('row', { name: /cust-second/ })).toContainText('02:20 UTC');          // the next visit moved too (10:20 in Kuala Lumpur; the console shows UTC)
    const outbox = page.getByLabel('Messages to deliver');
    await expect(outbox).toContainText('delayed by 20 minutes');
    const rows = outbox.getByRole('row').filter({ hasText: 'delayed by 20 minutes' });
    const before = await outbox.getByRole('row').count();
    await rows.first().getByRole('button', { name: 'Mark sent' }).click();
    await expect(outbox.getByRole('row')).toHaveCount(before - 1);
    await page.close();
  }, 60_000);

  it('writes knowledge and a policy, shows what a call would hear, and holds a policy to its approvals, from the console', async () => {
    const { createUser } = await import('../src/store/tenants.js'); const { withActor } = await import('../src/db.js');
    const mkToken = async (email: string) => (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }))).token;
    const [t2, t3, t4] = [await mkToken('ui-kb-2@daythree.test'), await mkToken('ui-kb-3@daythree.test'), await mkToken('ui-kb-4@daythree.test')];
    const call = (token: string, m: 'GET' | 'POST' | 'PUT', u: string, b?: unknown) => env.call(token, m, u, b);
    const tenant = (await call(env.staffToken, 'POST', '/internal/tenants', { name: 'Knowledge UI Co' })).json().id as string;
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await signIn(page, env.staffToken);
    await page.goto(`${base}#/knowledge`);
    await page.getByLabel('Client').selectOption({ label: 'Knowledge UI Co' });
    const articles = page.getByLabel('Articles');
    await articles.getByLabel(/^Article name/).fill('late-fees');
    await articles.getByLabel(/^Title/).fill('Late payment fees');
    await articles.getByLabel(/^Text/).fill('A late fee of five ringgit applies after seven days. You can ask for it to be waived once a year.');
    await articles.getByRole('button', { name: 'Write article' }).click();
    await expect(articles).toContainText('late-fees (en)');
    await articles.getByLabel('Ask the knowledge base').fill('late fee');
    await articles.getByRole('button', { name: 'Search as a call would hear it' }).click();
    await expect(articles.getByLabel('Search results')).toContainText('Nothing published matches');           // a draft informs nobody
    const art = (await call(env.staffToken, 'GET', `/internal/tenants/${tenant}/knowledge`)).json()[0];
    const v1 = (await call(env.staffToken, 'GET', `/internal/knowledge/${art.id}`)).json().versions[0].id;
    expect((await call(env.staffToken, 'POST', `/internal/knowledge-versions/${v1}/publish`, {})).statusCode).toBe(403);   // its author cannot publish it
    await call(t2, 'POST', `/internal/knowledge-versions/${v1}/publish`, {});
    await articles.getByRole('button', { name: 'Search as a call would hear it' }).click();
    await expect(articles.getByLabel('Search results')).toContainText('A late fee of five ringgit applies after seven days.');

    const policy = page.getByLabel('Policy', { exact: true });
    await expect(policy).toContainText('No policy is in force');
    await policy.getByLabel(/^Approval levels/).fill('Owner');
    await policy.getByRole('button', { name: 'Save levels' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();                                                 // one level is refused
    await policy.getByLabel(/^Approval levels/).fill('Policy owner, Compliance');
    await policy.getByRole('button', { name: 'Save levels' }).click();
    await expect(policy).toContainText('Policy owner → Compliance');
    await policy.getByLabel(/^Why/).fill('The first policy.');
    await policy.getByRole('button', { name: 'Propose this policy' }).click();
    const card = policy.getByLabel('Policy 1.0');
    await expect(card).toContainText('pending');
    await expect(card).toContainText('Added rule "no_waiver"');
    await card.getByRole('button', { name: 'Approve this level' }).click();
    await expect(card).toContainText('You proposed this change');                                              // not your own
    const pending = (await call(env.staffToken, 'GET', `/internal/tenants/${tenant}/policy`)).json().pending.id;
    await call(t2, 'POST', `/internal/policy-versions/${pending}/decision`, { decision: 'approved' });
    await call(t3, 'POST', `/internal/policy-versions/${pending}/decision`, { decision: 'approved' });
    await page.reload();
    await page.getByLabel('Client').selectOption({ label: 'Knowledge UI Co' });
    await expect(page.getByLabel('Policy 1.0')).toContainText('approved');
    await page.getByLabel('Policy 1.0').getByRole('button', { name: 'Put live' }).click();
    await expect(page.getByLabel('Policy 1.0')).toContainText('You proposed this change');                     // someone else must put it live
    await call(t4, 'POST', `/internal/policy-versions/${pending}/activate`);
    await page.reload();
    await page.getByLabel('Client').selectOption({ label: 'Knowledge UI Co' });
    await expect(page.getByLabel('Policy 1.0')).toContainText('live');
    const ask = page.getByLabel('Policy', { exact: true });
    await ask.getByLabel(/^Ask the policy/).fill('waive_fee');
    await ask.getByRole('button', { name: 'Check' }).click();
    await expect(ask.getByRole('status')).toContainText('Not allowed: Only a person may waive a fee.');
    await page.close();
  }, 90_000);

  it('shows who changed what and why in the change log, and the panels on the Control Tower', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await signIn(page, env.staffToken);
    await expect(page.getByLabel('Runway')).toBeVisible();
    await expect(page.getByLabel('Learning loop')).toContainText('waiting for review');
    await expect(page.getByLabel('Modules')).toContainText('Cases');
    await page.goto(`${base}#/change-log`);
    const changes = page.getByLabel('Changes');
    await expect(changes).toContainText('policy.propose');
    await expect(changes.getByRole('row').filter({ hasText: 'policy.propose' }).first()).toContainText('The first policy.');   // the reason, from the proposal itself
    await expect(changes).toContainText('staff@daythree.test');
    await page.getByLabel('Show').selectOption({ label: 'Money and rates' });
    await expect(changes).not.toContainText('policy.propose');
    await expect(changes).toContainText('fx.add');
    await page.close();
  });

  it('keeps the signed-in session across a reload', async () => {
    const page = await browser.newPage();
    await signIn(page, env.staffToken);
    await expect(page.getByRole('heading', { name: 'Control Tower', level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Control Tower', level: 1 })).toBeVisible();
    await page.close();
  });
});
