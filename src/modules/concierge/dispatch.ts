import type { ConciergeTask, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendPatientMessage } from "@/modules/messaging/outbound";
import { missedSummary } from "./answers";
import { ConciergeError, ConciergeNotFoundError } from "./errors";
import { notifyOverdueEscalations, openEscalation } from "./escalations";
import { buildStepMessage, parseSteps, pickLanguage, stepHasHighRisk } from "./protocols";
import { firstName, getClinicInfo, SYSTEM_ACTOR, type Actor, type ClinicInfo } from "./shared";
import { checkInLink, checkInTokenHash, newCheckInToken } from "./tokens";

/**
 * Dispatch: the minute-by-minute engine behind the protocols.
 *
 *  - PENDING tasks that are due on ACTIVE enrolments go out through
 *    `sendPatientMessage` (WhatsApp when connected, logged on the patient's
 *    conversation otherwise). Check-ins and photo requests carry a fresh
 *    single-use link; only the token's hash is stored. Each task is claimed
 *    with a conditional update before its message is built, so two schedulers
 *    (two server processes, or the cron endpoint) never send it twice.
 *  - A step more than a day late (the enrolment was paused, or the procedure
 *    signed days after it was performed) is skipped instead of sent: nobody
 *    wants five old check-ins at once. Staff can still "Send now".
 *  - A check-in still unanswered 24 h after it went out gets one reminder
 *    (with a fresh link; the latest link is the valid one); after 48 h it is
 *    MISSED, and a missed step that carried a high-risk question opens a WATCH
 *    escalation ("No answer to the day-7 check-in").
 *  - An enrolment whose steps are all done becomes COMPLETED.
 *  - OPEN escalations past their target are re-notified (every 30 minutes).
 *
 * `attempts` counts the messages of the current send: 1 once sent, 2 once
 * reminded; while a task is still PENDING it counts failed tries.
 */
export const REMINDER_AFTER_MS = 24 * 3_600_000;
export const MISSED_AFTER_MS = 48 * 3_600_000;
/** A pending step this late is skipped rather than sent. */
export const STALE_AFTER_MS = 24 * 3_600_000;
/** Give up on a step after this many failed send attempts. */
export const MAX_SEND_ATTEMPTS = 5;
const BATCH = 200;

const sendInclude = {
  enrolment: {
    include: {
      patient: { select: { id: true, fullName: true, language: true, deletedAt: true } },
      protocol: { select: { id: true, steps: true, treatment: { select: { key: true } } } },
    },
  },
} satisfies Prisma.ConciergeTaskInclude;

type SendableTask = Prisma.ConciergeTaskGetPayload<{ include: typeof sendInclude }>;

export interface SendResult {
  task: ConciergeTask;
  /** The public link that went out (null for instructions). */
  link: string | null;
  messageId: string;
  conversationId: string;
  delivery: string;
}

interface SendOptions {
  now: Date;
  /** A reminder keeps the original `sentAt`; a (re)send resets it. */
  reminder: boolean;
  clinic?: ClinicInfo;
}

/** The message for one task, with a fresh link for check-ins and photo requests. */
async function compose(task: SendableTask, opts: SendOptions) {
  const { enrolment } = task;
  const step = parseSteps(enrolment.protocol.steps)[task.stepIndex];
  if (!step) throw new ConciergeError("no_steps", "this step no longer exists in the protocol");
  const clinic = opts.clinic ?? (await getClinicInfo(task.tenantId));
  const language = pickLanguage(enrolment.language);
  const token = step.kind === "INSTRUCTION" ? null : newCheckInToken();
  const link = token ? checkInLink(token) : null;
  const body = buildStepMessage(step, {
    language,
    clinicName: clinic.name,
    clinicPhone: clinic.phone,
    patientFirstName: firstName(enrolment.patient.fullName),
    link,
    reminder: opts.reminder,
  });
  return { step, token, link, body };
}

async function deliver(task: SendableTask, body: string, reminder: boolean) {
  const { enrolment } = task;
  return sendPatientMessage(task.tenantId, {
    patientId: enrolment.patientId,
    body,
    channel: enrolment.channel,
    templateKey: `concierge:${enrolment.protocol.treatment.key}:${task.stepIndex}`,
    author: "SYSTEM",
    meta: { conciergeTaskId: task.id, enrolmentId: enrolment.id, stepIndex: task.stepIndex, kind: task.kind, reminder },
  });
}

