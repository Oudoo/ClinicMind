# ClinicMind

**The clinic operating system with an AI that only speaks from the record.**

ClinicMind is a multi-tenant clinic platform: patients, appointments and
consultations in one place, a retrieval-grounded AI assistant over the clinic's
own records, and a consultation workflow in which a transcript becomes a
structured note that a clinician reviews and signs. Every clinic runs as an
isolated, white-labeled tenant on its own domain, and the assistant can be
embedded in the clinic's website or portal.

---

## What's inside

| Area | What it does |
|---|---|
| **Patients** | Registry with search (name, phone, e-mail), pagination, archive/restore, medical history (conditions, allergies, diagnoses, surgeries), medications, documents and a unified chronological timeline. |
| **Appointments** | Week and day views on the clinic's clock, booking with per-doctor and per-room conflict detection, reschedule, cancel with reason, and the full lifecycle: scheduled → confirmed → checked in → in progress → completed, or no-show. |
| **Consultation intelligence** | Transcript → structured extraction (symptoms, diagnoses, tests, follow-ups, medications) → editable review → **sign**. Nothing reaches the patient record until a clinician signs; signing reconciles medications, creates the visit and writes the timeline. |
| **AI assistant** | Retrieval-augmented chat over the clinic's records (pgvector + lexical match), optionally focused on one patient. Every answer states whether it is grounded and cites the records it came from; when nothing matches it says so. |
| **Team and access** | Password sign-in, server-side sessions, invitations and password reset, lockout and rate limits, six roles enforced at every API boundary. |
| **Tenancy and white-label** | Tenant per clinic with branding, custom domain/subdomain, per-tenant embed secret, allow-listed embedding origins. |
| **Audit and data safety** | Append-only audit log enforced by a database trigger, soft delete, tenant isolation in every query and Postgres Row-Level Security policies. |
| **Operations** | Health endpoint, Prisma migrations, Docker images, Compose stacks for development and production (TLS, backups), CI with dependency audit, tests, build and end-to-end smoke. |

Planned next (see [`docs/SPEC_ANALYSIS.md`](docs/SPEC_ANALYSIS.md)): audio
capture and transcription, the all-in-one inbox integration (WhatsApp, voice),
Arabic/RTL, reporting, background jobs.

---

## Tech stack

- **App:** Next.js 16 (App Router, React Server Components), React 19, TypeScript (strict), Tailwind, Radix, Zod
- **Data:** PostgreSQL 16 + `pgvector` + `pg_trgm` via Prisma; migrations, RLS policies, audit trigger
- **AI:** provider-agnostic adapters for Google Gemini, OpenAI and Anthropic, plus an offline `echo` provider; 1536-dimension embeddings; hybrid retrieval
- **Quality:** Vitest (unit + database-backed route tests), Playwright (desktop and mobile smoke), ESLint, GitHub Actions
- **Runtime:** Node 22, Docker (standalone server image), Caddy for automatic HTTPS

---

## Quick start (local)

Prerequisites: Node 22, Docker (for Postgres with pgvector), `openssl`.

```bash
cp .env.example .env
# set two real secrets in .env:
#   AUTH_SECRET=$(openssl rand -base64 48)
#   EMBED_SIGNING_SECRET=$(openssl rand -base64 48)
# optional: SEED_DEMO_PASSWORD=<12+ characters>   GEMINI_API_KEY=<key>

docker compose up -d db          # PostgreSQL 16 + pgvector on localhost:5432
npm ci
npm run db:migrate               # applies prisma/migrations
npm run db:seed                  # builds the demo clinic and indexes it for the assistant
npm run dev                      # http://localhost:3000
```

The seed creates **Aura Derma & Hair Clinic** (tenant `demo`, Africa/Cairo):
62 patients with histories and medications, weeks of appointments around today,
a few hundred signed visits, drafts awaiting review and conversations,
all indexed for the assistant. It ends by printing the sign-in details:

| Account | Who | Role |
|---|---|---|
| `owner@demo.clinic` | Dr. Layla Hassan | Clinic owner (physician-owner) |
| `doctor@demo.clinic` | Dr. Omar Fahmy | Doctor |
| `mariam@demo.clinic` | Dr. Mariam Tarek | Doctor |
| `nurse@demo.clinic` | Heba Mostafa | Nurse |
| `reception@demo.clinic` | Youssef Hany | Receptionist |
| `platform@demo.clinic` | Platform Admin | Platform administrator (system owner, `/platform`) |

