import type pg from 'pg';
import { withActor } from '../db.js';
import type { HandoverPacket } from '../store/runs.js';
import { recordEvent } from '../store/events.js';
import { routingHealth } from '../store/control-actions.js';
import { addCallbackRequest, getFallbackPlan, getRoutes, healthMap, logFailover, markUnfunded, recordSample } from '../store/resilience.js';
import { classify, pickRoute } from './failover.js';
import { DEFAULT_FALLBACK, fallbackLadder, type FallbackStep } from './fallback.js';
import { getPolicy } from '../store/resilience.js';

/** A voice provider as a call sees it. Real adapters fit this; tests use fakes that can be killed, slowed or run dry. */
export interface VoiceRuntime {
  /** Speak a line. Rejects on a hard failure, and with FundingExhausted if the provider has no credit left. */
  speak(text: string): Promise<{ latencyMs: number }>;
  /** Told what the call has said and collected so far, when this provider takes the call over. */
  resume?(packet: HandoverPacket): Promise<void>;
  /** A cheap health check, used to find out whether a failed provider has recovered. */
  ping?(): Promise<{ latencyMs: number }>;
}

export class FundingExhausted extends Error {
  constructor() { super('The provider has no credit left.'); }
}

/** The telephony leg: it can still play audio and move a call when no voice provider works. */
export interface TelephonyRuntime {
  playHolding(text: string): Promise<void>;
  transferToHuman(): Promise<void>;
  offerCallback(): Promise<void>;
  voicemail(): Promise<void>;
}

export interface SessionDeps {
  pool: pg.Pool;
  runtime(providerId: string): VoiceRuntime | undefined;
  telephony: TelephonyRuntime;
  humanAvailable?: () => Promise<boolean>;
  handover?: () => Promise<HandoverPacket>;
  now?: () => Date;
}

export interface SpeakInput {
  tenantId: string; callId: string; runId?: string;
  /** What the call says, in order, with every slot already filled. */
  lines: string[];
  /** Played by the new provider when it takes over, before the interrupted line is replayed. */
  bridge?: string;
  /** The client's own reference for the person, for a callback request. */
  contactRef?: string;
  /** Attempts per line across all providers, so a failing line cannot loop for ever. */
  maxAttemptsPerLine?: number;
}

export interface SessionResult {
  outcome: 'completed' | 'fallback';
  played: { line: string; providerId: string; replay: boolean }[];
  switches: { from: string; to: string | null; trigger: string }[];
  fallback?: { steps: FallbackStep[]; done: FallbackStep['kind'][]; failed: FallbackStep['kind'][] };
}

const asInternal = <T>(d: SessionDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.pool, { kind: 'internal' }, fn);
export const DEFAULT_BRIDGE = 'One moment please.';
const BRIDGE_TRIES = 3;

/**
 * Say a call's lines through the best working voice provider, and keep the call going when that provider fails:
 * retry until the provider is judged failed, then hand over to the next one, which plays a bridge message and then
 * replays the interrupted line in full. If every provider has failed, the fallback ladder takes over. The call is
 * never left in silence.
 */
export async function speakLines(d: SessionDeps, input: SpeakInput): Promise<SessionResult> {
  const now = d.now ?? (() => new Date());
  const result: SessionResult = { outcome: 'completed', played: [], switches: [] };
  const routes = await asInternal(d, (c) => getRoutes(c, input.tenantId, 'voice'));
  const tried = new Set<string>();
  const event = (type: string, payload: Record<string, unknown>) =>
    asInternal(d, (c) => recordEvent(c, { tenantId: input.tenantId, callId: input.callId, type, payload, occurredAt: now() }));
  const choose = () => asInternal(d, async (c) => pickRoute(routes, await routingHealth(c, routes.map((r) => r.providerId)), tried));

  /** One attempt to say something through one provider. Records it, and says whether it played and whether the provider is still trusted. */
  const attempt = async (providerId: string, text: string): Promise<{ played: boolean; healthy: boolean; trigger?: string }> => {
    const rt = d.runtime(providerId);
    let kind: 'ok' | 'error' | 'dead_air' = 'error'; let latencyMs: number | undefined; let funding = false;
    if (rt) {
      try { const r = await rt.speak(text); latencyMs = r.latencyMs; kind = classify({ latencyMs }, await asInternal(d, getPolicy)); }
      catch (e) { if (e instanceof FundingExhausted) funding = true; }
    }
    const at = now();
    const h = await asInternal(d, (c) => funding
      ? markUnfunded(c, providerId, { tenantId: input.tenantId, callId: input.callId, at })
      : recordSample(c, { providerId, kind, latencyMs, callId: input.callId, tenantId: input.tenantId, at }));
    return { played: kind === 'ok' && !funding, healthy: h.state === 'healthy', trigger: funding ? 'funding' : h.transition?.trigger ?? (kind === 'ok' ? undefined : kind === 'error' ? 'hard_errors' : 'dead_air') };
  };

  /** Hand the call to the next working provider, which says the bridge message first. Null if none can. */
  const takeOver = async (from: string, trigger: string): Promise<string | null> => {
    tried.add(from);
    for (;;) {
      const next = await choose();
      const entry = { from, to: next, trigger };
      result.switches.push(entry);
      await asInternal(d, (c) => logFailover(c, { scope: 'voice', tenantId: input.tenantId, callId: input.callId, runId: input.runId, from, to: next, trigger }));
      await event('failover.voice', { from, to: next, trigger });
      if (!next) return null;
      const packet = d.handover ? await d.handover() : undefined;
      if (packet) await d.runtime(next)?.resume?.(packet).catch(() => undefined);
      // One error on the bridge does not condemn the provider: it is tried again while it is still trusted.
      let b = await attempt(next, input.bridge ?? DEFAULT_BRIDGE);
      for (let i = 1; i < BRIDGE_TRIES && !(b.played && b.healthy) && b.healthy; i++) b = await attempt(next, input.bridge ?? DEFAULT_BRIDGE);
      if (b.played && b.healthy) return next;
      tried.add(next); from = next; trigger = b.trigger ?? 'hard_errors';   // it could not say it: look further
    }
  };

  let current = await choose();
  const cap = input.maxAttemptsPerLine ?? 20;
  for (const line of input.lines) {
    let replay = false;
    for (let attempts = 0; ; attempts++) {
      if (!current || attempts >= cap) { await totalFailure(d, input, result, current); return result; }
      const a = await attempt(current, line);
      if (a.played) result.played.push({ line, providerId: current, replay });
      // A provider that is no longer trusted hands over now; one still trusted is simply tried again (unless it was a success).
      if (!a.healthy) {
        const next = await takeOver(current, a.trigger ?? 'hard_errors');
        if (!a.played) replay = true;           // cut off mid-line: the whole line is said again, slot values and all
        current = next;
        if (a.played) break;
        continue;
      }
      if (a.played) break;
    }
  }
  return result;
}

