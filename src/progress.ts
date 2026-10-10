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
    id: '3', name: 'Stitching And Outbound Deliverability', status: 'in_progress', summary: "Cut cost without hurting the caller's experience. Recordings, the stitching plan and its measured saving, the DID pool with its permanent failure lock, and outbound analytics are built and tested against fakes.",
    criteria: [
      { text: 'The cost difference between a stitched and an unstitched version of the same flow is measured.', state: 'partly', proof: 'tests',
        note: "The measuring is built and exact: the same scripted callers are played with and without recordings and the difference in synthesised characters is priced at the voice provider's rate. It has not been run on a real flow with real recordings and a confirmed rate, and it prices speech synthesis only." },
      { text: 'A blind listening check confirms there is no drop in caller experience (the Customer Experience Council signs off).', state: 'not_met', proof: 'none',
        note: 'Needs people listening to real stitched calls. No audio plays on a call yet, so there is nothing to listen to.' },
      { text: 'The DID-lock rule has been verified against failure history.', state: 'partly', proof: 'tests',
        note: 'The rule is tested against seeded failure history: a failed DID is never used again for that contact, the next provider is used when the cheap one is locked out, and a dial is refused without contacting a provider when nothing is left. There is no real failure history yet, and failures are recorded by an operator or the API, not detected from carrier signals.' },
    ], open: [
      'No audio is played on a call: no voice provider or speech pipeline is connected, so the seams between recordings and live speech are unheard',
      "A call's cost record does not yet receive the synthesised-character count (the count is in each run)",
      'DID failures are not detected automatically from provider or carrier events',
      'Outcomes are recorded through the API and not yet tied to a workflow run',
    ],
  },
  {
    id: '4', name: 'Resilience And Concurrency', status: 'in_progress', summary: 'Degrade gracefully instead of failing. Failover rules with hysteresis, provider health, the fallback ladder, telephony failover, concurrency ceilings, inbound entitlements and the funding monitor are built and tested against fakes.',
    criteria: [
      { text: 'Chaos tests cover killing the provider, injecting latency and running the balance to zero. Each produces the expected failover with no dead drop.', state: 'partly', proof: 'fakes',
        note: 'The tests kill a fake voice provider, inject latency and dead air, and run the balance to zero, and each fails over, plays the bridge, replays the interrupted line and ends in the fallback ladder when nothing works. The providers are stand-ins: no real provider has been failed during a live call, and nothing yet plays these lines on a phone call.' },
      { text: 'Reaching a concurrency ceiling triggers queueing or rerouting, and no burst charge appears on the bill.', state: 'partly', proof: 'fakes',
        note: "Outbound dials go to a provider with room or are held back with a retry time; inbound callers beyond a client's channels wait; calls inside the ceiling carry no burst line, tested against the cost records. The ceilings come from the rates entered, and have not been checked against what the real providers count or charge." },
    ], open: [
      'No voice provider is connected to live calls, so voice failover runs on a model of a provider and the bridge and replayed lines are not heard',
      'An outbound dial held back is not queued here: the dialler keeps its list and retries after the time given (a queue would have to keep the customer\'s number)',
      'A caller waiting in the inbound queue hears a hold message; nothing yet starts the workflow when their turn comes',
      'Funding is still not deducted as calls are costed, so the monitor warns from entered balances only',
      'Failures are detected from errors at dial time and from reported samples, not yet from provider webhooks',
      'A failed provider recovers only through probes (`probeProviders` must be scheduled; a telephony provider has no probe yet)',
      'Hanging up a timed-out queued caller on Twilio uses a request written from memory, unchecked against the live service',
    ],
  },
  {
    id: '5', name: 'Journey, QA And Audit', status: 'in_progress', summary: 'Every call can be reconstructed down to the node and the reason. Replay, tickets, call-end classification with a drop alert, turn-by-turn reading, QA scoring, the AI decision audit and approved changes are built and tested against fakes.',
    criteria: [
      { text: 'Any production call can be fully replayed.', state: 'partly', proof: 'fakes',
        note: "A call that carried a workflow is replayed step by step with the reason for each, the transcript with timing, adherence to the workflow, a clickable mood line, the call's own events and any failover; a call with no workflow is replayed from its events. Built from stored records and checked against calls driven through the real code, but no real phone call has yet been through it, and the call's audio is not recorded, so a replay shows what was said, not how it sounded." },
      { text: 'Every escalation produces a ticket with all the required fields.', state: 'met', proof: 'tests',
        note: "A call passed to a person (by the reading of the caller, or by the workflow's own handoff) opens a ticket in the same step, with the reason, the customer's view, the automatic review, council notes, and the impact; the database refuses a ticket with a field missing. Council notes begin as \"not requested\" until the council exists (a later phase), and the automatic review is by rules." },
      { text: 'An unintentional system drop raises an alert within agreed latency.', state: 'partly', proof: 'fakes',
        note: "A call that ends after the workflow failed, or while it was still working, is flagged as a fault when the end is reported, with a Control Tower alert and a ticket; a watchdog flags a drop that never came with an end event once the failure is older than the agreed latency (60 s unless changed). Tested with simulated provider events: who really hung up is judged from the workflow's state, not from anything the providers report, and the watchdog must be run on a schedule." },
    ], open: [
      'No real call has been replayed: no live provider events have reached this code, and the call audio is not recorded',
      'The watchdog (`POST /internal/faults/sweep`) must be run on a schedule by the deployment; nothing calls it automatically',
      'Who ended a call is inferred from the workflow, because what the providers report about who hung up has not been checked against the live services',
      'Mood and intent are read by word lists (English and Bahasa Malaysia, extendable per client); a model for turns the lists cannot read is not connected',
      'QA judgement questions need a model; none is connected, so they are left out of the score and the scorecard says it is incomplete',
      'The council (Phase 6) does not exist, so ticket council notes are empty and changes are not reviewed by it',
      'Changes can be proposed, approved and put live; a change to a live flow made some other way is not stopped from skipping this path',
    ],
  },
  {
    id: '6', name: 'Self-Learning Promotion Loop', status: 'in_progress', summary: "Promote nodes from live TTS to pre-recorded audio based on evidence, never assumption. Logging of every model-written line, clustering by wording and journey context, canonical scripts, council review, automatic promotion with recordings, drift screening with demotion and replay, and the cost change are built and tested against fakes.",
    criteria: [
      { text: 'At least one node is promoted automatically, with an audit trail.', state: 'partly', proof: 'fakes',
        note: "A node whose model-written line recurred past the threshold was drawn up as one script, passed both councils at high confidence, had its fixed words recorded and was promoted with no person involved; every step (distilled, each council's opinion with model and tokens, approved, recorded, promoted) is in the audit trail and the events are never edited. The councils and the recorder are stand-ins in the tests: no real council model or voice provider is connected, so this has not been shown with real reviews or real audio." },
      { text: 'A simulated drift demotes it again, also with an audit trail.', state: 'partly', proof: 'fakes',
        note: "Callers in the test reacted worse to the script than to the live line; the screen found the mood had fallen, demoted the node back to live speech, assembled replays of its worst calls and recorded each step. A change to the node itself demotes it at once. Drift is judged from simulated calls, so the thresholds are untested against real callers." },
      { text: 'The financial assessment shows the cost change for both.', state: 'met', proof: 'tests',
        note: "Promotion and demotion each record the per-use change in live characters and cost at the voice provider's rate in force, the one-off cost of recording, the number of uses to pay it back, and the saving realised while promoted, all in exact money. It prices speech synthesis only; model tokens saved are not priced." },
    ], open: [
      'No real council model, distiller model or voice provider is connected; councils, distilling by a model and recording are exercised with stand-ins, and the rules do the rest',
      'Clustering uses word overlap and a threshold, not embeddings; it has not been tuned on real conversations',
      'The sweep (`POST /internal/learning/sweep`) that finishes approved scripts and screens promoted nodes for drift must be run on a schedule by the deployment',
      'The frequency, similarity, confidence and drift thresholds are conservative defaults and have not been tuned',
      'Drift compares how callers reacted before and after promotion; a change in the caller population over the same period would look like drift',
      'A promoted script is a layer over the workflow, not a part of its version: demoting or promoting changes what an in-flight call says at its next line',
    ],
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
    note: 'The model for a task is configuration (`model_config`), and every AI decision, with its model, tier, tokens and any step up a tier, goes in an append-only record (`ai_decisions`) that the console rolls up. The two AI tasks that exist (a model-written line, and a QA judgement) log tokens and escalate on low confidence; no real model is connected yet, so this is tested with stand-ins.',
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
