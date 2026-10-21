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

- **Resolution** (`lib/tenant.ts`): custom domain → subdomain, used as a hint for
  public surfaces only; the acting tenant of an authenticated request comes from
  its session or embed token (§4).
- **Isolation**: every domain row carries `tenantId`; services always filter by
  it; Postgres **RLS** (`prisma/sql/01_pgvector_and_rls.sql`) is the
  defense-in-depth backstop.
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
   `POST /api/embed/session`.

There is no host- or header-based tenant resolution and no development
fallback. The middleware strips the legacy `x-clinicmind-tenant` /
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
sign-off is gated to clinicians.

**Not yet**: TOTP (`User.mfaEnabled/mfaSecret` are reserved), session listing
and remote revocation UI, Redis-backed rate limiting for multi-instance
deployments, and the embed-token hardening tracked separately (SEC-2/SEC-7 in
the Phase 1 audit).

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

Encryption in transit (TLS at the edge) and at rest (Postgres/S3) · argon2id
passwords and server-side sessions with login history and lockout (§4) · RBAC ·
Zod input validation · per-route framing/CSP · signed short-lived embed tokens ·
append-only audit (app + RLS) · secure upload + malware-scan flags on `Document`.

## 9. Performance targets

Dashboard < 2s (RSC + indexed aggregates), search < 1s (trigram indexes), chat <
5s (top-k retrieval + streaming-ready adapters), summary < 15s, transcription
near-real-time (Whisper-class via adapter).
