# ClinicMind — Medical AI OS

> Integrated Clinical Intelligence, Operating as One.

ClinicMind is an **AI-first, multi-tenant clinic operating system**. Each clinic
runs its own fully isolated, white-labeled instance on its own domain, and the
assistant surface can be embedded on the clinic's website or in another portal.

It uses the **Institutional Tech** brand system (Stripe × McKinsey:
bento grids, stark negative space, electric-indigo data viz, Plus Jakarta Sans +
JetBrains Mono).

---

## What's inside

| Capability | Status |
|---|---|
| Multi-tenant core (custom domain + subdomain + branding) | ✅ |
| Authentication: argon2id passwords, server-side sessions, invitations, password reset, login history + lockout | ✅ |
| RBAC (6 roles) + embed-token session bridge | ✅ |
| Patient CRM + unified timeline | ✅ |
| Appointments (week view, conflict detection, waitlist) | ✅ |
| Consultation Intelligence (transcript → extract → **review → sign**) | ✅ |
| Doctor AI Assistant (RAG, citations, "never answer without retrieval") | ✅ |
| AI provider abstraction (OpenAI / Anthropic / **Gemini** / offline `echo`) | ✅ |
| Immutable audit log + soft delete | ✅ |
| pgvector RAG store + ivfflat index + Postgres RLS | ✅ |
| Embeddable surface + `embed.js` loader + provisioning API | ✅ |
| Analytics dashboard (bento metrics, blueprint charts) | ✅ |
| Docker / Compose / GitHub Actions CI | ✅ |
| WhatsApp / Voice / S3 / Redis queues | 🔌 interfaces + schema in place; channel workers are the next slice |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

### Demo, costs & SaaS

- **Live demo (GitHub Pages):** a fully static, seeded, zero-backend build lives in
  [`demo/`](demo/) and deploys to GitHub Pages (`https://oudoo.github.io/ClinicMind/`).
  It's the permanent sales/pitch asset and includes an interactive **Production
  Report** tab (architecture, security, costs, SaaS readiness).
- **Demo script:** [`docs/DEMO_SCENARIO.md`](docs/DEMO_SCENARIO.md)
- **What costs money (and how to run at $0):** [`docs/COSTS_AND_PAYMENTS.md`](docs/COSTS_AND_PAYMENTS.md)
- **Turning it into a paid subscription SaaS:** [`docs/SAAS_MODEL.md`](docs/SAAS_MODEL.md)

> **AI providers:** OpenAI, Anthropic, **Google Gemini**, and an offline `echo`
> fallback are all supported via one adapter interface. Set `AI_DEFAULT_PROVIDER`
> (`gemini` has a free tier; `echo` is $0 and offline).

---

## Tech stack

- **Frontend/Backend:** Next.js 16 (App Router, RSC), TypeScript, Tailwind, Radix, Zod
- **Database:** PostgreSQL + pgvector via Prisma (soft delete, audit, RLS, full-text)
- **AI:** provider-agnostic adapter layer (OpenAI GPT-4o / Anthropic Claude / offline echo) with a RAG pipeline
- **Infra:** Docker, Docker Compose (Postgres+pgvector, Redis, MinIO), GitHub Actions

---

## Quick start

```bash
cp .env.example .env            # fill secrets (AUTH_SECRET, EMBED_SIGNING_SECRET, AI keys)

# 1) bring up infra
docker compose up -d db redis minio

# 2) install + schema
npm install
npm run db:migrate              # applies prisma/migrations (schema, pgvector index, RLS, audit trigger)
npm run db:seed                 # seeds the "demo" tenant; prints the demo password and the embed secret once

# 3) run
npm run dev                     # http://localhost:3000/login
```

The seed creates two demo staff accounts, `owner@demo.clinic` (clinic owner) and
`doctor@demo.clinic` (doctor), and **prints their password** at the end. Set
`SEED_DEMO_PASSWORD` to choose it (12+ characters); re-running the seed resets it.
Sign in at `/login`; there is no development bypass — every request to
`/dashboard` and `/api/*` needs a session (or an embed token). Without AI keys
the app uses the deterministic `echo` provider, which still enforces the
retrieval guardrail.

### Accounts, invitations and password reset

- **Invite staff** from *Settings → Team* (or `POST /api/users`). The new user is
  created `INVITED` and receives a single-use link (valid 7 days) to choose a
  password; the link is also shown to the inviting administrator.
- **Forgot password:** `/forgot-password` e-mails a single-use reset link
  (valid 1 hour). A user who never set a password gets a fresh invitation instead.
- **E-mail delivery:** set `SMTP_URL` (and `MAIL_FROM`) to send through any SMTP
  relay. Without it, messages are written to the server log — fine for local
  development, not for a real deployment.
- Sessions are server-side rows in `Session` (12-hour lifetime, revoked on sign
  out); passwords are argon2id hashes; sign-ins are rate limited and every
  attempt is recorded in `LoginEvent`. Details in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#4-authn--authz).

### Tests

```bash
npm test                        # unit tests + route tests against TEST_DATABASE_URL
```

The route tests (`src/__tests__/`) need a Postgres database with the migrations
applied (`npm run db:migrate` against `TEST_DATABASE_URL`; they fall back to
`DATABASE_URL`). They create and delete their own tenants. They are skipped when
neither variable is set; CI provides one.

Schema changes are Prisma migrations under `prisma/migrations/`; the second
migration adds what the schema cannot express (pgvector index, trigram index,
Row-Level Security policies, the append-only trigger on `audit_logs`).

### Full stack in Docker

```bash
docker compose up --build       # web + db + redis + minio
```

---

## Project layout

```
prisma/                 schema.prisma · seed.ts · sql/ (pgvector + RLS)
public/embed.js         client website embed loader
src/
  app/
    page.tsx            marketing landing
    login/ forgot-password/ invite/[token]/ reset-password/[token]/
                        sign-in, password reset and invitation acceptance
    dashboard/          the ClinicMind tab (overview, patients, appointments,
                        consultations, assistant, conversations, settings · team)
    embed/[tenantSlug]/ public embeddable surface
    api/                auth · users · assistant · consultations · embed · tenants · patients · …
  components/           ui primitives (bento, metric, chart) · dashboard shell · clinicmind widgets
  lib/                  env · db · tenant · auth(session/login/password/auth-tokens/rbac/rate-limit)
                        · ai(adapters/rag/extraction) · brand · embed · audit · mailer
  test/                 helpers for the database-backed route tests
  __tests__/            route tests: 401 without a session, tenant isolation, auth flows
  modules/              domain services (patients · appointments · analytics)
```

---

## Security posture

Password sign-in (argon2id) with server-side sessions in httpOnly `SameSite=Lax`
cookies, single-use invitation/reset links, login history and lockout · RBAC at
every API boundary (platform provisioning is SUPER_ADMIN-only) · clinical
decisions require explicit clinician **sign-off** (never auto-saved) · append-only
audit log (enforced in app + RLS) · tenant isolation in queries **and** Postgres
Row-Level Security, with every client-supplied foreign key proven to belong to the
acting tenant · per-tenant embed secrets stored hashed and shown once · short-lived
signed embed tokens bound to an active user with a role ceiling · strict per-route
framing policy · Zod validation on all input.
```
