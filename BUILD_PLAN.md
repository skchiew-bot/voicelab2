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
- A tenant switcher.
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

**Status (in progress)**

Built and tested:
- **The definition and validator:** a workflow is plain JSON (never executed): `speak` nodes (fixed, hybrid or dynamic), `api` calls, `subflow`, `handoff` and `end`, with conditions in a small fixed language. The validator refuses a missing start, an edge to a node that does not exist, a node nothing leads to, a variable that is used but never set, malformed conditions, a fixed node with slots or a hybrid one without, and more. A saved version with problems is kept but can never be published.
- **The engine:** runs a call as a resumable step function over plain data, so it can wait for the caller and continue later. Routing takes the first condition that holds; if none does, the call ends cleanly. Subflows run inside a workflow and return their outcome; a handoff passes the call with every variable and does not come back (to another workflow, or to a person with a reason). A missing variable stops the call before anything wrong is said; a loop is stopped by limits on steps per request, steps per call and integration calls per call. Phone numbers, in any form and however deeply nested, are refused in a call's variables and in what an integration returns.
- **Understanding replies:** by phrase rules, whole words only, and a match inside a longer phrase of another intent is ignored, so "tidak boleh" (cannot) is not read as "boleh" (can). Several intents is "ambiguous", none is "unknown".
- **Versions:** an edit inside a node is a minor version (1.0 to 1.1); a change to where the call can go (nodes, transitions, conditions, targets) is major (1.1 to 2.0). Versions are immutable, and two saves at once get different numbers.
- **Staging, production and rollback:** a version must be valid, every workflow it hands over to must be live in the same environment and receive every variable it needs, and subflows may not loop. Production also needs the version live in staging and a clean list-based simulation of that exact version, in which every scenario states the outcome it expects (none expecting a failure) and every workflow it reaches is, in production, the version that was simulated. A new version of a workflow is refused if a workflow already live in that environment would break on it, and the same goes for a rollback. A rollback goes back one version at a time, however often it is used. A call pins the versions it can reach when it starts, so a deploy or rollback never changes one already under way. A reply claims its turn before anything runs, so two replies at once cannot both act (or both write to an integration); a reply can say which question it answers.
- **List-based simulation:** many scripted callers through one version, judged against what each should do; integrations answer only from the scenario, so a simulation never touches a real system. Every scenario is stored as a run with its steps, ready for replay.
- **Integrations:** a client's own system can be called mid-call. The address must be https with a real hostname; the connection refuses any hostname that resolves to a private, loopback, link-local or metadata address (checked at connect time, so a name that later points inward is refused too); redirects are never followed; replies are size- and time-limited. Values go into the path URL-encoded. The key is encrypted and never returned. A staging test call reads but never writes.
- **Sensitive variables:** marked in the workflow, they are never spoken, given to a model, or sent to an integration, in any workflow of the call (checked before publishing and again while the call runs). They are never recorded in steps or shown in views. A sensitive answer is used to route the call and then forgotten. Values supplied at the start are held sealed (encrypted, bound to the call) while the call waits, and wiped when it ends; a call left waiting is ended and wiped by a sweep (`POST /internal/workflow-runs/sweep`, which must be scheduled by whoever runs the deployment: nothing calls it automatically yet).
- **The Malaysian debt-collection template** (English and Bahasa Malaysia): greeting, identity check on the last four digits of the identity card number, balance, then a promise to pay, a payment plan, or a person.
- **Console:** a Workflows list with template creation, and a workflow page with versions, publish and rollback buttons, a JSON editor with a problem check, an outline, simulation, and a test call.

Not built yet:
- **A real phone call through a workflow.** No speech recognition or voice provider is connected, so the engine takes the caller's words as text and live calls cannot yet hold a conversation. This is why the first exit criterion is only partly met.
- **The prompt-to-workflow builder** (deferred above) and a **visual canvas**.
- **A model for replies the phrase rules cannot match.** The template's wording is a draft: it needs review by whoever is responsible for compliance, and the Bahasa Malaysia by a native speaker, before real use.

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

