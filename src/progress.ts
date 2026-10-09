/**
 * Where the project stands against BUILD_PLAN.md, for the Control Tower's progress view.
 * This is maintained by hand when a phase's state changes (see CLAUDE.md). A test ties it to the plan:
 * every phase and exit criterion here must match the plan's text, so the two cannot silently drift.
 *
 * state: met = done and proven; partly = built but not fully proven or not complete; not_met = not done.
 * proof: how it was shown to work. "fakes" means tested against stand-ins for the provider, not the real service.
 */
export type PhaseStatus = 'done' | 'in_progress' | 'not_started';
export type CriterionState = 'met' | 'partly' | 'not_met';
export type Proof = 'tests' | 'fakes' | 'live' | 'none';

export interface Criterion { text: string; state: CriterionState; proof: Proof; note?: string }
export interface PhaseProgress { id: string; name: string; status: PhaseStatus; summary: string; criteria: Criterion[]; open: string[] }

const notMet = (text: string): Criterion => ({ text, state: 'not_met', proof: 'none' });

export const PHASES: PhaseProgress[] = [
  {
    id: '0', name: 'Foundations', status: 'in_progress',
    summary: 'The shared backbone that every later phase plugs into. Built and tested; a few supporting items remain.',
    criteria: [
      { text: 'An operator can add a provider through the UI and enter its parameters and charging mechanism, without a code change.', state: 'met', proof: 'tests', note: 'Driven in a real browser.' },
      { text: 'A rate change creates a new version, and old records keep their original rate.', state: 'met', proof: 'tests' },
      { text: "A client user can't read internal-ledger data, and a test proves it.", state: 'met', proof: 'tests' },
    ],
    open: ['A tenant switcher', 'Redis and the job queue (nothing needs them yet)', 'Finer roles than internal admin, tenant admin and tenant user', 'The Docker install has never been run end to end'],
  },
  {
    id: '1', name: 'Telephony, Voice And Metering', status: 'in_progress',
    summary: 'Real calls on real providers, with the true cost of every call known.',
    criteria: [
      { text: 'Inbound and outbound test calls work on both Twilio and Telnyx.', state: 'not_met', proof: 'fakes', note: 'The code exists and passes against fake providers. It needs live accounts, a public address and real test calls.' },
      { text: "Every test call produces a complete cost record, and the record reconciles with the provider's own usage data within an agreed tolerance.", state: 'partly', proof: 'fakes', note: "Estimated and reconciled records work for Twilio and for figures an operator enters, against fakes. Not checked against the live service; no automatic Telnyx check; no voice usage is fed in yet." },
      { text: 'An outbound call to a number on the do-not-call list is blocked before it is dialled.', state: 'met', proof: 'tests', note: 'Including real call placement: the provider is never contacted.' },
    ],
    open: [
      'Live proof of Twilio and Telnyx call control (the providers\' docs were unreachable while building, so formats were written from memory)',
      'No voicebot yet: every answered call plays a test message and hangs up',
      'Telnyx automatic reconciliation, and a schedule for the reconciliation sweep',
      'Voice usage (characters, tokens) is not yet fed into cost records',
    ],
  },
  {
    id: '2', name: 'Workflow Skeleton', status: 'in_progress', summary: "The minimum workflow engine that stitching and modules can hang off. The engine, versions, staging and production, simulation, integrations and the Malaysian debt-collection template are built and tested.",
    criteria: [
      { text: 'The debt-collection template runs end to end in staging and then in production.', state: 'partly', proof: 'tests',
        note: "Runs from the first word to the outcome in staging (simulated) and in production (a scripted caller replying through the API), all tested. No real phone call runs through it: no speech recognition or voice provider is connected to calls, so a live call cannot yet hold this conversation. The wording is a draft for compliance and native-speaker review." },
      { text: 'Rolling back to the previous version works on a live workflow.', state: 'met', proof: 'tests', note: 'Tested with a call in flight: it finishes on the version it started on, and new calls get the version rolled back to.' },
      { text: "A workflow with a dangling path can't be published.", state: 'met', proof: 'tests', note: 'A missing target (including names every object inherits), an unreachable node, or a dependency that is not ready each block publishing; a new version that would break a live caller is refused too.' },
    ],
    open: [
      'Live phone calls cannot hold this conversation yet: no speech recognition or voice provider is connected, and the engine takes the caller\'s words as text',
      'The prompt-to-workflow builder (deferred in the plan)',
      'A visual canvas: the console shows an outline and a JSON editor',
      'Replies are understood by phrase rules only; nothing yet handles a reply the rules cannot match',
    ],
  },
  {
    id: '3', name: 'Stitching And Outbound Deliverability', status: 'not_started', summary: "Cut cost without hurting the caller's experience.",
    criteria: [
      notMet('The cost difference between a stitched and an unstitched version of the same flow is measured.'),
      notMet('A blind listening check confirms there is no drop in caller experience (the Customer Experience Council signs off).'),
      notMet('The DID-lock rule has been verified against failure history.'),
    ], open: [],
  },
  {
    id: '4', name: 'Resilience And Concurrency', status: 'not_started', summary: 'Degrade gracefully instead of failing.',
    criteria: [
      notMet('Chaos tests cover killing the provider, injecting latency and running the balance to zero. Each produces the expected failover with no dead drop.'),
      notMet('Reaching a concurrency ceiling triggers queueing or rerouting, and no burst charge appears on the bill.'),
    ], open: [],
  },
  {
    id: '5', name: 'Journey, QA And Audit', status: 'not_started', summary: 'Every call can be reconstructed down to the node and the reason.',
    criteria: [
      notMet('Any production call can be fully replayed.'),
      notMet('Every escalation produces a ticket with all the required fields.'),
      notMet('An unintentional system drop raises an alert within agreed latency.'),
    ], open: [],
  },
  {
    id: '6', name: 'Self-Learning Promotion Loop', status: 'not_started', summary: 'Promote nodes from live TTS to pre-recorded audio based on evidence, never assumption.',
    criteria: [
      notMet('At least one node is promoted automatically, with an audit trail.'),
      notMet('A simulated drift demotes it again, also with an audit trail.'),
      notMet('The financial assessment shows the cost change for both.'),
    ], open: [],
  },
  {
    id: '7', name: 'Business Modules', status: 'not_started', summary: 'Self-contained modules that each plug into the shared backbone: case management, appointments, knowledge base and policy.',
    criteria: [], open: [],
  },
  {
    id: 'CT', name: 'Control Tower', status: 'in_progress', summary: 'One internal console to see and steer the whole platform. Version 1 shows project progress, what needs attention, live calls, provider health, funding and cost.',
    criteria: [
      { text: 'An operator can answer these from one screen without opening a provider console:', state: 'partly', proof: 'tests', note: 'What needs attention, live calls, provider health, recorded funding balances, and cost and margin totals are on one screen; cost by campaign is one click away on the Calls screen. Funding is not yet deducted automatically as calls are costed, and alerts are shown in the console only.' },
      { text: 'Every action taken in the Control Tower appears in the change log, with who did it and why.', state: 'not_met', proof: 'none', note: 'Actions are recorded in the audit log, but no change-log screen shows them yet.' },
    ],
    open: ['A change-log screen (actions are recorded in the audit log, but nothing shows them yet)', 'Alerts by email, WhatsApp or Slack', 'Funding runway and burn rate'],
  },
];

/** The plan's exit criterion that applies to every phase. */
export const CROSS_CUTTING: Criterion[] = [
  {
    text: 'each AI task the phase introduces has a configured model tier, a logged token count and a documented escalation rule.',
    state: 'partly', proof: 'none',
    note: 'No AI task exists in the product yet. The model_config table and the tier rules in CLAUDE.md are in place; token logging and escalation rules do not exist yet.',
  },
];

/** Open decisions, worded as in the plan's table. */
export const DECISIONS: string[] = [
  'Client rate card (per minute, and per feature)',
  'Confirm the proposed technology stack (see Global Requirements): language, plus any changes',
  'Hosting region (Malaysian data-residency rules for call recordings and debtor data)',
  'Cloud provider',
  "How each provider's usage is ingested (per-call API, webhook or invoice) and how long it lags",
  'Failover thresholds: N errors, latency window, hysteresis',
  'Frequency and confidence thresholds for promotion',
  'Do-not-call registry sources per country',
  'Who staffs the Quality Council and Customer Experience Council, and what they need to sign off',
  'Alert channels and on-call ownership',
];
