import { Prisma, type UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canReadLabResults } from "@/lib/auth/rbac";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, formatDateInTz, fromDateKey } from "@/lib/time";
import { parseFilePayload, UploadError, type FileUpload } from "@/lib/uploads";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { notify } from "@/modules/notifications/service";
import { procedureLabel } from "@/modules/finance/charges";
import { MAX_AMOUNT, PAYMENT_METHODS } from "@/modules/finance/constants";
import { defaultClinicId } from "@/modules/finance/documents";
import { FinanceError } from "@/modules/finance/errors";
import { recordExpenseTx, type ExpenseActor } from "@/modules/finance/expenses";
import { DEFAULT_TURNAROUND_DAYS, LAB_STATUS_LABELS, LAB_VIEWS, MAX_LAB_FILE_BYTES, MAX_LAB_FILES, type LabOrderStatusValue, type LabView } from "./constants";

/**
 * Lab work: what is sent to a lab for a patient (a biopsy for
 * histopathology, blood tests, a culture), from the procedure it came from
 * and where on the body it was taken, due back by a day (the lab's usual
 * days, or the one given). An order still at the lab past its day is late:
 * the job `lab-orders-late` tells the doctor who asked and the desk, once.
 * Its result comes back with the lab's report (a photo or a PDF); the doctor
 * who asked is told, and told to act when the result is flagged. A result is
 * clinical: the roles that read consultations read it, the desk only sees
 * where an order stands.
 *
 * The lab's bill for an order is an expense under Lab fees, from that lab,
 * and a cost on its procedure, off the doctor's share; voiding one voids the
 * other, and an order whose bill was voided takes a new one. An order is
 * never deleted: it is cancelled with the reason (the database refuses
 * anything else).
 */

type Tx = Prisma.TransactionClient;
type Actor = ExpenseActor;

const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zMoney = z.number().int("Whole EGP").positive("More than zero").max(MAX_AMOUNT, "Too large");

const asDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const addDaysKey = (key: string, days: number) => keyOf(new Date(asDate(key).getTime() + days * 86_400_000));
const daysBetween = (from: string, to: string) => Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);

export const LabOrderInput = z
  .object({
    patientId: zText(64).min(1, "Whose sample"),
    /** A lab from the list… */
    labId: zOptionalText(64),
    /** …or a new one by its name (found by it when it exists). */
    labName: zOptionalText(120),
    procedureId: zOptionalText(64),
    /** Who asked for it (the doctor sending it, else the procedure's doctor). */
    doctorId: zOptionalText(64),
    tests: zText(300).min(2, "Say what the lab is asked for"),
    site: zOptionalText(120),
    reference: zOptionalText(80),
    /** The day it went (today when left out). */
    sentOn: zDayKey.optional(),
    /** The day it is due back (the lab's usual days after it went, when left out). */
    dueOn: zDayKey.optional(),
    note: zOptionalText(500),
  })
  .superRefine((v, ctx) => {
    if (!v.labId && !v.labName) ctx.addIssue({ code: "custom", path: ["labId"], message: "Which lab" });
    if (v.labId && v.labName) ctx.addIssue({ code: "custom", path: ["labName"], message: "A lab from the list, or a new name" });
  });

export const LabOrderEdit = z.object({
  tests: zText(300).min(2, "Say what the lab is asked for"),
  site: zOptionalText(120),
  reference: zOptionalText(80),
  procedureId: zOptionalText(64),
  dueOn: zDayKey,
  note: zOptionalText(500),
});

export const LabResultInput = z.object({
  result: zText(4000).min(2, "What the lab's report says"),
  /** Something in it a doctor must act on. */
  abnormal: z.boolean().default(false),
  /** The day it came back (today when left out). */
  receivedOn: zDayKey.optional(),
  /** The lab's report: photos or PDFs (`[{ name, type, data }]`, data in base64). */
  files: z.array(z.unknown()).max(MAX_LAB_FILES, `At most ${MAX_LAB_FILES} files`).optional(),
});

export const LabCancelInput = z.object({ reason: zText(300).min(3, "Say why, in a few words") });

export const LabBillInput = z.object({
  amount: zMoney,
  reference: zOptionalText(120),
  /** The day of the lab's bill (today when left out). */
  billedOn: zDayKey.optional(),
  /** The day it is to be paid by. */
  dueOn: zDayKey.optional(),
  /** Paid now, in full. */
  paid: z.object({ method: z.enum(PAYMENT_METHODS).default("BANK_TRANSFER"), fromDrawer: z.boolean().default(false), reference: zOptionalText(120) }).optional(),
});

