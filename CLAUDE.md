# Voice Lab

Provider-agnostic voice orchestration platform. The blueprint is the source of truth for what to build; `BUILD_PLAN.md` sets the order and the exit criteria for each phase.

## Working agreement (standing instructions from the owner)

- Build `BUILD_PLAN.md` phase by phase **without asking to continue**. Stop only for live credentials or a decision only the owner can make. Say what is unverified instead of stopping for it.
- **One PR per phase**, on a branch named `claude/phase-<n>-<name>` (owner-approved; the designated session branch is also allowed). When a phase depends on an unmerged one, branch from it and set the PR's base to that branch; say so in the PR.
- **Before each commit:** run the checks you changed things for and chain them to the commit with `&&`, so a failing check stops the commit.
- **Before each PR:** tests and typecheck green, then an **independent Opus review**: a helper agent on Opus, given the diff and the invariants but not my conclusions, asked for bugs, invariant violations and missing tests. Treat its findings as claims to verify, fix the real ones, and list findings and outcomes in the PR description.
- **The owner merges.** Never merge a PR unless told to in that message.
- Be honest in PR descriptions about what was only tested against fakes.
- **Keep `src/progress.ts` current**: when a phase's state or an exit criterion changes, update it in the same PR. It drives the Control Tower's progress view, and a test ties it to `BUILD_PLAN.md`. Never mark something met without proof, or proven live when it was only tested against fakes.

## Dev Control Tower (how this project is built, for the owner)

The owner watches how Claude Code builds Voice Lab through the **dev Control Tower** (`/control-tower`). It is separate from the product's Control Tower, the operations console in `BUILD_PLAN.md`. "Control Tower" alone means the product console; ask if a request could mean either.

