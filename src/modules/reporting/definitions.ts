/**
 * The thirteen reported metrics: ids, names, the exact definition shown on the
 * Definitions tab, the source tables and the unit of the headline value. No
 * server imports (client components render these).
 */
export const METRIC_IDS = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11", "M12", "M13"] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export type MetricUnit = "count" | "percent" | "egp" | "seconds" | "score";

export interface MetricDefinition {
  id: MetricId;
  name: string;
  definition: string;
  source: string;
  unit: MetricUnit;
  /** Which direction of change is good for the headline figure. */
  goodWhen: "up" | "down";
  /** The headline figure needs finance:read. */
  finance?: boolean;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    id: "M1",
    name: "Enquiries by treatment",
    definition:
      "New leads created in the period, grouped by the treatment they asked about. A lead with two interests counts once per interest; the number of such multi-interest leads is shown next to the total.",
    source: "Lead (createdAt, interests)",
    unit: "count",
    goodWhen: "up",
  },
  {
    id: "M2",
    name: "Lead to consultation conversion",
    definition:
      "Leads created in the period that attended a consultation within 30 days, divided by leads created in the period. Attended means checked in, in progress or completed; the consultation is the lead's own booking, else any CONSULTATION-kind appointment of the linked patient, from the day the lead was created up to 30 days after.",
    source: "Lead, Appointment",
    unit: "percent",
    goodWhen: "up",
  },
  {
    id: "M3",
    name: "Consultation to procedure conversion",
    definition:
      "Attended consultations in the period (CONSULTATION-kind appointments checked in, in progress or completed) followed by a SIGNED procedure for the same patient within 60 days (the same day included), divided by attended consultations. Broken down by the consulting doctor, by the treatment the consultation was booked for, and by the treatment of the procedure that followed.",
    source: "Appointment, Procedure",
    unit: "percent",
    goodWhen: "up",
  },
  {
    id: "M4",
    name: "Revenue by doctor and treatment",
    definition:
      "Revenue of SIGNED procedures by the date performed (price minus discount), by doctor and by treatment. Deposits and refunds are shown separately by the date paid; consultation fees are their own line. With a doctor or treatment filter, the money lines count payments linked to a matching procedure or consultation.",
    source: "Procedure, Payment",
    unit: "egp",
    goodWhen: "up",
    finance: true,
  },
  {
    id: "M5",
    name: "Average first-response time",
    definition:
      "Median and 90th percentile seconds from an inbound message to the first reply that follows it in the same conversation, split by who replied (AI or a human), by channel and by the hour of day the message arrived (clinic clock). A run of inbound messages before a reply is one wait, timed from its first message; automated sends (reminders, concierge steps) are not replies.",
    source: "Message (direction, author, createdAt), Conversation (channel)",
    unit: "seconds",
    goodWhen: "down",
  },
  {
    id: "M6",
    name: "No-show rate",
    definition:
      "Appointments with status NO_SHOW divided by booked appointments (every past appointment except CANCELLED and WAITLISTED), by doctor, by type, by weekday, by lead source (the appointment's lead, else the patient's source, else unknown) and by whether a deposit was paid (a DEPOSIT payment linked to the appointment, or paid by that patient before the appointment and after the previous one).",
    source: "Appointment, Lead, Patient, Payment",
    unit: "percent",
    goodWhen: "down",
  },
  {
    id: "M7",
    name: "Lost leads and reasons",
    definition:
      "Leads marked lost in the period, by reason (no response, price, distance, chose competitor, not a fit, timing, other) and by the stage they were at when lost.",
    source: "Lead (lostAt, lostReason, lostAtStage)",
    unit: "count",
    goodWhen: "down",
  },
  {
    id: "M8",
    name: "Most common objections",
    definition:
      "Objection tags the AI set on conversations opened in the period (price, pain, downtime, doubt about results, trust, timing), next to the objections staff confirmed on leads closed (won or lost) in the period: counts and the share of all conversations opened / all leads closed carrying each tag.",
    source: "Conversation (objections), Lead (objections)",
    unit: "count",
    goodWhen: "down",
  },
  {
    id: "M9",
    name: "Hair-transplant enquiries by source",
    definition: "Leads created in the period with the hair-transplant interest, by first-touch source and by campaign.",
    source: "Lead (source, campaignId, interests)",
    unit: "count",
    goodWhen: "up",
  },
  {
    id: "M10",
    name: "Repeat-patient rate",
    definition:
      "Patients whose first paid visit (first SIGNED procedure or first CONSULTATION_FEE payment) falls in the period shifted back 12 months, who had a second paid visit on a later day within 12 months of the first, divided by that cohort. Broken down by the first treatment (the procedure of that first day, else consultation only). The cohort window is stated on the screen.",
    source: "Patient, Procedure, Payment",
    unit: "percent",
    goodWhen: "up",
  },
  {
    id: "M11",
    name: "Patient satisfaction",
    definition:
      "Check-in satisfaction scores (1–5): for hair transplant the check-ins due about 30 days (month 1) and about 365 days (month 12) after the procedure; for other treatments the check-in due about 14 days after. Averages and counts, plus the public review count and rating pulled weekly (latest and the 12-week trend).",
    source: "CheckIn (satisfaction, task offset), ReviewSnapshot",
    unit: "score",
    goodWhen: "up",
  },
  {
    id: "M12",
    name: "Follow-ups overdue",
    definition:
      "Open lead follow-ups (not done, due in the past) and concierge escalations still unacknowledged past their target time, by owner or assignee, as of now. Escalations raised for an overdue follow-up are not counted twice.",
    source: "LeadFollowUp, Escalation",
    unit: "count",
    goodWhen: "down",
  },
  {
    id: "M13",
    name: "Campaign to procedure",
    definition:
      "For each campaign: leads created in the period, consultations attended (M2 rule), SIGNED procedures within 60 days of the consultation, their revenue, the campaign cost overlapping the period (pro-rated by days) and the cost per procedure (or “no procedures yet”).",
    source: "Lead, Appointment, Procedure, CampaignCost",
    unit: "egp",
    goodWhen: "down",
    finance: true,
  },
];