export const LabListQuery = z.object({
  view: z.enum(LAB_VIEWS).optional(),
  labId: zOptionalText(64),
  q: zOptionalText(120),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const notFound = (id: string) => new FinanceError(404, "not_found", `lab order ${id} not found in tenant`, { entity: "lab_order" });
const resultsOnly = () => new FinanceError(403, "forbidden", "lab results are for clinicians", { message: "A lab's result is for the doctors and the nurses to record and read." });

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface LabFileDTO {
  id: string;
  name: string | null;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  url: string;
}

export interface LabOrderDTO {
  id: string;
  clinic: { id: string; name: string };
  patient: { id: string; fullName: string };
  lab: { id: string; name: string; phone: string | null };
  procedure: { id: string; label: string; performedAt: string } | null;
  doctor: { id: string; fullName: string } | null;
  tests: string;
  site: string | null;
  reference: string | null;
  note: string | null;
  sentAt: string;
  sentOn: string;
  dueOn: string;
  status: LabOrderStatusValue;
  statusLabel: string;
  /** At the lab past its day. */
  late: boolean;
  daysLate: number | null;
  receivedAt: string | null;
  receivedBy: string | null;
  /** The result and the lab's report: for the clinicians (null and empty for the desk). */
  resultsVisible: boolean;
  result: string | null;
  abnormal: boolean | null;
  files: LabFileDTO[];
  /** The lab's bill: its expense (null until billed, or when voided). */
  bill: { expenseId: string; amount: number; paid: number; owed: number } | null;
  /** A bill was entered and voided (a new one can be). */
  billVoided: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface LabKpis {
  waiting: number;
  late: number;
  backThisWeek: number;
  /** Results back in the last 30 days flagged for a doctor to act on (clinicians only; null for the desk). */
  flagged: number | null;
  /** Orders with no bill yet (or a voided one). */
  unbilled: number;
}

const orderInclude = {
  clinic: { select: { id: true, name: true } },
  patient: { select: { id: true, fullName: true } },
  lab: { select: { id: true, name: true, phone: true } },
  procedure: { select: { id: true, performedAt: true, quantity: true, stages: true, priceItem: { select: { name: true } }, treatment: { select: { name: true } } } },
  doctor: { select: { id: true, fullName: true, email: true } },
  expense: { select: { id: true, amount: true, voidedAt: true, payments: { where: { voidedAt: null }, select: { amount: true } } } },
  files: { orderBy: { createdAt: "asc" }, select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true } },
} satisfies Prisma.LabOrderInclude;

type OrderRow = Prisma.LabOrderGetPayload<{ include: typeof orderInclude }>;

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
}

function toDTO(o: OrderRow, today: string, timezone: string, role: UserRole | null | undefined, names: Map<string, string>): LabOrderDTO {
  const visible = !!role && canReadLabResults(role);
  const dueOn = keyOf(o.dueOn);
  const late = o.status === "SENT" && dueOn < today;
  const liveBill = o.expense && !o.expense.voidedAt ? o.expense : null;
  const paid = liveBill ? liveBill.payments.reduce((s, p) => s + p.amount, 0) : 0;
  return {
    id: o.id,
    clinic: o.clinic,
    patient: o.patient,
    lab: o.lab,
    procedure: o.procedure ? { id: o.procedure.id, label: procedureLabel(o.procedure), performedAt: o.procedure.performedAt.toISOString() } : null,
    doctor: o.doctor ? { id: o.doctor.id, fullName: o.doctor.fullName ?? o.doctor.email } : null,
    tests: o.tests,
    site: o.site,
    reference: o.reference,
    note: o.note,
    sentAt: o.sentAt.toISOString(),
    sentOn: dateKeyInTz(o.sentAt, timezone),
    dueOn,
    status: o.status,
    statusLabel: LAB_STATUS_LABELS[o.status],
    late,
    daysLate: late ? daysBetween(dueOn, today) : null,
    receivedAt: o.receivedAt?.toISOString() ?? null,
    receivedBy: o.receivedById ? (names.get(o.receivedById) ?? null) : null,
    resultsVisible: visible,
    result: visible ? o.result : null,
    abnormal: visible ? o.abnormal : null,
    files: visible ? o.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, createdAt: f.createdAt.toISOString(), url: `/api/lab-order-files/${f.id}` })) : [],
    bill: liveBill ? { expenseId: liveBill.id, amount: liveBill.amount, paid, owed: Math.max(0, liveBill.amount - paid) } : null,
    billVoided: !!o.expense?.voidedAt,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    createdAt: o.createdAt.toISOString(),
    createdBy: o.createdById ? (names.get(o.createdById) ?? null) : null,
  };
}

