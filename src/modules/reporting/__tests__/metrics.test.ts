import { describe, expect, it } from "vitest";
import {
  campaignToProcedure,
  consultationToProcedure,
  emptyLabels,
  enquiriesByTreatment,
  firstResponseTimes,
  leadToConsultation,
  lostLeads,
  median,
  messageAuthor,
  noShowBreakdown,
  objectionsSideBySide,
  overdueByOwner,
  percentile,
  prorateCost,
  repeatPatientRate,
  revenueBreakdown,
  satisfactionScores,
  shiftBackOneYear,
  type AppointmentRow,
  type CampaignCostRow,
  type LeadRow,
  type MessageRow,
  type PaymentRow,
  type ProcedureRow,
} from "@/modules/reporting/metrics";
import { periodBuckets, resolvePeriod } from "@/modules/reporting/period";

/**
 * The thirteen metrics are pure functions over rows; these tests feed
 * synthetic rows and pin each definition: who counts, in which window, and
 * what the breakdowns contain.
 */
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);
const period = { from: at("2026-03-01T00:00:00Z"), to: at("2026-04-01T00:00:00Z") };
const labels = () => {
  const l = emptyLabels();
  l.treatments.set("hair-transplant", "Hair transplant");
  l.treatments.set("prp-hair", "Hair loss / PRP");
  l.treatments.set("acne", "Acne treatment");
  l.doctors.set("d1", "Dr. One");
  l.doctors.set("d2", "Dr. Two");
  return l;
};

function lead(id: string, createdAt: string, extra: Partial<LeadRow> = {}): LeadRow {
  return {
    id,
    createdAt: at(createdAt),
    source: "WEBSITE",
    campaignId: null,
    interests: [],
    patientId: null,
    consultationAppointmentId: null,
    stage: "NEW",
    lostReason: null,
    lostAtStage: null,
    lostAt: null,
    wonAt: null,
    objections: [],
    ...extra,
  };
}

function appt(id: string, startsAt: string, extra: Partial<AppointmentRow> = {}): AppointmentRow {
  return { id, patientId: "p1", doctorId: "d1", kind: "CONSULTATION", status: "COMPLETED", startsAt: at(startsAt), leadId: null, patientSource: null, treatmentKey: null, ...extra };
}

function proc(id: string, patientId: string, performedAt: string, extra: Partial<ProcedureRow> = {}): ProcedureRow {
  return { id, patientId, doctorId: "d1", treatmentKey: "acne", performedAt: at(performedAt), price: 2000, discount: 0, ...extra };
}

function pay(id: string, kind: string, amount: number, paidAt: string, extra: Partial<PaymentRow> = {}): PaymentRow {
  return { id, patientId: "p1", kind, method: "CASH", amount, paidAt: at(paidAt), procedureId: null, appointmentId: null, ...extra };
}

describe("percentiles", () => {
  it("uses the nearest rank and returns null for no data", () => {
    expect(percentile([], 50)).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
  });
});

describe("M1 enquiries by treatment", () => {
  const leads = [
    lead("a", "2026-03-02T10:00:00Z", { interests: ["hair-transplant", "prp-hair"] }),
    lead("b", "2026-03-05T10:00:00Z", { interests: ["hair-transplant"] }),
    lead("c", "2026-03-06T10:00:00Z", { interests: [] }),
    lead("d", "2026-02-27T10:00:00Z", { interests: ["acne"] }), // before the period
    lead("e", "2026-03-07T10:00:00Z", { interests: ["acne", "acne"] }), // a duplicate interest counts once
  ];

  it("counts a lead with two interests once per interest and reports how many such leads there were", () => {
    const m1 = enquiriesByTreatment(leads, period, labels());
    expect(m1.leads).toBe(4);
    expect(m1.multiInterest).toBe(1);
    expect(Object.fromEntries(m1.items.map((i) => [i.key, i.count]))).toEqual({ "hair-transplant": 2, "prp-hair": 1, unspecified: 1, acne: 1 });
    expect(m1.items.find((i) => i.key === "unspecified")?.label).toBe("Not specified");
    expect(m1.items[0]).toMatchObject({ key: "hair-transplant", label: "Hair transplant", count: 2 });
  });

  it("with a treatment filter counts only leads with that interest, once each", () => {
    const m1 = enquiriesByTreatment(leads, period, labels(), "hair-transplant");
    expect(m1.leads).toBe(2);
    expect(m1.items).toEqual([{ key: "hair-transplant", label: "Hair transplant", count: 2 }]);
  });
});

