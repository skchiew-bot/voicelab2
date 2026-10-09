import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { Json } from './definition.js';
import type { IntegrationCall } from './engine.js';

/**
 * A workflow author chooses the address an API node calls, so that address cannot be allowed to reach our own
 * network (cloud metadata, databases, internal services). Three layers, because each alone has gaps:
 *   1. the base address is checked when it is saved (https, a real hostname, no credentials or odd ports);
 *   2. every address a hostname resolves to must be public, checked at the moment of connecting, so a name that
 *      later points somewhere private (DNS rebinding) is refused;
 *   3. redirects are never followed, and replies are size- and time-limited.
 */
// Two lists, because one list holding both families treats every IPv4 address as IPv4-in-IPv6 and blocks the lot.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [
  ['::', 96],           // includes ::1 and IPv4-compatible addresses such as ::10.0.0.1
  ['fec0::', 10],       // old site-local range
  ['::ffff:0:0', 96],   // IPv4 inside IPv6: refused outright rather than unpacked
  ['64:ff9b::', 96],    // NAT64
  ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(net6, bits, 'ipv6');

/** True only for an address that is on the public internet. Anything unrecognised is not public. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  return family === 4 ? !blocked4.check(ip, 'ipv4') : !blocked6.check(ip, 'ipv6');
}

type Resolver = (host: string, opts: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addrs: dns.LookupAddress[]) => void) => void;

/** A lookup for https.request that refuses any hostname resolving to a non-public address. */
export function guardedLookup(resolve: Resolver = dns.lookup as unknown as Resolver) {
  return (host: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void): void => {
    resolve(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find((a) => !isPublicAddress(a.address));
      if (bad || addrs.length === 0) return cb(Object.assign(new Error('That address is not on the public internet, so Voice Lab will not call it.'), { code: 'EBLOCKED' }));
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  };
}

/** Why a base address cannot be saved, or null if it is fine. */
export function baseUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'That is not a valid address.'; }
  if (u.protocol !== 'https:') return 'Use an https address.';
  if (u.username || u.password) return 'Do not put a username or password in the address. Use the key field.';
  if (u.port && u.port !== '443') return 'Only the standard https port is allowed.';
  if (u.search || u.hash) return 'Leave off the query string and any # part.';
  const host = u.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, '')) !== 0) return 'Use a hostname, not a numeric address.';
  if (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) return 'That hostname looks like an internal name, not a public one.';
  return null;
}

export interface IntegrationConfig { baseUrl: string; authHeader?: string; authSecret?: string }
export interface HttpDeps { lookup?: ReturnType<typeof guardedLookup>; ca?: string | Buffer; timeoutMs?: number; maxBytes?: number; port?: number }

export const MAX_REPLY_BYTES = 1024 * 1024;

/** Make one call to an integration and return its JSON reply. Never follows redirects. */
export function callIntegration(cfg: IntegrationConfig, req: IntegrationCall, deps: HttpDeps = {}): Promise<Json> {
  const problem = baseUrlProblem(cfg.baseUrl);
  if (problem) return Promise.reject(new Error(`The integration's address is not allowed: ${problem}`));
  const base = new URL(cfg.baseUrl);
  const path = base.pathname.replace(/\/+$/, '') + req.path;
  const body = req.method === 'POST' && req.body !== undefined ? JSON.stringify(req.body) : undefined;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxBytes = deps.maxBytes ?? MAX_REPLY_BYTES;

  return new Promise<Json>((resolve, reject) => {
    const done = (fn: () => void) => { clearTimeout(timer); fn(); };
    const r = https.request({
      protocol: 'https:', hostname: base.hostname, port: deps.port ?? 443, path, method: req.method,
      headers: {
        accept: 'application/json', 'user-agent': 'VoiceLab',
        ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(cfg.authHeader && cfg.authSecret ? { [cfg.authHeader]: cfg.authSecret } : {}),
      },
      lookup: (deps.lookup ?? guardedLookup()) as never, ca: deps.ca, agent: false,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return done(() => reject(new Error(`The integration answered HTTP ${status}. Redirects are not followed.`))); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { r.destroy(); done(() => reject(new Error('The integration\'s reply was too large.'))); } else chunks.push(c);
      });
      res.on('end', () => {
        if (status < 200 || status >= 300) return done(() => reject(new Error(`The integration answered HTTP ${status}.`)));
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json; done(() => resolve(v)); }
        catch { done(() => reject(new Error('The integration did not reply with JSON.'))); }
      });
      res.on('error', (e) => done(() => reject(e)));
    });
    const timer = setTimeout(() => { r.destroy(); reject(new Error('The integration took too long to answer.')); }, timeoutMs);
    r.on('error', (e) => done(() => reject(e)));
    if (body !== undefined) r.write(body);
    r.end();
  });
}
