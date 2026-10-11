const KEY = 'voicelab.token';

// sessionStorage can be unavailable (private windows, blocked storage); the app still works for the visit.
let memoryToken: string | null = null;
export const getToken = (): string | null => {
  try { return sessionStorage.getItem(KEY) ?? memoryToken; } catch { return memoryToken; }
};
export const setToken = (t: string | null): void => {
  memoryToken = t;
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* ignore */ }
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details: string[] = []) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${getToken() ?? ''}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const raw = data?.details;
    const details = Array.isArray(raw)
      ? raw.map((d: unknown) => (typeof d === 'string' ? d : (d as { message?: string }).message ?? JSON.stringify(d)))
      : [];
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`, details);
  }
  return data as T;
}

/** Fetch a file the API serves behind the token (audio), as a local URL the browser can play. */
export async function apiObjectUrl(path: string): Promise<string> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
  if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status}).`);
  return URL.createObjectURL(await res.blob());
}

export interface ParamDef { key: string; label: string; type: 'string' | 'secret' | 'url' | 'number' | 'boolean'; required: boolean; help?: string }
export interface Adapter {
  key: string; kind: 'telephony' | 'voice' | 'model'; displayName: string; docsUrl: string;
  params: ParamDef[]; defaultCapabilities: Record<string, string>;
}
export interface Capability { capability: string; support: 'native' | 'composable' | 'unsupported'; notes: string | null }
export interface Provider {
  id: string; adapter_key: string; kind: string; name: string; params: Record<string, unknown>;
  status: string; secrets_stored: boolean; credentials_checked_at: string | null; capabilities: Capability[];
}
export interface Component { component: string; unit: string; rate: string; currency: string; billing_line: string; direction: string }
export interface ChargingVersion {
  id: string; version: number; effective_from: string; billing_increment_seconds: number;
  minimum_charge_seconds: number; rounding: string; concurrency_limit: number | null;
  burst_premium_multiplier: string | null; notes: string | null; confirmed: boolean;
  source_url: string | null; components: Component[];
}
export interface Tenant { id: string; name: string; created_at: string }
export interface Project { id: string; name: string }
export interface CreditSummary { balance: string; recent: { id: number; kind: string; credits: string; ref: string | null; created_at: string }[] }

export interface FxRate { id: number; currency: string; per_usd: string; effective_from: string }
export interface RateCard { id: number; effective_from: string; inbound_credits_per_minute: string; outbound_credits_per_minute: string; credit_value_usd: string }
export interface PhoneNumber { id: string; provider_id: string; e164: string; tenant_id: string; project_id: string | null; country: string; label: string | null }
export interface DncRegistry { country: string; requirement: 'registry' | 'none_required'; source: string; national_entries: number }
export interface CallRow {
  id: string; tenant_id: string; provider_id: string; direction: string; status: string; country: string | null;
  started_at: string; ended_at: string | null; duration_seconds: string | null; end_reason: string | null; cost_status: string; cost_error?: string | null;
}
export interface CostLine { component: string; billing_line: string; unit: string; quantity: string; billed_seconds: number | null; rate: string; currency: string; amount: string; amount_usd: string }
export interface CallCost { status: string; total_usd: string; total_myr: string; credits_drawn: string; margin_usd: string; lines: CostLine[] }
export interface Reconciliation { id: number; source: string; outcome: string; our_cost_usd: string; reported_cost_usd: string | null; detail: string; created_at: string }
export interface CampaignCost { project_id: string | null; project: string | null; calls: number; total_usd: string; total_myr: string; credits_drawn: string; margin_usd: string }
export interface CallEvent { id: number; type: string; occurred_at: string }
export interface ReferenceRate { adapterKey: string; summary: string }

