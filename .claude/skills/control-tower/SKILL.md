---
name: control-tower
description: The dev Control Tower, modelled on skchiew-bot/d3ngineering. Shows the owner how Claude Code is building Voice Lab - the task board, agent operations, quality, AI spend per model, governance, the incident register, stop-loss alerts and the lessons register that stops past mistakes from repeating. With no argument, refresh and publish the dashboard. With "lesson <what happened>", record a lesson with a guard. With "check", review the current diff against every lesson. Use when the user runs /control-tower, asks what has been done, what it cost or what went wrong, or wants a mistake recorded so it is not repeated.
argument-hint: "[dashboard | lesson <what happened> | check]"
---

# Dev Control Tower

This is the owner's view of the **development** of Voice Lab. It is not the product's Control Tower (the operations console in `BUILD_PLAN.md`, `admin/src/ControlTower.tsx`). A request to show or refresh the Control Tower ("show control tower") means this dashboard, by the owner's decision of 2026-10-11; for any other request that could mean either, ask (lesson L-014).

Pieces:
- `.claude/hooks/devlog.mjs`, wired in `.claude/settings.json`: logs each session's actions and failed actions to `devlog/.spool/`, which git ignores. It records the tool, a scrubbed file path or command description, and for a failure only a category (such as `exit 1` or `denied`), never content, prompts, error text, numbers or tokens.
- `scripts/devlog-flush.mjs`: moves new spool lines into new files under `devlog/activity/`, rebuilt from an allowlist of fields. Run it before every commit; the new files go in that commit.
- `devlog/lessons.md`: the lessons register, loaded into every session from `CLAUDE.md`. `tests/devlog.test.ts` fails if a lesson loses a guard.
- The same hook records each shell command's kind (test, typecheck, build, commit, push), subagents, and on every Stop the session's tokens per model and cost. It gathers every transcript of the session (a resume in another folder starts a new one that copies earlier messages), counts each message once, and adds Claude Code's latest checkpoint for each of its runs (a resume that restores Claude Code's cost state continues its run; one that cannot, such as a resume in another folder, starts a new run from zero) plus the messages after their run's last checkpoint, priced exactly from `devlog/control-tower.json`. It enforces the stop-loss budgets and wasted-effort checks from that file; they count consecutive failures of the same thing and ignore test runs marked `DEVLOG_EXPECT_RED=1`.
- `scripts/devlog-task.mjs`: the development control board (start, update, done), the incident register (`incident`) and the owner's decisions register (`decision --title … --on <day> --ref …`) and review verdicts for the routing view (`outcome`, below). Events go to the spool like everything else.
- The dashboard follows the D3ngineering blueprint and the Daythree design (`skchiew-bot/d3ngineering`, ADR-0012 and ADR-0013): overview, playback of every recorded step, board, cost (with the routing saving against `costEstimate.baselineModel`), quality and learning, governance and audit, and runner and pacing (not built yet). Its health checks never read green on an input they cannot read.
- Routing and escalation: each helper agent's model and tokens are what Claude Code recorded (one `AgentRun` per agent, written at every Stop); its process, task and escalation trigger are what the session declares in a tag, and its review verdicts what the session declares with `outcome`. The dashboard keeps the two apart and checks the declared against the recorded wherever a record exists. The floor and ceiling tier of each process, the escalation threshold, the shadow-review sampling and the proposed throttle bands are all in `devlog/control-tower.json` (`routing`, `throttle`); the owner's values there are marked for confirming for Voice Lab.
- Activity log integrity: each file in `devlog/activity/` is compared with the commit that first added it. A change is accepted only by the owner, recorded as a decision and listed in `integrity.acceptedChanges` of `devlog/control-tower.json` as `{ "<file>": { "blob": "<git hash-object of the accepted content, or null if deleted>", "decision": "DEC-…" } }`. Never add an entry the owner did not decide.
- `devlog/control-tower.json`: budgets, thresholds, model tiers, prices (with their source and date) and an optional RM rate. Change behaviour here, not in code.
- `devlog/prs.json`: each PR with its branch (`head`) and review findings (severity and whether fixed), extracted once per PR.
- `devlog/repo.json`: GitHub facts about the repository: default branch, number of forks, and each fork the session can read with its branches.
- `scripts/devlog-report.mjs` and the template `devlog/dashboard.html`: they build the dashboard from all of the above with no model call.

