# ClinicMind — Architecture

## 1. Positioning

ClinicMind is a **separate tool** that integrates into the GROW Engine without
modifying it. Two integration surfaces:

1. **Admin tab** — the GROW Engine frames `/embed/<tenant>` (or links to
   `/dashboard`) inside its own chrome.
2. **Client website** — a clinic drops `public/embed.js` on their own domain to
   embed their isolated instance.

Both resolve to exactly one **Tenant**, the unit of isolation.

```
GROW Engine dashboard ─┐
Client website ────────┼──► embed.js ──► /embed/<tenant> ──► tenant-scoped session
Custom domain ─────────┘                       │
Subdomain ─────────────────────────────────────┘
```

## 2. Modular monolith

A single Next.js deployment with clear domain seams (`src/modules/*`,
`src/lib/*`), so it can later be split into services. Domains: auth, users,
clinics, patients, appointments, conversations, consultations, ai, analytics,
audit, settings, billing, embed.

## 3. Multi-tenancy

- **Resolution** (`lib/tenant.ts`): custom domain → subdomain → explicit header.
- **Isolation**: every domain row carries `tenantId`; services always filter by
  it; Postgres **RLS** (`prisma/sql/01_pgvector_and_rls.sql`) is the
  defense-in-depth backstop.
- **White-label**: `Tenant.branding` drives runtime CSS-variable overrides
  (`lib/brand.ts` → `tenantThemeStyle`) — no rebuild per client.

## 4. AuthN / AuthZ

- **Embed token** (`lib/embed.ts`): host backend signs a short-lived JWT
  (tenant, user, role, origin). Exchanged for an httpOnly cookie at
  `/api/embed/session`.
- **RBAC** (`lib/auth/rbac.ts`): 6 roles → capability sets, enforced at every API
  edge via `assertCan`. Clinical sign-off is gated to clinicians.
- `lib/auth/session.ts` resolves the acting context (token → header → dev demo).

## 5. AI layer

```
                ┌─────────────────────────────────────────┐
  call sites ──►│ provider.ts (registry + routing policy)  │
                └───┬───────────────┬───────────────┬──────┘
                    ▼               ▼               ▼
                OpenAiProvider  AnthropicProvider  EchoProvider
                    └───── implement AiProvider (types.ts) ──────┘
```

- **RAG** (`lib/ai/rag.ts`): embed → pgvector retrieve (tenant-scoped) → rank →
  lexical re-rank → grounded generate **with citations**. The system prompt
  forbids answering outside retrieved context; confidence collapses to ~0 when
  retrieval is empty.
- **Extraction** (`lib/ai/extraction.ts`): transcript → strict JSON
  (symptoms/diagnoses/medications/tests/follow-ups), stored separately and
  surfaced for clinician review.
- Every invocation is persisted as an immutable `AiRun` (prompt, context, output,
  confidence, latency).

## 6. Data model highlights

- **History is never overwritten** — `AiRun`, `Visit`, `Consultation`,
  `TimelineEvent` are append-only; diagnoses/medications are appended on sign.
- **Soft delete** via `deletedAt` + `notDeleted` filter.
- **Unified timeline** (`TimelineEvent`) denormalizes appointments, calls,
  messages, diagnoses, prescriptions, audio, documents and AI notes chronologically.
- **pgvector** `KnowledgeEmbedding` powers RAG; ivfflat cosine index in SQL.

## 7. Queues & storage (interfaces in place)

Redis-backed background jobs (notifications, WhatsApp, voice, AI summaries,
reports) and S3-compatible storage (audio, documents, images) are provisioned in
Compose and represented in the schema (`audioKey`, `s3Key`, `Conversation`,
`Document`). Channel workers are the next implementation slice.

## 8. Security

Encryption in transit (TLS at the edge) and at rest (Postgres/S3) · RBAC · Zod
input validation · per-route framing/CSP · signed short-lived embed tokens ·
append-only audit (app + RLS) · secure upload + malware-scan flags on `Document` ·
session/device/login tracking models.

## 9. Performance targets

Dashboard < 2s (RSC + indexed aggregates), search < 1s (trigram indexes), chat <
5s (top-k retrieval + streaming-ready adapters), summary < 15s, transcription
near-real-time (Whisper-class via adapter).
