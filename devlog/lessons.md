# Lessons register

Mistakes made while building Voice Lab, and what stops each one coming back. Every Claude Code session loads this file (imported from `CLAUDE.md`). Read it before building. When you fix a bug, a review finding or a process mistake, add a lesson here or extend an existing one.

Format, checked by `tests/devlog.test.ts`:
- A heading `### L-NNN: <the rule, as an instruction>`.
- **Seen:** where it happened, with PR links. Add to this line when it happens again.
- **Rule:** what to do instead.
- **Guards:** one or more lines `` `path` › "exact text" ``. The text must appear in that file, usually a test title. The test fails if a guard's file or text is removed, so a lesson cannot quietly lose its protection.

### L-001: Check-then-act needs a lock or an atomic claim
- **Seen:** 14 times. Racing final callbacks ([#5](https://github.com/skchiew-bot/voicelab2/pull/5)); two reconciliation checks at once ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)); two replies both firing an integration write ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)); the dial retry bypassing the capacity lock, and inbound capacity decided without it ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)); concurrent rate changes (Phase 0). Two approved changes to one flow could both go live, the older silently undoing the newer; the drop watchdog could flag a call twice (Phase 5 independent review, 2026-10-10). Two audio finishes at once recorded every phrase twice and spent the voice provider twice (Phase 6 independent review, 2026-10-10). Contact limits were read without a lock, so three simultaneous dials to one person all passed; a case closed while its number was being looked up was still dialled (Phase 7 independent review, 2026-10-10). A relay connection closing ended the call's run even when a newer connection had taken the call over, hanging up on the caller mid-conversation (live call voice link independent review, 2026-10-10). A relay connection standing by whose socket closed while its look was under way could still take the call over, and its close then ended the run (live call voice link hardening review, 2026-10-10). Test files, each migrating a database of its own, all passed migration 001's check that the cluster-wide roles did not exist on a brand-new cluster, and all but one then failed creating them (fresh cloud container, 2026-10-10). A workflow's outcome for an outbound call that landed after a person had classified the call replaced the person's statement, because the latest row counts (Phase 3 workflow outcomes independent review, 2026-10-10). Staff disabling a client's admin and that admin disabling another took different locks, so both could commit and leave the client with no admin (client portal independent review, 2026-10-10). A hang-up callback that the dispatcher had claimed, then held back and put back to waiting, would have dialled a caller already served, since only waiting callbacks were cancelled; the dispatcher now checks again under the case lock just before it dials (transfer follow-ups review, 2026-10-11).
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
  - `tests/knowledge.test.ts` › "approves each level once and in order when three people approve at the same moment, and publishes a draft once"
  - `tests/control-actions.test.ts` › "holds dials back once the minute's quota is used, even when they arrive at the same moment, and lifts when cleared"
  - `tests/relay.test.ts` › "keeps serving the call on a new connection when the old one closes after it"
  - `tests/relay.test.ts` › "a connection standing by looks again within seconds, stops looking once closed, and never takes the call over after"
  - `tests/fresh-container.test.ts` › "migrates one scratch database before any test file, so files migrating at once never race to create the cluster-wide roles"
  - `tests/workflow-outcomes.test.ts` › "never replaces what a person said, even when the workflow's outcome lands after it"
  - `tests/portal.test.ts` › "holds when staff disable a client admin while that admin disables another: the client is not left with no admin by the race"
  - `tests/transfer.test.ts` › "is either placed or cancelled, never both, when the dispatcher and the call that reached them land at the same moment"
  - `tests/transfer.test.ts` › "checks again just before the dial: reached while their number was being looked up, the callback is cancelled, not dialled"

### L-002: Never repeat an action whose outcome is unknown
- **Seen:** 2 times. The dial retry re-dialled after a timeout, risking two calls to one person ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)). A live call that fell back while a reply was being applied ended the run with no sign that the reply was cut off, so whether it had reached a client's system could not be told from the record (live call voice link hardening review, 2026-10-10).
- **Rule:** Retry only after a definite refusal. After a timeout or an unreadable reply, the first attempt may have taken effect: record it as unknown, never retry it automatically. Anything cut off part-way is recorded as cut off.
- **Guards:**
  - `tests/concurrency.test.ts` › "does not dial again after a timeout or an unreadable reply"
  - `tests/relay.test.ts` › "cuts off a reply still being applied when the call falls back: the run ends now, says it was cut off, and the reply cannot land"

### L-003: Look up data-defined names as own properties only
- **Seen:** 2 times. Workflow names such as `constructor`, `toString` and `__proto__` passed validation, rendering, conditions and reply paths ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)). A client's lexicon topic named like an inherited property (`toString`) broke turn reading (Phase 5 independent review, 2026-10-10).
- **Rule:** Never use `in` or `obj[name]` on names that come from data. Use `own()`, and reject reserved names.
- **Guards:**
  - `tests/workflow-hardening.test.ts` › "reserved names cannot be used for nodes, variables, captures or stored values"
  - `tests/workflow-hardening.test.ts` › "a missing variable named like an inherited property is still missing"
  - `tests/workflow-hardening.test.ts` › "does not reach inherited properties"
  - `tests/tracker.test.ts` › "lets a client name a topic like an inherited property without breaking the reading"

### L-004: Money never passes through a JavaScript number, including on screen
- **Seen:** 3 times. The funding monitor compared balances as floats ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)). The console still showed balances and credits with `Number(…).toLocaleString()` on three screens, found by the dev Control Tower check on 2026-10-09. The Control Tower's funding alerts still compared and printed balances with `Number()` (found while building the panels, 2026-10-10).
- **Rule:** Amounts stay decimal strings or BigInt (`src/money.ts`). In the console, format them with `fmtDecimal` from `admin/src/ui.tsx`, never `Number()` or `parseFloat()`.
- **Guards:**
  - `tests/billing.test.ts` › "has no floating point drift"
  - `tests/devlog.test.ts` › "keeps money out of floating point in the console"
  - `tests/control-tower-panels.test.ts` › "names a funding balance in an alert to the last decimal place, never through a floating-point number"

