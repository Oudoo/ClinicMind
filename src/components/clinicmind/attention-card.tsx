import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { ChevronRight, CircleAlert, CircleCheck, CircleDot, TriangleAlert, type LucideIcon } from "lucide-react";
import { Card, SectionTitle } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { getAttentionSummary, type AttentionTone } from "@/modules/notifications/attention";

/** Each tone has its own mark as well as its colour: overdue, waiting, for information. */
const TONE: Record<AttentionTone, { Icon: LucideIcon; icon: string; detail: string }> = {
  danger: { Icon: TriangleAlert, icon: "text-danger", detail: "text-danger" },
  warning: { Icon: CircleAlert, icon: "text-warning", detail: "text-muted-foreground" },
  default: { Icon: CircleDot, icon: "text-muted-foreground", detail: "text-muted-foreground" },
};

/**
 * What needs a human now: open escalations, overdue follow-ups, drafts to sign,
 * today's no-shows, pending onboarding forms, unread alerts — each one line that
 * says how many and why, and opens the place to deal with it. Role-aware through
 * getAttentionSummary(); the same summary GET /api/notifications/attention returns.
 * Rendered by src/app/dashboard/page.tsx. Server component: fetches what it needs itself.
 */
export async function AttentionCard({ tenantId, userId, role }: { tenantId: string; userId: string | null; role: UserRole }) {
  const summary = await getAttentionSummary(tenantId, userId, role);
  const calm = summary.items.length === 0;
  return (
    <Card data-testid="attention-card" className="overflow-hidden p-0">
      <SectionTitle
        className="px-5 pt-5"
        title="Needs attention"
        description={role === "DOCTOR" ? "Your escalations, drafts and alerts." : "Open work for your role, most urgent first."}
      />
      {calm ? (
        <p className="flex items-center gap-2 px-5 pb-5 pt-4 text-sm text-muted-foreground" data-testid="attention-calm">
          <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          Nothing waiting. Escalations, follow-ups, drafts and forms are all handled.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border border-t border-border">
          {summary.items.map((item) => {
            const tone = TONE[item.tone];
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  data-testid={`attention-${item.key}`}
                  className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-muted/60 focus-visible:-outline-offset-2"
                >
                  <tone.Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone.icon)} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium first-letter:uppercase">{item.label}</span>
                    <span className={cn("block text-xs", tone.detail)}>{item.detail}</span>
                  </span>
                  <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
