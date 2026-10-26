import type { NotificationKind, NotificationLevel, Prisma } from "@prisma/client";
import type { SeedContext } from "./index";
import { makeRandom } from "./util";

/**
 * A week of notifications for the demo clinic: about 25 for the owner (two
 * critical escalations still unread, a metric alert, bookings, no-shows,
 * onboarding forms, a payment, the weekly brief, the welcome), 10 for the
 * reception (bookings, leads, messages, intake) and 6 for Dr. Omar Fahmy
 * (escalations, consultations awaiting signature). About half are read.
 * Titles point at real rows created by the earlier seed modules when they
 * exist (appointments, leads, escalations, consultations). Preferences: the
 * owner has browser notifications on and a digest at 08:00; the doctor gets
 * e-mail for escalations only.
 */
const TZ = "Africa/Cairo";
const MINUTE = 60_000;

const dateKey = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const timeOf = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const dayOf = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "2-digit", month: "short" }).format(d);

interface Draft {
  userId: string;
  kind: NotificationKind;
  level?: NotificationLevel;
  title: string;
  body?: string;
  href?: string;
  entity?: string;
  entityId?: string;
  /** How long ago it happened. */
  minutesAgo: number;
  read: boolean;
  emailed?: boolean;
}

export async function seedNotifications(ctx: SeedContext): Promise<void> {
  const r = makeRandom(71);
  const { db, tenantId } = ctx;
  const byEmail = (email: string) => ctx.users.find((u) => u.email === email);
  const owner = byEmail("owner@demo.clinic");
  const reception = byEmail("reception@demo.clinic");
  const doctor = byEmail("doctor@demo.clinic");
  if (!owner) return;

  const now = ctx.today;
  const since = new Date(now.getTime() - 7 * 24 * 60 * MINUTE);

  // Distinct patient names, deterministic.
  const pool = [...ctx.patients];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r.rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  let cursor = 0;
  const patient = () => pool[cursor++ % Math.max(pool.length, 1)] ?? { id: "", fullName: "Walk-in patient", condKey: "", tag: "" };

  // What the earlier modules left for us to point at.
  const [upcoming, noShows, leads, escalations, pendingConsultations, intakePending] = await Promise.all([
    db.appointment.findMany({
      where: { tenantId, deletedAt: null, startsAt: { gte: now }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
      orderBy: { startsAt: "asc" },
      take: 9,
      select: { id: true, startsAt: true, reason: true, patient: { select: { fullName: true } } },
    }),
    db.appointment.findMany({
      where: { tenantId, deletedAt: null, status: "NO_SHOW", startsAt: { gte: since } },
      orderBy: { startsAt: "desc" },
      take: 3,
      select: { id: true, startsAt: true, reason: true, patient: { select: { fullName: true } } },
    }),
    db.lead.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, fullName: true, source: true, interests: true } }),
    db.escalation.findMany({ where: { tenantId, status: { in: ["OPEN", "ACKNOWLEDGED"] } }, orderBy: { dueAt: "asc" }, take: 3, select: { id: true, summary: true, level: true } }),
    doctor
      ? db.consultation.findMany({
          where: { tenantId, status: "PENDING_REVIEW", doctorId: doctor.id },
          orderBy: { createdAt: "asc" },
          take: 4,
          select: { id: true, createdAt: true, patient: { select: { fullName: true } } },
        })
      : Promise.resolve([]),
    db.intakeSubmission.findMany({ where: { tenantId, status: "PENDING" }, orderBy: { submittedAt: "desc" }, take: 3, select: { id: true, fullName: true } }),
  ]);

  const receptionName = reception?.fullName ?? "the front desk";
  const bookedVia = ["via WhatsApp", "via the website", "by the AI receptionist", "by phone"];
  const treatments = ["FUE hair transplant", "PRP session", "Acne follow-up", "Pigmentation review", "Laser hair removal", "Botox & fillers", "General dermatology"];

  const booking = (userId: string, i: number, minutesAgo: number, read: boolean): Draft => {
    const a = upcoming[i];
    const when = a?.startsAt ?? new Date(now.getTime() + (i + 1) * 36 * 60 * MINUTE);
    const who = a?.patient.fullName ?? patient().fullName;
    return {
      userId,
      kind: "BOOKING_CREATED",
      title: `New booking: ${who} · ${dayOf(when)} ${timeOf(when)}`,
      body: `${a?.reason ?? r.pick(treatments)} · booked by ${receptionName} ${r.pick(bookedVia)}.`,
      href: `/dashboard/appointments?date=${dateKey(when)}`,
      entity: a ? "Appointment" : undefined,
      entityId: a?.id,
      minutesAgo,
      read,
    };
  };
  const noShow = (userId: string, i: number, minutesAgo: number, read: boolean): Draft => {
    const a = noShows[i];
    const when = a?.startsAt ?? new Date(now.getTime() - minutesAgo * MINUTE);
    const who = a?.patient.fullName ?? patient().fullName;
    return {
      userId,
      kind: "NO_SHOW",
      level: "WARNING",
      title: `No-show: ${who} missed ${timeOf(when)} on ${dayOf(when)}`,
      body: `${a?.reason ?? r.pick(treatments)} · ${i === 0 ? "second miss in 60 days" : "first miss"} — call to rebook.`,
      href: `/dashboard/appointments?date=${dateKey(when)}`,
      entity: a ? "Appointment" : undefined,
      entityId: a?.id,
      minutesAgo,
      read,
    };
  };
  const lead = (userId: string, i: number, minutesAgo: number, read: boolean): Draft => {
    const l = leads[i];
    const who = l?.fullName ?? patient().fullName;
    const source = l?.source ? l.source.toLowerCase().replace(/_/g, " ") : r.pick(["instagram", "facebook", "google", "referral"]);
    const interest = l?.interests?.[0] ?? r.pick(treatments);
    return {
      userId,
      kind: "LEAD_NEW",
      title: `New lead: ${who} · ${source} · ${interest}`,
      body: `Asked for prices in Arabic · assigned to ${receptionName} · first touch within 15 min keeps the conversion at 40%.`,
      href: "/dashboard/leads",
      entity: l ? "Lead" : undefined,
      entityId: l?.id,
      minutesAgo,
      read,
    };
  };
  const message = (userId: string, i: number, minutesAgo: number, read: boolean): Draft => {
    const quotes = [
      "Is it normal to have redness two days after the PRP session?",
      "Can I move Thursday's appointment to the afternoon?",
      "Which shampoo should I use after the transplant?",
      "Do you have a slot this Saturday for a consultation?",
    ];
    const who = patient().fullName;
    return {
      userId,
      kind: "MESSAGE_INBOUND",
      title: `${who} wrote on WhatsApp`,
      body: `“${quotes[i % quotes.length]}”`,
      href: "/dashboard/conversations",
      minutesAgo,
      read,
    };
  };
  const intake = (userId: string, i: number, minutesAgo: number, read: boolean): Draft => {
    const s = intakePending[i];
    const who = s?.fullName ?? patient().fullName;
    return {
      userId,
      kind: "INTAKE_SUBMITTED",
      title: `Onboarding form from ${who}`,
      body: i % 2 === 0 ? "Matched to an existing patient by phone · 2 photos attached · allergies: penicillin." : "New patient · hair loss, Norwood III · asks about FUE pricing and recovery time.",
      href: "/dashboard/patients/intake",
      entity: s ? "IntakeSubmission" : undefined,
      entityId: s?.id,
      minutesAgo,
      read,
    };
  };

  const esc1Patient = patient().fullName;
  const esc2Patient = patient().fullName;
  const escalation = (userId: string, i: number, minutesAgo: number, read: boolean, level: NotificationLevel): Draft => {
    const e = escalations[i];
    const texts = [
      {
        title: `Patient at risk: ${esc1Patient} · severe pain after FUE (day 2)`,
        body: "Check-in answer: “pain 9/10, swelling around the donor area”. Target reply within 30 min — acknowledge in Concierge.",
      },
      {
        title: `Patient at risk: ${esc2Patient} · fever 38.6° after PRP session`,
        body: "Check-in answer: “fever since last night, redness spreading”. Out of hours — the on-call doctor was e-mailed.",
      },
      {
        title: `Watch: ${patient().fullName} reports itching on day 5`,
        body: "Within the normal range for the protocol; a nurse replied with the aftercare note. No action needed unless it persists.",
      },
    ];
    const t = texts[i % texts.length]!;
    return {
      userId,
      kind: "ESCALATION",
      level,
      title: e?.summary && e.summary.length <= 120 ? `Patient at risk: ${e.summary}` : t.title,
      body: t.body,
      href: "/dashboard/concierge",
      entity: e ? "Escalation" : undefined,
      entityId: e?.id,
      minutesAgo,
      read,
      emailed: true,
    };
  };
  const reviewPending = (userId: string, i: number, minutesAgo: number, read: boolean): Draft => {
    const c = pendingConsultations[i];
    const who = c?.patient.fullName ?? patient().fullName;
    const drafted = c?.createdAt ?? new Date(now.getTime() - (minutesAgo + 24 * 60) * MINUTE);
    const hours = Math.max(24, Math.floor((now.getTime() - drafted.getTime()) / (60 * MINUTE)) - Math.floor(minutesAgo / 60));
    return {
      userId,
      kind: "REVIEW_PENDING",
      level: "WARNING",
      title: `Consultation of ${who} awaits your signature`,
      body: `Drafted ${dayOf(drafted)} ${timeOf(drafted)} · waiting ${hours} h. Review the extraction and sign it.`,
      href: c ? `/dashboard/consultations?id=${c.id}` : "/dashboard/consultations",
      entity: "Consultation",
      entityId: c?.id,
      minutesAgo,
      read,
    };
  };

  const H = 60;
  const D = 24 * 60;
  const weekStart = new Date(now.getTime() - 2 * D * MINUTE);
  const drafts: Draft[] = [
    // ── Owner (25) ──────────────────────────────────────────────────────────
    escalation(owner.id, 0, 25, false, "CRITICAL"),
    escalation(owner.id, 1, 3 * H + 10, false, "CRITICAL"),
    {
      userId: owner.id,
      kind: "ALERT_RULE",
      level: "WARNING",
      title: "No-show rate crossed 8% (14 days: 11.5%)",
      body: "Rule “No-show rate ≤ 8%” fired on this morning's figures: 7 no-shows of 61 appointments. Reminders 24 h before the slot are the usual fix.",
      href: "/dashboard/reports",
      minutesAgo: 26 * H,
      read: false,
      emailed: true,
    },
    booking(owner.id, 0, 55, false),
    booking(owner.id, 1, 4 * H, false),
    booking(owner.id, 2, D + 2 * H, true),
    booking(owner.id, 3, 2 * D + 3 * H, true),
    booking(owner.id, 4, 3 * D + 5 * H, true),
    booking(owner.id, 5, 5 * D + H, true),
    noShow(owner.id, 0, 2 * H, false),
    noShow(owner.id, 1, D + 4 * H, true),
    noShow(owner.id, 2, 4 * D + 2 * H, true),
    intake(owner.id, 0, 40, false),
    intake(owner.id, 1, 2 * D + 6 * H, true),
    {
      userId: owner.id,
      kind: "PAYMENT_RECORDED",
      title: `Deposit of 5,000 EGP recorded for ${patient().fullName}`,
      body: "Hair transplant (FUE, 2,500 grafts) · balance 40,000 EGP due on the day · recorded by the front desk, cash.",
      href: "/dashboard/finance",
      minutesAgo: 6 * H,
      read: true,
    },
    {
      userId: owner.id,
      kind: "WEEKLY_BRIEF",
      title: `Weekly brief · week of ${dayOf(weekStart)}`,
      body: [
        "Revenue 184,500 EGP (+12% vs the week before), 61 appointments, 4 no-shows (6.6%).",
        "9 new leads, 3 consultations booked, best source Instagram (cost per consultation 420 EGP).",
        "2 escalations resolved, median reply 22 min; 14 check-ins answered, 1 flagged.",
        "Dr. Omar: 2 FUE sessions, 11 PRP; Dr. Mariam: 28 derm visits, 3 drafts still unsigned.",
        "Next week: 48 booked, Tuesday is full, Thursday afternoon has 5 open slots.",
      ].join("\n"),
      href: "/dashboard/reports",
      minutesAgo: 2 * D + 1 * H,
      read: false,
    },
    {
      userId: owner.id,
      kind: "SYSTEM",
      title: "Welcome to ClinicMind",
      body: "Your clinic is set up. Notifications land here and, when you want them, in your inbox — choose which ones under Settings → Notifications.",
      href: "/dashboard/settings",
      minutesAgo: 6 * D + 23 * H,
      read: true,
    },
    lead(owner.id, 0, H + 20, false),
    lead(owner.id, 1, D + 6 * H, true),
    lead(owner.id, 2, 3 * D + 2 * H, true),
    message(owner.id, 0, 15, false),
    message(owner.id, 1, D + 30, true),
    {
      userId: owner.id,
      kind: "FOLLOW_UP_OVERDUE",
      level: "WARNING",
      title: `Follow-up overdue: ${leads[3]?.fullName ?? patient().fullName} (due yesterday 14:00)`,
      body: `Call about the consultation quote · owner ${receptionName}. A lead left for 24 h becomes an escalation.`,
      href: "/dashboard/leads?tab=follow-ups",
      entity: leads[3] ? "Lead" : undefined,
      entityId: leads[3]?.id,
      minutesAgo: 5 * H,
      read: false,
    },
    {
      userId: owner.id,
      kind: "FOLLOW_UP_OVERDUE",
      level: "WARNING",
      title: `Follow-up overdue: ${leads[4]?.fullName ?? patient().fullName} (due Tuesday 11:00)`,
      body: "Send the PRP package offer · done later the same day.",
      href: "/dashboard/leads?tab=follow-ups",
      entity: leads[4] ? "Lead" : undefined,
      entityId: leads[4]?.id,
      minutesAgo: 2 * D + 4 * H,
      read: true,
    },
    {
      userId: owner.id,
      kind: "CHECK_IN_ANSWERED",
      title: `${patient().fullName} answered the day-7 check-in: all good`,
      body: "Pain 1/10, no swelling, taking the antibiotics as prescribed. Next check-in on day 14.",
      href: "/dashboard/concierge",
      minutesAgo: 9 * H,
      read: true,
    },
  ];

  // ── Reception (10) ────────────────────────────────────────────────────────
  if (reception) {
    drafts.push(
      booking(reception.id, 6, 30, false),
      booking(reception.id, 7, 3 * H, false),
      booking(reception.id, 8, D + 5 * H, true),
      lead(reception.id, 5, 50, false),
      lead(reception.id, 6, D + H, true),
      lead(reception.id, 7, 3 * D, true),
      message(reception.id, 2, 10, false),
      message(reception.id, 3, D + 2 * H, true),
      intake(reception.id, 2, 40, false),
      intake(reception.id, 1, 2 * D + 6 * H, true),
    );
  }

  // ── Dr. Omar Fahmy (6) ────────────────────────────────────────────────────
  if (doctor) {
    drafts.push(
      escalation(doctor.id, 0, 25, false, "CRITICAL"),
      escalation(doctor.id, 2, 2 * D + 3 * H, true, "WARNING"),
      reviewPending(doctor.id, 0, 3 * H, false),
      reviewPending(doctor.id, 1, D + 2 * H, false),
      reviewPending(doctor.id, 2, 3 * D + H, true),
      reviewPending(doctor.id, 3, 5 * D + 4 * H, true),
    );
  }

  const rows: Prisma.NotificationCreateManyInput[] = drafts.map((d) => {
    const createdAt = new Date(now.getTime() - d.minutesAgo * MINUTE);
    const readAt = d.read ? new Date(Math.min(now.getTime() - MINUTE, createdAt.getTime() + r.between(5, 600) * MINUTE)) : null;
    return {
      tenantId,
      userId: d.userId,
      kind: d.kind,
      level: d.level ?? "INFO",
      title: d.title,
      body: d.body ?? null,
      href: d.href ?? null,
      entity: d.entity ?? null,
      entityId: d.entityId ?? null,
      readAt,
      emailedAt: d.emailed ? createdAt : null,
      createdAt,
    };
  });
  await db.notification.createMany({ data: rows });

  const prefs: Prisma.NotificationPreferenceCreateManyInput[] = [
    { tenantId, userId: owner.id, inApp: {}, email: {}, browser: true, digestHour: 8 },
  ];
  if (doctor) prefs.push({ tenantId, userId: doctor.id, inApp: {}, email: { ESCALATION: true, ALERT_RULE: false }, browser: false, digestHour: null });
  await db.notificationPreference.createMany({ data: prefs, skipDuplicates: true });
}
