import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { formatDateTimeInTz } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { CHANNELS } from "@/modules/crm/shared";
import type { TemplateDTO, TemplateVarsDTO } from "./dto";

/**
 * Reply templates for the reception inbox. A template body carries
 * `{{name}}`, `{{clinic}}`, `{{doctor}}`, `{{date}}` and `{{link}}`
 * placeholders that the inbox fills from the thread's context when the
 * template is inserted into the reply box; anything it cannot fill stays
 * visible so the receptionist completes it.
 */
export const TEMPLATE_PLACEHOLDERS = ["name", "clinic", "doctor", "date", "link"] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export type TemplateVars = Partial<Record<TemplatePlaceholder, string | null | undefined>>;

/** Replace every `{{ key }}` whose value is known; unknown or empty ones are left in place. */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (whole, key: string) => {
    const value = vars[key as TemplatePlaceholder];
    return value ? String(value) : whole;
  });
}

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

export interface DefaultTemplate {
  key: string;
  name: string;
  language: "ar" | "en";
  category: string;
  body: string;
}

/** The templates every demo clinic starts with (seeded; owners edit them). */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    key: "booking-confirmation-ar",
    name: "Booking confirmation (AR)",
    language: "ar",
    category: "booking",
    body: "أهلاً {{name}} 👋 تم تأكيد حجزك في {{clinic}} مع {{doctor}} يوم {{date}}. لو احتجت تغيير الميعاد ابعتلنا هنا وإحنا نظبطه.",
  },
  {
    key: "booking-confirmation-en",
    name: "Booking confirmation (EN)",
    language: "en",
    category: "booking",
    body: "Hi {{name}}, your appointment at {{clinic}} with {{doctor}} is confirmed for {{date}}. Reply here if you need to change the time.",
  },
  {
    key: "price-reply-ar",
    name: "Price reply (AR)",
    language: "ar",
    category: "price",
    body: "أهلاً {{name}} 🌿 السعر النهائي بيتحدد بعد الكشف لأنه بيعتمد على حالتك، لكن نقدر نبعتلك نطاق الأسعار دلوقتي. تحب نحجزلك استشارة مع {{doctor}}؟",
  },
  {
    key: "price-reply-en",
    name: "Price reply (EN)",
    language: "en",
    category: "price",
    body: "Hi {{name}}, the final price is confirmed at the consultation because it depends on your case, but we can share the price range now. Shall we book you a consultation with {{doctor}}?",
  },
  {
    key: "follow-up-nudge-ar",
    name: "Follow-up nudge (AR)",
    language: "ar",
    category: "follow-up",
    body: "أهلاً {{name}}، معاك {{clinic}}. حابين نطمن إن كل حاجة واضحة بخصوص استفسارك. لو عندك أي سؤال أو حابب تحجز، إحنا هنا 🙏",
  },
  {
    key: "follow-up-nudge-en",
    name: "Follow-up nudge (EN)",
    language: "en",
    category: "follow-up",
    body: "Hi {{name}}, this is {{clinic}}. Just checking whether you have any questions about your enquiry — happy to help or to book you in whenever suits you.",
  },
  {
    key: "intake-link-ar",
    name: "Intake link (AR)",
    language: "ar",
    category: "intake",
    body: "أهلاً {{name}} 🙌 قبل زيارتك يوم {{date}}، من فضلك املأ نموذج البيانات من هنا: {{link}} — بياخد دقيقتين وبيوفر وقتك في العيادة.",
  },
  {
    key: "intake-link-en",
    name: "Intake link (EN)",
    language: "en",
    category: "intake",
    body: "Hi {{name}}, before your visit on {{date}} please fill in your details here: {{link}} — it takes two minutes and saves time at the clinic.",
  },
];

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const TemplateInput = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use letters, digits and dashes"),
  name: zText(120).min(1, "Name is required"),
  language: z.enum(["ar", "en"]).default("ar"),
  body: zText(2000).min(1, "Body is required"),
  category: zOptionalText(40),
  channel: z.preprocess(blankToUndefined, z.enum(CHANNELS).optional()),
  active: z.boolean().default(true),
});
export type TemplateInput = z.input<typeof TemplateInput>;

