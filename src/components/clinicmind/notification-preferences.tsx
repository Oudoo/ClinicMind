import type { UserRole } from "@prisma/client";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { db } from "@/lib/db";
import { getTenantTimezone } from "@/modules/appointments/service";
import { getPreferences } from "@/modules/notifications/service";
import { NotificationPreferencesForm } from "./notification-preferences-form";

const ROLE_LABEL: Record<UserRole, string> = {
  SUPER_ADMIN: "platform admin",
  CLINIC_OWNER: "owner",
  DOCTOR: "doctor",
  NURSE: "nurse",
  RECEPTIONIST: "reception",
  ASSISTANT: "assistant",
};

/**
 * Per-user notification preferences: which kinds in-app, by e-mail, browser notifications.
 * Rendered by the settings page. Server component: fetches the current values and
 * hands them to the client form. Owners see the same form as everyone: these are
 * personal settings, one row per user.
 */
export async function NotificationPreferences({ tenantId, userId, role }: { tenantId: string; userId: string | null; role: UserRole }) {
  if (!userId) return null;
  const [preferences, timezone, user] = await Promise.all([
    getPreferences(tenantId, userId),
    getTenantTimezone(tenantId),
    db.user.findFirst({ where: { id: userId, tenantId }, select: { email: true } }),
  ]);
  return (
    <Card className="space-y-4" id="notifications">
      <SectionTitle
        title="Notifications"
        description="Which events reach you, and how. These are your own settings; every member of the team has theirs."
        action={<Badge tone="accent">{ROLE_LABEL[role]}</Badge>}
      />
      <NotificationPreferencesForm initial={preferences} timezone={timezone} email={user?.email ?? null} />
    </Card>
  );
}
