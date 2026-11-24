# OLTREVIX BROKERAGE

Database-backed investment account application focused on **stocks, government bonds, and commodities**. The landing page, registration/sign-in flows, investor workspace, and role-protected administration console are separate from the Global Starks visual reference.

## Current implementation and limits

- Frontend: Vite + plain JavaScript; intended for Netlify.
- API: Express; intended for Render.
- Identity and database: Supabase Auth + Postgres.
- The initial Supabase migration inserts **no instruments, balances, positions, research, models, or other sample rows**. Account records appear only after database-backed actions or trusted integrations.
- Registration, login, session refresh, password reset, portfolio data, orders, account requests, watchlists, price alerts, notifications, support, and administrative review are implemented in the API.
- Orders and funding/withdrawal/transfer actions are **requests only**. No order is routed or executed and no money is accepted, reserved, transferred, or settled. There is no broker, market-data, FX, payment, bank, custodian, or settlement provider configured.
- Account values are not converted between currencies. Instrument/position quotes are only aggregated into a portfolio value when all relevant quotes are present and in the portfolio currency.
- Before any production use, complete legal/compliance, licensing, security, privacy, identity-verification, operational, market-data, broker, and payment-provider reviews. This repository is not a production-ready regulated brokerage service.

## Local development

Requirements: Node.js 20 or later and npm.

1. Install frontend packages from the repository root:

   ```bash
   npm ci
   ```

2. Configure and start the API in a second terminal:

   ```bash
   cd backend
   npm ci
   cp .env.example .env
   ```

   Fill in the Supabase values in `backend/.env`, then start the API:

   ```bash
   npm start
   ```

   The API listens on `http://localhost:3001`. Never put the Supabase service-role key in frontend variables, source control, or a browser.

3. Start the frontend from the repository root:

   ```bash
   npm run dev
   ```

   Vite serves the site on port 5173 and proxies `/api` to `http://127.0.0.1:3001`. Without Supabase credentials, the site and API health check run, but authentication and database-backed routes intentionally return a configuration error.

4. Build the frontend:

   ```bash
   npm run build
   ```

## Supabase setup

1. Create a Supabase project.
2. Apply `backend/supabase/migrations/202611240001_initial.sql` once using the Supabase SQL Editor or Supabase CLI. It creates the schema, row-level-security policies, updated-at triggers, and auth-user provisioning trigger; it does not seed data.
3. In Supabase Auth, configure email confirmation, SMTP, password policy, and allowed redirect URLs. Include the deployed frontend origin plus its `/reset-password` route.
4. Configure the backend environment values from `backend/.env.example`. The Render service needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. The service-role key is server-only and must be stored as a secret.
5. The first administrator must register normally. A trusted project operator can then promote that profile using the Supabase SQL Editor, for example:

   ```sql
   update public.profiles
   set role = 'admin', updated_at = now()
   where email = 'operator@example.com';
   ```

   Use the exact intended account and verify the change. Do not expose an admin-creation endpoint or the service-role key to the browser.
6. Add only verified, authorized instruments or approved research/model content. The current application does not generate market records or populate balances automatically.

## Deployment: Netlify + Render

### Render API

`render.yaml` defines the Node service with `backend/` as its root and `npm ci` / `npm start` commands. Create the service from the blueprint and set these environment variables in Render:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (secret)
- `FRONTEND_URL` (the exact Netlify site origin, e.g. `https://your-site.netlify.app`)
- `CORS_ORIGINS` (comma-separated exact frontend origins; include production and any authorized preview/custom domains)

The health endpoint is `/api/health`. It reports whether the Supabase environment values are present; it does not certify database connectivity or service readiness.

### Netlify frontend

Connect the repository with the project root as the base directory. Netlify builds with `npm run build` and publishes `dist/` via `netlify.toml`. Set the build environment variable:

```text
VITE_API_BASE_URL=https://<your-render-service>.onrender.com/api
```

Set it to the Render service’s actual HTTPS origin. The browser calls the API directly, so the Render `CORS_ORIGINS` list must include the exact Netlify origin. Netlify’s SPA fallback is configured in `netlify.toml`.

## Useful checks

```bash
# Frontend production build (repository root)
npm run build

# API JavaScript syntax check (backend)
node --check backend/src/server.js

# API health once the local API is running
curl http://localhost:3001/api/health
```

No live Supabase credentials or deployed Netlify/Render/Supabase services are included in this workspace. The current local smoke checks therefore verify startup, routing, health, syntax, and frontend bundling only; real registration, database migration behavior, authenticated account flows, and deployed cross-origin configuration still need to be exercised after Supabase and deployment variables are supplied.
