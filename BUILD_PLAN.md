# Voice Lab Build Plan

Derived from *Voice Lab Blueprint And Build Plan* (Oct 9, 2026, @skchiew). The blueprint is the source of truth for **what** Voice Lab does. This plan sets the **order** to build it in and what "done" means for each phase. It adds one workstream the blueprint lacks: the **Control Tower**.

Sequence from the blueprint: telephony, voice and metering first, then a minimal workflow skeleton, then stitching. Everything else builds on those.

## Global Requirements (All Phases)

### Model selection and token cost

Token cost is a build requirement, not a Phase 6 detail. Every AI task in every phase picks the smallest model that does the job reliably, and escalates only when needed. The same rules are in `CLAUDE.md` so every Claude Code session follows them.

| Task type | Model | Examples in this plan |
| --- | --- | --- |
| High-volume, per-turn | Haiku 5.5 | Intent and sentiment tagging (Phase 5), turn logging (Phase 6), drift screening (Phase 6), routine QA checks |
| Per-change or per-cluster | Sonnet 5.5 | Script distillation (Phase 6), prompt-to-workflow builder (Phase 2), QA scorecard scoring (Phase 5) |
| Low-volume, high-stakes | Opus 5.5 | Quality and Customer Experience Council review (Phases 3 and 6), approvals and policy changes (Phase 7) |

- Volume decides the tier: the more often a step runs, the smaller its model.
- Escalate on low confidence or when a cheap check flags a problem, and record the escalation in the audit trail.
- Use rules, embeddings and thresholds instead of an LLM wherever they do the job (for example, clustering).
- Cache repeated prompt prefixes, and batch work that isn't in the live call path.
- Model choice per task is configuration, not code.
- Log model, input tokens and output tokens per task. They feed the cost record (Phase 1) and the Control Tower cost panel.
- Prices are not hardcoded; read current pricing before setting the cost model.

**Exit criteria (every phase):** each AI task the phase introduces has a configured model tier, a logged token count and a documented escalation rule.

### Technology stack (proposed)

**Status:** proposed, pending confirmation of hosting region, cloud provider and language (see Open Decisions). The aim is a stack small enough for a non-technical person to install.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere | One language across call service, UI and adapters. Node handles many long-lived WebSocket media streams well. |
| API and call service | Fastify plus WebSockets | Twilio TwiML and Telnyx event webhooks, and media streams. |
| Database | PostgreSQL | Ledgers, rate versions, workflows and the call-event log need strong consistency and an audit trail. Row-level security enforces tenant isolation and the split between the two ledgers. |
| Queues and live state | Redis, with BullMQ for jobs | Concurrency counters, call state, pub/sub for live panels, batch jobs (distillation, QA scoring, usage reconciliation). |
| Control Tower and client portal | React single-page apps (Vite), served by the API | Live panels over WebSocket or server-sent events. Two separate apps over the same API, with separate permissions. Chosen over Next.js so there is still one thing to deploy; revisit if server-side rendering is needed. |
| Recordings and pre-recorded audio | S3-compatible object storage | Stitching audio, per-language recordings, call recordings. |
| Secrets | Provider credentials encrypted at rest with a managed key | Credentials are keyed in through the UI and must never sit in plain text. |
| Provider adapters | Typed adapter interface per provider | Each adapter declares its own parameter set; the UI builds its form from it. A new provider is a new adapter, not a UI change. |
| Model configuration | Config table, per task | Implements the model-selection rule above; a change needs no deploy. |
| Observability | OpenTelemetry (logs, traces, metrics) | Feeds the Control Tower provider-health panel. |
| Deployment | Docker Compose with a guided installer | Fits the "non-technical person can stand it up" principle. Move to a managed container service if load requires it. |
| Tests | Vitest plus a fake-provider simulator | Needed for the Phase 4 chaos tests. |

Design rules:
- **Postgres alone for the event log at first.** A partitioned table is enough for early volume. If call volume grows, move analytics to ClickHouse without changing how events are written.
- **No microservices yet.** One deployable service with clear internal modules (adapters, workflow engine, metering, Control Tower API). Split only when load demands it.
- **TypeScript over Python.** The per-turn AI work is API calls to providers, not local models, so TypeScript costs nothing and keeps one language.

## Phase Overview

