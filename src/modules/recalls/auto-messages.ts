import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { addDays, endOfDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { isQuiet, quietEndOn, readReminderSettings } from "@/modules/messaging/reminder-settings";
import { DUE_SOON_DAYS } from "./constants";
import { deliverRecallMessage, recallForMessage, renderRecallMessage } from "./messages";

/**
 * The recall's own WhatsApp messages: 14 days before the due day, on it, and
 * 7 days after, each at the end of the quiet hours of its day (never in
 * them), in the patient's language, from the clinic's template.
 *
 * Only while the recall waits for a booking (stopped once booked, snoozed or
 * ended), on a WhatsApp recall (a phone-call one is reception's), to a
 * patient with a number who agreed: treatment reminders for a review, a
 * session, planned work or a missed visit; offers and news for a patient not
 * seen for a year (asking them back is marketing). Not while reception has
 * its own plan (the day the patient asked to be called, or a contact in the
 * last three days). A step that was missed (the server was down, the quiet
 * hours, the desk's plan) is not sent late: only the latest step due goes.
 * Each step is claimed on the recall before it goes, so it goes once.
 */

const DAY_MS = 86_400_000;
const BATCH = 200;
/** A contact by the desk this recent: the automatic message waits. */
const DESK_CONTACT_DAYS = 3;

export const AUTO_STEPS = [
  { step: 1, days: -DUE_SOON_DAYS, label: "14 days before the due day" },
  { step: 2, days: 0, label: "on the due day" },
  { step: 3, days: 7, label: "7 days after the due day" },
] as const;

/** The patient agreed to what this recall's message is: offers and news for a lapsed patient, treatment reminders otherwise. */
export const consented: Prisma.RecallWhereInput = {
  OR: [
    { kind: { not: "LAPSED" }, patient: { reminderConsent: true } },
    { kind: "LAPSED", patient: { marketingConsent: true } },
  ],
};

export interface RecallMessageSummary {
  tenants: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** One pass over every active clinic (the `recall-messages` job), or one clinic. */
export async function sendRecallMessages(now: Date = new Date(), opts: { tenantId?: string } = {}): Promise<RecallMessageSummary> {
  const summary: RecallMessageSummary = { tenants: 0, sent: 0, failed: 0, skipped: 0 };
  const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null, ...(opts.tenantId ? { id: opts.tenantId } : {}) }, select: { id: true } });
  for (const { id: tenantId } of tenants) {
    const settings = await readReminderSettings(tenantId);
    if (!settings.recallMessages) continue;
    const tz = await getTenantTimezone(tenantId);
    if (isQuiet(now, tz, settings)) continue;
    summary.tenants += 1;
    const candidates = await db.recall.findMany({
      where: {
        tenantId,
        status: { in: ["OPEN", "CONTACTED"] },
        channel: "WHATSAPP",
        autoStep: { lt: AUTO_STEPS.length },
        dueAt: { lte: endOfDayInTz(addDays(now, DUE_SOON_DAYS, tz), tz) },
        AND: [
          { OR: [{ nextContactAt: null }, { nextContactAt: { lte: now } }] },
          { OR: [{ lastContactAt: null }, { lastContactAt: { lt: new Date(now.getTime() - DESK_CONTACT_DAYS * DAY_MS) } }] },
          { patient: { deletedAt: null, OR: [{ whatsapp: { not: null } }, { phone: { not: null } }] } },
          consented,
        ],
      },
      orderBy: { dueAt: "asc" },
      take: BATCH,
      select: { id: true, dueAt: true, autoStep: true },
    });
    for (const r of candidates) {
      const step = AUTO_STEPS.filter((s) => s.step > r.autoStep && quietEndOn(r.dueAt, tz, settings, s.days).getTime() <= now.getTime()).pop();
      if (!step) continue;
      const claimed = await db.recall.updateMany({ where: { id: r.id, tenantId, autoStep: r.autoStep, status: { in: ["OPEN", "CONTACTED"] } }, data: { autoStep: step.step } });
      if (!claimed.count) continue;
      const loaded = await recallForMessage(tenantId, r.id);
      if (!loaded) continue;
      const rendered = await renderRecallMessage(tenantId, loaded, { timezone: tz, now });
      if (!rendered.body || rendered.unfilled.length) {
        await db.recallActivity.create({
          data: { tenantId, recallId: r.id, kind: "NOTE", note: `The automatic message ${step.label} was not sent: the clinic's "${rendered.templateKey}" template uses ${rendered.unfilled.map((p) => `{{${p}}}`).join(", ") || "no text"}.`, at: now },
        });
        summary.skipped += 1;
        continue;
      }
      try {
        const sent = await deliverRecallMessage(tenantId, loaded, rendered, { authorId: null, step: step.step });
        const failedReason = sent.delivery === "FAILED" ? ((await db.message.findFirst({ where: { id: sent.messageId, tenantId }, select: { failedReason: true } }))?.failedReason ?? "delivery failed") : null;
        await db.recallActivity.create({
          data: { tenantId, recallId: r.id, kind: "MESSAGE", outcome: sent.delivery, note: failedReason ? `Automatic, ${step.label}: ${failedReason}` : `Automatic, ${step.label}: ${sent.body}`.slice(0, 1000), messageId: sent.messageId, at: now },
        });
        if (sent.delivery === "FAILED") summary.failed += 1;
        else summary.sent += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(`[recalls] the automatic message for recall ${r.id} failed`, err);
      }
    }
  }
  return summary;
}
