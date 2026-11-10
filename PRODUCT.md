# Product

<!-- impeccable:product-schema 1 -->

> Written from the codebase, the README and the owner's UI brief (10 November 2026), without an
> interview. Lines marked *(inferred)* are read from the code and seed data, not confirmed by the
> owner: correct them here and later design work follows.

## Platform

web

## Users

Staff of private clinics in Egypt, first of all dermatology and hair clinics, working in English
with patient-facing documents and messages in Arabic or English.

- **Receptionists** at the front desk, on a desktop all day with patients standing in front of
  them and the phone ringing: who is coming, who has arrived, booking and moving visits, taking
  payments, calling patients back.
- **Doctors** between patients, on a desktop or a tablet in the consultation room: who is next,
  the record, dictating and signing the consultation, the treatment plan.
- **Nurses**: the same schedule and records, procedure sessions, lab work and post-treatment
  follow-up; they do not sign.
- **Clinic owners**, usually a practising doctor *(inferred from the demo clinic)*: everything
  above, plus money, staff, reports and settings. They also look at the clinic from a phone.
- **Platform administrators** (the company that runs ClinicMind) create and manage the clinics.

## Product Purpose

One system for running the clinic's day: the patient record, the schedule, consultations that
become signed notes, billing and the follow-up of patients. Success is a front desk that never
loses track of who is waiting, a doctor who signs the note before the next patient, and an owner
whose money and recalls add up without a second spreadsheet.

## Positioning

The AI only speaks from the clinic's own record and library, with citations, and nothing reaches
the patient record until a clinician signs it. Every clinic is an isolated, white-labeled tenant.

## Operating Context

- A working day follows the patient: booked → confirmed → checked in → in consultation → done,
  with no-shows and cancellations to call back.
- The clinic's clock is the clinic's time zone (Africa/Cairo for the demo); the week starts on
  Saturday and Friday is usually closed.
- Money is whole Egyptian pounds (EGP). The desk takes cash, card, bank transfer and InstaPay.
- Patients are messaged on WhatsApp in their own language.
- Demo data: Aura Derma & Hair Clinic, Cairo (`npm run db:seed`); the live demo is
  https://cm.growcdx.com.

## Capabilities and Constraints

- Six roles enforced at every API edge; the interface shows a role only what it may use.
  Clinical sign-off, the assistant and the evidence panel need the clinician mark.
- Tenant branding: product name, accent colour and logo are set per clinic and must keep working
  in every screen (`src/lib/brand.ts`). Light is the default theme; dark is supported.
- Patient-facing surfaces (invoices, statements, quotes, the intake and check-in forms) render in
  Arabic, right to left, as well as English. The staff interface is English.
- Financial records are append-only: numbered, never edited or deleted. The interface must never
  suggest otherwise.
- Phones are a first-class size for the owner and for patient-facing pages; nothing may scroll
  sideways at 390 px.
- The click-through prototype in `demo/` is a separate mock-up, not this application.

## Brand Commitments

- Name: ClinicMind (a clinic may replace it with its own product name).
- Faces: Plus Jakarta Sans for the interface, JetBrains Mono for codes and reference numbers.
- Default accent: indigo `#4F46E5`; a clinic's own accent replaces it.
- Voice: plain, factual, in the clinic's own words ("visit", "the desk", "owes 1,100 EGP"); no
  marketing language inside the application.

## Evidence on Hand

- A seeded demo clinic with patients, weeks of appointments, signed visits, invoices and
  recalls, rebuilt around today's date by the seed.
- No customer logos, testimonials or usage figures exist: none may be invented.

## Product Principles

1. **The next action first.** A screen opens on what the person should do now (who is waiting,
   what to sign, what to collect), then on what happened.
2. **Show a role its own work.** Navigation, the overview and the lists lead with what that role
   does every day; the rest stays one step away, never mixed in.
3. **State is always readable.** A visit's status, a balance, a late patient: said in words, with
   a consistent colour and shape, never by colour alone.
4. **Dense, not crowded.** Staff read these screens hundreds of times a day: favour compact rows
   and clear grouping over large cards and decoration.
5. **Nothing clinical or financial by accident.** Signing, no-shows, refunds and write-offs ask
   first and say what will be recorded.

## Accessibility & Inclusion

WCAG 2.1 AA for contrast and keyboard use *(inferred as the working standard; no formal
requirement was stated)*. Arabic text is never letter-spaced or set in capitals. Status is never
carried by colour alone.
