import type { PaymentMethod, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * What insurers and companies paid of their claims, for the reports: answer
 * by answer (what one payment paid of one claim line), on the day the money
 * came, by how it came, at the branch whose claim it paid. Voided payments
 * never count.
 */

type Client = Prisma.TransactionClient | typeof db;

export interface PayerMoney {
  amount: number;
  at: Date;
  method: PaymentMethod;
  /** The branch of the claim it paid. */
  clinicId: string;
  /** The work it paid for. */
  procedureId: string | null;
  invoiceId: string;
}

export async function payerMoneyIn(client: Client, tenantId: string, span: { gte?: Date; lt?: Date }, opts: { procedureIds?: string[] } = {}): Promise<PayerMoney[]> {
  const rows = await client.claimAnswer.findMany({
    where: {
      tenantId,
      voidedAt: null,
      paid: { gt: 0 },
      payerPayment: { voidedAt: null, paidAt: span },
      ...(opts.procedureIds ? { claimLine: { procedureId: { in: opts.procedureIds } } } : {}),
    },
    select: {
      paid: true,
      payerPayment: { select: { paidAt: true, method: true } },
      claimLine: { select: { procedureId: true, claim: { select: { clinicId: true, invoiceId: true } } } },
    },
  });
  return rows.map((r) => ({
    amount: r.paid,
    at: r.payerPayment.paidAt,
    method: r.payerPayment.method,
    clinicId: r.claimLine.claim.clinicId,
    procedureId: r.claimLine.procedureId,
    invoiceId: r.claimLine.claim.invoiceId,
  }));
}

/** What every payer owes now: its live claims' shares, less what it paid and refused. */
export async function payersOwed(client: Client, tenantId: string): Promise<number> {
  const lines = await client.claimLine.findMany({
    where: { tenantId, claim: { status: { in: ["OPEN", "SENT"] } } },
    select: { payerShare: true, answers: { where: { voidedAt: null }, select: { paid: true, refused: true } } },
  });
  return lines.reduce((s, l) => s + l.payerShare - l.answers.reduce((t, a) => t + a.paid + a.refused, 0), 0);
}
