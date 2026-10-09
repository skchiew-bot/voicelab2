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
    .locator('input, select').first();
};

async function signIn(page: Page, token: string) {
  await page.goto(base);
  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

describe.skipIf(!run)('admin UI', () => {
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
    await expect(page.getByRole('heading', { name: 'Providers' })).toHaveCount(0);
    await page.close();
  });

  it('lets an operator add a provider, set rates and funding, and manage a client, all from forms', async () => {
    const page = await browser.newPage();
    await signIn(page, env.staffToken);

    // Providers: the form is built from the adapter declaration.
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

  it('keeps the signed-in session across a reload', async () => {
    const page = await browser.newPage();
    await signIn(page, env.staffToken);
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
    await page.close();
  });
});