describe("M2 lead to consultation", () => {
  it("converts leads with an attended consultation within 30 days, from the lead's own booking or the patient's", () => {
    const leads = [
      lead("own", "2026-03-02T09:00:00Z", { source: "REFERRAL", consultationAppointmentId: "c-own" }),
      lead("patient", "2026-03-03T09:00:00Z", { patientId: "p2" }),
      lead("late", "2026-03-04T09:00:00Z", { patientId: "p3" }), // consultation on day 31
      lead("noshow", "2026-03-05T09:00:00Z", { consultationAppointmentId: "c-ns" }),
      lead("before", "2026-03-10T15:00:00Z", { patientId: "p5" }), // consultation the day before the lead
      lead("sameday", "2026-03-11T15:00:00Z", { patientId: "p6" }), // walk-in: seen in the morning, lead logged after
      lead("outside", "2026-04-02T09:00:00Z", { patientId: "p2" }), // created after the period
    ];
    const appointments = [
      appt("c-own", "2026-03-20T10:00:00Z", { patientId: "p1" }),
      appt("c-p2", "2026-03-10T10:00:00Z", { patientId: "p2", status: "CHECKED_IN" }),
      appt("c-p3", "2026-04-04T10:00:00Z", { patientId: "p3" }),
      appt("c-ns", "2026-03-12T10:00:00Z", { patientId: "p4", status: "NO_SHOW" }),
      appt("c-p5", "2026-03-09T10:00:00Z", { patientId: "p5" }),
      appt("c-p6", "2026-03-11T08:00:00Z", { patientId: "p6" }),
      appt("f-p3", "2026-03-06T10:00:00Z", { patientId: "p3", kind: "FOLLOW_UP" }), // not a consultation
    ];
    const m2 = leadToConsultation(leads, appointments, period, { sourceLabels: { REFERRAL: "Referral", WEBSITE: "Website" } });
    expect(m2.leads).toBe(6);
    expect([...m2.consultationAt.keys()].sort()).toEqual(["own", "patient", "sameday"]);
    expect(m2.converted).toBe(3);
    expect(m2.rate).toBeCloseTo(0.5);
    expect(m2.consultationAt.get("own")).toEqual(at("2026-03-20T10:00:00Z"));
    expect(m2.bySource).toEqual([
      { key: "WEBSITE", label: "Website", total: 5, converted: 2, rate: 0.4 },
      { key: "REFERRAL", label: "Referral", total: 1, converted: 1, rate: 1 },
    ]);
  });

  it("has no rate without leads", () => {
    expect(leadToConsultation([], [], period).rate).toBeNull();
  });
});

describe("M3 consultation to procedure", () => {
  const appointments = [
    appt("c1", "2026-03-02T10:00:00Z", { patientId: "p1", doctorId: "d1", treatmentKey: "hair-transplant" }),
    appt("c2", "2026-03-03T10:00:00Z", { patientId: "p2", doctorId: "d1", treatmentKey: "acne" }),
    appt("c3", "2026-03-04T10:00:00Z", { patientId: "p3", doctorId: "d2" }),
    appt("c4", "2026-03-05T10:00:00Z", { patientId: "p4", doctorId: "d2", status: "NO_SHOW" }), // not attended
    appt("c5", "2026-03-06T14:00:00Z", { patientId: "p5", doctorId: "d2", leadId: "L5" }),
    appt("x", "2026-03-06T10:00:00Z", { patientId: "p6", kind: "PROCEDURE" }), // not a consultation
  ];
  const procedures = [
    proc("s1", "p1", "2026-04-20T10:00:00Z", { treatmentKey: "hair-transplant" }), // 49 days later
    proc("s2", "p2", "2026-05-10T10:00:00Z"), // 68 days later: too late
    proc("s3", "p3", "2026-03-01T10:00:00Z"), // before the consultation
    proc("s5", "p5", "2026-03-06T09:00:00Z", { treatmentKey: "prp-hair" }), // same day, entered for the morning
  ];

  it("counts attended consultations followed by a signed procedure within 60 days, by doctor and treatment", () => {
    const m3 = consultationToProcedure(appointments, procedures, period, labels(), {}, { leadInterests: new Map([["L5", ["prp-hair"]]]) });
    expect(m3.consultations).toBe(4);
    expect(m3.converted).toBe(2);
    expect(m3.rate).toBe(0.5);
    expect(m3.byDoctor).toEqual([
      { key: "d1", label: "Dr. One", total: 2, converted: 1, rate: 0.5 },
      { key: "d2", label: "Dr. Two", total: 2, converted: 1, rate: 0.5 },
    ]);
    const byTreatment = Object.fromEntries(m3.byTreatment.map((t) => [t.key, [t.total, t.converted]]));
    expect(byTreatment).toEqual({ "hair-transplant": [1, 1], acne: [1, 0], unspecified: [1, 0], "prp-hair": [1, 1] });
    expect(m3.byProcedureTreatment.map((t) => t.key).sort()).toEqual(["hair-transplant", "prp-hair"]);
  });

  it("narrows to one doctor, and to one treatment's consultations and procedures", () => {
    expect(consultationToProcedure(appointments, procedures, period, labels(), { doctorId: "d1" })).toMatchObject({ consultations: 2, converted: 1 });
    // Treatment filter: consultations for hair transplant or for no stated treatment; only a transplant converts.
    const ht = consultationToProcedure(appointments, procedures, period, labels(), { treatmentKey: "hair-transplant" });
    expect(ht).toMatchObject({ consultations: 3, converted: 1 });
  });
});

