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

## Admin console

Staff sign in with an API token. Providers: add one from a form built from the adapter's declared settings, set capabilities, add charging versions, confirm rates, record funding. Clients: add a client, grant credits, add projects, create users (their token is shown once).

## API (Phase 0)

All requests send `Authorization: Bearer <token>`. `/internal/*` is Daythree staff only; `/client/*` is a tenant's own data.

| Endpoint | Purpose |
| --- | --- |
| `GET /me` | Who the token belongs to |
| `GET /health` | Database and migration check (no auth) |
| `GET /internal/adapters` | Adapter parameter declarations, used to build the provider form |
| `POST /internal/providers` | Add a provider; secrets are encrypted and never returned |
| `PUT /internal/providers/:id/capabilities/:capability` | Set native, composable or unsupported |
| `POST /internal/providers/:id/charging` | Add a charging version (a rate change is a new version) |
| `GET /internal/providers/:id/charging[?at=]` | All versions, or the one in force at a date |
| `POST /internal/charging/:versionId/confirm` | Record that a rate was checked against the provider's pricing page |
| `POST /internal/providers/:id/funding` | Provider funding ledger (internal only) |
| `POST /internal/tenants/:id/credits` | Client credit ledger |
| `GET /client/credits` | A client's own balance and recent entries |
