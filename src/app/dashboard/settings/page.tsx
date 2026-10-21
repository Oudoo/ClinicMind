import { getActingContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Card, SectionTitle, Badge } from "@/components/ui/primitives";
import { EmbedInstructions } from "@/components/clinicmind/embed-instructions";
import { EmbedSecretCard } from "@/components/clinicmind/embed-secret-card";
import { InviteMemberForm, ResendInviteButton } from "@/components/clinicmind/team-management";
import { can, grantableRoles } from "@/lib/auth/rbac";
import { BRAND, type TenantBranding } from "@/lib/brand";
import { formatDate } from "@/lib/utils";

const STATUS_TONE: Record<string, "default" | "success" | "warning" | "danger"> = {
  ACTIVE: "success",
  INVITED: "warning",
  DISABLED: "danger",
};

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const tenant = await db.tenant
    .findUnique({
      where: { id: ctx.tenantId },
      include: {
        // Only non-secret embed fields are read here; the hash never reaches a page.
        embed: { select: { enabled: true, allowedOrigins: true, secretPrefix: true, secretRotatedAt: true } },
      },
    })
    .catch(() => null);

  const canManageUsers = can(ctx.role, "users:manage");
  const team = canManageUsers
    ? await db.user.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, email: true, fullName: true, role: true, status: true, createdAt: true },
      })
    : [];

  const branding = (ctx.branding as TenantBranding | null) ?? null;
  const accent = branding?.accent ?? BRAND.primitives.electricIndigo;
  const embed = tenant?.embed ?? null;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Settings & Integration"
        description="White-label this tenant, connect a custom domain, and embed ClinicMind anywhere."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-4">
          <SectionTitle title="Branding" description="Each client runs their own white-labeled version." />
          <Row label="Product name" value={branding?.productName ?? BRAND.productName} />
          <Row
            label="Accent color"
            value={
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-4 rounded border border-border"
                  style={{ background: accent }}
                />
                <span className="font-mono text-xs">{accent}</span>
              </span>
            }
          />
          <Row label="Logo" value={branding?.logoUrl ? "Custom" : "Default"} />
        </Card>

        <Card className="space-y-4">
          <SectionTitle title="Custom Domain" description="Serve the tool from the client's own domain." />
          <Row
            label="Domain"
            value={tenant?.customDomain ?? <span className="text-muted-foreground">not set</span>}
          />
          <Row
            label="Status"
            value={
              tenant?.customDomainVerified ? (
                <Badge tone="success">verified</Badge>
              ) : (
                <Badge tone="warning">pending DNS</Badge>
              )
            }
          />
          <Row label="Subdomain" value={`${ctx.tenantSlug}.${env.ROOT_DOMAIN}`} />
        </Card>
      </div>

      {canManageUsers ? (
        <Card className="space-y-4">
          <SectionTitle
            title="Team"
            description="Staff accounts of this clinic. Invited members choose their password through a single-use link."
            action={<Badge tone="accent">{team.length} members</Badge>}
          />
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-4 data-label font-normal">Member</th>
                <th className="py-2 pr-4 data-label font-normal">Role</th>
                <th className="py-2 pr-4 data-label font-normal">Status</th>
                <th className="py-2 pr-4 data-label font-normal">Since</th>
                <th className="py-2 data-label font-normal text-right" />
              </tr>
            </thead>
            <tbody>
              {team.map((member) => (
                <tr key={member.id} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-4">
                    <div className="font-medium">{member.fullName ?? member.email}</div>
                    {member.fullName ? (
                      <div className="font-mono text-xs text-muted-foreground">{member.email}</div>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs uppercase text-muted-foreground">
                    {member.role}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={STATUS_TONE[member.status] ?? "default"}>{member.status}</Badge>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">
                    {formatDate(member.createdAt)}
                  </td>
                  <td className="py-2.5 text-right">
                    {member.status === "INVITED" ? <ResendInviteButton userId={member.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-border pt-4">
            <p className="data-label mb-3">Invite a member</p>
            <InviteMemberForm roles={grantableRoles(ctx.role)} />
          </div>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <SectionTitle
          title="Embed on your website"
          description="Drop ClinicMind into the client's site or the GROW Engine dashboard as a tab."
          action={
            <Badge tone={embed?.enabled ? "success" : "default"}>
              {embed?.enabled ? "embedding enabled" : "embedding off"}
            </Badge>
          }
        />
        <Row
          label="Allowed origins"
          value={
            embed?.allowedOrigins?.length
              ? embed.allowedOrigins.join(", ")
              : "none configured — token requests are refused"
          }
        />
        <EmbedSecretCard
          secretPrefix={embed?.secretPrefix ?? null}
          rotatedAt={embed?.secretRotatedAt?.toISOString() ?? null}
          canRotate={can(ctx.role, "embed:manage")}
        />
        <EmbedInstructions appUrl={env.APP_URL} tenantSlug={ctx.tenantSlug} />
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="data-label">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}
