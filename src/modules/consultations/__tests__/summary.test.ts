import { describe, expect, it } from "vitest";
import { findSummaryMentions, highlightSegments, rebuildSummary } from "../summary";
import type { ClinicalExtraction } from "../types";

/** The signed summary must match what was signed (audit #02). */

const DRAFT: ClinicalExtraction = {
  symptoms: ["Inflammatory papules on cheeks", "post-inflammatory marks"],
  diagnoses: ["Acne vulgaris, moderate inflammatory", "Rosacea"],
  medications: [
    { name: "Adapalene 0.1% gel", dosage: "Thin layer", frequency: "Nightly" },
    { name: "Doxycycline", dosage: "100 mg", frequency: "Once daily for 8 weeks" },
  ],
  tests: [],
  followUps: ["Review in 6 weeks"],
};
const SUMMARY =
  "Acne consultation. Acne vulgaris, moderate inflammatory; possible rosacea. Plan: Adapalene 0.1% gel thin layer nightly; doxycycline 100 mg once daily for 8 weeks. Review in 6 weeks.";

describe("findSummaryMentions", () => {
  it("finds nothing when nothing was removed", () => {
    expect(findSummaryMentions({ draft: DRAFT, signed: DRAFT, summary: SUMMARY })).toEqual([]);
  });

  it("finds a removed medication by name or generic and a removed diagnosis, case-insensitively", () => {
    const signed = { ...DRAFT, diagnoses: [DRAFT.diagnoses[0]!], medications: [DRAFT.medications[0]!] };
    const mentions = findSummaryMentions({ draft: DRAFT, signed, summary: SUMMARY });
    expect(mentions.map((m) => [m.kind, m.item, m.term])).toEqual([
      ["medication", "Doxycycline", "doxycycline"],
      ["diagnosis", "Rosacea", "Rosacea"],
    ]);
    const doxy = mentions[0]!;
    expect(SUMMARY.slice(doxy.ranges[0]![0], doxy.ranges[0]![1])).toBe("doxycycline");
  });

  it("finds a removed brand by its generic", () => {
    const draft = { ...DRAFT, medications: [{ name: "Roaccutane 20 mg" }] };
    const mentions = findSummaryMentions({ draft, signed: { ...draft, medications: [] }, summary: "Started isotretinoin 20 mg daily." });
    expect(mentions.map((m) => m.term)).toEqual(["isotretinoin"]);
  });

  it("does not count a medication kept under another name or strength as removed", () => {
    const draft = { ...DRAFT, medications: [{ name: "Minoxidil 5% solution", dosage: "1 ml" }] };
    const signed = { ...draft, medications: [{ name: "Minoxidil 5%", dosage: "1 ml" }] };
    expect(findSummaryMentions({ draft, signed, summary: "Continue minoxidil 5% solution twice daily." })).toEqual([]);
  });

  it("ignores words inside items that were signed and partial words", () => {
    const draft = { ...DRAFT, diagnoses: ["Acne", "Acne vulgaris"] };
    const signed = { ...draft, diagnoses: ["Acne vulgaris"] };
    expect(findSummaryMentions({ draft, signed, summary: "Acne vulgaris, improving." })).toEqual([]);
    const draft2 = { ...DRAFT, diagnoses: ["Tinea"] };
    expect(findSummaryMentions({ draft: draft2, signed: { ...draft2, diagnoses: [] }, summary: "Tinea-like rash ruled out." })).toHaveLength(1);
    expect(findSummaryMentions({ draft: draft2, signed: { ...draft2, diagnoses: [] }, summary: "Tineas are fungal." })).toEqual([]);
  });

  it("matches Arabic spelling variants", () => {
    const draft = { ...DRAFT, diagnoses: ["حب الشباب"] };
    const mentions = findSummaryMentions({ draft, signed: { ...draft, diagnoses: [] }, summary: "تشخيص: حب الشباب." });
    expect(mentions).toHaveLength(1);
  });
});

describe("highlightSegments", () => {
  it("cuts the summary around the mentions", () => {
    const signed = { ...DRAFT, medications: [DRAFT.medications[0]!] };
    const mentions = findSummaryMentions({ draft: DRAFT, signed, summary: SUMMARY });
    const segments = highlightSegments(SUMMARY, mentions);
    expect(segments.filter((s) => s.mark).map((s) => s.text)).toEqual(["doxycycline"]);
    expect(segments.map((s) => s.text).join("")).toBe(SUMMARY);
  });
});

describe("rebuildSummary", () => {
  it("writes '<reason>. <diagnoses>. Plan: <meds with dose and frequency>. <follow-ups>.' from the signed items", () => {
    const signed = { ...DRAFT, diagnoses: [DRAFT.diagnoses[0]!], medications: [DRAFT.medications[0]!] };
    expect(rebuildSummary(signed, { reason: "Acne consultation" })).toBe(
      "Acne consultation. Acne vulgaris, moderate inflammatory. Plan: Adapalene 0.1% gel Thin layer nightly. Review in 6 weeks.",
    );
  });

  it("falls back to the symptoms as the reason and says when there is no medication", () => {
    expect(rebuildSummary({ ...DRAFT, diagnoses: [], medications: [], followUps: [] })).toBe(
      "Presented with inflammatory papules on cheeks, post-inflammatory marks. Plan: no medication.",
    );
    expect(rebuildSummary({ symptoms: [], diagnoses: [], medications: [{ name: "Finasteride", dosage: "1 mg", frequency: "BID" }], tests: [], followUps: [] })).toBe(
      "Consultation. Plan: Finasteride 1 mg BID.",
    );
  });

  it("never mentions what was removed", () => {
    const signed = { ...DRAFT, diagnoses: [DRAFT.diagnoses[0]!], medications: [DRAFT.medications[0]!] };
    const rebuilt = rebuildSummary(signed, { reason: "Acne consultation" });
    expect(findSummaryMentions({ draft: DRAFT, signed, summary: rebuilt })).toEqual([]);
  });
});
