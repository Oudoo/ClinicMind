import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { zText } from "@/lib/validation";
import { allocateCredit } from "./allocations";
import { FinanceError } from "./errors";
import { patientBalances } from "./ledger";
import { RELATIONS } from "./ledger-copy";

/**
 * Family accounts: a household head pays for its members. A member's own
 * payments still pay their own invoices first; the head's payments go on to
 * whatever the family owes, oldest first (see allocations.ts). One level
 * only: a head has no head of their own and a member heads no one (the
 * database refuses a chain too). Leaving a family keeps what the head had
 * already paid; from then on each pays for themselves.
 */

type Actor = { id?: string | null; email?: string | null; ip?: string | null };

export const HouseholdInput = z.object({
  /** The family member who pays for this patient; null: the patient pays for themselves again. */
  headId: zText(64).min(1).nullable(),
  relation: z.enum(RELATIONS).optional(),
});

export interface HouseholdMember {
  id: string;
  fullName: string;
  relation: string | null;
  archived: boolean;
  /** Owed now; negative is credit. */
  balance: number;
}

export interface HouseholdView {
  /** The patient pays for others (head), is paid for (member), or neither. */
  role: "head" | "member" | "none";
  head: Omit<HouseholdMember, "relation"> | null;
  /** Everyone the head pays for (a member sees the whole family). */
  members: HouseholdMember[];
  /** The head's balance and the members' together. */
  familyBalance: number | null;
}

export async function getHousehold(tenantId: string, patientId: string): Promise<HouseholdView> {
  const patient = await db.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, householdHeadId: true } });
  if (!patient) throw new TenantScopeError("patient", patientId);
  const headId = patient.householdHeadId ?? patient.id;
  const [head, members] = await Promise.all([
    db.patient.findFirst({ where: { id: headId, tenantId }, select: { id: true, fullName: true, deletedAt: true } }),
    db.patient.findMany({ where: { tenantId, householdHeadId: headId }, select: { id: true, fullName: true, householdRelation: true, deletedAt: true }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!head || !members.length) return { role: "none", head: null, members: [], familyBalance: null };
  const balances = await patientBalances(db, tenantId, [head.id, ...members.map((m) => m.id)]);
  return {
    role: patient.householdHeadId ? "member" : "head",
    head: { id: head.id, fullName: head.fullName, archived: head.deletedAt !== null, balance: balances.get(head.id) ?? 0 },
    members: members.map((m) => ({ id: m.id, fullName: m.fullName, relation: m.householdRelation, archived: m.deletedAt !== null, balance: balances.get(m.id) ?? 0 })),
    familyBalance: [...balances.values()].reduce((s, b) => s + b, 0),
  };
}

/**
 * Put a patient in a family (the head who pays for them, and how they are
 * related) or take them out of it (`headId: null`). Joining puts the head's
 * credit towards the new member's open invoices.
 */
export async function setHouseholdHead(tenantId: string, patientId: string, rawInput: unknown, actor: Actor = {}): Promise<HouseholdView> {
  const input = HouseholdInput.parse(rawInput);
  if (input.headId === patientId) throw new z.ZodError([{ code: "custom", path: ["headId"], message: "Choose another patient: a patient does not pay for themselves as head" }]);
  const change = await db.$transaction(async (tx) => {
    // Both rows locked, in a fixed order, so two changes made at once cannot build a chain.
    const ids = [patientId, ...(input.headId ? [input.headId] : [])].sort();
    await tx.$queryRaw`SELECT id FROM "patients" WHERE "tenantId" = ${tenantId} AND id = ANY(${ids}) ORDER BY id FOR UPDATE`;
    const patient = await tx.patient.findFirst({
      where: { id: patientId, tenantId },
      select: { id: true, fullName: true, deletedAt: true, householdHeadId: true, householdRelation: true, _count: { select: { householdMembers: true } } },
    });
    if (!patient) throw new TenantScopeError("patient", patientId);
    if (patient.deletedAt) throw new FinanceError(409, "archived", "an archived patient's family account is not changed", { message: "Restore the patient before changing their family account." });
    const before = { headId: patient.householdHeadId, relation: patient.householdRelation };
    if (input.headId === null) {
      if (!patient.householdHeadId) return null;
      await tx.patient.update({ where: { id: patientId }, data: { householdHeadId: null, householdRelation: null } });
      return { before, after: { headId: null, relation: null } };
    }
    const head = await tx.patient.findFirst({
      where: { id: input.headId, tenantId, ...notDeleted },
      select: { id: true, fullName: true, householdHeadId: true, householdHead: { select: { fullName: true } } },
    });
    if (!head) throw new TenantScopeError("patient", input.headId);
    if (head.householdHeadId) {
      const theirs = head.householdHead?.fullName ?? "another patient";
      throw new FinanceError(409, "head_is_member", "the head chosen is paid for by someone else", {
        message: `${head.fullName} is paid for by ${theirs}: choose ${theirs} as the one who pays.`,
      });
    }
    if (patient._count.householdMembers) {
      const n = patient._count.householdMembers;
      throw new FinanceError(409, "pays_for_others", "a head does not join another family", {
        message: `${patient.fullName} pays for ${n} family member${n === 1 ? "" : "s"}, so cannot be paid for by someone else.`,
      });
    }
    const relation = input.relation ?? "OTHER";
    await tx.patient.update({ where: { id: patientId }, data: { householdHeadId: head.id, householdRelation: relation } });
    // The head's money now pays this member's open invoices too.
    await allocateCredit(tx, tenantId, head.id, actor.id ?? null);
    return { before, after: { headId: head.id, relation } };
  });
  if (change) {
    await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "patient.household", entity: "Patient", entityId: patientId, before: change.before, after: change.after });
  }
  return getHousehold(tenantId, patientId);
}
