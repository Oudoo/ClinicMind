import type { PaymentMethod } from "@prisma/client";
import type { SeedContext } from "./index";
import { takeNumber } from "../../src/modules/finance/documents";
import { allocateCredit } from "../../src/modules/finance/allocations";
import { METHOD_LABELS, netPaid } from "../../src/modules/finance/constants";
import { cancelPlan, createPlan, instalmentMessage, settlePlan } from "../../src/modules/finance/instalments";
import { addMonthsToKey, coverInstalments } from "../../src/modules/finance/instalment-schedule";
import { addDays, dateKeyInTz, fromDateKey, startOfDayInTz, zonedParts, zonedTimeToUtc } from "../../src/lib/time";
import { isQuiet, quietEndOn, readReminderSettings } from "../../src/modules/messaging/reminder-settings";
import { notify } from "../../src/modules/notifications/service";

const TZ = "Africa/Cairo";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Instalment plans in the demo (Phase 5B), each paying for a treatment plan
 * the patient accepted, made through the plan service on the day the desk
 * agreed it, the payments towards them on the days they came in:
 *
 * - the laser course accepted six weeks ago: a quarter down, the first
 *   instalment five days overdue (the patient was reminded before it and
 *   written to the day after; the desk was told);
 * - a melasma plan: a quarter down, the next instalment due in two days
 *   (reminded yesterday);
 * - the hair restoration plan accepted ten days ago: the odd thousands down,
 *   five monthly instalments of 10,000 from next month;
 * - an acne plan paid in full in two instalments;
 * - a hair-loss plan stopped with the reason after its first instalment.
 *
 * Plans and payments go in before the cash drawer (a signed-off day takes no
 * more money); what the reminder job would have sent is written by
 * `seedInstalmentReminders`, after the consents.
 */

interface PlanSpec {
  /** The accepted treatment plan it pays for: the first or the last accepted with this heading. */
  quote: { title: string; which: "first" | "last" };
  /** The plan was agreed so many days after the quote was accepted, at this hour on the clinic clock (else half an hour after). */
  after: number;
  hour?: number;
  downPayment: (total: number) => number;
  count: number;
  /** The first instalment's day: so many days from today, on the day the plan is made, or (by default) a month after it. */
  firstDue?: { inDays: number } | "start";
  /** Paid at the desk: the down payment when the plan is made, then instalments by number (so many days after their day). */
  payments: { instalment: number; late?: number; method: PaymentMethod; reference?: string }[];
  stop?: { daysAgo: number; reason: string };
  note?: string;
}

const PLANS: PlanSpec[] = [
  {
    quote: { title: "Laser hair removal course", which: "first" },
    after: 9,
    hour: 12.5,
    downPayment: (t) => Math.round(t / 4 / 100) * 100,
    count: 3,
    payments: [{ instalment: 0, method: "CARD" }],
    note: "One payment a month while the sessions run.",
  },
  {
    quote: { title: "Melasma plan", which: "first" },
    after: 1,
    hour: 12,
    downPayment: (t) => Math.round(t / 4 / 100) * 100,
    count: 3,
    firstDue: { inDays: 2 },
    payments: [{ instalment: 0, method: "CASH" }],
  },
  {
    quote: { title: "Hair restoration plan", which: "last" },
    after: 2,
    hour: 12.5,
    downPayment: (t) => (t % 10_000) + 10_000,
    count: 5,
    payments: [{ instalment: 0, method: "BANK_TRANSFER", reference: "CIB transfer 5203" }],
    note: "The transplant date to be booked once the doctor confirms the graft count at the pre-op visit.",
  },
  {
    quote: { title: "Acne plan", which: "first" },
    after: 0,
    downPayment: () => 0,
    count: 2,
    firstDue: "start",
    payments: [
      { instalment: 1, method: "CASH" },
      { instalment: 2, method: "CARD" },
    ],
  },
  {
    quote: { title: "Hair loss plan", which: "last" },
    after: 0,
    downPayment: () => 0,
    count: 3,
    firstDue: "start",
    payments: [{ instalment: 1, method: "CASH" }],
    stop: { daysAgo: 4, reason: "He put the PRP course off to the new year: stopped until he books it." },
  },
];

