import { crc32, deflateSync } from "node:zlib";
import type { Prisma } from "@prisma/client";
import type { SeedContext } from "./index";
import { makeRandom, type Random } from "./util";
import { ensureDefaultProtocols, planTasks } from "../../src/modules/concierge/service";
import { buildStepMessage, dayLabel, parseSteps, pickLanguage, protocolLengthDays, stepHasHighRisk, stepHeading, type ProtocolQuestion, type ProtocolStep } from "../../src/modules/concierge/protocols";
import { triageAnswers, type TriageFlag, type TriageLevel } from "../../src/modules/concierge/triage";
import { formatAnswer, summarizeCheckIn, TRIAGE_LABEL } from "../../src/modules/concierge/answers";
import { checkInLink, checkInTokenHash, newCheckInToken } from "../../src/modules/concierge/tokens";
import { DEFAULT_CONCIERGE_SETTINGS, isWithinHours, SETTINGS_KEY, type ConciergeSettings } from "../../src/modules/concierge/settings";

/**
 * Protocols per treatment, enrolments on the signed procedures, tasks,
 * check-ins and escalations.
 *
 * Every SIGNED procedure the finance seed created is enrolled in the active
 * (default) protocol of its treatment, with its steps backdated from
 * `performedAt` on the clinic clock: steps already due went out (~88 % of the
 * check-ins whose 48-hour window closed were answered, mostly inside the
 * expected ranges with 4–5 stars, some 3; ~12 % missed), check-ins sent in the
 * last two days are awaiting an answer (reminded after 24 h), later steps are
 * pending. Recent follow-ups also get the WhatsApp messages that went out
 * (logged on the patient's conversation, the open links working). Six
 * escalations: two open high-risk replies (5 and 40 minutes old, the second
 * past its target), one open watch item, two resolved within target and one
 * acknowledged late. The roster: the nurse in hours, doctor@demo.clinic out
 * of hours, the owner as backup. Deterministic (makeRandom(21)); everything
 * goes in with createMany.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Follow-ups this recent also get the messages that went out (older ones are history). */
const MESSAGES_WITHIN_DAYS = 60;
const LINK_TTL_MS = 7 * DAY;

// ── Placeholder photos ───────────────────────────────────────────────────────

/** A small RGB PNG drawn pixel by pixel (no image library in the seed). */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A soft scalp-like study per view: skin tone, a darker band of hair where the view would show it. */
function placeholderPhoto(view: string): Buffer {
  const size = 160;
  const band = view === "top" ? [0, 0.55] : view === "donor" ? [0.35, 1] : [0, 0.3];
  return png(size, size, (x, y) => {
    const dx = x / size - 0.5;
    const dy = y / size - 0.45;
    const light = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 1.4);
    const v = y / size;
    const hair = v >= band[0]! && v <= band[1]! ? 0.55 + 0.1 * Math.sin(x * 0.9) : 1;
    const r = Math.round((150 + 80 * light) * hair);
    const g = Math.round((110 + 70 * light) * hair);
    const b = Math.round((90 + 55 * light) * hair);
    return [Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  });
}

// ── Answers ──────────────────────────────────────────────────────────────────

const COMMENTS = {
  en: ["Everything is fine, thank you.", "Very happy with the team so far.", "A little itchy at night but OK.", "Thanks for checking in!"],
  ar: ["الحمد لله كله تمام", "شكراً على المتابعة", "شوية هرش بالليل بس تمام", "مبسوط جداً من الفريق"],
};

/** An answer inside the question's expected range (and never in its danger range). */
function inRange(q: ProtocolQuestion, r: Random, language: "ar" | "en"): unknown {
  if (q.type === "yesno") return typeof q.expected?.value === "boolean" ? q.expected.value : r.chance(0.5);
  if (q.type === "text") return r.chance(0.3) ? r.pick(COMMENTS[language]) : undefined;
  const min = q.min ?? 0;
  const max = q.max ?? (q.type === "scale" ? 10 : 100);
  let lo = q.expected?.min ?? min;
  let hi = q.expected?.max ?? max;
  if (q.danger?.min !== undefined) hi = Math.min(hi, q.danger.min - 1);
  if (q.danger?.max !== undefined) lo = Math.max(lo, q.danger.max + 1);
  if (hi < lo) hi = lo;
  // Pain-like scales sit low, "how happy / how improved" ones high.
  return q.expected?.max !== undefined ? lo + Math.floor(r.rand() * r.rand() * (hi - lo + 1)) : hi - Math.floor(r.rand() * r.rand() * (hi - lo + 1));
}

