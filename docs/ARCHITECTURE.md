# ClinicMind — Architecture

## 1. Positioning

ClinicMind is a standalone product. Two surfaces reach one **Tenant**, the unit of
isolation:

1. **The clinic's own domain** — staff sign in at `https://<slug>.<ROOT_DOMAIN>`
   (or a verified custom domain) and work in `/dashboard`.
2. **Embedded surface** — the clinic drops `public/embed.js` on its website, or
   frames `/embed/<tenant>` inside another portal, with a server-minted token.

```
Clinic domain / subdomain ──► /login ──► session cookie ──► /dashboard
Clinic website / portal  ──► embed.js ──► /embed/<tenant> ──► embed token ──► cookie
```

## 2. Modular monolith

A single Next.js deployment with clear domain seams (`src/modules/*`,
`src/lib/*`), so it can later be split into services. Domains: auth, users,
clinics, patients, appointments, conversations, consultations, ai, analytics,
audit, settings, billing, embed.

## 3. Multi-tenancy

- **Resolution** (`lib/tenant.ts`): custom domain → subdomain, used as a hint for
  public surfaces only; the acting tenant of an authenticated request comes from
  its session or embed token (§4).
- **Isolation**: every domain row carries `tenantId` (including the clinical
  child tables `medical_histories`, `medications`, `documents`, `messages`);
  services always filter by it, and every client-supplied foreign key
  (`patientId`, `doctorId`, `clinicId`) is proven to belong to the acting tenant
  by `lib/tenant-scope.ts` before a write. Postgres **RLS**
  (`prisma/sql/01_pgvector_and_rls.sql`) is the defense-in-depth backstop.
- **White-label**: `Tenant.branding` drives runtime CSS-variable overrides
  (`lib/brand.ts` → `tenantThemeStyle`) — no rebuild per client.

## 4. AuthN / AuthZ

Everything under `/dashboard` and every `/api/*` route except `health`,
`auth/*`, `embed/token` and `embed/session` requires an authenticated **acting
context**. `lib/auth/session.ts#getActingContext()` builds one from exactly two
sources and otherwise returns `null` (route handlers answer **401**, the
dashboard layout redirects to `/login`):

1. **Staff session** — the httpOnly `cm_session` cookie. Its random 256-bit
   token is looked up by keyed hash (`HMAC-SHA256(AUTH_SECRET, token)`) in the
   `Session` table; the row must be unrevoked and unexpired, the user `ACTIVE`,
   the tenant `ACTIVE`. The tenant, user and role all come from that row.
2. **Embed token** — `cm_embed` cookie or `Authorization: Bearer`, a short-lived
   JWT minted server-to-server at `POST /api/embed/token` (`lib/embed.ts`) for
   the framed `/embed/<tenant>` surface and exchanged for the cookie at
   `POST /api/embed/session`. The host backend presents the tenant's **embed
   secret** (CSPRNG, stored as a SHA-256 hash, shown once) and may only mint a
   token for an *active user of that tenant* with a tenant role within the
   ceiling of that user's stored role and an allow-listed origin: the bridge can
   narrow a session, never widen it.

There is no host- or header-based tenant resolution and no development
fallback. The proxy strips the legacy `x-clinicmind-tenant` /
`x-clinicmind-domain` headers from every request and sends dashboard visitors
without any credential cookie straight to `/login?next=…`; the layout performs
the authoritative check. Tests obtain a context by creating a real session
(`src/test/db.ts#sessionCookieFor`).

**Sign-in** (`POST /api/auth/login`, `lib/auth/login.ts`): e-mail + password.
Passwords are argon2id hashes with OWASP parameters (`lib/auth/password.ts`,
policy: 12–128 characters). E-mail addresses are unique *per tenant*, so the
password is verified against every active-tenant user with that address; when
the same credentials are valid in more than one tenant the client is asked for
the clinic slug (`tenant_required`). On success a `Session` row is created
(12 h absolute lifetime, `lastSeenAt` refreshed every 5 min) and the cookie is
set `HttpOnly; SameSite=Lax; Path=/` plus `Secure` over HTTPS / in production.
`POST /api/auth/logout` revokes the row and clears the cookie.

**Abuse controls**: every attempt against a known user is a `LoginEvent`
(success flag, IP, user agent); 10 failures within 15 minutes lock the account
for the remainder of the window (database-backed, shared across instances). On
top of that `lib/auth/rate-limit.ts` keeps per-process sliding windows per IP
and per e-mail for sign-in, reset requests and set-password submissions
(**429** + `Retry-After`). Cookie-authenticated mutations also reject requests
whose `Origin` does not match the host (`lib/auth/request.ts#isSameOrigin`).
Unknown e-mails burn a dummy argon2 verification so timing does not reveal
whether an account exists.

**Invitations and password reset** (`lib/auth/auth-tokens.ts`, `AuthToken`
table): a user is created `INVITED` with no password (`POST /api/users` by a
`users:manage` role, or the owner created by `POST /api/tenants`) and receives
a single-use link `/invite/<token>` (7 days); `/forgot-password` issues
`/reset-password/<token>` (1 hour), or a fresh invitation for a user who never
set a password. Tokens are stored hashed like sessions, issuing a new one
replaces the previous unused one, and `POST /api/auth/password/reset` consumes
the token atomically, sets the password, activates the user, revokes all their
sessions and signs the caller in. Links go out through `lib/mailer.ts`
(`SMTP_URL`, otherwise the server log); invitation links are also returned to
the inviting administrator. Role ceiling: only a `SUPER_ADMIN` may invite
another `SUPER_ADMIN` (`lib/auth/rbac.ts#grantableRoles`).

