import type { Prisma } from "@prisma/client";
import { allergyClass } from "./clinical";
import type { SeedContext } from "./index";
import { makeRandom } from "./util";

/**
 * Dictated notes on about fifteen of today's and tomorrow's appointments:
 * what reception heard on the phone and what the doctor wants to remember,
 * in Arabic and English, with the recording length, authored by the
 * receptionist or the booking's doctor, each mirrored as an AUDIO event on the
 * patient timeline (exactly what the notes API writes). Each note fits its
 * patient: gendered wording for their sex, an allergy only when it is on
 * file, a treatment only when it is theirs.
 */

/**
 * A note that only fits some patients: their sex (the Arabic and English
 * wording is gendered), an allergy on file, their condition, or Arabic as
 * their language. Notes without constraints fit anyone.
 */
interface NoteText {
  text: string;
  sex?: "FEMALE" | "MALE";
  /** The patient has this allergy on file (the note mentions it). */
  allergy?: "penicillin";
  /** The patient's condition key in the core seed (fue, aga, acne, melasma…). */
  conds?: readonly string[];
  /** Only for patients whose language is Arabic. */
  arabicOnly?: boolean;
}

const TOPICAL = ["acne", "melasma", "eczema", "psoriasis", "rosacea"] as const;
const HAIR = ["aga", "fue"] as const;
const STEROID = ["eczema", "psoriasis", "alopecia-areata"] as const;
const PEEL = ["acne", "melasma", "rosacea"] as const;

const RECEPTION_AR: NoteText[] = [
  { sex: "FEMALE", text: "المريضة اتصلت وقالت إنها هتتأخر عشر دقايق تقريباً، ومعاها نتايج التحاليل اللي طلبها الدكتور." },
  { sex: "MALE", text: "المريض اتصل وقال إنه هيتأخر عشر دقايق تقريباً، ومعاه نتايج التحاليل اللي طلبها الدكتور." },
  { sex: "MALE", allergy: "penicillin", text: "طلب يحجز بعد الساعة ٥ المرة الجاية عشان الشغل. عنده حساسية من البنسلين، اتأكدوا إنها مكتوبة في الملف." },
  { sex: "FEMALE", allergy: "penicillin", text: "طلبت تحجز بعد الساعة ٥ المرة الجاية عشان الشغل. عندها حساسية من البنسلين، اتأكدوا إنها مكتوبة في الملف." },
  { sex: "MALE", text: "طلب يحجز بعد الساعة ٥ المرة الجاية عشان الشغل." },
  { sex: "FEMALE", text: "طلبت تحجز بعد الساعة ٥ المرة الجاية عشان الشغل." },
  { text: "اتأكدت من الموعد على الواتساب. الدفعة المقدمة اتدفعت، والباقي عند الوصول." },
  { sex: "FEMALE", text: "جاية بصحبة والدتها، محتاجين تقرير مكتوب للتأمين بعد الكشف." },
  { sex: "MALE", text: "جاي بصحبة والدته، محتاجين تقرير مكتوب للتأمين بعد الكشف." },
  { sex: "MALE", conds: TOPICAL, text: "قال إن الكريم عمل احمرار بسيط ووقّفه من يومين. الدكتور عايز يشوف الصور قبل الكشف." },
  { sex: "FEMALE", conds: TOPICAL, text: "قالت إن الكريم عمل احمرار بسيط ووقّفته من يومين. الدكتور عايز يشوف الصور قبل الكشف." },
  { sex: "FEMALE", text: "سألت لو ممكن الجلسة تبقى أقصر عشان عندها شغل الساعة ٣. ممكن نبدأ بدري لو في مكان." },
  { sex: "MALE", text: "سأل لو ممكن الجلسة تبقى أقصر عشان عنده شغل الساعة ٣. ممكن نبدأ بدري لو في مكان." },
  { sex: "MALE", arabicOnly: true, text: "بيفضّل التواصل بالعربي بس، ومش بيرد على المكالمات من رقم غريب — ابعتوا رسالة الأول." },
  { sex: "FEMALE", arabicOnly: true, text: "بتفضّل التواصل بالعربي بس، ومش بترد على المكالمات من رقم غريب — ابعتوا رسالة الأول." },
];

const RECEPTION_EN: NoteText[] = [
  { text: "Patient called to confirm; will be about ten minutes late and is bringing the lab results." },
  { allergy: "penicillin", text: "Asked for the earliest slot next time because of work. Reminder: allergic to penicillin, already on the file." },
  { text: "Asked for the earliest slot next time because of work." },
  { text: "Deposit for the package is paid; wants a receipt at the desk. Prefers WhatsApp for reminders." },
  { sex: "FEMALE", text: "Coming with her sister who will translate. Needs a written report for the insurer after the visit." },
  { sex: "MALE", text: "Coming with his sister who will translate. Needs a written report for the insurer after the visit." },
  { conds: TOPICAL, text: "Mentioned mild itching on the phone and stopped the cream two days ago; the doctor wants to see the photos first." },
  { sex: "FEMALE", text: "Could we keep the visit short? She has a meeting at 3 pm. Fine to start early if the room is free." },
  { sex: "MALE", text: "Could we keep the visit short? He has a meeting at 3 pm. Fine to start early if the room is free." },
  { conds: ["laser-hr", "melasma"], text: "Second visit this month; asked whether the follow-up can be combined with the laser session." },
];

