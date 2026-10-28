import { describe, expect, it } from "vitest";
import {
  actionFilter,
  auditExportHref,
  auditHref,
  changedFields,
  describeDevice,
  describeAction,
  fieldLabel,
  hasAuditFilters,
  parseAuditQuery,
} from "@/modules/audit/query";
import { auditWhere } from "@/modules/audit/service";

describe("parseAuditQuery", () => {
  it("keeps valid filters and drops malformed ones", () => {
    expect(
      parseAuditQuery(
        new URLSearchParams("actor=ckuser1&patient=ckpat1&action=Appointment&from=2026-10-01&to=2026-10-28&q=%20x%20&page=3"),
      ),
    ).toEqual({ actor: "ckuser1", patient: "ckpat1", action: "appointment", from: "2026-10-01", to: "2026-10-28", q: "x", page: 3 });
    expect(parseAuditQuery({ actor: "a b", patient: "x'--", action: "drop table", from: "28/10/2026", to: "yesterday", page: "0" })).toEqual({
      q: undefined,
      actor: undefined,
      patient: undefined,
      action: undefined,
      from: undefined,
      to: undefined,
      page: undefined,
    });
  });

  it("reads a reversed date range as the range meant", () => {
    expect(parseAuditQuery({ from: "2026-10-28", to: "2026-10-01" })).toMatchObject({ from: "2026-10-01", to: "2026-10-28" });
  });

  it("round-trips through the screen and export links", () => {
    const q = { actor: "system", action: "auth", from: "2026-10-01", page: 2 };
    expect(auditHref(q)).toBe("/dashboard/audit?actor=system&action=auth&from=2026-10-01&page=2");
    expect(auditExportHref(q)).toBe("/api/audit-logs/export?actor=system&action=auth&from=2026-10-01");
    expect(parseAuditQuery(new URL(`http://x${auditHref(q)}`).searchParams)).toMatchObject(q);
    expect(auditHref()).toBe("/dashboard/audit");
    expect(hasAuditFilters({ page: 3 })).toBe(false);
    expect(hasAuditFilters({ patient: "p" })).toBe(true);
  });
});

describe("actions", () => {
  it("expands an activity group to its prefixes and keeps an exact code exact", () => {
    expect(actionFilter("patient")).toEqual({ prefixes: ["patient", "medication"] });
    expect(actionFilter("patient.update")).toEqual({ exact: "patient.update" });
  });

  it("describes known codes in words and spells out unknown ones", () => {
    expect(describeAction("auth.login_failed")).toBe("Failed sign-in");
    expect(describeAction("patient.record.view")).toBe("Opened a patient record");
    expect(describeAction("concierge.task.resend")).toBe("Concierge: task resend");
    expect(describeAction("weird")).toBe("Weird");
  });
});

describe("changedFields", () => {
  it("lists only the fields that differ", () => {
    expect(changedFields({ status: "SCHEDULED", note: "x" }, { status: "CONFIRMED", note: "x" })).toEqual([
      { field: "status", from: "SCHEDULED", to: "CONFIRMED" },
    ]);
  });

  it("lists every field of a single snapshot", () => {
    expect(changedFields(undefined, { tags: ["vip", "laser"], count: 2 })).toEqual([
      { field: "tags", from: null, to: "vip, laser" },
      { field: "count", from: null, to: "2" },
    ]);
    expect(changedFields({ phone: "1" }, null)).toEqual([{ field: "phone", from: "1", to: null }]);
  });

  it("compares non-object snapshots whole and truncates long values", () => {
    expect(changedFields("a", "b")).toEqual([{ field: "value", from: "a", to: "b" }]);
    const long = "y".repeat(200);
    expect(changedFields({}, { summary: long })[0]?.to).toHaveLength(80);
    expect(changedFields(null, undefined)).toEqual([]);
  });

  it("labels fields in plain words", () => {
    expect(fieldLabel("nextAppointmentAt")).toBe("next appointment at");
    expect(fieldLabel("is_clinician")).toBe("is clinician");
  });
});

describe("auditWhere", () => {
  it("bounds dates at local midnight on the clinic clock, across a DST change", () => {
    // Egypt's summer time ends at midnight between 29 and 30 October 2026.
    const where = auditWhere("t1", { from: "2026-10-28", to: "2026-10-29" }, "Africa/Cairo");
    const and = (where.AND as { createdAt?: { gte: Date; lt: Date } }[]).find((c) => c.createdAt)!;
    expect(and.createdAt!.gte.toISOString()).toBe("2026-10-27T21:00:00.000Z");
    expect(and.createdAt!.lt.toISOString()).toBe("2026-10-29T22:00:00.000Z");
  });

  it("always scopes to the tenant", () => {
    expect((auditWhere("t1", {}, "Africa/Cairo").AND as unknown[])[0]).toEqual({ tenantId: "t1" });
    expect(auditWhere("t1", { actor: "system" }, "UTC").AND).toContainEqual({ actorId: null });
  });
});

describe("describeDevice", () => {
  it("names the browser and the system", () => {
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")).toBe("Chrome · Linux");
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari · iOS");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")).toBe("Edge · Windows");
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0")).toBe("Firefox · macOS");
    expect(describeDevice("vitest")).toBe("vitest");
    expect(describeDevice(null)).toBeNull();
  });
});
