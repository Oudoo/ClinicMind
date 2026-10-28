/**
 * The audit-log screen's query vocabulary, shared by the page, the filter bar,
 * the API and the CSV export. Pure and client-safe: no database imports.
 *
 *   /dashboard/audit?actor=<userId|system>&patient=<id>&action=<group|code>&from=YYYY-MM-DD&to=YYYY-MM-DD&q=…&page=2
 */

export interface AuditQuery {
  /** Free text: part of an action code, a record id or an e-mail. */
  q?: string;
  /** A user id, "system" for automated entries, or "anonymous" for requests made without signing in. */
  actor?: string;
  patient?: string;
  /** An activity group key (see ACTION_GROUPS) or one exact action code. */
  action?: string;
  /** Clinic-calendar days, inclusive. */
  from?: string;
  to?: string;
  page?: number;
}

export const AUDIT_FILTER_KEYS = ["q", "actor", "patient", "action", "from", "to"] as const;

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTION = /^[a-z_]+(\.[a-z_]+)*$/;

export function parseAuditQuery(params: Params): AuditQuery {
  const q = read(params, "q")?.trim().slice(0, 120) || undefined;
  const actor = read(params, "actor")?.trim();
  const patient = read(params, "patient")?.trim();
  const action = read(params, "action")?.trim().toLowerCase();
  let from = read(params, "from")?.trim();
  let to = read(params, "to")?.trim();
  if (from && !DAY.test(from)) from = undefined;
  if (to && !DAY.test(to)) to = undefined;
  // A reversed range is read as the range the person meant.
  if (from && to && to < from) [from, to] = [to, from];
  const page = Number.parseInt(read(params, "page") ?? "1", 10);
  return {
    q,
    actor: actor && ID.test(actor) ? actor : undefined,
    patient: patient && ID.test(patient) ? patient : undefined,
    action: action && action.length <= 64 && ACTION.test(action) ? action : undefined,
    from,
    to,
    page: Number.isFinite(page) && page > 1 ? page : undefined,
  };
}

export function auditQueryParams(query: AuditQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of AUDIT_FILTER_KEYS) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  if (query.page && query.page > 1) params.set("page", String(query.page));
  return params;
}

export function hasAuditFilters(query: AuditQuery): boolean {
  return AUDIT_FILTER_KEYS.some((k) => Boolean(query[k]));
}

export function auditHref(query: AuditQuery = {}): string {
  const qs = auditQueryParams(query).toString();
  return `/dashboard/audit${qs ? `?${qs}` : ""}`;
}

export function auditExportHref(query: AuditQuery = {}): string {
  const qs = auditQueryParams({ ...query, page: undefined }).toString();
  return `/api/audit-logs/export${qs ? `?${qs}` : ""}`;
}

/**
 * Activity groups for the filter: each matches action codes starting with one
 * of its prefixes (`patient.…`) or ending with one of its suffixes (`….export`).
 */
export const ACTION_GROUPS: { key: string; label: string; prefixes: string[]; suffixes?: string[] }[] = [
  { key: "auth", label: "Sign-in and sign-out", prefixes: ["auth"] },
  { key: "patient", label: "Patient records", prefixes: ["patient", "medication"] },
  { key: "appointment", label: "Appointments", prefixes: ["appointment"] },
  { key: "consultation", label: "Consultations and prescribing", prefixes: ["consultation", "review_snapshot"] },
  { key: "procedure", label: "Procedures", prefixes: ["procedure"] },
  { key: "payment", label: "Payments and finance", prefixes: ["payment", "finance"] },
  { key: "conversation", label: "Conversations and messaging", prefixes: ["conversation", "messaging"] },
  { key: "lead", label: "Leads and campaigns", prefixes: ["lead", "campaign"] },
  { key: "intake", label: "Onboarding forms", prefixes: ["intake"] },
  { key: "concierge", label: "Concierge", prefixes: ["concierge"] },
  { key: "assistant", label: "AI assistant", prefixes: ["assistant"] },
  { key: "user", label: "Team and access", prefixes: ["user", "embed"] },
  { key: "tenant", label: "Clinic settings", prefixes: ["tenant", "metric_target", "notification", "alert_rule", "report"] },
  { key: "exports", label: "Data exports (any)", prefixes: [], suffixes: ["export"] },
];

