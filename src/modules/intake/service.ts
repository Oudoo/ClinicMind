import type { IntakeLinkKind, IntakeStatus, Prisma } from "@prisma/client";
import QRCode from "qrcode";
import { z } from "zod";
import { db, notDeleted, systemDb, withTenant } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { BRAND, type TenantBranding } from "@/lib/brand";
import { resolveTenantHintFromHost } from "@/lib/tenant";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { parsePaging, zOptionalText, zText } from "@/lib/validation";
import { ingestInBackground } from "@/modules/knowledge/ingest";
import { notify } from "@/modules/notifications/service";
import { listTreatments } from "@/modules/treatments/service";
import { dedupeStrings, historyLists, type Actor } from "@/modules/patients/service";
import { phoneVariants } from "@/modules/patients/search";
import {
  IntakeFormInput,
  intakeEmergencyContact,
  intakeWhatsapp,
  type IntakeForm,
  type IntakeLanguage,
} from "@/modules/intake/form";
import { hashIntakeToken, isPlausibleIntakeToken, issueIntakeToken } from "@/modules/intake/tokens";

/**
 * Intake: shareable onboarding links and the submissions they collect.
 *
 * A link is an opaque 256-bit token; only its keyed hash is stored, so the URL
 * (and QR) can be shown exactly once, at creation. Public endpoints resolve
 * the hash, never confirm whether a token exists (unknown, expired, revoked,
 * used-up and another clinic's tokens all behave the same) and are
 * rate-limited by the route. Staff routes are tenant-scoped like every other
 * module: a submission or link of another tenant is a 404.
 */

export const DEFAULT_LINK_TTL_DAYS = 14;
export const INTAKE_REVIEW_PATH = "/dashboard/patients/intake";
/** Public endpoint budgets per client IP per 15 minutes. */
export const INTAKE_RATE_WINDOW_MS = 15 * 60 * 1000;
export const INTAKE_PUBLIC_GET_LIMIT = 60;
export const INTAKE_PUBLIC_POST_LIMIT = 10;

export class IntakeError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IntakeError";
  }
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

export type IntakeLinkStatus = "active" | "expired" | "revoked" | "exhausted";

export interface IntakeLinkDTO {
  id: string;
  kind: IntakeLinkKind;
  label: string | null;
  language: IntakeLanguage;
  tokenPrefix: string;
  patient: { id: string; fullName: string; phone: string | null } | null;
  expiresAt: string;
  maxUses: number | null;
  uses: number;
  revokedAt: string | null;
  createdAt: string;
  createdBy: { id: string; fullName: string } | null;
  submissionCount: number;
  status: IntakeLinkStatus;
}

export interface IntakeSubmissionDTO {
  id: string;
  status: IntakeStatus;
  fullName: string;
  phone: string | null;
  email: string | null;
  language: IntakeLanguage;
  submittedAt: string;
  data: IntakeForm;
  link: { id: string; kind: IntakeLinkKind; label: string | null; language: IntakeLanguage };
  matchedPatient: { id: string; fullName: string; phone: string | null } | null;
  patient: { id: string; fullName: string } | null;
  reviewedBy: { id: string; fullName: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface IssuedIntakeLink {
  link: IntakeLinkDTO;
  /** Shown once: the token is not recoverable from the database. */
  url: string;
  qrDataUrl: string;
  whatsappUrl: string;
  message: string;
}

const linkInclude = {
  patient: { select: { id: true, fullName: true, phone: true, whatsapp: true, deletedAt: true } },
  _count: { select: { submissions: true } },
} satisfies Prisma.IntakeLinkInclude;

type LinkRow = Prisma.IntakeLinkGetPayload<{ include: typeof linkInclude }>;

function asLanguage(value: string): IntakeLanguage {
  return value === "en" ? "en" : "ar";
}

export function linkStatus(link: { revokedAt: Date | null; expiresAt: Date; maxUses: number | null; uses: number }, now = new Date()): IntakeLinkStatus {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt <= now) return "expired";
  if (link.maxUses !== null && link.uses >= link.maxUses) return "exhausted";
  return "active";
}

function toLinkDTO(row: LinkRow, users: Map<string, string>, now = new Date()): IntakeLinkDTO {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    language: asLanguage(row.language),
    tokenPrefix: row.tokenPrefix,
    patient: row.patient ? { id: row.patient.id, fullName: row.patient.fullName, phone: row.patient.phone } : null,
    expiresAt: row.expiresAt.toISOString(),
    maxUses: row.maxUses,
    uses: row.uses,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdById ? { id: row.createdById, fullName: users.get(row.createdById) ?? "Staff" } : null,
    submissionCount: row._count.submissions,
    status: linkStatus(row, now),
  };
}