/** Every provider has failed. Record the callback first so it cannot be lost, then climb the ladder; no step may throw. */
async function totalFailure(d: SessionDeps, input: SpeakInput, result: SessionResult, last: string | null) {
  const plan = (await asInternal(d, (c) => getFallbackPlan(c, input.tenantId))) ?? DEFAULT_FALLBACK;
  const humanAvailable = d.humanAvailable ? await d.humanAvailable().catch(() => false) : false;
  const steps = fallbackLadder(plan, { humanAvailable });
  const done: FallbackStep['kind'][] = []; const failed: FallbackStep['kind'][] = [];
  if (steps.some((s) => s.kind === 'record_callback_request' || s.kind === 'offer_callback')) {
    await asInternal(d, (c) => addCallbackRequest(c, { tenantId: input.tenantId, callId: input.callId, contactRef: input.contactRef, reason: 'every voice provider failed' }));
    done.push('record_callback_request');
  }
  for (const s of steps) {
    if (s.kind === 'record_callback_request') continue;
    try {
      if (s.kind === 'holding_message') await d.telephony.playHolding(s.text);
      else if (s.kind === 'transfer_human') await d.telephony.transferToHuman();
      else if (s.kind === 'offer_callback') await d.telephony.offerCallback();
      else await d.telephony.voicemail();
      done.push(s.kind);
    } catch { failed.push(s.kind); }
  }
  result.outcome = 'fallback';
  result.fallback = { steps, done, failed };
  await asInternal(d, async (c) => {
    await logFailover(c, { scope: 'fallback', tenantId: input.tenantId, callId: input.callId, runId: input.runId, from: last, trigger: 'all_providers_failed', detail: { steps: steps.map((s) => s.kind), done, failed } });
    await recordEvent(c, { tenantId: input.tenantId, callId: input.callId, type: 'failover.fallback', payload: { steps: steps.map((s) => s.kind), done, failed } });
  });
}

/**
 * Try the voice providers that have failed over, so they can earn their way back. Each probe counts as an attempt; the
 * hysteresis rules decide when a run of good ones is enough. A deployment runs this on a schedule: nothing else sends a
 * failed provider any traffic. A provider that is out of funding is not probed (a top-up is what brings it back).
 */
export async function probeProviders(d: SessionDeps): Promise<{ providerId: string; kind: 'ok' | 'error' | 'dead_air'; state: string }[]> {
  const now = d.now ?? (() => new Date());
  const failed = await asInternal(d, async (c) => [...(await healthMap(c)).entries()].filter(([, s]) => s === 'failed').map(([id]) => id));
  const out: { providerId: string; kind: 'ok' | 'error' | 'dead_air'; state: string }[] = [];
  for (const providerId of failed) {
    const rt = d.runtime(providerId);
    if (!rt?.ping) continue;
    let kind: 'ok' | 'error' | 'dead_air' = 'error'; let latencyMs: number | undefined;
    try { latencyMs = (await rt.ping()).latencyMs; kind = classify({ latencyMs }, await asInternal(d, getPolicy)); } catch { /* an error is a sample like any other */ }
    const h = await asInternal(d, (c) => recordSample(c, { providerId, kind, latencyMs, probe: true, at: now() }));
    out.push({ providerId, kind, state: h.state });
  }
  return out;
}
