# Voice Lab

Provider-agnostic voice orchestration platform. See `BUILD_PLAN.md` for the plan and `CLAUDE.md` for working rules.

## Install (operator)

Needs Docker and openssl.

```
./scripts/setup.sh admin@yourcompany.com
```

This writes `.env` with fresh secrets, starts Postgres and the app, runs a health check and creates the first admin. The admin's API token is printed once. **Back up `.env`**: without `VOICELAB_SECRET_KEY`, stored provider credentials cannot be read.

After setup, the admin console is at <http://localhost:3000/admin/>. Sign in with the admin token.

## Develop

```
npm install
cp .env.example .env      # fill in DATABASE_URL and VOICELAB_SECRET_KEY
npm run migrate
npm run bootstrap -- you@example.com
npm run dev               # API on :3000
npm run build:admin       # then the console is served at /admin/
npm run dev:admin         # or run the console with hot reload (proxies to :3000)
npm test                  # needs a local Postgres; see tests/helpers.ts
npm run typecheck
```

## Calls

Set `PUBLIC_BASE_URL` (the https address providers use to reach this server), then point each provider at it:

- **Twilio:** the TwiML App Voice URL is `<base>/webhooks/twilio/<providerId>/voice`, and its status callback is `<base>/webhooks/twilio/<providerId>/status`. The provider needs the **Auth Token** saved, because Twilio signs events with it.
- **Telnyx:** the Voice API Application's webhook URL is `<base>/webhooks/telnyx/<providerId>`. Save the application's ID and the **webhook signing public key** on the provider.

Register the numbers you own with `POST /internal/numbers`; an inbound call is routed to the client that owns the number dialled. Until the workflow engine arrives, every answered call plays a short test message and hangs up, so do not point a real customer-facing number at this yet.

## Admin console

