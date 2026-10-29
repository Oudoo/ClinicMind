import { z } from "zod";
import { audit } from "@/lib/audit";
import { readTenantSetting, updateTenantSettings } from "@/lib/tenant-settings";
import { addDays, zonedParts, zonedTimeToUtc } from "@/lib/time";

/**
 * What the clinic sends on its own, and when it never does: the appointment
 * reminders (48 and 2 hours before), the recall messages (14 days before the
 * due day, on it and 7 days after), the call list of the next open day's unconfirmed
 * visits, and the quiet hours in which no automatic message goes out (on the
 * clinic clock; a message due then waits for their end). Stored under the
 * tenant setting key "reminders"; the owner edits it in Settings.
 */
export const SETTINGS_KEY = "reminders";

const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");

export const ReminderSettingsInput = z
  .object({
    quietStart: zTime,
    quietEnd: zTime,
    appointmentReminders: z.boolean(),
    recallMessages: z.boolean(),
    confirmCallsFrom: zTime,
  })
  .superRefine((v, ctx) => {
    if (v.quietStart === v.quietEnd) ctx.addIssue({ code: "custom", path: ["quietEnd"], message: "Quiet hours need a start and a different end" });
  });
export type ReminderSettingsInput = z.input<typeof ReminderSettingsInput>;

export interface ReminderSettings {
  /** No automatic message from this time… */
  quietStart: string;
  /** …until this one (the next morning when it is earlier). */
  quietEnd: string;
  appointmentReminders: boolean;
  recallMessages: boolean;
  /** From this time the day before, the next open day's unconfirmed visits are listed for a call. */
  confirmCallsFrom: string;
}

/** Quiet from 21:00 to 10:00 (the clinic opens at 10); everything on; the next open day's calls listed from noon. */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  quietStart: "21:00",
  quietEnd: "10:00",
  appointmentReminders: true,
  recallMessages: true,
  confirmCallsFrom: "12:00",
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whatever is stored, merged over the defaults. */
export function normalizeReminderSettings(raw: unknown): ReminderSettings {
  const d = DEFAULT_REMINDER_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const time = (v: unknown, fallback: string) => (typeof v === "string" && TIME.test(v) ? v : fallback);
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const quietStart = time(r.quietStart, d.quietStart);
  const quietEnd = time(r.quietEnd, d.quietEnd);
  return {
    quietStart,
    quietEnd: quietEnd === quietStart ? d.quietEnd : quietEnd,
    appointmentReminders: flag(r.appointmentReminders, d.appointmentReminders),
    recallMessages: flag(r.recallMessages, d.recallMessages),
    confirmCallsFrom: time(r.confirmCallsFrom, d.confirmCallsFrom),
  };
}

export async function readReminderSettings(tenantId: string): Promise<ReminderSettings> {
  return normalizeReminderSettings(await readTenantSetting<unknown>(tenantId, SETTINGS_KEY, null));
}

export async function saveReminderSettings(tenantId: string, raw: unknown, actor: { id?: string | null; email?: string | null; ip?: string | null } = {}): Promise<ReminderSettings> {
  const input = ReminderSettingsInput.parse(raw);
  const before = await readReminderSettings(tenantId);
  await updateTenantSettings(tenantId, { [SETTINGS_KEY]: input });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "tenant.reminders.update", entity: "Tenant", entityId: tenantId, before: { ...before }, after: { ...input } });
  return normalizeReminderSettings(input);
}

const minutesOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Is `now` inside the quiet hours on the clinic clock? */
export function isQuiet(now: Date, timeZone: string, s: Pick<ReminderSettings, "quietStart" | "quietEnd">): boolean {
  const p = zonedParts(now, timeZone);
  const m = p.hour * 60 + p.minute;
  const start = minutesOf(s.quietStart);
  const end = minutesOf(s.quietEnd);
  return start > end ? m >= start || m < end : m >= start && m < end;
}

/** The moment the quiet hours end on the clinic day of `day` (when an automatic message of that day may go). */
export function quietEndOn(day: Date, timeZone: string, s: Pick<ReminderSettings, "quietEnd">, plusDays = 0): Date {
  const p = zonedParts(addDays(day, plusDays, timeZone), timeZone);
  const end = minutesOf(s.quietEnd);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(end / 60), minute: end % 60 }, timeZone);
}

/** A time of day ("12:00") on the clinic day of `day`. */
export function timeOn(day: Date, timeZone: string, time: string): Date {
  const p = zonedParts(day, timeZone);
  const m = minutesOf(time);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(m / 60), minute: m % 60 }, timeZone);
}