| Phase | Name | Depends on | Control Tower slice |
| --- | --- | --- | --- |
| 0 | Foundations | None | Shell, auth, tenant switcher |
| 1 | Telephony, voice and metering | 0 | Live calls, cost per call, provider funding |
| 2 | Workflow skeleton | 1 | Live calls show the active node |
| 3 | Stitching and outbound deliverability | 2 | Stitch ratio, DID health |
| 4 | Resilience and concurrency | 1, 3 | Provider health, failover events, concurrency headroom |
| 5 | Journey, QA and audit | 2 | Sentiment and escalation queue, QA scores |
| 6 | Self-learning promotion loop | 3, 5 | Promotion and demotion feed, drift alerts |
| 7 | Business modules | 2, 5 | Case and appointment health per module |

The Control Tower is built alongside every phase, not after them. Each phase is done only when its slice of the Control Tower is shipped too.

---

## Phase 0: Foundations

Goal: the shared backbone that every later phase plugs into.

- Tenant model with strict isolation: client, campaign or project, users, roles.
- **Provider adapter framework.** Each adapter declares its own parameter set, and the UI renders a form from it. Credentials are stored encrypted, never hardcoded.
- Capability registry per provider: each capability is **native**, **composable** or **unsupported**, following the Puppet-Master principle.
- **Charging-mechanism records.** Each record captures:
  - rate and unit
  - billable components
  - billing increment and minimum charge
  - rounding, concurrency limits and burst premiums
  - separate billing lines
  - an **effective date**, so a rate change adds a new version instead of overwriting the old one
- **Two ledgers, strictly separate.** Provider funding is internal only. Voice Lab credits are visible to clients. Access control enforces the separation; it is not just a matter of which UI shows what.
- Event bus or call-event log that every later component writes to. The Control Tower and replay both read from it.
- Deployment packaging aimed at a non-technical operator: a single install path, guided setup and a health check.

**Status (in progress)**

Built and tested:
- Tenants, projects, users with hashed API tokens, internal and client roles.
- Adapter framework with parameter declarations for Twilio, Telnyx, OpenAI and ElevenLabs, served at `GET /internal/adapters`; structural validation only (live credential checks are Phase 1).
- Capability registry, editable per provider.
- Versioned, append-only charging records with a confirmation record for rates checked against pricing pages.
- Both ledgers, separated by database role and row-level security.
- Partitioned call-event log, audit log and model-config table.
- Encrypted provider credentials (AES-256-GCM); the API never returns them.
- Docker Compose and a setup script with a health check.
- **Admin console** (`/admin/`, React single-page app served by the API): staff sign-in; add a provider from a form built from the adapter declaration; edit capabilities; add and confirm charging versions; record provider funding; add clients, projects, users and credits. Driven end to end in a real browser by `tests/admin-ui.test.ts`. Exit criterion 1 is now met through the UI.

Not built yet:
- Tenant switcher and the Control Tower shell.
- Redis and the job queue (nothing in Phase 0 needs them yet).
- Finer roles and permissions beyond internal admin, tenant admin and tenant user.
- The Docker install path has not been run end to end; its compose file validates, but it needs a real run.

**Exit criteria**
- An operator can add a provider through the UI and enter its parameters and charging mechanism, without a code change.
- A rate change creates a new version, and old records keep their original rate.
- A client user can't read internal-ledger data, and a test proves it.

## Phase 1: Telephony, Voice And Metering

Goal: real calls on real providers, with the true cost of every call known.

- **Twilio adapter.** Credentials are an Account SID plus Auth Token, or an API key SID plus secret. Call control uses TwiML from a TwiML App Voice URL. Numbers are Twilio numbers.
- **Telnyx adapter.** Credentials are an API key (bearer token). Call control goes through a Voice API Application with v2 webhooks and an optional failover webhook. Numbers are provisioned DIDs. Credentials are validated on save using the read-only balance endpoint.
- Twilio credentials are also validated on save.
- Voice providers: OpenAI realtime and ElevenLabs conversational, for STT, LLM and TTS.
- **Per-call cost record.** It captures:
  - telephony leg, STT, LLM, TTS and platform fees
  - total in USD and MYR
  - credits drawn (zero until the rate card is set)
  - margin
  - billed duration after rounding to each provider's billing increment