**Status (in progress)**

Built and tested (against fakes; no audio has been played on a real call):
- **Pre-recorded audio:** a client's recordings are stored per language and found by their exact words (not by name), so what is played is always what the workflow says. Only fixed words are recorded: a new take is a new version, and the old one is kept. The upload refuses a file whose first bytes are not the audio type it claims, and anything over 5 MB. The console has a Recordings screen (upload, list, play).
- **Stitching plan:** every line a call speaks is planned as recorded and live parts. A fixed line is played whole if recorded. A hybrid line plays the recorded frame and speaks only the slot, and neighbouring live parts are joined into one request so the voice reads them as one phrase. A model-written line is always live. Sensitive variables are still refused. Each spoken line records how many characters are synthesised and how many played from a recording, in the call's steps and its totals; the count is by character, not byte.
- **Measuring the saving:** the same scripted callers are played with and without the recordings, and the difference in synthesised characters is priced exactly at the voice provider's per-character rate. It also lists the fixed words still worth recording.
- **DID pool and DID check:** before every dial (after the do-not-call gate, so a blocked number uses none), the check excludes any DID that has ever failed for this contact, picks the cheapest provider's numbers (a provider with no captured rate comes last), and uses the least recently used. If every number is locked for the contact, or the client has none, the call is refused and no provider is contacted; such calls are not counted as the provider failing. A named caller ID gets the same check. A failure is recorded against a call, locks that DID from that contact for good (rows cannot change), and the contact is known only by a keyed hash, so no customer number is kept.
- **Outbound analytics:** attempts, contact rate and answer rate, who rejected, wrong numbers, third parties, no answer and unreachable, answered calls not yet classified (shown, not guessed), and the callback times people asked for, in their own time zone.

Not built or not proven:
- **Playing audio.** No voice provider or speech pipeline is connected to calls, so nothing plays a recording on the telephony leg. This phase decides what would be played and counts it. Whether the seams between a recording and live speech sound natural cannot be tested without people listening.
- **Call cost records do not yet receive the synthesised-character count.** The count is in each run and the saving is measured from it, but a real call's cost record has no voice usage until a voice provider is connected to calls.
- **DID failures are recorded by an operator or another system through the API.** Nothing yet detects a spam label or carrier block from provider events, because the exact signals each provider sends have not been checked against the live services.
- **Outcomes are recorded through the API** and are not yet tied to the end outcome of a workflow run, since a call does not yet carry a workflow.
- **The blind listening check and Customer Experience Council sign-off** need people.

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

**Status (in progress)**

Built and tested against fakes (no real provider has failed during a live call):
- **Failover rules:** a provider is judged failed after N errors inside a window, N dead-air silences, or latency whose typical (median) value is over a threshold for enough replies; one bad reply never does it. A failed provider is trusted again only after a run of good attempts over a minimum time, and only attempts since it last changed state count, so it does not flip back on the first sign of life. Out of funding fails over at once and is not retried; a topped-up provider goes on probation. Every threshold is configurable (`resilience_policy`) and every switch is logged and shown in the console.
- **Voice failover with handover:** a call tries its voice providers in the client's order. When one is failed over, the next plays a bridge message, is told where the flow is, what was collected and what each side said (never a sensitive value), and the interrupted line is replayed in full with its slot values. A provider that is still trusted is simply tried again. A call already moved stays on the secondary rather than bouncing back.
- **Total failure:** a holding message, then a person if one is available, else a callback offer, else voicemail; a callback request is always recorded first unless the call went to a person, so the call is never left in silence, and a failing telephony leg cannot stop the record being made.
- **Telephony failover:** a failed, unfunded or full provider is passed over by the DID check; a provider that fails to place a call is counted against it and the next provider is tried; with every provider unavailable the dial is refused plainly and no provider is contacted. Refusals are not counted as the provider failing.
- **Concurrency ceilings:** taken from the rates' concurrency limit. A dial goes to the cheapest provider with room; if every provider is full it is held back with a retry time (nothing placed, no customer number kept), unless the client has agreed an overburst premium, in which case the call is marked, carries the provider's burst multiplier and the client's credits are multiplied by the agreed premium. A call within the ceiling carries no burst line. Dials arriving together cannot take the same last channel.
- **Inbound entitlement:** a client's simultaneous inbound channels (plus extra channels). Beyond them a call waits (hold message, never hung up on), the longest-waiting call moves up when a channel frees, a caller who gives up is recorded as abandoned (the provider's time is costed, no credits drawn), and a caller who waits too long is hung up on and given a callback request. A caller who is served after waiting is billed credits only from when they were served, and a caller on hold counts against the provider's ceiling. A client with no entitlement set is not limited. Extra channels are charged to credits monthly, once per month.
- **Funding-health monitor:** alert levels per provider and currency (warn and critical, chosen by an operator) feed the Control Tower; an empty balance fails the provider over.
- **Console:** a Resilience screen (provider health and why, capacity, funding and alert levels, the failover rules, recent failovers). The Control Tower raises alerts for failed or unfunded providers, low funding, queued callers and held-back dials.