function answersFor(step: ProtocolStep, r: Random, language: "ar" | "en"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of step.questions ?? []) {
    const v = inRange(q, r, language);
    if (v !== undefined) out[q.key] = v;
  }
  return out;
}

/** Push one high-risk question out of range: a red-flag yes, or a scale into its danger range. */
function highRiskAnswers(step: ProtocolStep, base: Record<string, unknown>, r: Random): Record<string, unknown> | null {
  const qs = (step.questions ?? []).filter((q) => (q.type === "yesno" && q.highRisk && typeof q.expected?.value === "boolean") || (q.type === "scale" && q.danger?.min !== undefined));
  if (!qs.length) return null;
  const q = r.pick(qs);
  return { ...base, [q.key]: q.type === "yesno" ? !q.expected!.value : Math.min(q.max ?? 10, q.danger!.min! + r.between(0, 1)) };
}

/** Push a non-high-risk question just outside its expected range (WATCH). */
function watchAnswers(step: ProtocolStep, base: Record<string, unknown>): Record<string, unknown> | null {
  const q = (step.questions ?? []).find((x) => x.type === "scale" && x.expected?.max !== undefined && (x.danger?.min === undefined || x.danger.min > x.expected.max + 1) && !x.highRisk);
  if (!q) return null;
  return { ...base, [q.key]: q.expected!.max! + 1 };
}

function flagSummary(step: ProtocolStep, flags: TriageFlag[]): string {
  const byKey = new Map((step.questions ?? []).map((q) => [q.key, q]));
  return flags.map((f) => (byKey.get(f.key) ? `${f.key} ${formatAnswer(byKey.get(f.key)!, f.value)}` : f.label)).join(", ");
}

// ── Seed ─────────────────────────────────────────────────────────────────────