export interface Alert { severity: 'high' | 'medium' | 'low'; code: string; message: string; link?: string }
export interface ProviderHealth {
  id: string; name: string; adapter: string; kind: string; status: string; credentialsCheckedAt: string | null;
  ratesInForce: boolean; ratesConfirmed: boolean; calls24h: { total: number; completed: number; unanswered: number; failed: number }; lastCall: string | null;
}
export interface MoneyWindow { calls: number; cost_usd: string; cost_myr: string; credits_drawn: string; margin_usd: string }
export interface Tower {
  generatedAt: string; alerts: Alert[]; blocked24h: number; activeTotal: number; providers: ProviderHealth[];
  activeCalls: { id: string; direction: string; status: string; started_at: string; provider_id: string }[];
  funding: { provider_id: string; provider: string; currency: string; balance: string; entries: number }[];
  money: { last24h: MoneyWindow; last7d: MoneyWindow };
}
export interface ControlState { providers: { id: string; name: string; kind: string; status: string; health: 'healthy' | 'failed' | 'unfunded'; healthReason: string | null; drained: { at: string; by: string; reason: string } | null; preferred: boolean }[]; pacePerMinute: number | null }
export interface ChangeEntry { id: number; at: string; action: string; category: string; entity: string; entityId: string | null; who: string; why: string | null; detail: Record<string, unknown>; link: string | null }
export interface ChangeLogPage { entries: ChangeEntry[]; next: number | null }
export interface Panels {
  generatedAt: string; unavailable: string[];
  stitching: { synthChars: number; recordedChars: number; recordedPercent: string | null; workflows: { workflowId: string | null; workflow: string; tenant: string; synthChars: number; recordedChars: number; recordedPercent: string | null }[] } | null;
  deliverability: { pool: { active: number; retired: number }; failures: { reason: string; n: number; numbers: number }[]; attempts: number; inFlight: number; notDialled: { blocked: number; noCallerId: number };
    outcomes: { contacted: number; rejected: number; wrongNumber: number; thirdParty: number; unclassified: number; noAnswer: number; unreachable: number }; rates: { contactPercent: number | null; answerPercent: number | null } } | null;
  concurrency: { providers: { providerId: string; provider: string; active: number; ceiling: number | null; usedPercent: string | null; burst24h: number }[]; deferred24h: number; paced24h: number; pacePerMinute: number | null; tenants: { tenantId: string; tenant: string; channels: number; active: number; queued: number }[] } | null;
  journeyQa: { qa: { scored: number; scores: number; average: string | null; distribution: { band: string; n: number }[] }; escalations: { trigger: string; n: number }[]; unacknowledgedFaults: number; sentiment: { day: string; turns: number; average: string | null; severe: number }[] } | null;
  learning: { inReview: number; approved: number; promoted: number; demoted: number; rejected: number; driftDemotions7d: number; forcedDemotions7d: number } | null;
  modules: { cases: { open: number; decisionRequired: number; needsHuman: number; missedOrUnknown: number; brokenPromises7d: number }; appointments: { needsReschedule: number; upcoming: number; unsentOverAnHour: number; movedByDelays7d: number } } | null;
  funding: { providers: { providerId: string; provider: string; status: string; currency: string; balance: string; recordedAt: string; spent7d: string; perDay: string; runwayDays: string | null;
    runway: 'measured' | 'no_spend' | 'spend_in_other_currency'; spentInOtherCurrencies: { currency: string; spent: string }[] }[]; spendWithoutBalance: { providerId: string; provider: string; currency: string; spent7d: string }[] } | null;
}
export interface PhaseProgress {
  id: string; name: string; status: 'done' | 'in_progress' | 'not_started'; summary: string; open: string[];
  criteria: { text: string; state: 'met' | 'partly' | 'not_met'; proof: 'tests' | 'fakes' | 'live' | 'none'; note?: string }[];
}
export interface Progress { generatedAt: string; phases: PhaseProgress[]; crossCutting: PhaseProgress['criteria']; decisions: string[] }

export interface WorkflowSummary { id: string; tenant_id: string; name: string; latest_version: string | null; staging_version: string | null; production_version: string | null }
export interface WfIssue { code: string; nodeId?: string; message: string }
export interface WfVersion { id: string; version: string; change: string; valid: boolean; issues: { errors: WfIssue[]; warnings: WfIssue[] }; note: string | null; created_at: string; definition: WorkflowDef }
export interface WorkflowDef { start: string; variables?: string[]; nodes: Record<string, { type: string; speech?: string; text?: string | Record<string, string>; transitions?: { when?: unknown; to: string }[]; workflow?: string; target?: unknown; outcome?: string; integration?: string; label?: string }> }
export interface WorkflowDetailData { id: string; tenant_id: string; name: string; live: { staging: string | null; production: string | null }; previous: { staging: string | null; production: string | null }; history: { id: number; environment: string; kind: string; version: string; created_at: string }[]; versions: WfVersion[] }
export interface TemplateInfo { key: string; title: string; description: string; entry: string; workflows: { key: string; description: string }[] }
export interface SimResult { batchId: string; total: number; passed: number; failed: number; clean: boolean; gateProblems?: string[]; results: { name: string; passed: boolean; outcome: string | null; failures: string[] }[] }
export interface RunView { id: string; version: number; status: string; outcome: string | null; error: string | null; said: string[]; awaiting: { captureAs: string } | null }

