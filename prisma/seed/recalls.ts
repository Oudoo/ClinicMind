import type { Prisma } from "@prisma/client";
import type { SeedContext, SeedUser } from "./index";
import { addDays, endOfDayInTz, formatDateInTz, startOfDayInTz } from "../../src/lib/time";
import { createAppointment, findFreeSlots, getTenantTimezone } from "../../src/modules/appointments/service";
import { ensureDefaultRecallRules } from "../../src/modules/recalls/rules";
import { addRecall } from "../../src/modules/recalls/service";
import { recallsOnConsultationSigned, recallsOnProcedureSigned, sweepRecalls } from "../../src/modules/recalls/engine";

/**
 * Recalls as the clinic would have them had they been switched on 200 days
 * ago: every signed procedure and consultation since is replayed through the
 * recall hooks at the moment it was signed (so reviews and next sessions
 * appear exactly as they would have), then the sweep catches up to today
 * (visits since close what they served, bookings ahead book them, missed
 * visits and planned work not booked are recalled).
 *
 * The demo's patients come in nearly every week, so most of what that makes
 * is done or booked. A few patients with quieter histories show every kind
 * and state on today's list: transplant reviews due and overdue, a laser
 * course's next session, an acne review, a missed procedure, planned botox
 * not booked, two patients not seen for over a year, sessions and reviews
 * due soon, a phone-call recall, a booking made from a recall, a laser
 * course left after one session (ended by the sweep long after its window),
 * a patient not seen for a year who came back after a call (won back); and
 * the desk's work of the last days on some of them (a call with no
 * answer, a WhatsApp message, a decline, an unreachable patient, a snooze).
 */

const DAY = 86_400_000;
const MIN = 60_000;

/** `YYYY-MM-DD` of today ± offset days on the clinic clock. */
function dayKey(ctx: SeedContext, offsetDays: number): string {
  const d = ctx.calendarDay(offsetDays);
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

export async function seedRecalls(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  await ensureDefaultRecallRules(tenantId, db);
  const replayed = await replayHistory(ctx);
  const curated = await seedQuietPatients(ctx);
  const swept = await sweepRecalls(new Date());
  await deskWork(ctx, curated);
  const counts = await db.recall.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } });
  const by = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  console.log(
    `     recalls: ${replayed} made replaying the signed work, ${swept.made.missed + swept.made.unbooked + swept.made.lapsed + swept.made.sessions} by the sweep, ${swept.ended} ended long past their window; ${Object.entries(by)
      .map(([k, v]) => `${v} ${k.toLowerCase()}`)
      .join(", ")}.`,
  );
}

/** Recalls were switched on this long ago: older work brought none. */
const REPLAY_DAYS = 200;

