# ClinicMind — Live Demo Script (spec first)

**Framing for the meeting:** the *Clinic AI Implementation Spec* is the
destination. ClinicMind is the foundation that already runs: the one patient
record, scheduling, the review-and-sign clinical workflow, the grounded
assistant, tenancy and security. The demo walks the spec **module by module**,
shows what runs today for each, and names what comes next and when. The
platform console and the rest of the product come at the end.

**Where:** the real application, seeded with the demo clinic
(**Aura Derma & Hair Clinic**, Cairo).

**Phase 1 (software testing before hosting):** the same script runs against the
click-through prototype at <https://oudoo.github.io/ClinicMind/> — a
browser-only build with the same seeded clinic, the same accounts and the same
screens, where every action responds but nothing leaves the browser. Use it to
validate flows and copy before the full stack is deployed; then run Phase 2
(front end and back end) on the hosted application.

**The spec as a module (prototype):** sign in as `ai@demo.clinic` (Clinic AI
lead). The navigation is the spec, module by module; every screen responds with
seeded data: the cross-channel front desk with drafts and real slots, intake
links and doctor briefs, ambient recording and signed documents with evidence
spans, photo timelines, concierge protocols with an escalation ladder, the
management dashboards with a weekly brief, and the AI rules (modes, red lines,
prompt registry, evaluation gates, kill switch). Demo this first when the
audience wants to see the spec rather than the foundation.

---

## Before the meeting (15 minutes, once)

1. **Use a live AI provider.** Set `GEMINI_API_KEY` (free tier) or another key
   in `.env`. Without a key the assistant runs in offline `echo` mode: it still
   retrieves and cites, but quotes the records instead of reasoning, and the
   transcript extraction returns an empty draft instead of a structured one.
2. **Rebuild the demo clinic the morning of the demo** so the schedule is
   centred on today:
   ```bash
   SEED_DEMO_PASSWORD='<choose 12+ characters>' npm run db:seed
   ```
   It prints the six accounts. Re-running it resets everything you changed.
3. **Two browser profiles:** the owner (`owner@demo.clinic`, Dr. Layla Hassan,
   physician-owner: books, reviews and signs, manages settings) and the platform
   administrator (`platform@demo.clinic`) for the closing section.
4. Open `/api/health` in a tab: database, active AI providers, no development
   secrets.
5. Rehearse the consultation step once with the transcript below.

Suggested timing: about 12 minutes of screen time; the rest is conversation.

---

## Part A — the spec, module by module

### Foundation: one patient record, roles, audit (60 s)
*Spec:* one Postgres record of truth with row-level security, roles, an
append-only event log, prompts and modes governed centrally.

**Show:** sign in as the owner. Try a wrong password first: the message does
not reveal whether the account exists, and repeated failures lock the account.
Open **Patients → Ali Adel**: history, the penicillin allergy in red, medications
written only by signed consultations, and the **Timeline** tab with
appointments, visits, diagnoses and prescriptions in one chronological record.

> "This is the record every module in the spec reads and writes. Nothing here
> was typed by an AI; every clinical line came from a consultation a doctor
> signed, and every change is in an append-only audit log."

*Next:* the `Lead`, `Consent`, `Intake`, `Photo` and `Protocol` entities from
the spec are added to this same record in Phases 1 to 4.

### Module 1 — AI front desk and lead conversion (90 s)
*Spec:* answer every WhatsApp, Instagram, web and phone enquiry within a
minute, qualify, book a real slot, re-engage quiet leads, hand over to staff.

**Show:** **Appointments** (week view, today highlighted). Click **New
appointment**: pick a patient, **Dr. Omar Fahmy**, today, a time already taken
on his column. ClinicMind refuses the overlap and names the clash, with a
waitlist option. Move it to a free slot and book; from the **⋯** menu confirm it.
Then **Reschedule** it to a later time: the booking goes back to unconfirmed
and reads **Awaiting patient**, and the patient's WhatsApp thread holds the
request in their language ("reply 1 to confirm, or 2 for another time"). A
reply of 1 confirms the booking and thanks them without bothering reception;
2 tells reception to find another time. In the demo no WhatsApp number is
connected, so the request is logged on the thread for the desk to send.
Then open **Conversations**: the seeded WhatsApp threads show where channel
traffic lands in the record.

> "The front desk in the spec is an AI that calls tools. The tools it needs
> most, real availability and a booking that cannot double-book, are these.
> The channels and the inbox are Omni Grow, our all-in-one inbox, which stays
> its own product and talks to ClinicMind through a signed contract: patient
> lookup by phone, slots, bookings, escalations, and confirmations back out."