function failedDelivery(delivery: string, reason: string | null | undefined): string | null {
  return delivery === "FAILED" ? `Delivery failed${reason ? `: ${reason}` : ""}`.slice(0, 500) : null;
}

// ── Manual re-send ───────────────────────────────────────────────────────────

/** "Re-send this step now": a fresh message (and link) regardless of the schedule; the previous link stops working. */
export async function sendTaskNow(tenantId: string, taskId: string, actor: Actor = {}, now = new Date()): Promise<SendResult> {
  const task = await db.conciergeTask.findFirst({ where: { id: taskId, tenantId }, include: sendInclude });
  if (!task) throw new ConciergeNotFoundError("task", taskId);
  if (task.enrolment.status === "STOPPED" || task.enrolment.status === "COMPLETED") {
    throw new ConciergeError("invalid_state", `the enrolment is ${task.enrolment.status.toLowerCase()}; nothing more goes out`);
  }
  if (task.status === "ANSWERED") throw new ConciergeError("already_answered", "this step is already answered");
  if (task.enrolment.patient.deletedAt) throw new ConciergeError("invalid_state", "the patient record is archived");
  const { token, link, body } = await compose(task, { now, reminder: false });
  const sent = await deliver(task, body, false);
  const updated = await db.conciergeTask.update({
    where: { id: task.id },
    data: {
      status: "SENT",
      sentAt: now,
      missedAt: null,
      attempts: 1,
      messageId: sent.messageId,
      lastError: failedDelivery(sent.delivery, null),
      tokenHash: token ? checkInTokenHash(token) : null,
    },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.task.resend",
    entity: "ConciergeTask",
    entityId: taskId,
    before: { status: task.status, attempts: task.attempts },
    after: { status: updated.status, attempts: updated.attempts, messageId: sent.messageId, delivery: sent.delivery },
  });
  return { task: updated, link, messageId: sent.messageId, conversationId: sent.conversationId, delivery: sent.delivery };
}

// ── The per-minute passes ────────────────────────────────────────────────────

/** Send every PENDING task that is due on an ACTIVE enrolment; skip the ones more than a day late. */
export async function dispatchDueTasks(tenantId: string, now = new Date()): Promise<{ sent: number; failed: number; skipped: number }> {
  const stale = await db.conciergeTask.updateMany({
    where: { tenantId, status: "PENDING", dueAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) }, enrolment: { status: "ACTIVE" } },
    data: { status: "SKIPPED", lastError: "Not sent: more than a day late (the follow-up was paused or signed late)" },
  });
  const due = await db.conciergeTask.findMany({
    where: { tenantId, status: "PENDING", dueAt: { lte: now }, enrolment: { status: "ACTIVE", patient: { deletedAt: null } } },
    orderBy: [{ dueAt: "asc" }],
    take: BATCH,
    include: sendInclude,
  });
  if (!due.length) return { sent: 0, failed: 0, skipped: stale.count };
  const clinic = await getClinicInfo(tenantId);
  let sent = 0;
  let failed = 0;
  for (const task of due) {
    let composed: Awaited<ReturnType<typeof compose>>;
    try {
      composed = await compose(task, { now, reminder: false, clinic });
    } catch (err) {
      failed += 1;
      await recordFailure(task, err);
      continue;
    }
    // Claim: only the scheduler that flips PENDING → SENT sends the message.
    const claimed = await db.conciergeTask.updateMany({
      where: { id: task.id, status: "PENDING" },
      data: { status: "SENT", sentAt: now, missedAt: null, attempts: 1, tokenHash: composed.token ? checkInTokenHash(composed.token) : null },
    });
    if (!claimed.count) continue;
    try {
      const result = await deliver(task, composed.body, false);
      await db.conciergeTask.update({ where: { id: task.id }, data: { messageId: result.messageId, lastError: failedDelivery(result.delivery, null) } });
      sent += 1;
    } catch (err) {
      failed += 1;
      // Put it back for the next minute (or give up after five tries).
      const giveUp = task.attempts + 1 >= MAX_SEND_ATTEMPTS;
      await db.conciergeTask
        .update({
          where: { id: task.id },
          data: { status: giveUp ? "SKIPPED" : "PENDING", sentAt: null, tokenHash: null, attempts: task.attempts + 1, lastError: errorText(err) },
        })
        .catch(() => undefined);
      console.error(`[concierge] send failed for task ${task.id}${giveUp ? " (giving up)" : ""}`, err);
    }
  }
  return { sent, failed, skipped: stale.count };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

