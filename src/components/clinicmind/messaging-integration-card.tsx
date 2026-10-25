import type { UserRole } from "@prisma/client";

/**
 * Messaging and CRM integration: the WhatsApp Cloud API / inbox webhook connection, templates.
 * Rendered by the settings page. Server component: fetch what it needs itself.
 */
export async function MessagingIntegrationCard(_props: { tenantId: string; userId: string | null; role: UserRole;  }) {
  return null;
}