All six share one password: `SEED_DEMO_PASSWORD` if set, otherwise a random one
printed by the seed. Re-running the seed rebuilds the demo clinic. There is no
development bypass: every `/dashboard` and `/api/*` request needs a session or
an embed token.

A guided tour for a live demo is in [`docs/DEMO_SCENARIO.md`](docs/DEMO_SCENARIO.md).

### Full stack in Docker

```bash
docker compose up --build        # db + migrations + web on http://localhost:3000
docker compose --profile seed run --rm seed
```

---

## AI configuration

Without any key the app runs on the deterministic `echo` provider: retrieval,
grounding and citations work, but answers quote the retrieved records instead
of reasoning over them. For a real demo set one key; Gemini has a free tier.

| Variable | Default | Notes |
|---|---|---|
| `AI_DEFAULT_PROVIDER` | `auto` | chat: gemini → openai → anthropic → echo |
| `AI_EMBEDDING_PROVIDER` | `auto` | embeddings: gemini → openai → echo |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | | at least one for live AI |
| `GEMINI_MODEL` / `OPENAI_MODEL` / `ANTHROPIC_MODEL` | `gemini-2.5-flash` / `gpt-4.1-mini` / `claude-opus-5-5` | |
| `GEMINI_EMBEDDING_MODEL` / `OPENAI_EMBEDDING_MODEL` | `gemini-embedding-001` / `text-embedding-3-small` | stored at 1536 dimensions |
| `AI_TIMEOUT_MS` | `30000` | per upstream call |

The assistant answers only from `knowledge_embeddings`. One plain-text document
is built per patient (profile, history, medications), visit, signed consultation
and conversation; documents are chunked (about 800 characters, 100 overlap),
content-hashed and embedded. Writes are idempotent and happen in the background
after every patient, appointment and consultation change. After changing the
embedding provider or model, rebuild the store:

```bash
npm run ai:reindex -- demo       # one tenant by slug
npm run ai:reindex -- --all      # every active tenant
```

`GET /api/health` reports the database, the active chat and embedding
providers, uptime and whether development secrets are in use.

---

## Roles

| Role | Can |
|---|---|
| `SUPER_ADMIN` | Everything, including provisioning and listing tenants (`platform:manage`). Never mintable through an embed token. |
| `CLINIC_OWNER` | The physician-owner: tenant settings, team, embed configuration, plus the full clinical rights of a doctor (bookable, may sign). |
| `DOCTOR` | Patients, appointments, consultations (capture, review, **sign**), AI assistant, reports and analytics. |
| `NURSE` | Patients, appointments, consultation capture; bookable; cannot sign. |
| `RECEPTIONIST` | Patients, appointments, conversations; no AI assistant. |
| `ASSISTANT` | Read-only patients, appointments and conversations. |

### Platform console (system owner)

Platform administrators (`SUPER_ADMIN`, kept in a dedicated `platform` tenant)
sign in at `/login` and land on `/platform`, where they create client tenants,
invite each clinic's owner, white-label the tenant (product name, accent, logo),
assign a custom domain, control embedding and suspend or activate access. The
dialog that creates a tenant shows the owner's invitation link and the embed
secret once. In production, create the first administrator with:

```bash
npm run platform:bootstrap -- --email admin@example.com --name "Full Name"
```

Details, the API and the growcdx.com developer-page plan are in
[`docs/PLATFORM.md`](docs/PLATFORM.md).

Invite staff from *Settings → Team* (or `POST /api/users`); the invitee receives
a single-use link (7 days) to choose a password, which is also shown to the
inviting administrator. `/forgot-password` sends a single-use reset link
(1 hour). Set `SMTP_URL` and `MAIL_FROM` to deliver e-mail; without them,
messages are written to the server log.

---

## Security posture

- **Authentication:** argon2id passwords; server-side sessions (12 hours, revoked on sign-out) in an `httpOnly`, `SameSite=Lax`, `Secure` cookie; login history; lockout after repeated failures; per-IP and per-account rate limits on sign-in, reset and set-password; same-origin check on cookie-authenticated mutations.
- **Authorisation:** six roles mapped to capabilities and checked at every API edge; clinical sign-off restricted to clinicians; platform operations restricted to `SUPER_ADMIN`.
- **Tenant isolation:** every query is scoped to the acting tenant, every client-supplied foreign key is proven to belong to it (a foreign id is indistinguishable from a missing one), and Postgres RLS policies exist on all tenant tables.
- **Embedding:** per-tenant secret stored hashed and shown once; short-lived signed tokens bound to an active user with a role ceiling; `Content-Security-Policy` with `frame-ancestors` from the tenant's allow-list on the embed page and framing denied everywhere else.
- **Transport and headers:** HSTS, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `no-store` on API responses; per-IP API rate limits (600 requests / 5 minutes, 40 for AI endpoints, 60 for token minting).
- **Integrity:** append-only audit log enforced by a trigger, soft delete, clinical writes only through signed consultations, Zod validation on every input.
- **Configuration:** production refuses to start on an invalid configuration or on development-looking secrets.