async function recordFailure(task: ConciergeTask, err: unknown): Promise<void> {
  const giveUp = task.attempts + 1 >= MAX_SEND_ATTEMPTS;
  await db.conciergeTask
    .updateMany({ where: { id: task.id, status: task.status }, data: { attempts: { increment: 1 }, lastError: errorText(err), ...(giveUp ? { status: "SKIPPED" } : {}) } })
    .catch(() => undefined);
  console.error(`[concierge] send failed for task ${task.id}${giveUp ? " (giving up)" : ""}`, err);
}

/** One reminder for check-ins and photo requests unanswered 24 h after they went out. */
export async function sendReminders(tenantId: string, now = new Date()): Promise<number> {
  const stale = await db.conciergeTask.findMany({
    where: {
      tenantId,
      status: "SENT",
      kind: { not: "INSTRUCTION" },
      attempts: { lt: 2 },
      sentAt: { lte: new Date(now.getTime() - REMINDER_AFTER_MS), gt: new Date(now.getTime() - MISSED_AFTER_MS) },
      enrolment: { status: "ACTIVE", patient: { deletedAt: null } },
    },
    orderBy: [{ sentAt: "asc" }],
    take: BATCH,
    include: sendInclude,
  });
  if (!stale.length) return 0;
  const clinic = await getClinicInfo(tenantId);
  let reminded = 0;
  for (const task of stale) {
    let composed: Awaited<ReturnType<typeof compose>>;
    try {
      composed = await compose(task, { now, reminder: true, clinic });
    } catch (err) {
      await recordFailure(task, err);
      continue;
    }
    // Claim the reminder (attempts 1 → 2) and switch the link in one step.
    const claimed = await db.conciergeTask.updateMany({
      where: { id: task.id, status: "SENT", attempts: { lt: 2 } },
      data: { attempts: 2, ...(composed.token ? { tokenHash: checkInTokenHash(composed.token) } : {}) },
    });
    if (!claimed.count) continue;
    try {
      const result = await deliver(task, composed.body, true);
      await db.conciergeTask.update({ where: { id: task.id }, data: { messageId: result.messageId, lastError: failedDelivery(result.delivery, null) } });
      reminded += 1;
    } catch (err) {
      // The first link is gone; the patient can still be sent a fresh one with "Send now".
      await db.conciergeTask.update({ where: { id: task.id }, data: { lastError: `Reminder failed: ${errorText(err)}`.slice(0, 500) } }).catch(() => undefined);
      console.error(`[concierge] reminder failed for task ${task.id}`, err);
    }
  }
  return reminded;
}

/** Check-ins unanswered 48 h after they went out are MISSED; high-risk ones open a WATCH escalation. */
export async function markMissedTasks(tenantId: string, now = new Date()): Promise<{ missed: number; escalated: number }> {
  const overdue = await db.conciergeTask.findMany({
    where: {
      tenantId,
      status: "SENT",
      kind: { not: "INSTRUCTION" },
      sentAt: { lte: new Date(now.getTime() - MISSED_AFTER_MS) },
      enrolment: { status: { in: ["ACTIVE", "PAUSED"] } },
    },
    orderBy: [{ sentAt: "asc" }],
    take: BATCH,
    include: sendInclude,
  });
  let missed = 0;
  let escalated = 0;
  for (const task of overdue) {
    const changed = await db.conciergeTask.updateMany({ where: { id: task.id, status: "SENT" }, data: { status: "MISSED", missedAt: now } });
    if (!changed.count) continue;
    missed += 1;
    const step = parseSteps(task.enrolment.protocol.steps)[task.stepIndex];
    if (!step || !stepHasHighRisk(step)) continue;
    try {
      await openEscalation(tenantId, {
        level: "WATCH",
        summary: missedSummary(step),
        patientId: task.enrolment.patientId,
        patientName: task.enrolment.patient.fullName,
        enrolmentId: task.enrolment.id,
        details: { reason: "missed", taskId: task.id, stepIndex: task.stepIndex },
        now,
        actor: SYSTEM_ACTOR,
      });
      escalated += 1;
    } catch (err) {
      console.error(`[concierge] missed-step escalation failed for task ${task.id}`, err);
    }
  }
  return { missed, escalated };
}

