import type { MetricId } from "./definitions";
import type { CountItem, RateItem } from "./metrics";
import type { Report } from "./service";

/**
 * Every table the reports page draws, as data: the page renders them and the
 * CSV export writes the same rows, so what the owner downloads is exactly what
 * they saw. Percentages are fractions (0..1); the renderers format them.
 */
export type CellKind = "text" | "count" | "egp" | "percent" | "seconds" | "score" | "date" | "hours";

export interface TableColumn {
  label: string;
  kind?: CellKind;
  /** Hide the column on phones (md) or on phones and tablets (lg). */
  hide?: "md" | "lg";
}

export type Cell = string | number | Date | null;

export interface TableRow {
  /** An id the UI may highlight (the signed-in doctor's own row). */
  key?: string;
  cells: Cell[];
}

export interface TableSpec {
  id: string;
  metric: MetricId;
  part: string;
  title: string;
  description?: string;
  columns: TableColumn[];
  rows: TableRow[];
  note?: string;
}

const n = (kind: CellKind, label: string, hide?: "md" | "lg"): TableColumn => ({ label, kind, hide });

function rateTable(id: string, metric: MetricId, part: string, title: string, current: RateItem[], previous: RateItem[], labels: [string, string, string], description?: string): TableSpec {
  const prev = new Map(previous.map((p) => [p.key, p]));
  return {
    id,
    metric,
    part,
    title,
    description,
    columns: [n("text", labels[0]), n("count", labels[1]), n("count", labels[2], "md"), n("percent", "Rate"), n("percent", "Previous", "lg")],
    rows: current.map((r) => ({ key: r.key, cells: [r.label, r.total, r.converted, r.rate, prev.get(r.key)?.rate ?? null] })),
  };
}

function countTable(id: string, metric: MetricId, part: string, title: string, current: CountItem[], previous: CountItem[], labels: [string, string], description?: string): TableSpec {
  const prev = new Map(previous.map((p) => [p.key, p.count]));
  return {
    id,
    metric,
    part,
    title,
    description,
    columns: [n("text", labels[0]), n("count", labels[1]), n("count", "Previous", "md")],
    rows: current.map((r) => ({ key: r.key, cells: [r.label, r.count, prev.get(r.key) ?? 0] })),
  };
}

