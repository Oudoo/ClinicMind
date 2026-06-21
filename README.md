# ClinicMind — Medical AI OS

> Integrated Clinical Intelligence, Operating as One.

ClinicMind is an **AI-first, multi-tenant Medical Operating System**, built as a
**standalone, integration-ready tool** for the **GROW Engine** admin dashboard.
It does not replace or modify the GROW Engine — it mounts into it as a tab and can
equally be embedded on any client's own website/domain, where **each client runs
their own fully isolated, white-labeled instance**.

It is themed with the GROW **Institutional Tech** brand system (Stripe × McKinsey:
bento grids, stark negative space, electric-indigo data viz, Plus Jakarta Sans +
JetBrains Mono).

---

## What's inside

| Capability | Status |
|---|---|
| Multi-tenant core (custom domain + subdomain + branding) | ✅ |
| RBAC (6 roles) + embed-token session bridge | ✅ |
| Patient CRM + unified timeline | ✅ |
| Appointments (week view, conflict detection, waitlist) | ✅ |
| Consultation Intelligence (transcript → extract → **review → sign**) | ✅ |
| Doctor AI Assistant (RAG, citations, "never answer without retrieval") | ✅ |
| AI provider abstraction (OpenAI / Anthropic / offline `echo`) | ✅ |
| Immutable audit log + soft delete | ✅ |
| pgvector RAG store + ivfflat index + Postgres RLS | ✅ |
| Embeddable surface + `embed.js` loader + provisioning API | ✅ |
| Analytics dashboard (bento metrics, blueprint charts) | ✅ |
| Docker / Compose / GitHub Actions CI | ✅ |
| WhatsApp / Voice / S3 / Redis queues | 🔌 interfaces + schema in place; channel workers are the next slice |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

---

## Tech stack

- **Frontend/Backend:** Next.js 14 (App Router, RSC, Server Actions), TypeScript, Tailwind, Radix, React Hook Form, Zod
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
npx prisma db push
# Apply pgvector index + RLS. Strip Prisma's ?schema= suffix, which psql rejects:
psql "${DATABASE_URL%%\?*}" -f prisma/sql/01_pgvector_and_rls.sql
npm run db:seed                 # seeds the "demo" tenant

# 3) run
npm run dev                     # http://localhost:3000
```

In development the app auto-authenticates as the seeded **demo** tenant owner, so
`/dashboard` works immediately. Without AI keys it uses the deterministic `echo`
provider, which still enforces the retrieval guardrail.

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
    dashboard/          the ClinicMind tab (overview, patients, appointments,
                        consultations, assistant, conversations, settings)
    embed/[tenantSlug]/ public embeddable surface
    api/                assistant · consultations · embed · tenants · patients · …
  components/           ui primitives (bento, metric, chart) · dashboard shell · clinicmind widgets
  lib/                  env · db · tenant · auth(rbac/session) · ai(adapters/rag/extraction) · brand · embed · audit
  modules/              domain services (patients · appointments · analytics)
```

---

## Security posture

RBAC at every API boundary · clinical decisions require explicit clinician
**sign-off** (never auto-saved) · append-only audit log (enforced in app + RLS) ·
tenant isolation in queries **and** Postgres Row-Level Security · short-lived
signed embed tokens · strict per-route framing policy · Zod validation on all input.
```