/** Names of tenant users, for "created by" / "reviewed by". */
async function userNames(tenantId: string, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
}

/** Parse a stored form back; a row written by an older schema degrades to the essentials. */
export function parseStoredForm(data: unknown, fallback: { fullName: string; phone: string | null; language?: string }): IntakeForm {
  const parsed = IntakeFormInput.safeParse(data);
  if (parsed.success) return parsed.data;
  const minimal = IntakeFormInput.safeParse({
    fullName: fallback.fullName,
    phone: fallback.phone ?? "+20000000000",
    consent: true,
    language: fallback.language ?? "ar",
  });
  if (minimal.success) return minimal.data;
  throw new IntakeError("corrupt_submission", 500, "Submission data cannot be read");
}

// ── Links ─────────────────────────────────────────────────────────────────────

export const CreateIntakeLinkInput = z.object({
  kind: z.enum(["OPEN", "PATIENT"]).default("OPEN"),
  patientId: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), zText(64).optional()),
  language: z.enum(["ar", "en"]).default("ar"),
  label: zOptionalText(80),
  expiresInDays: z.coerce.number().int().min(1).max(365).default(DEFAULT_LINK_TTL_DAYS),
  maxUses: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.coerce.number().int().min(1).max(10_000).optional(),
  ),
});
export type CreateIntakeLinkInput = z.input<typeof CreateIntakeLinkInput>;

export function intakeLinkUrl(token: string): string {
  const base = (env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, "");
  return `${base}/onboard/${token}`;
}

/** The invitation text (in the patient's language) and the `wa.me` share URL. */
export function whatsappShare(opts: { url: string; language: IntakeLanguage; clinicName: string; patientName?: string | null; phone?: string | null }) {
  const name = opts.patientName?.trim();
  const message =
    opts.language === "ar"
      ? `مرحباً${name ? ` ${name}` : ""}، من فضلك املأ نموذج التسجيل الخاص بـ${opts.clinicName} قبل زيارتك (يستغرق حوالي ٣ دقائق): ${opts.url}`
      : `Hello${name ? ` ${name}` : ""}, please fill in your onboarding form for ${opts.clinicName} before your visit (about 3 minutes): ${opts.url}`;
  const digits = opts.phone ? opts.phone.replace(/\D/g, "") : "";
  const whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  return { message, whatsappUrl };
}

export async function createIntakeLink(tenantId: string, input: unknown, actor: Actor = {}): Promise<IssuedIntakeLink> {
  const data = CreateIntakeLinkInput.parse(input);
  if (data.kind === "PATIENT" && !data.patientId) {
    throw new IntakeError("patient_required", 422, "A patient link needs a patientId");
  }
  const patient = data.kind === "PATIENT" && data.patientId ? await requireTenantPatient(tenantId, data.patientId) : null;
  const tenant = await db.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true } });

  const { token, tokenHash, tokenPrefix } = issueIntakeToken();
  const now = new Date();
  const row = await db.intakeLink.create({
    data: {
      tenantId,
      kind: data.kind,
      tokenHash,
      tokenPrefix,
      patientId: patient?.id ?? null,
      language: data.language,
      label: data.label ?? null,
      expiresAt: new Date(now.getTime() + data.expiresInDays * 86_400_000),
      maxUses: data.maxUses ?? null,
      createdById: actor.id ?? null,
    },
    include: linkInclude,
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "intake.link.create",
    entity: "IntakeLink",
    entityId: row.id,
    after: {
      kind: row.kind,
      label: row.label,
      language: row.language,
      patientId: row.patientId,
      expiresAt: row.expiresAt.toISOString(),
      maxUses: row.maxUses,
      tokenPrefix: row.tokenPrefix,
    },
  });

  const url = intakeLinkUrl(token);
  const [qrDataUrl, users] = await Promise.all([
    QRCode.toDataURL(url, { margin: 1, width: 320 }),
    userNames(tenantId, [row.createdById]),
  ]);
  const share = whatsappShare({
    url,
    language: asLanguage(row.language),
    clinicName: tenant.name,
    patientName: row.patient?.fullName ?? null,
    phone: row.patient?.whatsapp ?? row.patient?.phone ?? null,
  });
  return { link: toLinkDTO(row, users, now), url, qrDataUrl, whatsappUrl: share.whatsappUrl, message: share.message };
}