describe("M4 revenue", () => {
  const procedures = [
    proc("a", "p1", "2026-03-02T10:00:00Z", { doctorId: "d1", treatmentKey: "hair-transplant", price: 60_000, discount: 5_000 }),
    proc("b", "p2", "2026-03-03T10:00:00Z", { doctorId: "d2", treatmentKey: "acne", price: 2_000 }),
    proc("c", "p3", "2026-02-20T10:00:00Z", { doctorId: "d1", price: 9_000 }), // before the period
  ];
  const appointments = [appt("fee-appt", "2026-03-04T10:00:00Z", { doctorId: "d2" })];
  const payments = [
    pay("dep", "DEPOSIT", 5_000, "2026-02-25T10:00:00Z", { procedureId: "a", procedureDoctorId: "d1", procedureTreatmentKey: "hair-transplant" }), // before the period
    pay("dep2", "DEPOSIT", 500, "2026-03-05T10:00:00Z", { procedureId: "planned", procedureDoctorId: "d2", procedureTreatmentKey: "acne" }),
    pay("ref", "REFUND", 700, "2026-03-06T10:00:00Z", { procedureId: "a", procedureDoctorId: "d1", procedureTreatmentKey: "hair-transplant" }),
    pay("fee", "CONSULTATION_FEE", 600, "2026-03-04T10:30:00Z", { appointmentId: "fee-appt" }),
    pay("fee2", "CONSULTATION_FEE", 500, "2026-03-04T11:30:00Z"),
    pay("p", "PAYMENT", 30_000, "2026-03-02T12:00:00Z", { procedureId: "a" }),
  ];

  it("counts signed procedures by the date performed, net of discount, with deposits, refunds and fees as their own lines", () => {
    const m4 = revenueBreakdown(procedures, payments, period, labels());
    expect(m4).toMatchObject({ revenue: 57_000, procedures: 2, deposits: 500, refunds: 700, consultationFees: 1_100 });
    expect(m4.byDoctor.map((d) => [d.key, d.revenue])).toEqual([["d1", 55_000], ["d2", 2_000]]);
    expect(m4.byDoctor[0]!.byTreatment).toEqual([{ key: "hair-transplant", label: "Hair transplant", revenue: 55_000, procedures: 1 }]);
    expect(m4.byTreatment.map((t) => t.key)).toEqual(["hair-transplant", "acne"]);
  });

  it("narrows the money lines to payments of the filtered doctor", () => {
    const d2 = revenueBreakdown(procedures, payments, period, labels(), { doctorId: "d2" }, new Map(appointments.map((a) => [a.id, a])));
    expect(d2).toMatchObject({ revenue: 2_000, procedures: 1, deposits: 500, refunds: 0, consultationFees: 600 });
  });
});

