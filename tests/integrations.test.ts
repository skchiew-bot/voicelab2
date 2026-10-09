import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseUrlProblem, callIntegration, guardedLookup, isPublicAddress } from '../src/workflows/integrations.js';

describe('which addresses count as public', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888'])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '203.0.113.9',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it('treats anything that is not an address as not public', () => {
    for (const bad of ['', 'abc', '1.2.3', '1.2.3.4.5', '08.8.8.8', 'example.com', '8.8.8.8/8']) expect(isPublicAddress(bad), bad).toBe(false);
  });
});

describe('the connect-time lookup', () => {
  const resolving = (addrs: { address: string; family: number }[], err: Error | null = null) =>
    ((_h: string, _o: unknown, cb: (e: Error | null, a: typeof addrs) => void) => cb(err, addrs)) as never;
  const lookup = (addrs: { address: string; family: number }[], all = false) =>
    new Promise<{ err: (Error & { code?: string }) | null; result: unknown }>((resolve) =>
      guardedLookup(resolving(addrs))('api.example.com', { all }, (...args: unknown[]) => resolve({ err: args[0] as never, result: args.slice(1) })));

  it('lets a hostname through when every address it resolves to is public', async () => {
    const r = await lookup([{ address: '93.184.216.34', family: 4 }]);
    expect(r.err).toBeNull();
    expect(r.result).toEqual(['93.184.216.34', 4]);
    expect((await lookup([{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }], true)).result).toHaveLength(1);
  });
  it('refuses a hostname that resolves to a private address', async () => {
    for (const a of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '::1']) {
      const r = await lookup([{ address: a, family: a.includes(':') ? 6 : 4 }]);
      expect(r.err?.code, a).toBe('EBLOCKED');
    }
  });
  it('refuses a hostname with even one private address among public ones', async () => {
    expect((await lookup([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], true)).err?.code).toBe('EBLOCKED');
  });
  it('refuses a hostname that resolves to nothing, and passes a resolver error on', async () => {
    expect((await lookup([])).err?.code).toBe('EBLOCKED');
    const failing = await new Promise<Error | null>((resolve) =>
      guardedLookup(resolving([], new Error('ENOTFOUND')))('x.example.com', {}, (...a: unknown[]) => resolve(a[0] as Error)));
    expect(failing?.message).toBe('ENOTFOUND');
  });
});

describe('which base addresses can be saved', () => {
  it('accepts a plain https address, with or without a path', () => {
    expect(baseUrlProblem('https://api.example.com')).toBeNull();
    expect(baseUrlProblem('https://api.example.com/v1/')).toBeNull();
    expect(baseUrlProblem('https://api.example.com:443')).toBeNull();
  });
  it.each([
    ['http://api.example.com', 'https'], ['ftp://api.example.com', 'https'], ['https://user:pass@api.example.com', 'username'],
    ['https://api.example.com:8443', 'port'], ['https://api.example.com/?a=1', 'query'], ['https://api.example.com/#x', 'query'],
    ['https://127.0.0.1', 'numeric'], ['https://169.254.169.254', 'numeric'], ['https://[::1]', 'numeric'], ['https://8.8.8.8', 'numeric'],
    ['https://localhost', 'internal'], ['https://intranet', 'internal'], ['https://printer.local', 'internal'],
    ['https://metadata.google.internal', 'internal'], ['not a url', 'valid'],
  ])('refuses %s', (url, why) => {
    expect(baseUrlProblem(url)).toContain(why);
  });
});

// ---- the real HTTPS path, against a local TLS server (the guard is bypassed only by injecting a lookup)
const dir = mkdtempSync(path.join(tmpdir(), 'vl-tls-'));
let server: https.Server; let port: number; let ca: string;
const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
const toLoopback = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as never;
const cfg = { baseUrl: 'https://api.example.test' };
const call = (c: typeof cfg & { authHeader?: string; authSecret?: string }, req: { method: 'GET' | 'POST'; path: string; body?: never }, extra = {}) =>
  callIntegration(c, req as never, { lookup: toLoopback, ca, port, ...extra });

