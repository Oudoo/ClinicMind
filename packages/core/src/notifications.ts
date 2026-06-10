import nodemailer from "nodemailer";
import { and, eq } from "drizzle-orm";
import {
  db,
  notifications,
  notificationTemplates,
  notificationRules,
  users,
  userRoles,
  roles,
} from "@growengine/db";
import { env } from "./env.js";
import { enqueueNotificationJob } from "./queues.js";

/**
 * Notification Center — templates, rules, and multi-channel dispatch
 * (in-app, email, Slack, Teams, webhook). Rules map domain events to
 * audiences; dispatch always runs through the Notification Worker.
 */

let transporter: nodemailer.Transporter | null = null;

function mailer(): nodemailer.Transporter {
  if (!env.smtpHost) throw new Error("SMTP_HOST is not configured");
  transporter ??= nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPassword } : undefined,
  });
  return transporter;
}

/** Minimal {{placeholder}} template renderer (dot-path aware). */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), data);
    return value === undefined || value === null ? "" : String(value);
  });
}

export interface NotifyInput {
  tenantId: string;
  userId?: string | null;
  channel: "in_app" | "email" | "slack" | "teams" | "webhook";
  templateKey?: string;
  title: string;
  body?: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
}

/** Create the notification record and enqueue dispatch. */
export async function notify(input: NotifyInput) {
  const [record] = await db
    .insert(notifications)
    .values({
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      channel: input.channel,
      templateKey: input.templateKey,
      title: input.title,
      body: input.body,
      linkUrl: input.linkUrl,
      metadata: input.metadata ?? {},
      status: input.channel === "in_app" ? "delivered" : "queued",
    })
    .returning();

  if (input.channel !== "in_app") {
    await enqueueNotificationJob({
      tenantId: input.tenantId,
      notificationId: record.id,
      kind: "dispatch",
      input: {},
    });
  }
  return record;
}

/** Physical delivery — called only from the Notification Worker. */
export async function deliverNotification(notificationId: string) {
  const [record] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, notificationId));
  if (!record || record.status === "delivered") return;

  try {
    switch (record.channel) {
      case "email": {
        let toAddress = (record.metadata as Record<string, unknown>).email as string | undefined;
        if (!toAddress && record.userId) {
          const [u] = await db.select().from(users).where(eq(users.id, record.userId));
          toAddress = u?.email;
        }
        if (!toAddress) throw new Error("No recipient email resolvable");
        await mailer().sendMail({
          from: env.smtpFrom,
          to: toAddress,
          subject: record.title,
          text: record.body ?? record.title,
          html: `<div style="font-family:sans-serif"><h2>${record.title}</h2><p>${(record.body ?? "").replace(/\n/g, "<br/>")}</p>${record.linkUrl ? `<p><a href="${record.linkUrl}">Open in The Grow Engine</a></p>` : ""}</div>`,
        });
        break;
      }
      case "slack": {
        const url =
          ((record.metadata as Record<string, unknown>).webhookUrl as string) || env.slackWebhookUrl;
        if (!url) throw new Error("No Slack webhook configured");
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `*${record.title}*\n${record.body ?? ""}${record.linkUrl ? `\n<${record.linkUrl}|Open in The Grow Engine>` : ""}`,
          }),
        });
        if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}`);
        break;
      }
      case "teams": {
        const url =
          ((record.metadata as Record<string, unknown>).webhookUrl as string) || env.teamsWebhookUrl;
        if (!url) throw new Error("No Teams webhook configured");
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            summary: record.title,
            title: record.title,
            text: record.body ?? "",
            potentialAction: record.linkUrl
              ? [{ "@type": "OpenUri", name: "Open", targets: [{ os: "default", uri: record.linkUrl }] }]
              : [],
          }),
        });
        if (!res.ok) throw new Error(`Teams webhook HTTP ${res.status}`);
        break;
      }
      case "webhook": {
        const url = (record.metadata as Record<string, unknown>).webhookUrl as string;
        if (!url) throw new Error("No webhook URL in metadata");
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: record.title,
            body: record.body,
            linkUrl: record.linkUrl,
            metadata: record.metadata,
          }),
        });
        if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
        break;
      }
      case "in_app":
        break;
    }
    await db
      .update(notifications)
      .set({ status: "delivered", sentAt: new Date() })
      .where(eq(notifications.id, notificationId));
  } catch (err) {
    await db
      .update(notifications)
      .set({ status: "failed", error: (err as Error).message })
      .where(eq(notifications.id, notificationId));
    throw err;
  }
}

/**
 * Evaluate notification rules for a domain event — resolves audience and
 * fans out notifications through the configured channels.
 */
export async function applyNotificationRules(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>
) {
  const rules = await db
    .select()
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.tenantId, tenantId),
        eq(notificationRules.eventType, eventType),
        eq(notificationRules.isActive, 1)
      )
    );

  for (const rule of rules) {
    const [template] = await db
      .select()
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.tenantId, tenantId),
          eq(notificationTemplates.key, rule.templateKey)
        )
      );
    const title = template ? renderTemplate(template.subjectTemplate, payload) : eventType;
    const body = template ? renderTemplate(template.bodyTemplate, payload) : JSON.stringify(payload);

    const audience = rule.audience as { roles?: string[]; userIds?: string[] };
    const recipientIds = new Set<string>(audience.userIds ?? []);

    if (audience.roles?.length) {
      const roleUsers = await db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(and(eq(roles.tenantId, tenantId)));
      const tenantRoleNames = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.tenantId, tenantId));
      const wantedRoleIds = new Set(
        tenantRoleNames.filter((r) => audience.roles!.includes(r.name)).map((r) => r.id)
      );
      const memberships = await db.select().from(userRoles);
      for (const m of memberships) {
        if (wantedRoleIds.has(m.roleId)) recipientIds.add(m.userId);
      }
      void roleUsers;
    }

    const channels = (rule.channels as string[]) ?? ["in_app"];
    for (const channel of channels) {
      if (recipientIds.size === 0 && channel !== "slack" && channel !== "teams" && channel !== "webhook") continue;
      if (channel === "slack" || channel === "teams" || channel === "webhook") {
        await notify({
          tenantId,
          channel: channel as NotifyInput["channel"],
          templateKey: rule.templateKey,
          title,
          body,
          metadata: payload,
        });
      } else {
        for (const userId of recipientIds) {
          await notify({
            tenantId,
            userId,
            channel: channel as NotifyInput["channel"],
            templateKey: rule.templateKey,
            title,
            body,
            metadata: payload,
          });
        }
      }
    }
  }
}
