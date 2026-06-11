# The Grow Engine

Multi-tenant **Growth Intelligence Platform** — collects, validates, analyzes, explains, and builds execution plans from marketing and operational data. Not a reporting tool; a decision-support system.

## Architecture

```
apps/
  web/        Next.js 15 (App Router) — internal ops portal, client portal, public API
  worker/     Node.js background worker service (BullMQ) — ALL heavy processing
packages/
  db/         Drizzle ORM schema (PostgreSQL + pgvector), migrations, demo seed
  core/       Shared domain logic: queues, events, AI, integrations, forecasting…
```

**The Golden Rule:** no heavy processing inside Next.js request cycles. AI operations, forecasting, syncs, crawling, transcription and notifications run exclusively through Redis + BullMQ queues in the dedicated worker service (`integration`, `ai`, `research`, `notification`, `events` queues).

### Modules

| Module | Where |
|---|---|
| Multi-tenant auth + RBAC (Auth.js, JWT, tenant-scoped) | `apps/web/src/lib/auth.ts` |
| Client Portal (`/client/[slug]`) & Internal Ops Portal | `apps/web/src/app` |
| Integration connectors — Meta, GA4, Google Ads, TikTok, LinkedIn, X, Zoho, HubSpot, Salesforce, Dynamics, Odoo (official APIs only) | `packages/core/src/integrations` |
| API Rate Limit Manager (Redis sliding window + backoff) | `packages/core/src/rate-limiter.ts` |
| Sanity Check Engine (schema validation, MAD-z anomaly detection, calculation verification) | `packages/core/src/sanity.ts` |
| Verifiable Data Layer — every metric stores its provider request id + reference link | `metric_records` table |
| AI Confidence Framework (score + data sources + evidence count on every output) | `packages/core/src/confidence.ts` |
| AI Recommendation Verification Engine | `apps/worker/src/workers/ai/analysis.ts` |
| Forecasting (Holt-Winters + backtest MAPE), Seasonality heatmaps, Lost Opportunity Quantifier | `packages/core/src/forecasting.ts` |
| Agency Operating Memory + pgvector semantic search + Decisions + entity link graph | `packages/core/src/aom.ts` |
| Meeting Intelligence (prereq forms → recording → Whisper → extraction → Expectation Baseline) | `apps/worker/src/workers/ai/analysis.ts` |
| Automated SOW Generator (scope, feasibility, man-days, Good/Better/Best) | same |
| Automated DMAIC Generator (phases, timeline, generated tasks) | same |
| CAT workflow + 7-day micro-budget A/B pilots (strict approval gate) | `apps/web/src/app/actions/creative.ts` |
| AEO/GEO Content Auditor (live crawl + schema/citeability scoring) | `apps/worker/src/workers/ai/aeo.ts` |
| Interactive Business Audit lead magnet (public widget `/audit`) | `apps/web/src/app/audit` |
| Process Intelligence Engine (funnel + SLA + cycle-time bottlenecks) | `apps/worker/src/workers/ai/reports.ts` |
| Team Scorecards (objective metrics only) | `apps/worker/src/workers/ai/quant.ts` |
| Notification Center (in-app/email/Slack/Teams/webhook + templates + rules) | `packages/core/src/notifications.ts` |
| Domain Event Layer (persisted events + fan-out worker) | `packages/core/src/events.ts` |
| Billing domain (plans/subscriptions/invoices/usage) — gateway-ready | `packages/db/src/schema/billing.ts` |
| AI Cost Tracking per tenant/client/feature | `cost_tracking` table + `/costs` |
| Feature flags per tenant | `/settings` → Feature Flags |
| Enterprise audit trail, data retention enforcement, backups | `audit_logs`, retention worker, `scripts/backup.sh` |
| Public Grow Engine API (hashed bearer keys) | `/api/v1/*` |
| System Health Dashboard (workers, queues, DB, Redis) | `/system` |

## Local development

### macOS one-command setup

```bash
git clone https://github.com/Oudoo/The-Grow-Engine.git
cd The-Grow-Engine
git checkout claude/grow-engine-platform-build-5vz9zu   # until merged to main
bash scripts/setup-mac.sh
```

The script installs/starts the matching PostgreSQL + pgvector pair and Redis via Homebrew, creates the database, writes `.env`, installs dependencies (with an automatic fallback for the known esbuild postinstall failure on some Macs), builds, migrates and seeds. Then start the platform:

```bash
npx npm-run-all --parallel start:web start:worker   # http://localhost:3000
```

### Manual setup (any OS)

Prereqs: Node 22+, PostgreSQL 16+ with `pgvector`, Redis.

```bash
cp .env.example .env          # fill in at least DATABASE_URL, REDIS_URL, AUTH_SECRET, CREDENTIAL_ENCRYPTION_KEY
npm install
npm run db:migrate            # applies SQL migrations (creates pgvector extension)
npm run db:seed               # OPTIONAL: demo workspace for UAT
npm run dev                   # web on :3000 + worker, in parallel
```

Demo logins after seeding — workspace `demo-agency`:
- Team admin: `admin@demo.growengine.app` / `DemoAdmin2026!`
- Client portal: `client@acme-outdoor.com` / `DemoClient2026!`

## Production deployment (Hostinger, no Docker)

1. Provision on the server: Node 22, PostgreSQL 16 (+`postgresql-16-pgvector`), Redis, PM2 (`npm i -g pm2`), optional MinIO + Wiki.js.
2. Clone the repo to e.g. `/var/www/growengine`, create `.env` from `.env.example` with real values.
3. First run: `npm ci && npm run build && npm run db:migrate && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`.
4. Point your reverse proxy (LiteSpeed/Nginx) at `localhost:3000`.
5. GitHub push-to-deploy: add repo secrets `HOSTINGER_HOST`, `HOSTINGER_USER`, `HOSTINGER_SSH_KEY`, `HOSTINGER_APP_DIR` — every push to `main` builds, migrates and reloads PM2 (`.github/workflows/deploy.yml`).
6. Backups: schedule `scripts/backup.sh` in cron (daily). Retention is configurable via `BACKUP_RETENTION_DAYS`.

### Connecting real data sources

All integration credentials are entered per client in **Integration Health Center** and encrypted with AES-256-GCM. Platform-level OAuth apps (Meta App, Google OAuth, GA4 service account, TikTok app, etc.) are configured once in `.env` — see `.env.example` for every variable and how to generate it.

### Monitoring

- `GLITCHTIP_DSN` — GlitchTip (Sentry-compatible) error reporting from the worker.
- `/system` — live worker heartbeats, queue depths, failed jobs, DB/Redis latency.
- `/api/health` — JSON health endpoint for uptime checks.

## Public API

```
GET /api/v1/clients
GET /api/v1/metrics?clientId=…&metric=spend&since=2026-01-01&until=2026-02-01
GET /api/v1/recommendations?clientId=…
Authorization: Bearer ge_…   (create keys under Settings → API Keys)
```

Every metric row includes `sourceRequestId` and `sourceReferenceUrl` — the Verifiable Data Layer guarantee.