*Next (Phase 2, weeks 2 to 6):* knowledge base and price table, qualification
flow in shadow then assist mode, follow-up sequences, evaluation sets as
release gates; phone as a week-one spike.

### Module 2 — AI consultation preparation (45 s)
*Spec:* an intake link at booking, a one-page doctor brief, flags labelled
"patient reported", zero fabricated facts.

**Show:** on Ali Adel's record, point at what the brief will be built from:
history, medications, allergies, previous visits. Open the **Visits &
consultations** tab: who saw him and when.

> "The brief is a view over this record plus the intake answers. Because the
> record already exists, Module 2 is a form, a schema and a renderer, not a
> new system."

*Next (Phase 3, weeks 5 to 10):* intake templates, the patient mobile form,
brief generation with structured output, consent capture on a tablet.

### Module 3 — Clinical documentation copilot, the hero (3 min)
*Spec:* the doctor speaks or types, the copilot returns structured documents,
nothing is filed until the doctor signs, every sentence traceable.

**Show:** **Consultations → New consultation**. Pick **Ali Adel**, paste the
transcript below, click **Extract clinical data**. Point at the **Dictate**
control under the transcript (language Auto, dictation or ambient with
consent) and at the small microphone inside every free-text field (reason,
notes, summary, address, the assistant's question): one tap records, the next
stops, the words land at the caret. In the prototype the microphone is
simulated; the application sends the audio to the clinic's provider.

```
Doctor: Good morning Ali, how is the scalp since the last injection?
Patient: The patch is smaller, maybe half the size. Some itching after the sun.
Doctor: On examination the single alopecia areata patch on the vertex is about
two centimetres with early regrowth, no new patches, nails normal. We will
repeat intralesional triamcinolone 5 mg/ml today and I want you to use
minoxidil 5% solution, one millilitre twice daily on the patch. Please avoid
direct sun on the scalp. Any new medicines since last time?
Patient: No, only the thyroid tablets.
Doctor: Good. Blood work: TSH and ferritin before the next visit. Review in
six weeks with photos.
```

The draft appears as editable chips and rows: symptoms, diagnosis, tests,
follow-ups, medications. Nothing is in the record yet.
- Edit something live (change a dose, remove a symptom): the badge changes
  from "matches AI draft" to edited.
- Point to **Stop existing medication**: the current prescriptions with tick
  boxes. A continued medicine is updated in place; a ticked one is stopped.
- Click **Review complete — sign**, confirm. Open Ali's **Timeline**: a new
  visit, diagnosis and prescription attributed to the signer. The outcome
  panel says the AI draft and the signed version are both in the audit log.
- Optional: sign in as reception in the second profile and show that the sign
  button is not there.

> "This is the spec's rule in production: the AI drafts, the doctor decides,
> the record carries the doctor's signature. Shadow mode is not a setting here;
> it is the only way the system works."

*Next (Phase 3):* ambient audio capture and transcription (the button is
visible and disabled today), evidence spans per sentence, the full document
set: plan, patient instructions, consent draft, referral letter.

### Module 4 — Photography and treatment tracking (20 s)
*Spec:* standardised capture, automatic stage assignment, side-by-side
comparison, flags for review.

**Show:** the **Documents** tab on a patient record is the placeholder.

> "Not built yet, and we say so. It is Phase 4 and it hangs off the procedure
> record that signing already creates."

### Module 5 — Post-treatment patient concierge (30 s)
*Spec:* a signed procedure enrols the patient in a protocol; check-ins,
photo requests and escalation to a named human.

**Show:** the signed consultation from Module 3 is the trigger the protocol
engine will listen to; the outbound messages go through Omni Grow.

> "Phase 4. The engine is a scheduler over this record; the WhatsApp side is
> the inbox product we already have."

### Module 6 — AI management layer: the CEO dashboard (90 s)
*Spec:* one dashboard with thirteen defined metrics, six screens (Today,
Funnel, Doctors, Marketing, Patients, AI operations), a weekly AI-written brief
with metric citations, anomaly alerts, natural-language questions over the
reporting schema, and the success-metrics table the project is judged on.

**Show (prototype, `ai@demo.clinic` → 6 · CEO dashboard):** the headline
strip (revenue, enquiries, lead→consultation, consultation→procedure, first
response, no-show) with the change against the previous period; switch the
period to 90 days. **Today**: inbox load, first response now, escalations,
follow-ups overdue by owner, the weekly brief (five largest changes, driver,
action, every number cited) and the alerts; acknowledge one. **Funnel**: filter
by treatment, read the drop-off per stage, the lost reasons and objections.
**Doctors**: the per-doctor table and the no-show breakdown by weekday and
deposit; the hidden revenue metric with its notice, then *Re-run the model* to
reconcile it. **Marketing**: cost per procedure per campaign and the campaign
that produces leads but no consultations. **Targets**: the success-metrics
table with baseline, 90-day target and status; edit a baseline. Then
**Ask the data**: "how many transplant consultations came from the Meta
campaign" shows the answer and the read-only SQL.

**Show (application):** **Overview** (today's appointments, upcoming, no-show
rate, volume, diagnoses) and **AI Assistant**: "Which patients have a documented
allergy to lidocaine or penicillin?" answers from the record, not from search
snippets: the banner "Answered from the record: N patients matched (all shown)",
"No patient has lidocaine recorded as an allergy", and every patient with
penicillin on file, each linked to the record. "Is Tarek Ezzat on Cephalexin?"
checks his chart only and cites only him; "Which male patients have PCOS?" lists
no women; "Which patients had knee replacement surgery?" answers "No patient has
knee replacement recorded as a surgery or procedure." Open questions
("Summarise today's appointments") still use retrieval, limited to the patients
who match. `npm run assistant:eval` runs the 37-question evaluation set against
the demo clinic and prints a table.

> "Every number on the dashboard has one definition, owned by one table; a
> metric that fails its reconciliation test is hidden with a notice rather than
> shown wrong. The brief never states a number without its metric and period."

### Compliance and safety, across modules (30 s)
Roles at every API edge, tenant isolation in the application and in the
database, append-only audit, rate limits and security headers, production
refuses to start with development secrets, migrations and nightly backups.
Say it; do not click through it unless asked.

---

## Part B — the platform and the rest of ClinicMind

### The system-owner console: create a client live (2 min)
Switch to the platform administrator profile (`platform@demo.clinic`); it
lands on **Platform**.
- Click **New tenant**: name "Nour Clinics", owner e-mail, product name
  "Nour Care", a teal accent, time zone, optionally a custom domain.
- The dialog shows what you hand over: the sign-in address, the owner's
  invitation link and the embed secret, shown once.
- Open the tenant page: usage, white-label, domain and embedding, owner and
  staff. Click **Suspend** and **Activate** to show access control.
- Open the new tenant's sign-in address in a private window: the page carries
  the tenant's name, product name, accent and logo. Paste the invitation link:
  the owner chooses a password and is inside an empty, branded clinic.

> "Every client is an isolated tenant: own users, data, brand, domain and embed
> credentials. The owner we just invited runs it from here on; we manage all
> clients from one console, and the same console will sit behind the developer
> page on growcdx.com."

### Settings and embedding, as the clinic owner (45 s)
Back in the owner profile: **Settings**: branding (editable), custom domain,
the **Team** list with roles and the invitation form, the embed secret
(stored hashed, rotatable) and the two copy-paste snippets for the clinic's
website.

### Close (30 s)
- Security and operations: real authentication, roles, isolation, audit,
  headers and rate limits, one-command stack with TLS and backups, CI with
  dependency audit and end-to-end tests.
- Roadmap with dates from `docs/SPEC_ANALYSIS.md`: Phase 1 foundation and the
  Omni Grow contract (weeks 1 to 2), Module 1 (2 to 6), Modules 2 and 3 (5 to
  10), Modules 4 and 5 (9 to 14), Module 6 and hardening (12 to 16).

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| Assistant answers carry an "Offline mode" note, or extraction returns an empty draft | No AI key configured or the key failed; check `/api/health` → `ai`. Use a seeded draft awaiting review for the signing step. |
| "Too many requests" or "account locked" on sign-in | Too many wrong passwords in rehearsal. The per-IP limit clears in minutes; the account lockout clears after 15 minutes, or re-run the seed. |
| Schedule looks empty | The seed was run on another day; re-run `npm run db:seed`. |
| Sign button missing on a draft | You are signed in as a nurse or receptionist; use the owner or a doctor. |
| The platform entry is missing from the navigation | You are not signed in as `platform@demo.clinic`. |

## What not to promise yet
- Audio capture and transcription (next release, Phase 3).
- WhatsApp, Instagram and voice channels and the shared inbox (Omni Grow
  contract agreed, not wired).
- Intake forms and briefs, photography, protocols, the management dashboard.
- Arabic interface and right-to-left layout.
