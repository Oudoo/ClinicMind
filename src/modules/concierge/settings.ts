import type { UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { readTenantSetting, updateTenantSettings } from "@/lib/tenant-settings";
import { requireTenantUser } from "@/lib/tenant-scope";
import { zonedParts, type Weekday } from "@/lib/time";

/**
 * The concierge roster and hours: who a high-risk reply reaches in hours and
 * out of hours, who backs them up, and the acknowledgement targets (15 minutes
 * in hours, 30 out of hours per the spec). Stored under the tenant setting
 * key "concierge"; the defaults name the nurse in hours, the first doctor out
 * of hours and the owner as backup when the roster is empty.
 */
export const SETTINGS_KEY = "concierge";

const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");
const zUserId = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(64).nullable().optional());

export const ConciergeSettingsInput = z.object({
  hours: z.object({
    days: z.array(z.number().int().min(0).max(6)).max(7).transform((d) => [...new Set(d)].sort()),
    start: zTime,
    end: zTime,
  }),
  roster: z.object({
    inHoursUserId: zUserId,
    outOfHoursUserId: zUserId,
    backupUserId: zUserId,
  }),
  ackMinutes: z.object({
    inHours: z.number().int().min(1).max(240),
    outOfHours: z.number().int().min(1).max(240),
  }),
});
export type ConciergeSettingsInput = z.input<typeof ConciergeSettingsInput>;

export interface ConciergeSettings {
  hours: { days: number[]; start: string; end: string };
  roster: { inHoursUserId: string | null; outOfHoursUserId: string | null; backupUserId: string | null };
  ackMinutes: { inHours: number; outOfHours: number };
}

/** Saturday–Thursday, 09:00–21:00, 15 / 30 minutes; the roster falls back to roles. */
export const DEFAULT_CONCIERGE_SETTINGS: ConciergeSettings = {
  hours: { days: [6, 0, 1, 2, 3, 4], start: "09:00", end: "21:00" },
  roster: { inHoursUserId: null, outOfHoursUserId: null, backupUserId: null },
  ackMinutes: { inHours: 15, outOfHours: 30 },
};

/** How long a WATCH escalation may wait for a human. */
export const WATCH_ACK_MINUTES = 240;

/** Whatever is stored, merged over the defaults; junk never breaks the roster. */
export function normalizeSettings(raw: unknown): ConciergeSettings {
  const d = DEFAULT_CONCIERGE_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const hours = r.hours ?? {};
  const roster = r.roster ?? {};
  const ack = r.ackMinutes ?? {};
  const days = Array.isArray(hours.days) ? hours.days.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6) : d.hours.days;
  const time = (v: unknown, fallback: string) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback);
  const id = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const minutes = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 240 ? v : fallback);
  return {
    hours: { days: [...new Set(days)].sort(), start: time(hours.start, d.hours.start), end: time(hours.end, d.hours.end) },
    roster: { inHoursUserId: id(roster.inHoursUserId), outOfHoursUserId: id(roster.outOfHoursUserId), backupUserId: id(roster.backupUserId) },
    ackMinutes: { inHours: minutes(ack.inHours, d.ackMinutes.inHours), outOfHours: minutes(ack.outOfHours, d.ackMinutes.outOfHours) },
  };
}

