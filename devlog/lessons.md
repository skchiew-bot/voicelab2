# Lessons register

Mistakes made while building Voice Lab, and what stops each one coming back. Every Claude Code session loads this file (imported from `CLAUDE.md`). Read it before building. When you fix a bug, a review finding or a process mistake, add a lesson here or extend an existing one.

Format, checked by `tests/devlog.test.ts`:
- A heading `### L-NNN: <the rule, as an instruction>`.
- **Seen:** where it happened, with PR links. Add to this line when it happens again.
- **Rule:** what to do instead.
- **Guards:** one or more lines `` `path` › "exact text" ``. The text must appear in that file, usually a test title. The test fails if a guard's file or text is removed, so a lesson cannot quietly lose its protection.

### L-001: Check-then-act needs a lock or an atomic claim
- **Seen:** 6 times. Racing final callbacks ([#5](https://github.com/skchiew-bot/voicelab2/pull/5)); two reconciliation checks at once ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)); two replies both firing an integration write ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)); the dial retry bypassing the capacity lock, and inbound capacity decided without it ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)); concurrent rate changes (Phase 0).
- **Rule:** Any "read state, decide, write" path that two requests can reach at once takes a lock (`pg_advisory_xact_lock`, `SELECT … FOR UPDATE`) or claims the work atomically, and re-checks inside the lock. Write the simultaneous-requests test first.
- **Guards:**
  - `tests/telephony.test.ts` › "survives the same final callback arriving three times at once"
  - `tests/costs.test.ts` › "serialises concurrent deliveries of the same call"
  - `tests/workflow-store-hardening.test.ts` › "two simultaneous replies cannot both reach the next step"
  - `tests/concurrency.test.ts` › "never exceeds the ceiling when dials arrive at the same moment"
  - `tests/concurrency.test.ts` › "counts a caller on hold against the provider"

### L-002: Never repeat an action whose outcome is unknown
- **Seen:** The dial retry re-dialled after a timeout, risking two calls to one person ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)).
- **Rule:** Retry only after a definite refusal. After a timeout or an unreadable reply, the first attempt may have taken effect: record it as unknown, never retry it automatically.
- **Guards:**
  - `tests/concurrency.test.ts` › "does not dial again after a timeout or an unreadable reply"

### L-003: Look up data-defined names as own properties only
- **Seen:** Workflow names such as `constructor`, `toString` and `__proto__` passed validation, rendering, conditions and reply paths ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)).
- **Rule:** Never use `in` or `obj[name]` on names that come from data. Use `own()`, and reject reserved names.
- **Guards:**
  - `tests/workflow-hardening.test.ts` › "reserved names cannot be used for nodes, variables, captures or stored values"
  - `tests/workflow-hardening.test.ts` › "a missing variable named like an inherited property is still missing"
  - `tests/workflow-hardening.test.ts` › "does not reach inherited properties"

### L-004: Money never passes through a JavaScript number, including on screen
- **Seen:** 2 times. The funding monitor compared balances as floats ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)). The console still showed balances and credits with `Number(…).toLocaleString()` on three screens, found by the dev Control Tower check on 2026-10-09.
- **Rule:** Amounts stay decimal strings or BigInt (`src/money.ts`). In the console, format them with `fmtDecimal` from `admin/src/ui.tsx`, never `Number()` or `parseFloat()`.
- **Guards:**
  - `tests/billing.test.ts` › "has no floating point drift"
  - `tests/devlog.test.ts` › "keeps money out of floating point in the console"

### L-005: Something that never happened gets no status as if it had
- **Seen:** 3 times. A refused dial was stamped "could not be priced", giving a permanent false alert ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). The reconciliation sweep retried calls that never connected ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)). A DID failure could be recorded against a call that never went out ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)).
- **Rule:** Give "never started" its own state (such as `not_applicable`) and keep it out of failure counts, alerts and retries.
- **Guards:**
  - `tests/phase3.test.ts` › "will not lock a DID because of a call that never went out"
  - `tests/phase3.test.ts` › "does not count a refused dial as the provider failing"
  - `tests/reconcile.test.ts` › "skips calls that never connected"

### L-006: One bad record must not take a whole feature down
- **Seen:** 3 times. One unreadable secret returned a 500 for the whole Control Tower ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). One provider priced in a currency with no exchange rate made every pooled dial fail ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)). A very large number gave a 500 instead of a 400 ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)).
- **Rule:** Handle the bad item where it is: report it as an alert, rank it last, or refuse that input with a 4xx. Keep everything else working.
- **Guards:**
  - `tests/control-tower.test.ts` › "is reported as an alert and does not take the whole Control Tower down"
  - `tests/phase3.test.ts` › "ranks a provider priced in a currency with no exchange rate last instead of failing every dial"
  - `tests/reconcile.test.ts` › "are refused with a clear error, not a server error"