async function toDTOs(rows: OrderRow[], today: string, timezone: string, role: UserRole | null | undefined): Promise<LabOrderDTO[]> {
  const names = await namesOf(rows.flatMap((o) => [o.createdById, o.receivedById]));
  return rows.map((o) => toDTO(o, today, timezone, role, names));
}

async function clockOf(tenantId: string, now: Date) {
  const timezone = await getTenantTimezone(tenantId);
  return { timezone, today: dateKeyInTz(now, timezone) };
}

/** A day key on the clinic clock that must be a real day, not ahead of today (unless it may be). */
function realDay(key: string, timezone: string, path: string, today: string, opts: { future?: boolean } = {}): string {
  if (!fromDateKey(key, timezone)) throw new z.ZodError([{ code: "custom", path: [path], message: "Not a real date" }]);
  if (!opts.future && key > today) throw new z.ZodError([{ code: "custom", path: [path], message: "Not a day ahead" }]);
  return key;
}

/** The moment of a day: now for today, else noon of that day on the clinic clock. */
function momentOf(key: string, timezone: string, now: Date): Date {
  if (key === dateKeyInTz(now, timezone)) return now;
  return new Date(fromDateKey(key, timezone)!.getTime() + 12 * 3_600_000);
}

async function loadOrder(client: Tx | typeof db, tenantId: string, id: string): Promise<OrderRow> {
  const row = await client.labOrder.findFirst({ where: { id, tenantId }, include: orderInclude });
  if (!row) throw notFound(id);
  return row;
}

/** The patient's procedure, not cancelled, or a 404. */
async function requireProcedure(tx: Tx, tenantId: string, patientId: string, procedureId: string) {
  const p = await tx.procedure.findFirst({ where: { id: procedureId, tenantId, patientId, ...notDeleted, status: { not: "CANCELLED" } }, select: { id: true, doctorId: true } });
  if (!p) throw new TenantScopeError("procedure", procedureId);
  return p;
}

function filesFrom(raw: unknown): FileUpload[] {
  try {
    return parseFilePayload(raw, { max: MAX_LAB_FILES, maxBytes: MAX_LAB_FILE_BYTES });
  } catch (err) {
    if (err instanceof UploadError) throw new FinanceError(422, err.code, err.message, { message: err.message });
    throw err;
  }
}

async function storeFiles(tx: Tx, tenantId: string, order: { id: string; patientId: string }, files: FileUpload[], actor: Actor, now: Date) {
  if (!files.length) return;
  const have = await tx.labOrderFile.count({ where: { tenantId, labOrderId: order.id } });
  if (have + files.length > MAX_LAB_FILES) throw new FinanceError(422, "too_many_files", "too many files on the order", { message: `At most ${MAX_LAB_FILES} files on one lab order.` });
  for (const f of files) {
    const blob = await tx.fileBlob.create({ data: { tenantId, patientId: order.patientId, mimeType: f.mimeType, sizeBytes: f.bytes.length, bytes: f.bytes, createdAt: now }, select: { id: true } });
    await tx.labOrderFile.create({ data: { tenantId, labOrderId: order.id, blobId: blob.id, name: f.name, mimeType: f.mimeType, sizeBytes: f.bytes.length, createdById: actor.id ?? null, createdAt: now } });
  }
}

const timeline = (tx: Tx, tenantId: string, patientId: string, refId: string, title: string, occurredAt: Date, body: string | null = null) =>
  tx.timelineEvent.create({ data: { tenantId, patientId, kind: "LAB", refId, title, body, occurredAt } });

// ── Labs ─────────────────────────────────────────────────────────────────────

export interface LabDTO {
  id: string;
  name: string;
  turnaroundDays: number;
}

/** The labs the clinic sends to (suppliers marked a lab, not archived), by name. */
export async function listLabs(tenantId: string): Promise<LabDTO[]> {
  const labs = await db.supplier.findMany({ where: { tenantId, isLab: true, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, turnaroundDays: true } });
  return labs.map((l) => ({ id: l.id, name: l.name, turnaroundDays: l.turnaroundDays ?? DEFAULT_TURNAROUND_DAYS }));
}