## Before anything else

Check the branch is current: `git fetch origin main && git rev-list --count HEAD..origin/main`. If it is behind, bring `main` in (merge; never rewrite someone else's history) before reporting anything (lesson L-013).

## `dashboard` (default)

0. **Refresh branches.** `git fetch --prune origin`, so the branch audit sees every branch on GitHub and none that were deleted.
1. **Update `devlog/prs.json`.** List the repository's PRs with the GitHub tools (`list_pull_requests`, state `all`). For each PR that is missing from the file, or whose state or merge time changed, add or update its entry: `number`, `title`, `state`, `html_url`, `created_at`, `merged_at`, `head` (the PR's branch name), `head_sha` (its head commit) and `findings`. Read `findings` from the PR body's "Independent review" table: one `{ "severity", "fixed" }` per row, using the severity as written (`"Unrated"` if there is none), and `fixed: false` when the outcome says it was left or not changed. A finding counts as fixed only when none of it was left: partly fixed, or partly put to the owner, is `fixed: false`. A row that only confirms something was checked and found fine is not a finding; leave it out. Count every review the body reports (a re-check, a merge review), and read the findings from the body even for an entry copied from another branch's file, so every entry follows these rules. Leave entries that have not changed alone. Write the file with a one-space indent, as it is, so its diff shows only what changed.
1b. **Update `devlog/repo.json`.** Read the repository with `search_repositories` and the query `repo:<owner>/<name>` (`minimal_output: false`): record `defaultBranch`, `forksCount`, `visibility` and `checkedAt`. GitHub forks belong to other accounts, outside this session's access: list a fork's branches (`list_branches`) only for forks already added to the session, into `forks` as `{ fullName, url, pushedAt, branches: [{ name, sha }] }`. Never add someone's fork to a session unasked: when the dashboard shows forks it could not inspect, ask the owner.
2. **Check the board and incidents.** Run `node scripts/devlog-task.mjs board`. Every task in flight should have a current status, progress and next step, and every branch on GitHub should be part of the plan. Link a branch to a task with `--branch` only when it really carries that task's work; never create or link a task just to clear a warning. Report forks and task-only branches to the owner, who decides whether to keep, link or retire them; every review finding or failure since the last run should be an incident tied to a lesson. Add what is missing.
3. **Check new lessons.** For every PR or commit since the last run that fixed a bug or a review finding, make sure `devlog/lessons.md` has a lesson for it, or extend that lesson's **Seen** line and count. Use `lesson` mode below for each new one.
4. **Build:** `node scripts/devlog-report.mjs --prs devlog/prs.json --html <scratchpad>/dev-control-tower.html`.
5. **Publish** it with the Artifact tool as an update to the owner's existing dashboard, https://claude.ai/artifact/VbV5a77oLkWRr5KpKRcnaH (pass it as `url`; read it first, as the tool requires), so the owner keeps one link. If that link no longer works, look for "Voice Lab Dev Control Tower" with `action: list` before publishing a new one.
6. **Commit and push** on the branch the session is working on (its designated branch, or the current phase branch): run `node scripts/devlog-flush.mjs`, then commit the changes to `devlog/` (lessons, PR data and the new activity files). Activity files are always new files, so they never conflict when branches merge.
7. **Report** in a few lines: what needs attention (from the top of the dashboard), spend since the last report, any stop-loss alerts or logging gaps, branches off the plan, merged branches left on GitHub, the default-branch check, GitHub forks, new lessons, and the link. Deleting a branch or changing the default branch is the owner's decision: report it, never do it unasked. If the dashboard shows a logging gap for this session (its hooks were not running), say so plainly.

## Routing tags and verdicts

Start every helper agent with a tag at the very start of the Agent `description`, so the dashboard can place its work:

