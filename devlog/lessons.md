# Lessons register

Mistakes made while building Voice Lab, and what stops each one coming back. Every Claude Code session loads this file (imported from `CLAUDE.md`). Read it before building. When you fix a bug, a review finding or a process mistake, add a lesson here or extend an existing one.

Format, checked by `tests/devlog.test.ts`:
- A heading `### L-NNN: <the rule, as an instruction>`.
- **Seen:** where it happened, with PR links. Add to this line when it happens again.
- **Rule:** what to do instead.
- **Guards:** one or more lines `` `path` › "exact text" ``. The text must appear in that file, usually a test title. The test fails if a guard's file or text is removed, so a lesson cannot quietly lose its protection.

### L-001: Check-then-act needs a lock or an atomic claim
- **Seen:** 6 times. Racing final callbacks ([#5](https://github.com/skchiew-bot/voicelab2/pull/5)); two reconciliation checks at once ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)); two replies both firing an integration write ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)); the dial retry bypassing the capacity lock, and inbound capacity decided without it ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)); concurrent rate changes (Phase 0). Two approved changes to one flow could both go live, the older silently undoing the newer; the drop watchdog could flag a call twice (Phase 5 independent review, 2026-10-10). Two audio finishes at once recorded every phrase twice and spent the voice provider twice (Phase 6 independent review, 2026-10-10). Contact limits were read without a lock, so three simultaneous dials to one person all passed; a case closed while its number was being looked up was still dialled (Phase 7 independent review, 2026-10-10).
- **Rule:** Any "read state, decide, write" path that two requests can reach at once takes a lock (`pg_advisory_xact_lock`, `SELECT … FOR UPDATE`) or claims the work atomically, and re-checks inside the lock. Write the simultaneous-requests test first.
- **Guards:**
  - `tests/telephony.test.ts` › "survives the same final callback arriving three times at once"
  - `tests/costs.test.ts` › "serialises concurrent deliveries of the same call"
  - `tests/workflow-store-hardening.test.ts` › "two simultaneous replies cannot both reach the next step"
  - `tests/concurrency.test.ts` › "never exceeds the ceiling when dials arrive at the same moment"
  - `tests/concurrency.test.ts` › "counts a caller on hold against the provider"
  - `tests/changes.test.ts` › "is refused, so approving one change never silently undoes another"
  - `tests/learning.test.ts` › "records the audio once when two finishes arrive together"
  - `tests/cases.test.ts` › "holds every dial to a contact's limits even when they arrive together, or in one dispatcher batch"
  - `tests/cases.test.ts` › "does not call a case that was closed while its number was being looked up"

### L-002: Never repeat an action whose outcome is unknown
- **Seen:** The dial retry re-dialled after a timeout, risking two calls to one person ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)).
- **Rule:** Retry only after a definite refusal. After a timeout or an unreadable reply, the first attempt may have taken effect: record it as unknown, never retry it automatically.
- **Guards:**
  - `tests/concurrency.test.ts` › "does not dial again after a timeout or an unreadable reply"

### L-003: Look up data-defined names as own properties only
- **Seen:** Workflow names such as `constructor`, `toString` and `__proto__` passed validation, rendering, conditions and reply paths ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)). A client's lexicon topic named like an inherited property (`toString`) broke turn reading (Phase 5 independent review, 2026-10-10).
- **Rule:** Never use `in` or `obj[name]` on names that come from data. Use `own()`, and reject reserved names.
- **Guards:**
  - `tests/workflow-hardening.test.ts` › "reserved names cannot be used for nodes, variables, captures or stored values"
  - `tests/workflow-hardening.test.ts` › "a missing variable named like an inherited property is still missing"
  - `tests/workflow-hardening.test.ts` › "does not reach inherited properties"
  - `tests/tracker.test.ts` › "lets a client name a topic like an inherited property without breaking the reading"