- A campaign or project tag on every record, so costs roll up per campaign.
- The client credit meter uses the same billing increment as the provider.
- **Do-not-call pre-dial gate**, as a hard check per country. The blueprint lists it under Case Management. It is pulled forward here because no outbound call may be placed without it.
- Reference rates entered as starting data and marked *unconfirmed* until each one is checked against the provider's current pricing page.

**Status (in progress)**

Built and tested. The provider APIs are unreachable from the build environment, so everything below is proven against fakes of their responses, not against the real services:
- **Credential checks on save** for all four adapters. Twilio fetches the account over basic auth (token, or API key pair) and refuses an account that is not active. Telnyx uses the read-only balance endpoint. OpenAI lists models. ElevenLabs fetches the user. A rejection is told apart from an outage; "save without checking" exists for outages, is recorded in the audit log, and the credentials can be checked later, from the console or the API.
- **Billing math** in exact integer arithmetic: increment, rounding (up, nearest, down) and minimum charge, with no floating point.
- **Per-call cost record:** one line per billable component, each pointing at the exact charging version used, so a later rate change cannot alter it. Totals in USD and MYR using the FX rate in force at the time, credits drawn, margin, and the project tag. Re-sending a call returns the stored record and draws no credits twice. A call it cannot price (no rates, no FX rate) is refused, not recorded wrong.
- **Credit meter** mirrors the provider's billing increment. Credits are zero until a rate card exists.
- **FX rates and the client rate card** (versioned, append-only), and a per-campaign cost rollup.
- **Call control for Twilio and Telnyx**, proven against fakes and signed test webhooks, not against the live services:
  - Outbound calls: the do-not-call gate runs first and the provider is never contacted for a blocked number. The caller ID must be one of the client's own numbers on that provider. Our call id rides along (a URL parameter for Twilio, `client_state` for Telnyx), so an event can only match the call it belongs to.
  - Inbound calls: routed to a client by the number dialled (`phone_numbers`); a number nobody owns is rejected and nothing about the caller is recorded.
  - Webhooks are verified by signature and fail closed: Twilio HMAC-SHA1 over the full URL and parameters, which needs the Auth Token (an API key pair cannot verify); Telnyx Ed25519 over `timestamp|body` with a five-minute replay window, which needs the webhook public key. Retried deliveries are recognised and skipped.
  - A call moves forward only (a late event cannot reopen or re-price it), is finished and priced exactly once even when callbacks race, and a pricing failure is recorded and retryable (`POST /internal/calls/:id/cost/retry`) instead of losing the call.
  - Customer numbers exist in memory while a call is set up and are never stored, logged or audited; provider error text is scrubbed of anything number-shaped.
  - Until Phase 2, every answered call plays a short test message and hangs up.
- **Reconciliation** (`POST /internal/calls/:id/reconcile`, `POST /internal/reconcile/run`): a call's estimated cost is compared with the provider's own duration and price, and every figure the provider gave must be within a set tolerance (default 2%, `RECONCILE_TOLERANCE_PCT`; differences under a second or a hundredth of a cent are ignored). A match adds a "reconciled" cost record (no second draw of credits, and the campaign rollup counts each call once); a difference is stored, flagged on the call and logged, and the estimate is left alone. Twilio can be checked automatically; any provider can be checked from figures an operator enters, and the provider's price is required, since a duration alone cannot show the rate was right (Telnyx has no automatic check yet). Two checks of one call take turns, and re-pricing a call can never wipe its reconciled or variance flag. Twilio's price is sometimes not yet published, in which case the answer is "pending", not a guess.
- **Direction-specific rates:** a rate can apply to inbound calls, outbound calls, or both, because providers charge them differently. A version that would charge a call twice (a line for any call plus one for a direction, or the same direction twice) is refused.
- **Reference rates:** the blueprint's research figures can be saved onto a provider in one step, always as unconfirmed, with a billing increment the operator chooses (the research gives none).
- **Console screens** for FX rates, the rate card, our numbers, do-not-call lists (with a dry-run check), and calls with their timeline, cost lines, reconciliation and re-pricing.
- **Do-not-call gate**, failing closed: an unparseable number, or a country with no declared position, is blocked. Supports a national registry per country and each client's own opt-out list. Numbers are stored as keyed hashes. `gateOutbound` logs the decision to the call-event log without the number.