/** The prefixes and suffixes an `action` filter stands for, or the exact code when it is one. */
export function actionFilter(action: string): { prefixes: string[]; suffixes: string[] } | { exact: string } {
  const group = ACTION_GROUPS.find((g) => g.key === action);
  return group ? { prefixes: group.prefixes, suffixes: group.suffixes ?? [] } : { exact: action };
}

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.login_locked": "Sign-in refused: account locked",
  "auth.logout": "Signed out",
  "auth.password_reset_requested": "Password reset requested",
  "finance.export": "Exported finance data",
  "report.export": "Exported a report table",
  "user.invite.accept": "Accepted an invitation",
  "user.password.reset": "Reset their password",
  "patient.create": "Added a patient",
  "patient.update": "Edited patient details",
  "patient.archive": "Archived a patient",
  "patient.restore": "Restored a patient",
  "patient.export": "Exported the patient list",
  "patient.record.view": "Opened a patient record",
  "patient.history.update": "Edited the medical history",
  "patient.history.extract": "Drafted history with AI",
  "patient.view.create": "Saved a patient-list view",
  "patient.view.update": "Changed a saved view",
  "patient.view.delete": "Deleted a saved view",
  "appointment.create": "Booked an appointment",
  "appointment.update": "Edited an appointment",
  "appointment.reschedule": "Rescheduled an appointment",
  "appointment.transition": "Changed an appointment's status",
  "appointment.note.create": "Added an appointment note",
  "appointment.note.delete": "Deleted an appointment note",
  "consultation.sign": "Signed a consultation",
  "consultation.discard": "Discarded a consultation draft",
  "consultation.transcribe": "Transcribed a recording",
  "consultation.extract": "Drafted a note with AI",
  "consultation.safety_override": "Overrode a prescribing safety check",
  "procedure.create": "Recorded a procedure",
  "procedure.update": "Edited a procedure",
  "procedure.sign": "Signed a procedure",
  "procedure.cancel": "Cancelled a procedure",
  "payment.record": "Recorded a payment",
  "payment.void": "Voided a payment",
  "payment.import": "Imported card-machine payments",
  "conversation.reply": "Replied to a conversation",
  "conversation.read": "Read a conversation",
  "conversation.update": "Updated a conversation",
  "conversation.close": "Closed a conversation",
  "conversation.reopen": "Reopened a conversation",
  "conversation.inbound.open": "New conversation received",
  "lead.create": "Added a lead",
  "lead.update": "Edited a lead",
  "lead.stage": "Moved a lead",
  "lead.lost": "Marked a lead lost",
  "lead.reopen": "Reopened a lead",
  "lead.convert": "Converted a lead to a patient",
  "lead.book": "Booked a lead",
  "intake.link.create": "Created an onboarding link",
  "intake.link.revoke": "Revoked an onboarding link",
  "intake.submission.create": "Onboarding form submitted",
  "intake.submission.accept": "Accepted an onboarding form",
  "intake.submission.reject": "Rejected an onboarding form",
  "assistant.query": "Asked the AI assistant about patients",
  "user.invite": "Invited a team member",
  "user.invite.resend": "Resent an invitation",
  "user.clinician": "Changed a clinician mark",
  "tenant.update": "Changed clinic settings",
  "tenant.branding": "Changed branding",
  "tenant.status": "Changed the clinic's status",
  "tenant.provision": "Created the clinic",
  "embed.token.mint": "Opened from an embedding app",
  "audit.export": "Exported the audit log",
};

/** A readable sentence for an action code; unknown codes are spelled out. */
export function describeAction(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const [head, ...rest] = action.split(".");
  const words = (s: string) => s.replace(/_/g, " ");
  const subject = words(head ?? action);
  const label = rest.length ? `${subject}: ${rest.map(words).join(" ")}` : subject;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** A short display form of a snapshot value. */
export function displayValue(v: unknown, max = 80): string | null {
  if (v === null || v === undefined || v === "") return null;
  let text: string;
  if (typeof v === "string") text = v;
  else if (typeof v === "number" || typeof v === "boolean") text = String(v);
  else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) text = v.join(", ");
  else text = JSON.stringify(v);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "createdAt" → "created at", "patientId" → "patient id". */
export function fieldLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

/**
 * The fields an entry changed: keys whose value differs between the before and
 * after snapshots (or every key of the one snapshot present). Snapshots that
 * are not objects are compared whole.
 */
export function changedFields(before: unknown, after: unknown, limit = 40): FieldChange[] {
  if (before === null || before === undefined) before = undefined;
  if (after === null || after === undefined) after = undefined;
  if (before === undefined && after === undefined) return [];
  if (!isRecord(before ?? {}) || !isRecord(after ?? {})) {
    const a = displayValue(before);
    const b = displayValue(after);
    return a === b ? [] : [{ field: "value", from: a, to: b }];
  }
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const changes: FieldChange[] = [];
  for (const key of keys) {
    if (JSON.stringify(b[key]) === JSON.stringify(a[key])) continue;
    changes.push({ field: key, from: displayValue(b[key]), to: displayValue(a[key]) });
    if (changes.length >= limit) break;
  }
  return changes;
}

/** What kind of record an entry is about, in words (entries about a patient show the patient instead). */
export const ENTITY_LABELS: Record<string, string> = {
  Tenant: "Clinic",
  Finance: "Finance",
  Report: "Report",
  User: "Team member",
  AuditLog: "Audit log",
  Notification: "Notification",
  NotificationPreference: "Notification settings",
  AlertRule: "Alert rule",
  MetricTarget: "Metric target",
  MessageTemplate: "Message template",
  ChannelIntegration: "Messaging channel",
  TenantEmbedConfig: "Embedding",
  Campaign: "Campaign",
  CampaignCost: "Campaign cost",
  Lead: "Lead",
  LeadFollowUp: "Lead follow-up",
  Protocol: "Concierge protocol",
  IntakeLink: "Onboarding link",
  SavedView: "Saved view",
  WeeklyBrief: "Weekly brief",
  PaymentImport: "Card-machine import",
};

/** "Chrome · Windows" from a user-agent string; null when there is none. */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (!browser && !os) return ua.length > 40 ? `${ua.slice(0, 39)}…` : ua;
  return [browser, os].filter(Boolean).join(" · ");
}