export interface PoolNumber extends PhoneNumber { status: string; use_count: number; last_used_at: string | null; failures: number; contacts_locked: number; inbound_workflow_id: string | null }
export interface Recording { id: string; language: string; text: string; version: number; label: string | null; content_type: string; duration_ms: number; created_at: string }
export interface RecordingGaps { covered: number; missingCharacters: number; missing: { node: string; language: string; text: string; characters: number }[] }
export interface StitchReport {
  scenarios: number; unstitched: { synthChars: number; costUsd: string }; stitched: { synthChars: number; recordedChars: number; costUsd: string };
  saved: { chars: number; costUsd: string; percent: string }; ratesConfirmed: boolean; note: string;
}
export interface OutboundReport {
  period: { from: string; to: string }; notDialled: { blocked: number; noCallerId: number }; inFlight: number; attempts: number;
  outcomes: { contacted: number; rejected: number; wrongNumber: number; thirdParty: number; unclassified: number; noAnswer: number; unreachable: number };
  rates: { contactPercent: number | null; answerPercent: number | null };
  bestCallbackTimes: { day: number; hour: number; time_zone: string; requests: number }[];
}

export interface HealthRow { provider_id: string; name: string; kind: string; status: string; state: 'healthy' | 'failed' | 'unfunded'; reason: string | null; since: string | null; ok_streak: number }
export interface FailoverRow { id: number; scope: string; call_id: string | null; from_name: string | null; to_name: string | null; trigger: string; detail: Record<string, unknown>; at: string }
export interface CapacityRow { providerId: string; name: string; active: number; ceiling: number | null }
export interface FundingRow { providerId: string; provider: string; providerStatus: string; currency: string; balance: string; level: 'ok' | 'warn' | 'critical' | 'empty'; warnBelow: string | null; criticalBelow: string | null }
export interface PolicyView { errorThreshold: number; errorWindowMs: number; latencyThresholdMs: number; latencyWindowMs: number; latencyMinSamples: number; deadAirMs: number; recoveryOkSamples: number; recoveryDwellMs: number }

export interface ReplayTimeline { index: number; at: string; source: string; type: string; node?: string | null; speaker: 'assistant' | 'caller' | 'system'; summary: string; text?: string; latencyMs?: number; reasoning?: Record<string, unknown>; policy?: string; adherence?: 'on_path' | 'deviation' }
export interface ReplayView {
  run: { id: string; workflow: string; status: string; outcome: string | null; environment: string; kind: string; versions: Record<string, string> } | null;
  call: { id: string; status: string; direction: string; ended_by: string | null; ended_node: string | null; fault: boolean; fault_reason: string | null } | null;
  summary: { durationMs: number | null; turns: number; outcome: string | null; endedBy: string | null; endedAtNode: string | null; fault: boolean; escalated: boolean };
  timeline: ReplayTimeline[];
  transcript: { index: number; speaker: 'assistant' | 'caller'; text: string; at: string; node: string | null; timelineIndex: number; latencyMs?: number; sentiment?: number }[];
  sentiment: { turn: number; sentiment: number; severe: boolean; kind: string; topic: string | null; node: string | null; transcriptIndex: number; timelineIndex: number }[];
  adherence: { score: number | null; followed: number; checked: number; deviations: { seq: number; node: string | null; reason: string }[] };
}
export interface TicketRow { id: string; kind: 'escalation' | 'fault'; trigger: string; reason: string; node: string | null; status: 'open' | 'in_review' | 'resolved'; created_at: string; call_id: string | null; run_id: string | null }
export interface TicketFull extends TicketRow {
  customer_view: string; ai_reviews: { reviewer: string; verdict: string; findings: { check: string; result: string }[] }[];
  council_notes: { status: string; note?: string; notes: { note: string; at: string }[] }; impact: Record<string, unknown>;
  events: { id: number; kind: string; status: string | null; note: string | null; at: string }[];
}
export interface FaultRow { id: string; direction: string; ended_node: string | null; fault_reason: string; fault_at: string; acknowledged: boolean; flagged_after_ms: string | null }
export interface QaSet { id: string; use_case: string; version: number; criteria: { id: string; label: string; type: string; weight: number }[] }
export interface QaScore { id: string; run_id: string; workflow: string; use_case: string; criteria_version: number; score: string; scorer: string; model: string | null; tier: string | null; input_tokens: number; output_tokens: number; escalated_from: string | null; results: { complete: boolean; results: { id: string; label: string; passed: boolean | null; detail: string; scorer: string }[] }; created_at: string }
export interface QaSummary { byWorkflow: { workflow: string; scored: number; average: string; lowest: string }[]; mostFailed: { criterion: string; label: string; failed: number }[]; unscored: number }
export interface AiUsage { task: string; model: string; tier: string; decisions: number; input_tokens: string; output_tokens: string; rejected: number; reworked: number; escalations: number }
export interface ChangeRow { id: string; workflow: string; environment: string; from_version: string | null; to_version: string; status: 'pending' | 'approved' | 'rejected' | 'applied'; reason: string; changes: number; levelsDone: number; levelsTotal: number; created_at: string }
export interface ChangeFull extends ChangeRow {
  diff: { shape: string; summary: string[]; lines: { op: '+' | '-' | '~'; node: string | null; text: string }[] };
  financial: { basis: { scenarios: number }; delta: { synthChars: number; says: number; steps: number; escalations: number; costUsd: string | null }; ratesConfirmed: boolean | null; note: string; before: { synthChars: number } | null; after: { synthChars: number } };
  progress: { level: number; name: string; decision: string | null; note: string | null; at: string | null }[]; nextLevel: number | null;
}
export interface Showcase {
  change: { workflow: string; status: string; reason: string; from: string | null; to: string };
  before: { version: string | null; steps: { id: string; type: string; start: boolean; text: string }[] }; after: { version: string; steps: { id: string; type: string; start: boolean; text: string }[] };
  detected: { periodDays: number; calls: number; escalated: number; escalationPercent: number | null; failed: number; averageSentiment: number | null; turns: number; turnsNotUnderstood: number; whereCallsEscalate: { node: string; escalations: number }[] };
  why: string; changes: ChangeFull['diff']; financial: ChangeFull['financial']; approvals: ChangeFull['progress'];
  audio: { node: string; language: string; text: string; recordingId: string | null }[]; audioNote: string;
}

