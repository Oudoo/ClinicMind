import type { Gender, PrismaClient, UserRole } from "@prisma/client";
import { seedTreatments } from "./treatments";
import { seedPrices } from "./prices";
import { seedCrm } from "./crm";
import { seedFinance } from "./finance";
import { seedCourses } from "./courses";
import { seedInvoices } from "./invoices";
import { seedConcierge } from "./concierge";
import { seedIntake } from "./intake";
import { seedAppointmentNotes } from "./appointment-notes";
import { seedReporting } from "./reporting";
import { seedNotifications } from "./notifications";
import { seedSafety } from "./safety";

/**
 * The second half of the demo seed: everything the PM round-2 modules need
 * (the price list, CRM leads and conversations, procedures and payments, concierge
 * enrolments, intake links, dictated appointment notes, campaign costs,
 * review snapshots, alert rules, prescribing-safety overrides, notifications).
 * Runs after the core clinic
 * (staff, patients, appointments, visits) exists; each module reads what it
 * needs from the database and keeps its own deterministic random stream.
 */
export interface SeedUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  kind: "derm" | "hair" | null;
}

export interface SeedPatient {
  id: string;
  fullName: string;
  language: string;
  phone: string;
  gender: Gender;
  /** The clinical scenario key from the core seed (e.g. "fue", "acne", "melasma"). */
  condKey: string;
  /** The patient tag of that scenario (e.g. "hair-transplant"). */
  tag: string;
  doctorKind: "derm" | "hair";
}

export interface SeedContext {
  db: PrismaClient;
  tenantId: string;
  clinicId: string;
  users: SeedUser[];
  patients: SeedPatient[];
  /** An instant on the clinic clock (Africa/Cairo). */
  zoned: (y: number, m: number, d: number, h: number, min: number) => Date;
  /** Calendar fields of today ± offset days on the clinic clock. */
  calendarDay: (offsetDays: number) => { y: number; m: number; d: number; weekday: number };
  today: Date;
}

export async function seedRound2(ctx: SeedContext): Promise<void> {
  const steps: [string, (c: SeedContext) => Promise<void>][] = [
    ["treatments", seedTreatments],
    ["price list", seedPrices],
    ["crm", seedCrm],
    ["finance", seedFinance],
    ["courses", seedCourses],
    ["receipts and invoices", seedInvoices],
    ["concierge", seedConcierge],
    ["intake", seedIntake],
    ["appointment notes", seedAppointmentNotes],
    ["reporting", seedReporting],
    ["prescribing safety", seedSafety],
    ["notifications", seedNotifications],
  ];
  for (const [name, fn] of steps) {
    const started = Date.now();
    await fn(ctx);
    console.log(`   · ${name} seeded (${Date.now() - started} ms)`);
  }
}
