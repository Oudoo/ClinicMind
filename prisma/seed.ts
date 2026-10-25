import { PrismaClient, type Gender, type AppointmentStatus, type ChannelType, type Prisma } from "@prisma/client";
import { generateEmbedSecret } from "../src/lib/embed";
import { generatePassword, hashPassword, PasswordSchema } from "../src/lib/auth/password";
import { reindexTenant } from "../src/modules/knowledge/ingest";
import { PLATFORM_TENANT_SLUG } from "../src/modules/platform/service";
import { seedRound2 } from "./seed/index";

/**
 * Demo seed: "Aura Derma & Hair Clinic" (Cairo), a dermatology and hair-transplant
 * practice with five staff accounts, ~60 patients, six weeks of completed visits
 * with signed consultations, three weeks of upcoming appointments, WhatsApp and
 * voice conversations and AI activity. Deterministic (seeded PRNG) and
 * idempotent: re-running removes the demo tenant and rebuilds it.
 *
 * Staff passwords: `SEED_DEMO_PASSWORD` if set, otherwise a fresh random one;
 * it is printed at the end. There is no development sign-in bypass.
 */
const db = new PrismaClient();
const TENANT_SLUG = "demo";
const PLATFORM_ADMIN_EMAIL = "platform@demo.clinic";
const TZ = "Africa/Cairo";

// ── Deterministic randomness ─────────────────────────────────────────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261022);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

// ── Time helpers (clinic wall-clock → UTC) ───────────────────────────────────
function zoned(y: number, m: number, d: number, h: number, min: number): Date {
  // Find the UTC instant whose wall time in TZ is the requested one.
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
    guess -= asUtc - Date.UTC(y, m - 1, d, h, min);
  }
  return new Date(guess);
}
function calendarDay(offsetDays: number): { y: number; m: number; d: number; weekday: number } {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), weekday };
}

// ── Clinical vocabulary ──────────────────────────────────────────────────────
const FIRST_M = ["Ahmed", "Mohamed", "Omar", "Youssef", "Khaled", "Mahmoud", "Karim", "Tarek", "Hassan", "Amr", "Mostafa", "Ali", "Ziad", "Sherif", "Hany", "Adel", "Ibrahim", "Sameh"];
const FIRST_F = ["Sara", "Nour", "Fatma", "Mariam", "Heba", "Dina", "Yasmin", "Salma", "Rana", "Aya", "Menna", "Hala", "Laila", "Nadine", "Mona", "Reem", "Farida", "Nesma"];
const LAST = ["Mahmoud", "Saleh", "Ibrahim", "El-Din", "Adel", "Mansour", "Tarek", "Hany", "Fathy", "Abdel Rahman", "Samir", "Kamel", "Shaaban", "Gamal", "Zaki", "Fouad", "Nabil", "Ezzat", "Hamdy", "Lotfy"];

