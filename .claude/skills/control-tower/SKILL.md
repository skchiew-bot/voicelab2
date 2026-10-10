---
name: control-tower
description: The dev Control Tower, modelled on skchiew-bot/d3ngineering. Shows the owner how Claude Code is building Voice Lab - the task board, agent operations, quality, AI spend per model, governance, the incident register, stop-loss alerts and the lessons register that stops past mistakes from repeating. With no argument, refresh and publish the dashboard. With "lesson <what happened>", record a lesson with a guard. With "check", review the current diff against every lesson. Use when the user runs /control-tower, asks what has been done, what it cost or what went wrong, or wants a mistake recorded so it is not repeated.
argument-hint: "[dashboard | lesson <what happened> | check]"
---

# Dev Control Tower

This is the owner's view of the **development** of Voice Lab. It is not the product's Control Tower (the operations console in `BUILD_PLAN.md`, `admin/src/ControlTower.tsx`). If a request could mean either, ask (lesson L-014).

Pieces:
- `.claude/hooks/devlog.mjs`, wired in `.claude/settings.json`: logs each session's actions and failed actions to `devlog/.spool/`, which git ignores. It records the tool, a scrubbed file path or command description, and for a failure only a category (such as `exit 1` or `denied`), never content, prompts, error text, numbers or tokens.
- `scripts/devlog-flush.mjs`: moves new spool lines into new files under `devlog/activity/`, rebuilt from an allowlist of fields. Run it before every commit; the new files go in that commit.
- `devlog/lessons.md`: the lessons register, loaded into every session from `CLAUDE.md`. `tests/devlog.test.ts` fails if a lesson loses a guard.
- The same hook records each shell command's kind (test, typecheck, build, commit, push), subagents, and on every Stop the session's tokens per model and cost. It gathers every transcript of the session (a resume in another folder starts a new one that copies earlier messages), counts each message once, and adds Claude Code's latest checkpoint for each of its runs (a resume that restores Claude Code's cost state continues its run; one that cannot, such as a resume in another folder, starts a new run from zero) plus the messages after their run's last checkpoint, priced exactly from `devlog/control-tower.json`. It enforces the stop-loss budgets and wasted-effort checks from that file; they count consecutive failures of the same thing and ignore test runs marked `DEVLOG_EXPECT_RED=1`.
- `scripts/devlog-task.mjs`: the development control board (start, update, done) and the incident register (`incident`). Events go to the spool like everything else.
- `devlog/control-tower.json`: budgets, thresholds, model tiers, prices (with their source and date) and an optional RM rate. Change behaviour here, not in code.
- `devlog/prs.json`: each PR with its branch (`head`) and review findings (severity and whether fixed), extracted once per PR.
- `devlog/repo.json`: GitHub facts about the repository: default branch, number of forks, and each fork the session can read with its branches.
- `scripts/devlog-report.mjs` and the template `devlog/dashboard.html`: they build the dashboard from all of the above with no model call.

## Before anything else

Check the branch is current: `git fetch origin main && git rev-list --count HEAD..origin/main`. If it is behind, bring `main` in (merge; never rewrite someone else's history) before reporting anything (lesson L-013).

## `dashboard` (default)

0. **Refresh branches.** `git fetch --prune origin`, so the branch audit sees every branch on GitHub and none that were deleted.
1. **Update `devlog/prs.json`.** List the repository's PRs with the GitHub tools (`list_pull_requests`, state `all`). For each PR that is missing from the file, or whose state or merge time changed, add or update its entry: `number`, `title`, `state`, `html_url`, `created_at`, `merged_at`, `head` (the PR's branch name) and `findings`. Read `findings` from the PR body's "Independent review" table: one `{ "severity", "fixed" }` per row, using the severity as written (`"Unrated"` if there is none), and `fixed: false` when the outcome says it was left or not changed. Leave entries that have not changed alone.
1b. **Update `devlog/repo.json`.** Read the repository with `search_repositories` and the query `repo:<owner>/<name>` (`minimal_output: false`): record `defaultBranch`, `forksCount`, `visibility` and `checkedAt`. GitHub forks belong to other accounts, outside this session's access: list a fork's branches (`list_branches`) only for forks added to the session, into `forks` as `{ fullName, url, pushedAt, branches: [{ name, sha }] }`. The dashboard flags forks it could not inspect.
2. **Check the board and incidents.** Run `node scripts/devlog-task.mjs board`. Every task in flight should have a current status, progress and next step, and every branch on GitHub should be part of the plan: a branch the report calls a fork needs a board task linked with `--branch`, or the owner's decision to retire it; every review finding or failure since the last run should be an incident tied to a lesson. Add what is missing.
3. **Check new lessons.** For every PR or commit since the last run that fixed a bug or a review finding, make sure `devlog/lessons.md` has a lesson for it, or extend that lesson's **Seen** line and count. Use `lesson` mode below for each new one.
4. **Build:** `node scripts/devlog-report.mjs --prs devlog/prs.json --html <scratchpad>/dev-control-tower.html`.
5. **Publish** it with the Artifact tool as an update to the owner's existing dashboard, https://claude.ai/artifact/VbV5a77oLkWRr5KpKRcnaH (pass it as `url`; read it first, as the tool requires), so the owner keeps one link. If that link no longer works, look for "Voice Lab Dev Control Tower" with `action: list` before publishing a new one.
6. **Commit and push** on the branch the session is working on (its designated branch, or the current phase branch): run `node scripts/devlog-flush.mjs`, then commit the changes to `devlog/` (lessons, PR data and the new activity files). Activity files are always new files, so they never conflict when branches merge.
7. **Report** in a few lines: what needs attention (from the top of the dashboard), spend since the last report, any stop-loss alerts or logging gaps, branches off the plan, merged branches left on GitHub, the default-branch check, GitHub forks, new lessons, and the link. Deleting a branch or changing the default branch is the owner's decision: report it, never do it unasked. If the dashboard shows a logging gap for this session (its hooks were not running), say so plainly.

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