describe("M5 first-response time", () => {
  const m = (conversationId: string, direction: "INBOUND" | "OUTBOUND", author: string, iso: string, channel = "WHATSAPP"): MessageRow => ({ conversationId, direction, author, createdAt: at(iso), channel });
  const messages: MessageRow[] = [
    // AI replies after 30 s and 10 s.
    m("c1", "INBOUND", "PATIENT", "2026-03-02T10:00:00Z"),
    m("c1", "OUTBOUND", "AI", "2026-03-02T10:00:30Z"),
    m("c1", "INBOUND", "PATIENT", "2026-03-02T10:05:00Z"),
    m("c1", "OUTBOUND", "AI", "2026-03-02T10:05:10Z"),
    // Three messages in a row, a human answers 300 s after the first: one wait of 300 s.
    m("c2", "INBOUND", "PATIENT", "2026-03-03T18:00:00Z", "VOICE"),
    m("c2", "INBOUND", "PATIENT", "2026-03-03T18:01:00Z", "VOICE"),
    m("c2", "INBOUND", "PATIENT", "2026-03-03T18:02:00Z", "VOICE"),
    m("c2", "OUTBOUND", "HUMAN", "2026-03-03T18:05:00Z", "VOICE"),
    // An automated reminder is not a reply; the human answers after 600 s.
    m("c3", "INBOUND", "PATIENT", "2026-03-04T09:00:00Z"),
    m("c3", "OUTBOUND", "SYSTEM", "2026-03-04T09:01:00Z"),
    m("c3", "OUTBOUND", "HUMAN", "2026-03-04T09:10:00Z"),
    // Unanswered.
    m("c4", "INBOUND", "PATIENT", "2026-03-05T09:00:00Z"),
    // Before the period: ignored.
    m("c5", "INBOUND", "PATIENT", "2026-02-20T09:00:00Z"),
    m("c5", "OUTBOUND", "AI", "2026-02-20T09:00:05Z"),
  ];

  it("reports the median and 90th percentile, split by AI and human, by channel and by hour", () => {
    const m5 = firstResponseTimes(messages, period, "UTC");
    expect(m5.n).toBe(4);
    expect(m5.p50).toBe(30);
    expect(m5.p90).toBe(600);
    expect(m5.ai).toEqual({ n: 2, p50: 10, p90: 30 });
    expect(m5.human).toEqual({ n: 2, p50: 300, p90: 600 });
    expect(m5.unanswered).toBe(1);
    expect(m5.byChannel).toEqual([
      { channel: "WHATSAPP", label: "WhatsApp", n: 3, p50: 30, p90: 600 },
      { channel: "VOICE", label: "Voice", n: 1, p50: 300, p90: 300 },
    ]);
    expect(m5.byHour[10]).toEqual({ hour: 10, n: 2, p50: 10, p90: 30 });
    expect(m5.byHour[18]).toEqual({ hour: 18, n: 1, p50: 300, p90: 300 });
    expect(m5.byHour).toHaveLength(24);
  });

  it("reads the hour on the clinic clock", () => {
    const m5 = firstResponseTimes(messages, period, "Africa/Cairo");
    expect(m5.byHour[12]?.n).toBe(2); // 10:00 UTC is 12:00 in Cairo in March
  });

  it("treats legacy replies marked meta.by = ai as the AI's", () => {
    expect(messageAuthor("HUMAN", { by: "ai", mode: "assist" })).toBe("AI");
    expect(messageAuthor("HUMAN", null)).toBe("HUMAN");
    expect(messageAuthor("SYSTEM", { by: "ai" })).toBe("SYSTEM");
  });
});

