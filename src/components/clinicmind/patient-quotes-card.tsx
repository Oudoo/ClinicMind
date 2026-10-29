import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { Plus } from "lucide-react";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { patientQuotes } from "@/modules/quotes/service";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { QuoteStateBadge } from "./quote-shared";

/**
 * The patient's treatment plans on their page: each with its number (or
 * "draft"), when it was given, its total and where it stands, and a new one
 * for roles that make them. Server component: it fetches what it needs.
 */
export async function PatientQuotesCard({ tenantId, role, patientId, canWrite }: { tenantId: string; role: UserRole; patientId: string; canWrite: boolean }) {
  if (!can(role, "quotes:read")) return null;
  const { quotes, timezone, total } = await patientQuotes(tenantId, patientId);
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });
  return (
    <Card className="space-y-3" aria-label="Treatment plans">
      <SectionTitle
        title="Treatment plans"
        description="Quotes given, and the patient's answers."
        action={
          canWrite && can(role, "quotes:write") ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/dashboard/quotes/new?patientId=${patientId}`}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                New
              </Link>
            </Button>
          ) : null
        }
      />
      {quotes.length ? (
        <ul className="space-y-2" data-testid="patient-quotes">
          {quotes.map((q) => (
            <li key={q.id}>
              <Link href={`/dashboard/quotes/${q.id}`} className="flex items-start justify-between gap-3 rounded-md border border-border p-3 hover:bg-muted/40">
                <span className="min-w-0">
                  <span className="block font-mono text-xs font-medium">{q.number ?? "Draft"}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {q.title ?? "Treatment plan"} · {day(q.sentAt ?? q.createdAt)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-mono text-sm tabular-nums">{formatNumber(q.state === "ACCEPTED" && q.acceptedTotal !== null ? q.acceptedTotal : q.total)} EGP</span>
                  <QuoteStateBadge state={q.state} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No treatment plan yet" hint={canWrite && can(role, "quotes:write") ? "Make one after the consultation: phases, sessions, price and validity." : undefined} />
      )}
      {total > quotes.length ? <p className="text-xs text-muted-foreground">The {quotes.length} latest of {total}.</p> : null}
    </Card>
  );
}