Not built or not proven:
- **No voice provider is connected to live calls**, so voice failover is exercised through a model of a provider, and the bridge and replay are not heard.
- **An outbound dial held back is not queued here:** keeping a queue would mean keeping the customer's number. The dialler retries after the time it is given.
- **A queued inbound caller hears a hold message;** nothing yet starts the workflow when their turn comes.
- **Funding is not deducted as calls are costed**, so the monitor works from entered balances.
- **Failures come from errors at dial time and reported samples,** not yet from provider webhooks or measured dead air on a live call.
- **Nothing sends a failed provider traffic, so recovery needs probes.** `probeProviders` tries failed voice providers and must be run on a schedule by the deployment; a failed telephony provider has no probe yet and recovers only when samples are reported through the API. A recovered provider must show a run of good attempts spanning the minimum time.
- **The held-back dials and the orphan events:** a dial held back for capacity leaves its gate and DID-check events in the event log under an id that never becomes a call.
- **Hanging up a timed-out queued caller** uses a Twilio call-update request written from memory and unchecked against the live service.
- Per-client voice routes, fallback plans and entitlements are set through the API; the console shows the result but does not edit them yet.

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

**Status (in progress)**

Built and tested against fakes (no real call has been through it):
- **Reading each turn:** the kind of moment (inquiry, complaint, request), a topic, and sentiment, by word lists in English and Bahasa Malaysia that a client can add to. The call re-routes when the intent changes (`intentRoutes` in a workflow), and escalates to a person after about two failed recoveries in a row (a turn not understood, or the caller upset) or on severe sentiment, whichever is first. A sensitive answer is never read. Escalating needs no model.
- **How a call ended:** recorded to the node, and by whom: the customer (hung up while the workflow waited), or the system. A system drop (the workflow failed or was still working when the call ended, or the provider reported a failure after answer) is flagged on the call, alerts in the Control Tower straight away until someone has looked, and opens a ticket. A watchdog flags a drop that came with no end event once the failure is older than the agreed latency.
- **Tickets** for every call passed to a person and every dropped call, each with the reason, the customer's view, the automatic review, council notes and the impact; they are never edited, and what happens to one is kept as events.
- **Replay** of a call: every step with its reason (the node's script, the words that decided an intent, the rule that chose the next step, a model's account of a line it wrote), the transcript with how long each step took, whether the call kept to its workflow, a mood line whose points lead to the transcript line and the step, the call's own events and any failover.
- **QA scorecard:** criteria per client and use case (each version kept), rules for what can be decided by rules, a model only for a question of judgement (the configured tier first, one tier up when unsure), scored in batches after the call, with tokens recorded.
- **Audit trail of AI decisions:** every model-written line is checked and recorded as used, tidied or turned down with the reason; every QA judgement and step up a tier is recorded with model, tier and tokens. A line a model wrote is never spoken if it is empty, has an unfilled slot, runs on, or contains something that looks like a phone number.
- **Changes:** a proposed change shows what differs (a visual diff), carries a financial assessment worked out by playing scripted callers through both versions, and needs the configured levels of approval, each by a different person who did not propose it; the history is kept, and applying goes through the usual deploy gates. A **showcase** tells the client the flow now, what was detected in it, what changes and why, the flow after, and plays the recorded phrases.