Not built yet:
- **Proof against the live services.** The Twilio and Telnyx request formats, status values and signature schemes were written from the providers' published behaviour, and their docs were not reachable while building, so they have not been checked against the real services. Exit criterion 1 (test calls on both) is not met until someone runs real test calls with live accounts, public URLs and `PUBLIC_BASE_URL` set.
- **Talking to a caller.** The voice providers (OpenAI, ElevenLabs) are not connected to calls, so there is no voicebot yet. Do not point a real number at this: callers hear a test message and the call ends.
- **A known gap in call control:** if the server stops in the instant between storing a Telnyx event and sending its reply command, that command is not re-sent (a retried event is skipped as a duplicate), so a call could sit unanswered.
- **Automatic reconciliation for Telnyx**, and a schedule for the sweep (`POST /internal/reconcile/run` must be called, for example from a cron job). The sweep records each try, tries the longest-waiting call first, skips calls that never connected, and leaves a call for a person after 8 tries. The Twilio call-record fields used (`duration`, `price`, `price_unit`) were written from memory, like the rest of call control, and are unverified against the live service.
- **Feeding usage into the cost record.** The record accepts seconds, characters and tokens; no live call yet supplies them.

**Exit criteria**
- Inbound and outbound test calls work on both Twilio and Telnyx.
- Every test call produces a complete cost record, and the record reconciles with the provider's own usage data within an agreed tolerance.
- An outbound call to a number on the do-not-call list is blocked before it is dialled.

## Phase 2: Workflow Skeleton

Goal: the minimum workflow engine that stitching and modules can hang off.

- Nodes with conditions that route to the next node. When no condition matches, the call ends cleanly. The validator rejects any dangling path.
- Nodes can call APIs or integrations mid-call to read and write values.
- Node types: **fixed**, **hybrid** and **dynamic**. In this phase every node is still spoken by TTS; stitching comes in Phase 3.
- Sub-workflows that collapse into a single expandable node.
- Handoff from one workflow to another, carrying the full context.
- Semantic versioning: an edit inside a node is a minor version, a structural change is a major version. Rollback is supported.
- Promotion from staging to production, with test calls and list-based simulation in staging.
- First template: debt collection, tailored to Malaysia.

*Deferred to later in the phase or after it: the prompt-to-workflow builder. It needs its own credit pricing, and that is never set below the provider's token cost.*

**Exit criteria**
- The debt-collection template runs end to end in staging and then in production.
- Rolling back to the previous version works on a live workflow.
- A workflow with a dangling path can't be published.

## Phase 3: Stitching And Outbound Deliverability

Goal: cut cost without hurting the caller's experience.

- Voice Lab–owned pre-recorded audio is played on the telephony leg.
- **Hybrid nodes** play a pre-recorded frame and fill the slot with live TTS. The seams between the two must sound natural.
- Pre-recordings are kept per language.
- Inbound calls pre-record the anchors (greeting, menu, hold, verification, closing). Outbound calls are mostly pre-recorded.
- The cost record shows pre-recorded segments at zero synthesis cost.
- **DID pool with rotation.** A DID that failed for a contact is permanently locked away from that contact.
- **DID-check node** before every dial. It excludes DIDs in the contact's failure history, then picks an eligible DID from the cheapest provider.
- Outbound analytics:
  - contact rate
  - rejected, wrong number, third party and unreachable outcomes
  - captured best callback times

**Exit criteria**
- The cost difference between a stitched and an unstitched version of the same flow is measured.
- A blind listening check confirms there is no drop in caller experience (the Customer Experience Council signs off).
- The DID-lock rule has been verified against failure history.

## Phase 4: Resilience And Concurrency

Goal: degrade gracefully instead of failing.

- Detection of hard failures (API errors, dropped connections) and soft failures (dead air, latency over a threshold).
- Failover triggers only after N errors or sustained latency over a window. Hysteresis stops it from switching back on the first sign of recovery.
- Running out of provider funding is its own trigger: the call fails over immediately, with no retry.
- The working secondary provider plays the bridge message. The interrupted sentence is then replayed in full, with its slot values.
- State hands over to the secondary: flow position, collected variables and what the caller said.
- **Total failure** falls back to a pre-recorded holding message, a callback offer, a transfer to a human or voicemail. The call is never dropped dead.
- Separate failover for the telephony leg, between Twilio and Telnyx.
- Concurrency ceilings per provider, to avoid burst pricing. When the ceiling is reached, calls queue, reroute to a provider with capacity, or outbound dialling slows down.
- Inbound concurrency is a per-client entitlement. Extra channels are deducted from credits monthly.
- Optional premium overburst for clients at a configurable premium.
- **Funding-health monitor.** It alerts at configurable thresholds before a provider balance reaches zero.

