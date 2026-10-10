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
    summary: 'The shared backbone that every later phase plugs into. Built and tested, with a tenant switcher, read-only staff, user management (a new admin needs another admin to approve them) and an install path run end to end, and scheduled jobs that the app runs itself on Postgres.',
    criteria: [
      { text: 'An operator can add a provider through the UI and enter its parameters and charging mechanism, without a code change.', state: 'met', proof: 'tests', note: 'Driven in a real browser.' },
      { text: 'A rate change creates a new version, and old records keep their original rate.', state: 'met', proof: 'tests' },
      { text: "A client user can't read internal-ledger data, and a test proves it.", state: 'met', proof: 'tests' },
    ],
    open: [
      'The install was run end to end only in a cloud sandbox (with the sandbox\'s certificate added to the image build), not on a real host',
      'Client admins and client users can do the same things: the client portal only reads credits and projects so far',
    ],
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
      'The live call voice link is built on Twilio\'s speech relay (ConversationRelay) and tested only against a fake relay: a call with a workflow (an outbound call that names one, or a call to a number set to answer with one) holds the conversation, playing recordings by signed link and speaking the rest; a call without one plays a test message. Its message format comes from Twilio\'s published packages and is unchecked against a live call; Telnyx has no voice link yet',
      'A call the workflow passes to a person (its own handoff or an escalation) is put through to the client\'s agent phone, showing one of our own numbers, with a whisper of the reason and ticket reference after which the agent presses 1 to take the call (so a voicemail is never taken for a person); if no one takes it, or the call ends with the dial\'s outcome unknown, a callback request is recorded and the caller hears the holding message. Tested only against fakes: Twilio\'s transfer requests are taken from its published packages (the dial-ended status values are assumed) and are unchecked against a live call. Staff set the agent number through the API (no console screen yet); the agent\'s time on the call is not yet costed or counted against the provider\'s concurrency ceiling',
      'Twilio\'s per-minute charge for the speech relay is not in the rate card until an operator adds it; the relay speaks in the one language set on the provider',
      'Telnyx automatic reconciliation (the reconciliation sweep now runs every hour as a scheduled job)',
      'Voice usage (characters, tokens) is not yet fed into cost records, including lines the voice link says again when a reconnected line takes a call over (recorded on the call, not yet priced)',
      'When the server running a call\'s start or reply dies, a reconnected line can wait up to 60 to 90 seconds with nothing to say before the caller hears the holding line; there is no interim "one moment" line yet',
    ],
  },
  {
    id: '2', name: 'Workflow Skeleton', status: 'in_progress', summary: "The minimum workflow engine that stitching and modules can hang off. The engine, versions, staging and production, simulation, integrations and the Malaysian debt-collection template are built and tested.",
    criteria: [
      { text: 'The debt-collection template runs end to end in staging and then in production.', state: 'partly', proof: 'tests',
        note: "Runs from the first word to the outcome in staging (simulated) and in production (a scripted caller replying through the API), all tested. No real phone call has run through it yet: the live call voice link (Twilio's speech relay) now carries a call's conversation to the workflow, but it is tested only against a fake relay, and outbound case calls do not yet name a workflow. The wording is a draft for compliance and native-speaker review." },
      { text: 'Rolling back to the previous version works on a live workflow.', state: 'met', proof: 'tests', note: 'Tested with a call in flight: it finishes on the version it started on, and new calls get the version rolled back to.' },
      { text: "A workflow with a dangling path can't be published.", state: 'met', proof: 'tests', note: 'A missing target (including names every object inherits), an unreachable node, or a dependency that is not ready each block publishing; a new version that would break a live caller is refused too.' },
    ],
    open: [
      'Live phone calls hold this conversation through Twilio\'s speech relay, which turns the caller\'s words into text; tested only against a fake relay, with no live call yet',
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
      'Recordings and live speech are sent to a call through Twilio\'s speech relay (recordings by a signed, short-lived link), but only to a fake relay so far, so the seams between them are still unheard',
      "A call's cost record does not yet receive the synthesised-character count (the count is in each run)",
      'DID failures are not detected automatically from provider or carrier events',
      'A workflow records how an outbound call turned out at the end it finishes at, tested only against fakes; it does not yet capture a callback time asked for on the call',
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
      'A failed provider recovers only through probes (`probeProviders` is not a scheduled job yet, because no voice provider is connected to probe; a telephony provider has no probe yet)',
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
      'The frequency, similarity, confidence and drift thresholds are conservative defaults and have not been tuned',
      'Drift compares how callers reacted before and after promotion; a change in the caller population over the same period would look like drift',
      'A promoted script is a layer over the workflow, not a part of its version: promoting or demoting changes what an in-flight call says at its next line',
      'Turns from staging test calls count as evidence and a promoted script is spoken in every environment of the client; evidence is not yet kept apart by environment',
      'Simulations do not use promoted scripts, so the production gate does not exercise what live calls will say; the cluster report is recomputed on each view and will need caching on a busy client',
      'A person can approve a script that someone else asked about, and it need not be a different person from the one who drew it up',
    ],
  },
  {
    id: '7', name: 'Business Modules', status: 'in_progress', summary: "Self-contained modules that each plug into the shared backbone. All three are built and tested against fakes. Closed-loop case management (callbacks locked to a time, promises to pay tracked through a payment system, retries and channel rotation, reachability, ageing, inbound recognition, and quiet hours and contact limits on every dial). Appointments (diaries for an officer or a group, customers coming in or officers visiting, delays that move every later visit, officers told of changes, and a cancellation policy with exact fees). The knowledge base and policy (knowledge that informs the bot, with one reviewer; a policy of what it may do and say, with every approval level, each from a different person).",
    criteria: [], open: [
      'Case management has been tested only against fakes: the lookup of a number to dial at the moment of a call, and the client\'s payment-status system, are stand-ins; no client system is connected',
      'Messages on other channels (WhatsApp, SMS, email) are not sent by the platform: case and appointment messages are queued for the client\'s own sender (`/internal/tenants/:id/case-outbox`, `/internal/tenants/:id/notifications`), and no provider for them exists',
      'The dispatcher, the payment check, the ageing sweep and the appointment reminders run as scheduled jobs (every minute, hourly, daily and every 15 minutes); a callback is placed within its agreed lateness only if the dispatcher runs at least that often, so its interval should stay at a minute',
      'Promises are recorded through the API; a workflow does not yet record one from what a caller says on a call',
      'Quiet hours and contact limits apply to every dial only for a client with a contact policy; a client without one has no limits. The daily and weekly limits are rolling 24 hours and 7 days, not calendar days in the contact\'s zone',
      'It is assumed, not checked against a real system, that the client\'s payment-status integration reports the total paid since the case was opened, as an exact decimal string; a total that goes down is ignored and logged each time it is seen',
      'The keyed hash of every inbound caller\'s number is now kept on the call, whether or not they have a case',
      'A case, contact or officer reference, an address or an article containing a run of eight or more digits is refused because it looks like a phone number, which also refuses some genuine ones (a unit like "10-03-05", a numeric account reference, a helpline written as digits)',
      'Appointments: travel time is supplied by the client, not computed from a map; customers do not book or cancel for themselves; a fee is recorded and told to the customer, never charged; a flagged appointment is not rebooked automatically; daylight saving is untested (the tests use Kuala Lumpur); appointments are not part of a case\'s read-back',
      'Policy is enforced on the words a model writes and a promoted script speaks (banned phrases) and on questions put to `POST /internal/tenants/:id/policy/check`; the text a client writes into a workflow, and actions a workflow takes, are not yet checked against it, and a workflow does not call the check by itself',
      'Knowledge reaches a model that writes a line (ranked by word overlap against the node\'s prompt, not by embeddings); no model is connected, so nothing has shown that it uses what it is given',
      'A policy proposal keeps the approval levels it was made under; levels cannot be changed while a proposal waits (withdraw it first)',
      'Policy conditions compare numbers as ordinary numbers (the workflow condition language), and a numeric limit variable arrives through JSON, so a limit check on a value with more digits than a number holds is not exact; give limit variables as text',
      'A promoted script blocked by the policy is recorded on the step but not as a row in the policy answers, and does not demote the promotion; nothing yet records a model line turned down as a policy answer',
      'Knowledge is ranked against the node\'s prompt, the same snippets every turn, not against what the caller just said',
    ],
  },
  {
    id: 'CT', name: 'Control Tower', status: 'in_progress', summary: 'One internal console to see and steer the whole platform. It shows project progress, what needs attention, live calls, provider health, funding with days left, cost and margin, concurrency, stitching, deliverability, journey and QA, the learning loop and the business modules, and a change log of who changed what and why. Operators can drain, fail over and prefer providers, set the dialling pace and retire caller IDs from it, each with a reason.',
    criteria: [
      { text: 'An operator can answer these from one screen without opening a provider console:', state: 'partly', proof: 'tests', note: 'What needs attention, live calls, provider health, funding with days left at the last week\'s spend, cost and margin, concurrency against ceilings, and the stitching, deliverability, journey, learning and module panels are on one screen; cost by campaign is one click away on the Calls screen. Days left are worked out from the balance staff recorded (calls are not deducted from it), and alerts go by email only once a mail service is connected (none is yet). Tested against fakes; no real provider has been connected.' },
      { text: 'Every action taken in the Control Tower appears in the change log, with who did it and why.', state: 'met', proof: 'tests', note: 'The Control Tower\'s own actions (drain and restore a provider, force or end a failover, prefer a priced telephony provider, set the dialling pace, retire or bring back a caller ID) each require a reason and appear in the change log with who took them and why. Tested against fakes. Changes made on other screens are also in the log; some of those take no reason, and the log says so.' },
    ],
    open: ['Changing a provider\'s concurrency ceiling from the Control Tower (it needs approval; today it is a new rate version on the provider\'s screen)', 'A reason asked for on settings changes made on other screens that take none today', 'Draining applies to new outbound calls and voice routing; inbound calls still arrive at the provider the caller dialled', 'Alerts by email are built and tested against a fake mail service; no real mail service is connected yet, so none are sent (the Control Tower says so). WhatsApp and Slack are not built', 'Calls taken off the recorded funding balance automatically', 'Clusters close to the promotion threshold on the learning panel'],
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