describe("M6 no-show rate", () => {
  const now = at("2026-04-15T00:00:00Z");
  // 2026-03-02 is a Monday, 2026-03-07 a Saturday.
  const appointments = [
    appt("a1", "2026-03-02T10:00:00Z", { patientId: "p1", doctorId: "d1", status: "NO_SHOW", leadId: "L1" }),
    appt("a2", "2026-03-02T11:00:00Z", { patientId: "p2", doctorId: "d1", status: "COMPLETED", patientSource: "REFERRAL" }),
    appt("a3", "2026-03-07T10:00:00Z", { patientId: "p3", doctorId: "d2", kind: "PROCEDURE", status: "NO_SHOW" }),
    appt("a4", "2026-03-07T11:00:00Z", { patientId: "p4", doctorId: "d2", kind: "PROCEDURE", status: "COMPLETED" }),
    appt("a5", "2026-03-08T11:00:00Z", { patientId: "p5", status: "CANCELLED" }), // not booked
    appt("a6", "2026-03-09T11:00:00Z", { patientId: "p6", status: "WAITLISTED" }), // not booked
    appt("a7", "2026-04-20T11:00:00Z", { patientId: "p7", status: "SCHEDULED" }), // future
    appt("p4-prior", "2026-02-10T11:00:00Z", { patientId: "p4", status: "COMPLETED" }),
  ];
  const deposits = [
    pay("d-a3", "DEPOSIT", 5_000, "2026-03-01T10:00:00Z", { patientId: "p3", appointmentId: "a3" }), // linked to the appointment
    pay("d-p4", "DEPOSIT", 500, "2026-02-20T10:00:00Z", { patientId: "p4" }), // after the previous visit, before this one
    pay("d-p2", "DEPOSIT", 500, "2026-01-01T10:00:00Z", { patientId: "p2" }), // no earlier appointment, so any earlier deposit counts
    pay("x-p1", "PAYMENT", 900, "2026-03-01T10:00:00Z", { patientId: "p1" }), // not a deposit
  ];

  it("divides no-shows by booked past appointments, by doctor, type, weekday, source and deposit", () => {
    const m6 = noShowBreakdown(appointments, period, now, deposits, {
      leadSources: new Map([["L1", "CLICK_TO_WHATSAPP_AD"]]),
      priorAppointments: appointments.filter((a) => a.status !== "CANCELLED" && a.status !== "WAITLISTED"),
      labels: labels(),
      sourceLabels: { CLICK_TO_WHATSAPP_AD: "Click-to-WhatsApp ad", REFERRAL: "Referral", unknown: "Unknown" },
      timeZone: "UTC",
    });
    expect(m6).toMatchObject({ booked: 4, noShows: 2, rate: 0.5 });
    expect(m6.byDoctor.map((d) => [d.key, d.total, d.converted])).toEqual([["d1", 2, 1], ["d2", 2, 1]]);
    expect(m6.byKind.map((d) => [d.key, d.total, d.converted])).toEqual([["CONSULTATION", 2, 1], ["PROCEDURE", 2, 1]]);
    expect(m6.byWeekday.map((d) => [d.label, d.total, d.converted])).toEqual([["Saturday", 2, 1], ["Monday", 2, 1]]);
    expect(Object.fromEntries(m6.bySource.map((d) => [d.key, [d.total, d.converted]]))).toEqual({ CLICK_TO_WHATSAPP_AD: [1, 1], REFERRAL: [1, 0], unknown: [2, 1] });
    expect(m6.byDeposit).toEqual([
      { key: "deposit", label: "Deposit paid", total: 3, converted: 1, rate: 1 / 3 },
      { key: "none", label: "No deposit", total: 1, converted: 1, rate: 1 },
    ]);
  });

  it("does not count a deposit paid before the patient's previous appointment", () => {
    const m6 = noShowBreakdown(
      [appt("a", "2026-03-10T10:00:00Z", { patientId: "q" }), appt("prev", "2026-02-15T10:00:00Z", { patientId: "q" })],
      period,
      now,
      [pay("old", "DEPOSIT", 500, "2026-02-01T10:00:00Z", { patientId: "q" })],
      { timeZone: "UTC" },
    );
    expect(m6.byDeposit).toEqual([{ key: "none", label: "No deposit", total: 1, converted: 0, rate: 0 }]);
  });

  it("filters by doctor and source", () => {
    const m6 = noShowBreakdown(appointments, period, now, deposits, { doctorId: "d2", timeZone: "UTC" });
    expect(m6).toMatchObject({ booked: 2, noShows: 1 });
    const bySource = noShowBreakdown(appointments, period, now, deposits, { source: "REFERRAL", timeZone: "UTC" });
    expect(bySource).toMatchObject({ booked: 1, noShows: 0, rate: 0 });
  });
});