### L-004: Money never passes through a JavaScript number, including on screen
- **Seen:** 2 times. The funding monitor compared balances as floats ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)). The console still showed balances and credits with `Number(…).toLocaleString()` on three screens, found by the dev Control Tower check on 2026-10-09.
- **Rule:** Amounts stay decimal strings or BigInt (`src/money.ts`). In the console, format them with `fmtDecimal` from `admin/src/ui.tsx`, never `Number()` or `parseFloat()`.
- **Guards:**
  - `tests/billing.test.ts` › "has no floating point drift"
  - `tests/devlog.test.ts` › "keeps money out of floating point in the console"

### L-005: Something that never happened gets no status as if it had
- **Seen:** 4 times. A refused dial was stamped "could not be priced", giving a permanent false alert ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). The reconciliation sweep retried calls that never connected ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)). A DID failure could be recorded against a call that never went out ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)). The branch audit read a failed comparison with the trunk as "0 commits ahead", so with the trunk missing every branch, `main` included, would have shown as merged and deletable (independent review, 2026-10-10). A call never answered was recorded as a customer hang-up or a system drop; a QA run with nothing scored was stored as 0; a later normal end cleared a fault already flagged (Phase 5 independent review, 2026-10-10). A plain no-answer was counted as a missed call in the alert, and a callback the dispatcher was late for used up one of the person's retries though nobody was dialled (Phase 7 independent review, 2026-10-10). A delay flagged appointments it never reached as needing a new time, and told their customers they could not go ahead (Phase 7 appointments independent review, 2026-10-10).
- **Rule:** Give "never started" or "unknown" its own state (such as `not_applicable`, or `null` rather than 0) and keep it out of failure counts, alerts, retries and anything that recommends an action.
- **Guards:**
  - `tests/phase3.test.ts` › "will not lock a DID because of a call that never went out"
  - `tests/phase3.test.ts` › "does not count a refused dial as the provider failing"
  - `tests/reconcile.test.ts` › "skips calls that never connected"
  - `tests/devlog.test.ts` › "runs no audit and flags nothing when the trunk cannot be found"
  - `tests/journey.test.ts` › "does not call a call that was never answered a hang-up or a drop"
  - `tests/journey.test.ts` › "keeps a fault the watchdog found, with the time it was first seen, when the call then ends in a way that looks fine"
  - `tests/qa.test.ts` › "stores no score at all when nothing could be scored, and scores the call once a model is connected"
  - `tests/cases.test.ts` › "counts only a real failure to reach someone as an alert, not a plain no-answer"
  - `tests/appointments.test.ts` › "does not push an appointment into the officer's time off, and does not flag one the delay never reaches"

### L-006: One bad record must not take a whole feature down
- **Seen:** 3 times. One unreadable secret returned a 500 for the whole Control Tower ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). One provider priced in a currency with no exchange rate made every pooled dial fail ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)). A very large number gave a 500 instead of a 400 ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)). One script's audio failure aborted the whole sweep, so drift screening stopped for everyone (Phase 6 independent review, 2026-10-10).
- **Rule:** Handle the bad item where it is: report it as an alert, rank it last, or refuse that input with a 4xx. Keep everything else working.
- **Guards:**
  - `tests/control-tower.test.ts` › "is reported as an alert and does not take the whole Control Tower down"
  - `tests/phase3.test.ts` › "ranks a provider priced in a currency with no exchange rate last instead of failing every dial"
  - `tests/reconcile.test.ts` › "are refused with a clear error, not a server error"
  - `tests/qa.test.ts` › "keeps scoring the rest of a batch when the model fails on one call, and tries the failed one again next time"
  - `tests/learning.test.ts` › "does not stop the sweep when one script's audio fails, and names what it could not judge"

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
- **Seen:** A child workflow could speak or send a parent's sensitive value. Phone numbers nested in values, or written in local form, got through ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)). Free text a person types (a decision note, a close reason, a callback note) could have stored a customer's number in an append-only table (Phase 7 independent review, 2026-10-10). A policy answer's reason repeated the value of a call variable (a phone number passing as an amount) into an append-only table (Phase 7 knowledge independent review, 2026-10-10).
- **Rule:** Enforce sensitivity and number rules across workflows, nesting levels and every input path (start variables, integration replies), both at publish time and at run time.
- **Guards:**
  - `tests/workflow-hardening.test.ts` › "a parent's sensitive variable cannot be spoken by the workflow it hands over to"
  - `tests/workflow-hardening.test.ts` › "are refused in the starting record, however deep, and in the local form"
  - `tests/workflow-hardening.test.ts` › "are refused in what an integration returns, nested or not"
  - `tests/cases.test.ts` › "refuses a customer's number in a note, a reason or a callback note, and an impossible date"
  - `tests/knowledge-policy.test.ts` › "never puts the value of a variable into the reason it gives"