export interface ListLinksOptions {
  page?: number;
  pageSize?: number;
  patientId?: string;
  /** `active` hides revoked, expired and exhausted links. */
  status?: "active" | "all";
}

export async function listIntakeLinks(tenantId: string, opts: ListLinksOptions = {}) {
  const params = new URLSearchParams();
  if (opts.page !== undefined) params.set("page", String(opts.page));
  if (opts.pageSize !== undefined) params.set("pageSize", String(opts.pageSize));
  const { page, pageSize, skip, take } = parsePaging(params);
  const now = new Date();
  const where: Prisma.IntakeLinkWhereInput = {
    tenantId,
    ...(opts.patientId ? { patientId: opts.patientId } : {}),
    ...(opts.status === "active" ? { revokedAt: null, expiresAt: { gt: now } } : {}),
  };
  const [rows, total] = await db.$transaction([
    db.intakeLink.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take, include: linkInclude }),
    db.intakeLink.count({ where }),
  ]);
  const users = await userNames(tenantId, rows.map((r) => r.createdById));
  let links = rows.map((r) => toLinkDTO(r, users, now));
  if (opts.status === "active") links = links.filter((l) => l.status === "active");
  return { links, total, page, pageSize };
}

export async function revokeIntakeLink(tenantId: string, id: string, actor: Actor = {}): Promise<IntakeLinkDTO | null> {
  const existing = await db.intakeLink.findFirst({ where: { id, tenantId }, include: linkInclude });
  if (!existing) return null;
  const row = existing.revokedAt
    ? existing
    : await db.intakeLink.update({ where: { id: existing.id }, data: { revokedAt: new Date() }, include: linkInclude });
  if (!existing.revokedAt) {
    await audit({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      ip: actor.ip,
      action: "intake.link.revoke",
      entity: "IntakeLink",
      entityId: row.id,
      before: { revokedAt: null },
      after: { revokedAt: row.revokedAt?.toISOString() ?? null, tokenPrefix: row.tokenPrefix },
    });
  }
  const users = await userNames(tenantId, [row.createdById]);
  return toLinkDTO(row, users);
}

// ── Public side ───────────────────────────────────────────────────────────────