describe("M7 lost leads and M8 objections", () => {
  const leads = [
    lead("l1", "2026-02-01T10:00:00Z", { lostAt: at("2026-03-03T10:00:00Z"), lostReason: "PRICE", lostAtStage: "CONTACTED", objections: ["PRICE"] }),
    lead("l2", "2026-02-01T10:00:00Z", { lostAt: at("2026-03-04T10:00:00Z"), lostReason: "NO_RESPONSE", lostAtStage: "NEW" }),
    lead("l3", "2026-02-01T10:00:00Z", { lostAt: at("2026-03-05T10:00:00Z"), lostReason: null, lostAtStage: null }),
    lead("w1", "2026-02-01T10:00:00Z", { wonAt: at("2026-03-06T10:00:00Z"), objections: ["PRICE", "PAIN"] }),
    lead("old", "2026-01-01T10:00:00Z", { lostAt: at("2026-02-03T10:00:00Z"), lostReason: "PRICE" }),
  ];

  it("counts lost leads by reason (every reason listed) and by the stage they were lost at", () => {
    const m7 = lostLeads(leads, period);
    expect(m7.lost).toBe(3);
    expect(m7.byReason.map((r) => r.key)).toEqual(["NO_RESPONSE", "PRICE", "DISTANCE", "CHOSE_COMPETITOR", "NOT_A_FIT", "TIMING", "OTHER"]);
    expect(Object.fromEntries(m7.byReason.map((r) => [r.key, r.count]))).toMatchObject({ PRICE: 1, NO_RESPONSE: 1, OTHER: 1, DISTANCE: 0 });
    expect(m7.byStage.map((s) => s.label)).toEqual(["New", "Contacted", "Unknown"]);
  });

  it("puts the AI's tags on conversations next to staff-confirmed objections on closed leads, as shares of all of them", () => {
    const conversations = [
      { id: "c1", createdAt: at("2026-03-02T10:00:00Z"), objections: ["PRICE", "PRICE"] },
      { id: "c2", createdAt: at("2026-03-03T10:00:00Z"), objections: ["DOWNTIME"] },
      { id: "c3", createdAt: at("2026-03-03T10:00:00Z"), objections: [] },
      { id: "c4", createdAt: at("2026-03-04T10:00:00Z"), objections: [] },
    ];
    const m8 = objectionsSideBySide(conversations, leads, period);
    expect(m8).toMatchObject({ conversations: 4, taggedConversations: 2, closedLeads: 4 });
    const price = m8.items.find((i) => i.key === "PRICE")!;
    expect(price).toMatchObject({ aiCount: 1, aiShare: 0.25, staffCount: 2, staffShare: 0.5 });
    expect(m8.items[0]!.key).toBe("PRICE");
    expect(m8.items.map((i) => i.key).sort()).toEqual(["DOWNTIME", "PAIN", "PRICE", "RESULTS_DOUBT", "TIMING", "TRUST"]);
  });
});

describe("M10 repeat-patient rate", () => {
  const cohort = { from: at("2025-03-01T00:00:00Z"), to: at("2025-04-01T00:00:00Z") };
  const visits = [
    // p1: first visit in the cohort (a transplant), back 200 days later → returned.
    { patientId: "p1", at: at("2025-03-05T10:00:00Z"), treatmentKey: "hair-transplant" },
    { patientId: "p1", at: at("2025-09-21T10:00:00Z"), treatmentKey: "prp-hair" },
    // p2: first visit in the cohort, back after 400 days → not returned within 12 months.
    { patientId: "p2", at: at("2025-03-10T10:00:00Z"), treatmentKey: "acne" },
    { patientId: "p2", at: at("2026-04-14T10:00:00Z"), treatmentKey: "acne" },
    // p3: consultation fee and procedure on the first day; nothing after → the first treatment is the procedure.
    { patientId: "p3", at: at("2025-03-12T09:00:00Z"), treatmentKey: null },
    { patientId: "p3", at: at("2025-03-12T11:00:00Z"), treatmentKey: "acne" },
    // p4: consultation only, back within the year.
    { patientId: "p4", at: at("2025-03-20T09:00:00Z"), treatmentKey: null },
    { patientId: "p4", at: at("2025-05-01T09:00:00Z"), treatmentKey: "acne" },
    // p5: first visit before the cohort → not in it.
    { patientId: "p5", at: at("2025-01-10T09:00:00Z"), treatmentKey: "acne" },
    { patientId: "p5", at: at("2025-03-15T09:00:00Z"), treatmentKey: "acne" },
  ];

  it("follows the patients whose first paid visit is in the cohort for 12 months", () => {
    const m10 = repeatPatientRate(visits, cohort, "UTC", labels());
    expect(m10).toMatchObject({ cohort: 4, returned: 2, rate: 0.5 });
    expect(Object.fromEntries(m10.byFirstTreatment.map((r) => [r.key, [r.total, r.converted]]))).toEqual({
      "hair-transplant": [1, 1],
      acne: [2, 0],
      consultation: [1, 1],
    });
    expect(m10.byFirstTreatment.find((r) => r.key === "consultation")?.label).toBe("Consultation only");
  });

  it("filters by the first treatment and shifts a period back one year on the clinic clock", () => {
    expect(repeatPatientRate(visits, cohort, "UTC", labels(), { treatmentKey: "acne" })).toMatchObject({ cohort: 2, returned: 0, rate: 0 });
    const shifted = shiftBackOneYear({ from: at("2026-03-01T00:00:00Z"), to: at("2026-04-01T00:00:00Z") }, "UTC");
    expect(shifted).toEqual(cohort);
  });
});

