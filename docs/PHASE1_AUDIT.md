# ClinicMind — Phase 1: Analysis & Audit

| | |
|---|---|
| **Date** | 2026-10-21 |
| **Scope** | Everything in `Oudoo/ClinicMind` on GitHub: `main`, PR #2 (`claude/clinicmind-medical-ai-os-iototl` @ `7d3007a`), PR #1 (`claude/grow-engine-platform-build-5vz9zu` @ `08534e2`) |
| **Purpose** | Establish what we actually have before Phase 2 (feature work) and Phase 3 (handover to the clinic/doctor who bought it) |
| **Method** | Full read of the ClinicMind source (every file), schema and SQL, docs, CI, Docker; dependency install + typecheck + lint + unit tests + production build run locally; `npm audit`; secret scan of all branches and history; targeted review of the GROW Engine branch |

All file paths and line numbers below refer to the ClinicMind branch (`claude/clinicmind-medical-ai-os-iototl`) unless stated otherwise. `main` is empty apart from this document.

---

## 0. Executive summary

**Verdict: ClinicMind is a well-structured, clean, buildable prototype, not a product that can hold real patient data yet.** The code quality is good for its size, the docs are excellent, CI is green, and the architecture is sound. But several of the headline security guarantees in the README, the PR description and the sales demo are not true in the code, the flagship AI assistant cannot work because nothing ever feeds its retrieval store, and the clinical workflow is roughly a third built. The static demo the client saw shows features the real application does not have.

The six things that decide the plan:

