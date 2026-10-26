import type { Prisma } from "@prisma/client";
import type { SeedContext } from "./index";
import { makeRandom } from "./util";

/**
 * Dictated notes on about fifteen of today's and tomorrow's appointments:
 * what reception heard on the phone and what the doctor wants to remember,
 * in Arabic and English, with the recording length, authored by the
 * receptionist or the booking's doctor, each mirrored as an AUDIO event on the
 * patient timeline (exactly what the notes API writes).
 */

const RECEPTION_AR = [
  "المريضة اتصلت وقالت إنها هتتأخر عشر دقايق تقريباً، ومعاها نتايج التحاليل اللي طلبها الدكتور.",
  "طلب يحجز بعد الساعة ٥ المرة الجاية عشان الشغل. عنده حساسية من البنسلين، اتأكدوا إنها مكتوبة في الملف.",
  "اتأكدت من الموعد على الواتساب. الدفعة المقدمة لجلسة الليزر اتدفعت، الباقي عند الوصول.",
  "جاية بصحبة والدتها، محتاجين تقرير مكتوب للتأمين بعد الكشف.",
  "قال إن الكريم عمل احمرار بسيط ووقّفه من يومين. الدكتور عايز يشوف الصور قبل الكشف.",
  "سألت لو ممكن الجلسة تبقى أقصر عشان عندها شغل الساعة ٣. ممكن نبدأ بدري لو في مكان.",
  "بيفضّل التواصل بالعربي بس، ومش بيرد على المكالمات من رقم غريب — ابعتوا رسالة الأول.",
];

const RECEPTION_EN = [
  "Patient called to confirm; will be about ten minutes late and is bringing the lab results.",
  "Asked for the earliest slot next time because of work. Reminder: allergic to penicillin, already on the file.",
  "Deposit for the package is paid; wants a receipt at the desk. Prefers WhatsApp for reminders.",
  "Coming with her sister who will translate. Needs a written report for the insurer after the visit.",
  "Mentioned mild itching on the phone and stopped the cream two days ago; the doctor wants to see the photos first.",
  "Could we keep the visit short? She has a meeting at 3 pm. Fine to start early if the room is free.",
  "Second visit this month; asked whether the follow-up can be combined with the laser session.",
];

const DOCTOR_AR = [
  "تذكير لنفسي: نراجع صور الشهر الأول قبل الجلسة، ولو الكثافة مش مرضية نناقش جلسة PRP إضافية.",
  "المريض عنده تاريخ عائلي قوي. لازم نسأل عن الأدوية الحالية ونعيد تقييم الجرعة.",
  "الحالة اتحسنت على الروتين الحالي حسب الصور اللي بعتها. نفكر في تقليل الكورتيزون تدريجياً.",
  "لو الاحمرار لسه موجود نعمل اختبار حساسية قبل أي تقشير. مش هنبدأ الجلسة النهاردة لو في التهاب.",
];

const DOCTOR_EN = [
  "Before the review: compare the donor-area photos with day 7 and check the crusting is gone before any PRP.",
  "Strong family history. Ask about current medication and re-assess the dose; order ferritin and TSH if not done.",
  "Improving on the current routine judging by the photos she sent; consider tapering the steroid this visit.",
  "If the redness persists do a patch test first; no peel today while the skin is inflamed.",
  "Check adherence to the nightly gel and sunscreen; discuss the chemical peel course if the marks persist.",
];

/** Soft shuffle on the module's own deterministic stream. */
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Dictated notes on some of today's and tomorrow's appointments. */
export async function seedAppointmentNotes(ctx: SeedContext): Promise<void> {
  const r = makeRandom(41);
  const { db, tenantId } = ctx;
  const today = ctx.calendarDay(0);
  const tomorrow = ctx.calendarDay(1);
  const from = ctx.zoned(today.y, today.m, today.d, 0, 0);
  const to = ctx.zoned(tomorrow.y, tomorrow.m, tomorrow.d, 23, 59);

  // Re-runs rebuild the same notes: drop what an earlier run of this module left.
  await db.appointmentNote.deleteMany({ where: { tenantId } });
  await db.timelineEvent.deleteMany({
    where: { tenantId, kind: "AUDIO", title: { in: ["Dictated note on the appointment", "Typed note on the appointment"] } },
  });

  const appointments = await db.appointment.findMany({
    where: { tenantId, deletedAt: null, startsAt: { gte: from, lte: to }, status: { notIn: ["CANCELLED"] } },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      patientId: true,
      doctorId: true,
      startsAt: true,
      createdAt: true,
      patient: { select: { language: true } },
    },
  });
  if (!appointments.length) return;

  const reception = ctx.users.filter((u) => u.role === "RECEPTIONIST");
  const doctors = ctx.users.filter((u) => u.role === "DOCTOR" || (u.role === "CLINIC_OWNER" && u.kind));
  const fallbackAuthors = reception.length ? reception : doctors;
  if (!fallbackAuthors.length) return;

  const chosen = shuffle(appointments, r.rand).slice(0, 15);
  const now = Date.now();
  const notes: Prisma.AppointmentNoteCreateManyInput[] = [];
  const events: Prisma.TimelineEventCreateManyInput[] = [];

  for (const appt of chosen) {
    const count = r.chance(0.3) ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const byDoctor = i === 1 || r.chance(0.35);
      const doctor = doctors.find((d) => d.id === appt.doctorId) ?? (doctors.length ? r.pick(doctors) : null);
      const author = byDoctor && doctor ? doctor : r.pick(fallbackAuthors);
      const arabic = appt.patient.language === "ar" ? r.chance(0.8) : r.chance(0.25);
      const pool = byDoctor && doctor ? (arabic ? DOCTOR_AR : DOCTOR_EN) : arabic ? RECEPTION_AR : RECEPTION_EN;
      const kind = r.chance(0.85) ? "DICTATION" : "TEXT";
      // Dictated between a few days and half an hour before the slot, never after now.
      const minutesBefore = r.between(30, 72 * 60);
      const at = Math.min(now - r.between(2, 90) * 60_000, appt.startsAt.getTime() - minutesBefore * 60_000);
      const createdAt = new Date(Math.max(at, appt.createdAt.getTime() + 60_000));
      const body = r.pick(pool);
      notes.push({
        tenantId,
        appointmentId: appt.id,
        patientId: appt.patientId,
        kind,
        body,
        language: arabic ? "ar" : "en",
        durationSeconds: kind === "DICTATION" ? r.between(8, 75) : null,
        authorId: author.id,
        createdAt,
      });
      events.push({
        tenantId,
        patientId: appt.patientId,
        kind: "AUDIO",
        title: kind === "DICTATION" ? "Dictated note on the appointment" : "Typed note on the appointment",
        body,
        refId: appt.id,
        occurredAt: createdAt,
      });
    }
  }

  await db.appointmentNote.createMany({ data: notes });
  await db.timelineEvent.createMany({ data: events });
}
