import { Prisma, type RecallRule } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantUser, TenantScopeError } from "@/lib/tenant-scope";
import { zText } from "@/lib/validation";
import { normalizeText } from "@/modules/assistant/text";
import { listTreatments, requireTenantTreatment } from "@/modules/treatments/service";
import { RECALL_CHANNELS, RECALL_OWNER_ROLES } from "./constants";
import type { RecallRuleDTO } from "./dto";

/**
 * Recall rules: what brings a patient back, and when.
 *
 *  - SESSIONS: a course. After each session the next one is due `dueDays[0]`
 *    days later and on time for `windowDays` more ("laser every 4–6 weeks":
 *    28 and 14). A course sold as a package counts its own sessions; one
 *    recorded a session at a time is a course of `sessions`.
 *  - REVIEWS: the patient is seen again `dueDays` days after the treatment
 *    ("transplant reviews at months 1, 3, 6 and 12"), each on time for
 *    `windowDays`.
 *
 * A rule is triggered by a procedure of its treatment, or by a signed
 * consultation whose diagnoses contain one of its words. Owner and channel
 * say who works the recalls it makes and how the patient is reached. A
 * change applies to the recalls made from then on; recalls already made keep
 * their dates. Every clinic starts with the four rules below.
 */

type Client = Prisma.TransactionClient;

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

export interface DefaultRecallRule {
  treatmentKey: string;
  name: string;
  kind: "SESSIONS" | "REVIEWS";
  dueDays: number[];
  windowDays: number;
  sessions: number | null;
  diagnosisTerms: string[];
}

/** The plan's examples: laser every 4–6 weeks, PRP monthly ×3, transplant reviews at months 1, 3, 6, 12, acne review at 6–8 weeks. */
export const DEFAULT_RECALL_RULES: readonly DefaultRecallRule[] = [
  { treatmentKey: "laser-hair-removal", name: "Laser hair removal: next session every 4–6 weeks", kind: "SESSIONS", dueDays: [28], windowDays: 14, sessions: 6, diagnosisTerms: [] },
  { treatmentKey: "prp-hair", name: "PRP: monthly, 3 sessions", kind: "SESSIONS", dueDays: [30], windowDays: 7, sessions: 3, diagnosisTerms: [] },
  { treatmentKey: "hair-transplant", name: "Hair transplant: reviews at months 1, 3, 6 and 12", kind: "REVIEWS", dueDays: [30, 91, 182, 365], windowDays: 14, sessions: null, diagnosisTerms: [] },
  { treatmentKey: "acne", name: "Acne: review at 6–8 weeks", kind: "REVIEWS", dueDays: [42], windowDays: 14, sessions: null, diagnosisTerms: ["acne", "حب الشباب"] },
];

/** When a course has no session rule: the next session four weeks on, on time for two more. */
export const FALLBACK_SESSION_DAYS = 28;
export const FALLBACK_SESSION_WINDOW = 14;

/** Diagnosis words are matched on normalised text (case, Arabic letter forms and digits folded). */
export const normaliseTerm = (s: string) => normalizeText(s).replace(/\s+/g, " ").trim();

/**
 * Create the default rules for a clinic that has none yet (never again once
 * it has any: an owner who switched them all off keeps them off). Serialised
 * per clinic so two first signings cannot both create them. Returns how many
 * were created.
 */