1. **There is no login.** Any visitor to a tenant's URL is treated as that clinic's owner with full rights (`src/lib/auth/session.ts:54-83`). No password code exists anywhere. This alone blocks any deployment with real data. (SEC-1)
2. **A single tenant's embed key grants platform super-admin.** The token endpoint lets the caller pick any role, including `SUPER_ADMIN`, and the key is shown in the UI and in the client-facing embed snippet. (SEC-2, SEC-3)
3. **Row-Level Security and the "append-only audit" are not enforced.** Policies exist for 4 of 12 tenant tables, the app never activates them, and the DB role bypasses them anyway. (SEC-6)
4. **The AI assistant has no data.** Nothing writes to `knowledge_embeddings`, so every answer is "no context retrieved". The Gemini default model was retired in September 2025, so the documented "free tier" setup fails outright. (AI-1, AI-2)
5. **Next.js 14.2.35 carries 23 published advisories, 2 critical (unauthenticated RCE).** The 14.x line no longer receives fixes; the upgrade to 15.5.x/16 is mandatory before handover. (DEP-1)
6. **Repo hygiene:** `main` is empty, the product lives on a draft PR, and an unrelated second product (GROW Engine, PR #1) shares the repository with a deploy workflow that would SSH-deploy to Hostinger on the first push to `main`. That branch also has blocking security issues of its own (section 6.1). (REPO-1)

What is genuinely good and worth keeping: the modular layout, the Prisma schema (19 models, sensible indexes, soft delete, audit shape), the provider-agnostic AI adapter, the RBAC permission table, Zod validation on every input, strict TypeScript with zero `any`, the brand/white-label mechanism, the docs, and the CI pipeline.

### Headline numbers

| Measure | Value |
|---|---|
| ClinicMind source (ts/tsx, excl. tests) | 3,570 lines across 55 files |
| API routes / pages | 10 route handlers, 9 pages |
| Prisma models / tenant-scoped / with RLS policy | 19 / 12 / 4 |
| Unit tests | 10, all pure functions (RBAC table, hex→HSL, re-rank); 0 for auth, tenancy, routes |
| `npm audit` | 24 vulnerabilities (3 critical, 15 high); 4 in the production tree, Next.js critical |
| Typecheck / lint / tests / build | all pass locally (Node 20) |
| Mutation endpoints (PATCH/PUT/DELETE) | 0 |
| Writes to the RAG store | 0 |
| Secrets found in tree or history | 0 (only placeholder values) |

---

## 1. Repository state

| Item | State |
|---|---|
| `main` | One commit, "Initialize repository", no files |
| PR #2 — ClinicMind | Draft, open since 2026-06-21, 8 commits, 90 files, mergeable, CI green (build + Pages deploy) |
| PR #1 — The Grow Engine | Draft, open since 2026-06-10, 4 commits, 142 files, mergeable, **no CI checks** |
| Branch protection / CODEOWNERS / PR template | none |
| GitHub Pages demo | deployed from the PR #2 branch (`.github/workflows/pages.yml` runs on any `claude/**` push) |

The two PRs are two different products. GROW Engine is the agency's own marketing-intelligence platform (its README even says to clone `Oudoo/The-Grow-Engine.git`). ClinicMind's PR body says "the repo was empty when this started", so the two were built without knowledge of each other. If both PRs land on `main`, GROW's `.github/workflows/deploy.yml` will run `npm ci && npm run build` on the merged tree and SSH into `HOSTINGER_HOST` on every push to `main`.

**Recommendation (REPO-1, High):** land ClinicMind on `main` as the only product here; move GROW Engine to its own repository (or close PR #1 in this repo); enable branch protection on `main`; restrict the Pages demo deploy to `main` or a tag (REPO-2, Medium).

---

## 2. What ClinicMind is, as built

**Stack:** Next.js 14.2 App Router (RSC + route handlers, no server actions used), TypeScript strict, Tailwind 3, Radix (mostly unused), Prisma 5.22 on PostgreSQL 16 + pgvector + pg_trgm, `jose` for HS256 JWTs, Zod, Vitest 2, Docker/Compose, GitHub Actions.

**Request flow:** `middleware.ts` parses the `Host` header into a tenant hint (`acme.<ROOT_DOMAIN>` → slug; anything else → custom domain) and forwards it as `x-clinicmind-tenant`. `getActingContext()` (`src/lib/auth/session.ts`) turns that, or an embed JWT, into `{tenantId, userId, role}`. Route handlers call `assertCan(role, permission)` then a service in `src/modules/*` that filters by `tenantId`.

**Surfaces:** marketing landing (`/`), the dashboard (`/dashboard/*`: overview, patients, appointments, consultations, assistant, conversations, settings), the embeddable surface (`/embed/[tenantSlug]`, which renders only the assistant chat), `public/embed.js` loader, and the API (`/api/patients`, `/api/appointments`, `/api/assistant`, `/api/consultations/extract`, `/api/consultations/[id]/sign`, `/api/embed/token`, `/api/embed/session`, `/api/tenants`, `/api/me`, `/api/health`).

**Data model (`prisma/schema.prisma`):** Tenant, TenantEmbedConfig, Clinic, User, Session, LoginEvent, Patient, MedicalHistory, Medication, Appointment, Visit, Consultation, AiRun, Conversation, Message, Document, TimelineEvent, KnowledgeEmbedding (vector 1536), AuditLog. Of these, Session, LoginEvent, Document, Message, Conversation (writes), Clinic (beyond creation), KnowledgeEmbedding (writes), and the MFA/password fields on User have **no code using them**.

**AI layer:** one `AiProvider` interface with OpenAI, Anthropic, Gemini and an offline `echo` adapter; a RAG pipeline (embed → pgvector cosine → lexical re-rank → prompt with `[n]` context) and a transcript→JSON extraction pipeline. Every call is logged as an `AiRun`.

**Verified working locally** (see Appendix A): `npm ci`, `prisma generate`, `tsc --noEmit`, `next lint`, `vitest run` (10/10), `next build` (production). The GitHub CI run on the PR head is green and additionally applies the schema and the RLS SQL against a Postgres service.

---

## 3. Claims vs. reality

This table is the basis for the conversation with the client. "Claimed" means stated in the README, the PR description, `docs/ARCHITECTURE.md`, or the demo's "Production Report" tab.

| Claim | Reality in code | Status |
|---|---|---|
| "RBAC at every API boundary" | `assertCan` is called in every protected route. But the *identity* it checks comes from an unauthenticated resolver that hands out the owner role to anyone (SEC-1). | Misleading |
| "6 roles + embed-token session bridge" | Roles exist. The bridge lets the key holder pick any role incl. `SUPER_ADMIN` (SEC-2). | Partially true, unsafe |
| "Tenant isolation in queries **and** Postgres RLS" | Query scoping is consistent for reads. RLS is never activated and is bypassed by the DB owner role (SEC-6). Two write paths accept foreign `patientId`/`doctorId` (SEC-4). | Half true |
| "Append-only audit log, UPDATE/DELETE blocked at DB" | App writes audit rows for 4 actions and swallows failures. The DB policy does not block updates (permissive OR) and nothing blocks deletes (SEC-6, SEC-11). | False at the DB |
| "Sessions: httpOnly cookies, device + login history, MFA-ready" | Only the embed cookie exists. `Session`, `LoginEvent`, `mfaSecret`, `passwordHash` are unused columns. | Schema only |
| "Doctor AI Assistant (RAG, citations, never answers without retrieval)" | Pipeline exists and is correct, but no code ever inserts embeddings, so retrieval is always empty (AI-1). | Non-functional |
| "Gemini has a free tier — run at $0" | Default model `gemini-1.5-flash` was retired by Google in Sept 2025 → model-not-found (AI-2). Gemini cannot embed, so retrieval would use a hash pseudo-vector anyway (AI-3). | Broken |
| "Consultation Intelligence: audio → transcript → extract → review → sign" | No audio capture or transcription; the Record button only toggles a badge (CLIN-1). Review is view-only except the summary (CLIN-2). Extract and sign work. | One third built |
| "Patient CRM + unified timeline" | List + search + create-via-API. No add form, no detail page, timeline never rendered, no edit/delete (CLIN-5). | Minimal |
| "Appointments: week view, conflict detection, waitlist" | Create + 7-day list. No status changes, no reschedule/cancel; conflicts silently become WAITLISTED (CLIN-4). | Minimal |
| "WhatsApp / Voice / S3 / Redis queues" | README says "interfaces + schema in place" (honest). The demo shows them working (not honest). No code. | Not built |
| "Secure file uploads with malware scan" (demo report) | No upload code at all. | Not built |
| "Strict per-route framing/CSP" | Admin surface: yes (`X-Frame-Options: DENY`). Embed surface: no CSP at all; any site can frame it (SEC-7). | Half true |
| "Custom domain + subdomain, white-label" | Resolution and runtime theming work. No DNS/TLS verification flow; `customDomainVerified` is a DB flag only. | Works, manual |
| "Docker / Compose / CI" | Yes. Compose ships insecure defaults (SEC-5). No migrations (OPS-1). | True with caveats |
| "Arabic, Egyptian Arabic & English" | UI is English-only, LTR; `locale` fields unused (CLIN-7). | Not built |
| "Next.js pinned to patched 14.2.35" | Was true in June 2026. Now 23 advisories, 2 critical (DEP-1). | Outdated |

---

## 4. Findings

Severity: **Critical** = blocks any deployment with real data; **High** = must fix before handover; **Medium** = fix during Phase 2; **Low** = backlog.

### 4.1 Security and tenancy

**SEC-1 · Critical · No authentication; anyone is the clinic owner**
- `src/lib/auth/session.ts:54-58`: if the request carries `x-clinicmind-tenant`, `contextForSlug()` (lines 67-83) loads the tenant's first `CLINIC_OWNER`/`DOCTOR`/`SUPER_ADMIN` user and returns *that user* as the actor. If the tenant has no users it still returns role `CLINIC_OWNER` (line 81).
- `src/middleware.ts:20-21`: the header is set from the subdomain for every request, so `https://<slug>.<root>/dashboard` and every `/api/*` route are open to the public with owner privileges. On the apex domain the client's own `x-clinicmind-tenant` header passes through untouched (`new Headers(req.headers)`), so knowing a slug is enough from anywhere.
- Line 60-62: outside `NODE_ENV=production` every request is the demo owner.
- There is no login page, no password hashing, no session issuance; `passwordHash`, `Session`, `LoginEvent`, `mfaEnabled/mfaSecret` have zero references in `src/`.
- **Fix direction:** real authentication (email + password with argon2id/bcrypt, server sessions in the existing `Session` table or Auth.js, invitation + password reset, optional TOTP), remove the header-based resolver and the dev fallback outside tests, and make `getActingContext()` return `null` unless a verified session or embed token is present. Add tests that assert 401 on every route without a session.

**SEC-2 · Critical · Embed key = platform super-admin**
- `src/app/api/embed/token/route.ts:9-15`: the caller chooses `userId` (unchecked, need not exist) and `role` from the full enum including `SUPER_ADMIN`. The only check is `tenant.embed.publicKey === key` (line 39).
- `src/lib/auth/session.ts:34-48`: the token's role is trusted verbatim. `SUPER_ADMIN` → `tenant:manage` → `GET/POST /api/tenants` lists and creates tenants platform-wide.
- The "public key" is in fact the secret and is shown to every dashboard visitor (`src/app/dashboard/settings/page.tsx:82`) and embedded in the client-facing HTML snippet as `data-clinicmind-key` (`src/components/clinicmind/embed-instructions.tsx:27`), which contradicts `docs/INTEGRATION.md` ("never ship it to the browser"). `public/embed.js` does not even read that attribute; it needs `data-clinicmind-token-endpoint`, so the Settings snippet does not work. The server snippet (`embed-instructions.tsx:33-35`) names a `Bearer` header while the route expects `x-clinicmind-embed-key`.
- **Fix direction:** rename to `embedSecret`, store hashed, never render it after creation; cap the mintable role to the tenant's own roles (never `SUPER_ADMIN`), require `userId` to be an active user of that tenant, require `origin` and validate it, compare keys in constant time; fix the three snippets to match `embed.js` and the route.

**SEC-3 · High · Clinic owners can provision and list all tenants**
- `src/lib/auth/rbac.ts:47`: `CLINIC_OWNER` has `tenant:manage`. `src/app/api/tenants/route.ts:33,78` only checks that permission although the comment says "SUPER_ADMIN only". Split into `tenant:manage` (own tenant) and `platform:manage` (super-admin).

**SEC-4 · High · Cross-tenant writes through unchecked foreign keys**
- `src/app/api/consultations/extract/route.ts:24-41`: `patientId` from the body is written straight into a consultation of `ctx.tenantId`; the patient is never checked to belong to the tenant.
- `src/app/api/consultations/[id]/sign/route.ts:47-110`: the sign transaction then creates a Visit, appends diagnoses to that patient's `MedicalHistory`, inserts `Medication` rows and a `TimelineEvent` for the foreign patient.
- `src/modules/appointments/service.ts:50-90`: `patientId` and `doctorId` are likewise unchecked; a timeline event is written to the foreign patient.
- **Fix direction:** a `requireTenantPatient(tenantId, patientId)` helper (and the same for doctors/clinics) used in every write; add `tenantId` to `medical_histories`, `medications`, `documents`, `messages` so DB-level checks become possible.

**SEC-5 · High · Insecure secrets survive into production**
- `src/lib/env.ts:30-50`: when validation fails in production the code logs and continues with `AUTH_SECRET=dev-insecure-auth-secret-change-me` and `EMBED_SIGNING_SECRET=dev-insecure-embed-secret-change-me`. Both strings are in the public repo, so a misconfigured deploy lets anyone forge `SUPER_ADMIN` embed tokens.
- `docker-compose.yml:58-59` defaults the same values; the DB and MinIO use `clinicmind`/`clinicmind` and are published on all host interfaces (`5432`, `9000`, `9001`); `GEMINI_API_KEY` is missing from the `web` service.
- **Fix direction:** hard-fail at boot in production; remove defaults from Compose; bind infra ports to localhost.

**SEC-6 · High · Row-Level Security and audit immutability are not enforced**
- `prisma/sql/01_pgvector_and_rls.sql:34-52`: policies on `patients`, `appointments`, `consultations`, `audit_logs` only (4 of 12 tenant-scoped tables; `visits`, `ai_runs`, `timeline_events`, `knowledge_embeddings`, `conversations`, `users`, `clinics`, `tenant_embed_configs` have none).
- No code sets `app.current_tenant` (zero occurrences of `set_config`/`SET LOCAL` in `src/`), so the policy expression is always `"tenantId" = NULL`.
- The app connects as the role that owns the tables; PostgreSQL does not apply RLS to table owners unless `ALTER TABLE … FORCE ROW LEVEL SECURITY`. Result: RLS is inert. If a non-owner role were ever used, every query would return zero rows and the app would break.
- Lines 55-57: `audit_append_only … FOR UPDATE USING (false)` is a *permissive* policy OR'd with the tenant policy, so updates are allowed whenever the tenant policy passes; there is no `DELETE` policy at all.
- **Fix direction:** either implement RLS properly (dedicated non-owner app role, `FORCE ROW LEVEL SECURITY`, `SET LOCAL app.current_tenant` inside a transaction wrapper around every Prisma call, policies on all tenant tables, `AS RESTRICTIVE` deny policies for UPDATE/DELETE on `audit_logs`, a test that proves cross-tenant reads fail) or remove the claim from the docs and the demo. The former is roughly 2-3 days and worth it for a medical product.

**SEC-7 · Medium · Embed surface can be framed by any site; token relay trusts any origin**
- `src/middleware.ts:26-31` skips CSP for `/embed`, and `src/app/embed/[tenantSlug]/page.tsx` sets none. `frameAncestorsDirective()` (`src/lib/embed.ts:53-56`) and `HOST_DASHBOARD_ORIGIN` (`src/lib/env.ts:23`) are dead code. `allowedOrigins` is only consulted when minting a token and only if the caller volunteers an `origin` (`token/route.ts:43`).
- `src/components/clinicmind/embed-bootstrap.tsx:55-58,68`: `postMessage(..., "*")` and a `message` listener that does not check `e.origin`; any window that can post to the iframe can inject a (valid) token for another user/tenant.
- **Fix direction:** set `Content-Security-Policy: frame-ancestors <tenant allow-list>` in the embed route (DB lookup is fine there), validate `e.origin` against the allow-list, post to the known host.

**SEC-8 · Medium · No rate limiting, no body-size limits, unbounded strings**
- No limiter on `/api/assistant` and `/api/consultations/extract` (direct LLM spend), `/api/embed/token` (key guessing), or anything else. Zod schemas bound shape but not length (`fullName`, `reason`, `transcript` are unbounded). `maxDuration = 60` with no upstream timeout on provider `fetch` calls.

**SEC-9 · Medium · Gemini API key in the URL**
- `src/lib/ai/gemini.ts:37`: `?key=${env.GEMINI_API_KEY}` ends up in proxy and server logs. Use the `x-goog-api-key` header.

**SEC-10 · Medium · Thin security headers**
- `next.config.mjs:12-20`: nosniff, referrer policy, DNS prefetch only. No HSTS, no `Permissions-Policy`, no real CSP (script/connect sources), no `Cache-Control: no-store` on PHI responses.

**SEC-11 · Low**
- `audit()` catches and logs failures (`src/lib/audit.ts:37-40`); a "complete" trail can silently lose events. Consider failing the request or writing audit rows inside the same transaction.
- `publicKey` is a Prisma `cuid()` (not a CSPRNG secret) compared with `!==` (not constant-time).
- `AiRun.rawPrompt` stores up to 4,000 chars of transcript (`extract/route.ts:51`) and `retrievedContext` stores patient chunks: PHI in AI logs with no retention policy.
- `/api/me` and `/api/health` are unauthenticated (fine for health; `/me` leaks tenant id/slug and permissions once SEC-1 is fixed it becomes harmless).

### 4.2 Dependencies and platform

**DEP-1 · Critical · Next.js 14.2.35 is unpatched**
- `npm audit` lists 23 advisories against the installed version, including GHSA-2xp9-vwfh-vxw4 (unauthenticated RCE in the Image Optimization API via AVIF, critical, fixed in 15.5.24) and GHSA-p293-qw3h-jr36 (unauthenticated RCE on Windows hosts, critical), plus SSRF in Server Actions/rewrites, cache poisoning and several DoS issues. Nothing in the 14.x line receives these fixes.
- Upgrade path: Next 15.5.x (minimum) or 16.x. Known touchpoints in this codebase: sync `cookies()`/`headers()` (`src/lib/auth/session.ts:28-29`, `src/app/api/embed/session/route.ts:21`), sync `params`/`searchParams` (`src/app/api/consultations/[id]/sign/route.ts:31`, `src/app/embed/[tenantSlug]/page.tsx:13`, `src/app/dashboard/patients/page.tsx:9-14`), React 19, `eslint-config-next`. The `experimental.serverActions.bodySizeLimit` block is unused and can go.

**DEP-2 · High · Other vulnerable or end-of-life packages**
- Production tree: `nanoid` (high), `source-map-js` (high), `postcss` via Next (high).
- Dev tree: `vitest` 2.1 (critical via `tinypool`), `vite`, `esbuild`, ESLint 8 (end-of-life), Tailwind 3 / `braces` / `micromatch` (high). Totals: 24 vulnerabilities, 3 critical, 15 high.
- Prisma 5.22 is two majors behind (7.x current); `@types/node` 22 vs Node 20 engine.

**DEP-3 · Medium · Non-deterministic installs**
- `Dockerfile:14` and `.github/workflows/ci.yml:45` run `npm ci || npm install`, which hides lockfile drift. The Docker image also ships devDependencies and the full `node_modules` (no `output: "standalone"`), and `ENV PNPM_HOME` is a leftover.

**DEP-4 · Low · Unused libraries**
- `react-hook-form`, `@radix-ui/react-dialog`, `-dropdown-menu`, `-label`, `-tabs`, `-tooltip` are installed and imported nowhere. The Prisma `fullTextSearch` preview flag is enabled and unused.

### 4.3 AI layer

**AI-1 · High · The RAG store is never populated**
- `knowledge_embeddings` is read in `src/lib/ai/rag.ts:53-62` and written nowhere (zero references to `knowledgeEmbedding` outside that query). Creating a patient, signing a consultation, or adding a visit never produces an embedding. `retrieve()` therefore returns `[]`, `answerWithRag()` sends `CONTEXT: (none)`, the `echo` provider refuses and the real providers answer "insufficient context". The assistant and the entire `/embed` surface (which renders only the assistant) are non-functional with real data.
- **Fix direction:** an ingestion step on every clinical write (visit notes, signed extraction, diagnoses, medications, conversation summaries) plus a backfill command; chunking; a per-tenant re-index job; and a decision on the embedding model/dimension (see AI-3).

**AI-2 · High · Default models are retired or on a deprecation path**
- `src/lib/ai/gemini.ts:25`: `gemini-1.5-flash` was shut down by Google on 24 Sept 2025 (001 on 27 May 2025); calls return model-not-found. `docs/COSTS_AND_PAYMENTS.md` and the demo recommend exactly this configuration. Replacement: `gemini-2.5-flash`.
- `src/lib/ai/openai.ts:25`: `gpt-4o` is being retired (dates vary by source; ChatGPT access ended Feb 2026, API retirement was scheduled for 2026). Verify against OpenAI's deprecations page before relying on it.
- `src/lib/ai/anthropic.ts:18`: `claude-opus-4-8` is valid; current generation is `claude-opus-5-5`.
- **Fix direction:** model IDs must come from env (`OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`) with current defaults, and the health endpoint should report provider reachability.

**AI-3 · Medium · Embeddings only work with OpenAI; otherwise retrieval is random**
- `src/lib/ai/provider.ts:29-31` routes embeddings to OpenAI or `echo`. Anthropic and Gemini adapters throw on `embed()`. With a Gemini-only or Anthropic-only configuration (the "cheap" setups the docs promote), retrieval uses `hashEmbed()` (`src/lib/ai/echo.ts:54-62`), a character-hash that has no semantic meaning, while the UI still renders citations and a confidence badge. Gemini embeddings are 768-dim vs the 1536-dim column, as the file comment admits.

**AI-4 · Medium · "Confidence" and "citations" are cosmetic**
- Confidence is `0.9` if the provider stopped normally, else `0.6` (`openai.ts:50`, `anthropic.ts:56`, `gemini.ts:68`), and `0.1` when nothing was retrieved. Citations are the retrieved chunks, not what the model actually used. The demo pitches both as safety guardrails; the handover material must not.

**AI-5 · Medium · PHI leaves the system with no governance**
- Transcripts and retrieved patient records are sent to OpenAI/Anthropic/Google and persisted in `ai_runs`. There is no DPA/BAA with those vendors, no patient consent capture, no data-residency option, no retention/purge job. Egypt's Personal Data Protection Law (151/2020) applies to an Egyptian clinic; if the client is elsewhere, the local equivalent does. The docs mention BAAs as a to-do; the product needs the controls.

**AI-6 · Low**
- No streaming, no provider timeout/retry; `jsonMode` is ignored by the Anthropic adapter (handled by the tolerant parser); extraction returns an empty object on any parse failure with no signal to the clinician (`src/lib/ai/extraction.ts:66-76`).

### 4.4 Clinical workflow and product completeness

**CLIN-1 · High · Recording and transcription do not exist**
- `src/components/clinicmind/consultation-panel.tsx:72-82`: the Record button flips a boolean and shows a "● transcribing" badge. No `MediaRecorder`, no upload, no Whisper/Gemini-audio call, no `audioKey`. The demo narrates "a real consultation transcript is streaming in".

**CLIN-2 · High · "Review before sign" is read-only**
- Lines 109-118 render symptoms, diagnoses, medications, tests and follow-ups as badges; only the summary textarea is editable (121-128). `sign()` (46-54) posts the unedited AI extraction. The product's safety story ("AI drafts, the clinician decides") requires every field to be editable, removable and addable before signing, with the diff recorded in the audit log.

**CLIN-3 · High · Signing corrupts the record over time**
- `src/app/api/consultations/[id]/sign/route.ts:71-83` appends raw diagnosis strings to a JSON array with no de-duplication, no coding (ICD-10), no dates; 85-97 inserts a new `Medication` row per sign with no discontinue/replace logic, so repeat visits produce duplicate active medications. No allergy or interaction check against `MedicalHistory.allergies`. The created `Visit` has no `appointmentId`.

**CLIN-4 · High · Appointments have no lifecycle**
- Only `GET`/`POST /api/appointments` exist; there is no confirm, check-in, start, complete, cancel, no-show or reschedule, so the status enum is unreachable from the product. Conflicts silently set `WAITLISTED` (`src/modules/appointments/service.ts:77`) with no UI feedback or notification. `clinicId` is never set. The week view is read-only and groups by UTC date while showing local times.

**CLIN-5 · Medium · Patient CRM is a list**
- No "add patient" form (creation is API-only), no detail page, no edit/archive/merge, no document upload. `getPatient()` and the `TimelineEvent` feed are implemented in the service layer and rendered nowhere. Search exists only as a URL parameter (`?q=`) with no input field. Hard-coded `take: 100` with no pagination. `dateOfBirth` requires a full ISO datetime (`src/modules/patients/service.ts:8`), so a plain date fails validation.

**CLIN-6 · Medium · Conversations, documents, channels: read-only pages over empty tables**
- `src/app/dashboard/conversations/page.tsx` reads `conversation`; nothing writes it. `Document`, `Message`, WhatsApp, voice, Redis, S3: schema and env vars only. The README states this; the demo and `docs/DEMO_SCENARIO.md` present them as working.

**CLIN-7 · Medium · No localisation**
- English-only strings, LTR layout, `en-GB` date formats, `lang="en"`. `Tenant.settings.locale` and `Conversation.locale` are unused. For an Egyptian clinic (Cairo timezone, EGP, Arabic patient names in the seed) Arabic UI and RTL are table stakes.

**CLIN-8 · Medium · Timezone and metric correctness**
- `src/modules/analytics/service.ts:32-36` computes "today" in the server's timezone and `buildTrend` (95-100) buckets by UTC date; `Clinic.timezone` is never read. `noShowRate` divides by appointments with `startsAt >= weekAgo` with no upper bound, so future bookings deflate the rate (47-48, 63).

**CLIN-9 · Low**
- No user management UI/API (invite, role change, deactivate); provisioning creates an `INVITED` owner with no invitation email or activation; multi-clinic (`Clinic`) is unused; custom-domain verification is a manual DB flag; the "live" badge in the shell is hard-coded.

### 4.5 Operations and deployment

**OPS-1 · High · No migrations**
- Schema is applied with `prisma db push` (README, CI, Dockerfile). There is no `prisma/migrations/` directory, so there is no history, no rollback, and `db push` can drop columns on schema changes. The pgvector index and RLS SQL are a separate manual step that is easy to skip. Move to `prisma migrate` with the SQL as a migration.

**OPS-2 · High · No production deployment path**
- The docs name a Hostinger Next.js plan, but there is no deploy workflow, no environment/secrets management, no process for wildcard DNS + TLS for tenant subdomains or custom domains, no reverse-proxy config. Compose is dev-grade (SEC-5).

**OPS-3 · Medium · No observability**
- `console.error` only. No error tracking (Sentry/GlitchTip), no structured request logs, no metrics, no alerting. `/api/health` exists and is good.

**OPS-4 · Medium · No backup, restore, retention or DR procedure**
- Required for medical data and for the handover runbook.

**OPS-5 · Low**
- `.github/workflows/pages.yml` deploys the public demo from any `claude/**` branch with `enablement: true`; CI has no `npm audit` gate; Redis/S3/WhatsApp variables are documented but not in the env schema.

### 4.6 Code quality and tests

Positives: strict TypeScript with `noUncheckedIndexedAccess`, zero `any`, zero TODO/FIXME, lint clean, small files, consistent naming, every input validated with Zod, uniform error mapping (`src/lib/api.ts`), clear separation (routes → modules → db), good inline documentation, and docs that explain intent. The schema is thoughtfully indexed. This is a codebase a new developer can read in an afternoon.

**TEST-1 · High · Tests do not cover anything that can fail**
- `src/lib/__tests__/`: 10 tests over `can()`, `hexToHslTriplet()`, `tenantThemeStyle()`, `rerank()`. Nothing exercises `getActingContext`, tenant scoping, any route handler, the sign transaction, token minting/verification, or the extraction parser. CI provisions Postgres but no test uses it. Before Phase 2 feature work, add route-level tests with a test database (auth required, cross-tenant denied, sign is transactional) so the security fixes stay fixed.

**QUAL-1 · Medium · Docs, UI snippets and code disagree**
- Three different embed snippets (Settings UI, `docs/INTEGRATION.md`, `public/embed.js` header comment) with different attributes and headers (see SEC-2). README quick-start says "auto-authenticates as demo owner" which is the SEC-1 behaviour, not a dev convenience. `package.json` is `UNLICENSED` while `docs/COSTS_AND_PAYMENTS.md` says the code is "100% free and open-source" and "Yours": the license/IP terms of the sale need to be written down before handover.

---

## 5. The static demo vs. the product

`demo/` is a hand-written vanilla-JS page with hard-coded data (`demo/assets/data.js`: 1,284 patients, 412 AI interactions, EGP revenue, Arabic WhatsApp threads, an AI answer that names overdue patients with citations, a transcript that "streams in"). Its "Production Report" tab (`demo/assets/report.js`) asserts RLS, DB-blocked UPDATE/DELETE on the audit log, device + login history, MFA-ready auth, malware-scanned uploads, Redis-queued jobs, S3 storage, and CI-run migrations. Section 3 shows which of those are not true of the application.

If the doctor bought ClinicMind on the strength of this demo, the handover conversation needs an explicit list of (a) what works today, (b) what is being built in Phase 2, and (c) what is out of scope. Otherwise the first week of real use will surface the gaps as "bugs".

---

## 6. The GROW Engine branch (PR #1)

Characterisation from its README, PR body, manifests and workflow; a deeper review was run in parallel and its findings are appended in section 6.1.

- Separate product: a multi-tenant marketing/growth-intelligence platform for the agency (clients, leads, meetings, scorecards, ad-platform and CRM integrations, forecasting, AOM memory, billing domain). Monorepo (`apps/web` Next 15 + React 19 + Auth.js v5 beta, `apps/worker` BullMQ, `packages/core`, `packages/db` Drizzle + pgvector). About 17,600 lines of TypeScript/SQL over 142 files, written over two days (10-11 June 2026).
- No CI on the branch. The only workflow is `deploy.yml`: on push to `main` it builds and then SSH-deploys with `appleboy/ssh-action` to `HOSTINGER_HOST` and reloads PM2. This is the collision risk in REPO-1.
- Demo credentials (`admin@demo.growengine.app / DemoAdmin2026!`, `client@acme-outdoor.com / DemoClient2026!`) are published in the README and PR body; fine for a seed, but they must never be used on a real deployment.
- No reference to ClinicMind, clinics or patients anywhere in its tree; the two codebases share nothing (ClinicMind was built to be *embedded in* GROW as a tab via the token bridge, not to share code).
- Recommendation: move it to `Oudoo/The-Grow-Engine` (the URL its own README uses) and close PR #1 here. If the agency wants ClinicMind to appear as a tab inside GROW, that is an integration task on the GROW side (mint an embed token server-side, frame `/embed/<slug>`), and it depends on SEC-2 being fixed first.

### 6.1 Deeper review findings

A parallel read of the whole GROW branch produced the following. Items marked ✔ were re-verified directly against the source during this audit; the rest are reported with their evidence and should be confirmed in GROW's own audit.

**Completeness**
- Very little scaffolding: no stub/mock/fake-data markers outside the seed, which generates 120 days of synthetic metrics with `demo-seed-*` request ids (`packages/db/src/seed.ts:200-251`).
- The 11 integration connectors are real, read-only HTTP clients with error handling, but: there is no OAuth connect flow (users paste raw tokens, `apps/web/src/app/actions/integrations.ts:23,42-47`); currency is hard-coded to USD on every spend/revenue value (`packages/core/src/integrations/meta.ts:74,84`, `ga4.ts:109`, `ads-platforms.ts:65-332`); the X connector sends only a bearer token and omits `entity_ids` (`ads-platforms.ts:301-312`); TikTok, LinkedIn and GA4 fetch a single page; pinned API versions (Google Ads v18, LinkedIn 202411, Graph v21.0) are likely past provider support.
- Store-only features with no behaviour behind them: feature flags are written but never read for gating (`apps/web/src/app/actions/admin.ts:141-165`); a "pilot launch" inserts a row and touches no ad platform (`actions/creative.ts:219-230`); invoices are rows with no payment gateway; rule-based webhook notifications can never deliver because the `metadata.webhookUrl` they need is never set (`packages/core/src/notifications.ts:145-146,236-243`).
- Forecasting uses fixed Holt-Winters α/β/γ rather than fitted values (`packages/core/src/forecasting.ts:129`); the "confidence" score is a points heuristic (`confidence.ts:39-76`); upload limits of 500 MB and 1 GB exceed the 200 MB server-action body limit (`actions/meetings.ts:98`, `actions/work.ts:253`, `apps/web/next.config.ts:9`).

**Security**
- ✔ **Unauthenticated SSRF.** `POST /api/public/lead-audit` accepts any URL, rate-limited only by the spoofable `X-Forwarded-For` header (`apps/web/src/app/api/public/lead-audit/route.ts:27-33`); the worker fetches it with redirects followed and no private-address block (`packages/core/src/crawler.ts:31-36`); submitted form fields go straight into an LLM prompt (`apps/worker/src/workers/ai/reports.ts:50-66`); the result is readable by anyone holding the id via `GET`.
- ✔ **Unsanitised HTML.** `apps/web/src/components/markdown.tsx` renders `marked` output through `dangerouslySetInnerHTML` with no sanitiser; it is used for user-entered notes and for LLM output (`(internal)/leads/page.tsx:53`, `(internal)/aom/doc/[id]/page.tsx:28`), so stored XSS is reachable, including through prompt injection from crawled sites. Email HTML is also built unescaped (`notifications.ts:105`).
- ✔ **Open self-registration** creates a tenant and a tenant-level super-admin with no email verification (`apps/web/src/app/actions/auth.ts:53-103`).
- ✔ **Cross-tenant leak.** `/system` lists the last 10 failed jobs (queue, job name, error text) with no tenant filter, visible to any registered team user (`apps/web/src/app/(internal)/system/page.tsx:16-21`).
- ✔ **Weak defaults.** `required()` accepts fallbacks, so a missing `CREDENTIAL_ENCRYPTION_KEY` silently becomes an all-zero AES key and `AUTH_SECRET` a known string (`packages/core/src/env.ts:7-13,31-34`). `scripts/setup-mac.sh:80-81` writes a fixed auth secret and a 63-hex-character key (31 bytes), which makes AES-256-GCM throw whenever an integration credential is saved.
- Sound parts: bcrypt (cost 12) passwords; AES-256-GCM with a random IV for stored credentials (`packages/core/src/crypto.ts:4-31`); API keys stored as SHA-256 and looked up by hash; tenant filtering is consistent in server actions and `/api/v1/*`.
- Gaps: Auth.js JWT sessions (12 h, `trustHost: true`) embed roles and permissions at login and never re-check them, so revocation waits for expiry; no login rate limit or lockout; read permissions are not enforced on internal pages (only `requireTeamUser`); approvals need no permission (`actions/intelligence.ts:89`, `actions/creative.ts:118`); several actions take `clientId`/entity ids from the client without ownership checks (`actions/work.ts:114-169`, `actions/meetings.ts:191-196`, `actions/admin.ts:322-333`); API key scopes are never checked; invite tokens are stored in plaintext.

**Data and operations**
- ✔ 63 tables and 28 enums across 11 schema files, one Drizzle migration, no RLS. ✔ Zero automated tests and no ESLint config. ✔ The seed creates hard-coded logins (including an undocumented `pm@demo.growengine.app`) with no production guard.
- `deploy.yml`'s job is named "build-and-test" but runs only `npm ci && npm run build`, then `git reset --hard`, build, migrate and PM2 reload over SSH with no health check or rollback. `scripts/backup.sh` dumps to the same host, unencrypted, with no off-site copy.
- Smells: a `formAction` cast used on 49 forms discards server-action error results, so users get no validation feedback (`apps/web/src/lib/utils.ts:40-45`); `apps/worker/src/lib/track.ts:22` updates `queue_jobs` by `bullJobId` alone although BullMQ ids are per-queue counters, so status rows collide across the 5 queues; `notifications.ts:225` scans `user_roles` across all tenants.

**Bottom line for GROW:** a much larger and more complete build than ClinicMind (real connectors, a worker, forecasting), but with its own blocking security issues (SSRF, XSS, zero-key fallback, cross-tenant `/system`), no tests, and a deploy workflow that must not land in this repository. It needs its own audit in its own repository.

---

## 7. Recommended plan

The order matters: the client's feature requests sit on top of a codebase that cannot safely hold patient data today. Doing features first would mean rewriting them when the auth and tenancy model changes.

### Phase 2A — Make it safe (blocks everything else)

| # | Work | Resolves | Size |
|---|---|---|---|
| 1 | Real authentication: password login (argon2id), server sessions in `Session`, invitation + reset flows, logout, optional TOTP; remove header resolver and dev bypass; 401 tests on every route | SEC-1 | L (5-8 d) |
| 2 | Embed hardening: secret stored hashed, role ceiling, `userId` must exist, origin required, constant-time compare, CSP frame-ancestors on `/embed`, origin check in the iframe; one consistent snippet | SEC-2, SEC-7 | M (2-3 d) |
| 3 | Permission split (`platform:manage`), tenant-ownership checks on every foreign key, `tenantId` on child tables | SEC-3, SEC-4 | M (2-3 d) |
| 4 | Fail-fast env, Compose without defaults, localhost-bound ports, security headers, rate limiting, body limits | SEC-5, SEC-8, SEC-10 | S-M (2-3 d) |
| 5 | Next.js 15.5+/16 upgrade, React 19, ESLint 9, Vitest 3+, `npm audit` gate in CI, deterministic installs, slim Docker image | DEP-1..3 | M (2-4 d) |
| 6 | Prisma migrations incl. pgvector/RLS SQL; RLS done properly (app role, FORCE, `SET LOCAL`, restrictive audit policies) or claim removed | OPS-1, SEC-6 | M (2-3 d) |
| 7 | AI config: env-driven model IDs with current defaults, API key in header, provider timeouts, health reports provider status | AI-2, SEC-9, AI-6 | S (1 d) |
| 8 | Error tracking + structured logs, backup/restore script and runbook, retention job for `ai_runs` | OPS-3, OPS-4, AI-5 | M (2-3 d) |
| 9 | Route-level test suite against a test Postgres (auth, isolation, sign transaction, token flow) | TEST-1 | M (3-4 d) |

Roughly **4-6 weeks for one senior full-stack engineer**. Items 1, 3 and 5 are the critical path.

### Phase 2B — Make the demoed features real

| # | Work | Resolves | Size |
|---|---|---|---|
| 10 | Patient CRUD UI, detail page with the timeline, search box, pagination, archive | CLIN-5 | M (4-6 d) |
| 11 | Appointment lifecycle API + UI (confirm/check-in/complete/cancel/no-show/reschedule), conflict feedback, clinic + doctor assignment, clinic-timezone day boundaries | CLIN-4, CLIN-8 | M (3-5 d) |
| 12 | Editable review-before-sign (add/remove/correct every field), de-duplicated coded diagnoses, medication reconciliation (stop/replace), allergy check, audit diff | CLIN-2, CLIN-3 | M (3-5 d) |
| 13 | RAG ingestion on write + backfill + re-index; embedding model decision (OpenAI 1536 or Gemini 768 with a new column); real grounding/confidence semantics in the UI | AI-1, AI-3, AI-4 | M (3-5 d) |
| 14 | Audio capture in the browser, upload to object storage, transcription (Whisper or Gemini audio), Arabic/English transcript | CLIN-1 | L (4-8 d) |
| 15 | Arabic UI + RTL + locale-aware formats | CLIN-7 | L (5-8 d) |
| 16 | User management UI (invite, roles, deactivate) and tenant settings (branding, allowed origins) | CLIN-9 | M (3-4 d) |

Roughly **5-8 weeks**. WhatsApp/voice channels and document uploads are not in this estimate; each is a separate L-sized slice if the client is paying for them.

### Phase 2C — The client's requested features

To be scoped with the doctor once 2A is underway (see section 8). Each feature should be specified against the real product, not the demo.

### Phase 3 — Handover

Deployment runbook (hosting, DNS/TLS for subdomains and custom domains, env/secrets, backups, restore drill), admin and user manual, data-protection documentation (DPA with AI vendors, privacy notice, retention), license/IP transfer document, credential rotation, support/SLA agreement, training session. Size: **1-2 weeks**.

---

## 8. Open questions for the team and the client

1. **What exactly did the doctor buy?** One clinic on one domain, or the multi-tenant SaaS story? This decides whether tenant provisioning, custom domains and the embed bridge are in scope or can be simplified away.
2. **Which features were promised** beyond what is in section 3's "works" column? In particular: audio recording, WhatsApp receptionist, voice agent, Arabic UI, document uploads.
3. **Hosting target and operator:** Hostinger as documented, or a VPS/cloud? Who operates it after handover (the agency on retainer, or the clinic)? This sets how much of OPS-2..4 we must automate.
4. **AI provider and data residency:** is sending transcripts to OpenAI/Google/Anthropic acceptable to the clinic and lawful where it operates? Budget per month for AI usage?
5. **Languages:** Arabic and English both required at launch? Egyptian Arabic for the assistant?
6. **License and IP:** what the sale contract says about code ownership, and whether the agency keeps the right to reuse the platform for other clinics.
7. **Timeline and budget** for Phase 2A, which is non-negotiable before any real patient record is entered.

---

## Appendix A — Verification log

Run on 2026-10-21 in a clean Linux container, Node 20, against `7d3007a`.

| Step | Command | Result |
|---|---|---|
| Install | `npm ci` | OK (lockfile honoured) |
| Client | `npx prisma generate` | OK |
| Types | `npm run typecheck` (`tsc --noEmit`) | OK, 0 errors |
| Lint | `npm run lint` (`next lint`) | OK, 0 warnings |
| Tests | `npm test` (`vitest run`) | 3 files, 10 tests, all pass |
| Build | `NODE_ENV=production npm run build` | OK |
| Audit | `npm audit` | 24 vulns: 3 critical, 15 high, 6 moderate; prod tree: next (critical), nanoid, source-map-js, postcss |
| Outdated | `npm outdated` | next 14→16, prisma 5→7, react 18→19, eslint 8→10, tailwind 3→4, vitest 2→5, zod 3→4 |
| Secrets | regex scan of both trees and all history | none (placeholders only) |
| RLS | grep `set_config\|SET LOCAL\|current_tenant` in `src/` | 0 matches |
| RAG writes | grep `knowledgeEmbedding\|knowledge_embeddings` in `src/` | 1 match (the SELECT) |
| Mutations | grep `PATCH\|PUT\|DELETE` handlers | 0 |
| GitHub | PR #2 check runs on head | `build` success, `deploy` (Pages) success |
| Live demo | `https://oudoo.github.io/ClinicMind/` | not reachable from the audit container (egress policy); last Pages deploy succeeded 2026-06-21 |

## Appendix B — Inventory (ClinicMind branch)

```
.github/workflows/ci.yml, pages.yml        CI (typecheck/lint/test/build + schema + RLS SQL), Pages demo deploy
Dockerfile, docker-compose.yml             multi-stage image; Postgres+pgvector, Redis, MinIO, web
prisma/schema.prisma                       19 models, 11 enums
prisma/sql/01_pgvector_and_rls.sql         ivfflat index, trigram index, RLS on 4 tables
prisma/seed.ts                             "demo" tenant, 2 users, 5 patients
docs/                                      ARCHITECTURE, INTEGRATION, SAAS_MODEL, COSTS_AND_PAYMENTS, DEMO_SCENARIO
demo/                                      static sales demo (hash router, hard-coded data, "Production Report")
public/embed.js                            iframe loader + token relay
src/middleware.ts                          host → tenant hint; X-Frame-Options/CSP for non-embed routes
src/lib/env.ts                             Zod env (falls back to insecure defaults)
src/lib/db.ts                              Prisma singleton, notDeleted filter
src/lib/tenant.ts                          host/slug/custom-domain resolution
src/lib/auth/rbac.ts                       6 roles × 15 permissions
src/lib/auth/session.ts                    acting-context resolver (embed token → header → dev demo)
src/lib/embed.ts                           HS256 sign/verify, (unused) frame-ancestors helper
src/lib/audit.ts                           append-only audit writer (errors swallowed)
src/lib/ai/{types,provider,openai,anthropic,gemini,echo,rag,extraction}.ts
src/modules/{patients,appointments,analytics}/service.ts
src/app/api/...                            10 route handlers (see section 2)
src/app/dashboard/...                      7 pages + layout + shell
src/app/embed/[tenantSlug]/page.tsx        embeddable assistant surface
src/components/clinicmind/                 assistant-chat, consultation-panel, embed-bootstrap, embed-instructions
src/components/ui/                         primitives (bento, card, badge, metric), button, spark-chart
src/lib/__tests__/                         rbac, rag (rerank), brand
```
