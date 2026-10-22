# Clinic AI Implementation Spec — analysis and roadmap for ClinicMind

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Input** | "Clinic AI Implementation Spec" (GrowCDX, 2026-10-02): six modules, 16-week plan, 2,800 hours, Egypt dermatology + hair-transplant clinic |
| **Baseline** | ClinicMind `main` after the Phase 1 audit and the hardening/feature sprint (see `docs/PHASE1_AUDIT.md`) |
| **Purpose** | Say precisely what the spec asks for, what ClinicMind already covers, what is missing, how the existing all-in-one inbox tool fits, and in what order to build |

---

## 0. Verdict in one paragraph

The spec describes a **patient-facing conversational AI platform** (WhatsApp, Instagram, web chat, phone) wrapped around a clinic's operations, with a doctor-facing documentation copilot, photo tracking, post-treatment protocols and a management layer. ClinicMind today is a **staff-facing clinic operating system**: secure multi-tenant sign-in, patients, appointments, consultation extract-review-sign, a retrieval-grounded assistant over the clinic's own records, audit and migrations. The two overlap on the foundation (one Postgres record of truth with RLS and pgvector, TypeScript, Next.js apps, provider-agnostic AI, roles, audit) and on about a third of Modules 2, 3 and 6. The patient-facing half (Modules 1 and 5), the photo module (4) and the conversation gateway do not exist. ClinicMind is therefore the right **core** for the spec, not the spec itself: it removes roughly 10 to 14 of the spec's 70 person-weeks (foundation, scheduling, auth, tenancy, documentation sign-off) and changes the build order, because the inbox/gateway work can start immediately against a working clinic record. Your existing all-in-one inbox tool is the natural owner of the channel gateway and staff inbox; the integration contract in section 5 is the first thing to agree.

---

## 1. What the spec asks for (compressed)

| Module | Core outcome | Spec effort | Live by |
|---|---|---|---|
| Foundation | One Postgres patient record, one conversation gateway, one AI orchestrator, worker (pg-boss), Next.js staff/patient apps, R2/S3, reporting schema, Sentry, LLM call log | 8 pw | week 3 |
| 1 · AI front desk | Answers, qualifies, books real slots, chases silent leads on WhatsApp/IG/web/phone; staff inbox with shadow/assist/auto modes | 10 pw | week 4 (WA) → 8 (phone) |
| 2 · Consultation prep | Intake link at booking → structured answers + photos → one-page doctor brief, hair-transplant structure | 5 pw | week 8 |
| 3 · Documentation copilot | Ambient recording/dictation → transcript → note, plan, instructions, consent draft, referral; evidence links; doctor signs | 6 pw | week 9 |
| 4 · Photography | Standardised capture, auto stage/view organisation, timeline, side-by-side, flags for review, consented marketing exports | 6 pw | week 11 |
| 5 · Post-treatment concierge | Versioned protocols (day 0 … month 12), structured check-ins on WhatsApp, keyword + AI triage, escalation ladder, roster | 6 pw | week 12–13 |
| 6 · Management layer | Metric definitions, nightly reporting schema, dashboards, weekly AI brief, anomaly alerts, NL questions | 6 pw | week 16 |
| Cross-cutting | Shadow→assist→auto modes, prompt versioning + eval sets as deploy gates, structured outputs everywhere, red-line rules, PDPL compliance, 2FA, consent capture, retention, kill switch | hardening 6 pw + design/QA/delivery 17 pw | gates 1–4 |

Assumptions that drive it: one site, 3–6 doctors, Egypt, Arabic (Egyptian) + English, WhatsApp carries 70% of enquiries, no existing EMR, AI never diagnoses, a squad of 4–5 for 16 weeks, clinic lead 4 h/week.

---

## 2. What ClinicMind is after this sprint