export async function readConciergeSettings(tenantId: string): Promise<ConciergeSettings> {
  return normalizeSettings(await readTenantSetting<unknown>(tenantId, SETTINGS_KEY, null));
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when the clinic clock says the roster's in-hours person is on. Overnight ranges (22:00–06:00) work. */
export function isWithinHours(now: Date, timeZone: string, hours: ConciergeSettings["hours"]): boolean {
  if (!hours.days.length) return false;
  const p = zonedParts(now, timeZone);
  const minute = p.hour * 60 + p.minute;
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  const onDay = (weekday: Weekday) => hours.days.includes(weekday);
  if (start === end) return onDay(p.weekday);
  if (start < end) return onDay(p.weekday) && minute >= start && minute < end;
  // Overnight: the shift that started yesterday evening still runs this morning.
  if (minute >= start) return onDay(p.weekday);
  const yesterday = ((p.weekday + 6) % 7) as Weekday;
  return minute < end && onDay(yesterday);
}

export interface StaffRef {
  id: string;
  fullName: string;
  role: UserRole;
}

export interface ResolvedRoster {
  inHours: StaffRef | null;
  outOfHours: StaffRef | null;
  backup: StaffRef | null;
  /** Every active owner: always told about an escalation. */
  owners: StaffRef[];
  /** Which entries came from the defaults rather than the saved roster. */
  defaults: { inHours: boolean; outOfHours: boolean; backup: boolean };
}

/**
 * The roster as people: saved ids that still name an active member of the
 * tenant, else the defaults (nurse in hours, first doctor out of hours, the
 * owner as backup).
 */
export async function resolveRoster(tenantId: string, settings: ConciergeSettings): Promise<ResolvedRoster> {
  const users = await db.user.findMany({
    where: { tenantId, ...notDeleted, status: "ACTIVE", role: { in: ["CLINIC_OWNER", "DOCTOR", "NURSE"] } },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, fullName: true, email: true, role: true },
  });
  const refs: StaffRef[] = users.map((u) => ({ id: u.id, fullName: u.fullName ?? u.email, role: u.role }));
  const byId = new Map(refs.map((u) => [u.id, u]));
  const firstOf = (role: UserRole) => refs.find((u) => u.role === role) ?? null;
  const owners = refs.filter((u) => u.role === "CLINIC_OWNER");
  const saved = (id: string | null) => (id ? (byId.get(id) ?? null) : null);

  const inHoursSaved = saved(settings.roster.inHoursUserId);
  const outSaved = saved(settings.roster.outOfHoursUserId);
  const backupSaved = saved(settings.roster.backupUserId);
  const inHours = inHoursSaved ?? firstOf("NURSE") ?? firstOf("DOCTOR") ?? owners[0] ?? null;
  const outOfHours = outSaved ?? firstOf("DOCTOR") ?? owners[0] ?? inHours;
  const backup = backupSaved ?? owners[0] ?? firstOf("DOCTOR") ?? null;
  return {
    inHours,
    outOfHours,
    backup,
    owners,
    defaults: { inHours: !inHoursSaved, outOfHours: !outSaved, backup: !backupSaved },
  };
}

export interface Assignment {
  assignedToId: string | null;
  backupId: string | null;
  ownerIds: string[];
  outOfHours: boolean;
  ackMinutes: number;
}

/** Who a new escalation goes to right now, and how long they have. */
export async function resolveAssignee(tenantId: string, settings: ConciergeSettings, outOfHours: boolean): Promise<Assignment> {
  const roster = await resolveRoster(tenantId, settings);
  const primary = outOfHours ? roster.outOfHours : roster.inHours;
  const assignedToId = primary?.id ?? roster.backup?.id ?? null;
  return {
    assignedToId,
    backupId: roster.backup && roster.backup.id !== assignedToId ? roster.backup.id : null,
    ownerIds: roster.owners.map((o) => o.id),
    outOfHours,
    ackMinutes: outOfHours ? settings.ackMinutes.outOfHours : settings.ackMinutes.inHours,
  };
}

export async function updateConciergeSettings(
  tenantId: string,
  rawInput: unknown,
  actor: { id?: string | null; email?: string | null; ip?: string | null } = {},
): Promise<ConciergeSettings> {
  const input = ConciergeSettingsInput.parse(rawInput);
  // Every user id a request supplies must belong to the tenant (SEC-4).
  for (const id of [input.roster.inHoursUserId, input.roster.outOfHoursUserId, input.roster.backupUserId]) {
    if (id) await requireTenantUser(tenantId, id);
  }
  const before = await readConciergeSettings(tenantId);
  const next: ConciergeSettings = {
    hours: input.hours,
    roster: {
      inHoursUserId: input.roster.inHoursUserId ?? null,
      outOfHoursUserId: input.roster.outOfHoursUserId ?? null,
      backupUserId: input.roster.backupUserId ?? null,
    },
    ackMinutes: input.ackMinutes,
  };
  await updateTenantSettings(tenantId, { [SETTINGS_KEY]: next });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.settings.update",
    entity: "Tenant",
    entityId: tenantId,
    before,
    after: next,
  });
  return next;
}