beforeAll(async () => {
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 2 -subj "/CN=api.example.test" -addext "subjectAltName=DNS:api.example.test" 2>/dev/null`);
  ca = readFileSync(`${dir}/c.pem`, 'utf8');
  server = https.createServer({ key: readFileSync(`${dir}/k.pem`), cert: ca }, (req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url!.startsWith('/redirect')) { res.writeHead(302, { location: '/internal-secret' }); return res.end(); }
      if (req.url!.startsWith('/internal-secret')) { res.writeHead(200); return res.end('{"leaked":true}'); }
      if (req.url!.startsWith('/missing')) { res.writeHead(404); return res.end('{}'); }
      if (req.url!.startsWith('/text')) { res.writeHead(200); return res.end('not json'); }
      if (req.url!.startsWith('/big')) { res.writeHead(200); return res.end('{"x":"' + 'a'.repeat(2000) + '"}'); }
      if (req.url!.startsWith('/slow')) return; // never answers
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { balance: '12.50' }, echoed: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { server?.closeAllConnections(); await new Promise((r) => server?.close(r)); });

describe('calling an integration over https', () => {
  it('sends the request with the key and returns the JSON reply', async () => {
    const reply = await call({ ...cfg, baseUrl: 'https://api.example.test/v1/', authHeader: 'x-api-key', authSecret: 's3cret' }, { method: 'GET', path: '/accounts/A-1' });
    expect(reply).toMatchObject({ data: { balance: '12.50' } });
    const r = seen.at(-1)!;
    expect(r.method).toBe('GET');
    expect(r.url).toBe('/v1/accounts/A-1');
    expect(r.headers['x-api-key']).toBe('s3cret');
    expect(r.headers.host).toBe(`api.example.test:${port}`);
  });
  it('sends a POST body as JSON', async () => {
    const reply = await call(cfg, { method: 'POST', path: '/pay', body: { amount: '10.00', ref: 'A-1' } as never });
    expect(reply).toMatchObject({ echoed: { amount: '10.00', ref: 'A-1' } });
    expect(seen.at(-1)!.headers['content-type']).toBe('application/json');
  });
  it('does not follow a redirect, so a server cannot bounce the call somewhere else', async () => {
    const before = seen.length;
    await expect(call(cfg, { method: 'GET', path: '/redirect' })).rejects.toThrow(/Redirects are not followed/);
    expect(seen.slice(before).map((s) => s.url)).toEqual(['/redirect']);
  });
  it('reports an error status, a reply that is not JSON, a reply that is too large, and one that never comes', async () => {
    await expect(call(cfg, { method: 'GET', path: '/missing' })).rejects.toThrow(/HTTP 404/);
    await expect(call(cfg, { method: 'GET', path: '/text' })).rejects.toThrow(/did not reply with JSON/);
    await expect(call(cfg, { method: 'GET', path: '/big' }, { maxBytes: 1000 })).rejects.toThrow(/too large/);
    await expect(call(cfg, { method: 'GET', path: '/slow' }, { timeoutMs: 250 })).rejects.toThrow(/took too long/);
  });
  it('refuses to connect when the hostname resolves to a private address, without contacting it', async () => {
    const before = seen.length;
    const privateResolver = guardedLookup(((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as never);
    await expect(callIntegration(cfg, { method: 'GET', path: '/accounts/A-1' }, { lookup: privateResolver, ca, port })).rejects.toThrow(/not on the public internet/);
    expect(seen.length).toBe(before);
  });
  it('refuses an address that is not allowed before doing anything', async () => {
    await expect(callIntegration({ baseUrl: 'http://api.example.test' }, { method: 'GET', path: '/x' })).rejects.toThrow(/not allowed/);
    await expect(callIntegration({ baseUrl: 'https://169.254.169.254' }, { method: 'GET', path: '/latest/meta-data' })).rejects.toThrow(/not allowed/);
  });
});