### L-005: Something that never happened gets no status as if it had
- **Seen:** 14 times. A refused dial was stamped "could not be priced", giving a permanent false alert ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). The reconciliation sweep retried calls that never connected ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)). A DID failure could be recorded against a call that never went out ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)). The branch audit read a failed comparison with the trunk as "0 commits ahead", so with the trunk missing every branch, `main` included, would have shown as merged and deletable (independent review, 2026-10-10). A call never answered was recorded as a customer hang-up or a system drop; a QA run with nothing scored was stored as 0; a later normal end cleared a fault already flagged (Phase 5 independent review, 2026-10-10). A plain no-answer was counted as a missed call in the alert, and a callback the dispatcher was late for used up one of the person's retries though nobody was dialled (Phase 7 independent review, 2026-10-10). A delay flagged appointments it never reached as needing a new time, and told their customers they could not go ahead (Phase 7 appointments independent review, 2026-10-10). The Control Tower's funding runway said "no spend" when the spend was in another currency, and its contact rate read answered calls with no outcome as not contacted (Control Tower panels independent review, 2026-10-10). Draining a client's only provider for planned maintenance failed every dial, so each case callback used up one of the person's retries (Control Tower actions independent review, 2026-10-10). A scheduled job that failed for one client was reported as failing outright, and a job no longer in the code would have been reported overdue for ever (Phase 0 scheduler independent review, 2026-10-10). A transfer to a person whose dial-ended request never came would have stayed "dialling" for ever, with no callback for a caller who had asked for a person (human transfer independent review, 2026-10-10). PR #36 then cited this lesson to record no callback for a caller who hung up while the agent's phone rang, reading it as "not a failure to reach anyone"; the owner decided otherwise (2026-10-10): what never happened was the caller reaching a person, so a caller who asked for one and hung up before the dial or while it rang now gets a callback, once ([#36](https://github.com/skchiew-bot/voicelab2/pull/36) follow-ups). Ask which thing did not happen before using this lesson to leave something undone. The agent leg's length was then read as 0 (free) for any dial status it did not recognise; only a status that says the leg never connected means no time, anything else is unknown and waits (transfer follow-ups independent review, 2026-10-10). A leg that could not be checked against Twilio (no id to look it up by) was recorded as a variance, with a provider difference that never happened; it is now its own state, `unchecked` (transfer follow-ups re-review, 2026-10-11).
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
  - `tests/control-tower-panels.test.ts` › "give funding runway from the recorded balance and the last week's spend, exactly, counting a reconciled call once"
  - `tests/control-actions.test.ts` › "holds dials back instead of failing them, so a case callback keeps its retries, and voice providers cannot be drained to nothing"
  - `tests/transfer.test.ts` › "records a callback once when the call ends while the dial is under way and Twilio never says how it ended"
  - `tests/scheduler.test.ts` › "says only some clients failed when that is what happened, and never alerts on a job this code no longer runs"
  - `tests/transfer.test.ts` › "prices the agent leg only at its own telephony rate, refuses to call it free, and waits when its length is unknown"
  - `tests/transfer.test.ts` › "records a callback, once, for a caller who asked for a person and hung up before the dial or while the agent phone rang"
  - `tests/transfer.test.ts` › "checks both legs against Twilio, each by its own id and in its own currency, and leaves a leg it cannot look up for a person"