Staff sign in with an API token. The console opens on the **Control Tower** (what needs attention, project progress, live calls, provider health, funding, cost and margin). Other screens: Workflows, Providers, Clients, Rates (FX and the client rate card), Numbers, Do not call, and Calls (cost by campaign, each call's timeline and cost lines, reconciliation and re-pricing). Providers: add one from a form built from the adapter's declared settings, set capabilities, add charging versions, confirm rates, record funding. Clients: add a client, grant credits, add projects, create users (their token is shown once). The **Working on** menu picks one client for every screen that works on one client. Users: add staff (admin, or read only: every screen, no changes) and disable any user; a disabled token stops working at once. Jobs: the sweeps the app runs by itself (set `SCHEDULER=off` on a server that should not run them), when each last ran, and controls to turn one off, change its interval or run it now.

## Client portal

Clients sign in at `/portal/` with the API token their organisation was given (a separate sign-in from the staff console). Everyone sees the balance, the last 30 days per project and their calls with the credits each drew; client admins also add and disable their own organisation's users. Nothing about providers, provider cost or margin is shown.

## API (Phase 0)

All requests send `Authorization: Bearer <token>`. `/internal/*` is Daythree staff only (read-only staff may only `GET`); `/client/*` is a tenant's own data.

| Endpoint | Purpose |
| --- | --- |
| `GET /internal/scheduler`, `PUT /internal/scheduler/:name`, `POST /internal/scheduler/:name/run` | Scheduled jobs and their recent runs; turn one off or on, change its interval, or run it now (admins, with a reason) |
| `GET /me` | Who the token belongs to, their role, and whether they are read only |
| `GET /internal/users`, `POST /internal/staff`, `POST /internal/users/:id/approve`, `POST /internal/users/:id/disable` | Who can sign in (admins only); add staff (token shown once; a new admin works only after a different admin approves them); disable a user for good |
| `GET /health` | Database and migration check (no auth) |
| `GET /internal/adapters` | Adapter parameter declarations, used to build the provider form |
| `POST /internal/providers` | Add a provider; secrets are encrypted and never returned |
| `PUT /internal/providers/:id/capabilities/:capability` | Set native, composable or unsupported |
| `POST /internal/providers/:id/check` | Re-check stored credentials with the provider |
| `POST /internal/providers/:id/charging` | Add a charging version (a rate change is a new version) |
| `GET /internal/providers/:id/charging[?at=]` | All versions, or the one in force at a date |
| `POST /internal/charging/:versionId/confirm` | Record that a rate was checked against the provider's pricing page |
| `POST /internal/providers/:id/funding` | Provider funding ledger (internal only) |
| `POST /internal/tenants/:id/credits` | Client credit ledger |
| `GET /client/credits` | A client's own balance and recent entries |
| `GET /client/me`, `GET /client/summary`, `GET /client/calls` | Who is signed in; balance and the last 30 days per project; the client's own calls, newest first (`limit`, `before`, `projectId`) |
| `GET /client/users`, `POST /client/users`, `POST /client/users/:id/disable` | A client admin's own organisation's users (token shown once) |
| `POST /internal/fx`, `GET /internal/fx` | FX rates (units of a currency per 1 USD); MYR is required to cost calls |
| `POST /internal/rate-card`, `GET /internal/rate-card` | Client credits per billed minute and the value of a credit; credits are zero until one exists |
| `POST /internal/calls/:callId/cost` | Price a call from the rates in force when it happened |
| `GET /internal/calls/:callId/cost` | The stored cost record, with its lines |
| `GET /internal/costs/campaigns` | Cost, credits and margin per campaign |
| `POST /internal/dnc/registries` | Declare a country's do-not-call position (a registry, or none required) |
| `POST /internal/dnc/numbers`, `POST /internal/dnc/numbers/remove` | Load or remove numbers on a national registry or a client's own list |
| `POST /internal/dial/check` | Dry run of the pre-dial gate |
| `POST /internal/dial/gate` | The gate every real outbound dial goes through; logs the decision |
| `POST /internal/numbers`, `GET /internal/numbers` | Numbers we own at a provider, and which client each belongs to |
| `POST /internal/calls/outbound` | Place a call. The do-not-call gate runs first; a blocked number never reaches the provider |
| `GET /internal/calls/:callId` | A call's status, timings and cost state |
| `POST /internal/calls/:callId/cost/retry` | Re-price a call whose cost could not be recorded |
| `POST /webhooks/twilio/:providerId/(voice\|status)`, `POST /webhooks/telnyx/:providerId` | Provider callbacks; no token, verified by signature |
| `GET /internal/reference-rates`, `POST /internal/providers/:id/charging/reference` | The blueprint's starting rates, saved onto a provider as unconfirmed |
| `GET /internal/calls` | Recent calls, filterable by status |
| `POST /internal/calls/:callId/reconcile` | Check a call's cost against the provider (`provider_api`, Twilio only) or against figures you enter (`manual`, the provider's price is required) |
| `GET /internal/calls/:callId/reconciliations` | The checks made on a call |
| `POST /internal/reconcile/run` | Check every finished, unchecked Twilio call. Call it on a schedule |
| `GET /internal/control-tower` | Everything the Control Tower shows: alerts, live calls, provider health, funding, cost and margin |
| `GET /internal/progress` | Project progress against the build plan |
| `GET /internal/workflow-templates`, `POST /internal/tenants/:id/workflows/from-template` | Offered templates, and creating one for a client |
| `POST /internal/tenants/:id/workflows`, `GET /internal/workflows`, `GET /internal/workflows/:id` | Create, list and read workflows |
| `POST /internal/workflows/validate` | Check a draft definition without saving it |
| `POST /internal/workflows/:id/versions` | Save a new version (minor for an edit inside a node, major for a change of shape) |
| `POST /internal/workflows/:id/deploy`, `POST /internal/workflows/:id/rollback` | Put a version live in staging or production; go back one version |
| `POST /internal/workflows/:id/simulate`, `GET /internal/simulations/:batchId` | List-based simulation in staging |
| `POST /internal/workflows/:id/runs`, `POST /internal/workflow-runs/:runId/reply`, `GET /internal/workflow-runs/:runId` | Start a test or live call through a workflow, reply to it, and read its steps |
| `POST /internal/tenants/:id/integrations`, `GET /internal/tenants/:id/integrations` | A client's own systems a workflow can call (the key is never returned) |
