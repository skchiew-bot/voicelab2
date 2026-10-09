---
name: control-tower
description: Check or build the Control Tower, Voice Lab's internal operations console. With no argument, report which Control Tower panels and alerts are due for the phases built so far, which exist, and what is missing. With "build <panel>" (for example "build funding"), build that panel end to end. Use when the user runs /control-tower or asks about Control Tower progress, panels or alerts.
argument-hint: "[status | build <panel>]"
---

# Control Tower

The Control Tower is defined in `BUILD_PLAN.md`, under "Control Tower Workstream". That section is the source of truth for the panels, their actions, the phase each one ships in, the alerts and the exit criteria. Read it on every run; do not work from memory of it. Each phase is done only when its Control Tower slice ships too (Phase Overview table).

## Status (no argument, or `status`)

1. Read the Phase Overview table and each phase's **Status** block in `BUILD_PLAN.md` to see which phases are started.
2. For every panel due in a started phase, check the code, not the plan's prose:
   - an internal read endpoint in `src/app.ts` (under `/internal/`),
   - a view in `admin/src/` reachable from `admin/src/App.tsx`,
   - each listed action wired to an existing API, and audited,
   - coverage in `tests/` (a database test for the data, `tests/admin-ui.test.ts` for the view).
3. Do the same for the alerts due so far and for the Control Tower shell and tenant switcher (Phase 0).
4. Report a table: panel, phase, built / partial / missing, and what is missing. Then say which of the four exit-criteria questions ("Are calls healthy? Are we funded? Are we making money on campaign X? Is anything about to break?") an operator can answer from one screen today.

Make no code changes in status mode.

## Build (`build <panel>`)

Build one panel at a time, in this order:

1. **Data.** Add or reuse an internal read query in `src/store/`. The Control Tower only reads from the call-event log, the ledgers and the registries. If the data is not recorded yet, the panel is blocked on its phase; say so rather than inventing a source.
2. **API.** Add the endpoint under `/internal/` in `src/app.ts`, staff only, like the existing internal routes. Never expose it under `/client/`.
3. **Actions.** An action (pause, drain, acknowledge, record a top-up, roll back) calls the same store function and approval rule as the existing API, and writes to the audit log with who and why (`src/store/audit.ts`). Actions marked "requires approval" in the plan must not take effect without one. Each action must show up in the change log panel once that exists.
4. **View.** Add the panel to the admin console (`admin/src/`), using the shared components in `admin/src/ui.tsx` and the API client in `admin/src/api.ts`.
5. **Tests.** Prove the query and the endpoint in a database test, and drive the view in `tests/admin-ui.test.ts`. If the panel touches cost, margin or funding, extend `tests/foundations.test.ts` (or add an equivalent) so a `voicelab_client` actor cannot read it.
6. **Plan.** Update the phase's **Status** block in `BUILD_PLAN.md` to say the panel is built.
7. Run `npm run typecheck`, `npm test` and `npm run build:admin` before committing.

## Rules that bite here

- The Control Tower is internal only. Provider cost, FX, rate cards, margin, funding and do-not-call data never reach client-facing code or the client portal.
- Money is exact: show amounts from `src/money.ts` / `src/billing.ts` values, formatted as strings, never recomputed in floating point in the browser.
- Never show a customer phone number. Our own numbers (`phone_numbers`) may be shown; provider error text goes through `redactNumbers` first.
- Show whether a cost record is estimated or reconciled once that state exists.
- Live panels use server-sent events or WebSocket (see the stack table in `BUILD_PLAN.md`); polling is acceptable only as a stated stopgap.
- Any model call a panel triggers follows the model-selection table in `CLAUDE.md`, with the model read from config and tokens logged.
