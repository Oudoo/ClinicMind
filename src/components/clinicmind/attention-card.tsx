import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { ChevronRight, CircleCheck } from "lucide-react";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { formatNumber, cn } from "@/lib/utils";
import { getAttentionSummary, type AttentionTone } from "@/modules/notifications/attention";

const TONE_TEXT: Record<AttentionTone, string> = {
  default: "text-foreground",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * What needs a human now: open escalations, overdue follow-ups, drafts to sign,
 * today's no-shows, pending onboarding forms, unread alerts — each a count, one
 * line of why and a link. Role-aware through getAttentionSummary(); the same
 * summary GET /api/notifications/attention returns.
 * Rendered by src/app/dashboard/page.tsx. Server component: fetches what it needs itself.
 */
export async function AttentionCard({ tenantId, userId, role }: { tenantId: string; userId: string | null; role: UserRole }) {
  const summary = await getAttentionSummary(tenantId, userId, role);
  const calm = summary.items.length === 0;
  return (
    <Card data-testid="attention-card">
      <SectionTitle
        title="Needs attention now"
        description={role === "DOCTOR" ? "Your escalations, your drafts and your alerts." : "Open items for your role, oldest target first."}
        action={calm ? <Badge tone="success">clear</Badge> : <Badge tone={summary.items.some((i) => i.tone === "danger") ? "danger" : "warning"}>{formatNumber(summary.total)} open</Badge>}
      />
      {calm ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" data-testid="attention-calm">
          <CircleCheck className="h-4 w-4 text-success" aria-hidden="true" />
          Nothing waiting. Escalations, follow-ups, drafts and forms are all handled.
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {summary.items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                data-testid={`attention-${item.key}`}
                className="group flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted"
              >
                <span className={cn("metric-value w-12 shrink-0 text-2xl tabular-nums", TONE_TEXT[item.tone])}>{formatNumber(item.count)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.label}</span>
                  <span className={cn("block truncate text-xs", item.tone === "danger" ? "text-danger" : "text-muted-foreground")}>{item.detail}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