### L-010: A test that cannot fail proves nothing
- **Seen:** 5 times. The Control Tower drift test passed with wrong data ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). The Phase 2 production gate accepted scenarios that asserted nothing ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)). The guard for L-015 pointed at a code comment, not a test, so it could never fail (independent review, 2026-10-10). A report test asserted the sum of two transcripts' costs and so locked in a double count; three new tests passed with the code they protect broken (independent review and mutation checks, 2026-10-10).
- **Rule:** Before trusting a new test, break the code it protects and watch the test fail. Match exactly, not loosely. A test that asserts today's output can lock in today's bug: assert what is true, worked out by hand.
- **Guards:**
  - `tests/control-tower.test.ts` › "matches the plan's Control Tower criteria exactly"
  - `tests/devlog.test.ts` › "guards a code lesson with a test title, not a comment"

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
  - `tests/devlog.test.ts` › "warns at session start when the branch is behind origin/main"

### L-014: When a request could mean two things, ask which
- **Seen:** "Control Tower" names both the product's operations console (`BUILD_PLAN.md`) and the owner's dashboard for monitoring development. A request for the second was built as the first (session on 2026-10-09). The dev Control Tower was then designed without asking whether a reference existed; the owner already had one in `skchiew-bot/d3ngineering` (session on 2026-10-10).
- **Rule:** If a term has two meanings in this repo, or a request could fit either, ask before building. Before designing something new for the owner, ask whether they already have a design or an example to follow. "Control Tower" alone means the product console; the development monitor is the "dev Control Tower" (`/control-tower`).
- **Guards:**
  - `CLAUDE.md` › "dev Control Tower"

### L-015: Fake secrets in tests must not look like real ones
- **Seen:** A made-up token shaped like a Stripe live key (`sk_live_…`) in a test made GitHub push protection reject the push (session on 2026-10-09).
- **Rule:** Build test tokens at run time from obviously fake parts (`FAKE_TOKEN_…`), never in a real provider's key format (`sk_live_`, `AC…` with 32 hex characters, `xoxb-`).
- **Guards:**
  - `tests/devlog.test.ts` › "no tracked file holds a token in a real provider's key format"