export function reportTables(report: Report): TableSpec[] {
  const t: TableSpec[] = [];
  const { m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13 } = report;

  t.push(countTable("M1.treatment", "M1", "treatment", "Enquiries by treatment", m1.current.items, m1.previous.items, ["Treatment", "Enquiries"], `${m1.current.leads} new leads · ${m1.current.multiInterest} with more than one interest (counted once per interest)`));
  t.push(rateTable("M2.source", "M2", "source", "Lead to consultation by source", m2.current.bySource, m2.previous.bySource, ["Source", "Leads", "Attended"], "Leads created in the period with an attended consultation within 30 days."));
  t.push(rateTable("M3.doctor", "M3", "doctor", "Consultation to procedure by doctor", m3.current.byDoctor, m3.previous.byDoctor, ["Doctor", "Consultations", "With procedure"], "Attended consultations followed by a signed procedure within 60 days."));
  t.push(countTable("M3.treatment", "M3", "treatment", "Consultation to procedure by treatment", m3.current.byTreatment, m3.previous.byTreatment, ["Treatment of the procedure", "Converted consultations"]));

  if (m4) {
    const prevDoc = new Map(m4.previous.byDoctor.map((d) => [d.key, d.revenue]));
    t.push({
      id: "M4.doctor",
      metric: "M4",
      part: "doctor",
      title: "Revenue by doctor",
      description: "Signed procedures by the date performed, price minus discount.",
      columns: [n("text", "Doctor"), n("count", "Procedures", "md"), n("egp", "Revenue"), n("egp", "Previous", "lg")],
      rows: m4.current.byDoctor.map((d) => ({ key: d.key, cells: [d.label, d.procedures, d.revenue, prevDoc.get(d.key) ?? 0] })),
    });
    const prevTr = new Map(m4.previous.byTreatment.map((d) => [d.key, d.revenue]));
    t.push({
      id: "M4.treatment",
      metric: "M4",
      part: "treatment",
      title: "Revenue by treatment",
      columns: [n("text", "Treatment"), n("count", "Procedures", "md"), n("egp", "Revenue"), n("egp", "Previous", "lg")],
      rows: m4.current.byTreatment.map((d) => ({ key: d.key, cells: [d.label, d.procedures, d.revenue, prevTr.get(d.key) ?? 0] })),
    });
    t.push({
      id: "M4.matrix",
      metric: "M4",
      part: "matrix",
      title: "Revenue by doctor and treatment",
      columns: [n("text", "Doctor"), n("text", "Treatment"), n("count", "Procedures", "md"), n("egp", "Revenue")],
      rows: m4.current.byDoctor.flatMap((d) => d.byTreatment.map((x) => ({ key: d.key, cells: [d.label, x.label, x.procedures, x.revenue] }))),
    });
    t.push({
      id: "M4.lines",
      metric: "M4",
      part: "lines",
      title: "Money lines",
      description: "Deposits and refunds by the date paid; consultation fees as their own line.",
      columns: [n("text", "Line"), n("egp", "This period"), n("egp", "Previous", "md")],
      rows: [
        { cells: ["Revenue (signed procedures)", m4.current.revenue, m4.previous.revenue] },
        { cells: ["Deposits taken", m4.current.deposits, m4.previous.deposits] },
        { cells: ["Refunds", m4.current.refunds, m4.previous.refunds] },
        { cells: ["Consultation fees", m4.current.consultationFees, m4.previous.consultationFees] },
      ],
    });
  }

  t.push({
    id: "M5.who",
    metric: "M5",
    part: "who",
    title: "First response by who replied",
    columns: [n("text", "Replied by"), n("count", "Replies"), n("seconds", "Median"), n("seconds", "90th percentile", "md")],
    rows: [
      { key: "ai", cells: ["AI", m5.current.ai.n, m5.current.ai.p50, m5.current.ai.p90] },
      { key: "human", cells: ["Human", m5.current.human.n, m5.current.human.p50, m5.current.human.p90] },
      { key: "all", cells: ["All", m5.current.n, m5.current.p50, m5.current.p90] },
    ],
    note: m5.current.unanswered ? `${m5.current.unanswered} inbound messages in the period have no reply yet.` : undefined,
  });
  t.push({
    id: "M5.channel",
    metric: "M5",
    part: "channel",
    title: "First response by channel",
    columns: [n("text", "Channel"), n("count", "Replies"), n("seconds", "Median"), n("seconds", "90th percentile", "md")],
    rows: m5.current.byChannel.map((c) => ({ key: c.channel, cells: [c.label, c.n, c.p50, c.p90] })),
  });
  t.push({
    id: "M5.hour",
    metric: "M5",
    part: "hour",
    title: "First response by hour of day",
    description: "Hour the inbound message arrived, on the clinic clock.",
    columns: [n("text", "Hour"), n("count", "Replies"), n("seconds", "Median"), n("seconds", "90th percentile", "md")],
    rows: m5.current.byHour.filter((h) => h.n > 0).map((h) => ({ key: String(h.hour), cells: [`${String(h.hour).padStart(2, "0")}:00`, h.n, h.p50, h.p90] })),
  });

  const noShowParts: [string, string, keyof typeof m6.current][] = [
    ["doctor", "No-show rate by doctor", "byDoctor"],
    ["kind", "No-show rate by appointment type", "byKind"],
    ["weekday", "No-show rate by weekday", "byWeekday"],
    ["source", "No-show rate by lead source", "bySource"],
    ["deposit", "No-show rate by deposit", "byDeposit"],
  ];
  for (const [part, title, key] of noShowParts) {
    t.push(rateTable(`M6.${part}`, "M6", part, title, m6.current[key] as RateItem[], m6.previous[key] as RateItem[], [part === "doctor" ? "Doctor" : part === "kind" ? "Type" : part === "weekday" ? "Weekday" : part === "source" ? "Source" : "Deposit", "Booked", "No-shows"]));
  }

  t.push(countTable("M7.reason", "M7", "reason", "Lost leads by reason", m7.current.byReason, m7.previous.byReason, ["Reason", "Lost"]));
  t.push(countTable("M7.stage", "M7", "stage", "Lost leads by stage", m7.current.byStage, m7.previous.byStage, ["Lost at stage", "Lost"]));
  t.push({
    id: "M8.objections",
    metric: "M8",
    part: "objections",
    title: "Objections: AI tags next to staff confirmations",
    description: `${m8.current.conversations} tagged conversations · ${m8.current.closedLeads} closed leads`,
    columns: [n("text", "Objection"), n("count", "AI (conversations)"), n("percent", "Share", "md"), n("count", "Staff (closed leads)"), n("percent", "Share", "md")],
    rows: m8.current.items.map((o) => ({ key: o.key, cells: [o.label, o.aiCount, o.aiShare, o.staffCount, o.staffShare] })),
  });
  t.push(countTable("M9.source", "M9", "source", "Hair-transplant enquiries by source", m9.current.bySource, m9.previous.bySource, ["Source", "Enquiries"]));
  t.push(countTable("M9.campaign", "M9", "campaign", "Hair-transplant enquiries by campaign", m9.current.byCampaign, m9.previous.byCampaign, ["Campaign", "Enquiries"]));
  t.push(rateTable("M10.treatment", "M10", "treatment", "Repeat-patient rate by first treatment", m10.current.byFirstTreatment, m10.previous.byFirstTreatment, ["First treatment", "Cohort", "Returned"]));

  t.push({
    id: "M11.buckets",
    metric: "M11",
    part: "buckets",
    title: "Satisfaction by check-in",
    columns: [n("text", "Check-in"), n("score", "Average (1–5)"), n("count", "Answers"), n("score", "Previous", "md")],
    rows: [
      { key: "hair1", cells: ["Hair transplant · month 1", m11.current.hairMonth1.avg, m11.current.hairMonth1.n, m11.previous.hairMonth1.avg] },
      { key: "hair12", cells: ["Hair transplant · month 12", m11.current.hairMonth12.avg, m11.current.hairMonth12.n, m11.previous.hairMonth12.avg] },
      { key: "others14", cells: ["Other treatments · day 14", m11.current.othersDay14.avg, m11.current.othersDay14.n, m11.previous.othersDay14.avg] },
      { key: "all", cells: ["All check-ins", m11.current.overall.avg, m11.current.overall.n, m11.previous.overall.avg] },
    ],
  });
  t.push({
    id: "M11.treatment",
    metric: "M11",
    part: "treatment",
    title: "Satisfaction by treatment",
    columns: [n("text", "Treatment"), n("score", "Average (1–5)"), n("count", "Answers")],
    rows: m11.current.byTreatment.map((x) => ({ key: x.key, cells: [x.label, x.avg, x.n] })),
  });
  t.push({
    id: "M11.reviews",
    metric: "M11",
    part: "reviews",
    title: "Public reviews, weekly",
    columns: [n("date", "Week of"), n("count", "Reviews"), n("score", "Rating"), n("text", "Source", "md")],
    rows: m11.reviews.trend.map((r) => ({ cells: [r.weekStart, r.count, r.rating, r.source === "GOOGLE_BUSINESS_PROFILE" ? "Google" : "Manual"] })),
  });

  t.push({
    id: "M12.owner",
    metric: "M12",
    part: "owner",
    title: "Overdue by owner",
    columns: [n("text", "Owner"), n("count", "Follow-ups"), n("count", "Escalations"), n("date", "Oldest due", "md")],
    rows: m12.byOwner.map((o) => ({ key: o.key, cells: [o.label, o.followUps, o.escalations, o.oldestDueAt] })),
  });
  t.push({
    id: "M12.items",
    metric: "M12",
    part: "items",
    title: "Overdue items",
    columns: [n("text", "Kind"), n("text", "Subject"), n("text", "Owner", "md"), n("date", "Due", "lg"), n("hours", "Overdue")],
    rows: m12.items.map((i) => ({ key: i.id, cells: [i.kind === "follow_up" ? "Follow-up" : "Escalation", i.subject, i.ownerLabel, i.dueAt, i.overdueHours] })),
  });

  t.push({
    id: "M13.campaign",
    metric: "M13",
    part: "campaign",
    title: "Campaign to procedure",
    description: report.redacted ? "Revenue and cost are owner only." : "Cost is the campaign spend overlapping the period, pro-rated by days.",
    columns: [n("text", "Campaign"), n("text", "Platform", "lg"), n("count", "Leads"), n("count", "Consultations", "md"), n("count", "Procedures"), n("egp", "Revenue", "md"), n("egp", "Cost", "md"), n("egp", "Cost / lead", "lg"), n("egp", "Cost / procedure")],
    rows: m13.current.items.map((c) => ({
      key: c.campaignId,
      cells: [c.label, c.platform, c.leads, c.consultations, c.procedures, report.redacted ? null : c.revenue, report.redacted ? null : c.cost, report.redacted ? null : c.costPerLead, report.redacted ? null : c.procedures ? c.costPerProcedure : "no procedures yet"],
    })),
  });
  return t;
}

export function findTable(tables: readonly TableSpec[], metric: MetricId, part?: string): TableSpec | null {
  return tables.find((t) => t.metric === metric && (!part || t.part === part)) ?? null;
}