/** What the new-order dialog offers for a patient: the labs, the patient's procedures of the last six months, who may ask. */
export async function labOrderOptions(tenantId: string, patientId: string, now: Date = new Date()) {
  const patient = await db.patient.findFirst({ where: { id: patientId, tenantId, ...notDeleted }, select: { id: true } });
  if (!patient) throw new TenantScopeError("patient", patientId);
  const since = new Date(now.getTime() - 183 * 86_400_000);
  const [labs, procedures, doctors] = await Promise.all([
    listLabs(tenantId),
    db.procedure.findMany({
      where: { tenantId, patientId, ...notDeleted, status: { not: "CANCELLED" }, performedAt: { gte: since } },
      orderBy: { performedAt: "desc" },
      take: 30,
      select: { id: true, performedAt: true, quantity: true, stages: true, doctorId: true, priceItem: { select: { name: true } }, treatment: { select: { name: true } } },
    }),
    db.user.findMany({ where: { tenantId, ...notDeleted, status: "ACTIVE", role: { in: ["DOCTOR", "CLINIC_OWNER"] } }, orderBy: { fullName: "asc" }, select: { id: true, fullName: true, email: true } }),
  ]);
  return {
    labs,
    procedures: procedures.map((p) => ({ id: p.id, label: procedureLabel(p), performedAt: p.performedAt.toISOString(), doctorId: p.doctorId })),
    doctors: doctors.map((d) => ({ id: d.id, fullName: d.fullName ?? d.email })),
  };
}

// ── Orders ───────────────────────────────────────────────────────────────────

/** Send work to a lab: from a procedure or not, where it was taken, due back by the lab's usual day or the one given. */
export async function createLabOrder(tenantId: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<LabOrderDTO> {
  const input = LabOrderInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const { timezone, today } = await clockOf(tenantId, now);
  const sentOn = input.sentOn ? realDay(input.sentOn, timezone, "sentOn", today) : today;
  const id = await db.$transaction(async (tx) => {
    const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId, ...notDeleted }, select: { id: true } });
    if (!patient) throw new TenantScopeError("patient", input.patientId);
    let lab: { id: string; name: string; turnaroundDays: number | null };
    if (input.labId) {
      const found = await tx.supplier.findFirst({ where: { id: input.labId, tenantId, isLab: true }, select: { id: true, name: true, turnaroundDays: true } });
      if (!found) throw new TenantScopeError("supplier", input.labId);
      lab = found;
    } else {
      const name = input.labName!.replace(/\s+/g, " ");
      const found = await tx.supplier.findFirst({ where: { tenantId, name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true, turnaroundDays: true, isLab: true } });
      if (found && !found.isLab) await tx.supplier.update({ where: { id: found.id }, data: { isLab: true } });
      lab = found ?? (await tx.supplier.create({ data: { tenantId, name, category: "LAB", isLab: true, createdById: actor.id ?? null }, select: { id: true, name: true, turnaroundDays: true } }));
      if (!found) await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "supplier.create", entity: "Supplier", entityId: lab.id, after: { name, category: "LAB", isLab: true } });
    }
    const procedure = input.procedureId ? await requireProcedure(tx, tenantId, patient.id, input.procedureId) : null;
    let doctorId: string | null = null;
    if (input.doctorId) {
      const d = await tx.user.findFirst({ where: { id: input.doctorId, tenantId, ...notDeleted, role: { in: ["DOCTOR", "CLINIC_OWNER", "NURSE"] } }, select: { id: true } });
      if (!d) throw new TenantScopeError("user", input.doctorId);
      doctorId = d.id;
    } else if (actor.role === "DOCTOR" || actor.role === "CLINIC_OWNER") doctorId = actor.id ?? null;
    else doctorId = procedure?.doctorId ?? null;
    const dueOn = input.dueOn ? realDay(input.dueOn, timezone, "dueOn", today, { future: true }) : addDaysKey(sentOn, lab.turnaroundDays ?? DEFAULT_TURNAROUND_DAYS);
    if (dueOn < sentOn) throw new z.ZodError([{ code: "custom", path: ["dueOn"], message: "Not before the day it went" }]);
    const clinicId = await defaultClinicId(tx, tenantId);
    if (!clinicId) throw new FinanceError(409, "no_branch", "the clinic has no branch", { message: "Add a branch (a location) to the clinic first." });
    const sentAt = momentOf(sentOn, timezone, now);
    const order = await tx.labOrder.create({
      data: {
        tenantId,
        clinicId,
        patientId: patient.id,
        labId: lab.id,
        procedureId: procedure?.id ?? null,
        doctorId,
        tests: input.tests,
        site: input.site ?? null,
        reference: input.reference ?? null,
        note: input.note ?? null,
        sentAt,
        dueOn: asDate(dueOn),
        createdById: actor.id ?? null,
        createdAt: now,
      },
      select: { id: true },
    });
    await timeline(tx, tenantId, patient.id, order.id, `Sent to ${lab.name}: ${input.tests}`, sentAt, input.site ? `From the ${input.site}` : null);
    return order.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "lab.order_create", entity: "LabOrder", entityId: id, after: { patientId: input.patientId, tests: input.tests, site: input.site ?? null, procedureId: input.procedureId ?? null, sentOn } });
  return getLabOrder(tenantId, id, { role: actor.role, now });
}

