import type { UserRole } from "@prisma/client";

/**
 * What needs a human now: open escalations, overdue follow-ups, drafts to sign, unread alerts.
 * Rendered by src/app/dashboard/page.tsx. Server component: fetch what it needs itself.
 */
export async function AttentionCard(_props: { tenantId: string; userId: string | null; role: UserRole;  }) {
  return null;
}