### L-006: One bad record must not take a whole feature down
- **Seen:** 6 times. One unreadable secret returned a 500 for the whole Control Tower ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). One provider priced in a currency with no exchange rate made every pooled dial fail ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)). A very large number gave a 500 instead of a 400 ([#6](https://github.com/skchiew-bot/voicelab2/pull/6)). One script's audio failure aborted the whole sweep, so drift screening stopped for everyone (Phase 6 independent review, 2026-10-10). Pricing a transfer's agent leg inside the transfer's own transaction meant a pricing failure undid the transfer's record and left Twilio failing on every retry (transfer follow-ups independent review, 2026-10-10). Scheduling a case callback inside the end-of-call webhook could roll the call's end back, with Twilio retrying into the same error (transfer follow-ups re-review, 2026-10-11).
- **Rule:** Handle the bad item where it is: report it as an alert, rank it last, or refuse that input with a 4xx. Keep everything else working.
- **Guards:**
  - `tests/control-tower.test.ts` › "is reported as an alert and does not take the whole Control Tower down"
  - `tests/phase3.test.ts` › "ranks a provider priced in a currency with no exchange rate last instead of failing every dial"
  - `tests/reconcile.test.ts` › "are refused with a clear error, not a server error"
  - `tests/qa.test.ts` › "keeps scoring the rest of a batch when the model fails on one call, and tries the failed one again next time"
  - `tests/learning.test.ts` › "does not stop the sweep when one script's audio fails, and names what it could not judge"
  - `tests/transfer.test.ts` › "costs the agent leg in the one cost record of the call, exactly, with credits only for the time of the caller"

### L-007: Bill only for what was served
- **Seen:** 2 times. A caller who hung up in the queue was charged credits, and a served caller was billed for their time on hold. A promoted caller lost their agreed premium ([#10](https://github.com/skchiew-bot/voicelab2/pull/10)). The new scheduler ran extra channel charges every day, billing a past month at today's entitlement, so a client added or upgraded mid-month would have paid for the whole month (Phase 0 scheduler independent review, 2026-10-10).
- **Rule:** Credits start when service starts. Provider time is still costed internally. Carry agreed terms through every state change.
- **Guards:**
  - `tests/concurrency.test.ts` › "costs the provider time of a caller who gave up in the queue, and draws no credits for it"
  - `tests/concurrency.test.ts` › "bills a caller who waited and was then served only from the moment they were served"
  - `tests/concurrency.test.ts` › "keeps the agreed premium when a waiting caller is promoted beyond the channels"
  - `tests/scheduler.test.ts` › "does not schedule extra channel charges, which would bill a past month at today's entitlement"

### L-008: Key a rule on the real-world thing, not the database row
- **Seen:** 2 times. The DID lock was keyed by row, so the same number registered at a second provider could be shown again to a contact it had failed for ([#9](https://github.com/skchiew-bot/voicelab2/pull/9)). Every overdue scheduled job shared one alert key, so a second job going wrong raised no new alert and no email (Phase 0 scheduler independent review, 2026-10-10).
- **Rule:** Ask what the person or provider actually sees (the number, the contact), and key on that.
- **Guards:**
  - `tests/phase3.test.ts` › "locks the caller ID the contact sees, even when the same number is registered at two providers"
  - `tests/scheduler.test.ts` › "raises each job as its own alert, so a second job going wrong is a new alert and a new email"

### L-009: A privacy rule must hold across every boundary
- **Seen:** 3 times. A child workflow could speak or send a parent's sensitive value. Phone numbers nested in values, or written in local form, got through ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)). Free text a person types (a decision note, a close reason, a callback note) could have stored a customer's number in an append-only table (Phase 7 independent review, 2026-10-10). A policy answer's reason repeated the value of a call variable (a phone number passing as an amount) into an append-only table (Phase 7 knowledge independent review, 2026-10-10).
- **Rule:** Enforce sensitivity and number rules across workflows, nesting levels and every input path (start variables, integration replies), both at publish time and at run time.
- **Guards:**
  - `tests/workflow-hardening.test.ts` › "a parent's sensitive variable cannot be spoken by the workflow it hands over to"
  - `tests/workflow-hardening.test.ts` › "are refused in the starting record, however deep, and in the local form"
  - `tests/workflow-hardening.test.ts` › "are refused in what an integration returns, nested or not"
  - `tests/cases.test.ts` › "refuses a customer's number in a note, a reason or a callback note, and an impossible date"
  - `tests/knowledge-policy.test.ts` › "never puts the value of a variable into the reason it gives"

### L-010: A test that cannot fail proves nothing
- **Seen:** 9 times. The Control Tower drift test passed with wrong data ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). The Phase 2 production gate accepted scenarios that asserted nothing ([#8](https://github.com/skchiew-bot/voicelab2/pull/8)). The guard for L-015 pointed at a code comment, not a test, so it could never fail (independent review, 2026-10-10). A report test asserted the sum of two transcripts' costs and so locked in a double count; three new tests passed with the code they protect broken (independent review and mutation checks, 2026-10-10). The read-only test accepted a 400 as a refusal, so it passed with the read-only check removed for every route that parses its input first; a browser check passed before the screen had loaded its data (Phase 0 independent review and mutation checks, 2026-10-10). A transfer test titled "dials the agent once" asserted that all three simultaneous requests were given a dial (human transfer independent review, 2026-10-10). A script that resolved merge conflicts in this file joined two versions of L-001's Seen line whole, and the format test passed, since it only checked that a Seen line existed (merging #38, 2026-10-10). A capacity test checked that Twilio asking again did not count a leg twice, but the retry path writes nothing that is counted, so it could not fail; it now checks the dial adds exactly one channel (transfer follow-ups independent review, 2026-10-10).
- **Rule:** Before trusting a new test, break the code it protects and watch the test fail. Match exactly, not loosely. A test that asserts today's output can lock in today's bug: assert what is true, worked out by hand.
- **Guards:**
  - `tests/control-tower.test.ts` › "matches the plan's Control Tower criteria exactly"
  - `tests/devlog.test.ts` › "guards a code lesson with a test title, not a comment"
  - `tests/devlog.test.ts` › "gives each lesson one Seen, one Rule and one Guards line, so a merge cannot leave a lesson written twice"

  - `tests/staff-roles.test.ts` › "is refused every change, on every route, and nothing in the database moves"
### L-011: Show old data as old
- **Seen:** 2 times. A failed Control Tower refresh left stale numbers looking current, and a slow older request could overwrite a newer one ([#7](https://github.com/skchiew-bot/voicelab2/pull/7)). The client portal's calls screen said "No calls yet." when its load had failed, showed no time for its data, and a token disabled mid-session left every screen failing instead of returning to sign-in (client portal independent review, 2026-10-10).
- **Rule:** Every live screen shows when its data is from, says so when an update fails, and lets the newest request win.
- **Guards:**
  - `tests/admin-ui.test.ts` › "says so when a refresh fails, instead of showing old numbers as current"
  - `tests/admin-ui.test.ts` › "never mixes an old filter's late answer into the change log"
  - `tests/admin-ui.test.ts` › "gives a client its own portal: credits and calls for everyone, users for its admins, and a sign-in apart from the console"

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
- **Seen:** 2 times. "Control Tower" names both the product's operations console (`BUILD_PLAN.md`) and the owner's dashboard for monitoring development. A request for the second was built as the first (session on 2026-10-09). The dev Control Tower was then designed without asking whether a reference existed; the owner already had one in `skchiew-bot/d3ngineering` (session on 2026-10-10).
- **Rule:** If a term has two meanings in this repo, or a request could fit either, ask before building. Before designing something new for the owner, ask whether they already have a design or an example to follow. "Control Tower" alone means the product console; the development monitor is the "dev Control Tower" (`/control-tower`).
- **Guards:**
  - `CLAUDE.md` › "dev Control Tower"

### L-015: Fake secrets in tests must not look like real ones
- **Seen:** A made-up token shaped like a Stripe live key (`sk_live_…`) in a test made GitHub push protection reject the push (session on 2026-10-09).
- **Rule:** Build test tokens at run time from obviously fake parts (`FAKE_TOKEN_…`), never in a real provider's key format (`sk_live_`, `AC…` with 32 hex characters, `xoxb-`).
- **Guards:**
  - `tests/devlog.test.ts` › "no tracked file holds a token in a real provider's key format"

### L-016: Check an integration against a real payload, not an assumed one
- **Seen:** 7 times. Twilio and Telnyx request formats were written from memory and are still unverified against the live services ([#5](https://github.com/skchiew-bot/voicelab2/pull/5)). The dev Control Tower hook assumed the hook's `session_id` was the claude.ai session id; in a cloud session it is a local id, so links broke and one session counted twice (session on 2026-10-10). Session cost was nearly built on the transcript alone; a real transcript showed each message repeated per content block and background calls (the permission classifier) missing, so cost is now Claude Code's own checkpoint plus priced messages after it (session on 2026-10-10). A session resumed in another folder starts a new transcript that copies the earlier messages; summing transcripts double counted (independent review, 2026-10-10). The fix then assumed a resumed run's checkpoints carry the earlier total and called taking the largest "right either way"; real checkpoints showed the resumed run started from zero (it had no checkpoint to restore), so spend fell by a whole run once the new one overtook it; the first wording of that finding then overgeneralised it to every resume (independent review, 2026-10-10) ([#12](https://github.com/skchiew-bot/voicelab2/pull/12), found by the next dashboard run). Twilio's docs were unreachable again while building the live call voice link, so its messages were taken from Twilio's own published packages, kept as a fixture marked unverified, instead of from memory (2026-10-10) Its transfer requests (the `<Connect action>` request, the whisper and the end of the dial) were taken the same way; the values `DialCallStatus` takes are in neither package, so they are assumed and anything unknown is read as no one reached (human transfer, 2026-10-10).
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
- **Seen:** 2 times. After a restart, Claude Code reopened a session with `/home/user` as its project folder, outside the repository, so the repository's hooks never loaded and nothing was logged for half an hour, silently (session on 2026-10-10). The drift screen swallowed errors and said nothing about nodes it could not judge (Phase 6 independent review, 2026-10-10).
- **Rule:** A monitor must report its own gaps. The dev Control Tower flags any session that commits while not being logged; when you see that warning, say so and record what ran by hand instead of leaving the gap. Usage can be recorded by running the hook with a Stop event for the session's transcript; it gathers every transcript of the session and counts each message once.
- **Guards:**
  - `tests/devlog.test.ts` › "folds the board, splits a session's cost between its tasks exactly, links incidents to guarded lessons, and finds logging gaps"
  - `tests/learning.test.ts` › "does not stop the sweep when one script's audio fails, and names what it could not judge"

### L-021: A guardrail that fires on normal work is worse than none
- **Seen:** 2 times. The first stop-loss rules told Claude to stop after three unrelated commands that shared a description, a `grep` that mentioned `vitest`, a large file read in chunks, and test runs broken on purpose to prove a test can fail (independent review, 2026-10-10). The Phase 5 turn reader treated a plain "no" and "no, thank you" as upset, so two declined questions handed a call to a person; the drop watchdog treated a reply still being worked on as dropped (Phase 5 independent review, 2026-10-10).
- **Rule:** Before a guardrail can stop work, test it against normal work as well as the failure it targets: count consecutive failures of the same thing, reset on success, and give deliberate exceptions a way through (`DEVLOG_EXPECT_RED=1`).
- **Guards:**
  - `tests/devlog.test.ts` › "does not count test runs expected to fail, or commands that only mention a test runner"
  - `tests/devlog.test.ts` › "counts the same command failing, not different commands that share a description"
  - `tests/devlog.test.ts` › "but not about reading it in chunks"
  - `tests/devlog.test.ts` › "counts only successful edits since the last passing check"
  - `tests/tracker.test.ts` › "reads a plain "no" or "no, thank you" as neutral or kind, and two declined questions do not hand the call to a person"

### L-022: Compare times as times, not as text
- **Seen:** 4 times. The report compared git commit dates written with a +08:00 offset against UTC log timestamps as strings, so logging gaps, audit completeness and session times were wrong for anyone outside UTC (independent review, 2026-10-10). A date column read on a server east of UTC came back as the day before, so a promise was judged broken a day early (Phase 7 independent review, 2026-10-10). A group booking counted an officer's busy-ness by the server's UTC day, so early-morning work in Kuala Lumpur counted towards the wrong day (Phase 7 appointments independent review, 2026-10-10). The alert sweep judged an email claim's age by its own clock against a time the database had stamped, so a second sweep took a send still under way for a crash and marked it "may not have arrived" (found by repeated full runs, 2026-10-10).
- **Rule:** Turn every timestamp into one form (`new Date(x).toISOString()`, or milliseconds) at the edge, before comparing or sorting. Compare a time with times from the same clock: a database-stamped time against the database's `now()`.
- **Guards:**
  - `tests/devlog.test.ts` › "finds logging gaps"
  - `tests/cases.test.ts` › "records a part payment, recalculates the balance exactly, and passes the case to a person or plan"
  - `tests/appointments.test.ts` › "counts a group member's load by their own calendar day"
  - `tests/alerts.test.ts` › "sends once when two sweeps run at the same moment, and the second does not take a send still under way for a crash"

### L-023: Keep every branch accountable to the plan, and the trunk as the default
- **Seen:** 2 times. The repository's default branch on GitHub was still the first session branch (`claude/elegant-fermat-er13o8`), long merged, so clones and the GitHub page showed stale code; seven merged branches were never deleted; and nothing checked that a branch belonged to the plan (found by the dev Control Tower branch audit, 2026-10-10). A cloud session could not delete merged branches when asked: the git proxy refuses deletes and no GitHub tool deletes a branch, so a workflow now does it ([#20](https://github.com/skchiew-bot/voicelab2/pull/20)).
- **Rule:** Every branch is either named for a plan phase or carries a PR titled with one. A branch justified only by a board task is listed for the owner to confirm, and anything else is a fork; never create or link a task just to clear the warning. The default branch is `main`. Deleting branches and changing the default are the owner's calls: report them, never do them unasked. Merged `claude/` branches are deleted on merge by the `delete-merged-branches` workflow; when the owner asks, run that workflow (a cloud session cannot delete a branch with git).
- **Guards:**
  - `tests/devlog.test.ts` › "classes every branch as the trunk, part of the plan, task-only or a fork"
  - `tests/devlog.test.ts` › "runs no audit and flags nothing when the trunk cannot be found"
  - `.github/workflows/delete-merged-branches.yml` › "Refusing to delete the default branch."

### L-024: A check the checked party can pass by itself proves nothing
- **Seen:** 2 times. The first branch audit counted any branch linked to a board task as part of the plan, and its instructions told sessions to link a task to clear the fork warning: a session could invent a task and approve its own branch (independent review, 2026-10-10). Any admin could add a second admin through the API and use it to approve their own flow change, policy or knowledge version, since the "different person" checks compare user ids (Phase 0 independent review, 2026-10-10).
- **Rule:** When a check guards against the agent's own work drifting, the agent must not be able to satisfy it alone. Show self-declared evidence (a task link) as its own class for the owner to confirm, and never create evidence just to clear a warning.
- **Guards:**
  - `tests/devlog.test.ts` › "classes every branch as the trunk, part of the plan, task-only or a fork"
  - `CLAUDE.md` › "never create or link a task just to clear a warning"

  - `tests/staff-roles.test.ts` › "keeps an admin added by another admin out until a different admin approves them, so one admin cannot invent a second approver"
### L-025: Derived state is valid only for the thing it was derived from
- **Seen:** 2 times. A promoted script was looked up by workflow, node and language only, so after a deploy changed the node callers kept hearing the old script until a scheduled screen ran; a script learned in one journey context was spoken in every context; and the screen that looked for a changed node could be tripped by simulating an undeployed draft (Phase 6 independent review, 2026-10-10). A relay connection that resumed a call kept the question number it read when it connected; once a reply landed on the connection that had dropped, every later answer was refused as being for an earlier question and the caller was left in silence (live call voice link hardening re-review, 2026-10-10).
- **Rule:** Anything learned or derived from a definition (a script, a cache, a score) carries what it was derived from (here the node's hash and the journey context) and is used only when that still matches, checked at the point of use, not by a job that may not be running. A rehearsal of something undeployed never counts as evidence about what is live.
- **Guards:**
  - `tests/learning.test.ts` › "is not demoted by simulating a draft, but stops being spoken the moment a deploy changes its node"
  - `tests/learning.test.ts` › "speaks a script only in the journey context it was learned in"
  - `tests/relay.test.ts` › "a connection that carries on a call mid-reply catches up: it says the new question once the reply lands, and applies the answer after it"
  - `tests/relay.test.ts` › "a reconnect that arrives while a reply is being applied says the next question once it lands, without the caller speaking first"

### L-026: Record what a model cost, even when its answer is thrown away
- **Seen:** 2 times. The script distiller was asked before the check for an existing script, so a scan paid for model calls whose tokens were never written down; council tokens were lost when a person decided first (Phase 6 independent review, 2026-10-10). A live call's start or reply refused at its last step (the call had fallen back) threw away the model decisions it had paid for, and lines said again on a takeover were never counted as speech (live call voice link hardening re-review, 2026-10-10).
- **Rule:** Check whether the answer is needed before asking a model, and record the model, tier and tokens of every call that is made, in its own step, whether or not the answer is used.
- **Guards:**
  - `tests/learning.test.ts` › "does not ask a model to write a script for a node that already has one in review, and refuses to approve a script that fails the rules"
  - `tests/relay.test.ts` › "records what a model cost on a start refused because the call fell back meanwhile"

### L-027: A human override must pass the same rule checks as the automatic path
- **Seen:** A person could approve a script that the rule checks had already failed, and the approval was reported as an error after it had committed (Phase 6 independent review, 2026-10-10).
- **Rule:** Re-run the deterministic checks inside any manual approval, and report a failure after a committed step as a warning on the committed result, not as a failed request.
- **Guards:**
  - `tests/learning.test.ts` › "does not ask a model to write a script for a node that already has one in review, and refuses to approve a script that fails the rules"
  - `tests/learning.test.ts` › "leaves a low-confidence pass for a person, who can approve it; it stays approved, still live, until its audio exists"

### L-028: Measure a promised time from the promise, not from the last time it was moved
- **Seen:** 3 times. A callback held back by a quiet hour or a call limit had its time overwritten, so the lateness limit was measured from the new time and a callback locked for 11:00 could be placed days later (Phase 7 independent review, 2026-10-10). The case dispatcher, now a scheduled job, placed at most twenty callbacks a minute, so a backlog locked to one time would have been missed (Phase 0 scheduler independent review, 2026-10-10). A case callback after a caller hung up waiting for a person was locked to 15 minutes on, inside the contact's minimum gap, so the dispatcher would have held it back past its lateness and missed it (PR [#39](https://github.com/skchiew-bot/voicelab2/pull/39) independent review, carried into [#41](https://github.com/skchiew-bot/voicelab2/pull/41), 2026-10-11).
- **Rule:** Keep the time something was promised for separate from when it is next tried. Deferring changes the second, never the first, and anything past its allowed lateness is missed, however many times it was held back.
- **Guards:**
  - `tests/cases.test.ts` › "measures lateness from the time a callback was locked to, however long it was held back"
  - `tests/scheduler.test.ts` › "works through a backlog in batches while each batch is full, and stops at its bound"
  - `tests/transfer.test.ts` › "locks a case callback to when it can really be placed: after the minimum gap since the call just ended, or leaves a request when the calls allowed today are used"

### L-029: An event can arrive before the record that expects it
- **Seen:** 4 times. A provider's end-of-call report was processed before the dispatcher had recorded the call against its case, so the outcome was dropped and the retry chain stopped for good (Phase 7 independent review, 2026-10-10). A relay connection that arrived while another was still starting the call stood by and never looked again, so if the starter died the caller heard silence; and a start that finished after the call had already fallen back still wrote a run (live call voice link re-check, 2026-10-10). Costing the agent leg of a transfer: the call's end can be reported before the end of the dial that says how long the agent's leg lasted, and the call's end can come before Twilio asks what to do after the relay; the cost now waits for the dial's report and is priced when it lands, and the callback is recorded once whichever comes first (transfer follow-ups, 2026-10-10). Whether a caller on a case who hung up while the agent's phone rang got the case callback depended on which of Twilio's reports came first; with the whisper on and no 1 pressed, the call's end is now read as a hang-up whichever comes first (transfer follow-ups re-review, 2026-10-11).
- **Rule:** When a record is written after a call to an outside system, look at whether the outside system has already reported by the time it is written, and settle it then. Never rely on the order in which two requests commit. Anything waiting for another request's record looks again on a timer, and a decision already given (a fallback) is checked again when the late record is written.
- **Guards:**
  - `tests/cases.test.ts` › "does not lose the outcome of a call the provider reported over before it was recorded"
  - `tests/relay.test.ts` › "does not leave a standing-by connection silent when the one starting the call dies, and a late start then writes nothing"
  - `tests/transfer.test.ts` › "costs the agent leg in the one cost record of the call, exactly, with credits only for the time of the caller"
  - `tests/transfer.test.ts` › "records the callback once when the call ends before Twilio asks what next, or at the same moment"
  - `tests/transfer.test.ts` › "calls a caller on a case back after they hang up waiting for a person: in a quarter of an hour, or when quiet hours end"

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
- **Seen:** 4 times. A policy "deny when over 1000" let an action through when the amount was missing or unreadable, because the workflow condition language reads an unknown variable as false, so the deny was skipped and a plain allow won; banned phrases slipped past a curly apostrophe; an approved policy nobody could withdraw blocked every later change (Phase 7 knowledge independent review, 2026-10-10). A telephony provider an operator forced to fail over could never come back, because nothing probes telephony providers (Control Tower actions independent review, 2026-10-10). Deciding whether a later call had served the caller, a condition `transfer_status = 'answered'` was NULL for a call with no transfer, so `NOT (… OR NULL)` made `NOT EXISTS` pass and a call cut off mid-conversation counted as served; found by the test written first (transfer follow-ups, 2026-10-11). The fix still read a call with no workflow run at all (a voicemail on a dispatcher's retry, a caller who gave up in the queue) as served, because `NOT EXISTS` over an empty set passes; served now needs positive evidence (an agent pressed 1, or an end that says the contact was reached) (transfer follow-ups review, 2026-10-11).
- **Rule:** Where a check guards something (a policy, a gate), judge conditions three-valued: unknown on a deny counts as deny, unknown on an allow counts as not allowed. Normalise text before matching it, and give every stuck state a recorded way out. In SQL, wrap a nullable column in `coalesce` inside any `NOT`, so unknown never reads as a pass.
- **Guards:**
  - `tests/knowledge-policy.test.ts` › "denies when the variable a deny rule depends on is missing or unreadable, and does not allow on a condition it cannot judge"
  - `tests/knowledge-policy.test.ts` › "catches a banned phrase written with a curly apostrophe or zero-width marks, and refuses a phrase with no words"
  - `tests/knowledge.test.ts` › "lets a wrong proposal be withdrawn, with a reason, so it never blocks every later change; and a refused number is free again"
  - `tests/control-actions.test.ts` › "fails the provider over at once, logs it as an operator's failover, and lets it earn its way back like any other"
  - `tests/transfer.test.ts` › "keeps it when the later call did not reach them: a third party, a cut-off call, a voicemail on an unscreened dial, or no conversation at all"

### L-033: One figure, one definition: reuse the code that already counts it
- **Seen:** The Control Tower's deliverability panel counted contacts again instead of reusing the Outbound screen's count, so it counted every outcome row instead of each call's latest, mixed two time windows, and could show a different contact rate from the screen it linked to; its stitching total was summed from only the twenty busiest workflows (Control Tower panels independent review, 2026-10-10).
- **Rule:** When a new view shows a figure another part of the system already works out, call that code. Do not write a second query. Work out totals over everything, not over the rows a list happens to show, and test that the two places agree.
- **Guards:**
  - `tests/control-tower-panels.test.ts` › "count dials and outcomes as the Outbound screen does: finished dials only, each call's latest outcome, and no outcome as unknown"
  - `tests/control-tower-panels.test.ts` › "count every workflow in the stitching totals, not just the twenty it lists, and credit a child workflow's lines to it"

### L-034: Read operator input strictly; a value that does not parse is refused, never a default
- **Seen:** The dialling pace box sent `Number("1,000")`, which is `NaN`; JSON turned it into `null`, which means "no limit", so an operator trying to set a limit would have removed every limit and been told it was done (Control Tower actions independent review, 2026-10-10).
- **Rule:** Parse what a person types against the exact form you expect and refuse anything else with a message. Never let a value that failed to parse fall through to an empty, null or default meaning, especially one that loosens a safeguard.
- **Guards:**
  - `tests/admin-ui.test.ts` › "takes an action from the Control Tower only with a reason, and shows it in the change log"

### L-035: Run an install or a deploy for real; a file that validates can still fail to start
- **Seen:** 3 times. The Docker install had a compose file that validated, but it was never run. The first real run (Phase 0, 2026-10-10) crashed on a fresh install: the compose file passes `PUBLIC_BASE_URL` as an empty string, and the settings check refused it. Running the installer a second time to upgrade then failed with a raw database error, because the first admin already existed. A fresh cloud container had no `voicelab` test role and no installed dependencies, and Postgres was stopped after every restart; each session set them up by hand, and the first `npm test` failed before testing any code (2026-10-10). The script that now sets them up first held its lock on a descriptor the Postgres server it started inherited, so every later run would have waited out its time limit; the tests with stand-in commands passed, and only running it for real showed it (2026-10-10).
- **Rule:** Before calling an install, deploy or start-up path done, run it from nothing and run it again on top of itself. Treat a setting left empty as not set, and make every step safe to repeat. A script that holds a lock closes it for anything it starts that keeps running (a server).
- **Guards:**
  - `tests/config.test.ts` › "starts with a setting left empty by the install file, as if it were not set"
  - `tests/staff-roles.test.ts` › "creates the first admin once, and running it again to upgrade changes nothing"
  - `tests/fresh-container.test.ts` › "sets up a fresh container: starts Postgres, creates the test role with only the rights the tests need, installs the dependencies, and does nothing when run again"

### L-036: Choose the scope of a protective record on purpose, never from a screen-wide default
- **Seen:** The tenant switcher pre-filled the do-not-call form with the chosen client, so a national list pasted while a client was chosen would have been stored as that one client's opt-outs, and every other client could still dial those numbers (Phase 0 independent review, 2026-10-10).
- **Rule:** A menu-wide choice may decide what a screen shows, never what a record protects or who it belongs to. Forms that create do-not-call entries, numbers or workflows start empty and are chosen each time.
- **Guards:**
  - `tests/admin-ui.test.ts` › "follows one chosen client across screens and reloads, and forgets a client that no longer exists"

### L-037: A test must not depend on the time of day it runs
- **Seen:** 2 times. A cases test reset the contact policy to its default quiet hours (21:00 to 08:00 in Kuala Lumpur) and then expected a dial to be allowed, so it passed all day and failed every evening; it surfaced on `main` after merging #25, #26 and #28 at 21:40 Kuala Lumpur time (2026-10-10). A do-not-call test checked that no event held the fragment "6012", which a timestamp's microseconds can contain, so it failed now and then (found while running the full suite for the scheduler, 2026-10-10).
- **Rule:** Build every time-based expectation from a clock the test controls, or from windows worked out relative to the current time (as the test does for the "quiet now" case). Never assume the suite runs during office hours or in one time zone.
- **Guards:**
  - `tests/cases.test.ts` › "applies quiet hours and limits to the gate API too, in the contact's zone"
  - `tests/dnc.test.ts` › "records dial.blocked with the reason, and dial.allowed otherwise"

### L-038: Catch an intermittent failure's own error text before guessing at its cause
- **Seen:** 2 times. For a whole day a test file was sometimes marked failed with every test in it passing (about 1 run in 6). Guesses (hook timeouts, unhandled errors) went nowhere because the run's output was never kept; looping the suite with the output saved caught it: dropping the test database with `WITH (FORCE)` could not end an autovacuum worker the server was running there, "permission denied to terminate process" (Control Tower email alerts work, 2026-10-10). Test teardown ended a database's pool and force-dropped the database at once, while the server was still closing those connections: FORCE killed them mid-close, and each sent back an error nothing listened for, failing a run in which every test passed (about 5 drops in 100; the server log named the databases, found running the full suite for the fresh-container setup, 2026-10-10).
- **Rule:** When a failure will not reproduce on demand, keep the full output of every run until it happens again, and read the error before changing anything. Test teardown that drops a database retries when the server's own background work is in the way. Before dropping a database, wait for its own connections to finish closing; ending a pool does not wait for the server.
- **Guards:**
  - `tests/helpers.test.ts` › "drops a test database even when the server's own worker is still in it, and stops on any other error"
  - `tests/helpers.test.ts` › "waits for the database's own connections to finish closing before force-dropping it, so none is killed mid-close"

### L-039: Judge a failure by what happened, not by one name for it
- **Seen:** The live call voice link first treated only the outcome `error` as a broken workflow. A client's system failing ends a run as `integration_failed`, so the caller would have been left in silence and the call hung up, with no callback recorded (found by the relay's own failure test, 2026-10-10). The relay then read every "refused" answer from a run as harmless, so a reply left half-applied by a stopped server left the caller in silence on every turn (live call voice link independent review, 2026-10-10). A connection that took over or resumed a run another had abandoned, or one that ended with an error, read it as a finished call and hung up in silence with no callback; and a standby whose look failed outright swallowed the error and said nothing (live call voice link hardening review, 2026-10-10).
- **Rule:** Decide that something failed from the record of the failure (here, an error was recorded on the run), not from a list of outcome names that a new kind of failure can miss. Test the path with a failure of a different kind from the one you had in mind.
- **Guards:**
  - `tests/relay.test.ts` › "never leaves the caller in silence when the workflow fails: records a callback first, says the holding message, and ends"
  - `tests/relay.test.ts` › "falls back, once, when a reply was left half-applied by a server that stopped"
  - `tests/relay.test.ts` › "gives the caller the fallback, not silence, when the connection starting the call drops and its start then lands and is abandoned"
  - `tests/relay.test.ts` › "gives the fallback to a connection that takes over or resumes a run that broke or was abandoned"
  - `tests/relay.test.ts` › "a connection standing by falls back, never goes silent, when its look fails outright"

### L-040: Never hold a pooled connection while waiting for another from the same pool
- **Seen:** The live call voice link took a lock on its own pooled connection and then needed more connections to start the call, so ten calls answered at once took every connection and all waited for ever; every route of the server hung, and the pool had no time limit to break it (live call voice link independent review, 2026-10-10).
- **Rule:** Take a lock inside the transaction that does the work (`pg_advisory_xact_lock`, `FOR UPDATE`), or claim the work in one short transaction and do it after; never keep a connection while another is fetched. The pool gives up after a time limit instead of waiting for ever. Test with more simultaneous requests than the pool has connections.
- **Guards:**
  - `tests/relay.test.ts` › "does not hang the server when more calls are answered at once than it has database connections"

### L-041: A signature shared by every request proves who sent it, not what it may touch
- **Seen:** Twilio signs the relay's bare address, so every relay connection to a provider carries the same signature; anyone who saw it once could open connections at will and attach to a call whose ids they knew (live call voice link independent review, 2026-10-10).
- **Rule:** When a provider's signature does not cover the thing being acted on, add a key of your own for that thing (here, one made for each call and handed to the provider in the TwiML), and refuse anything without it.
- **Guards:**
  - `tests/relay.test.ts` › "serves no call it is not: the id of another call, the wrong Twilio call, a malformed id, or a missing or wrong call key ends the line and starts nothing"

### L-042: Background work stops when asked and gives back what it holds
- **Seen:** 2 times. The first scheduler kept running every remaining job and client after a shutdown began, so a deploy would have been killed part-way through provider work (Phase 0 scheduler independent review, 2026-10-10). Its lock was then held on a pooled connection for the whole run, while the job took more connections from the same pool (lesson L-040, found on merging main, 2026-10-10). A second review of the lease found that a run which outlived its lease still wrote the job's status over the newer run, so a running job showed as finished; nothing bounded a run, so a stuck job could stop every other job on its server and hold up shutdown for ever; and "run now" during a dead server's lease said it was done while nothing would run for up to two days (Phase 0 scheduler lease review, 2026-10-10).
- **Rule:** A loop of background work checks a stop flag before each unit of work, and counts what it did not reach as not done. Hold nothing across the work: claim it with a lease in one short statement, give the lease back when done, and let a dead worker's lease run out. Only the holder of the lease writes the shared status. Give every unit of work a deadline shorter than the lease, and give stopping a grace period; refuse a request that would quietly wait on a lease.
- **Guards:**
  - `tests/scheduler.test.ts` › "on stop, starts no further job or client and waits only for the one running; the clients not reached make the run partly"
  - `tests/scheduler.test.ts` › "holds no database connection while a job runs, so a job can use every connection there is"
  - `tests/scheduler.test.ts` › "runs a job again once the lease of a server that died mid-run has run out, and not before"
  - `tests/scheduler.test.ts` › "lets a run that outlived its lease record itself, but never report the newer run as finished or give back its lease"
  - `tests/scheduler.test.ts` › "gives up waiting for a run past its deadline, records it as failed, and keeps the lease since the work may still be going"
  - `tests/scheduler.test.ts` › "stops within its grace period even when a run is stuck, leaving that run unfinished"

### L-043: Take a person's words as an answer only to a question they heard
- **Seen:** 2 times. A relay connection that took a call over applied the caller's first words as the answer to a question that had gone to the connection that dropped, so a "yes" could become consent to something never heard; words said over the greeting were taken as the answer to the first question (live call voice link hardening review, 2026-10-10). Then a connection that took a call over by its timer still applied words that had arrived while it was doing so (live call voice link hardening re-review, 2026-10-10).
- **Rule:** Apply an answer only to a question this side knows was put to the person on the line they are on. When that is in doubt (a takeover, words that arrived before the question was sent), ask again instead of applying them.
- **Guards:**
  - `tests/relay.test.ts` › "lets a standing-by connection take the call over once the run exists: it says the last lines again, recordings included, and does not apply words said before the caller heard them"
  - `tests/relay.test.ts` › "does not take words that arrived before the first question was asked as its answer"

### L-044: A line picking up is not a person answering
- **Seen:** The first live transfer counted any answered dial to the agent as reaching a person, so an agent's voicemail would have taken the caller, with no callback; a repeated request after the agent number was removed hung up on the caller (human transfer independent review, 2026-10-10).
- **Rule:** When a step depends on a person being there, get a sign only a person gives (here, pressing 1 after the whisper) and record it; judge the outcome from that record, not from the line's status. Every path that ends a caller who asked for a person runs the callback ladder.
- **Guards:**
  - `tests/transfer.test.ts` › "does not take a voicemail on the agent phone for a person: a dial no one took with 1 runs the callback ladder"
  - `tests/transfer.test.ts` › "runs the ladder when Twilio asks again after the agent number was removed"

### L-045: A failing check must stop the commit
- **Seen:** A test run, the board update and the commit were joined with `;`, so a broken `src/progress.ts` (an unescaped apostrophe) was committed and pushed while the run reported a failure (human transfer, 2026-10-10).
- **Rule:** Join the checks and the commit with `&&`, never `;`, and read the result before pushing. A failure you cannot explain is read from its kept output before anything else (L-038).
- **Guards:**
  - `CLAUDE.md` › "so a failing check stops the commit"

### L-046: An answer must not tell the asker about anything they cannot see
- **Seen:** Emails were unique across the whole platform, so a client admin adding a user learned from "already exists" whether an email belonged to staff or to another client (client portal independent review, 2026-10-10).
- **Rule:** Scope every uniqueness rule, error and count a user can trigger to the data that user may see. Where a clash outside that scope cannot be avoided, answer as if nothing were there.
- **Guards:**
  - `tests/portal.test.ts` › "tells a client admin nothing about emails outside their own client: another client's user or a member of staff is a new user here"

### L-047: Prove a security boundary by listing everything that crosses it
- **Seen:** The client role's limits were tested by naming a few tables it must not read, so a later grant would have passed unnoticed; and the portal's first `/client/me` read the client's name as the owner role, outside the client role it was meant to run as (client portal independent review, 2026-10-10).
- **Rule:** Test a boundary with the exact list of what may cross it (every table, view and owner-rights function a role can reach), compared in full, so anything added fails the test until someone decides it belongs. Code on the client side of the line runs as the client role, every time.
- **Guards:**
  - `tests/portal.test.ts` › "lets the client role reach exactly what the portal needs, and nothing a later migration quietly adds"

### L-048: A second leg of a call spends money and a channel: cost it and count it like the first
- **Seen:** The first live transfer rang the client's agent as a second leg of the caller's call, which Twilio bills separately and which holds a second channel, but neither its cost nor its channel was counted anywhere (PR [#36](https://github.com/skchiew-bot/voicelab2/pull/36), raised by the owner, 2026-10-10). The first costing of it then priced the agent leg with every outbound or any-direction component (a speech-relay charge, a per-call fee) and recorded it as free when only an inbound rate existed (transfer follow-ups independent review, 2026-10-10). Checking the two legs against Twilio as one total let an error on one leg hide behind an opposite error on the other (transfer follow-ups re-review, 2026-10-11).
- **Rule:** Anything that makes a provider open another leg or channel goes through the same capacity decision (the `capacity` lock and `providerLoad`) and the same cost record (`recordCallCost`, one record per call) as a call does. Mark each line with the leg it prices, so a check against the provider compares like with like. Price a leg only with the rates that are its own, and refuse a leg with time on it and no rate, never record it as free. Check each leg against the provider on its own, never only as a total.
- **Guards:**
  - `tests/transfer.test.ts` › "counts the agent leg against the ceiling of the provider, and runs the ladder instead of dialling when the provider is full"
  - `tests/transfer.test.ts` › "costs the agent leg in the one cost record of the call, exactly, with credits only for the time of the caller"
  - `tests/transfer.test.ts` › "prices the agent leg only at its own telephony rate, refuses to call it free, and waits when its length is unknown"

### L-049: Limit where a stored setting can make us dial, when it is set and again at dial time
- **Seen:** The agent number for a transfer accepted any country, so a changed setting could have sent paid calls to an expensive destination abroad (toll fraud) (PR [#36](https://github.com/skchiew-bot/voicelab2/pull/36), raised by the owner, 2026-10-10). The first rule allowed any Malaysian number, including its premium and special-rate ranges; the review raised it, and I first named 1-900 as Malaysia's premium range from memory, where public listings put it on 600 and 1-600 (transfer follow-ups independent review, 2026-10-11). The owner then decided every +60 number may be an agent line, those ranges included (2026-10-11).
- **Rule:** A number we dial from a setting is checked against an allowlist of destinations when it is saved, by the database, and again just before the dial, so a value stored before the rule, or written by another path, is never rung. When a decision rests on facts about a numbering plan, take them from a published source, not memory.
- **Guards:**
  - `tests/transfer.test.ts` › "refuses an agent number outside Malaysia when it is set, and again at dial time for one stored before the rule"
