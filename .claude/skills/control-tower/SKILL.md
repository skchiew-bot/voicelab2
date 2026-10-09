---
name: control-tower
description: The dev Control Tower. Shows the owner how Claude Code is building Voice Lab (sessions, commits, PRs, review findings, failed actions) and the lessons register that stops past mistakes from repeating. With no argument, refresh and publish the dashboard. With "lesson <what happened>", record a new lesson with a guard. With "check", review the current diff against every lesson. Use when the user runs /control-tower, asks what has been done or what went wrong, or wants a mistake recorded so it is not repeated.
argument-hint: "[dashboard | lesson <what happened> | check]"
---

# Dev Control Tower

This is the owner's view of the **development** of Voice Lab. It is not the product's Control Tower (the operations console in `BUILD_PLAN.md`, `admin/src/ControlTower.tsx`). If a request could mean either, ask (lesson L-014).

Pieces:
- `.claude/hooks/devlog.mjs`, wired in `.claude/settings.json`: logs each session's actions and failed actions to `devlog/activity/<date>-<session>.jsonl`. It records file paths and command descriptions only, never content, prompts, numbers or tokens.
- `devlog/lessons.md`: the lessons register, loaded into every session from `CLAUDE.md`. `tests/devlog.test.ts` fails if a lesson loses a guard.
- `devlog/prs.json`: each PR with its review findings (severity and whether fixed), extracted once per PR.
- `scripts/devlog-report.mjs` and the template `devlog/dashboard.html`: they build the dashboard from all of the above with no model call.

## Before anything else

Check the branch is current: `git fetch origin main && git rev-list --count HEAD..origin/main`. If it is behind, bring `main` in (merge; never rewrite someone else's history) before reporting anything (lesson L-013).

## `dashboard` (default)

1. **Update `devlog/prs.json`.** List the repository's PRs with the GitHub tools (`list_pull_requests`, state `all`). For each PR that is missing from the file, or whose state or merge time changed, add or update its entry: `number`, `title`, `state`, `html_url`, `created_at`, `merged_at` and `findings`. Read `findings` from the PR body's "Independent review" table: one `{ "severity", "fixed" }` per row, using the severity as written (`"Unrated"` if there is none), and `fixed: false` when the outcome says it was left or not changed. Leave entries that have not changed alone.
2. **Check new lessons.** For every PR or commit since the last run that fixed a bug or a review finding, make sure `devlog/lessons.md` has a lesson for it, or extend that lesson's **Seen** line and count. Use `lesson` mode below for each new one.
3. **Build:** `node scripts/devlog-report.mjs --prs devlog/prs.json --html <scratchpad>/dev-control-tower.html`.
4. **Publish** it with the Artifact tool as an update to the owner's existing dashboard, https://claude.ai/artifact/VbV5a77oLkWRr5KpKRcnaH (pass it as `url`; read it first, as the tool requires), so the owner keeps one link. If that link no longer works, look for "Voice Lab Dev Control Tower" with `action: list` before publishing a new one.
5. **Commit and push** any changes to `devlog/` (lessons, PR data, this session's activity log).
6. **Report** in a few lines: what needs attention (from the top of the dashboard), any new lessons, and the link.

## `lesson <what happened>`

1. Find the root cause and the class of mistake, not just the instance. If an existing lesson covers the class, extend its **Seen** line, raise its count ("N times"), and add a guard if the new case isn't covered.
2. Otherwise add `### L-NNN: <the rule, as an instruction>` with **Seen** (with PR links), **Rule** and **Guards**.
3. A guard is a test that fails if the mistake returns. Write it if it doesn't exist, then break the code on purpose and watch it fail (lesson L-010). A lesson about process, with no code to test, is guarded by the hook, skill or `CLAUDE.md` text that enforces it.
4. Run `npx vitest run tests/devlog.test.ts`, then commit.

## `check`

Read the current diff (`git diff origin/main...HEAD`) against every lesson's **Rule**. For each lesson the diff could break, either confirm it holds (name the line or test) or fix it. Report as a short list: lesson, holds or fixed, and where.

## Rules

- Never record prompt text, command text, command output, phone numbers, credentials or customer data in `devlog/`.
- The dashboard is internal to the owner. Publish it privately and do not share it.
- Keep `devlog/activity/` files append-only: never edit or delete another session's log.
