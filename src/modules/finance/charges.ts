import type { Prisma, PriceUnit } from "@prisma/client";

/**
 * Charges: what a patient owes for work done, posted when the work is done.
 * A procedure is charged when it is signed; work done in stages (the
 * sessions of a course) is charged stage by stage as each is done, and
 * whatever is left when it is signed; a visit charged nothing carries the
 * reason. A charge is never edited (the database refuses it): a correction
 * is a reversing charge, dated the day it is made, so a closed day keeps
 * its totals. These helpers run inside the caller's transaction.
 */

type Tx = Prisma.TransactionClient;

/** The most stages one procedure is split into. */
export const MAX_STAGES = 50;

/**
 * How many stages a procedure from a price-list item is done in: a course
 * package's sessions, so many sessions of a per-session item; anything else
 * is done (and charged) at once.
 */
export function stagesFor(item: { unit: PriceUnit; sessions: number | null } | null, quantity: number): number {
  if (!item) return 1;
  if (item.unit === "PACKAGE") return Math.min(MAX_STAGES, Math.max(1, item.sessions ?? 1));
  if (item.unit === "SESSION") return Math.min(MAX_STAGES, Math.max(1, quantity));
  return 1;
}

/**
 * Stage `stage`'s share (1-based) of `net` split into `stages`: whole pounds,
 * the odd pounds falling on the later stages, the shares summing to `net`.
 */
export function stageShare(net: number, stages: number, stage: number): number {
  const upTo = (k: number) => Math.floor((net * k) / stages);
  return upTo(stage) - upTo(stage - 1);
}

/** "FUE hair transplant × 2,400", "PRP for hair loss, course": what the procedure is called on a charge. */
export function procedureLabel(p: { quantity: number; stages: number; priceItem: { name: string } | null; treatment: { name: string } }): string {
  const name = p.priceItem?.name ?? p.treatment.name;
  return p.quantity > 1 && p.stages === 1 ? `${name} × ${p.quantity.toLocaleString("en-US")}` : name;
}

/** "session 2 of 6", "sessions 3–6 of 6". */
export function stagePhrase(from: number, to: number, of: number): string {
  return from === to ? `session ${from} of ${of}` : `sessions ${from}–${to} of ${of}`;
}

export interface ChargeSummaryRow {
  amount: number;
  stage: number | null;
  reversalOfId: string | null;
}

/** What has been charged on a procedure so far, and how many of its stages are done. */
export function summarizeCharges(rows: readonly ChargeSummaryRow[]): { charged: number; stagesDone: number } {
  let charged = 0;
  let stagesDone = 0;
  for (const r of rows) {
    charged += r.amount;
    if (r.stage !== null && r.reversalOfId === null) stagesDone += 1;
  }
  return { charged, stagesDone };
}

export interface ChargeInput {
  tenantId: string;
  patientId: string;
  procedureId?: string | null;
  appointmentId?: string | null;
  stage?: number | null;
  amount: number;
  description: string;
  chargedAt: Date;
  doctorId?: string | null;
  clinicId?: string | null;
  createdById?: string | null;
  /** A discount: the charge it takes off, and why (a key of the fixed list). */
  discountOfId?: string | null;
  reason?: string | null;
}

export function postCharge(tx: Tx, input: ChargeInput) {
  return tx.charge.create({
    data: {
      tenantId: input.tenantId,
      patientId: input.patientId,
      procedureId: input.procedureId ?? null,
      appointmentId: input.appointmentId ?? null,
      stage: input.stage ?? null,
      amount: input.amount,
      description: input.description.slice(0, 300),
      chargedAt: input.chargedAt,
      doctorId: input.doctorId ?? null,
      clinicId: input.clinicId ?? null,
      createdById: input.createdById ?? null,
      discountOfId: input.discountOfId ?? null,
      reason: input.reason ?? null,
    },
  });
}

/**
 * Reverse every charge of a procedure not reversed yet: one negative row
 * each, dated `at`. Returns the total reversed.
 */
export async function reverseProcedureCharges(tx: Tx, tenantId: string, procedureId: string, at: Date, createdById: string | null): Promise<number> {
  const rows = await tx.charge.findMany({
    where: { tenantId, procedureId, reversalOfId: null, reversedBy: { is: null } },
    orderBy: { createdAt: "asc" },
  });
  let total = 0;
  for (const r of rows) {
    if (r.amount === 0) continue;
    await tx.charge.create({
      data: {
        tenantId,
        patientId: r.patientId,
        procedureId,
        appointmentId: r.appointmentId,
        stage: r.stage,
        amount: -r.amount,
        description: `Reversed: ${r.description}`.slice(0, 300),
        chargedAt: at,
        doctorId: r.doctorId,
        clinicId: r.clinicId,
        reversalOfId: r.id,
        createdById,
      },
    });
    total += r.amount;
  }
  return total;
}
