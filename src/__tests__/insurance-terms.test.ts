/**
 * A payer's contract applied to work, without the database: the rule that
 * applies (an item's before its category's before the contract's own), the
 * contract year, the contract in force on a day, and how a line is shared
 * between the patient and the payer within its approval and the yearly limit.
 */
import { describe, expect, it } from "vitest";
import { contractDiscountOf, contractOn, contractYear, patientShareOf, ruleFor, shareLines, type ContractTerms, type WorkLine } from "@/modules/insurance/terms";

const terms = (over: Partial<ContractTerms> = {}): ContractTerms => ({
  id: "c1",
  validFrom: "2026-01-01",
  validTo: null,
  discountPct: 10,
  copayPct: 20,
  annualLimit: null,
  approvalAbove: null,
  coveredByDefault: true,
  rules: [],
  ...over,
});
const line = (over: Partial<WorkLine> = {}): WorkLine => ({ chargeId: "ch1", day: "2026-10-01", amount: 1_800, priceItemId: null, category: "general", procedureId: "p1", ...over });

describe("a contract's rules", () => {
  it("takes an item's rule before its category's, and the contract's own when no rule names the work", () => {
    const t = terms({
      coveredByDefault: false,
      rules: [
        { category: "hair", priceItemId: null, covered: false, copayPct: null, needsApproval: false },
        { category: null, priceItemId: "cons-hair", covered: true, copayPct: 10, needsApproval: false },
        { category: "skin", priceItemId: null, covered: true, copayPct: null, needsApproval: true },
      ],
    });
    expect(ruleFor(t, { priceItemId: "cons-hair", category: "hair" })).toEqual({ covered: true, copayPct: 10, needsApproval: false });
    expect(ruleFor(t, { priceItemId: "fue", category: "hair" })).toEqual({ covered: false, copayPct: 20, needsApproval: false });
    expect(ruleFor(t, { priceItemId: null, category: "skin" })).toEqual({ covered: true, copayPct: 20, needsApproval: true });
    expect(ruleFor(t, { priceItemId: null, category: "laser" })).toEqual({ covered: false, copayPct: 20, needsApproval: false });
  });

  it("finds the contract in force on a day, and the contract year a day falls in", () => {
    const contracts = [
      { id: "old", validFrom: "2025-01-01", validTo: "2025-12-31" },
      { id: "new", validFrom: "2026-01-01", validTo: null },
    ];
    expect(contractOn(contracts, "2025-06-30")?.id).toBe("old");
    expect(contractOn(contracts, "2026-10-29")?.id).toBe("new");
    expect(contractOn(contracts, "2024-12-31")).toBeNull();
    expect(contractYear("2026-03-15", "2026-10-29")).toEqual({ from: "2026-03-15", to: "2027-03-14" });
    expect(contractYear("2026-03-15", "2027-03-14")).toEqual({ from: "2026-03-15", to: "2027-03-14" });
    expect(contractYear("2026-03-15", "2027-03-15")).toEqual({ from: "2027-03-15", to: "2028-03-14" });
    expect(contractYear("2026-03-15", "2026-01-10")).toEqual({ from: "2025-03-15", to: "2026-03-14" });
    // 29 February is the 28th in other years.
    expect(contractYear("2024-02-29", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2027-02-27" });
  });

  it("rounds the contract's discount and the patient's share to whole pounds", () => {
    expect(contractDiscountOf(2_000, 10)).toBe(200);
    expect(contractDiscountOf(1_555, 15)).toBe(233);
    expect(patientShareOf(1_800, 20)).toBe(360);
    expect(patientShareOf(1_799, 25)).toBe(450);
  });
});

describe("sharing work between the patient and the payer", () => {
  it("gives the payer the contract's share, and the patient all of work not covered", () => {
    const t = terms({ rules: [{ category: "laser", priceItemId: null, covered: false, copayPct: null, needsApproval: false }] });
    const shares = shareLines(t, [line(), line({ chargeId: "ch2", category: "laser", amount: 2_000 })], { approvals: [], limitUsed: () => 0 });
    expect(shares[0]).toMatchObject({ covered: true, patientShare: 360, payerShare: 1_440, note: null, approvalId: null });
    expect(shares[1]).toMatchObject({ covered: false, patientShare: 2_000, payerShare: 0, note: "not_covered" });
  });

  it("needs an approval above the contract's amount: none, nothing claimed; one, the payer pays up to what it left", () => {
    const t = terms({ approvalAbove: 1_500 });
    expect(shareLines(t, [line()], { approvals: [], limitUsed: () => 0 })[0]).toMatchObject({ needsApproval: true, payerShare: 0, patientShare: 1_800, note: "needs_approval" });
    const approvals = [{ id: "a1", procedureId: null, left: 1_000, validUntil: "2026-12-31" }];
    const [capped] = shareLines(t, [line()], { approvals, limitUsed: () => 0 });
    expect(capped).toMatchObject({ approvalId: "a1", payerShare: 1_000, patientShare: 800, note: "approval_cap" });
    // The caller's approvals are not used up: the function works on a copy.
    expect(approvals[0]!.left).toBe(1_000);
  });

  it("takes the approval for the line's own work first, never one for other work or past its day", () => {
    const t = terms({ rules: [{ category: "general", priceItemId: null, covered: true, copayPct: 0, needsApproval: true }] });
    const approvals = [
      { id: "other", procedureId: "p9", left: 5_000, validUntil: null },
      { id: "expired", procedureId: null, left: 5_000, validUntil: "2026-09-30" },
      { id: "any", procedureId: null, left: 5_000, validUntil: null },
      { id: "own", procedureId: "p1", left: 5_000, validUntil: "2026-10-31" },
    ];
    expect(shareLines(t, [line()], { approvals, limitUsed: () => 0 })[0]).toMatchObject({ approvalId: "own", payerShare: 1_800 });
    expect(shareLines(t, [line({ procedureId: "p2" })], { approvals, limitUsed: () => 0 })[0]).toMatchObject({ approvalId: "any" });
    // An approval is used up line by line.
    const one = [{ id: "a1", procedureId: null, left: 2_000, validUntil: null }];
    const two = shareLines(t, [line(), line({ chargeId: "ch2" })], { approvals: one, limitUsed: () => 0 });
    expect(two.map((s) => s.payerShare)).toEqual([1_800, 200]);
    expect(two[1]).toMatchObject({ note: "approval_cap", patientShare: 1_600 });
  });

  it("keeps the payer within the member's yearly limit, counting earlier claims and the lines before", () => {
    const t = terms({ annualLimit: 3_000 });
    const shares = shareLines(t, [line(), line({ chargeId: "ch2" })], { approvals: [], limitUsed: (year) => (year === "2026-01-01" ? 1_000 : 0) });
    expect(shares.map((s) => [s.payerShare, s.patientShare, s.note])).toEqual([
      [1_440, 360, null],
      [560, 1_240, "limit"],
    ]);
    // A new contract year starts afresh.
    const next = shareLines(t, [line({ day: "2027-01-02" })], { approvals: [], limitUsed: (year) => (year === "2026-01-01" ? 3_000 : 0) });
    expect(next[0]).toMatchObject({ payerShare: 1_440, note: null });
  });

  it("gives back to the approval what the limit takes off", () => {
    const t = terms({ approvalAbove: 0, annualLimit: 1_000 });
    const approvals = [{ id: "a1", procedureId: null, left: 3_000, validUntil: null }];
    const shares = shareLines(t, [line(), line({ chargeId: "ch2", day: "2027-01-05" })], { approvals, limitUsed: () => 0 });
    // The first line takes 1,000 of the approval (the limit), the next year's line the next 1,000.
    expect(shares.map((s) => [s.payerShare, s.approvalId])).toEqual([
      [1_000, "a1"],
      [1_000, "a1"],
    ]);
  });
});