- Hooks in `.claude/settings.json` log each session's activity to `devlog/.spool/`, which git ignores (what was done and what failed, never content, error text or numbers). **Before each commit, run `node scripts/devlog-flush.mjs`** and commit the new files in `devlog/activity/` with the work. Each flush writes new files, so branches never conflict over them.
- **Keep the control board current** (modelled on `skchiew-bot/d3ngineering`): `node scripts/devlog-task.mjs start <id> --title …` when you begin a task, `update` at each milestone (status, progress, attempt, tests, blocker, next step) and `done` when it is finished. Record each build failure, review finding or process mistake as an incident with `node scripts/devlog-task.mjs incident … --lesson L-NNN`. Models, tokens and cost come from the session automatically.
- **Act on stop-loss.** When the hook says `STOP-LOSS TRIGGERED` (consecutive failed test runs, the same command failing again and again, many edits to one file with no passing check in between, too many attempts at a task, or the session's cost budget), stop repeating that approach: record the evidence (`update <id> --blocker …` and an incident), tell the owner in your next message, and continue only with a different approach; if there is none, ask. A `WASTED EFFORT` warning means change approach. Mark a test run you expect to fail (proving a test can fail, lesson L-010) with `DEVLOG_EXPECT_RED=1` in the command. Budgets are in `devlog/control-tower.json`.
- **Every branch is part of the plan.** Name a phase branch `claude/phase-<id>-<name>` with an id from `src/progress.ts`; link any other branch (such as the designated session branch) to the board task whose work it really carries with `node scripts/devlog-task.mjs update <id> --branch <name>`; never create or link a task just to clear a warning. The dev Control Tower reports any other branch as a fork, lists task-only branches for the owner to confirm, and flags merged branches left on GitHub and a default branch that is not `main`. Deleting branches and changing the default branch are the owner's decisions. A merged `claude/` branch is deleted automatically by `.github/workflows/delete-merged-branches.yml`; when the owner asks for branches to be deleted, run that workflow with the GitHub Actions tool (`run_workflow` on `main`, optionally with input `branch`, and `unmerged: yes` only if the owner named an unmerged branch), since `git push --delete` is refused in a cloud session, then confirm with `git ls-remote --heads origin`.
- **Never repeat a lesson.** `devlog/lessons.md` (loaded below) lists every past mistake and its rule. Check new work against it.
- **When you fix a bug, a review finding or a process mistake,** add a lesson or extend one's **Seen** line, with a guard: a test that fails if the mistake comes back. `tests/devlog.test.ts` checks every guard still exists.
- List the lessons a PR adds or extends in its description.

@devlog/lessons.md

## Commands

- `npm test` runs unit and database tests (needs local Postgres; each test file gets a throwaway database). In the cloud container Postgres can be stopped after a restart: `pg_ctlcluster 16 main start`, and if every database test fails with ECONNREFUSED, that is why.
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
- A call has one cost, counted once: a reconciled record replaces the estimate in every total (`campaignCosts` takes the latest per call). Reconciling never draws credits again.
- Workflow definitions are data and are never executed: conditions use the fixed language in `src/workflows/conditions.ts`, and text slots are plain substitution. A version that fails `validateDefinition` can be saved but never deployed.
- Calls to a client's integrations go only through `callIntegration` (`src/workflows/integrations.ts`): https only, every resolved address public (checked at connect time), no redirects, limited size and time. Simulations never call a real system, and a staging run never writes to one.
- Sensitive workflow variables are never spoken, given to a model, sent to an integration, recorded in steps or shown in views, in any workflow of the call (enforced at publish time and again at run time). While a call waits they are held sealed, and they are wiped when it ends or is abandoned. A phone number, in any form or nesting, is never allowed in a call's variables. Look up names in definitions and variables with `own()` (never `in` or `[]`), so inherited names like `constructor` never count.
- A DID that has failed for a contact is never used for that contact again: `did_failures` is append-only, and `chooseDid` runs after `gateOutbound` and before the provider is contacted. A contact is known only by the keyed hash from `contactHash` (`src/store/dnc.ts`); the number is never stored.
- Pre-recorded audio is matched to the exact words (`textHash`), never by name. Only synthesised characters are billable; recordings cost nothing to synthesise. Recordings and the pool are internal only.
- A call is never dropped dead: when every provider has failed, `speakLines` runs the fallback ladder and records a callback request first. Failover is judged by `src/resilience/failover.ts` (pure, with hysteresis); a failed provider is trusted again only after a run of good attempts over a minimum time. Running out of funding fails over at once.
- A provider is never sent calls beyond its concurrency ceiling unless the client agreed to the premium; a call inside the ceiling must carry no burst line. Capacity is decided under one lock (`capacity`) in `placeOutboundCall`.
- A turn from a caller is read for intent and mood, and escalated to a person by rule (`src/journey/tracker.ts`); a sensitive answer is never read or recorded. Every call passed to a person gets a ticket in the same step, with every required field (the database refuses a ticket without them). Tickets, scores, AI decisions, approvals and fault acknowledgements are append-only.
- A line a model wrote is checked before it is spoken (`checkModelLine`) and recorded as used, tidied or turned down. Every model decision logs its model, tier and tokens in `ai_decisions`, and a step up a tier is recorded.
- A node is promoted to a script only on evidence (a cluster past the frequency threshold), after the rule checks and both councils, and only when every fixed phrase has a recording of exactly those words; a script's slots are variables of the workflow and never sensitive. Promotions, their events, the logged turns and the council opinions are append-only; status is the latest event. A promoted node that drifts, or whose definition changes, goes back to live speech and is recorded as demoted with the cost change.
- A case holds the client's reference and a keyed hash of the contact, never the number. A callback is placed within its agreed lateness of its locked time or not at all, only after being claimed, and a dial whose outcome is unknown is never repeated. Quiet hours and contact limits are enforced in `gateOutbound`, so they hold for every dial. A payment is applied from the total reported, never added, so checking twice counts it once. Cases, their events and attempts are append-only (status is on the case row); an aged or exhausted case is not called until a person decides.
- An appointment is booked only under the diary's lock, inside its hours, clear of every other appointment, journey and time off; a group booking lands on one free member. A delay moves later appointments only as far as the officer's travel requires and flags, never overruns, closing. A fee follows the client's policy in exact money and is recorded, not charged. Appointment messages are addressed by the client's reference, never a phone number, and are delivered by the client's own sender; appointment events are append-only.
- A knowledge version's words never change after they are written; a different person from its author publishes it, and one version of an article is published at a time. A policy is data, refuses by default (an action no rule allows, or any doubt, is a no), and changes only after every approval level (at least two), each by a different person who is not the proposer, and is put live by someone other than the proposer; every version and approval is append-only. A line a model writes, and a promoted script, is checked against the policy's banned phrases before it is spoken. A phone number is never put into knowledge.
- A caller passed to a person is put through only to the agent number staff set for that client (never one of our own numbers), showing one of our own numbers as the caller ID, never the caller's; the decision is read from the run's own outcome, and every transfer request is verified by Twilio's signature and names its call. The agent leg is a leg of the caller's call to the client's own staff, not a dial to a contact, so it does not go through `gateOutbound` (confirmed by the owner, 2026-10-10). An agent number must be Malaysian (+60), checked when it is set and again at dial time. The agent leg holds a channel against the provider's concurrency ceiling (decided under the `capacity` lock, taken before the call's row); when the provider is full the callback ladder runs instead. Its cost is a line of the call's one cost record (`leg = 'agent'`) and draws no credits; a call whose agent leg has not been reported waits to be priced, never with a guess. With the whisper on, a dial reached a person only if the agent pressed 1 (recorded), never because the line picked up. When no one takes the call, the caller hangs up before anyone does (before the dial or while it rings), or the call ends with the dial's outcome unknown, the callback request is recorded first and once, then the holding message. The caller's number from Twilio's requests is never stored.
- A change to a live flow is approved level by level by different people, never by the person who proposed it, and is put live only through `deploy`.
- A call pins the workflow versions it can reach when it starts. Deploying or rolling back never changes a call already under way.
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
