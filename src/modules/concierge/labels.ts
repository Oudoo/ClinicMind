import type { EnrolmentStatus, EscalationStatus, TaskStatus } from "./dto";
import type { Language, StepKind } from "./protocols";
import type { TriageLevel } from "./triage";

/**
 * Labels and badge tones shared by the concierge pages (server) and their
 * client components. Pure values, no server imports.
 */
export type Tone = "default" | "accent" | "success" | "warning" | "danger";

export const TRIAGE_TEXT: Record<TriageLevel, string> = { OK: "OK", WATCH: "Watch", HIGH_RISK: "High risk" };
export const TRIAGE_TONE: Record<TriageLevel, Tone> = { OK: "success", WATCH: "warning", HIGH_RISK: "danger" };

export const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  PENDING: "Scheduled",
  SENT: "Awaiting answer",
  ANSWERED: "Answered",
  MISSED: "Missed",
  SKIPPED: "Skipped",
};
export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = { PENDING: "default", SENT: "accent", ANSWERED: "success", MISSED: "danger", SKIPPED: "default" };

/** An instruction that went out is done ("Sent"); a check-in that went out waits for the patient. */
export function taskStatusText(status: TaskStatus, kind?: StepKind): string {
  return kind === "INSTRUCTION" && status === "SENT" ? "Sent" : TASK_STATUS_TEXT[status];
}

export function taskStatusTone(status: TaskStatus, kind?: StepKind): Tone {
  return kind === "INSTRUCTION" && status === "SENT" ? "success" : TASK_STATUS_TONE[status];
}

/** "Day 7 check-in" rather than "Day 7 · Day 7 check-in"; "Day 0 · Tonight after your transplant". */
export function stepTitle(dayLabel: string, title: string): string {
  return title.toLowerCase().startsWith(dayLabel.toLowerCase()) ? title : `${dayLabel} · ${title}`;
}

export const ENROLMENT_STATUS_TEXT: Record<EnrolmentStatus, string> = { ACTIVE: "Active", PAUSED: "Paused", COMPLETED: "Completed", STOPPED: "Stopped" };
export const ENROLMENT_STATUS_TONE: Record<EnrolmentStatus, Tone> = { ACTIVE: "accent", PAUSED: "warning", COMPLETED: "success", STOPPED: "default" };

export const ESCALATION_STATUS_TEXT: Record<EscalationStatus, string> = { OPEN: "Open", ACKNOWLEDGED: "Acknowledged", RESOLVED: "Resolved" };

export const KIND_TEXT: Record<StepKind, string> = { INSTRUCTION: "Instructions", CHECK_IN: "Check-in", PHOTO_REQUEST: "Photos" };

/** 0 = Sunday … 6 = Saturday; the Egyptian week starts on Saturday. */
export const WEEKDAY_ORDER = [6, 0, 1, 2, 3, 4, 5] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The photo views protocols ask for, in the patient's language. */
const VIEW_LABELS: Record<string, { ar: string; en: string }> = {
  front: { ar: "من قدام", en: "Front" },
  top: { ar: "من فوق", en: "Top" },
  donor: { ar: "المنطقة المانحة (من ورا)", en: "Donor area (back)" },
  back: { ar: "من ورا", en: "Back" },
  left: { ar: "الجنب الشمال", en: "Left side" },
  right: { ar: "الجنب اليمين", en: "Right side" },
  face: { ar: "الوش", en: "Face" },
  area: { ar: "مكان العلاج", en: "Treated area" },
};

export function viewLabel(view: string, language: Language = "en"): string {
  const known = VIEW_LABELS[view.trim().toLowerCase()];
  if (known) return known[language];
  return view.charAt(0).toUpperCase() + view.slice(1);
}

/** "12 min", "1 h 05 min", "2 d 3 h" for a duration in minutes (absolute value). */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(Math.abs(minutes)));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${String(rest).padStart(2, "0")} min` : `${h} h`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "in 12 min" / "12 min overdue" relative to `now`. */
export function relativeTarget(dueAt: string | Date, now: number): { text: string; overdue: boolean; minutes: number } {
  const due = typeof dueAt === "string" ? Date.parse(dueAt) : dueAt.getTime();
  const minutes = (due - now) / 60_000;
  if (minutes >= 0) return { text: minutes < 1 ? "less than a minute left" : `${formatMinutes(minutes)} left`, overdue: false, minutes };
  return { text: `${formatMinutes(minutes)} overdue`, overdue: true, minutes };
}

/** A check-in answer for staff eyes: "yes" / "3/10" / the text. */
export function answerText(type: string, value: unknown, max = 10): string {
  if (value === undefined || value === null || value === "") return "—";
  if (type === "yesno") return value === true || value === "yes" || value === "true" ? "Yes" : "No";
  if (type === "scale") return `${String(value)}/${max}`;
  return String(value);
}

/** "≤ 4" / "no" / "3–5" for the expected range of a question (staff view). */
export function expectedText(q: { type: string; expected?: { min?: number; max?: number; value?: boolean } | undefined }): string | null {
  const e = q.expected;
  if (!e) return null;
  if (q.type === "yesno") return typeof e.value === "boolean" ? (e.value ? "yes" : "no") : null;
  if (e.min !== undefined && e.max !== undefined) return `${e.min}–${e.max}`;
  if (e.max !== undefined) return `≤ ${e.max}`;
  if (e.min !== undefined) return `≥ ${e.min}`;
  return null;
}