export async function ensureDefaultRecallRules(tenantId: string, client: Client = db): Promise<number> {
  const run = async (tx: Client) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recall-rules:${tenantId}`}))`;
    if ((await tx.recallRule.count({ where: { tenantId } })) > 0) return 0;
    const treatments = await listTreatments(tenantId, { includeInactive: true }, tx);
    let created = 0;
    for (const def of DEFAULT_RECALL_RULES) {
      const treatment = treatments.find((t) => t.key === def.treatmentKey);
      if (!treatment) continue;
      await tx.recallRule.create({
        data: {
          tenantId,
          name: def.name,
          kind: def.kind,
          treatmentId: treatment.id,
          diagnosisTerms: def.diagnosisTerms.map(normaliseTerm),
          dueDays: def.dueDays,
          windowDays: def.windowDays,
          sessions: def.sessions,
        },
      });
      created += 1;
    }
    return created;
  };
  // Inside a caller's transaction the lock holds until it ends; otherwise the work gets one of its own.
  const own = (client as { $transaction?: unknown }).$transaction;
  return typeof own === "function" ? (client as typeof db).$transaction(run) : run(client);
}

/** The clinic's rules, made on first use. */
export async function activeRules(tenantId: string, client: Client = db): Promise<RecallRule[]> {
  let rows = await client.recallRule.findMany({ where: { tenantId, active: true }, orderBy: { createdAt: "asc" } });
  if (!rows.length && (await client.recallRule.count({ where: { tenantId } })) === 0) {
    await ensureDefaultRecallRules(tenantId, client);
    rows = await client.recallRule.findMany({ where: { tenantId, active: true }, orderBy: { createdAt: "asc" } });
  }
  return rows;
}

// ── Editing ──────────────────────────────────────────────────────────────────

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const zDays = z.number().int().min(1, "At least 1 day").max(3660, "At most 10 years");

const RuleFields = z.object({
  name: zText(120).min(2, "Give the rule a name"),
  kind: z.enum(["SESSIONS", "REVIEWS"]),
  treatmentId: z.preprocess(blankToNull, zText(64).nullable().default(null)),
  diagnosisTerms: z
    .array(zText(60))
    .max(10)
    .default([])
    .transform((terms) => [...new Set(terms.map(normaliseTerm).filter((t) => t.length >= 2))]),
  dueDays: z.array(zDays).min(1, "Give at least one day").max(12),
  windowDays: z.number().int().min(0).max(365).default(14),
  sessions: z.preprocess(blankToNull, z.number().int().min(2, "A course has at least 2 sessions").max(50).nullable().default(null)),
  ownerRole: z.enum(RECALL_OWNER_ROLES).default("RECEPTIONIST"),
  ownerId: z.preprocess(blankToNull, zText(64).nullable().default(null)),
  channel: z.enum(RECALL_CHANNELS).default("WHATSAPP"),
  active: z.boolean().default(true),
});

function checkRule(v: z.infer<typeof RuleFields>, ctx: z.RefinementCtx) {
  if (!v.treatmentId && !v.diagnosisTerms.length) {
    ctx.addIssue({ code: "custom", path: ["treatmentId"], message: "Choose a treatment or give diagnosis words" });
  }
  if (v.kind === "SESSIONS") {
    if (v.dueDays.length !== 1) ctx.addIssue({ code: "custom", path: ["dueDays"], message: "A course has one interval between sessions" });
    if (!v.treatmentId) ctx.addIssue({ code: "custom", path: ["treatmentId"], message: "A course belongs to a treatment" });
  } else if (v.sessions !== null) {
    ctx.addIssue({ code: "custom", path: ["sessions"], message: "Reviews have no session count" });
  }
  const sorted = [...v.dueDays].sort((a, b) => a - b);
  if (new Set(sorted).size !== sorted.length) ctx.addIssue({ code: "custom", path: ["dueDays"], message: "Each day once" });
}

export const RecallRuleInput = RuleFields.superRefine(checkRule).transform((v) => ({ ...v, dueDays: [...v.dueDays].sort((a, b) => a - b) }));
export type RecallRuleInput = z.input<typeof RecallRuleInput>;

async function checkRefs(tenantId: string, input: { treatmentId: string | null; ownerId: string | null }) {
  if (input.treatmentId) await requireTenantTreatment(tenantId, input.treatmentId);
  if (input.ownerId) await requireTenantUser(tenantId, input.ownerId);
}

