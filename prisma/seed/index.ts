import type { Gender, PrismaClient, UserRole } from "@prisma/client";
import { seedTreatments } from "./treatments";
import { seedPrices } from "./prices";
import { seedCrm } from "./crm";
import { seedFinance } from "./finance";
import { seedCourses } from "./courses";
import { seedInvoices } from "./invoices";
import { seedHouseholds } from "./households";
import { seedAdjustments } from "./adjustments";
import { seedCash } from "./cash";
import { seedConcierge } from "./concierge";
import { seedIntake } from "./intake";
import { seedAppointmentNotes } from "./appointment-notes";
import { seedReporting } from "./reporting";
import { seedNotifications } from "./notifications";
import { seedSafety } from "./safety";
import { seedRecalls } from "./recalls";
import { seedReminders } from "./reminders";
import { seedEvidence } from "./evidence";

/**
 * The second half of the demo seed: everything the PM round-2 modules need
 * (the price list, CRM leads and conversations, procedures and payments, concierge
 * enrolments, intake links, dictated appointment notes, campaign costs,
 * review snapshots, alert rules, prescribing-safety overrides, the evidence
 * library and recorded pregnancies, notifications, recalls, and the reminders
 * and recall messages the clinic sent on its own).
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
    ["family accounts", seedHouseholds],
    ["discounts and write-offs", seedAdjustments],
    // After every step that writes money: a day signed off takes no more.
    ["cash drawer", seedCash],
    ["concierge", seedConcierge],
    ["intake", seedIntake],
    ["appointment notes", seedAppointmentNotes],
    ["reporting", seedReporting],
    ["prescribing safety", seedSafety],
    // After the safety overrides: the isotretinoin one gets the negative test its reason names.
    ["evidence library and pregnancy", seedEvidence],
    ["notifications", seedNotifications],
    // Last: replays every signed procedure and consultation, then sweeps up to today.
    ["recalls", seedRecalls],
    // After the recalls: their automatic messages, beside the appointment reminders and the consents.
    ["reminders and consents", seedReminders],
  ];
  for (const [name, fn] of steps) {
    const started = Date.now();
    await fn(ctx);
    console.log(`   · ${name} seeded (${Date.now() - started} ms)`);
  }
}