export async function getLabOrder(tenantId: string, id: string, opts: { role?: UserRole | null; now?: Date } = {}): Promise<LabOrderDTO> {
  const { timezone, today } = await clockOf(tenantId, opts.now ?? new Date());
  return (await toDTOs([await loadOrder(db, tenantId, id)], today, timezone, opts.role))[0]!;
}

/** Correct an order still at the lab: what was asked, where from, its procedure, its reference, the day it is due back. */
export async function updateLabOrder(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<LabOrderDTO> {
  const input = LabOrderEdit.parse(rawInput);
  const now = opts.now ?? new Date();
  const { timezone, today } = await clockOf(tenantId, now);
  const dueOn = realDay(input.dueOn, timezone, "dueOn", today, { future: true });
  const before = await db.$transaction(async (tx) => {
    const o = await loadOrder(tx, tenantId, id);
    if (o.status !== "SENT") throw new FinanceError(409, "invalid_state", "only an order at the lab is changed", { message: "Only an order still at the lab is changed." });
    if (dueOn < dateKeyInTz(o.sentAt, timezone)) throw new z.ZodError([{ code: "custom", path: ["dueOn"], message: "Not before the day it went" }]);
    const procedure = input.procedureId ? await requireProcedure(tx, tenantId, o.patientId, input.procedureId) : null;
    const moved = dueOn !== keyOf(o.dueOn);
    await tx.labOrder.update({
      where: { id },
      data: {
        tests: input.tests,
        site: input.site ?? null,
        reference: input.reference ?? null,
        procedureId: procedure?.id ?? null,
        dueOn: asDate(dueOn),
        note: input.note ?? null,
        // A new day: late again only once it passes.
        ...(moved ? { lateNotifiedAt: null } : {}),
        updatedById: actor.id ?? null,
      },
    });
    return o;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lab.order_update",
    entity: "LabOrder",
    entityId: id,
    before: { tests: before.tests, site: before.site, dueOn: keyOf(before.dueOn), procedureId: before.procedureId },
    after: { tests: input.tests, site: input.site ?? null, dueOn, procedureId: input.procedureId ?? null },
  });
  return getLabOrder(tenantId, id, { role: actor.role, now });
}

/** A clinician records the result as the lab's report has it (and its photos or PDF); the doctor who asked is told. Recorded again, it is corrected. */
export async function recordLabResult(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<LabOrderDTO> {
  if (!actor.role || !canReadLabResults(actor.role)) throw resultsOnly();
  const input = LabResultInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const { timezone, today } = await clockOf(tenantId, now);
  const files = filesFrom(input.files);
  const { order, amended } = await db.$transaction(async (tx) => {
    const o = await loadOrder(tx, tenantId, id);
    if (o.status === "CANCELLED") throw new FinanceError(409, "invalid_state", "a cancelled order takes no result", { message: "This order is cancelled." });
    const amended = o.status === "RECEIVED";
    const receivedOn = input.receivedOn ? realDay(input.receivedOn, timezone, "receivedOn", today) : amended ? dateKeyInTz(o.receivedAt!, timezone) : today;
    if (receivedOn < dateKeyInTz(o.sentAt, timezone)) throw new z.ZodError([{ code: "custom", path: ["receivedOn"], message: "Not before the day it went" }]);
    await tx.labOrder.update({
      where: { id },
      data: {
        status: "RECEIVED",
        result: input.result,
        abnormal: input.abnormal,
        ...(amended && !input.receivedOn ? {} : { receivedAt: momentOf(receivedOn, timezone, now), receivedById: actor.id ?? null }),
        updatedById: actor.id ?? null,
      },
    });
    await storeFiles(tx, tenantId, o, files, actor, now);
    if (!amended) await timeline(tx, tenantId, o.patientId, o.id, `Result in from ${o.lab.name}: ${o.tests}`, momentOf(receivedOn, timezone, now));
    return { order: o, amended };
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: amended ? "lab.result_amend" : "lab.result",
    entity: "LabOrder",
    entityId: id,
    ...(amended ? { before: { result: order.result, abnormal: order.abnormal } } : {}),
    after: { result: input.result, abnormal: input.abnormal, files: files.length },
  });
  if (!amended && order.doctorId && order.doctorId !== actor.id) {
    await notify(tenantId, {
      kind: "LAB_RESULT_IN",
      level: input.abnormal ? "WARNING" : "INFO",
      title: `${input.abnormal ? "Lab result to act on" : "Lab result in"}: ${order.patient.fullName}`,
      body: `${order.tests} · ${order.lab.name}`,
      href: `/dashboard/lab/${id}`,
      entity: "LabOrder",
      entityId: id,
      userIds: [order.doctorId],
    }).catch((err: unknown) => console.error("[lab] result notification failed", err));
  }
  return getLabOrder(tenantId, id, { role: actor.role, now });
}

/** Add the lab's report (photos or PDFs) to an order. */
export async function addLabFiles(tenantId: string, id: string, rawFiles: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<LabOrderDTO> {
  if (!actor.role || !canReadLabResults(actor.role)) throw resultsOnly();
  const now = opts.now ?? new Date();
  const files = filesFrom(rawFiles);
  if (!files.length) throw new z.ZodError([{ code: "custom", path: ["files"], message: "Choose a photo or a PDF" }]);
  await db.$transaction(async (tx) => {
    const o = await loadOrder(tx, tenantId, id);
    if (o.status === "CANCELLED") throw new FinanceError(409, "invalid_state", "a cancelled order takes no file", { message: "This order is cancelled." });
    await storeFiles(tx, tenantId, o, files, actor, now);
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "lab.file_add", entity: "LabOrder", entityId: id, after: { files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, sizeBytes: f.bytes.length })) } });
  return getLabOrder(tenantId, id, { role: actor.role, now });
}