- `[<process> <task-id>]`, where the process is one of `plan`, `review`, `security-review`, `build`, `fix`, `check` and the task id is a task on the board (for example `[build DCT-12] Add the report check`).
- When you start an agent on a higher tier than its process's floor, say why: ` esc:<trigger>` after the task id, with the trigger one of `review_failed`, `suite_failed`, `builder_blocked`, `deny_path_touched` (for example `[build DCT-12 esc:suite_failed] …`). Declare only the reason that is true; the dashboard shows whether a record supports it (a failed test run or an edit to a high-risk file the hooks logged, or a failed verdict you declared) and flags one that nothing supports.
- ` shadow` after the task id marks a cheaper-tier review run beside a primary review, only for `review` (for example `[review DCT-12 shadow] …`). Shadow reviews run only when the owner has switched them on in `routing.shadowReview`.
- Match the whole bracket exactly, in lower case, first in the description. Anything else is no tag: the agent is still counted, as not recorded. The description itself is never stored, only the process, task and trigger.

Record a review's verdict when it is known, with the agent's id (shown as `agent_id` in the agent's result):

`node scripts/devlog-task.mjs outcome <task-id> --process review --result passed|failed [--agent <agentId>] [--shadow-of <primary agentId>] [--round N]`

The task must already be on the board (`start` it first). `--shadow-of` needs `--process review` and `--agent`. Round 1 is the first review of the task. There is no command to declare an escalation: the dashboard reads a climb from the models Claude Code recorded.

The routing view then shows, per process: the items that finished at the floor tier, the share of items from the floor that climbed above it (amber only past `routing.escalationAlert`, over its minimum number of finished items; fewer than that are shown as collecting), the triggers given, and the tokens by tier. A process's first agent for an item that runs above the floor with a declared trigger counts as an escalation into that process (a fix on a higher tier after a failed review), judged against the item's previous agent of any process; the same agent with no trigger is a start above the floor. A "Routing notes" card counts, apart from escalations, the items that ran above the ceiling (a breach of the policy, which also raises a warning), started below or above the floor, or entered by escalation, with the first-pass review rate, the cost of the process and the weekly trend. The log shows the last 50 climbs and whether a record supports each trigger; "Recent helper agents" shows the last 20 with why each ran on its tier; "Declared versus recorded" counts the mismatches, including helper agents that started and left no Claude Code record. The cost view splits cost by process and model, with the main session worked out per session and sessions from before recording shown as one row (main session and helper agents together); its rows are priced from transcripts, so they can differ from Spend. Utilisation and the throttle bands are shown as not in use, since no runner exists. Never change a process's floor because the view turns amber: that is the owner's decision.

## `lesson <what happened>`

1. Find the root cause and the class of mistake, not just the instance. If an existing lesson covers the class, extend its **Seen** line, raise its count ("N times"), and add a guard if the new case isn't covered.
2. Otherwise add `### L-NNN: <the rule, as an instruction>` with **Seen** (with PR links), **Rule** and **Guards**.
3. A guard is a test that fails if the mistake returns. Write it if it doesn't exist, then break the code on purpose and watch it fail (lesson L-010). A lesson about process, with no code to test, is guarded by the hook, skill or `CLAUDE.md` text that enforces it.
4. Run `npx vitest run tests/devlog.test.ts`, then commit.

## `check`

Read the current diff (`git diff origin/main...HEAD`) against every lesson's **Rule**. For each lesson the diff could break, either confirm it holds (name the line or test) or fix it. Report as a short list: lesson, holds or fixed, and where.

## Prices and the RM rate

Prices in `devlog/control-tower.json` must come from a current source (the `claude-api` skill's model table, or Anthropic's pricing page); record the source and date with them, and never put prices in code. The RM rate is shown only when the owner sets `currency.myrPerUsd` with its date and source.

## Rules

- Never record prompt text, command text, command output, error text, phone numbers, credentials or customer details (names included) in `devlog/`, including in task and incident text (`--title`, `--impact`, `--action`, `--blocker`, `--next`). The scrubber catches numbers, emails and credentials, not names.
- The dashboard is internal to the owner. Publish it privately and do not share it.
- Never edit or delete a file in `devlog/activity/`; a correction is a new file.
- `--html` must point outside the repository (the scratchpad); the script refuses to overwrite its template.