export async function seedConcierge(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const r = makeRandom(21);
  let seq = 0;
  const cid = (prefix: string) => `${prefix}${(++seq).toString(36).padStart(5, "0")}${Math.floor(r.rand() * 36 ** 8).toString(36).padStart(8, "0")}`;
  const now = ctx.today;

  await ensureDefaultProtocols(tenantId, db);

  // The roster: the nurse in hours, doctor@demo.clinic out of hours, the owner as backup.
  const nurse = ctx.users.find((u) => u.role === "NURSE");
  const doctor = ctx.users.find((u) => u.email === "doctor@demo.clinic") ?? ctx.users.find((u) => u.role === "DOCTOR");
  const owner = ctx.users.find((u) => u.email === "owner@demo.clinic") ?? ctx.users.find((u) => u.role === "CLINIC_OWNER");
  const settings: ConciergeSettings = {
    ...DEFAULT_CONCIERGE_SETTINGS,
    roster: { inHoursUserId: nurse?.id ?? null, outOfHoursUserId: doctor?.id ?? null, backupUserId: owner?.id ?? null },
  };
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, settings: true } });
  const current = tenant.settings && typeof tenant.settings === "object" && !Array.isArray(tenant.settings) ? (tenant.settings as Record<string, unknown>) : {};
  await db.tenant.update({ where: { id: tenantId }, data: { settings: { ...current, [SETTINGS_KEY]: settings } as unknown as Prisma.InputJsonObject } });

  const procedures = await db.procedure.findMany({
    where: { tenantId, status: "SIGNED", deletedAt: null, enrolment: null },
    orderBy: { performedAt: "asc" },
    select: {
      id: true,
      performedAt: true,
      signedAt: true,
      treatmentId: true,
      patient: { select: { id: true, fullName: true, language: true, phone: true, whatsapp: true, deletedAt: true } },
      treatment: { select: { key: true, name: true } },
    },
  });
  if (!procedures.length) {
    console.log("     concierge: no signed procedures to enrol (the finance seed created none); protocols and the roster only.");
    return;
  }

  const [protocolRows, clinic] = await Promise.all([
    db.protocol.findMany({ where: { tenantId, status: "ACTIVE" } }),
    db.clinic.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { timezone: true, phone: true } }),
  ]);
  const tz = clinic?.timezone || "Africa/Cairo";
  const protocols = new Map(protocolRows.map((p) => [p.treatmentId, { row: p, steps: parseSteps(p.steps) }]));
  const photos = new Map(["front", "top", "donor"].map((v) => [v, placeholderPhoto(v)]));
  const photoFor = (view: string) => photos.get(view) ?? photos.get("front")!;

  const enrolments: Prisma.ConciergeEnrolmentCreateManyInput[] = [];
  const tasks: (Prisma.ConciergeTaskCreateManyInput & { id: string })[] = [];
  const checkIns: Prisma.CheckInCreateManyInput[] = [];
  const blobs: Prisma.FileBlobCreateManyInput[] = [];
  const documents: Prisma.DocumentCreateManyInput[] = [];
  const escalations: Prisma.EscalationCreateManyInput[] = [];
  const timeline: Prisma.TimelineEventCreateManyInput[] = [];
  const messages: Prisma.MessageCreateManyInput[] = [];
  const conversations: Prisma.ConversationCreateManyInput[] = [];

  /** Every check-in row, with what it needs to become an escalation scenario later. */
  interface Answered {
    taskId: string;
    checkIn: Prisma.CheckInCreateManyInput & { id: string };
    step: ProtocolStep;
    enrolmentId: string;
    patientId: string;
    sentAt: Date;
    active: boolean;
  }
  const answered: Answered[] = [];
  const open: { taskId: string; enrolmentId: string; patientId: string }[] = [];

  let skipped = 0;
  let pausedOne = false;
  let stoppedOne = false;

  for (const proc of procedures) {
    const protocol = protocols.get(proc.treatmentId);
    if (!protocol || !protocol.steps.length || proc.patient.deletedAt) {
      skipped += 1;
      continue;
    }
    const { steps } = protocol;
    const language = pickLanguage(proc.patient.language);
    const plan = planTasks(steps, proc.performedAt, tz);
    const enrolmentId = cid("cnce");
    const signedAt = proc.signedAt ?? proc.performedAt;
    const allPast = plan.every((t) => t.dueAt.getTime() < now.getTime() - 2 * DAY);
    let status: "ACTIVE" | "PAUSED" | "COMPLETED" | "STOPPED" = allPast ? "COMPLETED" : "ACTIVE";
    // One paused and one stopped follow-up among the running ones, for the controls.
    const startedDaysAgo = (now.getTime() - proc.performedAt.getTime()) / DAY;
    if (status === "ACTIVE" && !pausedOne && proc.treatment.key === "acne" && startedDaysAgo >= 3) {
      status = "PAUSED";
      pausedOne = true;
    } else if (status === "ACTIVE" && !stoppedOne && proc.treatment.key === "general-dermatology" && startedDaysAgo >= 2) {
      status = "STOPPED";
      stoppedOne = true;
    }
    const pausedAt = status === "PAUSED" ? new Date(now.getTime() - 2 * DAY) : null;
    const stoppedAt = status === "STOPPED" ? new Date(Math.min(now.getTime() - DAY, proc.performedAt.getTime() + 2 * DAY)) : null;
    const withMessages = startedDaysAgo <= MESSAGES_WITHIN_DAYS && status !== "COMPLETED";

    // The patient's WhatsApp thread for the messages, found or opened.
    let conversationId: string | null = null;
    if (withMessages) {
      const existing = conversations.find((c) => c.patientId === proc.patient.id);
      const found = existing
        ? { id: existing.id! }
        : await db.conversation.findFirst({ where: { tenantId, patientId: proc.patient.id, channel: "WHATSAPP" }, orderBy: { updatedAt: "desc" }, select: { id: true } });
      conversationId = found?.id ?? cid("cncv");
      if (!found) {
        conversations.push({
          id: conversationId,
          tenantId,
          patientId: proc.patient.id,
          channel: "WHATSAPP",
          contactName: proc.patient.fullName,
          contactPhone: proc.patient.whatsapp ?? proc.patient.phone,
          locale: language,
          status: "WAITING_ON_PATIENT",
          createdAt: signedAt,
          updatedAt: signedAt,
        });
      }
    }
    const message = (body: string, at: Date, taskId: string, stepIndex: number, kind: string, reminder: boolean) => {
      const id = cid("cncm");
      messages.push({
        id,
        tenantId,
        conversationId: conversationId!,
        direction: "OUTBOUND",
        body,
        author: "SYSTEM",
        delivery: "LOGGED",
        templateKey: `concierge:${proc.treatment.key}:${stepIndex}`,
        meta: { conciergeTaskId: taskId, enrolmentId, stepIndex, kind, reminder },
        createdAt: at,
      });
      return id;
    };

    let lastDone: Date = signedAt;
    for (const t of plan) {
      const step = steps[t.stepIndex]!;
      const id = cid("cnct");
      const due = t.dueAt;
      const base: Prisma.ConciergeTaskCreateManyInput & { id: string } = {
        id,
        tenantId,
        enrolmentId,
        stepIndex: t.stepIndex,
        kind: t.kind,
        title: t.title,
        dueAt: due,
        status: "PENDING",
        attempts: 0,
        createdAt: signedAt,
      };
      const stoppedBefore = stoppedAt && due.getTime() > stoppedAt.getTime();
      const pausedBefore = pausedAt && due.getTime() > pausedAt.getTime();
      if (due.getTime() > now.getTime() || pausedBefore || stoppedBefore) {
        tasks.push({ ...base, status: stoppedBefore ? "SKIPPED" : "PENDING" });
        continue;
      }

      const sentAt = new Date(due.getTime() + r.between(0, 3) * MIN);
      const age = now.getTime() - sentAt.getTime();
      const link = (stored: boolean) => {
        const token = newCheckInToken();
        return { url: checkInLink(token), hash: stored ? checkInTokenHash(token) : null };
      };
      const ctxMsg = { language, clinicName: tenant.name, clinicPhone: clinic?.phone ?? null, patientFirstName: proc.patient.fullName.split(/\s+/)[0] ?? proc.patient.fullName };

      if (t.kind === "INSTRUCTION") {
        const messageId = withMessages ? message(buildStepMessage(step, { ...ctxMsg, link: null }), sentAt, id, t.stepIndex, t.kind, false) : null;
        tasks.push({ ...base, status: "SENT", sentAt, attempts: 1, messageId });
        lastDone = sentAt;
        continue;
      }

      // A check-in or photo request that went out: answered, still open, or missed.
      const windowOpen = age < 48 * HOUR;
      const outcome: "ANSWERED" | "SENT" | "MISSED" = windowOpen ? (r.chance(0.55) ? "ANSWERED" : "SENT") : r.chance(0.88) ? "ANSWERED" : "MISSED";
      if (outcome === "SENT" && status === "STOPPED") {
        // Stopping closed the link that was still open.
        tasks.push({ ...base, status: "SKIPPED", sentAt, attempts: 1 });
        continue;
      }
      const answeredAt =
        outcome === "ANSWERED" ? new Date(Math.min(now.getTime() - 20 * MIN, sentAt.getTime() + (r.chance(0.15) ? r.between(25, 40) * HOUR : r.between(8, 600) * MIN))) : null;
      const reminded = (outcome === "SENT" && age > 24 * HOUR) || (outcome === "MISSED") || (answeredAt !== null && answeredAt.getTime() - sentAt.getTime() > 24 * HOUR);
      const remindAt = new Date(sentAt.getTime() + 24 * HOUR + r.between(0, 2) * MIN);
      // Links still answerable keep their hash: open check-ins, and missed ones less than a week old.
      const keepLink = outcome === "SENT" || (outcome === "MISSED" && age < LINK_TTL_MS);
      let messageId: string | null = null;
      let tokenHash: string | null = null;
      if (withMessages) {
        const first = link(keepLink && !reminded);
        messageId = message(buildStepMessage(step, { ...ctxMsg, link: first.url }), sentAt, id, t.stepIndex, t.kind, false);
        tokenHash = first.hash;
        if (reminded && remindAt.getTime() < now.getTime()) {
          const second = link(keepLink);
          messageId = message(buildStepMessage(step, { ...ctxMsg, link: second.url, reminder: true }), remindAt, id, t.stepIndex, t.kind, true);
          tokenHash = second.hash;
        }
      }
      const task = {
        ...base,
        status: outcome,
        sentAt,
        attempts: reminded ? 2 : 1,
        messageId,
        tokenHash,
        answeredAt,
        missedAt: outcome === "MISSED" ? new Date(sentAt.getTime() + 48 * HOUR) : null,
      };
      tasks.push(task);
      if (outcome === "SENT") {
        open.push({ taskId: id, enrolmentId, patientId: proc.patient.id });
        continue;
      }
      if (outcome === "MISSED") {
        lastDone = task.missedAt!;
        continue;
      }

      // The answers: inside the expected ranges, 4–5 stars mostly, now and then a photo or a comment.
      const answers = answersFor(step, r, language);
      const satisfaction = step.satisfaction ? r.weighted([[5, 0.55], [4, 0.33], [3, 0.12]] as const) : null;
      const freeText = r.chance(0.12) ? r.pick(COMMENTS[language]) : null;
      const photoIds: string[] = [];
      if (step.kind === "PHOTO_REQUEST") {
        for (const view of (step.photos ?? []).slice(0, 4)) {
          const bytes = photoFor(view);
          const blobId = cid("cncb");
          const docId = cid("cncd");
          blobs.push({ id: blobId, tenantId, patientId: proc.patient.id, mimeType: "image/png", sizeBytes: bytes.length, bytes, createdAt: answeredAt! });
          documents.push({
            id: docId,
            tenantId,
            patientId: proc.patient.id,
            name: `${dayLabel(step)} ${view}`,
            kind: "image",
            s3Key: `blob:${blobId}`,
            mimeType: "image/png",
            sizeBytes: bytes.length,
            scanned: true,
            safe: true,
            createdAt: answeredAt!,
          });
          photoIds.push(docId);
        }
      }
      const { level, flags } = triageAnswers(step, answers, freeText);
      const checkIn = {
        id: cid("cncc"),
        tenantId,
        enrolmentId,
        taskId: id,
        patientId: proc.patient.id,
        answers: answers as Prisma.InputJsonObject,
        satisfaction,
        freeText,
        photoIds,
        triage: level,
        flags: flags as unknown as Prisma.InputJsonArray,
        source: r.chance(0.08) ? "staff" : "link",
        submittedAt: answeredAt!,
      };
      checkIns.push(checkIn);
      answered.push({ taskId: id, checkIn, step, enrolmentId, patientId: proc.patient.id, sentAt, active: status === "ACTIVE" });
      lastDone = answeredAt!;
    }

    enrolments.push({
      id: enrolmentId,
      tenantId,
      patientId: proc.patient.id,
      procedureId: proc.id,
      protocolId: protocol.row.id,
      status,
      channel: "WHATSAPP",
      language,
      startedAt: proc.performedAt,
      completedAt: status === "COMPLETED" ? lastDone : null,
      pausedAt,
      pauseReason: status === "PAUSED" ? "Travelling this week; will call when back" : null,
      stoppedAt,
      stopReason: status === "STOPPED" ? "Patient asked us to stop the messages; follows up by phone" : null,
      createdAt: signedAt,
    });
    timeline.push({
      tenantId,
      patientId: proc.patient.id,
      kind: "CHECK_IN",
      title: `Enrolled in ${protocol.row.name} v${protocol.row.version}`,
      body: `${proc.treatment.name}: ${steps.length} steps over ${protocolLengthDays(steps)} days, messages in ${language === "ar" ? "Arabic" : "English"} on WhatsApp.`,
      refId: enrolmentId,
      occurredAt: signedAt,
    });
    if (status === "COMPLETED") timeline.push({ tenantId, patientId: proc.patient.id, kind: "CHECK_IN", title: "Concierge follow-up completed", refId: enrolmentId, occurredAt: lastDone });
    if (status === "PAUSED") timeline.push({ tenantId, patientId: proc.patient.id, kind: "CHECK_IN", title: "Concierge follow-up paused", body: "Travelling this week; will call when back", refId: enrolmentId, occurredAt: pausedAt! });
    if (status === "STOPPED") timeline.push({ tenantId, patientId: proc.patient.id, kind: "CHECK_IN", title: "Concierge follow-up stopped", body: "Patient asked us to stop the messages; follows up by phone", refId: enrolmentId, occurredAt: stoppedAt! });
  }

  // ── Six escalations on real check-ins ─────────────────────────────────────
  const rosterAt = (at: Date) => {
    const outOfHours = !isWithinHours(at, tz, settings.hours);
    return { outOfHours, assignedToId: (outOfHours ? settings.roster.outOfHoursUserId : settings.roster.inHoursUserId) ?? owner?.id ?? null, target: outOfHours ? settings.ackMinutes.outOfHours : settings.ackMinutes.inHours };
  };
  const used = new Set<string>();
  /** The most recent answered check-in (on a running follow-up) that can be re-answered at `at` with a high-risk or watch reply. */
  const pick = (at: Date, level: "HIGH_RISK" | "WATCH") => {
    const candidates = answered
      .filter((a) => a.active && !used.has(a.taskId) && a.step.kind === "CHECK_IN" && a.sentAt.getTime() < at.getTime() - 5 * MIN)
      .filter((a) => (level === "HIGH_RISK" ? stepHasHighRisk(a.step) : Boolean(watchAnswers(a.step, {}))))
      .sort((x, y) => y.sentAt.getTime() - x.sentAt.getTime());
    return candidates[0] ?? null;
  };
  const scenarios: { minutesAgo: number; level: "HIGH_RISK" | "WATCH"; status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED"; ackAfter?: number; resolveAfter?: number; resolution?: string }[] = [
    { minutesAgo: 5, level: "HIGH_RISK", status: "OPEN" },
    { minutesAgo: 40, level: "HIGH_RISK", status: "OPEN" },
    { minutesAgo: 95, level: "WATCH", status: "OPEN" },
    { minutesAgo: 3 * 24 * 60 + 130, level: "HIGH_RISK", status: "RESOLVED", ackAfter: 8, resolveAfter: 35, resolution: "Called the patient: light oozing from two grafts, pressure advice given; settled on the evening call." },
    { minutesAgo: 9 * 24 * 60 + 300, level: "HIGH_RISK", status: "RESOLVED", ackAfter: 11, resolveAfter: 50, resolution: "Spoke to the patient: low-grade temperature after the gym, paracetamol and fluids; review booked." },
    { minutesAgo: 26 * 60, level: "HIGH_RISK", status: "ACKNOWLEDGED", ackAfter: 0 },
  ];
  let opened = 0;
  for (const s of scenarios) {
    const at = new Date(now.getTime() - s.minutesAgo * MIN);
    const a = pick(at, s.level);
    if (!a) continue;
    const base = a.checkIn.answers as Record<string, unknown>;
    const answers = s.level === "HIGH_RISK" ? highRiskAnswers(a.step, base, r) : watchAnswers(a.step, base);
    if (!answers) continue;
    const { level, flags } = triageAnswers(a.step, answers, null);
    if (level !== s.level) continue;
    used.add(a.taskId);
    const roster = rosterAt(at);
    // The acknowledged-late one waits past its target before someone takes it.
    const ackAfter = s.status === "ACKNOWLEDGED" ? roster.target + 11 : s.ackAfter;
    const acknowledgedAt = ackAfter !== undefined && s.status !== "OPEN" ? new Date(at.getTime() + ackAfter * MIN) : null;
    const resolvedAt = s.resolveAfter !== undefined ? new Date(at.getTime() + s.resolveAfter * MIN) : null;
    const actor = roster.assignedToId;
    const minutes = s.level === "HIGH_RISK" ? roster.target : 240;
    // The check-in itself becomes the alarming one, answered at `at`.
    Object.assign(a.checkIn, { answers: answers as Prisma.InputJsonObject, triage: level, flags: flags as unknown as Prisma.InputJsonArray, submittedAt: at, source: "link", freeText: s.level === "HIGH_RISK" && r.chance(0.5) ? null : a.checkIn.freeText });
    const task = tasks.find((t) => t.id === a.taskId)!;
    task.answeredAt = at;
    const summary = `${stepHeading(a.step, "en")}: ${flagSummary(a.step, flags)}`;
    const id = cid("cncx");
    escalations.push({
      id,
      tenantId,
      kind: "CONCIERGE",
      level,
      status: s.status,
      enrolmentId: a.enrolmentId,
      checkInId: a.checkIn.id,
      patientId: a.patientId,
      summary,
      details: { reason: "check-in", taskId: a.taskId, stepIndex: task.stepIndex, source: "link", flags, targetMinutes: minutes, backupUserId: settings.roster.backupUserId, reminders: 0 } as unknown as Prisma.InputJsonObject,
      assignedToId: roster.assignedToId,
      outOfHours: roster.outOfHours,
      dueAt: new Date(at.getTime() + minutes * MIN),
      acknowledgedAt,
      acknowledgedById: acknowledgedAt ? actor : null,
      resolvedAt,
      resolvedById: resolvedAt ? actor : null,
      resolution: resolvedAt ? (s.resolution ?? null) : null,
      createdAt: at,
      updatedAt: resolvedAt ?? acknowledgedAt ?? at,
    });
    timeline.push({ tenantId, patientId: a.patientId, kind: "ESCALATION", title: `${s.level === "HIGH_RISK" ? "High risk" : "Watch"} escalation opened`, body: `${summary} · ${roster.outOfHours ? "out of hours" : "in hours"}, target ${minutes} min`, refId: id, occurredAt: at });
    if (acknowledgedAt) {
      const late = Math.round((acknowledgedAt.getTime() - at.getTime()) / MIN) - minutes;
      timeline.push({ tenantId, patientId: a.patientId, kind: "ESCALATION", title: "Escalation acknowledged", body: `${summary} · after ${Math.round((acknowledgedAt.getTime() - at.getTime()) / MIN)} min${late > 0 ? `, ${late} min past the target` : ", within target"}`, refId: id, occurredAt: acknowledgedAt });
    }
    if (resolvedAt) timeline.push({ tenantId, patientId: a.patientId, kind: "ESCALATION", title: "Escalation resolved", body: s.resolution ?? null, refId: id, occurredAt: resolvedAt });
    opened += 1;
  }

  // The answered check-ins on the timeline, with their final triage.
  for (const a of answered) {
    const c = a.checkIn;
    const level = c.triage as TriageLevel;
    timeline.push({
      tenantId,
      patientId: a.patientId,
      kind: "CHECK_IN",
      title: `${stepHeading(a.step, "en")} answered · ${TRIAGE_LABEL[level]}${c.source === "staff" ? " (by phone)" : ""}`,
      body: summarizeCheckIn(a.step, { answers: c.answers as Record<string, unknown>, satisfaction: c.satisfaction ?? null, photoCount: (c.photoIds as string[]).length, triage: level }),
      refId: c.id,
      occurredAt: c.submittedAt as Date,
    });
  }

  await db.conversation.createMany({ data: conversations });
  await db.conciergeEnrolment.createMany({ data: enrolments });
  await db.conciergeTask.createMany({ data: tasks });
  await db.message.createMany({ data: messages });
  await db.fileBlob.createMany({ data: blobs });
  await db.document.createMany({ data: documents });
  await db.checkIn.createMany({ data: checkIns.map(({ ...c }) => c) });
  await db.escalation.createMany({ data: escalations });
  await db.timelineEvent.createMany({ data: timeline });
  // The latest outbound message time on the threads the seed opened.
  for (const c of conversations) {
    const last = messages.filter((m) => m.conversationId === c.id).reduce((m, x) => Math.max(m, (x.createdAt as Date).getTime()), 0);
    if (last) await db.conversation.update({ where: { id: c.id! }, data: { lastOutboundAt: new Date(last), updatedAt: new Date(last) } });
  }
  await db.auditLog.create({
    data: {
      tenantId,
      actorEmail: "seed@clinicmind",
      action: "concierge.seed",
      entity: "Tenant",
      entityId: tenantId,
      after: { enrolments: enrolments.length, tasks: tasks.length, checkIns: checkIns.length, escalations: escalations.length, messages: messages.length },
    },
  });

  const byStatus = (s: string) => enrolments.filter((e) => e.status === s).length;
  const closedCheckIns = tasks.filter((t) => t.kind === "CHECK_IN" && (t.status === "ANSWERED" || t.status === "MISSED"));
  const answeredPct = closedCheckIns.length ? Math.round((closedCheckIns.filter((t) => t.status === "ANSWERED").length / closedCheckIns.length) * 100) : 0;
  console.log(
    `     concierge: ${enrolments.length} enrolments (${byStatus("ACTIVE")} active, ${byStatus("PAUSED")} paused, ${byStatus("STOPPED")} stopped, ${byStatus("COMPLETED")} completed${skipped ? `, ${skipped} procedures without a protocol` : ""}), ${tasks.length} steps, ${checkIns.length} check-ins (${answeredPct}% of closed check-ins answered), ${open.length} awaiting an answer, ${opened} escalations, ${messages.length} messages.`,
  );
}
