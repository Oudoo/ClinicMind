import { formAction } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import {
  db,
  roles,
  apiKeys,
  dataRetentionPolicies,
  features,
  featureFlags,
  notificationTemplates,
  notificationRules,
  webhookEndpoints,
  tenantInvites,
  users,
  clients,
} from "@growengine/db";
import { requirePermission } from "@/lib/session";
import {
  inviteUser,
  createApiKey,
  revokeApiKey,
  updateRetentionPolicy,
  toggleFeatureFlag,
  upsertNotificationTemplate,
  createNotificationRule,
  createWebhookEndpoint,
} from "@/app/actions/admin";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ApiKeyForm, RetentionRow } from "./client-widgets";

const PLATFORM_FEATURES = [
  "dmaic", "aeo_auditor", "process_intelligence", "lead_magnet", "forecasting",
  "meeting_intelligence", "cat_workflow", "client_portal", "public_api",
];

export default async function SettingsPage() {
  const user = await requirePermission("settings:admin");
  const tenantId = user.tenantId;

  const [roleRows, keyRows, retentionRows, featureRows, flagRows, templates, rules, webhooks, invites, userRows, clientRows] =
    await Promise.all([
      db.select().from(roles).where(eq(roles.tenantId, tenantId)),
      db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId)).orderBy(desc(apiKeys.createdAt)),
      db.select().from(dataRetentionPolicies).where(eq(dataRetentionPolicies.tenantId, tenantId)),
      db.select().from(features),
      db.select().from(featureFlags).where(eq(featureFlags.tenantId, tenantId)),
      db.select().from(notificationTemplates).where(eq(notificationTemplates.tenantId, tenantId)),
      db.select().from(notificationRules).where(eq(notificationRules.tenantId, tenantId)),
      db.select().from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenantId)),
      db.select().from(tenantInvites).where(eq(tenantInvites.tenantId, tenantId)).orderBy(desc(tenantInvites.createdAt)).limit(10),
      db.select().from(users).where(eq(users.tenantId, tenantId)),
      db.select().from(clients).where(eq(clients.tenantId, tenantId)),
    ]);

  const flagByFeatureId = new Map(flagRows.map((f) => [f.featureId, f]));
  const featureByKey = new Map(featureRows.map((f) => [f.key, f]));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <Tabs defaultValue="team">
        <TabsList>
          <TabsTrigger value="team">Team & Roles</TabsTrigger>
          <TabsTrigger value="api">API Keys</TabsTrigger>
          <TabsTrigger value="governance">Data Governance</TabsTrigger>
          <TabsTrigger value="flags">Feature Flags</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="team" className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Members ({userRows.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {userRows.map((u) => (
                <div key={u.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <div>
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </div>
                  <div className="flex gap-1.5">
                    {u.isSuperAdmin && <Badge>owner</Badge>}
                    {u.clientId && <Badge variant="info">client portal</Badge>}
                    <Badge variant="secondary">{u.status}</Badge>
                  </div>
                </div>
              ))}
              {invites.filter((i) => !i.acceptedAt).length > 0 && (
                <div className="border-t pt-2">
                  <div className="text-xs font-semibold text-muted-foreground">Pending invites</div>
                  {invites.filter((i) => !i.acceptedAt).map((i) => (
                    <div key={i.id} className="mt-1 text-xs text-muted-foreground">
                      {i.email} · expires {i.expiresAt.toISOString().slice(0, 10)}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Invite member</CardTitle>
              <CardDescription>
                Pick &ldquo;Client User&rdquo; + a client to create a client-portal account; the
                onboarding drip starts automatically.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction(inviteUser)} className="space-y-3">
                <div>
                  <Label>Email</Label>
                  <Input name="email" type="email" required />
                </div>
                <div>
                  <Label>Role</Label>
                  <Select name="roleId" required>
                    {roleRows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>Client (for portal users)</Label>
                  <Select name="clientId">
                    <option value="">— internal team —</option>
                    {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </div>
                <Button type="submit" className="w-full">Send invitation</Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="api" className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Active keys</CardTitle>
              <CardDescription>Bearer tokens for the public Grow Engine API (/api/v1/*).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {keyRows.map((k) => (
                <div key={k.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <div>
                    <div className="font-medium">{k.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{k.keyPrefix}…</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {k.revokedAt ? (
                      <Badge variant="destructive">revoked</Badge>
                    ) : (
                      <form action={formAction(revokeApiKey.bind(null, k.id))}>
                        <Button size="sm" variant="ghost" className="text-destructive">Revoke</Button>
                      </form>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
          <ApiKeyForm createApiKey={createApiKey} />
        </TabsContent>

        <TabsContent value="governance">
          <Card>
            <CardHeader>
              <CardTitle>Data retention policies</CardTitle>
              <CardDescription>
                Enforced daily by the worker. Analytics, transcripts, recordings, audit logs and
                notifications are purged after their windows.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {retentionRows.map((p) => (
                <RetentionRow
                  key={p.id}
                  policy={{ id: p.id, dataCategory: p.dataCategory, retentionDays: p.retentionDays, lastEnforcedAt: p.lastEnforcedAt?.toISOString() ?? null }}
                  updateRetentionPolicy={updateRetentionPolicy}
                />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="flags">
          <Card>
            <CardHeader>
              <CardTitle>Feature flags</CardTitle>
              <CardDescription>Per-tenant module toggles (e.g. enable DMAIC beta for one workspace).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {PLATFORM_FEATURES.map((key) => {
                const feature = featureByKey.get(key);
                const flag = feature ? flagByFeatureId.get(feature.id) : undefined;
                const enabled = flag ? flag.enabled : (feature?.defaultEnabled ?? true);
                return (
                  <div key={key} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <span className="text-sm font-medium">{key.replace(/_/g, " ")}</span>
                    <form action={formAction(toggleFeatureFlag.bind(null, key, !enabled))}>
                      <Button size="sm" variant={enabled ? "default" : "outline"}>
                        {enabled ? "Enabled" : "Disabled"}
                      </Button>
                    </form>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Templates ({templates.length})</CardTitle>
              <CardDescription>Handlebars-style {"{{placeholders}}"} from event payloads.</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction(upsertNotificationTemplate)} className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Key</Label>
                    <Input name="key" placeholder="integration_failed" required />
                  </div>
                  <div>
                    <Label>Name</Label>
                    <Input name="name" required />
                  </div>
                </div>
                <div>
                  <Label>Subject template</Label>
                  <Input name="subjectTemplate" placeholder="Integration {{provider}} failed" required />
                </div>
                <div>
                  <Label>Body template</Label>
                  <Textarea name="bodyTemplate" rows={3} placeholder="Error: {{error}}" required />
                </div>
                <Button type="submit">Save template</Button>
              </form>
              <div className="mt-3 space-y-1">
                {templates.map((t) => (
                  <div key={t.id} className="rounded-md border px-3 py-1.5 text-xs">
                    <span className="font-mono">{t.key}</span> — {t.subjectTemplate}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Rules ({rules.length})</CardTitle>
              <CardDescription>Map domain events → audiences → channels.</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction(createNotificationRule)} className="space-y-3">
                <div>
                  <Label>Event type</Label>
                  <Input name="eventType" placeholder="integration.failed" required />
                </div>
                <div>
                  <Label>Template key</Label>
                  <Input name="templateKey" required />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Channels (csv)</Label>
                    <Input name="channels" defaultValue="in_app,email" />
                  </div>
                  <div>
                    <Label>Roles (csv)</Label>
                    <Input name="roleNames" placeholder="Admin,Account Manager" />
                  </div>
                </div>
                <Button type="submit">Create rule</Button>
              </form>
              <div className="mt-3 space-y-1">
                {rules.map((r) => (
                  <div key={r.id} className="rounded-md border px-3 py-1.5 text-xs">
                    <span className="font-mono">{r.eventType}</span> → {r.templateKey} via{" "}
                    {(r.channels as string[]).join(", ")}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="webhooks">
          <Card>
            <CardHeader>
              <CardTitle>Outbound webhooks</CardTitle>
              <CardDescription>
                HMAC-signed (X-GrowEngine-Signature) deliveries of domain events to your systems.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction(createWebhookEndpoint)} className="grid items-end gap-3 md:grid-cols-4">
                <div className="md:col-span-2">
                  <Label>URL</Label>
                  <Input name="url" type="url" placeholder="https://" required />
                </div>
                <div>
                  <Label>Event types (csv or *)</Label>
                  <Input name="eventTypes" defaultValue="*" />
                </div>
                <div>
                  <Label>Signing secret</Label>
                  <Input name="secret" type="password" />
                </div>
                <Button type="submit" className="md:col-span-4">Add endpoint</Button>
              </form>
              <div className="mt-3 space-y-1">
                {webhooks.map((w) => (
                  <div key={w.id} className="rounded-md border px-3 py-1.5 text-xs">
                    {w.url} → {(w.eventTypes as string[]).join(", ")}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