/** Every signed procedure and consultation since recalls were switched on, in the order it was signed, through the recall hooks at that moment. */
async function replayHistory(ctx: SeedContext): Promise<number> {
  const { db, tenantId } = ctx;
  const since = new Date(Date.now() - REPLAY_DAYS * DAY);
  const [procedures, consultations] = await Promise.all([
    db.procedure.findMany({ where: { tenantId, status: "SIGNED", deletedAt: null, performedAt: { gte: since } }, select: { id: true, signedAt: true, performedAt: true, signedById: true } }),
    db.consultation.findMany({ where: { tenantId, status: "SIGNED", reviewedAt: { gte: since } }, select: { id: true, reviewedAt: true, createdAt: true, reviewedById: true } }),
  ]);
  const events = [
    ...procedures.map((p) => ({ at: p.signedAt ?? p.performedAt, run: (at: Date) => recallsOnProcedureSigned(tenantId, p.id, { id: p.signedById }, at) })),
    ...consultations.map((c) => ({ at: c.reviewedAt ?? c.createdAt, run: (at: Date) => recallsOnConsultationSigned(tenantId, c.id, { id: c.reviewedById }, at) })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  let made = 0;
  for (const e of events) made += await e.run(e.at);
  return made;
}

interface Curated {
  hoda: string;
  wael: string;
  hassan: string;
  mai: string;
  ola: string;
}

/** Patients whose recalls show on today's list, one for each kind and state. */
async function seedQuietPatients(ctx: SeedContext): Promise<Curated> {
  const { db, tenantId, clinicId } = ctx;
  const at = (offsetDays: number, hour: number) => {
    const d = ctx.calendarDay(offsetDays);
    return ctx.zoned(d.y, d.m, d.d, Math.floor(hour), Math.round((hour % 1) * 60));
  };
  const doctor = (kind: "derm" | "hair") => ctx.users.find((u) => u.kind === kind && u.role === "DOCTOR") ?? ctx.users.find((u) => u.kind === kind)!;
  const reception: SeedUser = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const treatments = new Map((await db.treatment.findMany({ where: { tenantId }, select: { id: true, key: true, name: true } })).map((t) => [t.key, t]));
  const t = (key: string) => treatments.get(key)!;

  let phoneSeq = 55_120_000;
  const patient = async (fullName: string, gender: "MALE" | "FEMALE", opts: { language?: string; registeredDaysAgo: number; diagnosis: string }) => {
    const phone = `+2012${String((phoneSeq += 731)).padStart(8, "0")}`;
    const p = await db.patient.create({
      data: {
        tenantId,
        fullName,
        gender,
        phone,
        whatsapp: phone,
        language: opts.language ?? "ar",
        tags: ["recall-demo"],
        createdAt: new Date(Date.now() - opts.registeredDaysAgo * DAY),
        medicalHistory: { create: { tenantId, diagnoses: [opts.diagnosis] } },
      },
      select: { id: true },
    });
    return p.id;
  };
  /** A signed procedure with its charge, as signing posts it, then its recalls at that moment. */
  const signed = async (patientId: string, key: string, o: { day: number; price: number; doctor: "derm" | "hair" }) => {
    const performedAt = at(o.day, 11);
    const signedAt = new Date(performedAt.getTime() + 90 * MIN);
    const by = doctor(o.doctor).id;
    const proc = await db.procedure.create({
      data: { tenantId, patientId, treatmentId: t(key).id, doctorId: by, performedAt, price: o.price, status: "SIGNED", signedAt, signedById: by, createdById: by, createdAt: new Date(performedAt.getTime() - 5 * DAY) },
      select: { id: true },
    });
    await db.charge.create({ data: { tenantId, patientId, procedureId: proc.id, amount: o.price, description: t(key).name, chargedAt: performedAt, doctorId: by, clinicId, createdById: by, createdAt: signedAt } });
    await db.timelineEvent.create({ data: { tenantId, patientId, kind: "PROCEDURE", title: `${t(key).name} performed`, refId: proc.id, occurredAt: performedAt } });
    await recallsOnProcedureSigned(tenantId, proc.id, { id: by }, signedAt);
    return proc.id;
  };
  const visit = (patientId: string, startsAt: Date, status: "COMPLETED" | "NO_SHOW", kind: Prisma.AppointmentCreateManyInput["kind"], doctorKind: "derm" | "hair", reason: string) =>
    db.appointment.create({
      data: {
        tenantId,
        clinicId,
        patientId,
        doctorId: doctor(doctorKind).id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * MIN),
        status,
        kind,
        reason,
        statusChangedAt: status === "NO_SHOW" ? new Date(startsAt.getTime() + 30 * MIN) : startsAt,
        checkedInAt: status === "COMPLETED" ? new Date(startsAt.getTime() - 5 * MIN) : null,
        createdById: reception.id,
        createdAt: new Date(startsAt.getTime() - 7 * DAY),
      },
      select: { id: true },
    });

  // A transplant 40 days ago: the 1-month review is due (10 days in), the rest ahead.
  const nadia = await patient("Nadia Farouk", "FEMALE", { registeredDaysAgo: 70, diagnosis: "Female pattern hair loss" });
  await signed(nadia, "hair-transplant", { day: -40, price: 62_000, doctor: "hair" });

  // A transplant 110 days ago, seen for the 1-month review; the 3-month review is overdue. The desk wrote to him yesterday.
  const wael = await patient("Wael Hosny", "MALE", { registeredDaysAgo: 140, diagnosis: "Androgenetic alopecia" });
  await signed(wael, "hair-transplant", { day: -110, price: 75_000, doctor: "hair" });
  await visit(wael, at(-79, 13), "COMPLETED", "FOLLOW_UP", "hair", "Transplant review, month 1");

  // Laser one session at a time: sessions 70 and 36 days ago, the third is due.
  const rania = await patient("Rania Selim", "FEMALE", { registeredDaysAgo: 90, diagnosis: "Hirsutism" });
  await signed(rania, "laser-hair-removal", { day: -70, price: 1_800, doctor: "derm" });
  await signed(rania, "laser-hair-removal", { day: -36, price: 1_800, doctor: "derm" });

  // Acne diagnosed 45 days ago: the 6-week review is due. Called yesterday, no answer.
  const hoda = await patient("Hoda Mansour", "FEMALE", { registeredDaysAgo: 60, diagnosis: "Acne vulgaris" });
  const acneVisit = await visit(hoda, at(-45, 12), "COMPLETED", "CONSULTATION", "derm", "Acne breakout");
  const acneConsult = await db.consultation.create({
    data: {
      tenantId,
      patientId: hoda,
      doctorId: doctor("derm").id,
      status: "SIGNED",
      transcript: "Doctor: How long have the spots been there? Patient: About three months, worse before exams.",
      extraction: { symptoms: ["Inflamed papules on the cheeks"], diagnoses: ["Acne vulgaris"], medications: [], tests: [], followUps: ["Review in 6 weeks"] },
      summary: "Acne vulgaris. Topical plan. Review in 6 weeks.",
      reviewedById: doctor("derm").id,
      reviewedAt: at(-45, 12.5),
      createdAt: at(-45, 12),
    },
    select: { id: true },
  });
  await db.visit.create({ data: { tenantId, appointmentId: acneVisit.id, patientId: hoda, doctorId: doctor("derm").id, summary: "Acne vulgaris. Topical plan.", createdAt: at(-45, 12.5) } });
  await recallsOnConsultationSigned(tenantId, acneConsult.id, { id: doctor("derm").id }, at(-45, 12.5));

  // A PRP session booked three days ago, missed; nothing booked since.
  const tamer = await patient("Tamer Fawzy", "MALE", { registeredDaysAgo: 50, diagnosis: "Androgenetic alopecia" });
  const missed = await visit(tamer, at(-3, 15), "NO_SHOW", "PROCEDURE", "hair", "PRP session");
  await db.procedure.create({
    data: { tenantId, patientId: tamer, treatmentId: t("prp-hair").id, doctorId: doctor("hair").id, appointmentId: missed.id, performedAt: at(-3, 15), price: 2_500, status: "PLANNED", createdById: reception.id, createdAt: at(-9, 12) },
  });

  // Botox planned six days ago at the consultation, never booked.
  const lina = await patient("Lina Adel", "FEMALE", { registeredDaysAgo: 30, diagnosis: "Dynamic forehead lines" });
  await db.procedure.create({ data: { tenantId, patientId: lina, treatmentId: t("botox-fillers").id, doctorId: doctor("derm").id, performedAt: at(1, 12), price: 4_500, status: "PLANNED", createdById: doctor("derm").id, createdAt: at(-6, 13) } });

  // Not seen for 13 months, and for 19.
  const sameh = await patient("Sameh Ragab", "MALE", { registeredDaysAgo: 600, diagnosis: "Seborrhoeic dermatitis" });
  await visit(sameh, new Date(at(0, 12).getTime() - 396 * DAY), "COMPLETED", "CONSULTATION", "derm", "Scalp flaking");
  const mervat = await patient("Mervat Saad", "FEMALE", { registeredDaysAgo: 800, diagnosis: "Melasma" });
  await visit(mervat, new Date(at(0, 12).getTime() - 578 * DAY), "COMPLETED", "FOLLOW_UP", "derm", "Melasma review");

  // Due soon: PRP session two (22 days after the first), a transplant's 1-month review in five days.
  const yara = await patient("Yara Khalil", "FEMALE", { registeredDaysAgo: 40, diagnosis: "Telogen effluvium" });
  await signed(yara, "prp-hair", { day: -22, price: 2_500, doctor: "hair" });
  const omar = await patient("Omar Nabil", "MALE", { registeredDaysAgo: 55, diagnosis: "Androgenetic alopecia", language: "en" });
  await signed(omar, "hair-transplant", { day: -25, price: 58_000, doctor: "hair" });

  // A recall the doctor added by hand, to be phoned (no automatic message).
  const dalia = await patient("Dalia Ezz", "FEMALE", { registeredDaysAgo: 120, diagnosis: "Melasma" });
  await addRecall(tenantId, { patientId: dalia, label: "Melasma check after the summer, before the next peel", dueOn: dayKey(ctx, 4), windowDays: 10, channel: "VOICE", note: "Prefers a call" }, { id: doctor("derm").id });

  // A transplant 35 days ago whose review the desk booked from the list, into a free slot in three days.
  const karim = await patient("Karim Lotfy", "MALE", { registeredDaysAgo: 65, diagnosis: "Androgenetic alopecia" });
  await signed(karim, "hair-transplant", { day: -35, price: 70_000, doctor: "hair" });
  const slots = await findFreeSlots(tenantId, { doctorId: doctor("hair").id, date: dayKey(ctx, 3), duration: 30 });
  const slot = slots.suggestions[0];
  if (slot) {
    await createAppointment(tenantId, { patientId: karim, doctorId: doctor("hair").id, clinicId, startsAt: slot.startsAt, endsAt: slot.endsAt, kind: "FOLLOW_UP", reason: "Hair transplant · 1-month review", source: "VOICE" }, { id: reception.id });
  }

  // Worked by the desk below: an acne review declined, a missed visit nobody could reach, a review snoozed.
  const hassan = await patient("Hassan Badr", "MALE", { registeredDaysAgo: 80, diagnosis: "Acne vulgaris" });
  await addRecall(tenantId, { patientId: hassan, label: "Acne vulgaris · 6-week review", dueOn: dayKey(ctx, 0), windowDays: 14 }, { id: doctor("derm").id }, at(-10, 10));
  const mai = await patient("Mai Fikry", "FEMALE", { registeredDaysAgo: 75, diagnosis: "Melasma" });
  await addRecall(tenantId, { patientId: mai, label: "Melasma · 8-week review", dueOn: dayKey(ctx, 0), windowDays: 14 }, { id: doctor("derm").id }, at(-10, 10));
  const ola = await patient("Ola Hamed", "FEMALE", { registeredDaysAgo: 85, diagnosis: "Alopecia areata" });
  await addRecall(tenantId, { patientId: ola, label: "Alopecia areata · injection in 4 weeks", dueOn: dayKey(ctx, 0), windowDays: 7 }, { id: doctor("hair").id }, at(-10, 10));

  // One laser session 160 days ago and never seen since: the sweep below ends his next session as unreachable.
  const fady = await patient("Fady Mourad", "MALE", { registeredDaysAgo: 170, diagnosis: "Pseudofolliculitis barbae" });
  await signed(fady, "laser-hair-removal", { day: -160, price: 1_800, doctor: "derm" });

  // Not seen for a year: recalled 40 days ago (as the sweep made it that morning), phoned two weeks ago, back
  // six days ago. The sweep below ends it as done: a lapsed patient won back.
  const samar = await patient("Samar Wahba", "FEMALE", { registeredDaysAgo: 900, diagnosis: "Melasma" });
  const tz = await getTenantTimezone(tenantId);
  /** The last day the clinic was open (not a Friday) at least `n` days ago, as an offset. */
  const openDaysAgo = (n: number) => {
    for (let d = n; d < n + 7; d += 1) if (ctx.calendarDay(-d).weekday !== 5) return -d;
    return -n;
  };
  const called = at(openDaysAgo(14), 11.5);
  /** The doctor's first free half hour that day (the clinic's own bookings are already in). */
  const freeAt = async (offset: number, kind: "derm" | "hair") => {
    for (let h = 10; h < 20; h += 0.5) {
      const start = at(offset, h);
      const end = new Date(start.getTime() + 30 * MIN);
      const clash = await db.appointment.findFirst({
        where: { tenantId, doctorId: doctor(kind).id, deletedAt: null, status: { notIn: ["CANCELLED", "NO_SHOW", "WAITLISTED"] }, startsAt: { lt: end }, endsAt: { gt: start } },
        select: { id: true },
      });
      if (!clash) return start;
    }
    return at(offset, 20);
  };
  const lastSeen = new Date(at(0, 12).getTime() - 405 * DAY);
  await visit(samar, lastSeen, "COMPLETED", "FOLLOW_UP", "derm", "Melasma review");
  const madeAt = at(-40, 9.2);
  const since = formatDateInTz(lastSeen, tz, { day: "numeric", month: "short", year: "numeric" });
  const lapsed = await db.recall.create({
    data: {
      tenantId,
      patientId: samar,
      kind: "LAPSED",
      label: `No visit since ${since} (12 months)`,
      dueAt: startOfDayInTz(madeAt, tz),
      windowEndAt: endOfDayInTz(addDays(madeAt, 30, tz), tz),
      dedupeKey: `lapsed:${samar}:12:${startOfDayInTz(lastSeen, tz).toISOString().slice(0, 10)}`,
      status: "CONTACTED",
      attempts: 1,
      lastContactAt: called,
      nextContactAt: new Date(called.getTime() + 3 * DAY),
      createdAt: madeAt,
    },
    select: { id: true },
  });
  await db.recallActivity.createMany({
    data: [
      { tenantId, recallId: lapsed.id, kind: "STATUS", outcome: "OPEN", note: `Last seen on ${since}: no visit for 12 months and nothing booked.`, at: madeAt },
      { tenantId, recallId: lapsed.id, kind: "CALL", outcome: "will_book", note: "Back from abroad, will come in next week", byId: reception.id, at: called },
    ],
  });
  await visit(samar, await freeAt(openDaysAgo(6), "derm"), "COMPLETED", "FOLLOW_UP", "derm", "Melasma review after a year away");

  return { hoda, wael, hassan, mai, ola };
}

/** The desk's work of the last days on some of today's recalls, logged as it was done. */
async function deskWork(ctx: SeedContext, c: Curated): Promise<void> {
  const { db, tenantId } = ctx;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const at = (offsetDays: number, hour: number) => {
    const d = ctx.calendarDay(offsetDays);
    return ctx.zoned(d.y, d.m, d.d, Math.floor(hour), Math.round((hour % 1) * 60));
  };
  const startOf = (offsetDays: number) => at(offsetDays, 0);
  const recallOf = async (patientId: string) => db.recall.findFirstOrThrow({ where: { tenantId, patientId, status: { in: ["OPEN", "CONTACTED"] } }, orderBy: { dueAt: "asc" } });
  const log = (recallId: string, kind: "CALL" | "MESSAGE" | "STATUS", outcome: string, when: Date, note: string | null = null) =>
    db.recallActivity.create({ data: { tenantId, recallId, kind, outcome, note, byId: reception.id, at: when } });

  // Hoda: rang yesterday, no answer; try again today.
  const hoda = await recallOf(c.hoda);
  await log(hoda.id, "CALL", "no_answer", at(-1, 11.3), "Rang twice, voicemail full");
  await db.recall.update({ where: { id: hoda.id }, data: { status: "CONTACTED", attempts: 1, lastContactAt: at(-1, 11.3), nextContactAt: startOf(0) } });

  // Wael: the WhatsApp template yesterday, no reply yet.
  const wael = await recallOf(c.wael);
  await log(wael.id, "MESSAGE", "LOGGED", at(-1, 12.5), "أهلاً Wael، معاك Aura Derma & Hair Clinic. ميعاد متابعة زراعة الشعر جه. ابعتلنا اليوم اللي يناسبك وإحنا نحجزلك 🌿");
  await db.recall.update({ where: { id: wael.id }, data: { status: "CONTACTED", attempts: 1, lastContactAt: at(-1, 12.5), nextContactAt: startOf(0) } });

  // Hassan: declined on the phone two days ago, the price.
  const hassan = await recallOf(c.hassan);
  await log(hassan.id, "CALL", "declined", at(-2, 16), "Will continue the cream at home for now");
  await db.recall.update({ where: { id: hassan.id }, data: { status: "DECLINED", declineReason: "price", outcomeNote: "Will continue the cream at home for now", attempts: 1, lastContactAt: at(-2, 16), closedAt: at(-2, 16), closedById: reception.id, nextContactAt: null } });

  // Mai: three tries without an answer, then ended as unreachable.
  const mai = await recallOf(c.mai);
  await log(mai.id, "CALL", "no_answer", at(-6, 11));
  await log(mai.id, "CALL", "no_answer", at(-4, 13));
  await log(mai.id, "CALL", "no_answer", at(-2, 12));
  await log(mai.id, "STATUS", "UNREACHABLE", at(-2, 12.1), "Number switched off three times");
  await db.recall.update({ where: { id: mai.id }, data: { status: "UNREACHABLE", outcomeNote: "Number switched off three times", attempts: 3, lastContactAt: at(-2, 12), closedAt: at(-2, 12.1), closedById: reception.id, nextContactAt: null } });

  // Ola: travelling, asked to be called after next week.
  const ola = await recallOf(c.ola);
  const until = startOf(8);
  await log(ola.id, "STATUS", "SNOOZED", at(-1, 15), "Travelling until next week");
  await db.recall.update({ where: { id: ola.id }, data: { status: "SNOOZED", snoozedUntil: until, nextContactAt: until } });
}