Details and rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the
Phase 1 audit in [`docs/PHASE1_AUDIT.md`](docs/PHASE1_AUDIT.md).

---

## Testing

```bash
npm run typecheck && npm run lint
npm test                         # Vitest: unit tests + route tests against a Postgres database
npm run e2e                      # Playwright smoke suite against a running, seeded server
```

The route tests use `TEST_DATABASE_URL` (falling back to `DATABASE_URL`) with
the migrations applied; they create and delete their own tenants. The
end-to-end suite signs in to the demo clinic (`E2E_BASE_URL`, `E2E_EMAIL`,
`E2E_PASSWORD`; defaults to `http://localhost:3000` and the owner account) and
covers the security surface, sign-in, every section, the assistant, sign-out
and the phone layout. CI runs `npm audit` (production dependencies, high or
worse fails), migrations, typecheck, lint, tests, the production build and the
end-to-end suite.

---

## Deployment

`docker-compose.prod.yml` runs Caddy (automatic HTTPS, with on-demand
certificates for tenant subdomains and verified custom domains), PostgreSQL with
pgvector, a one-shot migration service, the standalone web server, an optional
demo seed and a nightly `pg_dump` with retention. The *Release image* workflow
publishes the images to GitHub Container Registry once CI is green; the
*Deploy* workflow updates a server over SSH; `scripts/server-setup.sh` prepares
a fresh Ubuntu server in one command. Configuration, the cm.growcdx.com
checklist, upgrades, backups, secret rotation, monitoring and troubleshooting
are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Development server / production build / production server |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run prisma:migrate` | Create a migration during development |
| `npm run db:seed` | Build the demo clinic and index it |
| `npm run db:reset` | Drop and recreate the database (development only) |
| `npm run ai:reindex -- <slug> \| --all` | Rebuild the assistant's knowledge store |
| `npm run platform:bootstrap -- --email <e-mail>` | Create or re-invite a platform administrator |
| `npm test` / `npm run test:watch` | Unit and route tests |
| `npm run e2e` / `npm run e2e:ui` | Playwright suite |
| `npm run lint` / `typecheck` / `format` | Static checks |

---

## Project layout

```
prisma/               schema.prisma · migrations/ · seed.ts
src/
  app/                landing · login, invite and reset pages · dashboard/* · embed/[tenantSlug] · api/*
  components/         ui primitives · dashboard shell · clinicmind/* (patients, appointments,
                      consultations, assistant, settings widgets)
  modules/            domain services: patients · appointments · consultations · knowledge · analytics
  lib/                env · db · auth (session, login, password, tokens, rbac, rate limit) · ai (adapters,
                      rag, extraction) · tenant scope · audit · mailer · proxy helpers
  proxy.ts            request proxy: auth redirects, rate limits, CSP and security headers
  __tests__/          route tests · lib/__tests__/ unit tests · test/ helpers
e2e/                  Playwright suite
scripts/              reindex.ts · backup.sh · restore.sh
deploy/               Caddyfile
docs/                 architecture · integration · runbook · audit · spec analysis · demo script
public/embed.js       website embed loader
```

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — tenancy, auth, data model, migrations, RLS, security, performance
- [`docs/PLATFORM.md`](docs/PLATFORM.md) — the system-owner console, provisioning API, growcdx.com developer page, Omni Grow integration
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — embedding ClinicMind in a website or portal, token minting
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — deploy, upgrade, backup and restore, rotation, monitoring
- [`docs/DEMO_SCENARIO.md`](docs/DEMO_SCENARIO.md) — the guided live demo
- [`docs/PHASE1_AUDIT.md`](docs/PHASE1_AUDIT.md) — the audit this release was built from
- [`docs/SPEC_ANALYSIS.md`](docs/SPEC_ANALYSIS.md) — analysis of the Clinic AI implementation spec and the roadmap
- [`docs/COSTS_AND_PAYMENTS.md`](docs/COSTS_AND_PAYMENTS.md), [`docs/SAAS_MODEL.md`](docs/SAAS_MODEL.md) — planning notes on running costs and a subscription model