### L-007: Bill only for what was served
- **Seen:** A caller who hung up in the queue was charged credits, and a served caller was billed for their time on hold. A promoted caller lost their agreed premium ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)).
- **Rule:** Credits start when service starts. Provider time is still costed internally. Carry agreed terms through every state change.
- **Guards:**
  - `tests/concurrency.test.ts` › "costs the provider time of a caller who gave up in the queue, and draws no credits for it"
  - `tests/concurrency.test.ts` › "bills a caller who waited and was then served only from the moment they were served"
  - `tests/concurrency.test.ts` › "keeps the agreed premium when a waiting caller is promoted beyond the channels"

### L-008: Key a rule on the real-world thing, not the database row
- **Seen:** The DID lock was keyed by row, so the same number registered at a second provider could be shown again to a contact it had failed for ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)).
- **Rule:** Ask what the person or provider actually sees (the number, the contact), and key on that.
- **Guards:**
  - `tests/phase3.test.ts` › "locks the caller ID the contact sees, even when the same number is registered at two providers"

### L-009: A privacy rule must hold across every boundary
- **Seen:** A child workflow could speak or send a parent's sensitive value. Phone numbers nested in values, or written in local form, got through ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)).
- **Rule:** Enforce sensitivity and number rules across workflows, nesting levels and every input path (start variables, integration replies), both at publish time and at run time.
- **Guards:**
  - `tests/workflow-hardening.test.ts` › "a parent's sensitive variable cannot be spoken by the workflow it hands over to"
  - `tests/workflow-hardening.test.ts` › "are refused in the starting record, however deep, and in the local form"
  - `tests/workflow-hardening.test.ts` › "are refused in what an integration returns, nested or not"

### L-010: A test that cannot fail proves nothing
- **Seen:** The Control Tower drift test passed with wrong data ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). The Phase 2 production gate accepted scenarios that asserted nothing ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)).
- **Rule:** Before trusting a new test, break the code it protects and watch the test fail. Match exactly, not loosely.
- **Guards:**
  - `tests/control-tower.test.ts` › "matches the plan's Control Tower criteria exactly"

### L-011: Show old data as old
- **Seen:** A failed Control Tower refresh left stale numbers looking current, and a slow older request could overwrite a newer one ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)).
- **Rule:** Every live screen shows when its data is from, says so when an update fails, and lets the newest request win.
- **Guards:**
  - `tests/admin-ui.test.ts` › "says so when a refresh fails, instead of showing old numbers as current"

### L-012: One blip is not a failure, and one good sign is not a recovery
- **Seen:** One error on the bridge message dropped a healthy provider. Recovery time was counted from the failure, not across the run of good attempts ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)).
- **Rule:** Judge health over a window, with hysteresis in both directions.
- **Guards:**
  - `tests/resilience.test.ts` › "tries the bridge again on a provider that is still trusted, instead of giving the call up after one blip"
  - `tests/failover.test.ts` › "does not switch back on the first sign of recovery"
  - `tests/failover.test.ts` › "only what happened since counts"

### L-013: Start from the latest main before reporting or building
- **Seen:** A session branch was cut from a commit before PRs #5–#10 merged. A Control Tower status report was then given against that stale code and reported built features as missing (session on 2026-10-09).
- **Rule:** At session start, check how far the branch is behind `origin/main`. If it is behind, bring `main` in before saying anything about the state of the project.
- **Guards:**
  - `.claude/hooks/devlog.mjs` › "commits behind origin/main"

### L-014: When a request could mean two things, ask which
- **Seen:** "Control Tower" names both the product's operations console (`BUILD_PLAN.md`) and the owner's dashboard for monitoring development. A request for the second was built as the first (session on 2026-10-09).
- **Rule:** If a term has two meanings in this repo, or a request could fit either, ask before building. "Control Tower" alone means the product console; the development monitor is the "dev Control Tower" (`/control-tower`).
- **Guards:**
  - `CLAUDE.md` › "dev Control Tower"

### L-015: Fake secrets in tests must not look like real ones
- **Seen:** A made-up token shaped like a Stripe live key (`sk_live_…`) in a test made GitHub push protection reject the push (session on 2026-10-09).
- **Rule:** Build test tokens at run time from obviously fake parts (`FAKE_TOKEN_…`), never in a real provider's key format (`sk_live_`, `AC…` with 32 hex characters, `xoxb-`).
- **Guards:**
  - `tests/devlog.test.ts` › "matches no real provider's key format"