const dayKey = (d: Date) => dateKeyInTz(d, TZ);

export async function seedInstalments(ctx: SeedContext): Promise<void> {
  const { db, tenantId, clinicId } = ctx;
  const desk = ctx.users.find((u) => u.email === "reception@demo.clinic") ?? ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? desk;
  const actor = { id: desk.id, email: desk.email };
  const now = ctx.today;
  /** On the day of `d` (clinic clock), at `hour`. */
  const onDay = (d: Date, hour: number) => {
    const p = zonedParts(d, TZ);
    return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(hour), minute: Math.round((hour % 1) * 60) }, TZ);
  };

  let made = 0;
  let paidIn = 0;
  for (const spec of PLANS) {
    const quote = await db.quote.findFirst({
      where: { tenantId, status: "ACCEPTED", title: spec.quote.title, acceptedAt: { not: null } },
      orderBy: { acceptedAt: spec.quote.which === "first" ? "asc" : "desc" },
      select: { id: true, title: true, patientId: true, acceptedAt: true, acceptedTotal: true, total: true },
    });
    if (!quote?.acceptedAt) continue;
    const total = quote.acceptedTotal ?? quote.total;
    const start = spec.hour === undefined && spec.after === 0 ? new Date(quote.acceptedAt.getTime() + 30 * MIN) : onDay(addDays(quote.acceptedAt, spec.after, TZ), spec.hour ?? 12);
    if (start.getTime() >= now.getTime()) continue;
    const startKey = dayKey(start);
    const firstDue = spec.firstDue === "start" ? startKey : spec.firstDue ? dayKey(addDays(now, spec.firstDue.inDays, TZ)) : addMonthsToKey(startKey, 1);
    const downPayment = spec.downPayment(total);
    if (firstDue < startKey || downPayment >= total || total - downPayment < spec.count) continue;

    const plan = await createPlan(
      tenantId,
      { patientId: quote.patientId, quoteId: quote.id, title: quote.title ?? "Treatment plan", total, downPayment, count: spec.count, everyMonths: 1, firstDue, reminderDays: 3, note: spec.note },
      actor,
      { now: start },
    );
    made += 1;

    for (const pay of spec.payments) {
      const instalment = plan.instalments.find((i) => i.number === pay.instalment);
      if (!instalment) continue;
      // At the desk when the plan was made, or on the instalment's day (so many days late) at noon.
      const due = fromDateKey(instalment.dueKey, TZ)!;
      const paidAt = instalment.dueKey === startKey && !pay.late ? new Date(start.getTime() + 2 * MIN) : onDay(addDays(due, pay.late ?? 0, TZ), 12 + (made % 3) * 0.75);
      if (paidAt.getTime() >= now.getTime()) continue;
      await db.$transaction(async (tx) => {
        const receipt = await takeNumber(tx, tenantId, clinicId, "RECEIPT");
        const payment = await tx.payment.create({
          data: {
            tenantId,
            patientId: quote.patientId,
            kind: "PAYMENT",
            method: pay.method,
            amount: instalment.amount,
            paidAt,
            reference: pay.reference ?? null,
            clinicId,
            receiptSequence: receipt.sequence,
            receiptNumber: receipt.number,
            instalmentPlanId: plan.id,
            createdById: desk.id,
            createdAt: paidAt,
          },
          select: { id: true },
        });
        await settlePlan(tx, tenantId, plan.id, paidAt);
        await tx.timelineEvent.create({
          data: {
            tenantId,
            patientId: quote.patientId,
            kind: "PAYMENT",
            title: `Payment — ${instalment.amount.toLocaleString("en-US")} EGP (${METHOD_LABELS[pay.method].toLowerCase()})`,
            body: [`Instalment plan: ${plan.title}`, pay.reference ? `Ref ${pay.reference}` : null].filter(Boolean).join(" · "),
            refId: payment.id,
            occurredAt: paidAt,
          },
        });
        await allocateCredit(tx, tenantId, quote.patientId, desk.id);
      });
      paidIn += instalment.amount;
    }

    if (spec.stop) {
      const when = onDay(addDays(now, -spec.stop.daysAgo, TZ), 13.25);
      if (when.getTime() > start.getTime()) await cancelPlan(tenantId, plan.id, { reason: spec.stop.reason }, { id: owner.id, email: owner.email }, { now: when });
    }
  }
  console.log(`     ${made} instalment plans, ${paidIn.toLocaleString("en-US")} EGP paid towards them`);
}