| Capability | State on `main` |
|---|---|
| Multi-tenant core (tenant per clinic, subdomain/custom domain, white-label) | Done |
| Staff authentication (argon2id, server sessions, invitations, reset, lockout, rate limits), RBAC 6 roles, platform vs tenant permissions | Done |
| Patients: CRUD, detail page, medical history, medications, timeline, search, pagination, archive | Done (this sprint) |
| Appointments: booking with conflict detection/waitlist, lifecycle (confirm → check-in → in progress → complete, cancel, no-show, reschedule), clinic-timezone day boundaries | Done (this sprint) |
| Consultations: transcript → structured extraction → **editable** review → sign; de-duplicated diagnoses; medication reconciliation; discard; history | Done (this sprint); **no audio capture yet** |
| AI assistant: ingestion of patient/visit/consultation/conversation documents into pgvector, hybrid retrieval, grounded answers with citations to patients, honest confidence; provider-agnostic (Gemini / OpenAI / Anthropic / offline), env-driven models, timeouts | Done (this sprint) |
| Conversations: data model + read-only view (seeded) | Model only; **no gateway, no sending** |
| Security: fail-fast env, CSP, per-tenant frame-ancestors on the embed surface, API rate limits, append-only audit (DB trigger), RLS policies in migrations (activation with a non-owner role pending), tenant-scope checks on every foreign key | Done |
| Operations: Prisma migrations, Docker/Compose (dev + production with TLS), nightly backups, runbook, CI (typecheck, lint, 150+ route/unit tests on Postgres, build, Playwright e2e) | Done |
| Analytics overview (patients, appointments, no-show, AI activity, diagnoses) | Basic |
| Arabic/RTL UI, 2FA, document/photo uploads, WhatsApp/voice channels, worker/queue, reporting schema, consent records, retention jobs | **Not built** |

---

## 3. Gap map: spec entity by entity

| Spec entity | ClinicMind today | Gap |
|---|---|---|
| Patient (phone E.164 unique, language, consent flags with timestamps, source, tags, assigned doctor) | `Patient` has phone, whatsapp, language, tags, notes | Add `consents` (kind, version, text hash, at, by), `source`/campaign, `assignedDoctorId`; make phone unique per tenant |
| Conversation / Message (channel, direction, media, status, 24-h window, handled by, intent, sentiment) | `Conversation`, `Message` (channel, direction, body, meta) | Add status, `windowExpiresAt`, `handledBy` (AI/staff/mixed), `intent`, `sentiment`, media refs, delivery/read receipts, idempotency key |
| Lead (stage, concern, treatment interest, source/campaign, lost reason, objections, score) | none | New `Lead` + `LeadEvent`; link to Conversation and Patient |
| Appointment (type, reminder log, intake completion) | full lifecycle | Add `type`, reminder log, `intakeId`, deposit status |
| Intake (template version, answers JSON, images, completion %, brief, read-at) | none | New `IntakeTemplate`, `Intake`, `Brief` |
| Encounter + Note (audio, transcript, structured note, plan, documents, versions, signed by/at) | `Visit` + `Consultation` (transcript, extraction, summary, signed) | Add audio object key + retention, note versions, generated `Document`s (plan, instructions, consent, referral), evidence spans |
| Procedure (type, doctor, date, revenue, grafts/donor notes, protocol) | none | New `Procedure` (hair-transplant record) |
| Photo (view, stage, captured at, quality, flags) | `Document` model (unused) | New `Photo` + object storage (R2/S3), EXIF stripping, signed URLs |
| Protocol / Enrolment / Check-in | none | New engine + worker |
| Event log (append-only) | `AuditLog` append-only (trigger) | Add read-access logging for photos/documents |

---

## 4. Architecture alignment