export const METRIC_BY_ID: Record<MetricId, MetricDefinition> = Object.fromEntries(METRIC_DEFINITIONS.map((d) => [d.id, d])) as Record<MetricId, MetricDefinition>;

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === "string" && (METRIC_IDS as readonly string[]).includes(value);
}

export const LOST_REASONS = ["NO_RESPONSE", "PRICE", "DISTANCE", "CHOSE_COMPETITOR", "NOT_A_FIT", "TIMING", "OTHER"] as const;
export const LOST_REASON_LABELS: Record<(typeof LOST_REASONS)[number], string> = {
  NO_RESPONSE: "No response",
  PRICE: "Price",
  DISTANCE: "Distance",
  CHOSE_COMPETITOR: "Chose competitor",
  NOT_A_FIT: "Not a fit",
  TIMING: "Timing",
  OTHER: "Other",
};

export const LEAD_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "CONSULTATION_BOOKED", "CONSULTATION_ATTENDED", "PROCEDURE_BOOKED", "WON", "LOST"] as const;
export const LEAD_STAGE_LABELS: Record<(typeof LEAD_STAGES)[number], string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CONSULTATION_BOOKED: "Consultation booked",
  CONSULTATION_ATTENDED: "Consultation attended",
  PROCEDURE_BOOKED: "Procedure booked",
  WON: "Won",
  LOST: "Lost",
};

export const OBJECTION_TAGS = ["PRICE", "PAIN", "DOWNTIME", "RESULTS_DOUBT", "TRUST", "TIMING"] as const;
export const OBJECTION_LABELS: Record<(typeof OBJECTION_TAGS)[number], string> = {
  PRICE: "Price",
  PAIN: "Pain",
  DOWNTIME: "Downtime",
  RESULTS_DOUBT: "Doubt about results",
  TRUST: "Trust",
  TIMING: "Timing",
};

export const APPOINTMENT_KIND_LABELS: Record<string, string> = {
  CONSULTATION: "Consultation",
  FOLLOW_UP: "Follow-up",
  PROCEDURE: "Procedure",
  CHECK_UP: "Check-up",
};

export const CHANNEL_LABELS: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  VOICE: "Voice",
  SMS: "SMS",
  WEB_CHAT: "Web chat",
  IN_PERSON: "In person",
};

export const ALERT_METRICS = [
  "NO_SHOW_RATE",
  "FIRST_RESPONSE_P50",
  "FIRST_RESPONSE_P90",
  "FOLLOW_UPS_OVERDUE",
  "ESCALATIONS_UNACKNOWLEDGED",
  "CHECK_IN_ANSWER_RATE",
  "CAMPAIGN_WITHOUT_PROCEDURE",
  "REVIEWS_PENDING",
  "LOST_LEADS_PRICE_SHARE",
  "LEAD_TO_CONSULTATION",
  "REVENUE",
] as const;
export type AlertMetricValue = (typeof ALERT_METRICS)[number];

export const ALERT_METRIC_LABELS: Record<AlertMetricValue, { label: string; unit: string; metric?: MetricId; finance?: boolean }> = {
  NO_SHOW_RATE: { label: "No-show rate", unit: "%", metric: "M6" },
  FIRST_RESPONSE_P50: { label: "First response, median", unit: "s", metric: "M5" },
  FIRST_RESPONSE_P90: { label: "First response, 90th percentile", unit: "s", metric: "M5" },
  FOLLOW_UPS_OVERDUE: { label: "Follow-ups and escalations overdue", unit: "", metric: "M12" },
  ESCALATIONS_UNACKNOWLEDGED: { label: "Escalations unacknowledged", unit: "" },
  CHECK_IN_ANSWER_RATE: { label: "Check-in answer rate", unit: "%" },
  CAMPAIGN_WITHOUT_PROCEDURE: { label: "Campaigns (≥100 leads) without a procedure", unit: "", metric: "M13" },
  REVIEWS_PENDING: { label: "Weeks since the last review snapshot", unit: "wk", metric: "M11" },
  LOST_LEADS_PRICE_SHARE: { label: "Lost leads citing price", unit: "%", metric: "M7" },
  LEAD_TO_CONSULTATION: { label: "Lead to consultation", unit: "%", metric: "M2" },
  REVENUE: { label: "Revenue", unit: "EGP", metric: "M4", finance: true },
};

/** How an alert rule's comparison window reads ("over 14 days"); FOLLOW_UPS_OVERDUE and REVIEWS_PENDING are as of now. */
export const ALERT_METRIC_IS_SNAPSHOT: Partial<Record<AlertMetricValue, true>> = { FOLLOW_UPS_OVERDUE: true, REVIEWS_PENDING: true };