const DOCTOR_AR: NoteText[] = [
  { conds: HAIR, text: "تذكير لنفسي: نراجع صور الشهر الأول قبل الجلسة، ولو الكثافة مش مرضية نناقش جلسة PRP إضافية." },
  { sex: "MALE", conds: HAIR, text: "المريض عنده تاريخ عائلي قوي. لازم نسأل عن الأدوية الحالية ونعيد تقييم الجرعة." },
  { sex: "FEMALE", conds: HAIR, text: "المريضة عندها تاريخ عائلي قوي. لازم نسأل عن الأدوية الحالية ونعيد تقييم الجرعة." },
  { sex: "MALE", conds: STEROID, text: "الحالة اتحسنت على الروتين الحالي حسب الصور اللي بعتها. نفكر في تقليل الكورتيزون تدريجياً." },
  { sex: "FEMALE", conds: STEROID, text: "الحالة اتحسنت على الروتين الحالي حسب الصور اللي بعتتها. نفكر في تقليل الكورتيزون تدريجياً." },
  { conds: PEEL, text: "لو الاحمرار لسه موجود نعمل اختبار حساسية قبل أي تقشير. مش هنبدأ الجلسة النهاردة لو في التهاب." },
  { text: "نراجع الاستجابة من آخر زيارة ونحدّث الخطة، وناخد صور قبل وبعد جلسة النهاردة." },
];

const DOCTOR_EN: NoteText[] = [
  { conds: ["fue"], text: "Before the review: compare the donor-area photos with day 7 and check the crusting is gone before any PRP." },
  { conds: [...HAIR, "alopecia-areata"], text: "Strong family history. Ask about current medication and re-assess the dose; order ferritin and TSH if not done." },
  { sex: "FEMALE", conds: STEROID, text: "Improving on the current routine judging by the photos she sent; consider tapering the steroid this visit." },
  { sex: "MALE", conds: STEROID, text: "Improving on the current routine judging by the photos he sent; consider tapering the steroid this visit." },
  { conds: PEEL, text: "If the redness persists do a patch test first; no peel today while the skin is inflamed." },
  { conds: ["acne"], text: "Check adherence to the nightly gel and sunscreen; discuss the chemical peel course if the marks persist." },
  { text: "Review the response since the last visit and update the plan; photos before and after today's session." },
];

interface NotePatient {
  gender: string;
  language: string;
  allergies: string[];
  condKey: string | null;
}

/** The notes of a pool that fit this patient (the unconstrained ones when nothing more specific does). */
export function notesFor(pool: readonly NoteText[], p: NotePatient): NoteText[] {
  const penicillin = p.allergies.some((a) => allergyClass(a) === "penicillin");
  const fits = pool.filter(
    (n) =>
      (!n.sex || n.sex === p.gender) &&
      (!n.allergy || (n.allergy === "penicillin" && penicillin)) &&
      (!n.conds || (p.condKey !== null && n.conds.includes(p.condKey))) &&
      (!n.arabicOnly || p.language === "ar"),
  );
  return fits.length ? fits : pool.filter((n) => !n.sex && !n.allergy && !n.conds && !n.arabicOnly);
}

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
      patient: { select: { language: true, gender: true, medicalHistory: { select: { allergies: true } } } },
    },
  });
  if (!appointments.length) return;

  const reception = ctx.users.filter((u) => u.role === "RECEPTIONIST");
  const doctors = ctx.users.filter((u) => u.role === "DOCTOR" || (u.role === "CLINIC_OWNER" && u.kind));
  const fallbackAuthors = reception.length ? reception : doctors;
  if (!fallbackAuthors.length) return;

  const chosen = shuffle(appointments, r.rand).slice(0, 15);
  const condOf = new Map(ctx.patients.map((p) => [p.id, p.condKey]));
  const now = Date.now();
  const notes: Prisma.AppointmentNoteCreateManyInput[] = [];
  const events: Prisma.TimelineEventCreateManyInput[] = [];

  for (const appt of chosen) {
    const allergies = appt.patient.medicalHistory?.allergies;
    const who: NotePatient = {
      gender: appt.patient.gender,
      language: appt.patient.language,
      allergies: Array.isArray(allergies) ? allergies.filter((a): a is string => typeof a === "string") : [],
      condKey: condOf.get(appt.patientId) ?? null,
    };
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
      const body = r.pick(notesFor(pool, who)).text;
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