describe("M11 satisfaction", () => {
  it("averages month 1 and month 12 for transplants and day 14 for other treatments", () => {
    const rows = [
      { satisfaction: 5, submittedAt: at("2026-03-02T10:00:00Z"), offsetDays: 30, treatmentKey: "hair-transplant" },
      { satisfaction: 4, submittedAt: at("2026-03-03T10:00:00Z"), offsetDays: 31, treatmentKey: "hair-transplant" },
      { satisfaction: 3, submittedAt: at("2026-03-04T10:00:00Z"), offsetDays: 365, treatmentKey: "hair-transplant" },
      { satisfaction: 4, submittedAt: at("2026-03-05T10:00:00Z"), offsetDays: 14, treatmentKey: "acne" },
      { satisfaction: null, submittedAt: at("2026-03-05T10:00:00Z"), offsetDays: 14, treatmentKey: "acne" },
      { satisfaction: 1, submittedAt: at("2026-02-05T10:00:00Z"), offsetDays: 14, treatmentKey: "acne" }, // before the period
    ];
    const m11 = satisfactionScores(rows, period, "hair-transplant", labels());
    expect(m11.hairMonth1).toEqual({ avg: 4.5, n: 2 });
    expect(m11.hairMonth12).toEqual({ avg: 3, n: 1 });
    expect(m11.othersDay14).toEqual({ avg: 4, n: 1 });
    expect(m11.overall).toEqual({ avg: 4, n: 4 });
  });
});

describe("M12 overdue by owner", () => {
  it("counts follow-ups and escalations past due by owner, oldest first", () => {
    const now = at("2026-03-10T12:00:00Z");
    const m12 = overdueByOwner(
      [
        { kind: "follow_up", id: "f1", ownerId: "u1", dueAt: at("2026-03-10T10:00:00Z"), subject: "Call Mona", href: null },
        { kind: "follow_up", id: "f2", ownerId: null, dueAt: at("2026-03-09T12:00:00Z"), subject: "Call Ali", href: null },
        { kind: "escalation", id: "e1", ownerId: "u1", dueAt: at("2026-03-10T11:00:00Z"), subject: "Fever day 3", href: null },
        { kind: "follow_up", id: "f3", ownerId: "u1", dueAt: at("2026-03-11T10:00:00Z"), subject: "Not due yet", href: null },
      ],
      new Map([["u1", "Youssef"]]),
      now,
    );
    expect(m12).toMatchObject({ followUps: 2, escalations: 1 });
    expect(m12.byOwner.map((o) => [o.label, o.followUps, o.escalations])).toEqual([["Youssef", 1, 1], ["Unassigned", 1, 0]]);
    expect(m12.items.map((i) => [i.id, i.overdueHours])).toEqual([["f2", 24], ["f1", 2], ["e1", 1]]);
  });
});