type RuleRow = RecallRule & { treatment: { id: string; name: string } | null };

async function toDTOs(tenantId: string, rows: RuleRow[]): Promise<RecallRuleDTO[]> {
  const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((id): id is string => Boolean(id)))];
  const owners = ownerIds.length ? await db.user.findMany({ where: { tenantId, id: { in: ownerIds } }, select: { id: true, fullName: true, email: true } }) : [];
  const ownerName = new Map(owners.map((u) => [u.id, u.fullName ?? u.email]));
  const counts = rows.length
    ? await db.recall.groupBy({ by: ["ruleId"], where: { tenantId, ruleId: { in: rows.map((r) => r.id) }, status: { in: ["OPEN", "CONTACTED", "SNOOZED", "BOOKED"] } }, _count: { _all: true } })
    : [];
  const open = new Map(counts.map((c) => [c.ruleId, c._count._all]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    treatment: r.treatment,
    diagnosisTerms: r.diagnosisTerms,
    dueDays: r.dueDays,
    windowDays: r.windowDays,
    sessions: r.sessions,
    ownerRole: r.ownerRole as RecallRuleDTO["ownerRole"],
    owner: r.ownerId ? { id: r.ownerId, name: ownerName.get(r.ownerId) ?? "Former staff member" } : null,
    channel: r.channel as RecallRuleDTO["channel"],
    active: r.active,
    openRecalls: open.get(r.id) ?? 0,
  }));
}

export async function listRecallRules(tenantId: string): Promise<RecallRuleDTO[]> {
  await activeRules(tenantId);
  const rows = await db.recallRule.findMany({ where: { tenantId }, orderBy: [{ active: "desc" }, { createdAt: "asc" }], include: { treatment: { select: { id: true, name: true } } } });
  return toDTOs(tenantId, rows);
}

export async function createRecallRule(tenantId: string, raw: unknown, actor: Actor = {}): Promise<RecallRuleDTO> {
  const input = RecallRuleInput.parse(raw);
  await checkRefs(tenantId, input);
  const row = await db.recallRule.create({ data: { tenantId, ...input, createdById: actor.id ?? null }, include: { treatment: { select: { id: true, name: true } } } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "recall.rule.create", entity: "RecallRule", entityId: row.id, after: input });
  return (await toDTOs(tenantId, [row]))[0]!;
}

export async function updateRecallRule(tenantId: string, id: string, raw: unknown, actor: Actor = {}): Promise<RecallRuleDTO> {
  const before = await db.recallRule.findFirst({ where: { id, tenantId } });
  if (!before) throw new TenantScopeError("recall_rule", id);
  // The whole rule is checked again with the change applied: a partial edit cannot leave it inconsistent.
  const merged = { ...before, ...(raw && typeof raw === "object" ? raw : {}) };
  const input = RecallRuleInput.parse({
    name: merged.name,
    kind: merged.kind,
    treatmentId: merged.treatmentId,
    diagnosisTerms: merged.diagnosisTerms,
    dueDays: merged.dueDays,
    windowDays: merged.windowDays,
    sessions: merged.sessions,
    ownerRole: merged.ownerRole,
    ownerId: merged.ownerId,
    channel: merged.channel,
    active: merged.active,
  });
  await checkRefs(tenantId, input);
  const row = await db.recallRule.update({ where: { id, tenantId }, data: input, include: { treatment: { select: { id: true, name: true } } } });
  const changed = Object.fromEntries(Object.entries(input).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((before as Record<string, unknown>)[k])));
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "recall.rule.update",
    entity: "RecallRule",
    entityId: id,
    before: Object.fromEntries(Object.keys(changed).map((k) => [k, (before as Record<string, unknown>)[k]])) as Prisma.InputJsonObject,
    after: changed as Prisma.InputJsonObject,
  });
  return (await toDTOs(tenantId, [row]))[0]!;
}