export interface LearningCluster { workflow: string; node: string; language: string; context: string; script: string; support: number; variants: number; ready: boolean; percentOfThreshold: number }
export interface LearningOverview {
  config: { minSupport: number; similarity: number; minConfidence: number; driftMinSamples: number; voiceProviderId: string | null };
  summary: { inReview: number; approved: number; promoted: number; demoted: number; rejected: number };
  threshold: number; clusters: LearningCluster[];
}
export interface Promotion { id: string; workflow: string; node: string; language: string; context_kind: string; context_topic: string; script: string; support: number; variants: number; status: 'in_review' | 'approved' | 'promoted' | 'demoted' | 'rejected'; distilled_by: string; created_at: string }
export interface PromotionEvent { id: number; kind: string; reason: string; created_at: string; detail: Record<string, unknown> }
export interface PromotionFinancial {
  direction: 'promote' | 'demote';
  perUse: { liveBefore: { chars: number; costUsd: string | null }; afterPromotion: { chars: number; costUsd: string | null }; saved: { chars: number; costUsd: string | null } };
  oneTime: { chars: number; costUsd: string | null; note: string }; breakEvenUses: number | null; usesWhilePromoted: number; realisedSavingUsd: string | null; ratesConfirmed: boolean | null; note: string;
}

export interface CaseRow { id: string; case_ref: string; contact_ref: string | null; status: 'open' | 'decision_required' | 'closed'; currency: string; opening_balance: string; paid_total: string; treatment: number; needs_human: boolean; opened_at: string; close_reason: string | null; pending_actions: number }
export interface CaseView {
  id: string; caseRef: string; status: CaseRow['status']; closeReason: string | null; needsHuman: boolean; currency: string; timeZone: string; balance: string; openingBalance: string; paidTotal: string;
  treatment: { level: number; name: string }; readBack: string;
  promises: { id: string; amount: string; due_on: string; status: string }[];
  actions: { id: string; kind: string; channel: string; scheduled_for: string; status: string; attempt: number; note: string | null }[];
  events: { id: number; kind: string; detail: Record<string, unknown>; at: string }[];
  bestTimes: { dow: number; hour: number; answered: number; tried: number }[];
}
export interface CasesSummary { open: number; decisionRequired: number; needsHuman: number; missedOrUnknown: number }

export interface DiaryRow { id: string; name: string; kind: 'individual' | 'group'; officer_ref: string | null; time_zone: string; active: boolean; members: number }
export interface AgendaRow { id: string; diary: string; contact_ref: string; kind: 'at_location' | 'field_visit'; starts_at: string; ends_at: string; travel_minutes: number; status: string; fee: string; location: string | null; visit_address: string | null }
export interface NotificationRow { id: string; appointment_id: string; recipient_kind: string; recipient_ref: string; channel: string; kind: string; body: string; status: string; created_at: string }
export interface AppointmentSummary { needsReschedule: number; upcoming: number; unsentOverAnHour: number }

export interface KnowledgeRow { id: string; slug: string; language: string; title: string; retired_at: string | null; published_version: number | null; drafts: number }
export interface KnowledgeVersion { id: string; version: number; title: string; body: string; voice_text: string | null; status: string; review_note: string | null }
export interface KnowledgeArticle { id: string; slug: string; language: string; retiredAt: string | null; versions: KnowledgeVersion[] }
export interface PolicyVersion { id: string; version: string; status: string; summary: string; rules: unknown[]; diff: string[]; proposedBy: string | null; progress: { level: number; name: string; decision: string | null; note: string | null }[]; nextLevel: number }
export interface PolicyOverview { levels: string[]; live: PolicyVersion | null; pending: PolicyVersion | null; history: PolicyVersion[] }