**Exit criteria**
- Chaos tests cover killing the provider, injecting latency and running the balance to zero. Each produces the expected failover with no dead drop.
- Reaching a concurrency ceiling triggers queueing or rerouting, and no burst charge appears on the bill.

## Phase 5: Journey, QA And Audit

Goal: every call can be reconstructed down to the node and the reason.

- Live intent tracking: each moment is classified as an inquiry, complaint or request, plus a topic. The call re-routes when the intent changes.
- Sentiment tracked turn by turn. The call escalates to a human after about 2 failed recovery attempts or on severe sentiment, whichever happens first.
- The call end is recorded to the node, along with who ended it: the customer, or the system. A system drop is flagged loudly as a fault.
- **QA scorecard** on every live call: criteria configurable per client and use case, scored by AI across the full call volume.
- **Audit trail** for every AI decision, recording why it proceeded, was rejected or was reworked.
- **Tickets** for human escalations, with AI reviews, council notes, impact analysis, the customer's view and the reason for escalating.
- Process changes shown as a visual diff. Multi-level approval is configurable, and its history is kept.
- **Replay** shows, per step:
  - the AI's reasoning and the policy it followed
  - transcript and latency
  - workflow adherence
  - a sentiment spline; clicking a point on it jumps to the transcript line and the node
- **Client showcase replay** shows the existing flow and what was detected, then what changed and why, before and after. The stitched audio can be played.
- Financial assessment attached to every proposed change.

**Exit criteria**
- Any production call can be fully replayed.
- Every escalation produces a ticket with all the required fields.
- An unintentional system drop raises an alert within agreed latency.

## Phase 6: Self-Learning Promotion Loop

Goal: promote nodes from live TTS to pre-recorded audio based on evidence, never assumption.

1. A node starts fully dynamic on first use.
2. Every turn is logged with its node, text and intent context.
3. Recurring, semantically similar turns within the same journey context are clustered.
4. When a cluster passes the frequency threshold, the AI distils a canonical script with the slots marked.
5. The Quality Council and Customer Experience Council review the script. A high-confidence pass promotes the node to pre-recorded automatically.
6. Live monitoring watches for drift. On drift, the node is demoted back to live TTS, the script is regenerated and a replay is assembled for people to listen to.

**Exit criteria**
- At least one node is promoted automatically, with an audit trail.
- A simulated drift demotes it again, also with an audit trail.
- The financial assessment shows the cost change for both.

## Phase 7: Business Modules

Goal: self-contained modules that each plug into the shared backbone. Each one can ship on its own.

- **Closed-loop case management**
  - Callbacks locked to a time and placed exactly then. Promise-to-pay tracked through a payment-status integration.
  - Reminders, thanks on payment, handoff to partial payment or to a human, and read-back of what was arranged.
  - Retry rules for missed callbacks. Reachability learning (best time to call, rotation to another channel).
  - Treatment changes after a broken promise. The balance is recalculated after a partial payment.
  - Case ageing forces a decision.
  - Inbound calls recognise an open case and continue it.
  - Quiet hours and limits on how often a contact is called.
- **Appointments**
  - Diaries per individual or per group.
  - Customer comes to a fixed location, or a field officer goes to the customer.
  - Delays cascade to every later appointment.
  - Officers are notified of changes. A cancellation policy can be configured.
  - Notifications by SMS, WhatsApp or email.
- **Knowledge base and policy**
  - The knowledge base informs the bot; policy governs what it may do.
  - Content is scoped per tenant and works across channels.
  - Policy changes get stricter versioning and approval than knowledge changes.

---

## Control Tower Workstream

**What it is:** one internal operations console for Daythree to see and steer the whole platform, across all clients, providers and campaigns. Clients never see it, because it shows provider costs and margin. A separate client portal shows clients their credits and their own call data.