describe("M13 campaign to procedure", () => {
  it("pro-rates a cost row by the days it overlaps the period", () => {
    const week: CampaignCostRow = { campaignId: "c", periodStart: at("2026-02-26T00:00:00Z"), periodEnd: at("2026-03-04T00:00:00Z"), amount: 7_000 };
    // 26 Feb – 4 Mar is seven days; 1–4 March fall in the period.
    expect(prorateCost(week, period, "UTC")).toBeCloseTo(4_000);
    expect(prorateCost({ ...week, periodStart: at("2026-04-01T00:00:00Z"), periodEnd: at("2026-04-07T00:00:00Z") }, period, "UTC")).toBe(0);
    expect(prorateCost({ ...week, periodStart: at("2026-03-10T00:00:00Z"), periodEnd: at("2026-03-16T00:00:00Z") }, period, "UTC")).toBeCloseTo(7_000);
    // On the Cairo clock the days start two hours earlier in UTC.
    expect(prorateCost({ ...week, periodStart: at("2026-03-01T00:00:00Z"), periodEnd: at("2026-03-01T00:00:00Z"), amount: 1_000 }, { from: at("2026-02-28T22:00:00Z"), to: at("2026-03-01T10:00:00Z") }, "Africa/Cairo")).toBeCloseTo(500);
  });

  it("follows each campaign's leads to consultations, procedures within 60 days, revenue and cost per procedure", () => {
    const campaigns = [
      { id: "meta-ht", name: "Meta · Hair transplant", platform: "META", treatmentKey: "hair-transplant" },
      { id: "google", name: "Google · Brand", platform: "GOOGLE", treatmentKey: null },
      { id: "idle", name: "Paused", platform: "META", treatmentKey: null },
    ];
    const leads = [
      lead("l1", "2026-03-02T10:00:00Z", { campaignId: "meta-ht", patientId: "p1" }),
      lead("l2", "2026-03-03T10:00:00Z", { campaignId: "meta-ht", patientId: "p2" }),
      lead("l3", "2026-03-04T10:00:00Z", { campaignId: "meta-ht" }),
      lead("l4", "2026-03-05T10:00:00Z", { campaignId: "google", patientId: "p4" }),
    ];
    const consultationAt = new Map([
      ["l1", at("2026-03-10T10:00:00Z")],
      ["l2", at("2026-03-11T10:00:00Z")],
      ["l4", at("2026-03-12T10:00:00Z")],
    ]);
    const procedures = [
      proc("s1", "p1", "2026-04-01T10:00:00Z", { treatmentKey: "hair-transplant", price: 60_000, discount: 0 }),
      proc("s2", "p2", "2026-06-30T10:00:00Z", { treatmentKey: "hair-transplant", price: 60_000 }), // after 60 days
    ];
    const costs: CampaignCostRow[] = [
      { campaignId: "meta-ht", periodStart: at("2026-03-01T00:00:00Z"), periodEnd: at("2026-03-31T00:00:00Z"), amount: 18_600 },
      { campaignId: "google", periodStart: at("2026-03-16T00:00:00Z"), periodEnd: at("2026-04-14T00:00:00Z"), amount: 3_000 },
    ];
    const m13 = campaignToProcedure(campaigns, leads, consultationAt, procedures, costs, period, "UTC");
    expect(m13.items).toEqual([
      { campaignId: "meta-ht", label: "Meta · Hair transplant", platform: "META", leads: 3, consultations: 2, procedures: 1, revenue: 60_000, cost: 18_600, costPerLead: 6_200, costPerProcedure: 18_600 },
      { campaignId: "google", label: "Google · Brand", platform: "GOOGLE", leads: 1, consultations: 1, procedures: 0, revenue: 0, cost: 1_600, costPerLead: 1_600, costPerProcedure: null },
    ]);
    expect(m13.totals).toEqual({ leads: 4, consultations: 3, procedures: 1, revenue: 60_000, cost: 20_200 });
  });
});

describe("periods", () => {
  it("resolves presets on the clinic clock with an equal comparison period", () => {
    const now = at("2026-10-26T10:00:00Z");
    const p = resolvePeriod({ period: "28d" }, "Africa/Cairo", now);
    expect(p.days).toBe(28);
    expect(p.toKey).toBe("2026-10-26");
    expect(p.previous.to).toEqual(p.from);
    expect(p.from.getTime() - p.previous.from.getTime()).toBe(28 * DAY);
    expect(resolvePeriod({ period: "month" }, "Africa/Cairo", now)).toMatchObject({ fromKey: "2026-10-01", toKey: "2026-10-26", days: 26 });
    expect(resolvePeriod({ period: "today" }, "Africa/Cairo", now)).toMatchObject({ fromKey: "2026-10-26", toKey: "2026-10-26", days: 1 });
  });

  it("falls back to 28 days for a broken custom range and buckets by day or week", () => {
    const now = at("2026-03-15T10:00:00Z");
    expect(resolvePeriod({ period: "custom", from: "2026-03-10", to: "2026-03-01" }, "UTC", now).preset).toBe("28d");
    const custom = resolvePeriod({ period: "custom", from: "2026-03-01", to: "2026-03-07" }, "UTC", now);
    expect(custom).toMatchObject({ preset: "custom", fromKey: "2026-03-01", toKey: "2026-03-07", days: 7 });
    expect(periodBuckets(custom, "UTC")).toHaveLength(7);
    expect(periodBuckets(resolvePeriod({ period: "90d" }, "UTC", now), "UTC")).toHaveLength(13);
  });
});