**RBAC** (`lib/auth/rbac.ts`): 6 roles → capability sets, enforced at every API
edge via `assertCan` on the role carried by the acting context. Clinical
sign-off is gated to clinicians; `platform:manage` (provisioning / listing
tenants) is SUPER_ADMIN-only while `tenant:manage` is scoped to the owner's own
tenant.

**Not yet**: TOTP (`User.mfaEnabled/mfaSecret` are reserved), session listing
and remote revocation UI, and Redis-backed rate limiting for multi-instance
deployments.

## 5. AI layer

```
                ┌─────────────────────────────────────────────────┐
  call sites ──►│ provider.ts (registry + routing policy + status) │
                └───┬────────────┬───────────────┬──────────┬──────┘
                    ▼            ▼               ▼          ▼
              GeminiProvider OpenAiProvider AnthropicProvider EchoProvider
                    └──────── implement AiProvider (types.ts) ────────┘
```

- **Routing** (`lib/ai/provider.ts`): `AI_DEFAULT_PROVIDER=auto` picks
  gemini → openai → anthropic → echo; `AI_EMBEDDING_PROVIDER=auto` picks
  gemini → openai → echo. An explicit name is honoured when configured and
  otherwise falls back to the auto order (never silently to `echo` while a real
  key exists). Every upstream call is bounded by `AI_TIMEOUT_MS`, non-2xx
  answers become a typed `AiProviderError`, and request bodies are never
  logged. `aiStatus()` exposes the active chat/embedding provider and model.
- **Ingestion** (`modules/knowledge/ingest.ts`): `ingestPatient`, `ingestVisit`,
  `ingestConsultation` (signed only), `ingestConversation`, `reindexTenant`,
  `removePatientKnowledge` and the fire-and-forget `ingestInBackground`. One
  plain-text document per entity → ~800-char chunks with 100 overlap →
  SHA-256 content hash → idempotent upsert keyed by
  `(tenantId, source, refId, chunkIndex)`; only changed chunks (or chunks
  embedded with another model) are re-embedded. `npm run ai:reindex` rebuilds
  a tenant from the CLI.
- **RAG** (`lib/ai/rag.ts`): embed query → pgvector cosine search + `pg_trgm`
  lexical search (hybrid, tenant-scoped, optionally per patient) → merge →
  lexical re-rank → grounded generate **with `[n]` citations**. Confidence is
  computed from retrieval (best match, number of strong matches, citation
  markers in the answer); an answer is `grounded` only above a threshold, and
  chunks below a score floor never reach the prompt.
- **Extraction** (`lib/ai/extraction.ts`): transcript → strict JSON
  (symptoms/diagnoses/medications/tests/follow-ups), stored separately and
  surfaced for clinician review.
- Every invocation is persisted as an immutable `AiRun` (prompt, context, output,
  confidence, latency).

## 6. Data model highlights

- **History is never overwritten** — `AiRun`, `Visit`, `Consultation`,
  `TimelineEvent` are append-only; diagnoses/medications are appended or reconciled on sign
  (new diagnoses appended, existing active medications updated or stopped).
- **Soft delete** via `deletedAt` + `notDeleted` filter.
- **Unified timeline** (`TimelineEvent`) denormalizes appointments, calls,
  messages, diagnoses, prescriptions, audio, documents and AI notes chronologically.
- **pgvector** `KnowledgeEmbedding` powers RAG: one row per chunk, keyed by
  `(tenantId, source, refId, chunkIndex)` with a content hash so re-indexing is
  idempotent; ivfflat cosine index in the migration SQL.

## 7. Schema changes, RLS and the audit log

- Schema changes are **Prisma migrations** (`prisma/migrations/`), applied with
  `prisma migrate deploy` in CI, Docker (`migrate` service) and production. The
  second migration holds what Prisma cannot express: the pgvector and trigram
  indexes, Row-Level Security policies on every tenant-scoped table, and the
  append-only trigger on `audit_logs`.
- **Audit immutability** is enforced by a trigger that refuses `UPDATE` and
  `DELETE` for every role; a tenant removal (offboarding, erasure request) opts
  in with `SET LOCAL app.allow_audit_delete = 'on'` inside its transaction.
- **RLS policies** compare `tenantId` with `app_current_tenant()`. They are
  present and tested by migration, but the application still connects as the
  table owner, which PostgreSQL exempts from RLS; activating them means a
  dedicated non-owner application role, `FORCE ROW LEVEL SECURITY`, and a
  per-transaction `SET LOCAL app.current_tenant` wrapper. Until then, isolation
  rests on the query-level scoping and `lib/tenant-scope.ts` checks, which every
  route test exercises.

## 8. Security

- **Transport and headers**: HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy` and `Cache-Control: no-store` on the API (next.config);
  a per-request Content-Security-Policy from `src/proxy.ts` — admin pages
  refuse framing, `/embed/<slug>` may be framed only by that tenant's
  allow-listed origins, which the iframe bootstrap also verifies on the
  `postMessage` channel.
- **Rate limits** (per client address, in the proxy): 600 API requests per
  5 minutes, 40 for the AI endpoints, 60 for embed-token minting; sign-in has
  its own per-IP/per-e-mail budgets and a database-backed account lockout.
- **Secrets**: production refuses to start on an invalid configuration or on
  development-looking secrets; embed secrets are stored hashed and shown once.
- **RBAC** at every API edge, tenant scoping on every query, ownership checks on
  every client-supplied foreign key, Zod validation with bounded lengths on all
  input, append-only audit of every mutation.

## 9. Performance targets

Dashboard < 2s (RSC + indexed aggregates), search < 1s (trigram indexes), chat <
5s (top-k retrieval + hybrid re-rank), extraction < 15s, with provider calls
bounded by `AI_TIMEOUT_MS`.
