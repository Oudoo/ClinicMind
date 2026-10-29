import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { patientInsurance, payerOptions } from "@/modules/insurance/covers";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { ApprovalStatusBadge, ClaimStatusBadge } from "./insurance-shared";
import { AddCoverButton, AnswerApprovalButton, CancelApprovalButton, EndCoverButton, RequestApprovalButton } from "./insurance-actions";
import { CLAIM_STATUS_LABELS, type ClaimStatusValue } from "@/modules/insurance/constants";

/**
 * The patient's insurance on their page: the cover valid today (the payer,
 * the card, the contract's terms in short and what is left of the yearly
 * limit), the other covers, the approvals asked of the payer with its
 * answers, and (for the roles that see claims) the claims made for their
 * invoices. The desk adds and ends covers and asks for and records approvals.
 * Server component: it fetches what it needs; nothing for a patient never
 * covered unless the user can add a cover.
 */
export async function PatientInsuranceCard({ tenantId, role, patientId, canWrite }: { tenantId: string; role: UserRole; patientId: string; canWrite: boolean }) {
  if (!can(role, "patients:read")) return null;
  const mayWrite = canWrite && can(role, "insurance:write");
  const [insurance, payers] = await Promise.all([patientInsurance(tenantId, patientId, { claims: can(role, "insurance:read") }), mayWrite ? payerOptions(tenantId) : Promise.resolve([])]);
  if (!insurance.covers.length && !mayWrite) return null;
  const { current, today, timezone } = insurance;
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });
  const dayKey = (key: string) => formatDateInTz(new Date(`${key}T12:00:00Z`), "UTC", { day: "numeric", month: "short", year: "numeric" });
  const others = insurance.covers.filter((c) => c.id !== current?.id);
  const approvals = insurance.approvals.slice(0, 6);
  const claims = insurance.claims?.slice(0, 6) ?? null;

  return (
    <Card className="space-y-4" aria-label="Insurance" data-testid="patient-insurance">
      <SectionTitle title="Insurance" description="The patient's cover with an insurer or a company, the approvals asked of it, and its claims." action={mayWrite ? <AddCoverButton patientId={patientId} payers={payers} today={today} /> : null} />
      {current ? (
        <div className="space-y-2 rounded-lg border border-border p-3" data-testid="current-cover">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">
                {can(role, "insurance:read") ? (
                  <Link href={`/dashboard/finance/insurance/payers/${current.payerId}`} className="underline-offset-2 hover:underline">
                    {current.payerName}
                  </Link>
                ) : (
                  current.payerName
                )}{" "}
                <Badge tone="success">Covered</Badge>
              </p>
              <p className="text-sm">
                Card <span className="font-mono">{current.memberNumber}</span>
                {current.plan ? ` · ${current.plan}` : ""} · {current.relationLabel}
                {current.employer ? ` · ${current.employer}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                From {dayKey(current.validFrom)}
                {current.validTo ? ` to ${dayKey(current.validTo)}` : ""}
              </p>
            </div>
            {mayWrite ? (
              <div className="flex flex-wrap gap-2">
                <RequestApprovalButton patientId={patientId} cover={current} today={today} />
                <EndCoverButton cover={current} today={today} />
              </div>
            ) : null}
          </div>
          {current.terms ? (
            <p className="text-sm">
              The patient pays {current.terms.copayPct}% of covered work at {current.terms.discountPct}% off
              {current.terms.approvalAbove !== null ? `; approval first above ${formatNumber(current.terms.approvalAbove)} EGP` : ""}.
            </p>
          ) : (
            <p className="text-sm text-warning">The payer has no contract in force today: nothing is claimed.</p>
          )}
          {current.limit ? (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span>Yearly limit, to {dayKey(current.limit.to)}</span>
                <span className="font-mono tabular-nums">
                  {formatNumber(current.limit.used)} of {formatNumber(current.limit.amount)} EGP used
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${formatNumber(current.limit.left)} EGP of the yearly limit left`}>
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round((current.limit.used / current.limit.amount) * 100))}%` }} />
              </div>
            </div>
          ) : null}
        </div>
      ) : insurance.covers.length ? (
        <p className="text-sm text-muted-foreground">No cover valid today.</p>
      ) : (
        <p className="text-sm text-muted-foreground">No cover. Add the patient&apos;s card when an insurer or a company pays for them.</p>
      )}

      {others.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {others.map((c) => (
            <li key={c.id}>
              {c.payerName} · card <span className="font-mono">{c.memberNumber}</span> · {dayKey(c.validFrom)}
              {c.validTo ? ` – ${dayKey(c.validTo)}` : " on"}
              {c.endReason ? ` · ended: ${c.endReason}` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {approvals.length ? (
        <div className="space-y-1">
          <p className="data-label">Approvals</p>
          <ul className="divide-y divide-border" data-testid="patient-approvals">
            {approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{a.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.payerName} · {formatNumber(a.amount)} EGP asked {day(a.requestedAt)}
                    {a.status === "APPROVED" ? ` · no. ${a.approvalNumber}, ${formatNumber(a.approvedAmount ?? 0)} EGP${a.validUntil ? ` until ${dayKey(a.validUntil)}` : ""} · ${formatNumber(a.left)} left` : ""}
                    {a.status === "REFUSED" ? ` · ${a.refusalReason}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <ApprovalStatusBadge status={a.status} label={a.statusLabel} expired={a.expired} />
                  {mayWrite && a.status === "REQUESTED" ? <AnswerApprovalButton approval={a} today={today} /> : null}
                  {mayWrite && (a.status === "REQUESTED" || (a.status === "APPROVED" && a.used === 0)) ? <CancelApprovalButton approval={a} /> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {claims?.length ? (
        <div className="space-y-1">
          <p className="data-label">Claims</p>
          <ul className="divide-y divide-border" data-testid="patient-claims">
            {claims.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <Link href={`/dashboard/finance/insurance/claims/${c.id}`} className="font-mono underline-offset-2 hover:underline">
                    {c.number}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">
                    {c.payerName} · invoice {c.invoiceNumber} · {day(c.claimedAt)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs tabular-nums">
                    {formatNumber(c.amount)}
                    {c.refused ? ` · ${formatNumber(c.refused)} refused` : ""}
                  </span>
                  <ClaimStatusBadge status={c.status} label={c.status === "SETTLED" && c.refused && !c.paid ? "Refused" : c.status === "SENT" && c.paid ? "Part paid" : CLAIM_STATUS_LABELS[c.status as ClaimStatusValue]} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
