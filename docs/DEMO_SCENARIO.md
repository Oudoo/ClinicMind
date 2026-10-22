# ClinicMind — Live Demo Script

**Goal:** in about eight minutes, show a working clinic operating system whose
AI never answers outside the clinic's own records, and whose clinical writes
always pass through a clinician's signature.

**Where:** the real application, seeded with the demo clinic
(**Aura Derma & Hair Clinic**, Cairo). Not the static mock-up.

---

## Before the meeting (15 minutes, once)

1. **Use a live AI provider.** Set `GEMINI_API_KEY` (free tier) or another key
   in `.env`. Without a key the assistant runs in offline `echo` mode: it still
   retrieves and cites, but it quotes the records instead of reasoning over them,
   and every answer carries an "Offline mode" note.
2. **Rebuild the demo clinic the morning of the demo** so the schedule is
   centred on today:
   ```bash
   SEED_DEMO_PASSWORD='<choose 12+ characters>' npm run db:seed
   ```
   The seed also indexes every record for the assistant and prints the five
   accounts. Re-running it resets everything you changed during rehearsal.
3. **Sign in as the owner** (`owner@demo.clinic`, Dr. Layla Hassan). She is the
   physician-owner: settings and team, and she can book, review and sign.
   Keep `doctor@demo.clinic` in a second browser profile if you want to show two
   people working at once.
4. Open `/api/health` in a tab: it shows the database, the active AI providers
   and that no development secrets are in use.
5. Rehearse the consultation step once with the transcript below.

---

## The script

### 1. Sign-in (30 s)
Open `/login`. Type a wrong password first: the message does not reveal whether
the account exists, and repeated failures lock the account.
> "There is no back door. Every request to the application carries a session
> that can be revoked, and every sign-in attempt is recorded."

### 2. Overview (45 s)
Metrics for the clinic: patients, today's appointments, upcoming, no-show rate,
appointment volume, AI activity, diagnosis distribution.
> "This is what the owner sees at eight in the morning. Everything on this
> screen is a live query."
Switch light/dark with the moon icon to make the white-label point.

### 3. Patients (60 s)
Search `Ali` and open **Ali Adel**.
- Header: age, contact, language, tags.
- Medical history: chronic conditions, the **penicillin allergy** in red,
  diagnoses, surgeries.
- Medications: read-only, written only by signed consultations.
- **Timeline** tab: appointments, visits, diagnoses and prescriptions in one
  chronological record. **Visits & consultations** tab: who saw him and when.
> "One record of truth. Nothing here was typed into a free-text box by an
> AI: every clinical line came from a consultation a doctor signed."

### 4. Appointments (60 s)
Open **Appointments** (week view, today highlighted). Click **New appointment**:
pick a patient, **Dr. Omar Fahmy**, today, a time that is already taken on his
column. ClinicMind refuses the overlap and names the conflict. Move it to a
free slot and book.
- From the **⋯** menu on today's bookings: confirm, check in, complete, or
  no-show. Cancelling asks for a reason; the reason stays on the record.
- Switch to **Day** for the front-desk list.
> "The schedule runs on the clinic's clock, conflicts are detected per doctor
> and per room, and every status change is audited."

### 5. Consultation intelligence — the hero moment (2 min)
Open **Consultations** → **New consultation**. Pick **Ali Adel**, paste the
transcript below, click **Extract clinical data**.

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
follow-ups, medications. Nothing has been saved to the record yet.
- Edit something live (change a dose, remove a symptom) to show the clinician
  is in control.
- Point to **Stop existing medication**: the current prescription list with
  tick boxes; a continued medicine is updated in place, a ticked one is stopped.
- Click **Review complete — sign**. Open Ali's **Timeline**: a new visit,
  diagnosis and prescription, attributed to the signer and timestamped.
- Optional: show **Discard draft** on one of the drafts awaiting review, and
  that a receptionist account cannot sign.
> "The AI drafts, the doctor decides. The record carries the doctor's
> signature, and the audit log keeps the AI draft next to what was signed."

### 6. AI assistant (90 s)
Open **AI Assistant**. Click a suggestion or ask:
- "Which patients have a documented allergy to penicillin?"
- "Who is currently on isotretinoin, and at what dose?"
- Focus the **patient context** on Ali Adel and ask "Summarise his treatment so far."

Each answer shows **grounded** or not, with numbered citations that open the
patient's record. Then ask something the clinic has no record of
("Which patients had knee surgery?"): it says it found nothing instead of
inventing an answer.
> "Retrieval first, always. If it is not in your records, the assistant says
> so. That is the difference between decision support and a chatbot."

### 7. Settings and embedding (45 s)
**Settings**: branding, custom domain, the **Team** list with roles and an
invitation form (single-use links, no passwords sent around), the **embed
secret** (stored hashed, shown once, rotatable) and the two copy-paste snippets
for putting ClinicMind inside the clinic's website.
> "Each clinic is its own isolated tenant with its own domain, brand, secret and
> allow-listed origins."

### 8. Close (30 s)
- Security: real authentication, roles at every API edge, tenant isolation in
  the application and in the database, append-only audit, security headers and
  rate limits, production refuses to start with development secrets.
- Operations: one-command stack with TLS and nightly backups, migrations,
  health endpoint, CI with dependency audit and end-to-end tests.
- Roadmap: audio capture and transcription, the all-in-one inbox (WhatsApp,
  voice) through the integration contract in `docs/SPEC_ANALYSIS.md`, Arabic,
  reporting.

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| Assistant answers carry an "Offline mode" note | No AI key configured or the key failed; check `/api/health` → `ai`. The demo still works, answers just quote the records. |
| "Too many requests" or "account locked" on sign-in | You rehearsed too many wrong passwords. The per-IP limit clears in minutes; the account lockout is stored in the database and clears after 15 minutes, or re-run the seed. |
| Schedule looks empty | The seed was run on another day; re-run `npm run db:seed`. |
| Sign button missing on a draft | You are signed in as a nurse or receptionist; sign in as the owner or a doctor. |

## What not to promise yet
- Audio capture and transcription (button is visible but disabled: next release).
- WhatsApp / voice channels and the shared inbox (integration contract written, not wired).
- Arabic interface and right-to-left layout.