export const TemplateUpdateInput = z.object({
  name: zText(120).min(1).optional(),
  language: z.enum(["ar", "en"]).optional(),
  body: zText(2000).min(1).optional(),
  category: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), zText(40).nullable().optional()),
  channel: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.enum(CHANNELS).nullable().optional()),
  active: z.boolean().optional(),
});

function toDTO(row: { id: string; key: string; name: string; language: string; body: string; channel: string | null; category: string | null; active: boolean }): TemplateDTO {
  return { id: row.id, key: row.key, name: row.name, language: row.language, body: row.body, channel: row.channel as TemplateDTO["channel"], category: row.category, active: row.active };
}

export async function listTemplates(tenantId: string, opts: { includeInactive?: boolean } = {}): Promise<TemplateDTO[]> {
  const rows = await db.messageTemplate.findMany({
    where: { tenantId, ...(opts.includeInactive ? {} : { active: true }) },
    orderBy: [{ category: "asc" }, { language: "asc" }, { name: "asc" }],
    take: 200,
  });
  return rows.map(toDTO);
}

export class DuplicateTemplateError extends Error {
  readonly status = 409;
  readonly code = "duplicate_key";
  constructor() {
    super("A template with this key already exists.");
    this.name = "DuplicateTemplateError";
  }
}

export async function createTemplate(tenantId: string, rawInput: unknown, actor: Actor = {}): Promise<TemplateDTO> {
  const input = TemplateInput.parse(rawInput);
  const existing = await db.messageTemplate.findUnique({ where: { tenantId_key: { tenantId, key: input.key } }, select: { id: true } });
  if (existing) throw new DuplicateTemplateError();
  const row = await db.messageTemplate.create({
    data: { tenantId, key: input.key, name: input.name, language: input.language, body: input.body, category: input.category ?? null, channel: input.channel ?? null, active: input.active },
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "messaging.template.create", entity: "MessageTemplate", entityId: row.id, after: input });
  return toDTO(row);
}

export async function updateTemplate(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}): Promise<TemplateDTO> {
  const patch = Object.fromEntries(Object.entries(TemplateUpdateInput.parse(rawInput)).filter(([, v]) => v !== undefined));
  const before = await db.messageTemplate.findFirst({ where: { id, tenantId } });
  if (!before) throw new TenantScopeError("conversation", id);
  const row = await db.messageTemplate.update({ where: { id, tenantId }, data: patch });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "messaging.template.update",
    entity: "MessageTemplate",
    entityId: id,
    before: { name: before.name, body: before.body, active: before.active, language: before.language },
    after: patch,
  });
  return toDTO(row);
}

/**
 * Placeholder values for a thread: the contact's first name, the clinic, and
 * the doctor and date of the patient's next appointment when there is one.
 */
export async function templateContext(tenantId: string, conversationId: string): Promise<TemplateVarsDTO> {
  const [tenant, conversation] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    db.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { contactName: true, patientId: true, patient: { select: { fullName: true } }, lead: { select: { fullName: true } } },
    }),
  ]);
  const fullName = conversation?.patient?.fullName ?? conversation?.lead?.fullName ?? conversation?.contactName ?? "";
  let doctor = "";
  let date = "";
  if (conversation?.patientId) {
    const next = await db.appointment.findFirst({
      where: { tenantId, patientId: conversation.patientId, ...notDeleted, startsAt: { gte: new Date() }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true, doctorId: true },
    });
    if (next) {
      const tz = await getTenantTimezone(tenantId);
      date = formatDateTimeInTz(next.startsAt, tz);
      if (next.doctorId) {
        const u = await db.user.findFirst({ where: { id: next.doctorId, tenantId }, select: { fullName: true, email: true } });
        doctor = u?.fullName ?? u?.email ?? "";
      }
    }
  }
  return {
    name: fullName.split(/\s+/)[0] ?? "",
    clinic: tenant?.name ?? "",
    doctor,
    date,
    link: (env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, ""),
  };
}
