import type { UserRole } from "@prisma/client";

/**
 * Per-user notification preferences: which kinds in-app, by e-mail, browser notifications.
 * Rendered by the settings page. Server component: fetch what it needs itself.
 */
export async function NotificationPreferences(_props: { tenantId: string; userId: string | null; role: UserRole;  }) {
  return null;
}