const publicLinkInclude = {
  tenant: { select: { id: true, name: true, branding: true, status: true, deletedAt: true } },
  patient: {
    select: {
      id: true,
      tenantId: true,
      fullName: true,
      phone: true,
      whatsapp: true,
      dateOfBirth: true,
      gender: true,
      city: true,
      nationalId: true,
      email: true,
      address: true,
      emergencyContact: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.IntakeLinkInclude;

type PublicLinkRow = Prisma.IntakeLinkGetPayload<{ include: typeof publicLinkInclude }>;

/** Where the public request arrived: the `Host` (or `X-Forwarded-Host`) header, used only to narrow. */
export interface PublicRequestMeta {
  host?: string | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The tenant a public request's host names: one of the tenant's subdomains
 * (`<slug>.<ROOT_DOMAIN>`) or its verified custom domain. The host links are
 * minted for (PUBLIC_URL / APP_URL) names no tenant, so a link always works
 * there; on a clinic's own domain only that clinic's links resolve.
 */
async function tenantIdForHost(host: string | null | undefined): Promise<string | null> {
  const value = host?.split(",")[0]?.trim().toLowerCase();
  if (!value) return null;
  if (value === hostOf(env.APP_URL) || (env.PUBLIC_URL && value === hostOf(env.PUBLIC_URL))) return null;
  const hint = resolveTenantHintFromHost(value);
  if (!hint.slug && !hint.customDomain) return null;
  const tenant = await db.tenant.findFirst({
    where: hint.customDomain ? { customDomain: hint.customDomain, customDomainVerified: true } : { slug: hint.slug },
    select: { id: true },
  });
  return tenant?.id ?? null;
}

/**
 * The clinic an onboarding link belongs to. Looked up across clinics because
 * the token is the visitor's only credential; everything after runs in that
 * clinic's database scope (row-level security, lib/db.ts).
 */
async function tenantOfToken(token: string): Promise<string | null> {
  if (!isPlausibleIntakeToken(token)) return null;
  const row = await systemDb.intakeLink.findUnique({ where: { tokenHash: hashIntakeToken(token) }, select: { tenantId: true } });
  return row?.tenantId ?? null;
}

/**
 * The live link behind a token, or null for unknown / expired / revoked /
 * used-up tokens, a suspended clinic, and another clinic's token presented on
 * a clinic's own domain (all indistinguishable on purpose).
 */
async function resolveLink(token: string, meta: PublicRequestMeta = {}, now = new Date()): Promise<PublicLinkRow | null> {
  if (!isPlausibleIntakeToken(token)) return null;
  const link = await db.intakeLink.findUnique({ where: { tokenHash: hashIntakeToken(token) }, include: publicLinkInclude });
  if (!link || linkStatus(link, now) !== "active") return null;
  if (link.tenant.deletedAt || link.tenant.status !== "ACTIVE") return null;
  if (link.kind === "PATIENT" && (!link.patient || link.patient.deletedAt || link.patient.tenantId !== link.tenantId)) return null;
  const hostTenant = await tenantIdForHost(meta.host);
  if (hostTenant && hostTenant !== link.tenantId) return null;
  return link;
}

export interface PublicIntakePrefill {
  fullName: string;
  phone: string;
  whatsapp: string;
  dateOfBirth: string;
  gender: string;
  city: string;
  nationalId: string;
  email: string;
  address: string;
  emergencyContact: string;
}

export interface PublicIntake {
  clinicName: string;
  productName: string;
  language: IntakeLanguage;
  kind: IntakeLinkKind;
  label: string | null;
  expiresAt: string;
  prefill: PublicIntakePrefill | null;
  treatments: { key: string; name: string }[];
}

export async function getPublicIntake(token: string, meta: PublicRequestMeta = {}): Promise<PublicIntake | null> {
  const tenantId = await tenantOfToken(token);
  return tenantId ? withTenant(tenantId, () => publicIntake(token, meta)) : null;
}

async function publicIntake(token: string, meta: PublicRequestMeta): Promise<PublicIntake | null> {
  const link = await resolveLink(token, meta);
  if (!link) return null;
  const branding = (link.tenant.branding as TenantBranding | null) ?? null;
  const treatments = await listTreatments(link.tenantId);
  const p = link.kind === "PATIENT" ? link.patient : null;
  return {
    clinicName: link.tenant.name,
    productName: branding?.productName ?? BRAND.productName,
    language: asLanguage(link.language),
    kind: link.kind,
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    prefill: p
      ? {
          fullName: p.fullName,
          phone: p.phone ?? "",
          whatsapp: p.whatsapp ?? "",
          dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : "",
          gender: p.gender,
          city: p.city ?? "",
          nationalId: p.nationalId ?? "",
          email: p.email ?? "",
          address: p.address ?? "",
          emergencyContact: p.emergencyContact ?? "",
        }
      : null,
    treatments: treatments.map((t) => ({ key: t.key, name: t.name })),
  };
}

/** Exact phone match among the tenant's active patients (newest first). */
async function findPatientByPhone(tenantId: string, phone: string | null): Promise<string | null> {
  if (!phone) return null;
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  const match = await db.patient.findFirst({
    where: { tenantId, ...notDeleted, OR: [{ phone: { in: variants } }, { whatsapp: { in: variants } }] },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return match?.id ?? null;
}

/**
 * Store a submission for a live link. Returns null when the token does not
 * resolve (the route answers 404). The link's `uses` is bumped by one atomic
 * conditional UPDATE, so a `maxUses` limit holds under concurrent submissions
 * and two patients sending through the desk QR at the same moment both land.
 */
export async function submitPublicIntake(
  token: string,
  body: unknown,
  meta: { ip?: string | null; host?: string | null } = {},
): Promise<{ ok: true } | null> {
  const tenantId = await tenantOfToken(token);
  return tenantId ? withTenant(tenantId, () => submitToLink(token, body, meta)) : null;
}

async function submitToLink(token: string, body: unknown, meta: { ip?: string | null; host?: string | null }): Promise<{ ok: true } | null> {
  const link = await resolveLink(token, { host: meta.host });
  if (!link) return null;
  const form = IntakeFormInput.parse(body);

  // Only treatments the clinic offers survive; unknown keys are dropped quietly.
  const offered = new Set((await listTreatments(link.tenantId)).map((t) => t.key));
  form.treatmentKeys = form.treatmentKeys.filter((k) => offered.has(k));
  if (link.kind === "PATIENT") form.language = form.language ?? asLanguage(link.language);

  const matchedPatientId =
    link.kind === "PATIENT" && link.patient ? link.patient.id : await findPatientByPhone(link.tenantId, form.phone);

  const submission = await db.$transaction(async (tx) => {
    // Revocation, expiry and the use limit are re-checked by the UPDATE itself
    // (row-locked), not by the read above.
    const bumped = await tx.intakeLink.updateMany({
      where: {
        id: link.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(link.maxUses !== null ? { uses: { lt: link.maxUses } } : {}),
      },
      data: { uses: { increment: 1 } },
    });
    if (bumped.count === 0) throw new IntakeError("link_unavailable", 404, "Link not found");
    return tx.intakeSubmission.create({
      data: {
        tenantId: link.tenantId,
        linkId: link.id,
        status: "PENDING",
        fullName: form.fullName,
        phone: form.phone,
        email: form.email ?? null,
        data: form as unknown as Prisma.InputJsonObject,
        matchedPatientId,
        ip: meta.ip ?? null,
      },
      select: { id: true, fullName: true, phone: true },
    });
  });

  await audit({
    tenantId: link.tenantId,
    ip: meta.ip,
    action: "intake.submission.create",
    entity: "IntakeSubmission",
    entityId: submission.id,
    after: { linkId: link.id, kind: link.kind, matchedPatientId, language: form.language },
  });
  notify(link.tenantId, {
    kind: "INTAKE_SUBMITTED",
    title: "Onboarding form received",
    body: `${submission.fullName}${submission.phone ? ` · ${submission.phone}` : ""}${matchedPatientId ? " · matches an existing patient" : ""}`,
    href: INTAKE_REVIEW_PATH,
    entity: "IntakeSubmission",
    entityId: submission.id,
    roles: ["RECEPTIONIST", "CLINIC_OWNER"],
  }).catch((err) => console.error("[intake] notify failed", err));
  return { ok: true };
}

// ── Submissions (staff) ───────────────────────────────────────────────────────

const submissionInclude = {
  link: { select: { id: true, kind: true, label: true, language: true } },
} satisfies Prisma.IntakeSubmissionInclude;

type SubmissionRow = Prisma.IntakeSubmissionGetPayload<{ include: typeof submissionInclude }>;

async function toSubmissionDTOs(tenantId: string, rows: SubmissionRow[]): Promise<IntakeSubmissionDTO[]> {
  const patientIds = [...new Set(rows.flatMap((r) => [r.matchedPatientId, r.patientId]).filter((id): id is string => Boolean(id)))];
  const [patients, users] = await Promise.all([
    patientIds.length
      ? db.patient.findMany({ where: { tenantId, id: { in: patientIds } }, select: { id: true, fullName: true, phone: true, deletedAt: true } })
      : Promise.resolve([]),
    userNames(tenantId, rows.map((r) => r.reviewedById)),
  ]);
  const patientById = new Map(patients.map((p) => [p.id, p]));
  return rows.map((r) => {
    const data = parseStoredForm(r.data, { fullName: r.fullName, phone: r.phone, language: r.link.language });
    const matched = r.matchedPatientId ? patientById.get(r.matchedPatientId) : null;
    const patient = r.patientId ? patientById.get(r.patientId) : null;
    return {
      id: r.id,
      status: r.status,
      fullName: r.fullName,
      phone: r.phone,
      email: r.email,
      language: data.language,
      submittedAt: r.submittedAt.toISOString(),
      data,
      link: { id: r.link.id, kind: r.link.kind, label: r.link.label, language: asLanguage(r.link.language) },
      matchedPatient: matched && !matched.deletedAt ? { id: matched.id, fullName: matched.fullName, phone: matched.phone } : null,
      patient: patient ? { id: patient.id, fullName: patient.fullName } : null,
      reviewedBy: r.reviewedById ? { id: r.reviewedById, fullName: users.get(r.reviewedById) ?? "Staff" } : null,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewNote: r.reviewNote,
    };
  });
}

export interface ListSubmissionsOptions {
  status?: IntakeStatus | "all";
  page?: number;
  pageSize?: number;
  patientId?: string;
}

export async function listSubmissions(tenantId: string, opts: ListSubmissionsOptions = {}) {
  const params = new URLSearchParams();
  if (opts.page !== undefined) params.set("page", String(opts.page));
  if (opts.pageSize !== undefined) params.set("pageSize", String(opts.pageSize));
  const { page, pageSize, skip, take } = parsePaging(params);
  const status = opts.status ?? "PENDING";
  const where: Prisma.IntakeSubmissionWhereInput = {
    tenantId,
    ...(status === "all" ? {} : { status }),
    ...(opts.patientId ? { OR: [{ patientId: opts.patientId }, { matchedPatientId: opts.patientId }] } : {}),
  };
  const [rows, total] = await db.$transaction([
    db.intakeSubmission.findMany({
      where,
      orderBy: status === "PENDING" ? [{ submittedAt: "asc" }, { id: "asc" }] : [{ submittedAt: "desc" }, { id: "desc" }],
      skip,
      take,
      include: submissionInclude,
    }),
    db.intakeSubmission.count({ where }),
  ]);
  return { submissions: await toSubmissionDTOs(tenantId, rows), total, page, pageSize };
}

export async function countPendingSubmissions(tenantId: string): Promise<number> {
  return db.intakeSubmission.count({ where: { tenantId, status: "PENDING" } });
}

export async function countSubmissionsByStatus(tenantId: string): Promise<Record<IntakeStatus, number>> {
  const rows = await db.intakeSubmission.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } });
  const out: Record<IntakeStatus, number> = { PENDING: 0, ACCEPTED: 0, REJECTED: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

/** Everything the patient page's onboarding card shows; `patient` is null when the id is not the tenant's. */
export async function getPatientIntake(tenantId: string, patientId: string) {
  const [patient, { links }, { submissions }] = await Promise.all([
    db.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, fullName: true, language: true } }),
    listIntakeLinks(tenantId, { patientId, pageSize: 10 }),
    listSubmissions(tenantId, { patientId, status: "all", pageSize: 10 }),
  ]);
  return { patient, links, submissions };
}

export const AcceptSubmissionInput = z.object({
  mode: z.enum(["create", "merge"]),
  patientId: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), zText(64).optional()),
});
export type AcceptSubmissionInput = z.input<typeof AcceptSubmissionInput>;

