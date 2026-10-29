import type { MessageDelivery, RecallKind } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { env } from "@/lib/env";
import { formatDateInTz, startOfDayInTz } from "@/lib/time";
import { DEFAULT_TEMPLATES } from "@/modules/messaging/default-templates";
import { renderTemplate, unfilledPlaceholders } from "@/modules/messaging/placeholders";
import { sendPatientMessage } from "@/modules/messaging/outbound";

/**
 * The WhatsApp message a recall sends: the clinic's template for its kind in
 * the patient's language (Settings → reply templates, `recall-<kind>-<ar|en>`;
 * the built-in text when the clinic has none), with {{treatment}} saying what
 * the patient is due for and {{date}} when, in that language.
 */

type Language = "ar" | "en";

const KIND_SLUG: Record<RecallKind, string> = { REVIEW: "review", NEXT_SESSION: "session", UNBOOKED: "unbooked", MISSED: "missed", LAPSED: "lapsed" };

export const recallTemplateKey = (kind: RecallKind, language: Language) => `recall-${KIND_SLUG[kind]}-${language}`;

/** The default treatments in Arabic, for the patient's message (another treatment keeps its own name). */
const ARABIC_TREATMENT: Record<string, string> = {
  "hair-transplant": "زراعة الشعر",
  "prp-hair": "البلازما للشعر",
  acne: "علاج حب الشباب",
  pigmentation: "علاج التصبغات",
  "laser-hair-removal": "إزالة الشعر بالليزر",
  "botox-fillers": "البوتوكس والفيلر",
  "general-dermatology": "الجلدية",
};

export interface RecallForMessage {
  kind: RecallKind;
  stage: number | null;
  dueAt: Date;
  treatment: { key: string; name: string } | null;
  procedure: { stages: number } | null;
  sessionsInCourse?: number | null;
  /** MISSED: when the missed visit was. */
  missedAt?: Date | null;
  patient: { fullName: string; language: string };
}

export function languageOf(code: string | null | undefined): Language {
  return code === "en" ? "en" : "ar";
}

/** What the recall is for, as the patient reads it. */
export function treatmentPhrase(r: RecallForMessage, language: Language): string {
  const name = r.treatment ? (language === "ar" ? (ARABIC_TREATMENT[r.treatment.key] ?? r.treatment.name) : r.treatment.name.toLowerCase()) : null;
  const of = r.procedure && r.procedure.stages > 1 ? r.procedure.stages : (r.sessionsInCourse ?? null);
  switch (r.kind) {
    case "NEXT_SESSION":
      if (language === "ar") return `جلسة ${name ?? "العلاج"}${r.stage ? ` رقم ${r.stage}${of ? ` من ${of}` : ""}` : ""}`;
      return `${name ?? "treatment"} session${r.stage ? ` ${r.stage}${of ? ` of ${of}` : ""}` : ""}`;
    case "REVIEW":
      if (language === "ar") return name ? `متابعة ${name}` : "زيارة المتابعة";
      return name ? `${name} review` : "follow-up visit";
    case "UNBOOKED":
      return name ?? (language === "ar" ? "العلاج" : "treatment");
    default:
      return name ?? "";
  }
}

/** When it is due ("on Tuesday 12 November", or "now" once the day has come), or when the visit was missed. */
export function datePhrase(r: RecallForMessage, timezone: string, language: Language, now: Date): string {
  const locale = language === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
  const on = (d: Date) => formatDateInTz(d, timezone, { weekday: "long", day: "numeric", month: "long" }, locale).replace("،", "");
  if (r.kind === "MISSED") {
    const at = r.missedAt ?? r.dueAt;
    return language === "ar" ? `يوم ${on(at)}` : `on ${on(at)}`;
  }
  if (r.dueAt.getTime() <= startOfDayInTz(now, timezone).getTime()) return language === "ar" ? "جه" : "now";
  return language === "ar" ? `يوم ${on(r.dueAt)}` : `on ${on(r.dueAt)}`;
}

export interface RenderedRecallMessage {
  body: string;
  templateKey: string;
  language: Language;
  /** Placeholders the clinic's template uses that nothing fills (the message is not sent). */
  unfilled: string[];
}

export async function renderRecallMessage(tenantId: string, r: RecallForMessage, ctx: { timezone: string; now: Date }): Promise<RenderedRecallMessage> {
  const language = languageOf(r.patient.language);
  const templateKey = recallTemplateKey(r.kind, language);
  const [template, tenant] = await Promise.all([
    db.messageTemplate.findFirst({ where: { tenantId, key: templateKey, active: true }, select: { body: true } }),
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);
  const body = template?.body ?? DEFAULT_TEMPLATES.find((t) => t.key === templateKey)?.body ?? "";
  const rendered = renderTemplate(body, {
    name: r.patient.fullName.trim().split(/\s+/)[0] ?? r.patient.fullName,
    clinic: tenant?.name ?? "",
    treatment: treatmentPhrase(r, language),
    date: datePhrase(r, ctx.timezone, language, ctx.now),
    link: (env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, ""),
  });
  // Any {{…}} left holds the message back: a placeholder a recall cannot fill, or one no template should carry.
  const left = [...rendered.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]!.toLowerCase());
  return { body: rendered.trim(), templateKey, language, unfilled: [...new Set([...unfilledPlaceholders(rendered), ...left])] };
}

/** Load what a recall's message needs. */
export async function recallForMessage(tenantId: string, recallId: string) {
  const r = await db.recall.findFirst({
    where: { id: recallId, tenantId },
    select: {
      id: true,
      kind: true,
      stage: true,
      dueAt: true,
      status: true,
      appointmentId: true,
      patientId: true,
      treatment: { select: { key: true, name: true } },
      procedure: { select: { stages: true } },
      rule: { select: { sessions: true } },
      patient: { select: { fullName: true, language: true, phone: true, whatsapp: true, deletedAt: true, reminderConsent: true, marketingConsent: true } },
    },
  });
  if (!r) return null;
  const missed = r.kind === "MISSED" && r.appointmentId ? await db.appointment.findFirst({ where: { id: r.appointmentId, tenantId, ...notDeleted }, select: { startsAt: true } }) : null;
  return { ...r, sessionsInCourse: r.rule?.sessions ?? null, missedAt: missed?.startsAt ?? null };
}

export interface SentRecallMessage {
  messageId: string;
  conversationId: string;
  delivery: MessageDelivery;
  body: string;
}

/** Send the recall's message to the patient on WhatsApp (logged on their conversation when no channel is connected). */
export async function deliverRecallMessage(
  tenantId: string,
  r: NonNullable<Awaited<ReturnType<typeof recallForMessage>>>,
  rendered: RenderedRecallMessage,
  opts: { authorId: string | null; step?: number },
): Promise<SentRecallMessage> {
  const sent = await sendPatientMessage(tenantId, {
    patientId: r.patientId,
    body: rendered.body,
    channel: "WHATSAPP",
    templateKey: rendered.templateKey,
    authorId: opts.authorId,
    author: opts.authorId ? "HUMAN" : "SYSTEM",
    meta: { recallId: r.id, kind: "recall", ...(opts.step ? { step: opts.step } : {}) },
  });
  return { ...sent, body: rendered.body };
}