### L-016: Check an integration against a real payload, not an assumed one
- **Seen:** 5 times. Twilio and Telnyx request formats were written from memory and are still unverified against the live services ([#5](https://github.com/skchiew-bot/voicelab2/pull/5)). The dev Control Tower hook assumed the hook's `session_id` was the claude.ai session id; in a cloud session it is a local id, so links broke and one session counted twice (session on 2026-10-10). Session cost was nearly built on the transcript alone; a real transcript showed each message repeated per content block and background calls (the permission classifier) missing, so cost is now Claude Code's own checkpoint plus priced messages after it (session on 2026-10-10). A session resumed in another folder starts a new transcript that copies the earlier messages; summing transcripts double counted (independent review, 2026-10-10). The fix then assumed a resumed run's checkpoints carry the earlier total and called taking the largest "right either way"; real checkpoints showed the resumed run started from zero (it had no checkpoint to restore), so spend fell by a whole run once the new one overtook it; the first wording of that finding then overgeneralised it to every resume (independent review, 2026-10-10) ([#12](https://github.com/skchiew-bot/voicelab2/pull/12), found by the next dashboard run).
- **Rule:** Before building on an outside payload or format, capture one real example and test against its actual shape. Where that is impossible, say so as unverified, in the PR and in `src/progress.ts`, and do not argue the code is right regardless; check it against real data as soon as the data exists.
- **Guards:**
  - `tests/devlog.test.ts` › "records the claude.ai session id in a cloud session, and the local id elsewhere"
  - `tests/devlog.test.ts` › "counts each message once, prices tokens exactly, and adds them to Claude Code's own checkpoint"
  - `tests/devlog.test.ts` › "counts a session resumed in another folder once"
  - `tests/devlog.test.ts` › "places every message in its own run"

### L-017: Record logs by allowlist; anything logged may be published
- **Seen:** The dev Control Tower hook scrubbed by blocklist and still let through credentials in URLs, `key=value` secrets, tokens split by digit runs, emails, and other tools' raw error text with a customer's name and email, all bound for git (independent review, 2026-10-10).
- **Rule:** Decide what a log may hold and record only that: fixed fields, categories instead of free text, scrubbed paths, nothing from outside the project. Treat every log, report and dashboard as published.
- **Guards:**
  - `tests/devlog.test.ts` › "records another tool's failure as a category, never its error text"
  - `tests/devlog.test.ts` › "scrubs credentials, emails and phone numbers from what it does record"
  - `tests/devlog.test.ts` › "moves only new lines into new files, rebuilt from known fields with no error text"

### L-018: Untrusted text placed into code or markup must stay inert
- **Seen:** A `$'` in a PR title, passed as a `String.replace` replacement, pasted part of the dashboard template into its own data and broke the page (independent review, 2026-10-10).
- **Rule:** Pass untrusted text to `replace` through a function, escape it for where it lands (`<` in embedded JSON, HTML entities in markup), and allow only known link targets.
- **Guards:**
  - `tests/devlog.test.ts` › "embeds hostile titles as inert text and reads review findings from a PR body"

### L-019: Tooling must not dirty the working tree
- **Seen:** The activity hook appended to a committed file after every command, so the tree was never clean and checkout, rebase and pull all failed (independent review, 2026-10-10).
- **Rule:** Hooks and background tools write only to ignored files. Anything meant for git is written by an explicit step (here, `scripts/devlog-flush.mjs`) into new files that never conflict across branches.
- **Guards:**
  - `tests/devlog.test.ts` › "writes to the spool, which git ignores, so the working tree stays clean"

### L-020: Check that monitoring is running, not just installed
- **Seen:** After a restart, Claude Code reopened a session with `/home/user` as its project folder, outside the repository, so the repository's hooks never loaded and nothing was logged for half an hour, silently (session on 2026-10-10). The drift screen swallowed errors and said nothing about nodes it could not judge (Phase 6 independent review, 2026-10-10).
- **Rule:** A monitor must report its own gaps. The dev Control Tower flags any session that commits while not being logged; when you see that warning, say so and record what ran by hand instead of leaving the gap. Usage can be recorded by running the hook with a Stop event for the session's transcript; it gathers every transcript of the session and counts each message once.
- **Guards:**
  - `tests/devlog.test.ts` › "folds the board, splits a session's cost between its tasks exactly, links incidents to guarded lessons, and finds logging gaps"
  - `tests/learning.test.ts` › "does not stop the sweep when one script's audio fails, and names what it could not judge"

### L-021: A guardrail that fires on normal work is worse than none
- **Seen:** The first stop-loss rules told Claude to stop after three unrelated commands that shared a description, a `grep` that mentioned `vitest`, a large file read in chunks, and test runs broken on purpose to prove a test can fail (independent review, 2026-10-10). The Phase 5 turn reader treated a plain "no" and "no, thank you" as upset, so two declined questions handed a call to a person; the drop watchdog treated a reply still being worked on as dropped (Phase 5 independent review, 2026-10-10).
- **Rule:** Before a guardrail can stop work, test it against normal work as well as the failure it targets: count consecutive failures of the same thing, reset on success, and give deliberate exceptions a way through (`DEVLOG_EXPECT_RED=1`).
- **Guards:**
  - `tests/devlog.test.ts` › "does not count test runs expected to fail, or commands that only mention a test runner"
  - `tests/devlog.test.ts` › "counts the same command failing, not different commands that share a description"
  - `tests/devlog.test.ts` › "but not about reading it in chunks"
  - `tests/devlog.test.ts` › "counts only successful edits since the last passing check"
  - `tests/tracker.test.ts` › "reads a plain "no" or "no, thank you" as neutral or kind, and two declined questions do not hand the call to a person"

### L-022: Compare times as times, not as text
- **Seen:** The report compared git commit dates written with a +08:00 offset against UTC log timestamps as strings, so logging gaps, audit completeness and session times were wrong for anyone outside UTC (independent review, 2026-10-10). A date column read on a server east of UTC came back as the day before, so a promise was judged broken a day early (Phase 7 independent review, 2026-10-10). A group booking counted an officer's busy-ness by the server's UTC day, so early-morning work in Kuala Lumpur counted towards the wrong day (Phase 7 appointments independent review, 2026-10-10).
- **Rule:** Turn every timestamp into one form (`new Date(x).toISOString()`, or milliseconds) at the edge, before comparing or sorting.
- **Guards:**
  - `tests/devlog.test.ts` › "finds logging gaps"
  - `tests/cases.test.ts` › "records a part payment, recalculates the balance exactly, and passes the case to a person or plan"
  - `tests/appointments.test.ts` › "counts a group member's load by their own calendar day"

### L-023: Keep every branch accountable to the plan, and the trunk as the default
- **Seen:** The repository's default branch on GitHub was still the first session branch (`claude/elegant-fermat-er13o8`), long merged, so clones and the GitHub page showed stale code; seven merged branches were never deleted; and nothing checked that a branch belonged to the plan (found by the dev Control Tower branch audit, 2026-10-10).
- **Rule:** Every branch is either named for a plan phase or carries a PR titled with one. A branch justified only by a board task is listed for the owner to confirm, and anything else is a fork; never create or link a task just to clear the warning. The default branch is `main`. Deleting branches and changing the default are the owner's calls: report them, never do them unasked.
- **Guards:**
  - `tests/devlog.test.ts` › "classes every branch as the trunk, part of the plan, task-only or a fork"
  - `tests/devlog.test.ts` › "runs no audit and flags nothing when the trunk cannot be found"

### L-024: A check the checked party can pass by itself proves nothing
- **Seen:** The first branch audit counted any branch linked to a board task as part of the plan, and its instructions told sessions to link a task to clear the fork warning: a session could invent a task and approve its own branch (independent review, 2026-10-10).
- **Rule:** When a check guards against the agent's own work drifting, the agent must not be able to satisfy it alone. Show self-declared evidence (a task link) as its own class for the owner to confirm, and never create evidence just to clear a warning.
- **Guards:**
  - `tests/devlog.test.ts` › "classes every branch as the trunk, part of the plan, task-only or a fork"
  - `CLAUDE.md` › "never create or link a task just to clear a warning"

### L-025: Derived state is valid only for the thing it was derived from
- **Seen:** A promoted script was looked up by workflow, node and language only, so after a deploy changed the node callers kept hearing the old script until a scheduled screen ran; a script learned in one journey context was spoken in every context; and the screen that looked for a changed node could be tripped by simulating an undeployed draft (Phase 6 independent review, 2026-10-10).
- **Rule:** Anything learned or derived from a definition (a script, a cache, a score) carries what it was derived from (here the node's hash and the journey context) and is used only when that still matches, checked at the point of use, not by a job that may not be running. A rehearsal of something undeployed never counts as evidence about what is live.
- **Guards:**
  - `tests/learning.test.ts` › "is not demoted by simulating a draft, but stops being spoken the moment a deploy changes its node"
  - `tests/learning.test.ts` › "speaks a script only in the journey context it was learned in"

### L-026: Record what a model cost, even when its answer is thrown away
- **Seen:** The script distiller was asked before the check for an existing script, so a scan paid for model calls whose tokens were never written down; council tokens were lost when a person decided first (Phase 6 independent review, 2026-10-10).
- **Rule:** Check whether the answer is needed before asking a model, and record the model, tier and tokens of every call that is made, in its own step, whether or not the answer is used.
- **Guards:**
  - `tests/learning.test.ts` › "does not ask a model to write a script for a node that already has one in review, and refuses to approve a script that fails the rules"

### L-027: A human override must pass the same rule checks as the automatic path
- **Seen:** A person could approve a script that the rule checks had already failed, and the approval was reported as an error after it had committed (Phase 6 independent review, 2026-10-10).
- **Rule:** Re-run the deterministic checks inside any manual approval, and report a failure after a committed step as a warning on the committed result, not as a failed request.
- **Guards:**
  - `tests/learning.test.ts` › "does not ask a model to write a script for a node that already has one in review, and refuses to approve a script that fails the rules"
  - `tests/learning.test.ts` › "leaves a low-confidence pass for a person, who can approve it; it stays approved, still live, until its audio exists"

### L-028: Measure a promised time from the promise, not from the last time it was moved
- **Seen:** A callback held back by a quiet hour or a call limit had its time overwritten, so the lateness limit was measured from the new time and a callback locked for 11:00 could be placed days later (Phase 7 independent review, 2026-10-10).
- **Rule:** Keep the time something was promised for separate from when it is next tried. Deferring changes the second, never the first, and anything past its allowed lateness is missed, however many times it was held back.
- **Guards:**
  - `tests/cases.test.ts` › "measures lateness from the time a callback was locked to, however long it was held back"

### L-029: An event can arrive before the record that expects it
- **Seen:** A provider's end-of-call report was processed before the dispatcher had recorded the call against its case, so the outcome was dropped and the retry chain stopped for good (Phase 7 independent review, 2026-10-10).
- **Rule:** When a record is written after a call to an outside system, look at whether the outside system has already reported by the time it is written, and settle it then. Never rely on the order in which two requests commit.
- **Guards:**
  - `tests/cases.test.ts` › "does not lose the outcome of a call the provider reported over before it was recorded"

### L-030: A request that needs several locks takes them all first, in one fixed order
- **Seen:** A move into a group diary held the old diary's lock and then waited for the group's members, while a group booking held a member and waited for the other: Postgres broke the deadlock with an error, and half the requests failed with a 500 (Phase 7 appointments independent review, 2026-10-10).
- **Rule:** Work out every lock a request will need before taking any, sort them, and take them in that order; locks taken later in a function are the ones that deadlock.
- **Guards:**
  - `tests/appointments.test.ts` › "does not deadlock when a move into a group meets group bookings, or two moves cross"

### L-031: A customer is never charged for the business's own fault
- **Seen:** A customer who cancelled an appointment that a delay had flagged for a new time, or had moved, was charged the late fee (Phase 7 appointments independent review, 2026-10-10).
- **Rule:** A fee that depends on who changed something must look at who made the change necessary: a time the business moved or broke is free for the customer to give up, whatever the notice.
- **Guards:**
  - `tests/appointments.test.ts` › "never charges a customer for a time the business broke"

### L-032: A rule that cannot be judged is a refusal, not a pass
- **Seen:** A policy "deny when over 1000" let an action through when the amount was missing or unreadable, because the workflow condition language reads an unknown variable as false, so the deny was skipped and a plain allow won; banned phrases slipped past a curly apostrophe; an approved policy nobody could withdraw blocked every later change (Phase 7 knowledge independent review, 2026-10-10).
- **Rule:** Where a check guards something (a policy, a gate), judge conditions three-valued: unknown on a deny counts as deny, unknown on an allow counts as not allowed. Normalise text before matching it, and give every stuck state a recorded way out.
- **Guards:**
  - `tests/knowledge-policy.test.ts` › "denies when the variable a deny rule depends on is missing or unreadable, and does not allow on a condition it cannot judge"
  - `tests/knowledge-policy.test.ts` › "catches a banned phrase written with a curly apostrophe or zero-width marks, and refuses a phrase with no words"
  - `tests/knowledge.test.ts` › "lets a wrong proposal be withdrawn, with a reason, so it never blocks every later change; and a refused number is free again"