interface Condition {
  key: string;
  tag: string;
  chronic: string[];
  diagnosis: string;
  meds: { name: string; dosage: string; frequency: string }[];
  reasons: string[];
  symptoms: string[];
  tests: string[];
  followUps: string[];
  doctor: "derm" | "hair";
}
const CONDITIONS: Condition[] = [
  { key: "aga", tag: "hair-loss", chronic: ["Androgenetic alopecia"], diagnosis: "Androgenetic alopecia (Norwood III vertex)", meds: [{ name: "Minoxidil 5% solution", dosage: "1 ml", frequency: "Twice daily" }, { name: "Finasteride", dosage: "1 mg", frequency: "Once daily" }], reasons: ["Hair loss consultation", "Hair loss follow-up", "PRP session", "Hair transplant consultation"], symptoms: ["progressive thinning at the crown", "increased shedding over 8 months", "family history on father's side"], tests: ["Trichoscopy", "Ferritin and TSH"], followUps: ["Review in 3 months with photos", "Discuss transplant candidacy"], doctor: "hair" },
  { key: "fue", tag: "hair-transplant", chronic: ["Androgenetic alopecia"], diagnosis: "Post FUE hair transplant, day 7 review", meds: [{ name: "Cephalexin", dosage: "500 mg", frequency: "Twice daily for 5 days" }, { name: "Saline spray", dosage: "As directed", frequency: "Every 2 hours while awake" }], reasons: ["Post-op day 7 review", "Post-op day 14 review", "Month 1 review", "Month 3 review"], symptoms: ["mild crusting in recipient area", "no bleeding", "donor area healing well"], tests: [], followUps: ["Crust removal guidance", "Photo set at month 1"], doctor: "hair" },
  { key: "acne", tag: "acne", chronic: [], diagnosis: "Acne vulgaris, moderate inflammatory", meds: [{ name: "Adapalene 0.1% gel", dosage: "Thin layer", frequency: "Nightly" }, { name: "Doxycycline", dosage: "100 mg", frequency: "Once daily for 8 weeks" }], reasons: ["Acne consultation", "Acne follow-up", "Chemical peel session"], symptoms: ["inflammatory papules on cheeks and jawline", "post-inflammatory marks", "flares before menstruation"], tests: [], followUps: ["Review in 6 weeks", "Sunscreen counselling"], doctor: "derm" },
  { key: "melasma", tag: "pigmentation", chronic: ["Melasma"], diagnosis: "Melasma, mixed epidermal-dermal", meds: [{ name: "Tranexamic acid", dosage: "250 mg", frequency: "Twice daily" }, { name: "Hydroquinone 4% cream", dosage: "Thin layer", frequency: "Nightly" }, { name: "Broad-spectrum sunscreen SPF 50", dosage: "Generous", frequency: "Every 3 hours outdoors" }], reasons: ["Pigmentation consultation", "Melasma follow-up", "Laser session"], symptoms: ["symmetrical brown patches on cheeks", "worse after summer", "no new medications"], tests: ["Wood's lamp examination"], followUps: ["Review in 8 weeks with photos"], doctor: "derm" },
  { key: "eczema", tag: "eczema", chronic: ["Atopic dermatitis"], diagnosis: "Atopic dermatitis flare, flexural", meds: [{ name: "Emollient cream", dosage: "Liberal", frequency: "Twice daily" }, { name: "Mometasone 0.1% cream", dosage: "Thin layer", frequency: "Once daily for 7 days" }], reasons: ["Eczema flare", "Eczema review"], symptoms: ["itchy patches in elbow folds", "sleep disturbed by itching", "dry skin"], tests: [], followUps: ["Review in 2 weeks", "Written skincare plan"], doctor: "derm" },
  { key: "psoriasis", tag: "psoriasis", chronic: ["Plaque psoriasis"], diagnosis: "Plaque psoriasis, limited, elbows and scalp", meds: [{ name: "Calcipotriol/betamethasone gel", dosage: "Thin layer", frequency: "Once daily" }, { name: "Coal tar shampoo", dosage: "As directed", frequency: "Three times weekly" }], reasons: ["Psoriasis review", "Psoriasis consultation"], symptoms: ["well-demarcated scaly plaques on elbows", "scalp scaling", "no joint pain"], tests: [], followUps: ["Review in 6 weeks"], doctor: "derm" },
  { key: "rosacea", tag: "rosacea", chronic: ["Rosacea"], diagnosis: "Papulopustular rosacea", meds: [{ name: "Metronidazole 0.75% gel", dosage: "Thin layer", frequency: "Twice daily" }, { name: "Ivermectin 1% cream", dosage: "Thin layer", frequency: "Nightly" }], reasons: ["Rosacea consultation", "Rosacea follow-up"], symptoms: ["persistent central facial redness", "flushing with heat and spicy food", "papules on nose"], tests: [], followUps: ["Trigger diary", "Review in 8 weeks"], doctor: "derm" },
  { key: "alopecia-areata", tag: "hair-loss", chronic: ["Alopecia areata"], diagnosis: "Alopecia areata, single patch, scalp", meds: [{ name: "Intralesional triamcinolone", dosage: "5 mg/ml", frequency: "Every 4 weeks" }], reasons: ["Alopecia areata injection", "Alopecia areata review"], symptoms: ["round patch of hair loss 3 cm", "noticed 6 weeks ago", "no nail changes"], tests: ["Thyroid function"], followUps: ["Injection in 4 weeks"], doctor: "hair" },
  { key: "laser-hr", tag: "laser", chronic: [], diagnosis: "Hirsutism, cosmetic laser hair removal course", meds: [], reasons: ["Laser hair removal session", "Laser hair removal consultation"], symptoms: ["unwanted facial hair", "previous waxing", "no hormonal symptoms"], tests: ["Hormonal profile if cycles irregular"], followUps: ["Next session in 6 weeks"], doctor: "derm" },
  { key: "warts", tag: "minor-procedure", chronic: [], diagnosis: "Plantar warts", meds: [{ name: "Salicylic acid 40% plaster", dosage: "Apply", frequency: "Daily" }], reasons: ["Wart cryotherapy", "Wart review"], symptoms: ["painful lesions on sole", "present for 4 months"], tests: [], followUps: ["Cryotherapy repeat in 3 weeks"], doctor: "derm" },
];
const ALLERGIES = [[], [], [], ["Penicillin"], ["Sulfa drugs"], ["NSAIDs"], ["Latex"]];
const COMORBID = [[], [], [], ["Hypertension"], ["Type 2 diabetes"], ["Hypothyroidism"], ["PCOS"], ["Iron deficiency anaemia"]];
const ROOMS = ["Room 1", "Room 2", "Laser suite", "Procedure room"];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🌱 Seeding ClinicMind demo clinic…");
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? generatePassword();
  const policy = PasswordSchema.safeParse(demoPassword);
  if (!policy.success) throw new Error(`SEED_DEMO_PASSWORD rejected: ${policy.error.issues[0]?.message}`);
  const passwordHash = await hashPassword(demoPassword);
  const embedSecret = generateEmbedSecret();
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  // Rebuild from scratch (audit rows cascade only with the explicit opt-in).
  const existing = await db.tenant.findUnique({ where: { slug: TENANT_SLUG }, select: { id: true } });
  if (existing) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL app.allow_audit_delete = 'on'`),
      db.tenant.delete({ where: { id: existing.id } }),
    ]);
    console.log("   Removed the previous demo tenant.");
  }

  const tenant = await db.tenant.create({
    data: {
      slug: TENANT_SLUG,
      name: "Aura Derma & Hair Clinic",
      status: "ACTIVE",
      branding: { accent: "#4F46E5", productName: "ClinicMind" },
      settings: { locale: "ar", channels: { whatsapp: true, voice: true } },
      embed: {
        create: {
          enabled: true,
          allowedOrigins: [new URL(appUrl).origin],
          secretHash: embedSecret.hash,
          secretPrefix: embedSecret.prefix,
          secretRotatedAt: new Date(),
        },
      },
      clinics: { create: { name: "Aura Clinic — Zamalek", address: "12 Hassan Sabry St, Zamalek, Cairo", phone: "+20 2 2735 0101", timezone: TZ } },
    },
    include: { clinics: true },
  });
  const clinicId = tenant.clinics[0]!.id;

  const staffSeed = [
    { email: "owner@demo.clinic", fullName: "Dr. Layla Hassan", role: "CLINIC_OWNER" as const, kind: "derm" as const },
    // The Clinic AI lead: owner-level, no clinic list of their own; the account the spec demo signs in with.
    { email: "ai@demo.clinic", fullName: "Nadia Youssef", role: "CLINIC_OWNER" as const, kind: null },
    { email: "doctor@demo.clinic", fullName: "Dr. Omar Fahmy", role: "DOCTOR" as const, kind: "hair" as const },
    { email: "mariam@demo.clinic", fullName: "Dr. Mariam Tarek", role: "DOCTOR" as const, kind: "derm" as const },
    { email: "nurse@demo.clinic", fullName: "Heba Mostafa", role: "NURSE" as const, kind: null },
    { email: "reception@demo.clinic", fullName: "Youssef Hany", role: "RECEPTIONIST" as const, kind: null },
  ];
  // Platform console: SUPER_ADMIN accounts live in their own tenant, never in a clinic.
  const platformExisting = await db.tenant.findUnique({ where: { slug: PLATFORM_TENANT_SLUG }, select: { id: true } });
  if (platformExisting) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL app.allow_audit_delete = 'on'`),
      db.tenant.delete({ where: { id: platformExisting.id } }),
    ]);
  }
  const platform = await db.tenant.create({
    data: { slug: PLATFORM_TENANT_SLUG, name: "GrowCDX Platform", status: "ACTIVE", branding: { productName: "ClinicMind" }, settings: { platform: true } },
    select: { id: true },
  });
  await db.user.create({
    data: { tenantId: platform.id, email: PLATFORM_ADMIN_EMAIL, fullName: "Platform Admin", role: "SUPER_ADMIN", status: "ACTIVE", passwordHash },
  });

  const staff = [] as { id: string; fullName: string; kind: "derm" | "hair" | null }[];
  for (const s of staffSeed) {
    const u = await db.user.create({
      data: { tenantId: tenant.id, clinicId, email: s.email, fullName: s.fullName, role: s.role, status: "ACTIVE", passwordHash },
      select: { id: true, fullName: true },
    });
    staff.push({ id: u.id, fullName: u.fullName ?? s.fullName, kind: s.kind });
  }
  const owner = staff[0]!;
  const doctorsFor = (kind: "derm" | "hair") => staff.filter((s) => s.kind === kind);

  // ── Patients ────────────────────────────────────────────────────────────
  const patients: { id: string; fullName: string; cond: Condition; language: string; phone: string; gender: Gender }[] = [];
  const used = new Set<string>();
  for (let i = 0; i < 62; i++) {
    const gender: Gender = chance(0.52) ? "FEMALE" : "MALE";
    let fullName = "";
    do {
      fullName = `${gender === "FEMALE" ? pick(FIRST_F) : pick(FIRST_M)} ${pick(LAST)}`;
    } while (used.has(fullName));
    used.add(fullName);
    const cond = pick(CONDITIONS);
    const age = between(19, 68);
    const dob = new Date(Date.UTC(2026 - age, between(0, 11), between(1, 28)));
    const language = chance(0.8) ? "ar" : "en";
    const allergies = pick(ALLERGIES);
    const comorbid = pick(COMORBID);
    const tags = [cond.tag, ...(chance(0.12) ? ["vip"] : []), ...(chance(0.15) ? ["new-patient"] : [])];
    const phone = `+2010${String(between(10_000_000, 99_999_999))}`;
    const p = await db.patient.create({
      data: {
        tenantId: tenant.id,
        fullName,
        gender,
        dateOfBirth: dob,
        phone,
        whatsapp: phone,
        email: chance(0.5) ? `${fullName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com` : null,
        emergencyContact: chance(0.6) ? `+2011${String(between(10_000_000, 99_999_999))}` : null,
        address: chance(0.7) ? pick(["Zamalek, Cairo", "Maadi, Cairo", "Nasr City, Cairo", "Heliopolis, Cairo", "6th of October City", "Sheikh Zayed", "Dokki, Giza", "New Cairo"]) : null,
        language,
        tags,
        notes: chance(0.3) ? pick(["Prefers morning appointments.", "Referred by Dr. Nabil.", "Sensitive skin — patch test before peels.", "Asked for Arabic-only communication."]) : null,
        createdAt: new Date(Date.now() - between(20, 400) * 86_400_000),
        medicalHistory: {
          create: {
            tenantId: tenant.id,
            chronicConditions: [...cond.chronic, ...comorbid],
            diagnoses: [cond.diagnosis],
            allergies,
            surgeries: cond.key === "fue" ? ["FUE hair transplant (2,400 grafts)"] : [],
            symptoms: cond.symptoms,
          },
        },
        medications: {
          create: cond.meds.map((m) => ({ tenantId: tenant.id, name: m.name, dosage: m.dosage, frequency: m.frequency, startDate: new Date(Date.now() - between(7, 120) * 86_400_000), active: true })),
        },
      },
      select: { id: true, fullName: true },
    });
    patients.push({ id: p.id, fullName: p.fullName, cond, language, phone, gender });
  }

  // ── Appointments, visits and consultations ───────────────────────────────
  const slots = [10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19];
  let appointmentCount = 0;
  let visitCount = 0;
  let pendingCount = 0;
  const timeline: Prisma.TimelineEventCreateManyInput[] = [];
  const todayKey = JSON.stringify(calendarDay(0));

  for (let offset = -42; offset <= 21; offset++) {
    const day = calendarDay(offset);
    if (day.weekday === 5) continue; // closed on Fridays
    const isToday = JSON.stringify(day) === todayKey;
    const n = day.weekday === 6 ? between(5, 8) : between(8, 13);
    const chosen = [...slots].sort(() => rand() - 0.5).slice(0, n).sort((a, b) => a - b);
    // No double bookings in the seed either: a doctor or a room stays busy until
    // its last live booking of the day ends (the database enforces the same).
    const busyUntil = new Map<string, number>();
    const free = (key: string, at: number) => (busyUntil.get(key) ?? 0) <= at;
    for (const slot of chosen) {
      const patient = pick(patients);
      const duration = pick([20, 30, 30, 45, 60]);
      const startsAt = zoned(day.y, day.m, day.d, Math.floor(slot), slot % 1 ? 30 : 0);
      const endsAt = new Date(startsAt.getTime() + duration * 60_000);
      const freeDoctors = doctorsFor(patient.cond.doctor).filter((d) => free(d.id, startsAt.getTime()));
      const freeRooms = ROOMS.filter((r) => free(r, startsAt.getTime()));
      if (!freeDoctors.length || !freeRooms.length) continue;
      const doctor = pick(freeDoctors);
      const room = pick(freeRooms);
      const kind = chance(0.55) ? ("CONSULTATION" as const) : chance(0.5) ? ("FOLLOW_UP" as const) : ("PROCEDURE" as const);
      const reason = pick(patient.cond.reasons);
      let status: AppointmentStatus = "SCHEDULED";
      let cancelReason: string | null = null;
      const past = startsAt.getTime() < Date.now();
      if (isToday) {
        status = past ? pick(["COMPLETED", "COMPLETED", "IN_PROGRESS", "CHECKED_IN", "NO_SHOW"]) : pick(["CONFIRMED", "CONFIRMED", "SCHEDULED"]);
      } else if (past) {
        const r = rand();
        status = r < 0.82 ? "COMPLETED" : r < 0.9 ? "NO_SHOW" : "CANCELLED";
        if (status === "CANCELLED") cancelReason = pick(["Patient travelling", "Rescheduled by phone", "Doctor unavailable"]);
      } else {
        status = chance(0.55) ? "CONFIRMED" : chance(0.08) ? "WAITLISTED" : "SCHEDULED";
      }
      const source: ChannelType = pick(["WHATSAPP", "WHATSAPP", "WHATSAPP", "VOICE", "IN_PERSON", "WEB_CHAT"]);
      const appt = await db.appointment.create({
        data: {
          tenantId: tenant.id, clinicId, patientId: patient.id, doctorId: doctor.id, room, kind,
          startsAt, endsAt, status, reason, source, cancelReason,
          confirmedAt: status === "CONFIRMED" || status === "CHECKED_IN" || status === "IN_PROGRESS" || status === "COMPLETED" ? new Date(startsAt.getTime() - 86_400_000) : null,
          checkedInAt: status === "CHECKED_IN" || status === "IN_PROGRESS" || status === "COMPLETED" ? new Date(startsAt.getTime() - 5 * 60_000) : null,
          statusChangedAt: status === "SCHEDULED" ? null : new Date(Math.min(Date.now(), startsAt.getTime())),
          createdById: pick(staff).id,
          createdAt: new Date(startsAt.getTime() - between(1, 14) * 86_400_000),
        },
        select: { id: true },
      });
      appointmentCount++;
      if (status !== "CANCELLED" && status !== "NO_SHOW" && status !== "WAITLISTED") {
        busyUntil.set(doctor.id, endsAt.getTime());
        busyUntil.set(room, endsAt.getTime());
      }
      timeline.push({ tenantId: tenant.id, patientId: patient.id, kind: "APPOINTMENT", title: `Appointment — ${reason}`, refId: appt.id, occurredAt: startsAt });
      if (status === "NO_SHOW") timeline.push({ tenantId: tenant.id, patientId: patient.id, kind: "APPOINTMENT", title: "Missed appointment", body: reason, refId: appt.id, occurredAt: endsAt });

      if (status === "COMPLETED" || status === "IN_PROGRESS") {
        const c = patient.cond;
        const transcript = [
          `Doctor: Good morning, ${patient.fullName.split(" ")[0]}. What brings you in today?`,
          `Patient: ${c.symptoms[0]}. ${c.symptoms[1] ?? ""}`.trim(),
          `Doctor: Any allergies or new medications?`,
          `Patient: ${pick(["No, nothing new.", "Only what you prescribed last time.", "I stopped the cream for a week because of travel."])}`,
          `Doctor: On examination this is consistent with ${c.diagnosis.toLowerCase()}. ${c.meds.length ? `We will continue ${c.meds.map((m) => m.name).join(" and ")}.` : "No medication is needed today."} ${c.followUps[0] ?? ""}`,
        ].join("\n");
        const extraction = { symptoms: c.symptoms, diagnoses: [c.diagnosis], medications: c.meds, tests: c.tests, followUps: c.followUps };
        const summary = `${reason}. ${c.diagnosis}. ${c.meds.length ? `Plan: ${c.meds.map((m) => `${m.name} ${m.dosage} ${m.frequency.toLowerCase()}`).join("; ")}.` : "No medication."} ${c.followUps.join(". ")}.`;
        const awaitingSignature = status === "COMPLETED" && offset >= -3 && chance(0.3);
        if (status === "COMPLETED" && !awaitingSignature) {
          const visit = await db.visit.create({
            data: { tenantId: tenant.id, appointmentId: appt.id, patientId: patient.id, doctorId: doctor.id, notes: summary, transcript, summary, createdAt: endsAt },
            select: { id: true },
          });
          await db.consultation.create({
            data: { tenantId: tenant.id, patientId: patient.id, visitId: visit.id, doctorId: doctor.id, status: "SIGNED", transcript, extraction, summary, reviewedById: doctor.id, reviewedAt: endsAt, createdAt: startsAt },
          });
          visitCount++;
          timeline.push({ tenantId: tenant.id, patientId: patient.id, kind: "VISIT", title: "Consultation signed", body: summary, refId: visit.id, occurredAt: endsAt });
          timeline.push({ tenantId: tenant.id, patientId: patient.id, kind: "DIAGNOSIS", title: c.diagnosis, refId: visit.id, occurredAt: endsAt });
          if (c.meds.length) timeline.push({ tenantId: tenant.id, patientId: patient.id, kind: "PRESCRIPTION", title: c.meds.map((m) => m.name).join(", "), refId: visit.id, occurredAt: endsAt });
        } else {
          await db.consultation.create({
            data: { tenantId: tenant.id, patientId: patient.id, doctorId: doctor.id, status: "PENDING_REVIEW", transcript, extraction, summary, createdAt: startsAt },
          });
          pendingCount++;
        }
      }
    }
  }
  // ── Conversations (AI receptionist on WhatsApp / voice) ──────────────────
  const threads = [
    { ar: ["السلام عليكم، عايزة أحجز كشف لحب الشباب", "وعليكم السلام! أهلاً بحضرتك في عيادة أورا. أقرب ميعاد مع د. مريم طارق يوم الثلاثاء ٤ العصر أو الأربعاء ١١ الصبح. أي ميعاد يناسبك؟", "الأربعاء ١١", "تم الحجز ✅ الأربعاء ١١ صباحاً مع د. مريم. هنبعتلك تذكير قبلها بيوم. محتاجة أي حاجة تانية؟"], summary: "Booked acne consultation with Dr. Mariam Tarek, Wednesday 11:00.", channel: "WHATSAPP" as const },
    { ar: ["بعد عملية الزراعة بيومين وفي تورم خفيف في الجبهة، ده طبيعي؟", "تورم خفيف في الجبهة في أول ٣-٤ أيام شائع بعد الزراعة. نام ورأسك مرفوعة واستخدم الكمادات الباردة حوالين العينين. لو زاد التورم أو وصل للعين أو في ألم شديد كلّمنا فوراً على خط الطوارئ.", "تمام شكراً", "بالشفا العاجل 🌿 د. عمر هيشوف الصور بتاعة يوم ٧ في الزيارة الجاية."], summary: "Post-transplant day 2 swelling question; reassured, red-flag advice given, flagged for nurse review.", channel: "WHATSAPP" as const },
    { ar: ["Hi, what is the price of laser hair removal for the face?", "Hello! Full-face laser hair removal is EGP 1,200 to 1,600 per session depending on the area, confirmed at consultation. A course is usually 6 sessions, 6 weeks apart. Would you like a consultation with Dr. Layla Hassan?", "Yes please, next week", "Available slots: Monday 2:00 PM or Thursday 5:30 PM. Which suits you?", "Thursday", "Booked ✅ Thursday 5:30 PM. Please arrive with no make-up. See you then!"], summary: "Laser pricing enquiry converted to a consultation, Thursday 17:30.", channel: "WHATSAPP" as const },
    { ar: ["ممكن أأجل ميعادي بكرة؟", "أكيد. ميعادك بكرة الساعة ٣ العصر مع د. ليلى. المواعيد المتاحة: الخميس ١ الظهر أو السبت ١٢. أي واحد يناسبك؟", "السبت ١٢", "تم التأجيل ✅ السبت ١٢ ظهراً. شكراً لإبلاغنا مبكراً."], summary: "Rescheduled follow-up to Saturday 12:00.", channel: "WHATSAPP" as const },
    { ar: ["Call: patient asked about opening hours and parking.", "Assistant: shared hours (Sat–Thu 10:00–20:00) and parking at the Zamalek garage; offered booking; patient will call back."], summary: "Voice enquiry about hours and parking.", channel: "VOICE" as const },
    { ar: ["الكريم اللي كتبه الدكتور عمل احمرار وحرقان، أعمل إيه؟", "آسفين لسماع ده. وقفي الكريم مؤقتاً واستخدمي المرطب بس. ده ممكن يكون تهيّج بسيط لكن لازم الدكتور يشوفه. هنبعت رسالتك لطاقم التمريض وهيرجعولك خلال ساعتين. لو في تورم في الوش أو صعوبة في التنفس اتصلي بالطوارئ فوراً.", "ماشي", "الممرضة هبة هتتصل بحضرتك قريباً."], summary: "Possible topical irritation; escalated to nurse queue (medium).", channel: "WHATSAPP" as const },
  ];
  let conversationCount = 0;
  for (let i = 0; i < 26; i++) {
    const t = pick(threads);
    const patient = chance(0.85) ? pick(patients) : null;
    const createdAt = new Date(Date.now() - between(0, 30) * 86_400_000 - between(0, 20) * 3_600_000);
    const conv = await db.conversation.create({
      data: {
        tenantId: tenant.id, patientId: patient?.id ?? null, channel: t.channel,
        externalId: t.channel === "WHATSAPP" ? `wa_${between(100000, 999999)}` : `call_${between(100000, 999999)}`,
        locale: patient?.language ?? "ar", summary: t.summary, createdAt, updatedAt: createdAt,
        messages: {
          create: t.ar.map((body, j) => ({ tenantId: tenant.id, direction: j % 2 === 0 ? ("INBOUND" as const) : ("OUTBOUND" as const), body, createdAt: new Date(createdAt.getTime() + j * 90_000), meta: j % 2 === 1 ? { by: "ai", mode: "assist" } : undefined })),
        },
      },
      select: { id: true },
    });
    conversationCount++;
    if (patient) timeline.push({ tenantId: tenant.id, patientId: patient.id, kind: t.channel === "VOICE" ? "CALL" : "WHATSAPP_MESSAGE", title: t.summary, refId: conv.id, occurredAt: createdAt });
  }

  await db.timelineEvent.createMany({ data: timeline });

  // ── AI activity ──────────────────────────────────────────────────────────
  const prompts = ["Which transplant patients are due their month 3 photo set?", "Summarise today's appointments", "Patients on isotretinoin who missed follow-ups", "Compare melasma progress for patients on tranexamic acid"];
  await db.aiRun.createMany({
    data: Array.from({ length: 38 }, () => ({
      tenantId: tenant.id, authorId: pick(staff.slice(0, 3)).id, kind: pick(["assistant_chat", "assistant_chat", "extraction", "summary"]),
      provider: "gemini", model: "gemini-2.5-flash", rawPrompt: pick(prompts), generatedOutput: "…", confidenceScore: 0.6 + rand() * 0.35,
      status: "SUCCEEDED" as const, latencyMs: between(900, 4200), createdAt: new Date(Date.now() - between(0, 13) * 86_400_000),
    })),
  });
  await db.auditLog.create({ data: { tenantId: tenant.id, actorEmail: "seed@clinicmind", action: "tenant.seed", entity: "Tenant", entityId: tenant.id, after: { patients: patients.length, appointments: appointmentCount } } });

  console.log(`✅ Seeded "${tenant.name}": ${patients.length} patients, ${appointmentCount} appointments, ${visitCount} signed visits, ${pendingCount} consultations awaiting review, ${conversationCount} conversations.`);

  // ── CRM, finance, concierge, intake, notifications and reporting ─────────
  await seedRound2({
    db,
    tenantId: tenant.id,
    clinicId,
    users: staffSeed.map((s, i) => ({ id: staff[i]!.id, email: s.email, fullName: s.fullName, role: s.role, kind: s.kind })),
    patients: patients.map((p) => ({ id: p.id, fullName: p.fullName, language: p.language, phone: p.phone, gender: p.gender, condKey: p.cond.key, tag: p.cond.tag, doctorKind: p.cond.doctor })),
    zoned,
    calendarDay,
    today: new Date(),
  });

  // Build the assistant's knowledge base (uses the configured embedding provider,
  // or the offline hash embeddings when no AI key is set).
  const index = await reindexTenant(tenant.id);
  console.log(`🧠 Indexed ${index.chunks.embedded} chunks for the assistant (${index.errors} errors).`);
  console.log(`🔑 Embed secret (shown once, stored hashed): ${embedSecret.secret}`);
  console.log("");
  console.log(`   Sign in at ${appUrl}/login — all seven demo accounts share one password:`);
  for (const s of staffSeed) console.log(`     ${s.email.padEnd(24)} ${s.fullName} (${s.role.replace("_", " ").toLowerCase()})`);
  console.log(`     ${PLATFORM_ADMIN_EMAIL.padEnd(24)} Platform Admin (super admin · ${appUrl}/platform)`);
  console.log(`   Password: ${demoPassword}`);
  console.log("   Set SEED_DEMO_PASSWORD to choose it; re-running the seed rebuilds the demo clinic.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
