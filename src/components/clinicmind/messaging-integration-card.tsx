import type { UserRole } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/auth/rbac";
import { formatDateTimeInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { getIntegrationStatus } from "@/modules/messaging/integrations";
import { listTemplates } from "@/modules/messaging/templates";
import type { IntegrationStatusDTO } from "@/modules/messaging/dto";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { InboxChannelSettings } from "./inbox-channel-settings";
import { InboxTemplatesEditor } from "./inbox-templates-editor";

const PROVIDER_LABELS: Record<IntegrationStatusDTO["provider"], string> = {
  manual: "Manual (logged only)",
  whatsapp_cloud: "WhatsApp Cloud API",
  inbox_webhook: "Inbox webhook",
};

/**
 * Settings → Messaging: how inbox replies reach patients (WhatsApp Cloud API,
 * the clinic's inbox webhook, or logged on the record), the signed inbound
 * webhook, a test send, and the reply templates. Owners (tenant:manage)
 * change it; everyone else sees the status. Server component.
 */
export async function MessagingIntegrationCard({ tenantId, role }: { tenantId: string; userId: string | null; role: UserRole }) {
  if (!can(role, "conversations:read")) return null;
  const manage = can(role, "tenant:manage");
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant) return null;
  const [status, templates, timezone] = await Promise.all([
    getIntegrationStatus(tenantId, tenant.slug, { redact: !manage }),
    listTemplates(tenantId, { includeInactive: manage }),
    getTenantTimezone(tenantId),
  ]);
  const live = status.enabled && status.provider !== "manual";
  const when = (iso: string | null) => (iso ? formatDateTimeInTz(new Date(iso), timezone) : "never");

  return (
    <Card className="space-y-5">
      <SectionTitle
        title="Messaging & WhatsApp"
        description="How replies from the reception inbox reach patients, how patients' messages reach the inbox, and the reply templates."
        action={<Badge tone={live ? "success" : "warning"}>{live ? "connected" : "logged only"}</Badge>}
      />
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Row label="Provider" value={PROVIDER_LABELS[status.provider]} />
        <Row label="Sending" value={live ? <Badge tone="success">enabled</Badge> : <Badge>off: replies are logged</Badge>} />
        <Row label="Last inbound" value={when(status.lastInboundAt)} />
        <Row label="Last outbound" value={when(status.lastOutboundAt)} />
        {status.provider === "whatsapp_cloud" ? <Row label="Phone number id" value={<span className="font-mono text-xs">{status.phoneNumberId ?? "—"}</span>} /> : null}
        {status.provider === "inbox_webhook" ? <Row label="Outbound URL" value={<span className="break-all font-mono text-xs">{status.outboundUrl ?? "—"}</span>} /> : null}
        <Row label="Webhook secret" value={status.hasSecret ? <span className="font-mono text-xs">{status.secretPrefix}…</span> : <span className="text-muted-foreground">not generated</span>} />
      </dl>
      {manage ? (
        <InboxChannelSettings status={status} />
      ) : (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Only the clinic owner can change the connection and the templates.</p>
      )}
      <InboxTemplatesEditor templates={templates} canEdit={manage} />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-1.5 last:border-0 sm:last:border-b">
      <dt className="data-label">{label}</dt>
      <dd className="min-w-0 text-right text-sm">{value}</dd>
    </div>
  );
}