**Principle:** the Control Tower only reads from the event log, the ledgers and the registries. Any action it offers, such as pausing a campaign or draining a provider, goes through the same APIs and approval rules as everything else, and every action is audited.

### Panels

| Panel | Shows | Actions | Ships in |
| --- | --- | --- | --- |
| **Live calls** | Active calls by client, campaign, provider and direction, plus the node each call is currently on | Open replay, listen in, transfer to a human | 1 (node view in 2) |
| **Provider health** | Error rate, latency percentiles, dead-air rate per provider and per telephony leg, and the failover state | Drain a provider, force failover, set as preferred | 4 |
| **Funding** | Provider balances, burn rate, days of runway left, and alerts on low balance | Acknowledge an alert, record a top-up | 1 (alerts in 4) |
| **Concurrency** | Live channels compared with each provider's ceiling and each client's entitlement, queue depth, overburst events | Change the dialling pace, change the ceiling (requires approval) | 4 |
| **Cost and margin** | Cost per call, per campaign and per client, in USD and MYR, against credits drawn. Margin, and how rounding affects it | Drill down to a single cost record | 1 |
| **Stitching** | Share of speech that was pre-recorded and share that was TTS, per workflow, and the savings | Drill down to a node | 3 |
| **Deliverability** | DID health, contact rate and outcome breakdown per pool | Retire a DID | 3 |
| **Journey and QA** | Sentiment trends, the escalation queue, QA score distribution and system-drop faults | Open a ticket, open replay | 5 |
| **Learning loop** | Clusters near the frequency threshold, nodes waiting for council review, promotions, drift demotions | Approve or reject a promotion, force a demotion | 6 |
| **Modules** | Case ageing, broken promises and appointment cascades | Open in the module | 7 |
| **Change log** | Workflow versions, promotions to production, rate-card versions, Control Tower actions | Roll back (requires approval) | 2 onward |

### Alerting

- Low provider balance, at configurable thresholds.
- A failover was triggered, or a provider is flapping.
- A provider is close to its concurrency ceiling or has gone into burst.
- An unintentional system drop. This is always a high-severity alert.
- A margin drop or cost spike on a campaign.
- A spike in QA scores or sentiment, or drift on a promoted node.

Alerts are delivered inside the console first. Later they can also go to email, WhatsApp or Slack, chosen per alert type.

### Control Tower Exit Criteria (Overall)

- An operator can answer these from one screen without opening a provider console:
  - Are calls healthy?
  - Are we funded?
  - Are we making money on campaign X?
  - Is anything about to break?
- Every action taken in the Control Tower appears in the change log, with who did it and why.

---

## Open Decisions

| Decision | Blocks | Owner |
| --- | --- | --- |
| Client rate card (per minute, and per feature) | Credits drawn and margin, from Phase 1 onward | TBD |
| Confirm the proposed technology stack (see Global Requirements): language, plus any changes | Phase 0 | TBD |
| Hosting region (Malaysian data-residency rules for call recordings and debtor data) | Phase 0: where Postgres and storage run | TBD |
| Cloud provider | Phase 0 | TBD |
| How each provider's usage is ingested (per-call API, webhook or invoice) and how long it lags | Accurate cost records in Phase 1 | TBD |
| Failover thresholds: N errors, latency window, hysteresis | Phase 4 | TBD |
| Frequency and confidence thresholds for promotion | Phase 6 | TBD |
| Do-not-call registry sources per country | Outbound in Phase 1 | TBD |
| Who staffs the Quality Council and Customer Experience Council, and what they need to sign off | Phases 3 and 6 | TBD |
| Alert channels and on-call ownership | Control Tower alerting | TBD |

## Risks

- **Usage data from providers arrives late or in different shapes.** The cost record could be estimated at first and then reconciled. Show its state (estimated or reconciled) in the Control Tower.
- **Seams in stitched audio sound unnatural.** The Customer Experience Council's gate in Phase 3 exists to catch this. Stitching ships only behind that gate.
- **Failover flaps between providers.** Hysteresis and chaos tests in Phase 4 address this.
- **Internal cost data leaks to clients.** The two ledgers are separated by access control and tested in Phase 0. The Control Tower is internal only.
- **Rates go stale.** Rates are versioned with an effective date and stay marked *unconfirmed* until they are checked against current provider pricing.