Not built or not proven:
- **No real call has been replayed.** Provider events are simulated, and call audio is not recorded.
- **Who hung up** is inferred from where the workflow was, because what the providers report has not been checked against the live services.
- **The watchdog must be scheduled** by the deployment.
- **A model for turns the word lists cannot read, and for QA judgement, is not connected:** those parts are tested with stand-ins and otherwise left out (the scorecard says when it is incomplete).
- **The council** is a later phase: ticket council notes begin as "not requested".
- The financial assessment counts speech spoken live, lines and steps, and escalations in the rehearsal; call length and telephony cost are not estimated.

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

**Status (in progress)**

Built and tested against fakes (no real call, council model or voice provider has been involved):
- **Every dynamic line is logged** with its node, the journey context it was said in (the kind and topic of the caller's last turn), and the values of the call's own variables put back as slots. Simulations are not evidence; a sensitive value can never be a slot.
- **Clustering** groups lines that say the same thing within one node and context, by word overlap and a threshold (no model). A cluster past the frequency threshold gets one canonical script with its slots marked: its medoid by rule, or a distiller model's version (the configured tier first, a stronger one when unsure, recorded). A script must pass rule checks first: it is a speakable line, every slot is a variable of the workflow and none is sensitive, and enough of it is fixed words to be worth recording.
- **The Quality Council and the Customer Experience Council** each review the script (the configured tier, with tokens and any concerns in the audit trail). Both passing with high confidence approves it automatically; either clearly failing turns it down; anything else waits for a person in the Learning screen.
- **Promotion** is complete only when every fixed phrase has a recording of exactly those words (found by the words, as in Phase 3). The recorder makes missing ones; without one the script stays approved and is still spoken live until audio is added. A promoted node plays its script, stitched like any other line, and the model is not asked.
- **Drift screening** compares callers' reactions (mood, being understood, escalating) after promotion with the live line before it, by rule. A fall past the thresholds, or a change to the node's own definition, demotes the node to live speech, assembles replays of its worst calls, and starts again from fresh live turns only. A force-demote is available to a person.
- **The cost change** for promotion and demotion is recorded in exact money at the voice provider's rate: per use, the one-off recording, the pay-back, and what was saved while promoted.

Not built or not proven:
- **No real council, distiller or voice provider is connected.** Reviews, distilling by a model and recording are exercised with stand-ins.
- Clustering is by word overlap, not embeddings, and every threshold is an untuned default.
- The sweep that finishes approved scripts and screens for drift must be scheduled by the deployment.
- Drift cannot tell a worse script from a change in who is calling.
- Evidence is not yet kept apart by environment (staging test calls count), simulations do not use promoted scripts, and a script change reaches a call already under way at its next line.

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
**Status (in progress)**

Closed-loop case management is built and tested against fakes (no real call, number lookup or payment system has been involved):
- **Cases** are known by the client's own reference and a keyed hash of the number; the number is used once to recognise the person and is not kept.
- **Callbacks** are locked to a time, refused inside the contact's quiet hours, and placed within the agreed lateness of exactly that time or not at all (a late one is missed and retried by the rules). Each is claimed before it is dialled, a dial whose outcome is unknown is never repeated, and every dial still goes through the do-not-call gate and the DID check.
- **Promises to pay** are tracked through the client's payment-status integration, which reports a total paid (an exact decimal string): a kept promise is thanked once and the balance recalculated; a part payment recalculates the balance and passes the case to a plan or a person; a broken promise makes the treatment one step firmer and schedules the next call. Checking twice never counts a payment twice.
- **Reminders** before a promise falls due; **thanks** on payment; **read-back** of what was arranged, built from the case's own records.
- **Retries** by a backoff list; after enough failures in a row the next try is on another channel (queued for the client's own sender); after the retry limit the case waits for a person's decision. **Reachability** is learned from each attempt by the contact's local hour.
- **Case ageing** stops an old case being called until a person decides to carry on, escalate or close it.
- **Inbound calls** from someone with an open case are recognised by the keyed hash of their number and carry the case's variables into the workflow.
- **Quiet hours and limits on how often a contact is called** (per day, per week, minimum gap) are enforced by the dial gate on every outbound call for a client that sets a contact policy.

Not built or not proven:
- No client number lookup or payment system is connected; messages on other channels are queued, not sent.
- The dispatcher, payment check and ageing sweep must be scheduled by the deployment.
- A workflow does not yet record a promise from what a caller says.
- All three modules (cases, appointments, knowledge base and policy) are built; see the status blocks above.

- **Appointments**
  - Diaries per individual or per group.
  - Customer comes to a fixed location, or a field officer goes to the customer.
  - Delays cascade to every later appointment.
  - Officers are notified of changes. A cancellation policy can be configured.
  - Notifications by SMS, WhatsApp or email.
**Appointments status (in progress)** Built and tested against fakes:
- **Diaries** per officer or per group (a group booking goes to the least busy free member), with weekly hours and time off; **locations** for customers who come in, and an address for an officer who goes to the customer, with the journey time counted so two visits cannot be booked closer than the officer can travel.
- **Booking** is conflict-free under a lock per diary, inside the diary's hours, and never in the past.
- **A delay** moves the visit and every later one that day by only as much as the officer's travel requires; one that would end after closing is flagged for a new time. Each customer affected, and the officer, is told.
- **A cancellation policy** per client: free until some hours before, then a late fee for a customer's own cancellation or late move, and a no-show fee; exact decimal money. A fee is recorded and told to the customer, never charged.
- **Messages** to customers and officers by the channel each prefers, addressed by the client's reference (never a phone number), written to an outbox that the client's own sender delivers and marks; reminders once, before the appointment.

Not built: no SMS, WhatsApp or email provider (messages are queued, not sent); travel time is supplied, not computed; customers do not book for themselves; a fee is not charged.

- **Knowledge base and policy**
  - The knowledge base informs the bot; policy governs what it may do.
  - Content is scoped per tenant and works across channels.
  - Policy changes get stricter versioning and approval than knowledge changes.

**Knowledge base and policy status (in progress)** Built and tested against fakes:
- **Knowledge** is scoped to one client and written once for every channel: each article has full text and an optional spoken short form (else one is derived, with no web address). A version is written as a draft, and a different person publishes it, which retires the one it replaces; every version is kept and what it said never changes. Search is by word overlap, in the language asked for (else English), in the form for the channel. A phone number is refused.
- **Policy** is data: action rules that allow or deny what the bot may do (under a condition, or up to an exact-decimal limit) and phrases it may never say. The default is to refuse: an action no rule allows is not allowed, and a doubt denies. Every answer is kept (without the call's variables).
- **A policy change** needs at least two approval levels, each decided in order by a different person who is not the proposer, and then someone other than the proposer puts it live; the version moves to a new major number when what is allowed or forbidden changes and a minor one when only a message does, with the difference listed in words. Going back to an older policy is a new proposal with the same approvals. One proposal at a time.
- **The call engine** holds every line a model writes and every promoted script to the policy in force (a banned phrase turns the line down, with the rule named, and the written fallback is used), tells the model what it must never say, and gives it the published knowledge that matches the node's prompt.

Not built: the policy does not yet check the text a client writes into a workflow or the actions a workflow takes, and a workflow does not call the policy check itself; ranking is by word overlap, not embeddings; no model is connected, so nothing shows that it uses the knowledge it is given.

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

### Control Tower status (version 1)

The console now opens on the Control Tower (`#/tower`, `GET /internal/control-tower`, `GET /internal/progress`):
- **Needs attention:** alerts derived from live state, each linking to where it is fixed: no MYR rate or client rate card; no public address for webhooks; call events a provider cannot verify (no Twilio Auth Token or Telnyx public key); credentials not checked; no rates in force, or rates not confirmed; no do-not-call position declared; calls that could not be priced, finished calls never priced, or that differ from the provider; calls stuck dialling or in progress for too long (provider events probably not arriving); credentials that cannot be decrypted; a provider failing at least half of its last 24 hours of finished calls (once it has at least five); a recorded funding balance that has run out on an active provider. Calls that never connected (a refused dial, a blocked number) have nothing to price and are never counted as pricing failures.
- **Project progress:** every phase with its status, exit criteria (met, partly or not met, and how each was proven: tested, tested against fakes, or proven live), what is still open, and the open decisions. The data is `src/progress.ts`, maintained by hand, and a test ties it to this plan's phase names, exit-criteria text (including the Control Tower's and the one that applies to every phase) and decisions table so the two cannot drift. A criterion can only be marked proven live with a written "Live evidence:" note.
- **Live calls, provider health, funding and cost and margin** (last 24 hours and 7 days, each call counted once).

- **Panels** (`GET /internal/control-tower/panels`): days of funding left at the last 7 days' spend (from the recorded balance); concurrency against each provider's ceiling and each client's channels; stitching (share of speech played from recordings, per workflow); deliverability (the Outbound screen's own counts: finished dials, answer and contact rates, calls with no outcome yet; caller IDs in use and locked); journey and QA (score bands, escalations, unlooked-at drops, daily sentiment); the learning loop; and cases and appointments. Each panel is worked out on its own, so one that fails does not hide the rest.
- **Change log** (`#/change-log`, `GET /internal/change-log`): every change made to the platform, newest first, with who made it and the reason given, read from the record the change made. Day-to-day activity (calls placed, workflows run) is kept apart.

- **Actions** (`POST /internal/control-tower/actions`, the "Take action" card): drain and restore a provider (no new outbound calls or voice routing; calls under way finish), force a failover (it recovers through the normal hysteresis), prefer a telephony provider in the caller-ID pool, set the dialling pace (dials a minute, held back like a full provider), and retire or bring back a caller ID. Each requires a reason and appears in the change log; a drained provider is an alert until it is restored.

Not built yet: changing a concurrency ceiling from the Control Tower (needs approval), a reason asked for on settings changes that take none, alerts by email, WhatsApp or Slack, and calls taken off the recorded funding balance automatically.

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
| Hosting region (Malaysian data-residency rules for call recordings and debtor data) | Phase 0: where Postgres and storage run | Owner, 2026-10-10: a Malaysian region, so recordings and debtor data stay in the country |
| Cloud provider | Phase 0 | TBD |
| How each provider's usage is ingested (per-call API, webhook or invoice) and how long it lags | Accurate cost records in Phase 1 | TBD |
| Failover thresholds: N errors, latency window, hysteresis | Phase 4 | TBD |
| Frequency and confidence thresholds for promotion | Phase 6 | TBD |
| Do-not-call registry sources per country | Outbound in Phase 1 | TBD |
| Who staffs the Quality Council and Customer Experience Council, and what they need to sign off | Phases 3 and 6 | TBD |
| Alert channels and on-call ownership | Control Tower alerting | Owner, 2026-10-10: email first; on-call ownership still TBD |

## Risks

- **Usage data from providers arrives late or in different shapes.** The cost record could be estimated at first and then reconciled. Show its state (estimated or reconciled) in the Control Tower.
- **Seams in stitched audio sound unnatural.** The Customer Experience Council's gate in Phase 3 exists to catch this. Stitching ships only behind that gate.
- **Failover flaps between providers.** Hysteresis and chaos tests in Phase 4 address this.
- **Internal cost data leaks to clients.** The two ledgers are separated by access control and tested in Phase 0. The Control Tower is internal only.
- **Rates go stale.** Rates are versioned with an effective date and stay marked *unconfirmed* until they are checked against current provider pricing.