/** A file of a lab's report, for the clinicians; null otherwise. */
export async function labFileFor(tenantId: string, fileId: string, role: UserRole | null | undefined): Promise<{ name: string | null; mimeType: string; bytes: Uint8Array } | null> {
  if (!role || !canReadLabResults(role)) return null;
  const f = await db.labOrderFile.findFirst({ where: { id: fileId, tenantId }, select: { name: true, mimeType: true, blobId: true } });
  if (!f) return null;
  const blob = await db.fileBlob.findFirst({ where: { id: f.blobId, tenantId }, select: { bytes: true } });
  return blob ? { name: f.name, mimeType: f.mimeType, bytes: blob.bytes } : null;
}

/** Cancel an order still at the lab, with the reason (its bill voided first, if it has one). */
export async function cancelLabOrder(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<LabOrderDTO> {
  const input = LabCancelInput.parse(rawInput);
  const now = opts.now ?? new Date();
  await db.$transaction(async (tx) => {
    const o = await loadOrder(tx, tenantId, id);
    if (o.status !== "SENT") throw new FinanceError(409, "invalid_state", "only an order at the lab is cancelled", { message: o.status === "CANCELLED" ? "This order is cancelled already." : "Its result is in: the order stays." });
    if (o.expense && !o.expense.voidedAt) throw new FinanceError(409, "billed", "the order has a bill", { message: "The lab billed it: the owner voids the bill first." });
    await tx.labOrder.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id ?? null, cancelReason: input.reason } });
    await timeline(tx, tenantId, o.patientId, o.id, `Lab order cancelled: ${o.tests}`, now, input.reason);
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "lab.order_cancel", entity: "LabOrder", entityId: id, after: { reason: input.reason } });
  return getLabOrder(tenantId, id, { role: actor.role, now });
}

