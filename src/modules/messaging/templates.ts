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
import { TEMPLATE_PLACEHOLDERS } from "./placeholders";

/**
 * Reply templates for the reception inbox. A template body carries
 * `{{name}}`, `{{clinic}}`, `{{doctor}}`, `{{date}}` and `{{link}}`
 * placeholders that the inbox fills from the thread's context when the
 * template is inserted into the reply box; anything it cannot fill stays
 * visible so the receptionist completes it (a reply that still carries one
 * is refused, see service.ts).
 */
export { TEMPLATE_PLACEHOLDERS, renderTemplate, unfilledPlaceholders, type TemplatePlaceholder, type TemplateVars } from "./placeholders";

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

export { DEFAULT_TEMPLATES, type DefaultTemplate } from "./default-templates";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** A template body may only use the placeholders the inbox knows how to fill. */
const zTemplateBody = zText(2000)
  .min(1, "Body is required")
  .superRefine((body, ctx) => {
    const unknown = [...body.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)]
      .map((m) => m[1]!.toLowerCase())
      .filter((key) => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(key));
    if (unknown.length) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown placeholder {{${unknown[0]}}}: use ${TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}`,
      });
    }
  });

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
  body: zTemplateBody,
  category: zOptionalText(40),
  channel: z.preprocess(blankToUndefined, z.enum(CHANNELS).optional()),
  active: z.boolean().default(true),
});
export type TemplateInput = z.input<typeof TemplateInput>;

export const TemplateUpdateInput = z.object({
  name: zText(120).min(1).optional(),
  language: z.enum(["ar", "en"]).optional(),
  body: zTemplateBody.optional(),
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