**Keep from ClinicMind** (it matches the spec's stack decisions): Postgres + pgvector as the single record, RLS, TypeScript end to end, Next.js for staff/patient web, provider-agnostic AI with structured outputs, roles/audit, migrations, Docker.

**Add** (spec requirements ClinicMind lacks):

1. **Worker + queue.** The spec is right that nothing heavy belongs in request cycles. Add `apps/worker` on **pg-boss** (Postgres-backed, no Redis) for: ingestion, transcription, brief generation, protocol scheduling, reminders, nightly reporting models, retries with backoff and a dead-letter table. ClinicMind's `ingestInBackground` is the seam this replaces.
2. **Conversation gateway.** One webhook per channel adapter, idempotency keys, outbound queue with retries, receipts. **Recommendation: your all-in-one inbox tool owns this** (section 5); ClinicMind consumes events and exposes tools.
3. **AI orchestrator.** Today ClinicMind has call sites (assistant, extraction). The spec needs an orchestrator with: prompt registry (versioned, stamped on every `AiRun`), per-module mode switch (shadow/assist/auto), a shared red-line system block, tool allow-lists scoped to the current patient, eval sets as deploy gates, cost guards. This is a new `packages/ai` layer; the provider adapters already exist.
4. **Primary model.** The spec chooses Claude Opus 5.5 through the Anthropic SDK with adaptive thinking, structured outputs and prompt caching, plus a cheap router. Keep ClinicMind's adapter layer but make the Anthropic path first-class through the SDK (structured outputs instead of "return JSON" prompts); keep Gemini/OpenAI as configurable alternatives and for embeddings (Anthropic has none).
5. **Object storage** (R2/S3, private, signed URLs, lifecycle) for audio and photos.
6. **Reporting schema** built nightly by SQL models with tests, plus the live views.
7. **Observability**: Sentry-compatible error tracking, structured logs, and the LLM call log with prompt version, tokens, latency, cost (extend `AiRun`).
8. **Patient-facing web** (intake, photo upload, consent) as mobile web pages under the same Next.js app, with their own token-based access (link with signed, expiring token), not staff sessions.

**Repository shape.** Stay in one repository and move to npm workspaces when the worker lands: `apps/web` (current app), `apps/worker`, `packages/db`, `packages/ai`, `packages/core`. Do it as a mechanical move in one PR before Module 1 work starts.

---

## 5. The all-in-one inbox: integration plan

You already have an inbox tool. The spec's Module 1 and the staff-inbox requirements map onto it almost one-to-one (one queue across channels, AI drafts staff can send/edit/discard, context pane, mode switch, canned replies, SLA timers). The cleanest split:

**Inbox tool owns:** channel adapters (WhatsApp Cloud API, Instagram/Messenger, website widget, voice platform transcripts), the unified thread model, agent assignment, templates/approval status, delivery receipts, the inbox UI.

**ClinicMind owns:** the patient record, scheduling, clinical data, the assistant's retrieval, protocols (Module 5 logic), consent state, audit, and the **tools** the front-desk AI needs to act.

**Contract (to agree with the inbox team):**

| Direction | Endpoint / event | Purpose |
|---|---|---|
| Inbox → ClinicMind | `POST /api/integrations/inbox/events` (HMAC-signed, idempotency key) | `message.received`, `message.sent`, `conversation.assigned`, `conversation.closed`, `lead.updated`; ClinicMind stores/links to `Conversation`/`Message`/`Lead` and updates the patient timeline |
| Inbox → ClinicMind | `GET /api/integrations/patients/lookup?phone=` | Identify the patient (or create a lead) from the sender |
| Inbox → ClinicMind | `GET /api/integrations/scheduling/slots?type=&doctorId=&from=&to=` | Real availability (three slots to offer) |
| Inbox → ClinicMind | `POST /api/integrations/scheduling/appointments` / `PATCH …/:id` | Book, reschedule, cancel with the same conflict rules as the dashboard |
| Inbox → ClinicMind | `POST /api/integrations/escalations` | Clinical/complaint escalation into a ClinicMind task with the conversation link |
| ClinicMind → Inbox | `POST <inbox>/webhooks/clinicmind` (HMAC) | `appointment.confirmed/reminder/cancelled`, `intake.link`, `protocol.step.due` (Module 5 messages go out through the inbox's WhatsApp adapter, templates included) |
| Both | Per-tenant API keys, scoped; every call carries the tenant id; rate-limited; full audit on both sides | |

**Open questions for the inbox tool** (these decide the design): Which channels does it already connect, and through which provider (Meta Cloud API direct or a BSP)? Does it store conversation bodies and media, or should ClinicMind be the system of record for clinical content? Does it have an AI drafting layer, or should ClinicMind's orchestrator return the draft (recommended: ClinicMind returns a `draft + confidence + risk` object, the inbox decides send/hold by mode)? Does it support WhatsApp template management and the 24-hour window? Does it expose webhooks and an API with idempotency? Multi-tenant or single-tenant per deployment?

**What this buys:** Module 1 effort drops from 10 person-weeks to roughly 5 to 6 (qualification logic, booking tools, lead model, follow-up sequences, evaluation set) and Module 5 reuses the same outbound path.

**Decision (22 Oct 2026): integrate Omni Grow from where it is; do not merge it into this codebase.** It keeps running on its own for other clients, clinical data stays inside ClinicMind's boundary, and each product keeps one codebase. The connection is configured per tenant on both sides (endpoint, API key, webhook secret); if a clinic wants the inbox inside the ClinicMind screen it is framed with the embed-token pattern, not moved. Details in [`PLATFORM.md`](PLATFORM.md#omni-grow-the-all-in-one-inbox-integrate-do-not-merge).

---

## 6. Module-by-module plan

### Module 1 — AI front desk (with the inbox tool)
- **Have:** patients, scheduling with conflicts/waitlist, timezone-correct slots, roles, audit.
- **Build:** `Lead` model + scoring; knowledge base entity (treatment pages, price table, never-say list) with embeddings; front-desk orchestrator (intent → qualification state machine → booking tools → draft reply) returning structured outputs; follow-up sequence scheduler (worker); shadow/assist/auto per channel; the evaluation set (200 conversations) and the red-line adversarial set as CI gates; phone via the voice platform's tool-calling against the same endpoints.
- **Risk:** Meta template approvals and number migration are calendar risks, not code; start them in week 1.

### Module 2 — Consultation preparation
- **Have:** appointment flow to attach an intake to; patient record to pre-fill.
- **Build:** intake templates (6, incl. the hair-transplant structure) as versioned JSON schemas; patient-facing mobile web form with resumable progress and photo steps (reuses Module 4 capture); brief generation as a structured output rendered by the console (no free text); deterministic attention rules + AI inconsistency detection with quoted evidence; brief versions/diffs; read-mark; walk-in short form.

### Module 3 — Documentation copilot
- **Have:** transcript → extraction → editable review → sign, medication reconciliation, audit of clinician edits versus the AI draft. This is the spec's "doctor edits and signs" core.
- **Build:** audio capture (browser `MediaRecorder` on the doctor console) with consent logging, upload to object storage, transcription via the vendor chosen in the bake-off (ElevenLabs Scribe or Deepgram; keyterm glossary), speaker separation; document generators per encounter type (note with evidence spans, treatment plan from the price table, instructions from the library, consent draft with checklist, referral, procedure record); audio retention job; document delivery through the inbox.

### Module 4 — Photography
- **Build from scratch:** `Photo` model and storage, guided capture page (overlay, lighting/blur checks), automatic stage assignment from procedure date, at-home photo classification/quality scoring (vision model), timeline and side-by-side comparison, missing-set flags → tasks, consent per use, watermarked exports with audit. The spec's "flags, not judgements" rule is the design constraint.

### Module 5 — Post-treatment concierge
- **Have:** patients, procedures to attach to (after Module 3's procedure record), the outbound path through the inbox.
- **Build:** protocol engine (versioned templates, enrolments, steps with offsets, quiet hours, language), structured questions as WhatsApp buttons/lists, keyword → AI triage with structured risk output, escalation ladder with timers and roster paging, concierge board, protocol editor with doctor approval, weekly report.

### Module 6 — Management layer
- **Have:** overview metrics, `AiRun` logging.
- **Build:** reporting schema + nightly SQL models with tests, the metric definitions table, dashboards (Today, Funnel, Doctors, Marketing, Patients, AI operations), ads spend import (Meta/Google), revenue capture, weekly AI brief with metric citations, anomaly alerts via the inbox, NL-to-SQL over the reporting schema (read-only role).

---

## 7. Compliance and clinical safety (what to add to ClinicMind)

| Spec requirement | ClinicMind | To add |
|---|---|---|
| Explicit consent with text version + timestamp (processing, photos, marketing) | none | `Consent` model, capture at first contact/intake, withdrawal same day |
| Row-level security on patient data | policies exist | activate with a non-owner app role + `SET LOCAL` per transaction (planned) |
| 2-factor for every staff account | schema fields reserved | TOTP enrolment + enforcement |
| Audit on reads of photos/documents | writes only | access-log on media reads |
| Breach playbook, DPO, PDPL licence, cross-border transfer terms | docs mention | legal workstream; pseudonymise patient identifiers before LLM calls that do not need them |
| Retention (audio 30 d, conversations 24 m, lost leads 12 m) | none | retention jobs in the worker, configurable per tenant |
| Red-line rules, kill switch, shadow mode, eval gates | assistant prompt only | orchestrator features in section 4 |
| Zero-retention LLM option, model refusals routed to humans | n/a | provider configuration + orchestrator |

---

## 8. Where I disagree with, or would adjust, the spec

1. **Build order.** The spec builds the foundation in weeks 1–3 and starts Module 1 in week 2. With ClinicMind as the core, the foundation becomes "workspace split + worker + gateway contract" (about 2 weeks), and Module 1 can start in week 1 against real scheduling and patient APIs.
2. **Scheduling decision.** The spec leaves "build in-platform vs integrate an EMR" open until week 1. ClinicMind already has scheduling with conflict rules; recommend "build in" is settled.
3. **Documentation copilot evidence model.** The spec requires every note sentence to reference a transcript span. ClinicMind's extraction today references the transcript as a whole. Plan the evidence-span schema before building Module 3's generators; retrofitting is expensive.
4. **Model strategy.** The spec fixes Claude Opus 5.5 everywhere. Keep that as the primary for clinical documents and triage (quality and structured outputs), but keep the adapter layer: Gemini embeddings for retrieval, a cheap router for intent/language, and the offline provider for tests. The cost model should reflect the mix.
5. **Phone channel.** Bridging the clinic's line into a voice platform is the least certain line item (Egypt numbers, SIP/FXO). Treat it as a spike in week 1 with an explicit "defer to phase 2" exit, as the spec's risk register already suggests.
6. **16 weeks with 4–5 people** is achievable only if the clinic content arrives on the spec's deadlines; the slimmer 20-week plan is the realistic default for a 3-person squad.
7. **Arabic.** The spec puts Arabic on the patient side (WhatsApp, intake) where it belongs; the staff UI can stay English-first with RTL readiness added when the clinic asks for it. Patient-facing surfaces must be bilingual from day one.

---

## 9. Phased roadmap from ClinicMind to the spec

| Phase | Weeks | Scope | Depends on |
|---|---|---|---|
| 0 · Demo (this sprint) | now | Secure, buildable ClinicMind with patients, appointments, consultations, grounded assistant, demo data | — |
| 1 · Foundation+ | 1–2 | Workspace split (`apps/web`, `apps/worker`, `packages/*`), pg-boss worker, object storage, Sentry, `Lead` and `Consent` models, prompt registry + `AiRun` cost fields, inbox integration contract signed off, RLS activation, TOTP | inbox tool answers (section 5) |
| 2 · Module 1 | 2–6 | Knowledge base + price table, front-desk orchestrator (shadow → assist), booking tools, follow-up sequences, evaluation sets as CI gates, phone spike | Phase 1; clinic content |
| 3 · Modules 2 + 3 | 5–10 | Intake templates + patient web form + brief; audio capture + transcription bake-off + document generators with evidence spans; consent on tablet | Phase 1; doctor-approved templates |
| 4 · Modules 4 + 5 | 9–14 | Photo capture/storage/timeline/flags; protocol engine + concierge board + escalation roster (outbound via inbox) | Phase 3 (procedure record) |
| 5 · Module 6 + hardening | 12–16 | Reporting schema, dashboards, weekly brief, alerts, NL questions; penetration test, retention jobs, runbooks, training | all |

Effort against the spec's 70 person-weeks: ClinicMind removes most of the foundation (8 → ~3), the scheduling and auth/tenancy work inside Module 1 (10 → ~6 with the inbox tool), and the sign-off core of Module 3 (6 → ~5). Realistic total: **about 55 to 60 person-weeks**, same gates, same acceptance criteria.

---

## 10. Decisions to take before Phase 1 starts

From the spec's list, the ones ClinicMind changes or needs now:

1. **Inbox ownership and contract** (section 5) — the first integration meeting.
2. **Scheduling**: settled as built-in (ClinicMind).
3. **Primary LLM and data residency**: Anthropic API direct with pseudonymisation and consent wording, lawyer to confirm transfer approval by week 2; regional fallback decision.
4. **WhatsApp number**: migrate the existing business number to the Cloud API (inbox tool or ClinicMind holds the Meta app?).
5. **Transcription vendor bake-off** in week 5 (Egyptian-Arabic sample).
6. **Repository and team shape**: one repo with workspaces; who owns the inbox tool's side of the contract.
7. **Budget question, pre-booking photos, prescription draft, default language and tone**: as recommended in the spec (ask budget only for transplant; allow hair/acne photos with one-line consent; prescription draft off at launch; Egyptian colloquial Arabic for patients, formal for documents).

---

## 11. What to show in the proof-of-concept meeting, and what to promise

**Show (works today):** sign-in and roles; patient record with history, medications and timeline; booking with conflict detection and the full appointment lifecycle; a consultation from transcript to editable extraction to signed record with medication reconciliation; the assistant answering from the clinic's own records with citations; settings, team invitations, embed; security posture (audit, rate limits, migrations, backups).

**Promise with dates (from the roadmap):** WhatsApp front desk through the inbox tool (Phase 2), intake briefs and ambient documentation (Phase 3), photos and concierge (Phase 4), management dashboards (Phase 5).

**Do not claim:** live WhatsApp or voice, audio recording, photo tracking, protocols, or compliance sign-off. The static GitHub Pages demo still shows some of these; retire it before the meeting or label it "concept".