/** The lab's bill for an order: an expense under Lab fees from that lab, and a cost on its procedure (off the doctor's share). */
export async function billLabOrder(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<LabOrderDTO> {
  const input = LabBillInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const { timezone, today } = await clockOf(tenantId, now);
  const billedOn = input.billedOn ? realDay(input.billedOn, timezone, "billedOn", today) : today;
  const dueOn = input.paid ? null : input.dueOn ? realDay(input.dueOn, timezone, "dueOn", today, { future: true }) : null;
  if (dueOn && dueOn < billedOn) throw new z.ZodError([{ code: "custom", path: ["dueOn"], message: "Not before the day of the bill" }]);
  const { expenseId, costId } = await db.$transaction(async (tx) => {
    const o = await loadOrder(tx, tenantId, id);
    if (o.status === "CANCELLED") throw new FinanceError(409, "invalid_state", "a cancelled order takes no bill", { message: "This order is cancelled." });
    if (o.expense && !o.expense.voidedAt) throw new FinanceError(409, "billed", "the order is billed already", { message: "The lab's bill for this order is in already." });
    const expenseId = await recordExpenseTx(
      tx,
      tenantId,
      {
        clinicId: o.clinicId,
        supplierId: o.labId,
        category: "LAB",
        description: `${o.tests} · ${o.patient.fullName}`,
        amount: input.amount,
        billedOn,
        dueOn,
        reference: input.reference,
        paid: input.paid ? { method: input.paid.method, fromDrawer: input.paid.fromDrawer, reference: input.paid.reference } : undefined,
      },
      timezone,
      actor,
      now,
    );
    const cost = o.procedureId
      ? await tx.procedureCost.create({
          data: { tenantId, procedureId: o.procedureId, kind: "LAB", description: `${o.lab.name}: ${o.tests}`, amount: input.amount, incurredAt: momentOf(billedOn, timezone, now), createdById: actor.id ?? null, createdAt: now },
          select: { id: true },
        })
      : null;
    await tx.labOrder.update({ where: { id }, data: { expenseId, costId: cost?.id ?? null, updatedById: actor.id ?? null } });
    return { expenseId, costId: cost?.id ?? null };
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "lab.bill", entity: "LabOrder", entityId: id, after: { expenseId, costId, amount: input.amount, billedOn, paid: input.paid ? input.paid.method : null } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.create", entity: "Expense", entityId: expenseId, after: { category: "LAB", amount: input.amount, billedOn, labOrderId: id } });
  return getLabOrder(tenantId, id, { role: actor.role, now });
}

// ── Lists ────────────────────────────────────────────────────────────────────

function viewWhere(view: LabView, today: string, now: Date): Prisma.LabOrderWhereInput {
  switch (view) {
    case "late":
      return { status: "SENT", dueOn: { lt: asDate(today) } };
    case "waiting":
      return { status: "SENT", dueOn: { gte: asDate(today) } };
    case "back":
      return { status: "RECEIVED", receivedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } };
    case "unbilled":
      return { status: { in: ["SENT", "RECEIVED"] }, OR: [{ expenseId: null }, { expense: { voidedAt: { not: null } } }] };
    case "cancelled":
      return { status: "CANCELLED" };
  }
}

const VIEW_ORDER: Record<LabView, Prisma.LabOrderOrderByWithRelationInput[]> = {
  late: [{ dueOn: "asc" }, { sentAt: "asc" }],
  waiting: [{ dueOn: "asc" }, { sentAt: "asc" }],
  back: [{ receivedAt: "desc" }],
  unbilled: [{ sentAt: "asc" }],
  cancelled: [{ cancelledAt: "desc" }],
};

/** The figures at the top of Lab work. */
export async function labKpis(tenantId: string, opts: { role?: UserRole | null; now?: Date } = {}): Promise<LabKpis> {
  const now = opts.now ?? new Date();
  const { today } = await clockOf(tenantId, now);
  const clinician = !!opts.role && canReadLabResults(opts.role);
  const [waiting, late, backThisWeek, flagged, unbilled] = await Promise.all([
    db.labOrder.count({ where: { tenantId, ...viewWhere("waiting", today, now) } }),
    db.labOrder.count({ where: { tenantId, ...viewWhere("late", today, now) } }),
    db.labOrder.count({ where: { tenantId, status: "RECEIVED", receivedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
    clinician ? db.labOrder.count({ where: { tenantId, ...viewWhere("back", today, now), abnormal: true } }) : Promise.resolve(null),
    db.labOrder.count({ where: { tenantId, ...viewWhere("unbilled", today, now) } }),
  ]);
  return { waiting, late, backThisWeek, flagged, unbilled };
}

/** The Lab work page's lists: late (the longest late first), waiting (the soonest due first), back, not billed, cancelled. */
export async function listLabOrders(tenantId: string, rawQuery: unknown = {}, opts: { role?: UserRole | null; now?: Date } = {}) {
  const query = LabListQuery.parse(rawQuery);
  const now = opts.now ?? new Date();
  const { timezone, today } = await clockOf(tenantId, now);
  const view = query.view ?? "waiting";
  const where: Prisma.LabOrderWhereInput = {
    tenantId,
    ...viewWhere(view, today, now),
    ...(query.labId ? { labId: query.labId } : {}),
    ...(query.q
      ? {
          AND: [
            {
              OR: [
                { patient: { fullName: { contains: query.q, mode: "insensitive" } } },
                { tests: { contains: query.q, mode: "insensitive" } },
                { lab: { name: { contains: query.q, mode: "insensitive" } } },
                { reference: { contains: query.q, mode: "insensitive" } },
              ],
            },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.labOrder.findMany({ where, include: orderInclude, orderBy: VIEW_ORDER[view], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.labOrder.count({ where }),
  ]);
  return { view, timezone, today, rows: await toDTOs(rows, today, timezone, opts.role), total, page: query.page, pageSize: query.pageSize };
}

/** A patient's lab orders, the latest first. */
export async function patientLabOrders(tenantId: string, patientId: string, opts: { role?: UserRole | null; now?: Date } = {}): Promise<LabOrderDTO[]> {
  const { timezone, today } = await clockOf(tenantId, opts.now ?? new Date());
  const rows = await db.labOrder.findMany({ where: { tenantId, patientId }, include: orderInclude, orderBy: { sentAt: "desc" }, take: 50 });
  return toDTOs(rows, today, timezone, opts.role);
}

// ── Late alerts ──────────────────────────────────────────────────────────────

export interface LateLabSummary {
  tenants: number;
  late: number;
}

/**
 * Tell the doctor who asked and the desk, once, of each order still at the
 * lab past its day (job `lab-orders-late`). An order given a new day is told
 * of again once that day passes.
 */
export async function notifyLateLabOrders(now: Date = new Date(), opts: { tenantId?: string } = {}): Promise<LateLabSummary> {
  const summary: LateLabSummary = { tenants: 0, late: 0 };
  const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null, ...(opts.tenantId ? { id: opts.tenantId } : {}) }, select: { id: true } });
  for (const tenant of tenants) {
    summary.tenants += 1;
    const { timezone, today } = await clockOf(tenant.id, now);
    const late = await db.labOrder.findMany({
      where: { tenantId: tenant.id, status: "SENT", dueOn: { lt: asDate(today) }, lateNotifiedAt: null },
      orderBy: { dueOn: "asc" },
      take: 200,
      select: { id: true, tests: true, dueOn: true, doctorId: true, patient: { select: { fullName: true } }, lab: { select: { name: true } } },
    });
    if (!late.length) continue;
    // Claimed first, so a second run tells no one twice.
    const claimed = await db.labOrder.updateMany({ where: { id: { in: late.map((o) => o.id) }, lateNotifiedAt: null }, data: { lateNotifiedAt: now } });
    if (!claimed.count) continue;
    summary.late += late.length;
    const day = (d: Date) => formatDateInTz(new Date(d.getTime() + 12 * 3_600_000), timezone, { day: "numeric", month: "short" });
    await notify(tenant.id, {
      kind: "LAB_ORDER_LATE",
      level: "WARNING",
      title: late.length === 1 ? `A lab result is late: ${late[0]!.patient.fullName}` : `${late.length} lab results are late`,
      body: late.map((o) => `${o.patient.fullName} · ${o.tests} · ${o.lab.name} · was due ${day(o.dueOn)}`).slice(0, 5).join("\n"),
      href: "/dashboard/lab?view=late",
      entity: "LabOrder",
      userIds: [...new Set(late.map((o) => o.doctorId).filter((x): x is string => !!x))],
      roles: ["RECEPTIONIST"],
    }).catch((err: unknown) => console.error("[lab] late notification failed", err));
  }
  return summary;
}