export const RejectSubmissionInput = z.object({
  note: zText(500).min(1, "Say why the form is rejected"),
});

/**
 * Claim a pending submission inside the review transaction. The conditional
 * UPDATE takes the row lock, so of two receptionists pressing "Accept" at the
 * same moment exactly one wins and the other gets the 409, never a second patient.
 */
async function claimPending(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
  data: Prisma.IntakeSubmissionUpdateManyMutationInput,
): Promise<void> {
  const claimed = await tx.intakeSubmission.updateMany({ where: { id, tenantId, status: "PENDING" }, data });
  if (!claimed.count) throw new IntakeError("not_pending", 409, "Submission already reviewed");
}

function summaryBody(form: IntakeForm, link: { kind: IntakeLinkKind; label: string | null }, treatmentNames: string[]): string {
  const via = link.kind === "PATIENT" ? "personal link" : `open link${link.label ? ` (${link.label})` : ""}`;
  const concern = [form.concern, form.sinceWhen ? `since ${form.sinceWhen}` : null].filter(Boolean).join(" — ");
  return [
    `Submitted via ${via} in ${form.language === "ar" ? "Arabic" : "English"}.`,
    `Interested in: ${treatmentNames.length ? treatmentNames.join(", ") : "—"}.`,
    concern ? `Concern: ${concern}.` : null,
    form.whatsappUpdates ? "Agreed to WhatsApp updates." : null,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000);
}

