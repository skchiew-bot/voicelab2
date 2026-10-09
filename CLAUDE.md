# Voice Lab

Provider-agnostic voice orchestration platform. The blueprint is the source of truth for what to build; `BUILD_PLAN.md` sets the order and the exit criteria for each phase.

## Commands

- `npm test` runs unit and database tests (needs local Postgres; each test file gets a throwaway database).
- `npm run typecheck` checks the API and the admin UI. Run both before pushing.
- `npm run build:admin` builds the admin UI (`admin/`, Vite + React) that the API serves at `/admin/`. `tests/admin-ui.test.ts` drives it in Chromium and is skipped where none is installed (`CHROMIUM_PATH`).
- `npm run migrate` applies `migrations/*.sql`. Migrations are append-only: add a new file, never edit an applied one.

## Invariants (do not break)

- Client-facing code runs as the `voicelab_client` database role via `withActor`; provider cost, charging, funding and secrets must stay unreachable from it. `tests/foundations.test.ts` proves this.
- Charging versions, both ledgers, the call-event log and the audit log are append-only (database triggers). A change is a new row.
- Provider secrets are encrypted and never returned by the API, logged or audited.
- Cost records, FX, rate cards and do-not-call lists are internal only; clients see credits drawn and nothing about provider cost or margin.
- Every outbound dial must go through `gateOutbound` (`src/store/dnc.ts`) before the provider is called. The gate fails closed. Phone numbers are never stored, logged or audited in clear.
- Webhooks are verified by signature before anything is read, and fail closed (no key, no verification, no processing). They are idempotent: a retried delivery changes nothing.
- A finished call is priced once. Calls move forward only; a late or duplicate event must not reopen or re-price one.
- Our own numbers (`phone_numbers`) are stored; customers' numbers are not. Scrub provider error text with `redactNumbers` before it is stored, logged or returned.
- Money is exact: use `src/money.ts` (BigInt, 1e-8) and `src/billing.ts`, never floating point. A call that cannot be priced is refused, not recorded with a guess.
- Tests never call real provider APIs. Provider HTTP goes through the injected `fetch`; use `fakeProviderApi` in `tests/helpers.ts`. When a test's setup calls an endpoint, assert it succeeded.

## Model selection (applies to every phase)

Token cost is a build requirement. Pick the smallest model that does the task reliably, and escalate only when needed. This applies to the product's runtime AI calls and to any build or dev work that calls a model.

| Task type | Model |
| --- | --- |
| High-volume, per-turn work: tagging intent or sentiment, logging, routine checks, drift screening | Haiku 5.5 |
| Per-change or per-cluster generation: distilling scripts, drafting workflows, summaries | Sonnet 5.5 |
| Low-volume, high-stakes judgement: council reviews, approvals, policy changes, root-causing hard failures | Opus 5.5 |

Rules:
- **Volume decides the tier.** The more often a step runs, the smaller its model. Strong models see only a small share of traffic.
- **Escalate on low confidence.** Start with the smaller model; call the next tier up only when confidence is low or a cheap check flags a problem. Record every escalation in the audit trail.
- **No LLM where a rule will do.** Clustering uses embeddings and thresholds, and validation uses deterministic checks.
- **Cache repeated context.** Rubrics, slot formats and council instructions go in cached prompt prefixes.
- **Batch anything that isn't live.** Distillation, council review and QA scoring run in batches, not in the call path.
- **Model choice is configuration, not code.** Each task's model lives in config, so it can change without a deploy.
- **Measure.** Log model, input tokens and output tokens per task. These roll into the cost record and the Control Tower.
- Do not hardcode prices. Read current pricing before setting the cost model.
- Never put a model name in commit messages (beyond the required co-author line), PR titles or PR bodies.
