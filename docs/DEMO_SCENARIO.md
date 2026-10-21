# ClinicMind — Demo Scenario (Management / Client Pitch)

**Goal:** in ~7 minutes, show that ClinicMind is an *AI-first clinic operating
system* — not a CRM with a chatbot bolted on — and that it is multi-tenant,
secure, and production-ready.

**Where:** the static demo (GitHub Pages). Seeded with a realistic clinic
("Aura Demo Clinic", 1,284 patients). No login, no setup, works offline.

**Tip:** use the moon icon (top-right) to switch light/dark live — it reinforces
the white-label/brand story.

---

## The 7-minute script

### 1. Overview — "the clinic at a glance" (60s)
Open on **Overview**.
- Point to the bento metrics: total patients, today's appointments, no-show rate.
- "Every tile is a live, indexed query — the dashboard target is under 2 seconds."
- Show the appointment-volume chart and diagnoses distribution.
> **Line:** "This is the operating picture a clinic owner sees the moment they log in."

### 2. AI Assistant — the hero moment (120s)
Go to **AI Assistant**. Click the suggestion **"Show me patients who missed follow-ups."**
- It returns named patients with how overdue they are — **with citations**.
- "Notice the citations and the confidence score. ClinicMind never answers a
  clinical question without retrieving from the clinic's own records — no
  hallucinations, no ungrounded guesses."
- Then ask **"Compare Ahmed and Mohamed's hypertension progress."**
> **Line:** "The doctor runs the clinic in natural language. This is the difference
> between *AI-attached* and *AI-first*."

### 3. Consultation Intelligence — review-before-sign (120s)
Go to **Consultation**.
- "A real consultation transcript is streaming in." Click **Extract clinical data**.
- The AI pulls **symptoms, diagnoses, medications, tests, follow-ups** into
  structured fields, plus a visit summary.
- "Crucially — nothing is saved yet." Click **Review complete — sign**.
> **Line:** "AI drafts; the clinician decides. Clinical decisions are never
> auto-saved — that's the safety and liability line, enforced in the product."

### 4. Patients & Conversations — the full OS (60s)
- **Patients:** the CRM with risk flags and clinical context.
- **Conversations:** "The AI receptionist already handled these on WhatsApp and
  voice — in Arabic, Egyptian Arabic and English — booking and rescheduling
  automatically." Point to the rescheduled asthma review.

### 5. Production Report — the "is it real?" tab (90s)
Go to **Production Report**.
- Expand **Multi-tenancy**: "Every client gets an isolated, white-labeled instance —
  their own domain, their own branding, their own data, enforced down to the database."
- Expand **Security**: RBAC, append-only audit, Row-Level Security, signed embed tokens.
- Expand **Cost & payments**: "We can run this at zero per-use cost and turn on paid
  AI only when a client pays for it."
- Expand **SaaS readiness**: "Charging monthly/annual subscriptions is a billing
  layer on top of the multi-tenant core we already have."
> **Line:** "This isn't a mockup. The demo is the sales asset; behind it is a
> production architecture documented right here."

---

## Questions you'll likely get — and the answers

- **"Is patient data safe / separated between clinics?"** Yes — every record is
  tenant-scoped in queries *and* enforced by Postgres Row-Level Security; audit is
  append-only.
- **"Does the AI make things up?"** No — the assistant is retrieval-grounded with
  citations and refuses to answer without context.
- **"What does it cost to run?"** Free software; you control AI cost via the
  provider switch (free Gemini tier or offline mode). See `docs/COSTS_AND_PAYMENTS.md`.
- **"Can we sell it as a subscription?"** Yes — see `docs/SAAS_MODEL.md`.
- **"Can a clinic put it on their own website?"** Yes — a one-line embed snippet;
  see `docs/INTEGRATION.md`.

---

## Definition of "demo passed"

✅ Assistant returns grounded, cited answers
✅ Consultation extraction → review → sign flow lands
✅ Multi-tenant + security story is credible (Report tab)
✅ Cost and SaaS questions answered

If these land, the next step is the **production deployment to Hostinger** (the
demo stays live permanently as the client-pitch build).