/**
 * Accept a pending submission into a patient record: `create` builds a new
 * patient (profile, medical history lists, medications), `merge` fills the
 * empty fields of an existing patient and appends history without duplicates.
 * Both write an INTAKE timeline event and audit entries. Null when the
 * submission is not the tenant's; 409 when it was already reviewed.
 */
export async function acceptSubmission(tenantId: string, id: string, input: unknown, actor: Actor = {}) {
  const data = AcceptSubmissionInput.parse(input);
  const submission = await db.intakeSubmission.findFirst({ where: { id, tenantId }, include: submissionInclude });
  if (!submission) return null;
  if (submission.status !== "PENDING") {
    throw new IntakeError("not_pending", 409, `Submission already ${submission.status.toLowerCase()}`);
  }
  const form = parseStoredForm(submission.data, { fullName: submission.fullName, phone: submission.phone, language: submission.link.language });
  const treatments = await listTreatments(tenantId);
  const treatmentByKey = new Map(treatments.map((t) => [t.key, t.name]));
  const treatmentKeys = form.treatmentKeys.filter((k) => treatmentByKey.has(k));
  const treatmentNames = treatmentKeys.map((k) => treatmentByKey.get(k)!);
  const body = summaryBody(form, submission.link, treatmentNames);
  const now = new Date();
  const whatsapp = intakeWhatsapp(form);
  const emergencyContact = intakeEmergencyContact(form);
  const dateOfBirth = form.dateOfBirth ? new Date(`${form.dateOfBirth}T00:00:00.000Z`) : null;

  let patientId: string;
  let created = false;
  let auditPatient: { action: string; before?: unknown; after: unknown };

  const accepted = { status: "ACCEPTED" as const, reviewedById: actor.id ?? null, reviewedAt: now, reviewNote: null };

  if (data.mode === "create") {
    const patient = await db.$transaction(async (tx) => {
      await claimPending(tx, tenantId, submission.id, accepted);
      const p = await tx.patient.create({
        data: {
          tenantId,
          fullName: form.fullName,
          gender: form.gender,
          dateOfBirth,
          phone: form.phone,
          whatsapp,
          email: form.email ?? null,
          city: form.city ?? null,
          nationalId: form.nationalId ?? null,
          address: form.address ?? null,
          emergencyContact,
          language: form.language,
          tags: dedupeStrings(treatmentKeys),
          source: "WEBSITE",
          notes: form.concern ? `Onboarding form: ${form.concern}${form.sinceWhen ? ` (since ${form.sinceWhen})` : ""}`.slice(0, 2000) : null,
          medicalHistory: {
            create: {
              tenantId,
              chronicConditions: form.chronicConditions,
              allergies: form.allergies,
              surgeries: form.surgeries,
              diagnoses: [],
            },
          },
        },
        select: { id: true, fullName: true, phone: true, whatsapp: true, email: true, city: true, nationalId: true, tags: true, language: true, gender: true },
      });
      if (form.medications.length) {
        await tx.medication.createMany({
          data: form.medications.map((m) => ({ tenantId, patientId: p.id, name: m.name, dosage: m.dose ?? null, active: true })),
        });
      }
      await tx.timelineEvent.create({
        data: { tenantId, patientId: p.id, kind: "INTAKE", title: "Onboarding form received", body, refId: submission.id, occurredAt: submission.submittedAt },
      });
      await tx.intakeSubmission.update({ where: { id: submission.id }, data: { patientId: p.id } });
      return p;
    });
    patientId = patient.id;
    created = true;
    auditPatient = { action: "patient.create", after: { ...patient, source: "WEBSITE", via: "intake", submissionId: submission.id } };
  } else {
    const targetId = data.patientId ?? submission.matchedPatientId;
    if (!targetId) throw new IntakeError("patient_required", 422, "Choose the patient to merge into");
    await requireTenantPatient(tenantId, targetId);
    const existing = await db.patient.findFirstOrThrow({
      where: { id: targetId, tenantId, ...notDeleted },
      include: { medicalHistory: true, medications: { where: { tenantId, active: true }, select: { name: true } } },
    });

    const patch: Prisma.PatientUpdateInput = {};
    const fill = <K extends "phone" | "whatsapp" | "email" | "city" | "nationalId" | "address" | "emergencyContact">(key: K, value: string | null) => {
      if (!existing[key] && value) patch[key] = value;
    };
    fill("phone", form.phone);
    fill("whatsapp", whatsapp);
    fill("email", form.email ?? null);
    fill("city", form.city ?? null);
    fill("nationalId", form.nationalId ?? null);
    fill("address", form.address ?? null);
    fill("emergencyContact", emergencyContact);
    if (!existing.dateOfBirth && dateOfBirth) patch.dateOfBirth = dateOfBirth;
    if (existing.gender === "UNDISCLOSED" && form.gender !== "UNDISCLOSED") patch.gender = form.gender;
    const tags = dedupeStrings([...existing.tags, ...treatmentKeys]);
    if (tags.length !== existing.tags.length) patch.tags = tags;

    const before = historyLists(existing.medicalHistory);
    const after = {
      chronicConditions: dedupeStrings([...before.chronicConditions, ...form.chronicConditions]),
      allergies: dedupeStrings([...before.allergies, ...form.allergies]),
      surgeries: dedupeStrings([...before.surgeries, ...form.surgeries]),
      diagnoses: before.diagnoses,
    };
    const historyChanged =
      after.chronicConditions.length !== before.chronicConditions.length ||
      after.allergies.length !== before.allergies.length ||
      after.surgeries.length !== before.surgeries.length;
    const knownMeds = new Set(existing.medications.map((m) => m.name.toLowerCase()));
    const newMeds = form.medications.filter((m) => !knownMeds.has(m.name.toLowerCase()));

    await db.$transaction(async (tx) => {
      await claimPending(tx, tenantId, submission.id, accepted);
      if (Object.keys(patch).length) await tx.patient.update({ where: { id: existing.id }, data: patch });
      if (historyChanged) {
        await tx.medicalHistory.upsert({
          where: { patientId: existing.id },
          create: { tenantId, patientId: existing.id, ...after },
          update: { chronicConditions: after.chronicConditions, allergies: after.allergies, surgeries: after.surgeries },
        });
      }
      if (newMeds.length) {
        await tx.medication.createMany({
          data: newMeds.map((m) => ({ tenantId, patientId: existing.id, name: m.name, dosage: m.dose ?? null, active: true })),
        });
      }
      await tx.timelineEvent.create({
        data: { tenantId, patientId: existing.id, kind: "INTAKE", title: "Onboarding form received", body, refId: submission.id, occurredAt: submission.submittedAt },
      });
      await tx.intakeSubmission.update({ where: { id: submission.id }, data: { patientId: existing.id } });
    });
    patientId = existing.id;
    const changedKeys = Object.keys(patch) as (keyof typeof patch)[];
    auditPatient = {
      action: "patient.update",
      before: {
        ...Object.fromEntries(changedKeys.map((k) => [k, existing[k as keyof typeof existing] instanceof Date ? (existing[k as keyof typeof existing] as Date).toISOString() : existing[k as keyof typeof existing]])),
        history: before,
      },
      after: { ...Object.fromEntries(changedKeys.map((k) => [k, patch[k] instanceof Date ? (patch[k] as Date).toISOString() : patch[k]])), history: after, medicationsAdded: newMeds.map((m) => m.name), via: "intake", submissionId: submission.id },
    };
  }

  await Promise.all([
    audit({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      ip: actor.ip,
      action: "intake.submission.accept",
      entity: "IntakeSubmission",
      entityId: submission.id,
      before: { status: "PENDING" },
      after: { status: "ACCEPTED", mode: data.mode, patientId },
    }),
    audit({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      ip: actor.ip,
      action: auditPatient.action,
      entity: "Patient",
      entityId: patientId,
      before: auditPatient.before,
      after: auditPatient.after,
    }),
  ]);
  ingestInBackground({ kind: "patient", tenantId, id: patientId });

  const row = await db.intakeSubmission.findFirstOrThrow({ where: { id: submission.id, tenantId }, include: submissionInclude });
  const [dto] = await toSubmissionDTOs(tenantId, [row]);
  return { submission: dto!, patientId, created };
}

export async function rejectSubmission(tenantId: string, id: string, input: unknown, actor: Actor = {}): Promise<IntakeSubmissionDTO | null> {
  const data = RejectSubmissionInput.parse(input);
  const submission = await db.intakeSubmission.findFirst({ where: { id, tenantId }, include: submissionInclude });
  if (!submission) return null;
  if (submission.status !== "PENDING") {
    throw new IntakeError("not_pending", 409, `Submission already ${submission.status.toLowerCase()}`);
  }
  const row = await db.$transaction(async (tx) => {
    await claimPending(tx, tenantId, submission.id, { status: "REJECTED", reviewNote: data.note, reviewedById: actor.id ?? null, reviewedAt: new Date() });
    return tx.intakeSubmission.findFirstOrThrow({ where: { id: submission.id, tenantId }, include: submissionInclude });
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "intake.submission.reject",
    entity: "IntakeSubmission",
    entityId: row.id,
    before: { status: "PENDING" },
    after: { status: "REJECTED", note: data.note },
  });
  const [dto] = await toSubmissionDTOs(tenantId, [row]);
  return dto!;
}
