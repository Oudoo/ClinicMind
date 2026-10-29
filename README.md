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
| **Appointments** | Week and day views on the clinic's clock, booking with per-doctor and per-room conflict detection, reschedule (the patient is asked on WhatsApp to confirm the new time; a reply of 1 confirms it), cancel with reason, and the full lifecycle: scheduled → confirmed → checked in → in progress → completed, or no-show. |
| **Consultation intelligence** | Transcript → structured extraction (symptoms, diagnoses, tests, follow-ups, medications) → editable review → **sign**. Nothing reaches the patient record until a clinician signs; signing reconciles medications, creates the visit and writes the timeline. |
| **Finance** | A price list with codes, units (per visit, session, area, graft, syringe…) and course packages; prices change from a set day on, a branch can have its own, and what was already charged keeps its price. Procedures are priced from the list (item × quantity, the day's price) and charged when done: at once when signed, or session by session for a course; a charge of nothing needs its reason, and charges are never edited (a correction is a reversing charge). A daily list shows work done but not billed. Invoices bill a patient's charges per branch, numbered when issued with no gaps; they are paid in part or in full as payments are put towards them (oldest first; a deposit waits for the invoice of its procedure), never deleted, and cancelled only with a reason and a numbered credit note; printed or sent on WhatsApp in Arabic or English, the patient's copy behind a link. Every payment has its receipt number; refunds are the owner's, with the reason. Each patient has an account: every charge, payment and refund with the running balance, a statement for any dates (printed, in Arabic or English), and the balance on the patient's header, their appointment and at check-in. A family's head can pay for its members: their payments go on to the members' invoices after the members' own, and the family statement shows the family's money once. Every discount has a reason from a fixed list and stays within the role's limit (reception and nurses 10%, doctors 20% unless the owner sets otherwise in Settings; more needs the owner), on a procedure or on a line of a draft invoice; the owner writes off what is left on an invoice, with a reason. Money taken at the desk goes into the cashier's shift, opened with the cash in the drawer and counted method by method at the close (any difference with its reason); money entered late for an earlier day is shown apart; once every shift of the day is closed the owner signs the branch's day off, and from then on nothing is recorded on it or voided from it (the database refuses it too). The owner's finance reports, Dentalore's set, each with its CSV: the day close (one day's drawer against the books, its figures beside Dentalore's while both run, and every receipt traced to the invoices and procedures it paid, a visit's fee, or the patient's credit), daily income (by kind and method, with the drawer's sign-off), daily production (gross, discounts, cancelled work, consultation fees, net: counted from the charges), branch production, daily adjustments (discounts, write-offs, cancellations, refunds, voided payments and credit notes, with who and why), balances by age with the period's invoices, procedures tracking, and each doctor's production, collections and write-offs. The finance dashboard shows the same production and what patients owe from their accounts. |
| **Treatment plans and quotes** | After the consultation, a doctor or the desk writes the plan in phases ("Months 1–3: clear the acne", "From month 4: the scars"), each with treatments from the price list: how many of the unit (grafts, areas, sessions), where ("crown", "both cheeks"), the sessions it is done in, and a discount within the role's limit with its reason; priced for the branch today, with the last day it holds (30 days unless changed), in Arabic or English. Given to the patient (printed, or sent on WhatsApp behind a link), it takes the branch's next quote number and its items and prices never change (the database refuses it). The patient accepts all of it or some treatments by typing their name and signing, on the clinic's screen or on their own phone, or declines it saying why; the doctor and the desk are told when the answer comes from the link. Each accepted treatment becomes a planned procedure at its quoted price and discount, for the plan's doctor, with no day yet (work done at once is then dated the day it is signed), and joins the recall list when nothing is booked for it three days later. A quote past its last day is expired until it is given more days; one is withdrawn with a reason, or revised into a new draft that replaces it once given. Treatment plans shows case acceptance by value and by plan for the last 30, 90 days or 12 months, what waits for an answer and what expires this week, and acceptance by treatment and (the owner) by doctor; each patient's page lists their plans. |
| **Instalment plans** | Treatment paid over time (a hair transplant, a laser course), from the patient's page or from an accepted treatment plan (Pay in instalments, once at a time): what it pays for, the total, a down payment, how many instalments every 1, 2, 3 or 6 months from a first day, and how many days before each the reminder goes; the schedule is in whole pounds with the odd pounds on the last, shown before it is made, and never changes (the database refuses it, and a plan is never deleted, only stopped with a reason). A payment recorded towards a plan (by the patient, or the head of their family for a member) covers its instalments in order, the down payment first; the plan is paid in full when they are all covered, and owed again if a payment is voided. Plans do not change what is invoiced: the money goes to invoices as any payment does. The patient gets a WhatsApp reminder in their language before each instalment and a message the day after one is missed, once each, never in the quiet hours and never after saying no; the desk and the owner are told what became overdue. Instalments shows what is overdue (the latest first), what falls due this week, what the active plans still have to collect and what was paid towards them this month, with a payment and a reminder now on each row; each patient's page shows their plans with the schedule. |
| **Doctor pay** | The owner sets each doctor's pay (and a nurse's, or their own): a rule for everything they do and, where it differs, one per category of the price list or for consultation fees, as a share of what is billed or of what is collected for their work (the lab's bills and the materials taken off first, if chosen) or a fixed fee per session; a share is never below zero. Materials come from the price list (per unit: a syringe, a session, a graft) and from costs the desk enters on a procedure (a lab's bill, extra materials; the owner voids one entered by mistake, with the reason). A month's statement lists each piece of work with what it billed and collected (in the month and to date), its costs and rule, what it had earned by the month's end, what earlier statements paid for it and what this one pays: money collected later for older work, a later cost, a cancellation or a refund all count in their own month, and anything owed back is taken off the next statement. Doctor pay shows every doctor's month; the owner closes a month once it is over (it never changes again: the database refuses it) and marks it paid with the method and reference; each doctor sees their own statements under My pay. |
| **Expenses and suppliers** | What the clinic spends, under a fixed list of categories (rent, salaries, electricity and the internet, medical supplies, lab fees, maintenance, marketing, fees, cleaning and more), for a branch and from a supplier or not: money spent at once (paid in full) or a bill to pay by a day, paid in one payment or several, never past its amount (the database refuses it too). Cash the desk pays out today comes out of the cashier's open shift: the drawer expects that much less at the close, and the day's close counts it. A photo or a PDF of the bill or the receipt goes with it (typed by its bytes, 5 MB each). Recurring expenses (the rent, the internet, a service contract) make their bill on their day every month or every few months, once a month, at the amount they have then; the owner sets them up, changes them for the bills to come and stops them with a reason. Nothing is deleted: the owner voids an expense or a payment entered by mistake, with the reason (an expense's payments with it). Expenses shows what is to pay and what is late, each month's spending by category, the recurring and the voided ones; Suppliers shows what is owed to each and their bills. Salaries are the owner's alone: no one else records them or sees them, in the lists or the totals. |
| **Lab work** | What the clinic sends to labs for a patient (a biopsy for histopathology, blood tests, a culture): from the procedure it came from, where on the body it was taken (the tooth waits on the dental decision), the lab's number, the day it went and the day it is due back (the lab's usual days, or the one given). An order still at the lab past its day is late: the doctor who asked and the desk are told once (job `lab-orders-late`, every hour), and the desk can call the lab from the list. The result comes back as the lab's report has it, with its photos or PDF; the doctor who asked is told, and told to act when it is flagged. A result is clinical: the doctors and the nurses record and read it, the desk sees only where an order stands. The lab's bill for an order is an expense under Lab fees from that lab, and a cost on its procedure, off the doctor's share; voiding one voids the other, and a voided bill can be entered again. An order is never deleted: it is cancelled with a reason. Lab work lists what is late, at the lab, back, not billed and cancelled; each patient's page lists theirs. Labs are suppliers marked a lab, with their usual days. |
| **Insurance and companies** | Insurers and companies that pay for their members' or staff's care, each with its contract: from a day on (a new contract ends the one before), the discount it gets on the price list, the patient's co-pay, a yearly limit per member (counted from the contract's day each year) and the amount above which the payer approves the work first; what it does not cover by category of the price list, with exceptions by item. The desk adds a patient's card (the payer, the member number, the plan, the employer and whether the patient is the member or family) from a day, and ends it with a reason. Approvals are asked of the payer from the patient's page and its answer recorded (approved with its number, amount and last day, or refused with the reason); work above the contract's amount is claimed only with one. A draft invoice of a covered patient shows the split line by line: the contract's price (the discount is a charge of its own, reversed if the work is no longer claimed), what the patient pays and what the payer is asked for, and why a line is not claimed (not covered, needs an approval, the approval or the yearly limit used up). Issuing the invoice makes the claim, numbered by branch (`ZAM-CL-000001`); the patient owes only their share, and cancelling the invoice cancels its claim, never one the payer already paid. Claims go to each payer in a batch (`ZAM-CB-000001`, with a CSV for the payer); the owner records what the payer paid line by line and what it refused with the reason; a refusal goes back to the patient's account unless the owner writes it off. A payer's payment is never deleted: voiding it puts back what it paid and wrote off. Insurance shows what each payer owes by age (up to 30 days, 31–60, 61–90, over 90) and, of it, what is not sent yet and what is past its days to pay, the claims to send, the batches, the approvals waiting and the payers with their members; the income reports count what payers paid on the day it came, at the branch of the claim. |
| **Recalls** | Every patient due back, made without anyone typing them: a signed procedure brings its treatment's reviews (hair transplant at months 1, 3, 6 and 12; acne at 6–8 weeks, also on an acne diagnosis), a course brings its next session after each one (laser every 4–6 weeks, PRP monthly ×3, a package's own number of sessions), a follow-up the doctor stated ("review in 6 weeks") its own review, and the sweep recalls planned treatment not booked after 3 days, a visit missed or cancelled and not rebooked within 48 hours, and patients not seen for 12 or 18 months. Never twice: one recall per source, one rule's review at a time (a treatment done again moves it), a stated follow-up within two weeks of a rule's recall is that recall. Each recall follows the patient's bookings: booked when a visit from two weeks before its due day is booked, reopened when that visit is cancelled or missed, done when the visit (or the session, or the planned work) is done, declined when the treatment is cancelled. Reception's list is who to contact today, overdue first, then due, then what is worth more; one tap sends the WhatsApp template in the patient's language, a call is logged with its outcome (no answer, call back on a day, thinking, will book, wrong number, declined with the reason), a visit is booked straight into a free slot, and a recall is snoozed, ended as unreachable or noted; every step is on the recall's log. Every recall ends: one still waiting 60 days after its window, with nothing done on it for 30, is ended as unreachable by the system. A patient's record lists their recalls with the same actions, their log, the last ones ended and Add for a review no rule makes; the next-appointment card says what the visit is booked for and what else is due by then. Results shows the recalls due in a period against the one before (contacted, booked, booked within 30 days, by kind), accepted treatment not booked and what it is worth, lapsed patients won back, revenue from recalls (the owner), how recalls ended and each person's calls, messages, bookings and endings. The owner edits the rules (interval or review days, the window still on time, sessions, who works it, phone or WhatsApp). |
| **Reminders and consents** | WhatsApp reminders in the patient's language 48 hours and 2 hours before every visit. An unconfirmed booking is asked to confirm: 1 confirms it, 2 asks for another time and puts it on reception's call list until it is moved. From noon the day before the next open day (Saturday's on a Thursday, with Fridays closed), its visits still unconfirmed are listed for a call. A recall waiting for a booking gets its own messages 14 days before the due day, on it and 7 days after: only the latest when one was missed, and never while the desk has its own plan (a contact in the last three days, or the day the patient asked to be called). Nothing goes in the clinic's quiet hours (21:00–10:00 by default), for a booking made minutes ago, or to a patient who said no. Each patient has two consents: treatment reminders (yes unless they say no) and offers and news (no unless they say yes; asking back a patient not seen for a year needs it). STOP on WhatsApp turns both off and START turns reminders back on; every change is dated and audited. A recall no message will reach (a phone-call recall, no number, no consent, messages switched off) is on reception's list as soon as it is due soon. The owner sets the quiet hours, the call-list time and what goes out in Settings. |
| **Evidence panel** | Beside the consultation review, a doctor asks a clinical question in Arabic or English and the answer comes only from the clinic's own library: guidelines, drug information and the clinic's protocols, pasted in as text with who wrote them and when, which doctors add and the owner (with the clinician mark) approves before the panel may quote them. Every statement is marked with the passage it comes from, the passage shown word for word under its heading; when no approved passage answers, the panel says "no good source" plainly. The patient's age, sex, pregnancy (recorded on the record as pregnant or excluded, with the day it was checked), allergies, medications and conditions go with the question, shown before asking; never their name, phone, ID or date of birth, and a name or number typed in the question is taken out. A drug named any way the clinic's vocabulary knows (a brand, the Arabic name) finds its generic name. Without an AI provider the answer quotes the passages' own sentences; with one, the model writes from the numbered passages alone and a sentence without a passage's marker is dropped. An approved source that is edited waits for approval again; a retired one answers nothing more. Every question is logged with what was sent and what was cited. A pregnancy excluded in the last 30 days (or recorded in the last 300) also feeds the prescribing checks: isotretinoin then warns about contraception instead of stopping; and a weight recorded in the last 180 days checks isotretinoin per kilogram (a warning above the usual 0.5 to 1 mg/kg a day). "Ask OpenEvidence" opens OpenEvidence in a new tab with the question copied without the patient's name or numbers, a reminder never to paste them, and the hand-off logged. Clinicians only: doctors, and the owner with the clinician mark. |
| **AI log and review** | Every question asked of the evidence panel or the assistant is kept with its answer and the words it cited, as is every rating and every prescribing-safety override: the database refuses an edit or a deletion. The doctor who asked rates each answer (useful or not, and what was wrong). The owner's monthly review (Evidence library → Monthly review) shows the month's questions against the month before, how many were answered from sources or records, the ratings by doctor, the answers rated not useful with the doctor's words, the questions nothing answered (sources the library may need), the sources cited most, the questions taken to OpenEvidence and the overrides by rule; on the first of each month the clinician owners are told it is ready. |
| **Patient data protection for AI** | Nothing that reaches an AI provider carries a patient's name, phone or WhatsApp number, national ID, e-mail or date of birth: the records indexed for the assistant are embedded without them, the assistant's context names patients as Patient A, Patient B (the answer comes back with the real names), and the consultation transcript, the dictated history and the evidence question go with "the patient" in place of the name. Staff names, dates and doses stay. The intake form's consent tells patients that AI assists the doctor, what is removed first, and that a consultation is recorded only with their agreement (the audio goes to the speech-to-text service as it is, and is not kept). |
| **AI assistant** | Retrieval-augmented chat over the clinic's records (pgvector + lexical match), optionally focused on one patient. Every answer states whether it is grounded and cites the records it came from; when nothing matches it says so. Clinicians only (checked on every request): nurses, reception, the AI lead and the platform admin ask no clinical questions. |
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

**One command for a demo laptop:** `scripts/demo-local.sh` creates `.env` with
fresh secrets, starts PostgreSQL in Docker when nothing answers at
`DATABASE_URL`, applies the migrations, seeds the demo clinic once (password
`Demo-Clinic-2026!`), builds and serves the application on
http://localhost:3000 and the click-through prototype on http://localhost:8787,
and prints the accounts. `--reseed` centres the schedule on today, `--rebuild`
rebuilds after new code, `--dev` runs the development server. Put
`GEMINI_API_KEY` in `.env` for live AI. The step-by-step runbook for a client
demo is the *ClinicMind Client Demo Runbook* document.

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
| `ai@demo.clinic` | Nadia Youssef | The Clinic AI module only: the spec's six modules and the AI rules |
| `doctor@demo.clinic` | Dr. Omar Fahmy | Doctor |
| `mariam@demo.clinic` | Dr. Mariam Tarek | Doctor |
| `nurse@demo.clinic` | Heba Mostafa | Nurse |
| `reception@demo.clinic` | Youssef Hany | Receptionist |
| `platform@demo.clinic` | Platform Admin | Platform administrator (system owner, `/platform`) |

All seven share one password: `SEED_DEMO_PASSWORD` if set, otherwise a random one
printed by the seed. In the application the Clinic AI lead lands on the
**Clinic AI** page (the module map and the link to the walk-through); the
module's own screens live in the prototype until their phase ships. Re-running the seed rebuilds the demo clinic. There is no
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

### Dictation and transcription

Doctors can dictate instead of typing. The **Dictate** control in the
consultation capture form and in the patient's *Edit history* dialog records in
the browser (MediaRecorder), sends the audio to the clinic's speech-to-text
provider and returns the transcript; the audio is not stored. Two modes:
*dictation* (the doctor alone) and *ambient* (doctor and patient, turns
labelled, consent confirmed and logged). The transcript then goes through the
same extract → review → sign path as a typed one, or, in the history editor,
becomes suggested entries the clinician reviews before saving. Every other
free-text field (appointment reason and notes, cancellation reason, visit
summary, patient address and notes, the assistant's question box) carries a
small microphone inside the field: one tap records, the next stops, and the
transcript lands at the caret with the existing text kept
(`DictationField`, built on the same `useDictation` hook).

| Variable | Default | Purpose |
|---|---|---|
| `AI_TRANSCRIPTION_PROVIDER` | `auto` | `auto` picks the first provider with a key that can transcribe (Gemini, then OpenAI). There is no silent fallback: without one, the API answers 503 and the control says so. `echo` is for tests only. |
| `GEMINI_TRANSCRIPTION_MODEL` | `gemini-2.5-flash` | Audio goes inline to `generateContent` with verbatim-transcription instructions (Egyptian Arabic and English mixes stay as spoken). |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-4o-transcribe` | Used through the audio transcriptions endpoint with a clinical vocabulary prompt. |

Claude (Anthropic) takes no audio input, so speech-to-text always runs on Gemini
or OpenAI even when Claude answers the chat.

### Providers per client

Every AI capability is provider-agnostic: Gemini, OpenAI (ChatGPT) and
Anthropic (Claude) adapters exist for chat, extraction and the assistant, and
Gemini and OpenAI for transcription. The platform console sets them **per
tenant** (tenant page → *AI providers*): which provider answers chat and which
one transcribes, optional model overrides, and the client's own API keys. Keys
are encrypted at rest (AES-256-GCM under `DATA_ENCRYPTION_KEY`, or a key derived
from `AUTH_SECRET`), never returned by any endpoint, and used only for that
tenant's calls; anything left on *inherit* uses the environment's
configuration. Embeddings stay global because the vector store has one
dimension and one model.

## Roles

| Role | Can |
|---|---|
| `SUPER_ADMIN` | Everything, including provisioning and listing tenants (`platform:manage`). Never mintable through an embed token. |
| `CLINIC_OWNER` | The physician-owner: tenant settings, team, embed configuration, the price list, the recall rules, doctor pay (rules, closing and paying statements, voiding a procedure cost), expenses (with salaries, recurring expenses, voiding an expense or its payment), refunds, voids and write-offs, insurers and companies (their contracts, recording and voiding what they paid of their claims), closing anyone's cash shift and signing the day off, approving and retiring the evidence library's sources and the monthly AI review (with the clinician mark), plus the full clinical rights of a doctor (bookable, may sign, asks the evidence panel and the assistant). An owner without the clinician mark (the Clinic AI lead) asks no clinical questions. |
| `DOCTOR` | Patients, appointments, consultations (capture, review, **sign**), AI assistant, the evidence panel and adding sources to its library, reports and analytics, working recalls, treatment plans and quotes, lab work (with the results), their own pay statements. |
| `NURSE` | Patients, appointments, consultation capture, payments in their own cash shift, instalment plans, procedure costs, expenses and suppliers (but salaries), lab work (with the results), patients' insurance cards, approvals, claims and sending them to the payers, working recalls, treatment plans and quotes, their own pay statements; bookable; cannot sign. |
| `RECEPTIONIST` | Patients, appointments, conversations, payments in their own cash shift, instalment plans and their reminders, procedure costs (lab bills, materials), expenses and suppliers (but salaries; cash for an expense out of their own shift), lab work and the labs' bills (not the results), patients' insurance cards, approvals, claims and sending them to the payers, the recall list, treatment plans and quotes; no AI assistant. |
| `ASSISTANT` | Read-only patients, appointments, conversations and recalls. |

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
- **Tenant isolation:** every query is scoped to the acting tenant, every client-supplied foreign key is proven to belong to it (a foreign id is indistinguishable from a missing one), and Postgres row-level security enforces it underneath: the app connects as its own role, each clinic's connections carry the clinic, and a query run without one returns nothing (`src/lib/db.ts`, docs/ARCHITECTURE.md §7).
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
the migrations applied; they create and delete their own tenants. Point it at
the app's role and `TEST_SYSTEM_DATABASE_URL` at the owner to run them with
row-level security enforced, as CI does. The
end-to-end suite signs in to the demo clinic (`E2E_BASE_URL`, `E2E_EMAIL`,
`E2E_PASSWORD`; defaults to `http://localhost:3000` and the owner account) and
covers the security surface, sign-in, every section, the assistant, sign-out
and the phone layout. CI runs `npm audit` (production dependencies, high or
worse fails), migrations, typecheck, lint, tests, the production build and the
end-to-end suite.

---

## Click-through prototype (Phase 1 testing)

`demo/` is a self-contained, browser-only build of the product for software
testers and sales demos: no server, no database, no AI key. It is published by
`.github/workflows/pages.yml` on every push to `main` that touches `demo/`:

**https://oudoo.github.io/ClinicMind/**

Every button, form and menu responds; the seeded clinic (Aura Derma & Hair
Clinic, Cairo), the platform console and the tenant white-label flow are all
there. The prototype also carries the **Clinic AI Implementation Spec as a
module**: sign in as `ai@demo.clinic` (the Clinic AI lead) and the workspace is
the spec itself, one entry per module (AI front desk, consultation preparation,
documentation copilot, photography, concierge, the CEO dashboard, AI rules),
with seeded leads, intakes, briefs, documents, photo timelines, protocols,
prompts and evaluation gates. The CEO dashboard (Module 6) computes the spec's
thirteen metric definitions from a 26-week reporting schema seeded in
`demo/assets/data-reporting.js`: six screens, period and comparison selectors,
the weekly brief, anomaly alerts, natural-language questions and the
success-metrics targets table. The owner reaches the same module from
the navigation; the platform console switches it on or off per tenant. Data lives in the browser's `localStorage` (account menu → *Reset demo
data* rebuilds it). Sign in with any seeded account and the password
`Demo-Clinic-2026!`; `platform@demo.clinic` opens the platform console.

Transcript extraction in the prototype is heuristic (it recognises common
dermatology drugs and conditions); the application runs an LLM with a strict
schema. To rebuild the stylesheet after editing `demo/src/input.css` or the
scripts:

```bash
npx tailwindcss -c demo/tailwind.config.cjs -i demo/src/input.css -o demo/assets/styles.css --minify
```

## Deployment

`docker-compose.prod.yml` runs Caddy (automatic HTTPS, with on-demand
certificates for tenant subdomains and verified custom domains), PostgreSQL with
pgvector, a one-shot migration service, the standalone web server, an optional
demo seed and a nightly `pg_dump` with retention. The *Release image* workflow
publishes the images to GitHub Container Registry once CI is green; the
*Deploy* workflow updates a server over SSH; `scripts/server-setup.sh` prepares
a fresh Ubuntu server in one command; the *Provision Hostinger* workflow sets
up a Hostinger KVM VPS and its DNS records in one run. Configuration, the cm.growcdx.com
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
scripts/              reindex.ts · backup.sh · restore-drill.sh · restore.sh
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