/**
 * What the instalment reminder job would have sent so far, as it sends it:
 * on its first pass after the quiet hours of the day an instalment comes
 * within its plan's reminder days (or when the plan was made, if later), the
 * reminder, unless it was paid by then; on the day after an instalment's day
 * still owed, the overdue message and the desk told. Each claimed once, a
 * patient who had said no to reminders gets no message. Runs after the
 * consents, which say who had said no and when.
 */
export async function seedInstalmentReminders(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const now = ctx.today;
  const [settings, tenant, clinic] = await Promise.all([
    readReminderSettings(tenantId),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    db.clinic.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { phone: true } }),
  ]);
  /** The job's pass a few minutes after `t`, or after the quiet hours `t` falls in. */
  const pass = (t: Date, minutes: number) => {
    const awake = !isQuiet(t, TZ, settings) ? t : quietEndOn(t, TZ, settings).getTime() > t.getTime() ? quietEndOn(t, TZ, settings) : quietEndOn(t, TZ, settings, 1);
    return new Date(awake.getTime() + minutes * MIN);
  };
  const plans = await db.instalmentPlan.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    include: {
      patient: { select: { id: true, fullName: true, language: true, phone: true, whatsapp: true, reminderConsent: true, reminderConsentAt: true } },
      instalments: { orderBy: { number: "asc" } },
      payments: { where: { deletedAt: null }, select: { kind: true, amount: true, paidAt: true } },
    },
  });

  let sent = 0;
  let overdue = 0;
  for (const [index, plan] of plans.entries()) {
    const p = plan.patient;
    const scheduled = plan.instalments.map((i) => ({ number: i.number, dueKey: dateKeyInTz(i.dueAt, TZ), amount: i.amount }));
    const owedAt = (number: number, t: Date) =>
      coverInstalments(scheduled, netPaid(plan.payments.filter((x) => x.paidAt.getTime() <= t.getTime())), dateKeyInTz(t, TZ), plan.reminderDays).find((i) => i.number === number)?.owed ?? 0;
    const activeAt = (t: Date) => t.getTime() >= plan.createdAt.getTime() && (!plan.cancelledAt || t < plan.cancelledAt) && (!plan.completedAt || t < plan.completedAt) && t.getTime() < now.getTime();
    // Said no before then (and has not said yes again since): no message, the claim still made.
    const consented = (t: Date) => p.reminderConsent || !p.reminderConsentAt || p.reminderConsentAt.getTime() > t.getTime();
    const reachable = Boolean(p.whatsapp ?? p.phone);
    const count = plan.instalments.filter((i) => i.number > 0).length;

    for (const i of plan.instalments) {
      // Before its day, within the plan's reminder days (the down payment has none).
      if (i.number > 0) {
        const opens = startOfDayInTz(addDays(i.dueAt, -plan.reminderDays, TZ), TZ);
        const at = pass(new Date(Math.max(opens.getTime(), plan.createdAt.getTime())), 6 + ((index * 7 + i.number * 3) % 19));
        const owed = owedAt(i.number, at);
        if (activeAt(at) && owed > 0) {
          await db.instalment.update({ where: { id: i.id }, data: { remindedAt: at } });
          if (consented(at) && reachable) {
            await write(p.id, at, instalmentMessage({ kind: "due", language: p.language === "en" ? "en" : "ar", patientName: p.fullName, clinicName: tenant.name, clinicPhone: clinic?.phone ?? null, title: plan.title, number: i.number, count, amount: owed, dueAt: i.dueAt, timezone: TZ }), "instalment:due", plan.id, i.number);
            sent += 1;
          }
        }
      }
      // The day after its day, still owed: the overdue message, and the desk and the owner told.
      const after = pass(startOfDayInTz(addDays(i.dueAt, 1, TZ), TZ), 6 + ((index * 5 + i.number) % 19));
      const owed = owedAt(i.number, after);
      if (activeAt(after) && owed > 0 && now.getTime() - after.getTime() <= 30 * DAY) {
        await db.instalment.update({ where: { id: i.id }, data: { overdueRemindedAt: after } });
        overdue += 1;
        if (consented(after) && reachable) {
          await write(p.id, after, instalmentMessage({ kind: "overdue", language: p.language === "en" ? "en" : "ar", patientName: p.fullName, clinicName: tenant.name, clinicPhone: clinic?.phone ?? null, title: plan.title, number: i.number, count, amount: owed, dueAt: i.dueAt, timezone: TZ }), "instalment:overdue", plan.id, i.number);
          sent += 1;
        }
        const before = new Date();
        await notify(tenantId, {
          kind: "INSTALMENT_OVERDUE",
          level: "WARNING",
          title: `An instalment is overdue: ${p.fullName}`,
          body: `${p.fullName} · ${plan.title} · ${owed.toLocaleString("en-US")} EGP`,
          href: "/dashboard/finance/instalments?view=overdue",
          entity: "InstalmentPlan",
          roles: ["RECEPTIONIST", "CLINIC_OWNER"],
        });
        // Seen by the desk the same morning when it is more than two days old.
        const old = now.getTime() - after.getTime() > 2 * DAY;
        await db.notification.updateMany({ where: { tenantId, kind: "INSTALMENT_OVERDUE", createdAt: { gte: before } }, data: { createdAt: after, readAt: old ? new Date(after.getTime() + HOUR) : null } });
      }
    }
  }
  console.log(`     instalment reminders: ${sent} messages, ${overdue} overdue`);

  /** One automatic WhatsApp message on the patient's thread, dated when the job sent it. */
  async function write(patientId: string, when: Date, body: string, templateKey: string, planId: string, number: number) {
    const found = await db.conversation.findFirst({ where: { tenantId, patientId, channel: "WHATSAPP" }, orderBy: { updatedAt: "desc" }, select: { id: true, lastOutboundAt: true, updatedAt: true } });
    const p = plans.find((x) => x.patientId === patientId)!.patient;
    const conversation =
      found ??
      (await db.conversation.create({
        data: { tenantId, patientId, channel: "WHATSAPP", contactName: p.fullName, contactPhone: p.whatsapp ?? p.phone, locale: p.language, status: "WAITING_ON_PATIENT", createdAt: when, updatedAt: when },
        select: { id: true, lastOutboundAt: true, updatedAt: true },
      }));
    await db.message.create({
      data: { tenantId, conversationId: conversation.id, direction: "OUTBOUND", body, author: "SYSTEM", delivery: "LOGGED", templateKey, meta: { instalmentPlanId: planId, instalment: number }, createdAt: when },
    });
    await db.conversation.update({
      where: { id: conversation.id },
      data: {
        lastOutboundAt: !conversation.lastOutboundAt || conversation.lastOutboundAt < when ? when : conversation.lastOutboundAt,
        updatedAt: conversation.updatedAt < when ? when : conversation.updatedAt,
      },
    });
  }
}