/** ACTIVE enrolments with nothing left to send or wait for become COMPLETED. */
export async function completeEnrolments(tenantId: string, now = new Date()): Promise<number> {
  const done = await db.conciergeEnrolment.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      tasks: { some: {}, none: { OR: [{ status: "PENDING" }, { status: "SENT", kind: { not: "INSTRUCTION" } }] } },
    },
    select: { id: true, patientId: true },
    take: BATCH,
  });
  if (!done.length) return 0;
  const completed = await db.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const e of done) {
      const changed = await tx.conciergeEnrolment.updateMany({ where: { id: e.id, status: "ACTIVE" }, data: { status: "COMPLETED", completedAt: now } });
      if (changed.count) ids.push(e.id);
    }
    const rows = done.filter((e) => ids.includes(e.id));
    if (rows.length) {
      await tx.timelineEvent.createMany({
        data: rows.map((e) => ({ tenantId, patientId: e.patientId, kind: "CHECK_IN" as const, title: "Concierge follow-up completed", refId: e.id, occurredAt: now })),
      });
    }
    return rows.length;
  });
  return completed;
}

export interface DispatchSummary {
  sent: number;
  failed: number;
  skipped: number;
  reminders: number;
  missed: number;
  escalated: number;
  completed: number;
}

/** All four passes for one tenant; one audit row when anything changed. */
export async function runConciergeDispatchForTenant(tenantId: string, now = new Date()): Promise<DispatchSummary> {
  const { sent, failed, skipped } = await dispatchDueTasks(tenantId, now);
  const reminders = await sendReminders(tenantId, now);
  const { missed, escalated } = await markMissedTasks(tenantId, now);
  const completed = await completeEnrolments(tenantId, now);
  const summary = { sent, failed, skipped, reminders, missed, escalated, completed };
  if (sent || failed || skipped || reminders || missed || completed) {
    await audit({ tenantId, actorEmail: SYSTEM_ACTOR.email, action: "concierge.dispatch", entity: "ConciergeTask", after: summary });
  }
  return summary;
}

async function activeTenantIds(): Promise<string[]> {
  const rows = await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Job "concierge-dispatch": every active tenant, every minute. */
export async function runConciergeDispatch(now = new Date()): Promise<string> {
  const totals: DispatchSummary = { sent: 0, failed: 0, skipped: 0, reminders: 0, missed: 0, escalated: 0, completed: 0 };
  for (const tenantId of await activeTenantIds()) {
    try {
      const s = await runConciergeDispatchForTenant(tenantId, now);
      for (const k of Object.keys(totals) as (keyof DispatchSummary)[]) totals[k] += s[k];
    } catch (err) {
      console.error(`[concierge] dispatch failed for tenant ${tenantId}`, err);
    }
  }
  return `sent ${totals.sent}, reminders ${totals.reminders}, missed ${totals.missed} (${totals.escalated} escalated), completed ${totals.completed}${totals.skipped ? `, skipped ${totals.skipped} late` : ""}${totals.failed ? `, failed ${totals.failed}` : ""}`;
}

/** Job "concierge-ack-overdue": OPEN escalations past their target, every 5 minutes. */
export async function runAckOverdue(now = new Date()): Promise<string> {
  let notified = 0;
  for (const tenantId of await activeTenantIds()) {
    try {
      notified += await notifyOverdueEscalations(tenantId, now);
    } catch (err) {
      console.error(`[concierge] overdue check failed for tenant ${tenantId}`, err);
    }
  }
  return `re-notified ${notified} overdue escalation${notified === 1 ? "" : "s"}`;
}
